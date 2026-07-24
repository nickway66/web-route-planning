from pathlib import Path
import uuid

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
import pytest


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


def test_alembic_uuid_default_migration_preserves_existing_data_and_schema(tmp_path, monkeypatch):
    from backend.app.config import settings

    database_path = tmp_path / "legacy-models.db"
    database_url = f"sqlite:///{database_path}"
    monkeypatch.setattr(settings, "database_url", database_url)
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    legacy_ids = {name: str(uuid.uuid4()) for name in ("user", "workspace", "conversation", "message")}

    command.upgrade(config, "0001")
    engine = create_engine(database_url)
    try:
        with engine.begin() as connection:
            connection.execute(text("PRAGMA foreign_keys=ON"))
            connection.execute(
                text(
                    "INSERT INTO users (id, email, password_hash, display_name, is_active, created_at, updated_at) "
                    "VALUES (:id, 'legacy@example.com', 'hash', 'Legacy user', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                ),
                {"id": legacy_ids["user"]},
            )
            connection.execute(
                text(
                    "INSERT INTO workspaces (id, user_id, name, data_version, layers_data, layer_count, route_count, point_count, created_at, updated_at) "
                    "VALUES (:id, :user_id, 'Legacy workspace', 1, '[]', 2, 3, 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                ),
                {"id": legacy_ids["workspace"], "user_id": legacy_ids["user"]},
            )
            connection.execute(
                text(
                    "INSERT INTO conversations (id, user_id, title, city, pinned, archived, route_count, message_count, last_preview, created_at, updated_at) "
                    "VALUES (:id, :user_id, 'Legacy conversation', 'Shenzhen', 1, 0, 5, 6, 'Legacy preview', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                ),
                {"id": legacy_ids["conversation"], "user_id": legacy_ids["user"]},
            )
            connection.execute(
                text(
                    "INSERT INTO chat_messages (id, conversation_id, role, content, created_at, sequence) "
                    "VALUES (:id, :conversation_id, 'user', 'Legacy message', CURRENT_TIMESTAMP, 1)"
                ),
                {"id": legacy_ids["message"], "conversation_id": legacy_ids["conversation"]},
            )

        command.upgrade(config, "head")
        _assert_legacy_data_and_constraints(engine, legacy_ids)
        _assert_cascade_delete(engine)

        command.downgrade(config, "0001")
        _assert_legacy_data_and_constraints(engine, legacy_ids)

        command.upgrade(config, "head")
        _assert_legacy_data_and_constraints(engine, legacy_ids)
        _assert_sqlite_uuid_defaults(engine)
    finally:
        engine.dispose()


def _assert_legacy_data_and_constraints(engine, legacy_ids):
    with engine.connect() as connection:
        assert connection.execute(text("SELECT id FROM users WHERE email = 'legacy@example.com'")).scalar_one() == legacy_ids["user"]
        assert connection.execute(text("SELECT user_id FROM workspaces WHERE id = :id"), {"id": legacy_ids["workspace"]}).scalar_one() == legacy_ids["user"]
        assert connection.execute(text("SELECT user_id FROM conversations WHERE id = :id"), {"id": legacy_ids["conversation"]}).scalar_one() == legacy_ids["user"]
        assert connection.execute(text("SELECT conversation_id FROM chat_messages WHERE id = :id"), {"id": legacy_ids["message"]}).scalar_one() == legacy_ids["conversation"]

    inspector = inspect(engine)
    assert any(index["name"] == "ix_users_email" and index["unique"] for index in inspector.get_indexes("users"))
    assert any(constraint["column_names"] == ["user_id"] for constraint in inspector.get_unique_constraints("workspaces"))
    assert any(index["name"] == "ix_conversations_user_id" for index in inspector.get_indexes("conversations"))
    assert any(constraint["column_names"] == ["conversation_id", "sequence"] for constraint in inspector.get_unique_constraints("chat_messages"))
    assert _cascade_foreign_key(inspector, "workspaces", "user_id")
    assert _cascade_foreign_key(inspector, "conversations", "user_id")
    assert _cascade_foreign_key(inspector, "chat_messages", "conversation_id")

    with pytest.raises(IntegrityError):
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO users (id, email, password_hash, display_name, is_active, created_at, updated_at) "
                    "VALUES (:id, 'legacy@example.com', 'hash', 'Duplicate', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                ),
                {"id": str(uuid.uuid4())},
            )
    with pytest.raises(IntegrityError):
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO workspaces (id, user_id, name, data_version, layers_data, layer_count, route_count, point_count, created_at, updated_at) "
                    "VALUES (:id, :user_id, 'Duplicate', 1, '[]', 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                ),
                {"id": str(uuid.uuid4()), "user_id": legacy_ids["user"]},
            )
    with pytest.raises(IntegrityError):
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO chat_messages (id, conversation_id, role, content, created_at, sequence) "
                    "VALUES (:id, :conversation_id, 'user', 'Duplicate', CURRENT_TIMESTAMP, 1)"
                ),
                {"id": str(uuid.uuid4()), "conversation_id": legacy_ids["conversation"]},
            )


def _cascade_foreign_key(inspector, table_name, column_name):
    return any(
        foreign_key["constrained_columns"] == [column_name] and foreign_key["options"].get("ondelete") == "CASCADE"
        for foreign_key in inspector.get_foreign_keys(table_name)
    )


def _assert_cascade_delete(engine):
    cascade_user_id = str(uuid.uuid4())
    cascade_workspace_id = str(uuid.uuid4())
    cascade_conversation_id = str(uuid.uuid4())
    cascade_message_id = str(uuid.uuid4())
    with engine.begin() as connection:
        connection.execute(text("PRAGMA foreign_keys=ON"))
        connection.execute(
            text("INSERT INTO users (id, email, password_hash, display_name, is_active, created_at, updated_at) VALUES (:id, :email, 'hash', 'Cascade', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"),
            {"id": cascade_user_id, "email": f"{cascade_user_id}@example.com"},
        )
        connection.execute(
            text("INSERT INTO workspaces (id, user_id, name, data_version, layers_data, layer_count, route_count, point_count, created_at, updated_at) VALUES (:id, :user_id, 'Cascade', 1, '[]', 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"),
            {"id": cascade_workspace_id, "user_id": cascade_user_id},
        )
        connection.execute(
            text("INSERT INTO conversations (id, user_id, title, city, pinned, archived, route_count, message_count, last_preview, created_at, updated_at) VALUES (:id, :user_id, 'Cascade', '', 0, 0, 0, 0, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"),
            {"id": cascade_conversation_id, "user_id": cascade_user_id},
        )
        connection.execute(
            text("INSERT INTO chat_messages (id, conversation_id, role, content, created_at, sequence) VALUES (:id, :conversation_id, 'user', 'Cascade', CURRENT_TIMESTAMP, 1)"),
            {"id": cascade_message_id, "conversation_id": cascade_conversation_id},
        )
        connection.execute(text("DELETE FROM users WHERE id = :id"), {"id": cascade_user_id})
        assert connection.execute(text("SELECT COUNT(*) FROM workspaces WHERE id = :id"), {"id": cascade_workspace_id}).scalar_one() == 0
        assert connection.execute(text("SELECT COUNT(*) FROM conversations WHERE id = :id"), {"id": cascade_conversation_id}).scalar_one() == 0
        assert connection.execute(text("SELECT COUNT(*) FROM chat_messages WHERE id = :id"), {"id": cascade_message_id}).scalar_one() == 0


def _assert_sqlite_uuid_defaults(engine):
    with engine.begin() as connection:
        user_id = connection.execute(
            text("INSERT INTO users (email, password_hash, display_name, is_active, created_at, updated_at) VALUES ('post-cycle@example.com', 'hash', 'Post cycle', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id")
        ).scalar_one()
        workspace_id = connection.execute(
            text("INSERT INTO workspaces (user_id, name, data_version, layers_data, layer_count, route_count, point_count, created_at, updated_at) VALUES (:user_id, 'Post cycle', 1, '[]', 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id"),
            {"user_id": user_id},
        ).scalar_one()
        conversation_id = connection.execute(
            text("INSERT INTO conversations (user_id, title, city, pinned, archived, route_count, message_count, last_preview, created_at, updated_at) VALUES (:user_id, 'Post cycle', '', 0, 0, 0, 0, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id"),
            {"user_id": user_id},
        ).scalar_one()
        message_id = connection.execute(
            text("INSERT INTO chat_messages (conversation_id, role, content, created_at, sequence) VALUES (:conversation_id, 'user', 'Post cycle', CURRENT_TIMESTAMP, 1) RETURNING id"),
            {"conversation_id": conversation_id},
        ).scalar_one()
    for generated_id in (user_id, workspace_id, conversation_id, message_id):
        assert str(uuid.UUID(generated_id)) == generated_id
