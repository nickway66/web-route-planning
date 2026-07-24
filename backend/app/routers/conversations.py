from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from backend.app.conversation_schemas import (
    ConversationCreate,
    ConversationDetail,
    ConversationSummary,
    ConversationUpdate,
    MessageCreate,
    MessageResponse,
)
from backend.app.database import get_db
from backend.app.dependencies.auth import get_current_user
from backend.app.models import ChatMessage, Conversation, User
from backend.app.repositories import conversations


MAX_CONVERSATIONS_PER_USER = 100
MAX_MESSAGES_PER_CONVERSATION = 1000

router = APIRouter()
DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


def summary_for(conversation: Conversation) -> ConversationSummary:
    return ConversationSummary(
        id=conversation.id,
        title=conversation.title,
        city=conversation.city,
        pinned=conversation.pinned,
        archived=conversation.archived,
        route_count=conversation.route_count,
        message_count=conversation.message_count,
        last_preview=conversation.last_preview,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
    )


def message_for(message: ChatMessage) -> MessageResponse:
    return MessageResponse(id=message.id, role=message.role, content=message.content, sequence=message.sequence, created_at=message.created_at)


def detail_for(conversation: Conversation) -> ConversationDetail:
    return ConversationDetail(**summary_for(conversation).model_dump(), messages=[message_for(message) for message in conversation.messages])


def find_or_404(db: Session, user: User, conversation_id: str, *, include_messages: bool = False) -> Conversation:
    conversation = conversations.get_for_user(db, conversation_id=conversation_id, user_id=user.id, include_messages=include_messages)
    if conversation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return conversation


@router.get("", response_model=list[ConversationSummary])
def list_conversations(current_user: CurrentUser, db: DbSession) -> list[ConversationSummary]:
    return [summary_for(conversation) for conversation in conversations.list_for_user(db, current_user.id)]


@router.post("", response_model=ConversationSummary, status_code=status.HTTP_201_CREATED)
def create_conversation(payload: ConversationCreate, current_user: CurrentUser, db: DbSession) -> ConversationSummary:
    try:
        conversation = conversations.create_for_user(
            db,
            user_id=current_user.id,
            title=payload.title,
            city=payload.city,
            max_conversations=MAX_CONVERSATIONS_PER_USER,
        )
    except conversations.ConversationLimitReached as error:
        raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="Conversation limit reached")
    return summary_for(conversation)


@router.get("/{conversation_id}", response_model=ConversationDetail)
def get_conversation(conversation_id: str, current_user: CurrentUser, db: DbSession) -> ConversationDetail:
    return detail_for(find_or_404(db, current_user, conversation_id, include_messages=True))


@router.patch("/{conversation_id}", response_model=ConversationSummary)
def update_conversation(conversation_id: str, payload: ConversationUpdate, current_user: CurrentUser, db: DbSession) -> ConversationSummary:
    conversation = find_or_404(db, current_user, conversation_id)
    return summary_for(conversations.update(conversation, db=db, **payload.model_dump()))


@router.post("/{conversation_id}/messages", response_model=MessageResponse, status_code=status.HTTP_201_CREATED)
def create_message(conversation_id: str, payload: MessageCreate, current_user: CurrentUser, db: DbSession) -> MessageResponse:
    conversation = find_or_404(db, current_user, conversation_id)
    try:
        message = conversations.add_message(
            db,
            conversation=conversation,
            role=payload.role,
            content=payload.content,
            max_messages=MAX_MESSAGES_PER_CONVERSATION,
        )
    except conversations.MessageLimitReached as error:
        raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="Message limit reached")
    return message_for(message)


@router.delete("/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_conversation(conversation_id: str, current_user: CurrentUser, db: DbSession) -> Response:
    conversations.delete(db, find_or_404(db, current_user, conversation_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
