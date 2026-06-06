import asyncio

from backend.app.services.ai import parse_ai_envelope
from backend.app.services.amap import AMapClient, normalize_poi, normalize_route_segments, parse_polyline, route_stats
from backend.app.services.exports import create_gpx
from backend.app.services.routes import build_ai_layers, normalize_place_name, optimize_point_order, optimize_point_order_by_route_cost


class RecordingAMapClient(AMapClient):
    def __init__(self):
        self.requests = []

    async def _get(self, path, params):
        self.requests.append({"path": path, "params": params})
        origin_lng, origin_lat = [float(item) for item in params["origin"].split(",")]
        destination_lng, destination_lat = [float(item) for item in params["destination"].split(",")]
        points = [[origin_lng, origin_lat]]
        for pair in str(params.get("waypoints") or "").split(";"):
            if pair:
                lng, lat = [float(item) for item in pair.split(",")]
                points.append([lng, lat])
        points.append([destination_lng, destination_lat])
        polyline = ";".join(f"{lng},{lat}" for lng, lat in points)
        return {"route": {"paths": [{"distance": "100", "duration": "10", "polyline": polyline}]}}


class FakeAIRouteClient:
    async def search_poi(self, keyword, city=""):
        coords = {
            "CityA": [100.0, 30.0],
            "CityB": [101.0, 31.0],
            "CityC": [102.0, 32.0],
        }
        name = keyword.replace("TestCity", "")
        lng, lat = coords[name]
        return [{"name": name, "address": "", "city": "TestCity", "location": [lng, lat]}]

    async def plan_driving_route(self, points):
        return [
            {
                "mode": "driving",
                "distance": 300.0,
                "duration": 30.0,
                "path": [[point["lng"], point["lat"]] for point in points],
                "transitTools": [],
                "legIndex": 0,
                "requestedMode": "driving",
            }
        ]

    async def plan_segment(self, from_point, to_point, mode, transit_city=""):
        raise AssertionError("AI driving routes should prefer plan_driving_route")


class FakeCostClient:
    def __init__(self, costs):
        self.costs = costs
        self.calls = []

    async def estimate_driving_cost(self, from_point, to_point):
        self.calls.append((from_point["name"], to_point["name"]))
        return self.costs[(from_point["name"], to_point["name"])]


class RetryingAMapClient(AMapClient):
    def __init__(self):
        self.attempts = 0
        self.sleeps = []

    async def _request_json(self, path, params):
        self.attempts += 1
        if self.attempts < 3:
            return {"status": "0", "info": "CUQPS_HAS_EXCEEDED_THE_LIMIT"}
        return {"status": "1", "result": "ok"}

    async def _wait_for_rate_limit_slot(self):
        return None

    async def _sleep(self, seconds):
        self.sleeps.append(seconds)


class ExhaustedQPSAMapClient(AMapClient):
    def __init__(self):
        self.attempts = 0
        self.sleeps = []

    async def _request_json(self, path, params):
        self.attempts += 1
        return {"status": "0", "info": "CUQPS_HAS_EXCEEDED_THE_LIMIT"}

    async def _wait_for_rate_limit_slot(self):
        return None

    async def _sleep(self, seconds):
        self.sleeps.append(seconds)


class FakeEntrancePOIClient:
    async def search_poi(self, keyword, city=""):
        return [
            {
                "name": "Test Park",
                "address": "",
                "city": "TestCity",
                "location": [100.0, 30.0],
                "routeLocation": [100.5, 30.5],
            }
        ]


def test_parse_polyline_accepts_semicolon_and_pipe_separators():
    assert parse_polyline("104.1,30.1;104.2,30.2|104.2,30.2;104.3,30.3") == [
        [104.1, 30.1],
        [104.2, 30.2],
        [104.3, 30.3],
    ]


def test_normalize_poi_uses_navi_entrance_as_route_location():
    poi = normalize_poi(
        {
            "id": "park-1",
            "name": "Test Park",
            "location": "100.0,30.0",
            "navi": {"entr_location": "100.5,30.5"},
        }
    )

    assert poi["location"] == [100.0, 30.0]
    assert poi["routeLocation"] == [100.5, 30.5]


def test_build_points_from_places_routes_to_entrance_but_keeps_display_location():
    from backend.app.services.routes import build_points_from_places

    points, misses = asyncio.run(build_points_from_places(FakeEntrancePOIClient(), ["Test Park"], "TestCity"))

    assert misses == []
    assert points[0]["lng"] == 100.5
    assert points[0]["lat"] == 30.5
    assert points[0]["displayLng"] == 100.0
    assert points[0]["displayLat"] == 30.0


def test_route_stats_sums_distance_and_duration():
    assert route_stats(
        [
            {"distance": 1200, "duration": 600},
            {"distance": "800", "duration": "300"},
        ]
    ) == {"distance": 2000.0, "duration": 900.0}


def test_amap_get_retries_qps_limit_errors_with_backoff():
    client = RetryingAMapClient()

    data = asyncio.run(client._get("place/text", {"keywords": "A"}))

    assert data == {"status": "1", "result": "ok"}
    assert client.attempts == 3
    assert client.sleeps == [1.0, 2.0]


def test_amap_get_reports_qps_limit_as_user_readable_error_after_retries():
    client = ExhaustedQPSAMapClient()

    try:
        asyncio.run(client._get("place/text", {"keywords": "A"}))
    except RuntimeError as error:
        message = str(error)
    else:
        raise AssertionError("expected QPS exhaustion to raise")

    assert message == "地图服务请求过于频繁，请稍后重试"
    assert client.attempts == 4
    assert client.sleeps == [1.0, 2.0, 4.0]


def test_transit_route_splits_walking_access_from_public_transport():
    route = {
        "segments": [
            {
                "walking": {
                    "distance": "120",
                    "duration": "90",
                    "steps": [{"polyline": "104.000,30.000;104.001,30.001"}],
                },
                "bus": {
                    "buslines": [
                        {
                            "name": "地铁1号线",
                            "distance": "2400",
                            "duration": "600",
                            "polyline": "104.001,30.001;104.020,30.020",
                        }
                    ]
                },
            },
            {
                "walking": {
                    "distance": "80",
                    "duration": "70",
                    "polyline": "104.020,30.020;104.021,30.021",
                }
            },
        ]
    }

    segments = normalize_route_segments(route, "transit")

    assert [segment["mode"] for segment in segments] == ["walking", "transit", "walking"]
    assert [segment["distance"] for segment in segments] == [120.0, 2400.0, 80.0]
    assert segments[1]["transitTools"] == ["地铁1号线"]


def test_non_transit_route_uses_one_path_source_without_duplicate_round_trip():
    route = {
        "polyline": "104.000,30.000;104.100,30.100",
        "steps": [
            {"polyline": "104.000,30.000;104.050,30.050"},
            {"polyline": "104.050,30.050;104.100,30.100"},
        ],
    }

    segments = normalize_route_segments(route, "driving")

    assert len(segments) == 1
    assert segments[0]["path"] == [
        [104.0, 30.0],
        [104.05, 30.05],
        [104.1, 30.1],
    ]


def test_plan_driving_route_sends_waypoints_in_single_request():
    client = RecordingAMapClient()
    points = [
        {"name": "A", "lng": 100.0, "lat": 30.0},
        {"name": "B", "lng": 101.0, "lat": 31.0},
        {"name": "C", "lng": 102.0, "lat": 32.0},
    ]

    segments = asyncio.run(client.plan_driving_route(points))

    assert client.requests == [
        {
            "path": "direction/driving",
            "params": {
                "origin": "100.0,30.0",
                "destination": "102.0,32.0",
                "waypoints": "101.0,31.0",
                "extensions": "all",
                "strategy": 2,
            },
        }
    ]
    assert len(segments) == 1
    assert segments[0]["mode"] == "driving"
    assert segments[0]["legIndex"] == 0


def test_plan_driving_route_chunks_points_over_waypoint_limit():
    client = RecordingAMapClient()
    points = [{"name": str(index), "lng": float(index), "lat": float(index)} for index in range(19)]

    segments = asyncio.run(client.plan_driving_route(points))

    assert len(client.requests) == 2
    assert client.requests[0]["params"]["origin"] == "0.0,0.0"
    assert client.requests[0]["params"]["destination"] == "17.0,17.0"
    assert client.requests[1]["params"]["origin"] == "17.0,17.0"
    assert client.requests[1]["params"]["destination"] == "18.0,18.0"
    assert [segment["legIndex"] for segment in segments] == [0, 1]


def test_build_ai_layers_uses_continuous_driving_route():
    response = asyncio.run(build_ai_layers(FakeAIRouteClient(), [["CityA", "CityB", "CityC"]], "TestCity", []))

    route = response["layers"][0]["routes"][0]
    assert len(route["segments"]) == 1
    assert route["segments"][0]["path"] == [[100.0, 30.0], [101.0, 31.0], [102.0, 32.0]]
    assert route["stats"] == {"distance": 300.0, "duration": 30.0}


def test_transit_route_treats_entrance_and_exit_paths_as_walking():
    route = {
        "segments": [
            {
                "entrance": {"polyline": "104.000,30.000;104.001,30.001", "distance": "90"},
                "bus": {
                    "buslines": [
                        {
                            "name": "bus-10",
                            "polyline": "104.001,30.001;104.020,30.020",
                        }
                    ]
                },
                "exit": {"polyline": "104.020,30.020;104.021,30.021", "distance": "60"},
            }
        ]
    }

    segments = normalize_route_segments(route, "transit")

    assert [segment["mode"] for segment in segments] == ["walking", "transit", "walking"]
    assert segments[0]["distance"] == 90.0
    assert segments[2]["distance"] == 60.0


def test_transit_segments_mark_subway_and_bus_for_route_styling():
    route = {
        "segments": [
            {
                "bus": {
                    "buslines": [
                        {
                            "name": "Metro Line 1",
                            "polyline": "104.000,30.000;104.010,30.010",
                        },
                        {
                            "name": "Metro Line 2",
                            "polyline": "104.010,30.010;104.020,30.020",
                        },
                        {
                            "name": "Bus 10",
                            "polyline": "104.020,30.020;104.030,30.030",
                        },
                    ]
                }
            }
        ]
    }

    segments = normalize_route_segments(route, "transit")

    assert [segment["transitKind"] for segment in segments] == ["subway", "subway", "bus"]
    assert segments[0]["transitColor"] != segments[1]["transitColor"]
    assert segments[2].get("transitColor") is None


def test_optimize_point_order_keeps_start_and_nearest_neighbors():
    points = [
        {"name": "A", "lng": 0, "lat": 0},
        {"name": "C", "lng": 10, "lat": 10},
        {"name": "B", "lng": 1, "lat": 1},
    ]

    ordered = optimize_point_order(points)

    assert [point["name"] for point in ordered] == ["A", "B", "C"]


def test_optimize_point_order_by_route_cost_keeps_start_and_uses_route_cost():
    points = [
        {"name": "A", "lng": 0, "lat": 0},
        {"name": "B", "lng": 1, "lat": 1},
        {"name": "C", "lng": 2, "lat": 2},
    ]
    costs = {
        ("A", "B"): 100,
        ("A", "C"): 10,
        ("B", "A"): 100,
        ("B", "C"): 100,
        ("C", "A"): 10,
        ("C", "B"): 10,
    }

    ordered = asyncio.run(optimize_point_order_by_route_cost(FakeCostClient(costs), points))

    assert [point["name"] for point in ordered] == ["A", "C", "B"]


def test_optimize_point_order_by_route_cost_falls_back_to_straight_line_order():
    class BrokenCostClient:
        async def estimate_driving_cost(self, from_point, to_point):
            raise RuntimeError("cost unavailable")

    points = [
        {"name": "A", "lng": 0, "lat": 0},
        {"name": "C", "lng": 10, "lat": 10},
        {"name": "B", "lng": 1, "lat": 1},
    ]

    ordered = asyncio.run(optimize_point_order_by_route_cost(BrokenCostClient(), points))

    assert [point["name"] for point in ordered] == ["A", "B", "C"]


def test_optimize_point_order_by_route_cost_skips_cost_matrix_for_many_points():
    points = [
        {"name": "A", "lng": 0, "lat": 0},
        {"name": "E", "lng": 20, "lat": 20},
        {"name": "B", "lng": 1, "lat": 1},
        {"name": "D", "lng": 10, "lat": 10},
        {"name": "C", "lng": 2, "lat": 2},
    ]
    client = FakeCostClient({})

    ordered = asyncio.run(optimize_point_order_by_route_cost(client, points))

    assert [point["name"] for point in ordered] == ["A", "B", "C", "D", "E"]
    assert client.calls == []


def test_normalize_place_name_strips_numbering_and_transport_notes():
    assert normalize_place_name("1. 起点：成都东站（地铁约20分钟）") == "成都东站"


def test_create_gpx_contains_routes_tracks_and_points():
    gpx = create_gpx(
        [
            {
                "name": "路线1",
                "routes": [
                    {
                        "meta": {"name": "第一天"},
                        "points": [{"name": "A", "lng": 104.1, "lat": 30.1}],
                        "segments": [{"path": [[104.1, 30.1], [104.2, 30.2]]}],
                    }
                ],
            }
        ]
    )

    assert "<gpx" in gpx
    assert "<name>第一天</name>" in gpx
    assert 'lat="30.1" lon="104.1"' in gpx
    assert 'lat="30.2" lon="104.2"' in gpx


def test_parse_ai_envelope_keeps_plain_chat_out_of_route_flow():
    result = parse_ai_envelope('{"type":"chat","reply":"I can use the current conversation context.","plan":null}')

    assert result == {"type": "chat", "reply": "I can use the current conversation context.", "plan": None, "parsedPlan": None}


def test_parse_ai_envelope_accepts_route_plan_with_two_places():
    result = parse_ai_envelope(
        '{"type":"route_plan","reply":"I prepared a Guangzhou route.","plan":{"city":"Guangzhou","days":[{"day":1,"places":[{"name":"Canton Tower"},{"name":"Guangdong Museum"}]}]}}'
    )

    assert result["type"] == "route_plan"
    assert result["reply"] == "I prepared a Guangzhou route."
    assert result["plan"]["city"] == "Guangzhou"
    assert [place["name"] for place in result["plan"]["days"][0]["places"]] == ["Canton Tower", "Guangdong Museum"]
    assert result["parsedPlan"] == result["plan"]


def test_parse_ai_envelope_downgrades_invalid_route_plan_to_travel_advice():
    result = parse_ai_envelope(
        '{"type":"route_plan","reply":"Canton Tower is worth visiting.","plan":{"city":"Guangzhou","days":[{"day":1,"places":[{"name":"Canton Tower"}]}]}}'
    )

    assert result["type"] == "travel_advice"
    assert result["plan"] is None
    assert result["parsedPlan"] is None


def test_parse_ai_envelope_accepts_legacy_route_json():
    result = parse_ai_envelope(
        '{"city":"Guangzhou","days":[{"day":1,"places":[{"name":"Canton Tower"},{"name":"Guangdong Museum"}]}]}'
    )

    assert result["type"] == "route_plan"
    assert result["reply"]
    assert not result["reply"].strip().startswith("{")
    assert result["plan"]["city"] == "Guangzhou"


def test_parse_ai_envelope_bad_json_falls_back_to_chat_text():
    result = parse_ai_envelope("Plain answer, not JSON")

    assert result == {"type": "chat", "reply": "Plain answer, not JSON", "plan": None, "parsedPlan": None}
