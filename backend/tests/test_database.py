import inspect
from pathlib import Path

from sqlalchemy import text

from backend.app.database import make_engine
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


def test_gitignore_ignores_sqlite_wal_and_shm_sidecars():
    gitignore = Path(__file__).parents[2] / ".gitignore"
    rules = gitignore.read_text(encoding="utf-8")

    assert "backend/data/*.db-wal" in rules
    assert "backend/data/*.db-shm" in rules
