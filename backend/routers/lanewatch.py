"""Connecting LaneWatch, and pairing its swimmers with the squad here.

The browser signs the coach in to LaneWatch and hands this server the
resulting sign-in token once; the server swaps it for LaneWatch's read-only
key and keeps only that (encrypted). See services/lanewatch.py.
"""

import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend import models
from backend.database import get_db
from backend.services import lanewatch
from backend.services.lanewatch import LaneWatchError

router = APIRouter()

# LaneWatch's public web sign-in settings. These identify the LaneWatch
# project to Firebase and are published in every LaneWatch web page; they are
# not secrets. Overridable so a staging LaneWatch can be used instead.
FIREBASE_WEB_CONFIG = {
    "apiKey": os.getenv("LANEWATCH_FIREBASE_API_KEY", "AIzaSyD15J2g_4FZpTsY8l2EpCTjTfHT78zjOJ0"),
    "authDomain": os.getenv("LANEWATCH_FIREBASE_AUTH_DOMAIN", "swim-tracker-tool.firebaseapp.com"),
    "projectId": os.getenv("LANEWATCH_FIREBASE_PROJECT_ID", "swim-tracker-tool"),
    "appId": os.getenv("LANEWATCH_FIREBASE_APP_ID", "1:1003052817682:web:955daffdb90da8c6b4e7cb"),
}


class ConnectIn(BaseModel):
    id_token: str = Field(..., min_length=20, max_length=8000)


class LinkIn(BaseModel):
    swimmer_id: int
    lanewatch_swimmer_id: str = Field(..., max_length=64)


class LinksIn(BaseModel):
    links: list[LinkIn] = Field(..., max_length=200)


def _fail(exc: LaneWatchError):
    # 401 from LaneWatch means the coach's LaneWatch sign-in or our key; it
    # must not look like this app's own login expired.
    code = 502 if exc.status is None else (409 if exc.status == 401 else min(exc.status, 499))
    raise HTTPException(code, str(exc))


@router.get("/status")
def get_status(db: Session = Depends(get_db)):
    return {**lanewatch.status(db), "sign_in": FIREBASE_WEB_CONFIG}


@router.post("/connect")
def connect(body: ConnectIn, db: Session = Depends(get_db)):
    try:
        lanewatch.connect(db, body.id_token)
    except LaneWatchError as exc:
        _fail(exc)
    return lanewatch.status(db)


@router.post("/disconnect")
def disconnect(db: Session = Depends(get_db)):
    return lanewatch.disconnect(db)


@router.get("/links")
def get_links(db: Session = Depends(get_db)):
    try:
        return lanewatch.suggest_links(db)
    except LaneWatchError as exc:
        _fail(exc)


@router.post("/links")
def save_links(body: LinksIn, db: Session = Depends(get_db)):
    try:
        saved = lanewatch.save_links(db, [link.model_dump() for link in body.links])
    except LaneWatchError as exc:
        _fail(exc)
    return {"saved": saved}


@router.delete("/links/{swimmer_id}")
def unlink(swimmer_id: int, db: Session = Depends(get_db)):
    if not lanewatch.unlink(db, swimmer_id):
        raise HTTPException(404, "That swimmer is not linked to LaneWatch.")
    return {"unlinked": True}


@router.get("/swimmers/{swimmer_id}/races")
def swimmer_races(swimmer_id: int, db: Session = Depends(get_db)):
    """The analyst's view of one swimmer's LaneWatch races, as plain text."""
    swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
    if not swimmer:
        raise HTTPException(404, "Swimmer not found")
    text: Optional[str] = lanewatch.analyst_lines(db, swimmer)
    return {"linked": bool(text), "summary": text or None}
