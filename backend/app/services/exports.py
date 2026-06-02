import html
import json
from typing import Any


def create_json(layers: list[dict[str, Any]]) -> str:
    return json.dumps(layers, ensure_ascii=False, indent=2)


def create_gpx(layers: list[dict[str, Any]]) -> str:
    parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<gpx version="1.1" creator="WEBMAP_VS">']
    for layer in layers:
        for route_index, route in enumerate(layer.get("routes") or []):
            name = html.escape(str(route.get("meta", {}).get("name") or layer.get("name") or f"route-{route_index + 1}"))
            parts.append("<trk>")
            parts.append(f"<name>{name}</name>")
            parts.append("<trkseg>")
            for segment in route.get("segments") or []:
                for point in segment.get("path") or []:
                    if len(point) >= 2:
                        parts.append(f'<trkpt lat="{point[1]}" lon="{point[0]}"></trkpt>')
            parts.append("</trkseg>")
            parts.append("</trk>")
            for point in route.get("points") or []:
                point_name = html.escape(str(point.get("name") or "point"))
                parts.append(f'<wpt lat="{point.get("lat")}" lon="{point.get("lng")}"><name>{point_name}</name></wpt>')
    parts.append("</gpx>")
    return "\n".join(parts)
