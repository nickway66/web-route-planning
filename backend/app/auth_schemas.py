from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class AuthModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)


class EmailRequest(AuthModel):
    email: EmailStr

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: object) -> object:
        return value.strip().lower() if isinstance(value, str) else value


class RegisterRequest(EmailRequest):
    password: str = Field(min_length=12, max_length=128)


class LoginRequest(EmailRequest):
    password: str = Field(min_length=12, max_length=128)


class UserResponse(AuthModel):
    id: str
    email: EmailStr
    display_name: str = Field(serialization_alias="displayName")
    is_active: bool = Field(serialization_alias="isActive")
    created_at: datetime = Field(serialization_alias="createdAt")


class TokenResponse(AuthModel):
    access_token: str = Field(serialization_alias="accessToken")
    token_type: str = Field(default="bearer", serialization_alias="tokenType")
    user: UserResponse
