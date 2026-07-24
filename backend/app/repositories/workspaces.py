from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.app.models import Workspace


class WorkspaceAlreadyExistsError(Exception):
    pass


def get_by_user_id(db: Session, user_id: str) -> Workspace | None:
    return db.scalar(select(Workspace).where(Workspace.user_id == user_id))


def _counts(layers: list[dict[str, Any]]) -> tuple[int, int, int]:
    route_count = sum(len(layer["routes"]) for layer in layers)
    point_count = sum(len(route["points"]) for layer in layers for route in layer["routes"])
    return len(layers), route_count, point_count


def upsert_for_user(db: Session, *, user_id: str, data_version: int, layers: list[dict[str, Any]]) -> Workspace:
    workspace = get_by_user_id(db, user_id)
    layer_count, route_count, point_count = _counts(layers)
    if workspace is None:
        workspace = Workspace(user_id=user_id, name="我的路线")
        db.add(workspace)
    workspace.data_version = data_version
    workspace.layers_data = layers
    workspace.layer_count = layer_count
    workspace.route_count = route_count
    workspace.point_count = point_count
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        # A concurrent initial write may have won; update that user's row atomically on retry.
        workspace = get_by_user_id(db, user_id)
        if workspace is None:
            raise
        workspace.data_version = data_version
        workspace.layers_data = layers
        workspace.layer_count = layer_count
        workspace.route_count = route_count
        workspace.point_count = point_count
        db.commit()
    db.refresh(workspace)
    return workspace


def create_from_import_if_empty(db: Session, *, user_id: str, data_version: int, layers: list[dict[str, Any]]) -> Workspace:
    workspace = get_by_user_id(db, user_id)
    if workspace is not None and workspace.layers_data:
        raise WorkspaceAlreadyExistsError
    if workspace is not None:
        return upsert_for_user(db, user_id=user_id, data_version=data_version, layers=layers)
    layer_count, route_count, point_count = _counts(layers)
    workspace = Workspace(
        user_id=user_id,
        name="我的路线",
        data_version=data_version,
        layers_data=layers,
        layer_count=layer_count,
        route_count=route_count,
        point_count=point_count,
    )
    db.add(workspace)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise WorkspaceAlreadyExistsError from error
    db.refresh(workspace)
    return workspace
