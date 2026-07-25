from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.app.models import User


class DuplicateEmailError(Exception):
    """Raised when a concurrent registration claims the same email address."""


def get_user_by_email(db: Session, email: str) -> User | None:
    return db.scalar(select(User).where(User.email == email))


def get_user_by_id(db: Session, user_id: str) -> User | None:
    return db.get(User, user_id)


def create_user(db: Session, *, email: str, password_hash: str, display_name: str) -> User:
    user = User(email=email, password_hash=password_hash, display_name=display_name)
    db.add(user)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        if "unique constraint failed: users.email" in str(error.orig).lower():
            raise DuplicateEmailError from error
        raise
    db.refresh(user)
    return user
