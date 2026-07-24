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
