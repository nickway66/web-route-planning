from __future__ import annotations

import time

from sqlalchemy import delete as sql_delete, func, insert, select, update as sql_update
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, selectinload

from backend.app.models import ChatMessage, Conversation, User
from backend.app.models.user import generate_uuid, utc_now


class ConversationLimitReached(Exception):
    pass


class MessageLimitReached(Exception):
    pass


class ConversationNotFound(Exception):
    pass


class ConcurrentWriteConflict(Exception):
    pass


def _is_retryable_contention(error: OperationalError) -> bool:
    message = str(error).lower()
    return "database is locked" in message or "could not serialize" in message or "deadlock detected" in message


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
    """Acquire the owner's write lock before checking the quota.

    PostgreSQL locks this one user row; SQLite serializes writers, where
    ``SELECT FOR UPDATE`` alone is intentionally a no-op.
    """
    for attempt in range(3):
        try:
            lock_result = db.execute(
                sql_update(User).where(User.id == user_id).values(id=User.id)
            )
            if lock_result.rowcount != 1:
                db.rollback()
                raise ConversationNotFound
            if count_for_user(db, user_id) >= max_conversations:
                db.rollback()
                raise ConversationLimitReached
            conversation = Conversation(user_id=user_id, title=title, city=city)
            db.add(conversation)
            db.commit()
            db.refresh(conversation)
            return conversation
        except OperationalError as error:
            db.rollback()
            if not _is_retryable_contention(error):
                raise
            if attempt == 2:
                raise ConcurrentWriteConflict from error
            time.sleep(0.01 * (attempt + 1))
    raise RuntimeError("unreachable")


def count_for_user(db: Session, user_id: str) -> int:
    return db.scalar(select(func.count()).select_from(Conversation).where(Conversation.user_id == user_id)) or 0


def update(
    db: Session, *, conversation_id: str, user_id: str, title: str | None, city: str | None,
    pinned: bool | None, archived: bool | None,
) -> Conversation | None:
    values = {
        key: value
        for key, value in {"title": title, "city": city, "pinned": pinned, "archived": archived}.items()
        if value is not None
    }
    if not values:
        return get_for_user(db, conversation_id=conversation_id, user_id=user_id)
    values["updated_at"] = func.now()
    result = db.execute(
        sql_update(Conversation)
        .where(Conversation.id == conversation_id, Conversation.user_id == user_id)
        .values(**values)
    )
    if result.rowcount != 1:
        db.rollback()
        return None
    db.commit()
    conversation = db.get(Conversation, conversation_id)
    if conversation is None:
        return None
    return conversation


def add_message(
    db: Session, *, conversation: Conversation, user_id: str, role: str, content: str, max_messages: int
) -> ChatMessage:
    """Persist a message and all denormalized conversation fields in one transaction."""
    for attempt in range(3):
        try:
            next_sequence = db.execute(
                sql_update(Conversation)
                .where(Conversation.id == conversation.id, Conversation.message_count < max_messages)
                .values(
                    message_count=Conversation.message_count + 1,
                    last_preview=" ".join(content.split())[:80],
                    updated_at=func.now(),
                )
                .returning(Conversation.message_count)
            ).scalar_one_or_none()
            if next_sequence is None:
                still_owned = get_for_user(db, conversation_id=conversation.id, user_id=user_id)
                db.rollback()
                if still_owned is None:
                    raise ConversationNotFound
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
            db.commit()
            message = db.get(ChatMessage, message_id)
            if message is None:
                raise RuntimeError("Message disappeared after creation")
            return message
        except OperationalError as error:
            db.rollback()
            if not _is_retryable_contention(error):
                raise
            if attempt == 2:
                raise ConcurrentWriteConflict from error
            time.sleep(0.01 * (attempt + 1))
    raise RuntimeError("unreachable")


def delete(db: Session, *, conversation_id: str, user_id: str) -> bool:
    result = db.execute(
        sql_delete(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == user_id)
    )
    if result.rowcount != 1:
        db.rollback()
        return False
    db.commit()
    return True
