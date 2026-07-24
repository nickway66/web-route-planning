import inspect
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

from sqlalchemy import text

from backend.app.database import get_db, make_engine
from backend.tests import conftest


def test_sqlite_engine_enables_foreign_keys(tmp_path):
    engine = make_engine(f"sqlite:///{tmp_path / 'test.db'}")

    with engine.connect() as connection:
        assert connection.execute(text("PRAGMA foreign_keys")).scalar() == 1

    engine.dispose()


def test_sqlite_engine_creates_missing_parent_directory(tmp_path):
    database_path = tmp_path / "nested" / "web_route_planning.db"
    engine = make_engine(f"sqlite:///{database_path}")

    with engine.connect():
        pass

    assert database_path.exists()
    engine.dispose()


def test_database_fixture_uses_production_engine_and_loads_models_before_creating_tables():
    fixture_source = inspect.getsource(conftest.db_session)

    assert "make_engine" in fixture_source
    assert 'import_module("backend.app.models")' in fixture_source
    assert fixture_source.index('import_module("backend.app.models")') < fixture_source.index("Base.metadata.create_all")


def test_database_test_fixtures_exclude_auth_client_until_auth_api_exists():
    assert not hasattr(conftest, "auth_client")


def _client_fixture_with_fake_app(monkeypatch, db_session):
    fake_app = SimpleNamespace(dependency_overrides={})

    class FakeTestClient:
        def __init__(self, app):
            self.app = app

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

    fastapi_module = ModuleType("fastapi")
    testclient_module = ModuleType("fastapi.testclient")
    testclient_module.TestClient = FakeTestClient
    main_module = ModuleType("backend.app.main")
    main_module.app = fake_app
    monkeypatch.setitem(sys.modules, "fastapi", fastapi_module)
    monkeypatch.setitem(sys.modules, "fastapi.testclient", testclient_module)
    monkeypatch.setitem(sys.modules, "backend.app.main", main_module)

    return fake_app, conftest.client.__wrapped__(db_session)


def test_client_fixture_teardown_preserves_unrelated_dependency_overrides(monkeypatch, db_session):
    def unrelated_dependency():
        return None

    def unrelated_override():
        return "preserved"

    app, client_fixture = _client_fixture_with_fake_app(monkeypatch, db_session)
    app.dependency_overrides[unrelated_dependency] = unrelated_override

    try:
        next(client_fixture)

        try:
            next(client_fixture)
        except StopIteration:
            pass

        assert app.dependency_overrides[unrelated_dependency] is unrelated_override
        assert get_db not in app.dependency_overrides
    finally:
        app.dependency_overrides.clear()


def test_client_fixture_teardown_restores_previous_get_db_override(monkeypatch, db_session):
    def original_get_db_override():
        yield db_session

    app, client_fixture = _client_fixture_with_fake_app(monkeypatch, db_session)
    app.dependency_overrides[get_db] = original_get_db_override

    try:
        next(client_fixture)

        try:
            next(client_fixture)
        except StopIteration:
            pass

        assert app.dependency_overrides[get_db] is original_get_db_override
    finally:
        app.dependency_overrides.clear()


def test_gitignore_ignores_sqlite_wal_and_shm_sidecars():
    gitignore = Path(__file__).parents[2] / ".gitignore"
    rules = gitignore.read_text(encoding="utf-8")

    assert "backend/data/*.db-wal" in rules
    assert "backend/data/*.db-shm" in rules
