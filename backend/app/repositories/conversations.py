from __future__ import annotations

from sqlalchemy import func, insert, literal, select, update as sql_update
from sqlalchemy.orm import Session, selectinload

from backend.app.models import ChatMessage, Conversation
from backend.app.models.user import generate_uuid, utc_now


class ConversationLimitReached(Exception):
    pass


class MessageLimitReached(Exception):
    pass


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


def create_for_user(
    db: Session, *, user_id: str, title: str, city: str, max_conversations: int
) -> Conversation:
    """Create only when the per-user cap is still available in this SQL statement."""
    conversation_id = generate_uuid()
    now = utc_now()
    under_limit = select(func.count()).select_from(Conversation).where(Conversation.user_id == user_id).scalar_subquery() < max_conversations
    result = db.execute(
        insert(Conversation).from_select(
            [
                "id", "user_id", "title", "city", "pinned", "archived", "route_count", "message_count",
                "last_preview", "created_at", "updated_at",
            ],
            select(
                literal(conversation_id), literal(user_id), literal(title), literal(city), literal(False), literal(False),
                literal(0), literal(0), literal(""), literal(now), literal(now),
            ).where(under_limit),
        )
    )
    if result.rowcount != 1:
        db.rollback()
        raise ConversationLimitReached
    db.commit()
    conversation = db.get(Conversation, conversation_id)
    if conversation is None:
        raise RuntimeError("Conversation disappeared after creation")
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


def add_message(
    db: Session, *, conversation: Conversation, role: str, content: str, max_messages: int
) -> ChatMessage:
    """Persist a message and all denormalized conversation fields in one transaction."""
    next_sequence = db.execute(
        sql_update(Conversation)
        .where(Conversation.id == conversation.id, Conversation.message_count < max_messages)
        .values(
            message_count=Conversation.message_count + 1,
            last_preview=content[:500],
            updated_at=func.now(),
        )
        .returning(Conversation.message_count)
    ).scalar_one_or_none()
    if next_sequence is None:
        db.rollback()
        raise MessageLimitReached
    message_id = generate_uuid()
    db.execute(
        insert(ChatMessage).values(
            id=message_id,
            conversation_id=conversation.id,
            role=role,
            content=content,
            sequence=next_sequence,
            created_at=utc_now(),
        )
    )
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    message = db.get(ChatMessage, message_id)
    if message is None:
        raise RuntimeError("Message disappeared after creation")
    return message


def delete(db: Session, conversation: Conversation) -> None:
    db.delete(conversation)
    db.commit()
