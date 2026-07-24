def create_conversation(client, **overrides):
    payload = {"title": "Trip planning", "city": "Shanghai"}
    payload.update(overrides)
    return client.post("/api/conversations", json=payload)


def test_conversation_lifecycle_and_message_sequences(auth_client):
    created = create_conversation(auth_client)

    assert created.status_code == 201
    conversation = created.json()
    assert conversation["title"] == "Trip planning"
    assert conversation["city"] == "Shanghai"
    assert conversation["messageCount"] == 0
    conversation_id = conversation["id"]

    first = auth_client.post(f"/api/conversations/{conversation_id}/messages", json={"role": "user", "content": "Find museums"})
    second = auth_client.post(f"/api/conversations/{conversation_id}/messages", json={"role": "assistant", "content": "Here are three."})
    detail = auth_client.get(f"/api/conversations/{conversation_id}")

    assert first.status_code == 201
    assert second.status_code == 201
    assert [message["sequence"] for message in detail.json()["messages"]] == [1, 2]
    assert detail.json()["messageCount"] == 2
    assert detail.json()["lastPreview"] == "Here are three."

    updated = auth_client.patch(
        f"/api/conversations/{conversation_id}",
        json={"title": "Museum day", "city": "Hangzhou", "pinned": True, "archived": True},
    )
    assert updated.status_code == 200
    assert updated.json()["title"] == "Museum day"
    assert updated.json()["pinned"] is True
    assert updated.json()["archived"] is True

    deleted = auth_client.delete(f"/api/conversations/{conversation_id}")
    assert deleted.status_code == 204
    assert auth_client.get(f"/api/conversations/{conversation_id}").status_code == 404


def test_list_orders_pinned_then_updated_and_returns_summaries(auth_client):
    first = create_conversation(auth_client, title="First").json()
    second = create_conversation(auth_client, title="Second").json()
    assert auth_client.patch(f"/api/conversations/{first['id']}", json={"pinned": True}).status_code == 200
    assert auth_client.post(f"/api/conversations/{second['id']}/messages", json={"role": "user", "content": "newer"}).status_code == 201

    listed = auth_client.get("/api/conversations")

    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()] == [first["id"], second["id"]]
    assert "messages" not in listed.json()[0]


def test_conversations_are_hidden_from_other_users_and_delete_cascades(client, auth_client, db_session):
    conversation = create_conversation(auth_client).json()
    conversation_id = conversation["id"]
    assert auth_client.post(f"/api/conversations/{conversation_id}/messages", json={"role": "user", "content": "private"}).status_code == 201

    credentials = {"email": "other@example.com", "password": "correct-horse-42"}
    assert client.post("/api/auth/register", json=credentials).status_code == 201
    token = client.post("/api/auth/login", json=credentials).json()["accessToken"]
    other_headers = {"Authorization": f"Bearer {token}"}
    assert client.get(f"/api/conversations/{conversation_id}", headers=other_headers).status_code == 404
    assert client.patch(f"/api/conversations/{conversation_id}", json={"title": "no"}, headers=other_headers).status_code == 404
    assert client.delete(f"/api/conversations/{conversation_id}", headers=other_headers).status_code == 404

    assert auth_client.delete(f"/api/conversations/{conversation_id}").status_code == 204
    from backend.app.models import ChatMessage
    assert db_session.query(ChatMessage).filter_by(conversation_id=conversation_id).count() == 0


def test_conversation_validates_lengths_roles_and_limits(auth_client, monkeypatch):
    assert create_conversation(auth_client, title="x" * 81).status_code == 422
    assert create_conversation(auth_client, city="x" * 81).status_code == 422
    conversation_id = create_conversation(auth_client).json()["id"]
    assert auth_client.post(f"/api/conversations/{conversation_id}/messages", json={"role": "system", "content": "no"}).status_code == 422
    assert auth_client.post(f"/api/conversations/{conversation_id}/messages", json={"role": "user", "content": "x" * 8001}).status_code == 422

    from backend.app.routers import conversations
    monkeypatch.setattr(conversations, "MAX_MESSAGES_PER_CONVERSATION", 1)
    assert auth_client.post(f"/api/conversations/{conversation_id}/messages", json={"role": "user", "content": "one"}).status_code == 201
    assert auth_client.post(f"/api/conversations/{conversation_id}/messages", json={"role": "user", "content": "two"}).status_code == 413


def test_conversation_count_is_limited(auth_client, monkeypatch):
    from backend.app.routers import conversations

    monkeypatch.setattr(conversations, "MAX_CONVERSATIONS_PER_USER", 1)
    assert create_conversation(auth_client).status_code == 201
    assert create_conversation(auth_client, title="Another").status_code == 413


def test_concurrent_message_adds_allocate_distinct_sequences(db_session):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from sqlalchemy.orm import sessionmaker

    from backend.app.models import Conversation, User
    from backend.app.repositories import conversations

    user = User(email="concurrent@example.com", password_hash="hash", display_name="concurrent")
    db_session.add(user)
    db_session.flush()
    conversation = Conversation(user_id=user.id, title="Concurrent", city="")
    db_session.add(conversation)
    db_session.commit()
    conversation_id = conversation.id
    user_id = user.id
    barrier = Barrier(2)
    sessions = sessionmaker(bind=db_session.get_bind())

    def add(content):
        session = sessions()
        try:
            owned = conversations.get_for_user(session, conversation_id=conversation_id, user_id=user_id)
            barrier.wait()
            return conversations.add_message(
                session, conversation=owned, user_id=user_id, role="user", content=content, max_messages=1000
            ).sequence
        finally:
            session.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        sequences = list(executor.map(add, ["first", "second"]))

    db_session.expire_all()
    stored = conversations.get_for_user(db_session, conversation_id=conversation_id, user_id=user_id, include_messages=True)
    assert sorted(sequences) == [1, 2]
    assert stored.message_count == 2
    assert [message.sequence for message in stored.messages] == [1, 2]
    assert stored.last_preview == stored.messages[-1].content


def test_concurrent_creates_honor_the_conversation_cap(db_session):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from sqlalchemy.orm import sessionmaker

    from backend.app.models import User
    from backend.app.repositories import conversations

    user = User(email="create-race@example.com", password_hash="hash", display_name="create-race")
    db_session.add(user)
    db_session.commit()
    user_id = user.id
    barrier = Barrier(2)
    sessions = sessionmaker(bind=db_session.get_bind())

    def create(title):
        session = sessions()
        try:
            barrier.wait()
            return conversations.create_for_user(
                session, user_id=user_id, title=title, city="", max_conversations=1
            ).id
        finally:
            session.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(create, title) for title in ["one", "two"]]
    outcomes = []
    for future in futures:
        try:
            outcomes.append(future.result())
        except conversations.ConversationLimitReached:
            outcomes.append("limited")

    assert outcomes.count("limited") == 1
    assert conversations.count_for_user(db_session, user_id) == 1


def test_message_racing_with_delete_is_not_misreported_as_a_limit(db_session):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from sqlalchemy.orm import sessionmaker

    from backend.app.models import Conversation, User
    from backend.app.repositories import conversations

    user = User(email="delete-race@example.com", password_hash="hash", display_name="delete-race")
    db_session.add(user)
    db_session.flush()
    conversation = Conversation(user_id=user.id, title="Delete race", city="")
    db_session.add(conversation)
    db_session.commit()
    conversation_id = conversation.id
    user_id = user.id
    barrier = Barrier(2)
    sessions = sessionmaker(bind=db_session.get_bind())

    def add():
        session = sessions()
        try:
            owned = conversations.get_for_user(session, conversation_id=conversation_id, user_id=user_id)
            barrier.wait()
            try:
                conversations.add_message(
                    session, conversation=owned, user_id=user_id, role="user", content="racing", max_messages=1
                )
                return "created"
            except conversations.ConversationNotFound:
                return "not_found"
        finally:
            session.close()

    def delete():
        session = sessions()
        try:
            owned = conversations.get_for_user(session, conversation_id=conversation_id, user_id=user_id)
            barrier.wait()
            conversations.delete(session, conversation_id=owned.id, user_id=user_id)
            return "deleted"
        finally:
            session.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        added, deleted = executor.submit(add), executor.submit(delete)
        assert added.result() in {"created", "not_found"}
        assert deleted.result() == "deleted"

    db_session.expire_all()
    assert conversations.get_for_user(db_session, conversation_id=conversation_id, user_id=user_id) is None


def test_last_preview_collapses_whitespace_and_is_limited_to_eighty_characters(auth_client):
    conversation_id = create_conversation(auth_client).json()["id"]
    content = "  first\n\tsecond   " + ("x" * 100)

    response = auth_client.post(
        f"/api/conversations/{conversation_id}/messages", json={"role": "user", "content": content}
    )
    detail = auth_client.get(f"/api/conversations/{conversation_id}")

    assert response.status_code == 201
    assert detail.json()["lastPreview"] == ("first second " + ("x" * 100))[:80]
    assert len(detail.json()["lastPreview"]) == 80


def test_repository_update_and_delete_are_scoped_to_the_owner(db_session):
    from backend.app.models import Conversation, User
    from backend.app.repositories import conversations

    owner = User(email="owner-scope@example.com", password_hash="hash", display_name="owner")
    other = User(email="other-scope@example.com", password_hash="hash", display_name="other")
    db_session.add_all([owner, other])
    db_session.flush()
    conversation = Conversation(user_id=owner.id, title="Private", city="")
    db_session.add(conversation)
    db_session.commit()

    assert conversations.update(
        db_session, conversation_id=conversation.id, user_id=other.id, title="Hijacked", city=None, pinned=None, archived=None
    ) is None
    assert conversations.delete(db_session, conversation_id=conversation.id, user_id=other.id) is False
    db_session.refresh(conversation)
    assert conversation.title == "Private"

    updated = conversations.update(
        db_session, conversation_id=conversation.id, user_id=owner.id, title="Renamed", city=None, pinned=None, archived=None
    )
    assert updated.title == "Renamed"
    assert conversations.delete(db_session, conversation_id=conversation.id, user_id=owner.id) is True


def test_non_contention_database_error_is_not_translated_to_a_conflict(db_session, monkeypatch):
    import pytest
    from sqlalchemy.exc import OperationalError

    from backend.app.models import User
    from backend.app.repositories import conversations

    user = User(email="db-error@example.com", password_hash="hash", display_name="db-error")
    db_session.add(user)
    db_session.commit()
    user_id = user.id
    database_error = OperationalError("UPDATE users", {}, RuntimeError("connection reset"))

    def raise_database_error(*args, **kwargs):
        raise database_error

    monkeypatch.setattr(db_session, "execute", raise_database_error)
    with pytest.raises(OperationalError) as raised:
        conversations.create_for_user(db_session, user_id=user_id, title="Will fail", city="", max_conversations=1)
    assert raised.value is database_error


def test_repository_message_append_is_scoped_to_the_owner(db_session):
    import pytest

    from backend.app.models import Conversation, User
    from backend.app.repositories import conversations

    owner = User(email="message-owner@example.com", password_hash="hash", display_name="owner")
    other = User(email="message-other@example.com", password_hash="hash", display_name="other")
    db_session.add_all([owner, other])
    db_session.flush()
    conversation = Conversation(user_id=owner.id, title="Private", city="")
    db_session.add(conversation)
    db_session.commit()

    with pytest.raises(conversations.ConversationNotFound):
        conversations.add_message(
            db_session,
            conversation=conversation,
            user_id=other.id,
            role="user",
            content="unauthorized",
            max_messages=1,
        )

    db_session.refresh(conversation)
    assert conversation.message_count == 0
    assert conversation.last_preview == ""
