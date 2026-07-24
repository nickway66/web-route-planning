from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text


def test_models_define_required_ownership_constraints():
    from backend.app.models import ChatMessage, Conversation, Workspace

    assert Workspace.__table__.c.user_id.unique is True
    assert Conversation.__table__.c.user_id.nullable is False
    assert ChatMessage.__table__.c.conversation_id.nullable is False
    assert "sequence" in ChatMessage.__table__.c
    assert any(
        constraint.columns.keys() == ["conversation_id", "sequence"]
        for constraint in ChatMessage.__table__.constraints
    )


def test_alembic_upgrade_creates_chat_tables_with_cascade_foreign_key(tmp_path, monkeypatch):
    from backend.app.config import settings

    database_path = tmp_path / "models.db"
    monkeypatch.setattr(settings, "database_url", f"sqlite:///{database_path}")
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))

    command.upgrade(config, "head")

    engine = create_engine(f"sqlite:///{database_path}")
    try:
        with engine.connect() as connection:
            connection.execute(text("PRAGMA foreign_keys=ON"))
            assert connection.execute(text("PRAGMA foreign_keys")).scalar() == 1
            foreign_keys = inspect(connection).get_foreign_keys("chat_messages")

        assert {"users", "workspaces", "conversations", "chat_messages"} <= set(inspect(engine).get_table_names())
        assert any(
            foreign_key["constrained_columns"] == ["conversation_id"]
            and foreign_key["options"].get("ondelete") == "CASCADE"
            for foreign_key in foreign_keys
        )
    finally:
        engine.dispose()
