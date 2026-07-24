import asyncio
import json

import pytest

from backend.app.services import ai as ai_service
from backend.app.services.ai import _json_object_candidates, is_route_request_message, parse_ai_envelope, request_zhipu_reply
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


def _route_plan_payload(reply="I prepared a route.", places=None):
    return {
        "type": "route_plan",
        "reply": reply,
        "plan": {
            "city": "Shenzhen",
            "days": [
                {
                    "day": 1,
                    "places": [{"name": name} for name in (places or ["Lotus Hill Park", "Shenzhen Museum"])],
                }
            ],
        },
    }


def test_parse_ai_envelope_keeps_plain_chat_out_of_route_flow():
    result = parse_ai_envelope('{"type":"chat","reply":"I can use the current conversation context.","plan":null}')

    assert result == {"type": "chat", "reply": "I can use the current conversation context.", "plan": None, "parsedPlan": None}


def test_parse_ai_envelope_accepts_route_plan_with_two_places():
    result = parse_ai_envelope(
        '{"type":"route_plan","reply":"I prepared a Guangzhou route.","plan":{"city":"Guangzhou","days":[{"day":1,"places":[{"name":"Canton Tower"},{"name":"Guangdong Museum"}]}]}}'
    )

    assert result["type"] == "route_plan"
    assert "Canton Tower" in result["reply"]
    assert "Guangdong Museum" in result["reply"]
    assert not result["reply"].startswith("{")
    assert result["plan"]["city"] == "Guangzhou"
    assert [place["name"] for place in result["plan"]["days"][0]["places"]] == ["Canton Tower", "Guangdong Museum"]
    assert result["parsedPlan"] == result["plan"]


def test_parse_ai_envelope_accepts_raw_route_plan_json_without_fence():
    payload = _route_plan_payload("I mapped out a Shenzhen day trip.", ["Lianhua Mountain Park", "Shenzhen Bay Park", "Window of the World"])

    result = parse_ai_envelope(json.dumps(payload))

    assert result["type"] == "route_plan"
    assert "Lianhua Mountain Park" in result["reply"]
    assert "Shenzhen Bay Park" in result["reply"]
    assert "Window of the World" in result["reply"]
    assert result["plan"]["city"] == "Shenzhen"
    assert [place["name"] for place in result["plan"]["days"][0]["places"]] == [
        "Lianhua Mountain Park",
        "Shenzhen Bay Park",
        "Window of the World",
    ]


def test_parse_ai_envelope_builds_detailed_route_reply_from_plan_fields():
    payload = {
        "type": "route_plan",
        "reply": "包括以下景点。",
        "plan": {
            "city": "深圳",
            "days": [
                {
                    "day": 1,
                    "places": [
                        {
                            "name": "桔钓沙",
                            "duration": "2小时",
                            "cost": "免费",
                            "hours": "全天开放",
                            "description": "海水清澈，适合看海和放松。",
                        },
                        {
                            "name": "深圳湾公园",
                            "duration": "1.5小时",
                            "cost": "免费",
                            "hours": "06:00-23:00",
                            "description": "适合沿海散步和看日落。",
                        },
                    ],
                }
            ],
        },
    }

    result = parse_ai_envelope(json.dumps(payload, ensure_ascii=False))

    assert result["type"] == "route_plan"
    assert "桔钓沙" in result["reply"]
    assert "深圳湾公园" in result["reply"]
    assert "2小时" in result["reply"]
    assert "1.5小时" in result["reply"]
    assert "免费" in result["reply"]
    assert "全天开放" in result["reply"]
    assert "06:00-23:00" in result["reply"]
    assert "海水清澈，适合看海和放松。" in result["reply"]
    assert "适合沿海散步和看日落。" in result["reply"]
    assert not result["reply"].startswith("{")
    assert not result["reply"].startswith("```")


def test_json_object_candidates_and_parse_handle_full_raw_route_plan_with_chinese_text():
    raw = json.dumps(
        {
            "type": "route_plan",
            "reply": "已为你整理一条深圳两日路线，涵盖城市地标、滨海休闲和文化展览。",
            "plan": {
                "city": "深圳",
                "days": [
                    {
                        "day": 1,
                        "places": [
                            {
                                "name": "莲花山公园",
                                "duration": "2小时",
                                "cost": "免费",
                                "hours": "06:00-22:30",
                                "description": "适合俯瞰城市中轴线，节奏比较从容。",
                            },
                            {
                                "name": "深圳市民中心",
                                "duration": "1小时",
                                "cost": "免费",
                                "hours": "09:00-17:00",
                                "description": "深圳的政治、文化中心，可以参观展览和休闲。",
                            },
                        ],
                    },
                    {
                        "day": 2,
                        "places": [
                            {
                                "name": "深圳湾公园",
                                "duration": "2小时",
                                "cost": "免费",
                                "hours": "全天开放",
                                "description": "适合海边散步，看日落。",
                            },
                            {
                                "name": "华侨城创意文化园",
                                "duration": "2小时",
                                "cost": "免费",
                                "hours": "10:00-22:00",
                                "description": "园区里有展览、咖啡馆和设计店铺。",
                            },
                        ],
                    },
                ],
            },
        },
        ensure_ascii=False,
    )

    candidates = _json_object_candidates(raw)
    result = parse_ai_envelope(raw)

    assert len(candidates) >= 1
    assert result["type"] == "route_plan"
    assert "莲花山公园" in result["reply"]
    assert "深圳市民中心" in result["reply"]
    assert "深圳湾公园" in result["reply"]
    assert "华侨城创意文化园" in result["reply"]
    assert "2小时" in result["reply"]
    assert "10:00-22:00" in result["reply"]
    assert result["plan"]["city"] == "深圳"
    assert [place["name"] for place in result["plan"]["days"][0]["places"]] == ["莲花山公园", "深圳市民中心"]


def test_parse_ai_envelope_accepts_route_plan_with_literal_newlines_in_reply():
    raw = """{"type":"route_plan","reply":"已为你整理深圳一日路线，具体行程如下：
1. 先去桔钓沙看海。
2. 再去大梅沙海滨公园散步。","plan":{"city":"深圳","days":[{"day":1,"places":[{"name":"桔钓沙","duration":"2小时","cost":"免费","hours":"全天开放","description":"海水清澈，适合看海。"},{"name":"大梅沙海滨公园","duration":"2小时","cost":"免费","hours":"全天开放","description":"适合海边散步和休闲。"}]}]}}"""

    result = parse_ai_envelope(raw)

    assert result["type"] == "route_plan"
    assert "桔钓沙" in result["reply"]
    assert "大梅沙海滨公园" in result["reply"]
    assert "2小时" in result["reply"]
    assert not result["reply"].startswith("{")
    assert not result["reply"].startswith("```")
    assert result["plan"]["city"] == "深圳"
    assert [place["name"] for place in result["plan"]["days"][0]["places"]] == ["桔钓沙", "大梅沙海滨公园"]


def test_parse_ai_envelope_repairs_truncated_route_plan_missing_closing_tokens():
    raw = (
        '{"type":"route_plan","reply":"已为你整理深圳夜游路线。","plan":{"city":"深圳","days":[{"day":1,'
        '"places":[{"name":"桔钓沙","description":"看海放松。"},{"name":"深圳湾公园","description":"适合夜间散步。"}]}}'
    )

    result = parse_ai_envelope(raw)

    assert result["type"] == "route_plan"
    assert "桔钓沙" in result["reply"]
    assert "深圳湾公园" in result["reply"]
    assert "看海放松。" in result["reply"]
    assert result["plan"]["city"] == "深圳"
    assert [place["name"] for place in result["plan"]["days"][0]["places"]] == ["桔钓沙", "深圳湾公园"]


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


def test_parse_ai_envelope_strips_fenced_route_envelope_from_reply():
    payload = _route_plan_payload("Your Shenzhen day trip is ready.")

    result = parse_ai_envelope(f"```json\n{json.dumps(payload)}\n```\nExtra explanation")

    assert result["type"] == "route_plan"
    assert "Lotus Hill Park" in result["reply"]
    assert "Shenzhen Museum" in result["reply"]
    assert not result["reply"].startswith("{")
    assert not result["reply"].startswith("```")
    assert [place["name"] for place in result["plan"]["days"][0]["places"]] == ["Lotus Hill Park", "Shenzhen Museum"]


def test_parse_ai_envelope_accepts_fenced_route_without_closing_fence():
    payload = _route_plan_payload("I already organized the route.")

    result = parse_ai_envelope(f"```json\n{json.dumps(payload)}\nMore natural language after the JSON")

    assert result["type"] == "route_plan"
    assert "Lotus Hill Park" in result["reply"]
    assert "Shenzhen Museum" in result["reply"]


def test_parse_ai_envelope_extracts_embedded_route_plan_from_mixed_text():
    payload = _route_plan_payload("Use this route.")

    result = parse_ai_envelope(f"Here is the useful part: {json.dumps(payload)} Thanks.")

    assert result["type"] == "route_plan"
    assert "Lotus Hill Park" in result["reply"]
    assert "Shenzhen Museum" in result["reply"]


def test_parse_ai_envelope_unwraps_nested_fenced_envelope_reply():
    nested_payload = _route_plan_payload("I arranged the route for you.", ["OCT Loft", "Shenzhen Talent Park"])
    outer_payload = {"type": "chat", "reply": f"```json\n{json.dumps(nested_payload)}\n```", "plan": None}

    result = parse_ai_envelope(json.dumps(outer_payload))

    assert result["type"] == "route_plan"
    assert "OCT Loft" in result["reply"]
    assert "Shenzhen Talent Park" in result["reply"]
    assert not result["reply"].startswith("{")
    assert not result["reply"].startswith("```")
    assert [place["name"] for place in result["plan"]["days"][0]["places"]] == ["OCT Loft", "Shenzhen Talent Park"]


def test_parse_ai_envelope_bad_fenced_json_uses_natural_language_fallback():
    result = parse_ai_envelope('```json\n{"type":"chat","reply":"oops"\nYou can still continue planning the Shenzhen route.')

    assert result["type"] == "chat"
    assert result["reply"]
    assert not result["reply"].startswith("{")
    assert not result["reply"].startswith("```")
    assert "Shenzhen route" in result["reply"]


def test_request_zhipu_reply_retries_once_for_explicit_route_request(monkeypatch):
    first_reply = {"type": "chat", "reply": "I will start with a few suggestions.", "plan": None}
    second_reply = _route_plan_payload("I arranged a Shenzhen day trip.", ["Lianhua Mountain Park", "Shenzhen Bay Park", "Talent Park"])
    responses = [
        {"choices": [{"message": {"content": json.dumps(first_reply)}}]},
        {"choices": [{"message": {"content": json.dumps(second_reply)}}]},
    ]
    captured_payloads = []

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers=None, json=None):
            captured_payloads.append(json)
            return FakeResponse(responses[len(captured_payloads) - 1])

    monkeypatch.setattr(ai_service, "build_zhipu_auth", lambda api_key, api_id="": "Bearer test")
    monkeypatch.setattr(ai_service.httpx, "AsyncClient", FakeAsyncClient)

    result = asyncio.run(
        request_zhipu_reply(
            [{"role": "user", "content": "给我一条深圳一日游路线，至少三个地点。"}],
            "test-key",
            "",
            "glm-test",
        )
    )

    assert len(captured_payloads) == 2
    assert result["type"] == "route_plan"
    assert [place["name"] for place in result["plan"]["days"][0]["places"]] == [
        "Lianhua Mountain Park",
        "Shenzhen Bay Park",
        "Talent Park",
    ]
    assert captured_payloads[1]["messages"][0]["role"] == "system"
    assert "route_plan" in captured_payloads[1]["messages"][0]["content"]
    assert captured_payloads[1]["messages"][-1]["role"] == "user"
    assert sum(1 for message in captured_payloads[1]["messages"] if message["role"] == "system") == 1


def test_request_zhipu_reply_retries_once_for_route_revision_context(monkeypatch):
    first_reply = {"type": "chat", "reply": "可以考虑海边。", "plan": None}
    second_reply = {
        "type": "route_plan",
        "reply": "我帮你把桔钓沙加进行程里了。",
        "plan": {
            "city": "深圳",
            "days": [
                {
                    "day": 1,
                    "places": [
                        {"name": "桔钓沙"},
                        {"name": "深圳湾公园"},
                    ],
                }
            ],
        },
    }
    responses = [
        {"choices": [{"message": {"content": json.dumps(first_reply, ensure_ascii=False)}}]},
        {"choices": [{"message": {"content": json.dumps(second_reply, ensure_ascii=False)}}]},
    ]
    captured_payloads = []

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers=None, json=None):
            captured_payloads.append(json)
            return FakeResponse(responses[len(captured_payloads) - 1])

    monkeypatch.setattr(ai_service, "build_zhipu_auth", lambda api_key, api_id="": "Bearer test")
    monkeypatch.setattr(ai_service.httpx, "AsyncClient", FakeAsyncClient)

    result = asyncio.run(
        request_zhipu_reply(
            [
                {"role": "user", "content": "给我一条深圳一日路线，至少两个地点。"},
                {"role": "assistant", "content": json.dumps(_route_plan_payload("已整理路线。", ["莲花山公园", "深圳湾公园"]), ensure_ascii=False)},
                {"role": "user", "content": "我想去桔钓沙"},
            ],
            "test-key",
            "",
            "glm-test",
        )
    )

    assert len(captured_payloads) == 2
    assert result["type"] == "route_plan"
    assert [place["name"] for place in result["plan"]["days"][0]["places"]] == ["桔钓沙", "深圳湾公园"]


def test_request_zhipu_reply_falls_back_to_rebuilt_route_plan_after_retry_misses(monkeypatch):
    first_reply = {"type": "travel_advice", "reply": "桔钓沙位于深圳，是一个风景优美的海滩。", "plan": None}
    second_reply = {"type": "travel_advice", "reply": "你可以考虑去桔钓沙看海。", "plan": None}
    responses = [
        {"choices": [{"message": {"content": json.dumps(first_reply, ensure_ascii=False)}}]},
        {"choices": [{"message": {"content": json.dumps(second_reply, ensure_ascii=False)}}]},
    ]
    captured_payloads = []

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers=None, json=None):
            captured_payloads.append(json)
            return FakeResponse(responses[len(captured_payloads) - 1])

    previous_plan = {
        "type": "route_plan",
        "reply": "已整理深圳一日路线。",
        "plan": {
            "city": "深圳",
            "days": [
                {
                    "day": 1,
                    "places": [
                        {"name": "莲花山公园", "duration": "2小时", "cost": "免费", "hours": "06:00-22:30", "description": "适合俯瞰城市景观。"},
                        {"name": "深圳湾公园", "duration": "1.5小时", "cost": "免费", "hours": "全天开放", "description": "适合海边散步看日落。"},
                    ],
                }
            ],
        },
    }

    monkeypatch.setattr(ai_service, "build_zhipu_auth", lambda api_key, api_id="": "Bearer test")
    monkeypatch.setattr(ai_service.httpx, "AsyncClient", FakeAsyncClient)

    result = asyncio.run(
        request_zhipu_reply(
            [
                {"role": "user", "content": "生成一条深圳一日游路线"},
                {"role": "assistant", "content": json.dumps(previous_plan, ensure_ascii=False)},
                {"role": "user", "content": "我想去桔钓沙"},
            ],
            "test-key",
            "",
            "glm-test",
        )
    )

    assert len(captured_payloads) == 2
    assert "这不是景点建议" in captured_payloads[1]["messages"][0]["content"]
    assert "桔钓沙" in captured_payloads[1]["messages"][0]["content"]
    assert result["type"] == "route_plan"
    assert result["plan"] is not None
    assert result["parsedPlan"] == result["plan"]
    assert [place["name"] for place in result["plan"]["days"][0]["places"]][:2] == ["桔钓沙", "莲花山公园"]
    assert "桔钓沙" in result["reply"]
    assert "莲花山公园" in result["reply"]
    assert "深圳湾公园" in result["reply"]
    assert "2小时" in result["reply"]
    assert "全天开放" in result["reply"]
    assert not result["reply"].startswith("{")
    assert not result["reply"].startswith("```")


def test_request_zhipu_reply_rebuilds_route_plan_from_natural_language_route_history(monkeypatch):
    first_reply = {"type": "travel_advice", "reply": "桔钓沙位于深圳，是一个风景优美的海滩。", "plan": None}
    second_reply = {"type": "travel_advice", "reply": "你可以考虑去桔钓沙看海。", "plan": None}
    responses = [
        {"choices": [{"message": {"content": json.dumps(first_reply, ensure_ascii=False)}}]},
        {"choices": [{"message": {"content": json.dumps(second_reply, ensure_ascii=False)}}]},
    ]
    captured_payloads = []

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers=None, json=None):
            captured_payloads.append(json)
            return FakeResponse(responses[len(captured_payloads) - 1])

    assistant_route_text = (
        "已为你整理深圳路线：\n"
        "1. 深圳欢乐谷；建议游玩4小时；费用：250元；营业时间：10:00-22:00；简介：大型主题公园\n"
        "2. 世界之窗；建议游玩3小时；费用：200元；营业时间：10:00-22:00；简介：主题公园"
    )

    monkeypatch.setattr(ai_service, "build_zhipu_auth", lambda api_key, api_id="": "Bearer test")
    monkeypatch.setattr(ai_service.httpx, "AsyncClient", FakeAsyncClient)

    result = asyncio.run(
        request_zhipu_reply(
            [
                {"role": "user", "content": "生成一条深圳一日游路线"},
                {"role": "assistant", "content": assistant_route_text},
                {"role": "user", "content": "我想去桔钓沙"},
            ],
            "test-key",
            "",
            "glm-test",
        )
    )

    assert len(captured_payloads) == 2
    assert "这不是景点建议" in captured_payloads[1]["messages"][0]["content"]
    assert "桔钓沙" in captured_payloads[1]["messages"][0]["content"]
    assert result["type"] == "route_plan"
    assert result["plan"] is not None
    assert result["parsedPlan"] == result["plan"]
    place_names = [place["name"] for place in result["plan"]["days"][0]["places"]]
    assert "桔钓沙" in place_names
    assert len(place_names) >= 2
    assert "深圳欢乐谷" in place_names or "世界之窗" in place_names
    assert "桔钓沙" in result["reply"]
    assert "深圳欢乐谷" in result["reply"] or "世界之窗" in result["reply"]
    assert not result["reply"].startswith("{")
    assert not result["reply"].startswith("```")


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("给我一条广州两日旅游路线", True),
        ("给我一条深圳一日游路线，我想去红树林。至少五个地点", True),
        ("帮我规划成都三日游", True),
        ("不要给我规划成都三日游", False),
        ("取消刚才那条深圳一日游路线", False),
        ("不用给我旅游路线了", False),
    ],
)
def test_is_route_request_message(text, expected):
    assert is_route_request_message(text) is expected
