from datetime import datetime, timedelta, timezone

import jwt
from fastapi import HTTPException, status
from pwdlib import PasswordHash

from .config import settings


ALGORITHM = "HS256"
password_hash = PasswordHash.recommended()


def _jwt_secret() -> str:
    if not settings.jwt_secret:
        raise HTTPException(status_code=500, detail="JWT_SECRET must be configured for authentication")
    return settings.jwt_secret


def hash_password(password: str) -> str:
    return password_hash.hash(password)


def verify_password(password: str, hashed_password: str) -> bool:
    return password_hash.verify(password, hashed_password)


def create_access_token(user_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_expire_minutes),
    }
    return jwt.encode(payload, _jwt_secret(), algorithm=ALGORITHM)


def decode_access_token(token: str) -> str:
    try:
        payload = jwt.decode(token, _jwt_secret(), algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        if not isinstance(user_id, str) or not user_id:
            raise jwt.InvalidTokenError("Missing subject")
        return user_id
    except HTTPException:
        raise
    except jwt.PyJWTError as error:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Could not validate credentials") from error
