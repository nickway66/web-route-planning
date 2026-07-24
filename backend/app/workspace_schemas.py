from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from fastapi import HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


MAX_BODY_BYTES = 5 * 1024 * 1024
MAX_LAYERS = 50
MAX_ROUTES_PER_LAYER = 50
MAX_POINTS_PER_ROUTE = 200


class WorkspaceModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _require_object(value: object, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be an object")
    return value


def _require_string(value: object, path: str) -> None:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{path} must be a non-empty string")


def validate_workspace_layers(layers: list[dict[str, Any]]) -> None:
    if len(layers) > MAX_LAYERS:
        raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="Workspace has too many layers")
    for layer_index, layer in enumerate(layers):
        layer = _require_object(layer, f"layers[{layer_index}]")
        _require_string(layer.get("id"), f"layers[{layer_index}].id")
        routes = layer.get("routes")
        if not isinstance(routes, list):
            raise ValueError(f"layers[{layer_index}].routes must be an array")
        if len(routes) > MAX_ROUTES_PER_LAYER:
            raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="Layer has too many routes")
        for route_index, route in enumerate(routes):
            route_path = f"layers[{layer_index}].routes[{route_index}]"
            route = _require_object(route, route_path)
            _require_string(route.get("id"), f"{route_path}.id")
            for required_key in ("points", "segmentModes", "segments"):
                if not isinstance(route.get(required_key), list):
                    raise ValueError(f"{route_path}.{required_key} must be an array")
            for required_key in ("stats", "meta"):
                _require_object(route.get(required_key), f"{route_path}.{required_key}")
            points = route["points"]
            if len(points) > MAX_POINTS_PER_ROUTE:
                raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="Route has too many points")
            for point_index, point in enumerate(points):
                point_path = f"{route_path}.points[{point_index}]"
                point = _require_object(point, point_path)
                if not _is_number(point.get("lng")) or not _is_number(point.get("lat")):
                    raise ValueError(f"{point_path}.lng and {point_path}.lat must be numbers")
            for segment_index, segment in enumerate(route["segments"]):
                _require_object(segment, f"{route_path}.segments[{segment_index}]")


class WorkspaceWrite(WorkspaceModel):
    data_version: int = Field(default=1, alias="dataVersion", ge=1, strict=True)
    layers: list[dict[str, Any]]

    @field_validator("layers")
    @classmethod
    def validate_layers(cls, layers: list[dict[str, Any]]) -> list[dict[str, Any]]:
        validate_workspace_layers(layers)
        return layers

    @model_validator(mode="after")
    def validate_size(self) -> "WorkspaceWrite":
        encoded = json.dumps(self.model_dump(by_alias=True), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_BODY_BYTES:
            raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="Workspace exceeds 5 MiB")
        return self


class WorkspaceResponse(WorkspaceModel):
    id: str | None
    name: str
    data_version: int = Field(alias="dataVersion")
    layers: list[dict[str, Any]]
    updated_at: datetime | None = Field(alias="updatedAt")
