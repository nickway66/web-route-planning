# AI Route Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build AI-generated routes that optimize place order and render one continuous AMap driving route through the optimized stops.

**Architecture:** Backend route planning gains a multi-point driving method that sends `origin`, `destination`, and `waypoints` to AMap when possible. AI layer building uses optimized points, plans driving as one route, and falls back to current adjacent-leg planning when multi-point planning cannot be used.

**Tech Stack:** Python FastAPI backend, httpx AMap Web Service client, pytest backend tests.

---

## File Structure

- Modify `backend/app/services/amap.py`: add waypoint constants, route-cost helpers, and multi-point driving planning.
- Modify `backend/app/services/routes.py`: add async route-cost-aware optimizer and use multi-point driving in AI route building.
- Modify `backend/tests/test_services.py`: add unit tests with fake AMap clients.

---

### Task 1: Multi-Point Driving Planning

**Files:**
- Modify: `backend/app/services/amap.py`
- Test: `backend/tests/test_services.py`

- [ ] **Step 1: Write the failing tests**

Add tests that exercise a fake AMap client and expected waypoint chunking:

```python
import pytest


@pytest.mark.asyncio
async def test_plan_driving_route_sends_waypoints_in_single_request():
    client = RecordingAMapClient()
    points = [
        {"name": "A", "lng": 100.0, "lat": 30.0},
        {"name": "B", "lng": 101.0, "lat": 31.0},
        {"name": "C", "lng": 102.0, "lat": 32.0},
    ]

    segments = await client.plan_driving_route(points)

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


@pytest.mark.asyncio
async def test_plan_driving_route_chunks_points_over_waypoint_limit():
    client = RecordingAMapClient()
    points = [{"name": str(index), "lng": float(index), "lat": float(index)} for index in range(19)]

    segments = await client.plan_driving_route(points)

    assert len(client.requests) == 2
    assert client.requests[0]["params"]["origin"] == "0.0,0.0"
    assert client.requests[0]["params"]["destination"] == "17.0,17.0"
    assert client.requests[1]["params"]["origin"] == "17.0,17.0"
    assert client.requests[1]["params"]["destination"] == "18.0,18.0"
    assert [segment["legIndex"] for segment in segments] == [0, 1]
```

The fake client class will be added above the tests:

```python
from backend.app.services.amap import AMapClient


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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `python -m pytest backend/tests/test_services.py -k "plan_driving_route" -v`

Expected: FAIL because `AMapClient.plan_driving_route` is not defined.

- [ ] **Step 3: Implement multi-point driving planning**

Add in `backend/app/services/amap.py`:

```python
AMAP_DRIVING_WAYPOINT_LIMIT = 16


def point_to_lnglat_text(point: dict[str, Any]) -> str:
    return f"{point['lng']},{point['lat']}"
```

Add methods to `AMapClient`:

```python
async def plan_driving_route(self, points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(points) < 2:
        raise ValueError("At least two points are required")
    segments: list[dict[str, Any]] = []
    start_index = 0
    chunk_index = 0
    while start_index < len(points) - 1:
        end_index = min(len(points) - 1, start_index + AMAP_DRIVING_WAYPOINT_LIMIT + 1)
        chunk = points[start_index : end_index + 1]
        segment = await self._plan_driving_chunk(chunk)
        segments.append({**segment, "legIndex": chunk_index, "requestedMode": "driving"})
        start_index = end_index
        chunk_index += 1
    return segments

async def _plan_driving_chunk(self, points: list[dict[str, Any]]) -> dict[str, Any]:
    params = {
        "origin": point_to_lnglat_text(points[0]),
        "destination": point_to_lnglat_text(points[-1]),
        "extensions": "all",
        "strategy": 2,
    }
    waypoints = [point_to_lnglat_text(point) for point in points[1:-1]]
    if waypoints:
        params["waypoints"] = ";".join(waypoints)
    data = await self._get("direction/driving", params)
    route = (data.get("route", {}).get("paths") or [{}])[0]
    segments = normalize_route_segments(route, "driving")
    if len(segments) != 1:
        raise RuntimeError("driving route returned unexpected segment count")
    return segments[0]
```

- [ ] **Step 4: Run tests to verify pass**

Run: `python -m pytest backend/tests/test_services.py -k "plan_driving_route" -v`

Expected: PASS.

---

### Task 2: AI Route Builder Uses Continuous Driving Routes

**Files:**
- Modify: `backend/app/services/routes.py`
- Test: `backend/tests/test_services.py`

- [ ] **Step 1: Write the failing test**

Add a fake AI route client and test:

```python
from backend.app.services.routes import build_ai_layers


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


@pytest.mark.asyncio
async def test_build_ai_layers_uses_continuous_driving_route():
    response = await build_ai_layers(FakeAIRouteClient(), [["CityA", "CityB", "CityC"]], "TestCity", [])

    route = response["layers"][0]["routes"][0]
    assert len(route["segments"]) == 1
    assert route["segments"][0]["path"] == [[100.0, 30.0], [101.0, 31.0], [102.0, 32.0]]
    assert route["stats"] == {"distance": 300.0, "duration": 30.0}
```

- [ ] **Step 2: Run test to verify failure**

Run: `python -m pytest backend/tests/test_services.py::test_build_ai_layers_uses_continuous_driving_route -v`

Expected: FAIL because `build_ai_layers()` still calls `plan_route()` and therefore `plan_segment()`.

- [ ] **Step 3: Implement continuous route use**

In `backend/app/services/routes.py`, add:

```python
async def plan_ai_driving_route(amap: AMapClient, points: list[dict[str, Any]], transit_city: str = "") -> dict[str, Any]:
    try:
        segments = await amap.plan_driving_route(points)
    except Exception:
        return await plan_route(amap, points, ["driving"] * (len(points) - 1), transit_city)
    return {"segments": segments, "stats": route_stats(segments)}
```

Then change `build_ai_layers()` to call:

```python
planned = await plan_ai_driving_route(amap, ordered, preferred_city)
```

- [ ] **Step 4: Run test to verify pass**

Run: `python -m pytest backend/tests/test_services.py::test_build_ai_layers_uses_continuous_driving_route -v`

Expected: PASS.

---

### Task 3: Road-Cost-Aware Point Ordering

**Files:**
- Modify: `backend/app/services/routes.py`
- Test: `backend/tests/test_services.py`

- [ ] **Step 1: Write failing tests**

Add tests:

```python
from backend.app.services.routes import optimize_point_order_by_route_cost


class FakeCostClient:
    def __init__(self, costs):
        self.costs = costs

    async def estimate_driving_cost(self, from_point, to_point):
        return self.costs[(from_point["name"], to_point["name"])]


@pytest.mark.asyncio
async def test_optimize_point_order_by_route_cost_keeps_start_and_uses_route_cost():
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

    ordered = await optimize_point_order_by_route_cost(FakeCostClient(costs), points)

    assert [point["name"] for point in ordered] == ["A", "C", "B"]


@pytest.mark.asyncio
async def test_optimize_point_order_by_route_cost_falls_back_to_straight_line_order():
    class BrokenCostClient:
        async def estimate_driving_cost(self, from_point, to_point):
            raise RuntimeError("cost unavailable")

    points = [
        {"name": "A", "lng": 0, "lat": 0},
        {"name": "C", "lng": 10, "lat": 10},
        {"name": "B", "lng": 1, "lat": 1},
    ]

    ordered = await optimize_point_order_by_route_cost(BrokenCostClient(), points)

    assert [point["name"] for point in ordered] == ["A", "B", "C"]
```

- [ ] **Step 2: Run tests to verify failure**

Run: `python -m pytest backend/tests/test_services.py -k "optimize_point_order_by_route_cost" -v`

Expected: FAIL because the async optimizer is not defined.

- [ ] **Step 3: Implement route-cost optimizer**

In `backend/app/services/amap.py`, add:

```python
async def estimate_driving_cost(self, from_point: dict[str, Any], to_point: dict[str, Any]) -> float:
    planned = await self.plan_segment(from_point, to_point, "driving")
    segments = planned if isinstance(planned, list) else [planned]
    stats = route_stats(segments)
    return float(stats["distance"])
```

In `backend/app/services/routes.py`, add:

```python
async def optimize_point_order_by_route_cost(amap: AMapClient, points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(points) <= 2:
        return points
    try:
        cost = await build_route_cost_matrix(amap, points)
        return nearest_neighbor_order(points, cost)
    except Exception:
        return optimize_point_order(points)
```

And helper functions:

```python
async def build_route_cost_matrix(amap: AMapClient, points: list[dict[str, Any]]) -> dict[tuple[int, int], float]:
    matrix = {}
    for from_index, from_point in enumerate(points):
        for to_index, to_point in enumerate(points):
            if from_index == to_index:
                continue
            matrix[(from_index, to_index)] = await amap.estimate_driving_cost(from_point, to_point)
    return matrix


def nearest_neighbor_order(points: list[dict[str, Any]], cost: dict[tuple[int, int], float]) -> list[dict[str, Any]]:
    ordered_indexes = [0]
    remaining = set(range(1, len(points)))
    while remaining:
        current = ordered_indexes[-1]
        next_index = min(remaining, key=lambda index: cost[(current, index)])
        ordered_indexes.append(next_index)
        remaining.remove(next_index)
    return [points[index] for index in ordered_indexes]
```

Update `build_ai_layers()`:

```python
ordered = await optimize_point_order_by_route_cost(amap, points)
```

- [ ] **Step 4: Run route-cost tests**

Run: `python -m pytest backend/tests/test_services.py -k "optimize_point_order_by_route_cost" -v`

Expected: PASS.

---

### Task 4: Full Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run backend tests**

Run: `python -m pytest backend/tests -v`

Expected: all tests pass.

- [ ] **Step 2: Run frontend build**

Run: `npm run build`

Expected: Vite build exits 0.

- [ ] **Step 3: Inspect git diff**

Run: `git diff -- backend/app/services/amap.py backend/app/services/routes.py backend/tests/test_services.py`

Expected: diff only contains route planning changes and tests.
