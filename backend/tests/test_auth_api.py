import sqlite3

from sqlalchemy.exc import IntegrityError


def test_register_normalizes_email_and_hides_password_hash(client):
    response = client.post(
        "/api/auth/register",
        json={"email": "  USER@example.com  ", "password": "correct-horse-42"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["email"] == "user@example.com"
    assert "passwordHash" not in body
    assert "password_hash" not in body


def test_register_rejects_duplicate_email(client):
    payload = {"email": "user@example.com", "password": "correct-horse-42"}
    assert client.post("/api/auth/register", json=payload).status_code == 201

    response = client.post("/api/auth/register", json={**payload, "email": "USER@example.com"})

    assert response.status_code == 409


def test_register_returns_conflict_and_rolls_back_when_email_unique_constraint_races(client, db_session, monkeypatch):
    rollback_called = False
    original_rollback = db_session.rollback

    def raise_duplicate_email_error():
        raise IntegrityError(
            "INSERT INTO users ...",
            {},
            sqlite3.IntegrityError("UNIQUE constraint failed: users.email"),
        )

    def record_rollback():
        nonlocal rollback_called
        rollback_called = True
        original_rollback()

    monkeypatch.setattr(db_session, "commit", raise_duplicate_email_error)
    monkeypatch.setattr(db_session, "rollback", record_rollback)
    response = client.post(
        "/api/auth/register",
        json={"email": "racing@example.com", "password": "correct-horse-42"},
    )

    assert response.status_code == 409
    assert rollback_called is True


def test_register_validates_email_and_password_length(client):
    invalid_email = client.post("/api/auth/register", json={"email": "not-an-email", "password": "correct-horse-42"})
    short_password = client.post("/api/auth/register", json={"email": "user@example.com", "password": "too-short"})

    assert invalid_email.status_code == 422
    assert short_password.status_code == 422


def test_login_returns_bearer_token_and_me_returns_public_user(client):
    payload = {"email": "user@example.com", "password": "correct-horse-42"}
    assert client.post("/api/auth/register", json=payload).status_code == 201

    login = client.post("/api/auth/login", json=payload)

    assert login.status_code == 200
    token_payload = login.json()
    assert token_payload["tokenType"] == "bearer"
    assert token_payload["accessToken"]
    assert "passwordHash" not in token_payload["user"]
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token_payload['accessToken']}"})
    assert me.status_code == 200
    assert me.json()["email"] == "user@example.com"


def test_login_failure_does_not_reveal_account_state(client, db_session):
    from backend.app.models import User

    payload = {"email": "user@example.com", "password": "correct-horse-42"}
    assert client.post("/api/auth/register", json=payload).status_code == 201
    user = db_session.query(User).filter_by(email="user@example.com").one()
    user.is_active = False
    db_session.commit()

    responses = [
        client.post("/api/auth/login", json={"email": "missing@example.com", "password": "correct-horse-42"}),
        client.post("/api/auth/login", json={"email": "user@example.com", "password": "wrong-password-42"}),
        client.post("/api/auth/login", json=payload),
    ]

    assert all(response.status_code == 401 for response in responses)
    assert {response.json()["detail"] for response in responses} == {"邮箱或密码错误"}


def test_me_requires_a_bearer_token(client):
    response = client.get("/api/auth/me")

    assert response.status_code == 401


def test_register_works_without_jwt_secret_but_login_reports_configuration_error(client, monkeypatch):
    from backend.app.config import settings

    monkeypatch.setattr(settings, "jwt_secret", "")
    register = client.post(
        "/api/auth/register",
        json={"email": "user@example.com", "password": "correct-horse-42"},
    )

    assert register.status_code == 201
    login = client.post(
        "/api/auth/login",
        json={"email": "user@example.com", "password": "correct-horse-42"},
    )
    assert login.status_code == 500
    assert "JWT_SECRET" in login.json()["detail"]


def test_me_reports_missing_jwt_secret_after_a_token_was_issued(client, monkeypatch):
    payload = {"email": "user@example.com", "password": "correct-horse-42"}
    assert client.post("/api/auth/register", json=payload).status_code == 201
    token = client.post("/api/auth/login", json=payload).json()["accessToken"]

    from backend.app.config import settings

    monkeypatch.setattr(settings, "jwt_secret", "")
    response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 500
    assert "JWT_SECRET" in response.json()["detail"]
