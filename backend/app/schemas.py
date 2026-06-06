from typing import Any, Literal

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class AIChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list)


class AIChatResponse(BaseModel):
    type: Literal["chat", "travel_advice", "route_plan", "cancel_or_negative"]
    reply: str
    plan: dict[str, Any] | None = None
    parsedPlan: dict[str, Any] | None = None


class Point(BaseModel):
    id: str | None = None
    name: str = ""
    address: str = ""
    city: str = ""
    lng: float
    lat: float
    priority: int = 1


class PlanRouteRequest(BaseModel):
    points: list[Point]
    segmentModes: list[str] = Field(default_factory=list)
    transitCity: str = ""


class PlanRouteResponse(BaseModel):
    segments: list[dict[str, Any]]
    stats: dict[str, float]


class AIBuildRequest(BaseModel):
    placeNames: list[str] = Field(default_factory=list)
    dayPlans: list[list[str]] = Field(default_factory=list)
    preferredCity: str = ""
    existingColors: list[str] = Field(default_factory=list)


class ExportRequest(BaseModel):
    layers: list[dict[str, Any]]
