def workspace_payload(*, layer_id: str = "layer-1") -> dict:
    return {
        "dataVersion": 1,
        "layers": [
            {
                "id": layer_id,
                "name": "上海",
                "color": "#1687ff",
                "visible": True,
                "selectedRouteId": "route-1",
                "futureLayerField": {"kept": True},
                "routes": [
                    {
                        "id": "route-1",
                        "visible": True,
                        "points": [{"name": "外滩", "lng": 121.49, "lat": 31.24, "futurePointField": "kept"}],
                        "segmentModes": [],
                        "segments": [],
                        "stats": {"distance": 0, "duration": 0},
                        "meta": {"name": "第一天", "days": 1, "note": "", "futureMetaField": True},
                        "futureRouteField": ["kept"],
                    }
                ],
            }
        ],
    }


def test_workspace_returns_empty_default_for_authenticated_user(auth_client):
    response = auth_client.get("/api/workspace")

    assert response.status_code == 200
    assert response.json() == {"id": None, "name": "我的路线", "dataVersion": 1, "layers": [], "updatedAt": None}


def test_workspace_round_trip_preserves_layers_and_unknown_fields(auth_client):
    payload = workspace_payload()

    saved = auth_client.put("/api/workspace", json=payload)
    restored = auth_client.get("/api/workspace")

    assert saved.status_code == 200
    assert saved.json()["layers"] == payload["layers"]
    assert restored.status_code == 200
    assert restored.json()["layers"] == payload["layers"]
    assert restored.json()["dataVersion"] == 1
    assert restored.json()["updatedAt"] is not None


def test_workspace_is_isolated_between_users(client, auth_client):
    assert auth_client.put("/api/workspace", json=workspace_payload()).status_code == 200

    registration = {"email": "second@example.com", "password": "correct-horse-42"}
    assert client.post("/api/auth/register", json=registration).status_code == 201
    token = client.post("/api/auth/login", json=registration).json()["accessToken"]
    response = client.get("/api/workspace", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    assert response.json()["layers"] == []


def test_workspace_rejects_invalid_route_shape(auth_client):
    payload = workspace_payload()
    del payload["layers"][0]["routes"][0]["segments"]

    response = auth_client.put("/api/workspace", json=payload)

    assert response.status_code == 422


def test_workspace_rejects_more_than_fifty_layers(auth_client):
    payload = {"dataVersion": 1, "layers": [workspace_payload(layer_id=f"layer-{index}")["layers"][0] for index in range(51)]}

    response = auth_client.put("/api/workspace", json=payload)

    assert response.status_code == 413


def test_workspace_rejects_non_integer_data_version(auth_client):
    payload = workspace_payload()
    payload["dataVersion"] = "1"

    response = auth_client.put("/api/workspace", json=payload)

    assert response.status_code == 422


def test_workspace_rejects_route_and_point_limits(auth_client):
    too_many_routes = workspace_payload()
    too_many_routes["layers"][0]["routes"] *= 51
    too_many_points = workspace_payload()
    too_many_points["layers"][0]["routes"][0]["points"] *= 201

    assert auth_client.put("/api/workspace", json=too_many_routes).status_code == 413
    assert auth_client.put("/api/workspace", json=too_many_points).status_code == 413


def test_workspace_rejects_payload_larger_than_five_mib(auth_client):
    payload = workspace_payload()
    payload["layers"][0]["routes"][0]["meta"]["largeUnknownField"] = "x" * (5 * 1024 * 1024)

    response = auth_client.put("/api/workspace", json=payload)

    assert response.status_code == 413


def test_workspace_rejects_oversized_raw_body_even_when_json_is_small(auth_client):
    payload = workspace_payload()
    raw_body = __import__("json").dumps(payload) + (" " * (5 * 1024 * 1024))

    response = auth_client.put("/api/workspace", content=raw_body, headers={"content-type": "application/json"})

    assert response.status_code == 413


def test_workspace_stops_reading_chunked_oversized_body_without_content_length():
    import asyncio

    from backend.app.main import app

    chunks = [
        {"type": "http.request", "body": b"{" + (b" " * (3 * 1024 * 1024)), "more_body": True},
        {"type": "http.request", "body": b" " * (3 * 1024 * 1024), "more_body": True},
        {"type": "http.request", "body": b"never-read", "more_body": False},
    ]
    sent = []
    receive_calls = 0

    async def receive():
        nonlocal receive_calls
        message = chunks[receive_calls]
        receive_calls += 1
        return message

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "PUT",
        "scheme": "http",
        "path": "/api/workspace",
        "raw_path": b"/api/workspace",
        "query_string": b"",
        "headers": [(b"content-type", b"application/json")],
        "client": ("testclient", 50000),
        "server": ("testserver", 80),
    }

    asyncio.run(app(scope, receive, send))

    assert sent[0]["status"] == 413
    assert receive_calls == 2


def test_workspace_rejects_oversized_content_length_without_reading_body():
    import asyncio

    from backend.app.main import app

    sent = []
    receive_calls = 0

    async def receive():
        nonlocal receive_calls
        receive_calls += 1
        raise AssertionError("body must not be read after Content-Length precheck")

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/workspace/import-local",
        "raw_path": b"/api/workspace/import-local",
        "query_string": b"",
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(5 * 1024 * 1024 + 1).encode())],
        "client": ("testclient", 50000),
        "server": ("testserver", 80),
    }

    asyncio.run(app(scope, receive, send))

    assert sent[0]["status"] == 413
    assert receive_calls == 0


def test_workspace_rejects_excessive_segments_and_segment_path_points(auth_client):
    too_many_segments = workspace_payload()
    too_many_segments["layers"][0]["routes"][0]["segments"] = [{"path": []}] * 201
    too_many_path_points = workspace_payload()
    too_many_path_points["layers"][0]["routes"][0]["segments"] = [{"path": [[121.49, 31.24]] * 501}]

    assert auth_client.put("/api/workspace", json=too_many_segments).status_code == 413
    assert auth_client.put("/api/workspace", json=too_many_path_points).status_code == 413


def test_import_local_does_not_overwrite_a_competing_import(db_session, monkeypatch):
    from sqlalchemy.orm import sessionmaker

    from backend.app.models import User, Workspace
    from backend.app.repositories import workspaces

    user = User(email="race@example.com", password_hash="hash", display_name="race")
    db_session.add(user)
    db_session.flush()
    db_session.add(Workspace(user_id=user.id, name="我的路线", layers_data=[]))
    db_session.commit()

    original_get = workspaces.get_by_user_id
    raced = False

    def get_then_allow_competing_import(session, user_id):
        nonlocal raced
        workspace = original_get(session, user_id)
        if not raced:
            raced = True
            other_session = sessionmaker(bind=session.get_bind())()
            try:
                other = original_get(other_session, user_id)
                other.layers_data = workspace_payload(layer_id="competing")["layers"]
                other_session.commit()
            finally:
                other_session.close()
        return workspace

    monkeypatch.setattr(workspaces, "get_by_user_id", get_then_allow_competing_import)

    with __import__("pytest").raises(workspaces.WorkspaceAlreadyExistsError):
        workspaces.create_from_import_if_empty(
            db_session, user_id=user.id, data_version=1, layers=workspace_payload()["layers"]
        )

    db_session.expire_all()
    assert original_get(db_session, user.id).layers_data[0]["id"] == "competing"


def test_import_local_only_creates_an_empty_workspace(auth_client):
    payload = workspace_payload()

    imported = auth_client.post("/api/workspace/import-local", json=payload)
    conflict = auth_client.post("/api/workspace/import-local", json=workspace_payload(layer_id="other"))

    assert imported.status_code == 201
    assert imported.json()["layers"] == payload["layers"]
    assert conflict.status_code == 409
