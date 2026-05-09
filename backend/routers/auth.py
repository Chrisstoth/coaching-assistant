from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import os, time
import jwt

router = APIRouter()

SECRET = os.getenv("SECRET_KEY", "dev-secret-please-change")
APP_PASSWORD = os.getenv("APP_PASSWORD", "")
TOKEN_TTL = 86400 * 60  # 60 days


class LoginRequest(BaseModel):
    password: str


@router.post("/login")
def login(req: LoginRequest):
    if not APP_PASSWORD:
        raise HTTPException(500, "APP_PASSWORD not set on server")
    if req.password != APP_PASSWORD:
        raise HTTPException(401, "Incorrect password")
    token = jwt.encode(
        {"iat": int(time.time()), "exp": int(time.time()) + TOKEN_TTL},
        SECRET,
        algorithm="HS256",
    )
    return {"token": token}
