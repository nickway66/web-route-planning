from pathlib import Path
import uuid

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


def test_models_generate_uuid_primary_keys_on_flush(db_session):
    from backend.app.models import ChatMessage, Conversation, User, Workspace

    user = User(email="user@example.com", password_hash="hash", display_name="User")
    workspace = Workspace(user=user)
    conversation = Conversation(user=user)
    message = ChatMessage(conversation=conversation, role="user", content="Hello", sequence=1)
    db_session.add_all([user, workspace, conversation, message])

    db_session.flush()

    for instance in (user, workspace, conversation, message):
        assert isinstance(instance.id, str)
        assert len(instance.id) == 36
        assert str(uuid.UUID(instance.id)) == instance.id


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
            connection.execute(
                text(
                    "INSERT INTO users (email, password_hash, display_name, is_active, created_at, updated_at) "
                    "VALUES ('migration@example.com', 'hash', 'Migration', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                )
            )
            generated_id = connection.execute(text("SELECT id FROM users WHERE email = 'migration@example.com'")).scalar_one()

        assert {"users", "workspaces", "conversations", "chat_messages"} <= set(inspect(engine).get_table_names())
        assert str(uuid.UUID(generated_id)) == generated_id
        assert any(
            foreign_key["constrained_columns"] == ["conversation_id"]
            and foreign_key["options"].get("ondelete") == "CASCADE"
            for foreign_key in foreign_keys
        )
    finally:
        engine.dispose()


def test_alembic_upgrade_from_0001_adds_uuid_defaults_to_existing_tables(tmp_path, monkeypatch):
    from backend.app.config import settings

    database_path = tmp_path / "upgraded-models.db"
    database_url = f"sqlite:///{database_path}"
    monkeypatch.setattr(settings, "database_url", database_url)
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))

    command.upgrade(config, "0001")
    command.upgrade(config, "head")

    engine = create_engine(database_url)
    try:
        with engine.begin() as connection:
            user_id = connection.execute(
                text(
                    "INSERT INTO users (email, password_hash, display_name, is_active, created_at, updated_at) "
                    "VALUES ('upgraded@example.com', 'hash', 'Upgraded', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) "
                    "RETURNING id"
                )
            ).scalar_one()
            workspace_id = connection.execute(
                text(
                    "INSERT INTO workspaces (user_id, name, data_version, layers_data, layer_count, route_count, point_count, created_at, updated_at) "
                    "VALUES (:user_id, 'Workspace', 1, '[]', 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id"
                ),
                {"user_id": user_id},
            ).scalar_one()
            conversation_id = connection.execute(
                text(
                    "INSERT INTO conversations (user_id, title, city, pinned, archived, route_count, message_count, last_preview, created_at, updated_at) "
                    "VALUES (:user_id, 'Conversation', '', 0, 0, 0, 0, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id"
                ),
                {"user_id": user_id},
            ).scalar_one()
            message_id = connection.execute(
                text(
                    "INSERT INTO chat_messages (conversation_id, role, content, created_at, sequence) "
                    "VALUES (:conversation_id, 'user', 'Hello', CURRENT_TIMESTAMP, 1) RETURNING id"
                ),
                {"conversation_id": conversation_id},
            ).scalar_one()

        for generated_id in (user_id, workspace_id, conversation_id, message_id):
            assert str(uuid.UUID(generated_id)) == generated_id
    finally:
        engine.dispose()
