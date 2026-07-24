from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from backend.app.models import ChatMessage, Conversation


def list_for_user(db: Session, user_id: str) -> list[Conversation]:
    return list(
        db.scalars(
            select(Conversation)
            .where(Conversation.user_id == user_id)
            .order_by(Conversation.pinned.desc(), Conversation.updated_at.desc())
        )
    )


def get_for_user(db: Session, *, conversation_id: str, user_id: str, include_messages: bool = False) -> Conversation | None:
    statement = select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == user_id)
    if include_messages:
        statement = statement.options(selectinload(Conversation.messages))
    return db.scalar(statement)


def create_for_user(db: Session, *, user_id: str, title: str, city: str) -> Conversation:
    conversation = Conversation(user_id=user_id, title=title, city=city)
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return conversation


def count_for_user(db: Session, user_id: str) -> int:
    return db.scalar(select(func.count()).select_from(Conversation).where(Conversation.user_id == user_id)) or 0


def update(conversation: Conversation, *, title: str | None, city: str | None, pinned: bool | None, archived: bool | None, db: Session) -> Conversation:
    if title is not None:
        conversation.title = title
    if city is not None:
        conversation.city = city
    if pinned is not None:
        conversation.pinned = pinned
    if archived is not None:
        conversation.archived = archived
    db.commit()
    db.refresh(conversation)
    return conversation


def add_message(db: Session, *, conversation: Conversation, role: str, content: str) -> ChatMessage:
    """Persist a message and all denormalized conversation fields in one transaction."""
    message = ChatMessage(conversation_id=conversation.id, role=role, content=content, sequence=conversation.message_count + 1)
    db.add(message)
    conversation.message_count += 1
    conversation.last_preview = content[:500]
    # Assigning an updated field triggers SQLAlchemy's onupdate value on the same flush.
    conversation.updated_at = func.now()
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(message)
    db.refresh(conversation)
    return message


def delete(db: Session, conversation: Conversation) -> None:
    db.delete(conversation)
    db.commit()
