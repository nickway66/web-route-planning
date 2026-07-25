from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING
import uuid

from sqlalchemy import Boolean, DateTime, String, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.database import Base

if TYPE_CHECKING:
    from .conversation import Conversation
    from .workspace import Workspace


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def generate_uuid() -> str:
    return str(uuid.uuid4())


UUID_SERVER_DEFAULT = text(
    "(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) "
    "|| '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))))"
)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid, server_default=UUID_SERVER_DEFAULT)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now)

    workspace: Mapped[Workspace | None] = relationship(back_populates="user", uselist=False, cascade="all, delete-orphan")
    conversations: Mapped[list[Conversation]] = relationship(back_populates="user", cascade="all, delete-orphan")
