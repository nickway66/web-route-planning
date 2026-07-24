"""Add SQLite UUID defaults to existing primary-key columns."""

from alembic import op
import sqlalchemy as sa


revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


UUID_SERVER_DEFAULT = sa.text(
    "(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) "
    "|| '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))))"
)


def _set_uuid_default(table_name: str, default) -> None:
    with op.batch_alter_table(table_name, recreate="always") as batch_op:
        batch_op.alter_column(
            "id",
            existing_type=sa.String(length=36),
            existing_nullable=False,
            server_default=default,
        )


def upgrade() -> None:
    for table_name in ("users", "workspaces", "conversations", "chat_messages"):
        _set_uuid_default(table_name, UUID_SERVER_DEFAULT)


def downgrade() -> None:
    for table_name in ("chat_messages", "conversations", "workspaces", "users"):
        _set_uuid_default(table_name, None)
