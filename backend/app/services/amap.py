import math
import re
import asyncio
from typing import Any

import httpx


SUBWAY_LINE_COLORS = [
    "#e23b3b",
    "#28a745",
    "#f2b705",
    "#6f42c1",
    "#00a3e0",
    "#d63384",
    "#20c997",
    "#fd7e14",
    "#0d6efd",
    "#6c757d",
    "#8bc34a",
    "#795548",
]

AMAP_DRIVING_WAYPOINT_LIMIT = 16
AMAP_REQUEST_INTERVAL_SECONDS = 0.8
AMAP_QPS_BACKOFF_SECONDS = [1.0, 2.0, 4.0]
QPS_LIMIT_KEYWORDS = ("QPS_HAS_EXCEEDED_THE_LIMIT", "CUQPS_HAS_EXCEEDED_THE_LIMIT")
QPS_LIMIT_USER_MESSAGE = "地图服务请求过于频繁，请稍后重试"


def parse_polyline(polyline: str | None) -> list[list[float]]:
    if not polyline:
        return []
    pairs = re.findall(r"-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?", str(polyline).replace("|", ";"))
    path: list[list[float]] = []
    last: list[float] | None = None
    for pair in pairs:
        lng_text, lat_text = pair.split(",", 1)
        point = [float(lng_text), float(lat_text)]
        if last != point:
            path.append(point)
            last = point
    return path


def haversine_meters(a: list[float], b: list[float]) -> float:
    lng1, lat1 = a
    lng2, lat2 = b
    rad = math.pi / 180
    d_lat = (lat2 - lat1) * rad
    d_lng = (lng2 - lng1) * rad
    r_lat1 = lat1 * rad
    r_lat2 = lat2 * rad
    value = math.sin(d_lat / 2) ** 2 + math.cos(r_lat1) * math.cos(r_lat2) * math.sin(d_lng / 2) ** 2
    return 6378137 * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))


def path_distance_meters(path: list[list[float]]) -> float:
    if len(path) < 2:
        return 0.0
    return sum(haversine_meters(path[i - 1], path[i]) for i in range(1, len(path)))


def point_to_lnglat_text(point: dict[str, Any]) -> str:
    return f"{point['lng']},{point['lat']}"


def parse_first_lnglat(value: Any) -> list[float] | None:
    path = parse_polyline(value)
    return path[0] if path else None


def route_stats(segments: list[dict[str, Any]]) -> dict[str, float]:
    distance = 0.0
    duration = 0.0
    for segment in segments:
        try:
            distance += float(segment.get("distance") or 0)
        except (TypeError, ValueError):
            pass
        try:
            duration += float(segment.get("duration") or 0)
        except (TypeError, ValueError):
            pass
    return {"distance": distance, "duration": duration}


def normalize_poi(raw: dict[str, Any]) -> dict[str, Any] | None:
    location = parse_polyline(raw.get("location"))
    if not location:
        return None
    navi = raw.get("navi") if isinstance(raw.get("navi"), dict) else {}
    route_location = parse_first_lnglat(navi.get("entr_location")) or parse_first_lnglat(navi.get("exit_location"))
    return {
        "id": raw.get("id") or raw.get("name") or "",
        "name": raw.get("name") or "",
        "address": raw.get("address") or raw.get("district") or "",
        "city": raw.get("cityname") or "",
        "province": raw.get("pname") or raw.get("province") or "",
        "district": raw.get("adname") or raw.get("district") or "",
        "adcode": raw.get("adcode") or "",
        "location": location[0],
        "routeLocation": route_location or location[0],
    }


class AMapClient:
    _request_lock = asyncio.Lock()
    _last_request_at = 0.0

    def __init__(self, key: str, base_url: str = "https://restapi.amap.com/v3"):
        if not key:
            raise ValueError("AMAP_WEB_SERVICE_KEY is not configured")
        self.key = key
        self.base_url = base_url.rstrip("/")

    async def _sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)

    async def _request_json(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(f"{self.base_url}/{path.lstrip('/')}", params={**params, "key": self.key})
            response.raise_for_status()
            return response.json()

    async def _wait_for_rate_limit_slot(self) -> None:
        async with self._request_lock:
            loop = asyncio.get_running_loop()
            elapsed = loop.time() - self.__class__._last_request_at
            wait_seconds = AMAP_REQUEST_INTERVAL_SECONDS - elapsed
            if wait_seconds > 0:
                await self._sleep(wait_seconds)
            self.__class__._last_request_at = loop.time()

    def _is_qps_limit_error(self, data: dict[str, Any]) -> bool:
        info = str(data.get("info") or data.get("infocode") or "")
        return any(keyword in info for keyword in QPS_LIMIT_KEYWORDS)

    async def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        attempts = len(AMAP_QPS_BACKOFF_SECONDS) + 1
        last_data: dict[str, Any] | None = None

        for attempt in range(attempts):
            await self._wait_for_rate_limit_slot()
            data = await self._request_json(path, params)
            last_data = data
            if str(data.get("status")) in {"1", "true", "True"}:
                return data
            if not self._is_qps_limit_error(data) or attempt >= len(AMAP_QPS_BACKOFF_SECONDS):
                break
            await self._sleep(AMAP_QPS_BACKOFF_SECONDS[attempt])

        data = last_data or {}
        if str(data.get("status")) not in {"1", "true", "True"}:
            if self._is_qps_limit_error(data):
                raise RuntimeError(QPS_LIMIT_USER_MESSAGE)
            raise RuntimeError(data.get("info") or "AMap request failed")
        return data

    async def search_poi(self, keyword: str, city: str = "") -> list[dict[str, Any]]:
        data = await self._get(
            "place/text",
            {
                "keywords": keyword,
                "city": city,
                "citylimit": "true" if city else "false",
                "extensions": "all",
                "show_fields": "navi",
                "offset": 20,
                "page": 1,
            },
        )
        return [poi for item in data.get("pois", []) if (poi := normalize_poi(item))]

    async def suggest_poi(self, keyword: str, city: str = "") -> list[dict[str, Any]]:
        return (await self.search_poi(keyword, city))[:6]

    async def plan_segment(self, from_point: dict[str, Any], to_point: dict[str, Any], mode: str, transit_city: str = "") -> dict[str, Any]:
        origin = f"{from_point['lng']},{from_point['lat']}"
        destination = f"{to_point['lng']},{to_point['lat']}"
        if mode == "walking":
            data = await self._get("direction/walking", {"origin": origin, "destination": destination})
            route = (data.get("route", {}).get("paths") or [{}])[0]
        elif mode == "riding":
            data = await self._get("direction/bicycling", {"origin": origin, "destination": destination})
            route = (data.get("data", {}).get("paths") or [{}])[0]
        elif mode == "transit":
            data = await self._get(
                "direction/transit/integrated",
                {"origin": origin, "destination": destination, "city": transit_city or "", "extensions": "all"},
            )
            route = (data.get("route", {}).get("transits") or [{}])[0]
        else:
            data = await self._get("direction/driving", {"origin": origin, "destination": destination, "extensions": "all", "strategy": 2})
            route = (data.get("route", {}).get("paths") or [{}])[0]
        return normalize_route_segments(route, mode)

    async def plan_driving_route(self, points: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if len(points) < 2:
            raise ValueError("At least two points are required")

        segments: list[dict[str, Any]] = []
        start_index = 0
        chunk_index = 0
        while start_index < len(points) - 1:
            end_index = min(len(points) - 1, start_index + AMAP_DRIVING_WAYPOINT_LIMIT + 1)
            segment = await self._plan_driving_chunk(points[start_index : end_index + 1])
            segments.append({**segment, "legIndex": chunk_index, "requestedMode": "driving"})
            start_index = end_index
            chunk_index += 1
        return segments

    async def _plan_driving_chunk(self, points: list[dict[str, Any]]) -> dict[str, Any]:
        params: dict[str, Any] = {
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

    async def estimate_driving_cost(self, from_point: dict[str, Any], to_point: dict[str, Any]) -> float:
        planned = await self.plan_segment(from_point, to_point, "driving")
        segments = planned if isinstance(planned, list) else [planned]
        stats = route_stats(segments)
        return float(stats["distance"])


def route_number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def is_subway_line(name: str | None) -> bool:
    text = str(name or "").lower()
    return any(keyword in text for keyword in ("地铁", "轨道", "轻轨", "metro", "subway", "mtr"))


def subway_line_color(name: str | None) -> str:
    text = str(name or "")
    match = re.search(r"(\d+)", text)
    if match:
        index = max(1, int(match.group(1))) - 1
    else:
        index = sum(ord(char) for char in text)
    return SUBWAY_LINE_COLORS[index % len(SUBWAY_LINE_COLORS)]


def make_route_segment(
    mode: str,
    path: list[list[float]],
    distance: Any = None,
    duration: Any = None,
    transit_tools: list[str] | None = None,
    transit_kind: str | None = None,
    transit_color: str | None = None,
) -> dict[str, Any] | None:
    deduped: list[list[float]] = []
    for point in path:
        if not deduped or deduped[-1] != point:
            deduped.append(point)
    if len(deduped) < 2:
        return None
    segment = {
        "mode": mode,
        "distance": route_number(distance, path_distance_meters(deduped)),
        "duration": route_number(duration, 0.0),
        "path": deduped,
        "transitTools": transit_tools or [],
    }
    if transit_kind:
        segment["transitKind"] = transit_kind
    if transit_color:
        segment["transitColor"] = transit_color
    return segment


def walking_segment_path(walking: dict[str, Any]) -> list[list[float]]:
    path = parse_polyline(walking.get("polyline"))
    for step in walking.get("steps", []) or []:
        path.extend(parse_polyline(step.get("polyline")))
    return path


def non_transit_step_path(route: dict[str, Any]) -> list[list[float]]:
    path: list[list[float]] = []
    for step in route.get("steps", []) or []:
        path.extend(parse_polyline(step.get("polyline")))
    return path


def non_transit_tmcs_path(route: dict[str, Any]) -> list[list[float]]:
    path: list[list[float]] = []
    for step in route.get("steps", []) or []:
        for tmcs in step.get("tmcs", []) or []:
            path.extend(parse_polyline(tmcs.get("polyline")))
    return path


def normalize_transit_route_segments(route: dict[str, Any]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []

    for segment in route.get("segments", []) or []:
        for walking_key in ("walking", "entrance"):
            walking = segment.get(walking_key) or {}
            walking_item = make_route_segment(
                "walking",
                walking_segment_path(walking),
                walking.get("distance"),
                walking.get("duration") or walking.get("time"),
            )
            if walking_item:
                segments.append(walking_item)

        for busline in segment.get("bus", {}).get("buslines") or []:
            tool = str(busline.get("name") or "").strip()
            transit_kind = "subway" if is_subway_line(tool) else "bus"
            transit_item = make_route_segment(
                "transit",
                parse_polyline(busline.get("polyline")),
                busline.get("distance"),
                busline.get("duration") or busline.get("time"),
                [tool] if tool else [],
                transit_kind,
                subway_line_color(tool) if transit_kind == "subway" else None,
            )
            if transit_item:
                segments.append(transit_item)

        railway = segment.get("railway") or {}
        tool = str(railway.get("name") or "").strip()
        railway_kind = "subway" if is_subway_line(tool) else "rail"
        railway_item = make_route_segment(
            "transit",
            parse_polyline(railway.get("polyline")),
            railway.get("distance"),
            railway.get("duration") or railway.get("time"),
            [tool] if tool else [],
            railway_kind,
            subway_line_color(tool) if railway_kind == "subway" else None,
        )
        if railway_item:
            segments.append(railway_item)

        exit_walking = segment.get("exit") or {}
        exit_walking_item = make_route_segment(
            "walking",
            walking_segment_path(exit_walking),
            exit_walking.get("distance"),
            exit_walking.get("duration") or exit_walking.get("time"),
        )
        if exit_walking_item:
            segments.append(exit_walking_item)

    if segments:
        return segments

    fallback = make_route_segment("transit", parse_polyline(route.get("polyline")), route.get("distance"), route.get("duration"))
    if fallback:
        return [fallback]
    raise RuntimeError("transit route path is empty")


def normalize_route_segments(route: dict[str, Any], mode: str) -> list[dict[str, Any]]:
    if mode == "transit":
        return normalize_transit_route_segments(route)

    candidates = [
        non_transit_tmcs_path(route),
        non_transit_step_path(route),
        parse_polyline(route.get("polyline")),
    ]
    path = next((candidate for candidate in candidates if len(candidate) >= 2), [])

    segment = make_route_segment(
        mode,
        path,
        route.get("distance"),
        route.get("duration") or route.get("time"),
    )
    if not segment:
        raise RuntimeError(f"{mode} route path is empty")
    return [segment]


def normalize_route_segment(route: dict[str, Any], mode: str) -> dict[str, Any]:
    segments = normalize_route_segments(route, mode)
    if len(segments) == 1:
        return segments[0]
    path: list[list[float]] = []
    tools: list[str] = []
    for segment in segments:
        path.extend(segment["path"])
        tools.extend(segment.get("transitTools") or [])
    merged = make_route_segment(
        mode,
        path,
        sum(route_number(segment.get("distance")) for segment in segments),
        sum(route_number(segment.get("duration")) for segment in segments),
        tools,
    )
    if not merged:
        raise RuntimeError(f"{mode} route path is empty")
    return merged
