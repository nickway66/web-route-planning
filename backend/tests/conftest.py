from importlib import import_module

import pytest
from sqlalchemy.orm import sessionmaker

from backend.app.config import settings
from backend.app.database import Base, get_db, make_engine


@pytest.fixture
def db_session(tmp_path):
    try:
        import_module("backend.app.models")
    except ModuleNotFoundError as error:
        if error.name != "backend.app.models":
            raise

    engine = make_engine(f"sqlite:///{tmp_path / 'test.db'}")
    testing_session_local = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    session = testing_session_local()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


@pytest.fixture
def client(db_session):
    from fastapi.testclient import TestClient

    from backend.app.main import app

    def override_get_db():
        yield db_session

    previous_jwt_secret = settings.jwt_secret
    settings.jwt_secret = "test-jwt-secret-that-is-at-least-thirty-two-bytes"
    previous_get_db_override = app.dependency_overrides.get(get_db)
    had_get_db_override = get_db in app.dependency_overrides
    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    if had_get_db_override:
        app.dependency_overrides[get_db] = previous_get_db_override
    else:
        app.dependency_overrides.pop(get_db, None)
    settings.jwt_secret = previous_jwt_secret


@pytest.fixture
def auth_client(client):
    import uuid

    payload = {"email": f"test-{uuid.uuid4().hex}@example.com", "password": "correct-horse-42"}
    assert client.post("/api/auth/register", json=payload).status_code == 201
    login = client.post("/api/auth/login", json=payload)
    assert login.status_code == 200
    client.headers.update({"Authorization": f"Bearer {login.json()['accessToken']}"})
    return client
