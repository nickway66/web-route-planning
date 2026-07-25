from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ConversationModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)


class ConversationCreate(ConversationModel):
    title: str = Field(default="New conversation", min_length=1, max_length=80)
    city: str = Field(default="", max_length=80)


class ConversationUpdate(ConversationModel):
    title: str | None = Field(default=None, min_length=1, max_length=80)
    city: str | None = Field(default=None, max_length=80)
    pinned: bool | None = None
    archived: bool | None = None


class MessageCreate(ConversationModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)


class MessageResponse(ConversationModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    sequence: int
    created_at: datetime = Field(alias="createdAt")


class ConversationSummary(ConversationModel):
    id: str
    title: str
    city: str
    pinned: bool
    archived: bool
    route_count: int = Field(alias="routeCount")
    message_count: int = Field(alias="messageCount")
    last_preview: str = Field(alias="lastPreview")
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")


class ConversationDetail(ConversationSummary):
    messages: list[MessageResponse]
