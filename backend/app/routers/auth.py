from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from backend.app.auth_schemas import LoginRequest, RegisterRequest, TokenResponse, UserResponse
from backend.app.database import get_db
from backend.app.dependencies.auth import get_current_user
from backend.app.models import User
from backend.app.repositories.users import DuplicateEmailError, create_user, get_user_by_email
from backend.app.security import create_access_token, hash_password, verify_password


router = APIRouter()
DbSession = Annotated[Session, Depends(get_db)]


def user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        is_active=user.is_active,
        created_at=user.created_at,
    )


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, db: DbSession) -> UserResponse:
    if get_user_by_email(db, str(payload.email)) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")
    try:
        user = create_user(
            db,
            email=str(payload.email),
            password_hash=hash_password(payload.password),
            display_name=str(payload.email).split("@", 1)[0],
        )
    except DuplicateEmailError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered") from error
    return user_response(user)


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: DbSession) -> TokenResponse:
    user = get_user_by_email(db, str(payload.email))
    if user is None or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="邮箱或密码错误")
    return TokenResponse(access_token=create_access_token(user.id), user=user_response(user))


@router.get("/me", response_model=UserResponse)
def me(current_user: Annotated[User, Depends(get_current_user)]) -> UserResponse:
    return user_response(current_user)
