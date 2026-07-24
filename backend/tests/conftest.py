from importlib import import_module

import pytest
from sqlalchemy.orm import sessionmaker

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

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def auth_client(client):
    # TODO(Task 3): attach an authenticated user once authentication endpoints exist.
    return client
