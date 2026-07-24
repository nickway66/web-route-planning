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


def test_import_local_only_creates_an_empty_workspace(auth_client):
    payload = workspace_payload()

    imported = auth_client.post("/api/workspace/import-local", json=payload)
    conflict = auth_client.post("/api/workspace/import-local", json=workspace_payload(layer_id="other"))

    assert imported.status_code == 201
    assert imported.json()["layers"] == payload["layers"]
    assert conflict.status_code == 409
