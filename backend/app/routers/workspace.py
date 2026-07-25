from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.dependencies.auth import get_current_user
from backend.app.models import User, Workspace
from backend.app.repositories.workspaces import (
    WorkspaceAlreadyExistsError,
    create_from_import_if_empty,
    get_by_user_id,
    upsert_for_user,
)
from backend.app.workspace_schemas import WorkspaceResponse, WorkspaceWrite


router = APIRouter()
DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


def response_for(workspace: Workspace | None) -> WorkspaceResponse:
    if workspace is None:
        return WorkspaceResponse(id=None, name="我的路线", data_version=1, layers=[], updated_at=None)
    return WorkspaceResponse(
        id=workspace.id,
        name=workspace.name,
        data_version=workspace.data_version,
        layers=workspace.layers_data,
        updated_at=workspace.updated_at,
    )


@router.get("", response_model=WorkspaceResponse)
def get_workspace(current_user: CurrentUser, db: DbSession) -> WorkspaceResponse:
    return response_for(get_by_user_id(db, current_user.id))


@router.put("", response_model=WorkspaceResponse)
def save_workspace(payload: WorkspaceWrite, current_user: CurrentUser, db: DbSession) -> WorkspaceResponse:
    workspace = upsert_for_user(db, user_id=current_user.id, data_version=payload.data_version, layers=payload.layers)
    return response_for(workspace)


@router.post("/import-local", response_model=WorkspaceResponse, status_code=status.HTTP_201_CREATED)
def import_local_workspace(payload: WorkspaceWrite, current_user: CurrentUser, db: DbSession) -> WorkspaceResponse:
    try:
        workspace = create_from_import_if_empty(
            db, user_id=current_user.id, data_version=payload.data_version, layers=payload.layers
        )
    except WorkspaceAlreadyExistsError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Workspace already contains routes") from error
    return response_for(workspace)
