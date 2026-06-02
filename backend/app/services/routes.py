import math
import re
import time
import uuid
from typing import Any

from .amap import AMapClient, haversine_meters, route_stats


LAYER_COLORS = ["#2bd1ff", "#24e0a4", "#ffd166", "#ff7f51", "#f5f7fa", "#00f5d4", "#f4a261", "#e9c46a", "#66e3ff", "#8ecae6"]


def create_id(prefix: str) -> str:
    return f"{prefix}_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}"


def normalize_place_name(name: str | None) -> str:
    text = str(name or "").strip()
    text = re.sub(r"^[\d一二三四五六七八九十]+[\.\、\)\）\-\s]*", "", text)
    text = re.sub(r"^(起点|终点)\s*[:：]", "", text)
    text = re.sub(r"\s*[\(（]\s*(地铁|公交|驾车|步行|骑行|约\d+分钟|小时|公里)[^\)）]*[\)）]\s*", "", text)
    return text.strip()


def normalize_compare(name: str | None) -> str:
    return re.sub(r"[\s路·\-—_，。；:：,.;/\\|?？!！()\[\]{}<>《》“”\"'`~@#$%^&*]+", "", normalize_place_name(name).lower())


def point_distance_km(a: dict[str, Any], b: dict[str, Any]) -> float:
    try:
        return haversine_meters([float(a["lng"]), float(a["lat"])], [float(b["lng"]), float(b["lat"])]) / 1000
    except (KeyError, TypeError, ValueError):
        return math.inf


def optimize_point_order(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(points) <= 2:
        return points
    ordered = [points[0]]
    remaining = points[1:]
    while remaining:
        current = ordered[-1]
        next_index = min(range(len(remaining)), key=lambda index: point_distance_km(current, remaining[index]))
        ordered.append(remaining.pop(next_index))
    return ordered


async def build_route_cost_matrix(amap: AMapClient, points: list[dict[str, Any]]) -> dict[tuple[int, int], float]:
    matrix: dict[tuple[int, int], float] = {}
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


async def optimize_point_order_by_route_cost(amap: AMapClient, points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(points) <= 2:
        return points
    try:
        cost = await build_route_cost_matrix(amap, points)
        return nearest_neighbor_order(points, cost)
    except Exception:
        return optimize_point_order(points)


def pick_unique_color(used: list[str] | None = None) -> str:
    used_lower = {item.lower() for item in (used or [])}
    for color in LAYER_COLORS:
        if color.lower() not in used_lower:
            return color
    return "#8EC5FF"


def score_poi(poi: dict[str, Any], target_name: str, preferred_city: str = "", anchor: dict[str, Any] | None = None) -> float:
    target = normalize_compare(target_name)
    name = normalize_compare(poi.get("name"))
    address = normalize_compare(poi.get("address"))
    score = 0.0
    if target and name:
        if name == target:
            score += 120
        elif name in target or target in name:
            score += 70
    if target and address and target in address:
        score += 20
    if preferred_city:
        fields = [poi.get("city"), poi.get("province"), poi.get("district"), poi.get("address")]
        if any(preferred_city in str(field or "") or str(field or "") in preferred_city for field in fields if field):
            score += 35
    if anchor and poi.get("location"):
        candidate = {"lng": poi["location"][0], "lat": poi["location"][1]}
        distance = point_distance_km(anchor, candidate)
        if distance <= 3:
            score += 45
        elif distance <= 15:
            score += 30
        elif distance <= 60:
            score += 10
        elif distance > 200:
            score -= 50
    score -= min(20, abs(len(name) - len(target)))
    return score


def pick_best_poi(pois: list[dict[str, Any]], target_name: str, preferred_city: str = "", anchor: dict[str, Any] | None = None) -> dict[str, Any] | None:
    if not pois:
        return None
    return max(pois, key=lambda poi: score_poi(poi, target_name, preferred_city, anchor))


async def plan_route(amap: AMapClient, points: list[dict[str, Any]], segment_modes: list[str], transit_city: str = "") -> dict[str, Any]:
    if len(points) < 2:
        raise ValueError("At least two points are required")
    modes = segment_modes or ["driving"] * (len(points) - 1)
    segments = []
    for index in range(len(points) - 1):
        mode = modes[index] if index < len(modes) else "driving"
        planned = await amap.plan_segment(points[index], points[index + 1], mode, transit_city)
        planned_segments = planned if isinstance(planned, list) else [planned]
        for segment in planned_segments:
            segments.append({**segment, "legIndex": index, "requestedMode": mode})
    return {"segments": segments, "stats": route_stats(segments)}


async def plan_ai_driving_route(amap: AMapClient, points: list[dict[str, Any]], transit_city: str = "") -> dict[str, Any]:
    try:
        segments = await amap.plan_driving_route(points)
    except Exception:
        return await plan_route(amap, points, ["driving"] * (len(points) - 1), transit_city)
    return {"segments": segments, "stats": route_stats(segments)}


async def build_points_from_places(amap: AMapClient, names: list[str], preferred_city: str = "") -> tuple[list[dict[str, Any]], list[str]]:
    points: list[dict[str, Any]] = []
    misses: list[str] = []
    for raw_name in names:
        name = normalize_place_name(raw_name)
        if not name:
            continue
        queries = [f"{preferred_city}{name}", name] if preferred_city and not name.startswith(preferred_city) else [name]
        pois: list[dict[str, Any]] = []
        for query in queries:
            pois = await amap.search_poi(query, preferred_city)
            if pois:
                break
        poi = pick_best_poi(pois, name, preferred_city, points[-1] if points else None)
        if not poi:
            misses.append(name)
            continue
        display_lng, display_lat = poi["location"]
        route_lng, route_lat = poi.get("routeLocation") or poi["location"]
        points.append(
            {
                "id": create_id("pt"),
                "name": poi.get("name") or name,
                "address": poi.get("address") or "",
                "city": poi.get("city") or poi.get("province") or poi.get("district") or preferred_city,
                "lng": route_lng,
                "lat": route_lat,
                "displayLng": display_lng,
                "displayLat": display_lat,
                "priority": 1,
            }
        )
    return points, misses


async def build_ai_layers(amap: AMapClient, day_plans: list[list[str]], preferred_city: str = "", existing_colors: list[str] | None = None) -> dict[str, Any]:
    layers = []
    misses = []
    colors = list(existing_colors or [])
    for day_index, places in enumerate(day_plans[:10]):
        points, day_misses = await build_points_from_places(amap, places, preferred_city)
        if day_misses:
            misses.append({"day": day_index + 1, "places": day_misses})
        if len(points) < 2:
            continue
        ordered = await optimize_point_order_by_route_cost(amap, points)
        planned = await plan_ai_driving_route(amap, ordered, preferred_city)
        route_name = f"{preferred_city or 'AI路线'}-第{day_index + 1}天" if len(day_plans) > 1 else (preferred_city or "AI路线")
        route = {
            "id": create_id("route"),
            "visible": True,
            "historyId": None,
            "points": ordered,
            "segmentModes": ["driving"] * (len(ordered) - 1),
            "segments": planned["segments"],
            "stats": planned["stats"],
            "meta": {"name": route_name, "days": 1, "note": ""},
        }
        color = pick_unique_color(colors)
        colors.append(color)
        layer_id = create_id("layer")
        layers.append({"id": layer_id, "name": route_name, "color": color, "visible": True, "routes": [route], "selectedRouteId": route["id"]})
    return {"layers": layers, "misses": misses, "degraded": [], "inferredCity": preferred_city}
