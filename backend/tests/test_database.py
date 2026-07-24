from sqlalchemy import text

from backend.app.database import make_engine


def test_sqlite_engine_enables_foreign_keys(tmp_path):
    engine = make_engine(f"sqlite:///{tmp_path / 'test.db'}")

    with engine.connect() as connection:
        assert connection.execute(text("PRAGMA foreign_keys")).scalar() == 1

    engine.dispose()
