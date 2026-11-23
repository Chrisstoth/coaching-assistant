"""Connecting LaneWatch, and pairing its swimmers with the squad here.

"Connect with LaneWatch": the coach approves on hub.lanewatch.app and comes
back with a one-time code, which this server swaps for LaneWatch's read-only
key and keeps only that (encrypted). See services/lanewatch.py.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend import models
from backend.database import get_db
from backend.services import lanewatch
from backend.services.lanewatch import LaneWatchError

router = APIRouter()


class ConnectStartIn(BaseModel):
    # Where LaneWatch sends the coach back: this app's /lanewatch/callback.
    redirect_uri: str = Field(..., max_length=300)


class ConnectFinishIn(BaseModel):
    state: str = Field(..., min_length=8, max_length=200)
    code: Optional[str] = Field(default=None, max_length=200)
    error: Optional[str] = Field(default=None, max_length=100)


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
    return lanewatch.status(db)


@router.post("/connect/start")
def start_connect(body: ConnectStartIn, db: Session = Depends(get_db)):
    """The address on hub.lanewatch.app to send the coach to."""
    try:
        return {"url": lanewatch.start_connect(db, body.redirect_uri)}
    except LaneWatchError as exc:
        _fail(exc)


# The page LaneWatch sends the coach back to may open outside this app's
# signed-in view (a phone's home-screen app often comes back in a separate
# browser view), so finishing is not behind this app's login. It is still
# safe: it only completes an attempt this server started minutes ago, once,
# and the code is useless without the PKCE verifier only this server holds.
public_router = APIRouter()


@public_router.post("/finish")
def finish_connect(body: ConnectFinishIn, db: Session = Depends(get_db)):
    if body.error:
        message = ("Connecting was cancelled in LaneWatch." if body.error == "access_denied"
                   else "LaneWatch didn't connect. Start connecting again.")
        raise HTTPException(400, message)
    try:
        lanewatch.finish_connect(db, body.state, body.code or "")
    except LaneWatchError as exc:
        _fail(exc)
    status = lanewatch.status(db)
    return {"connected": status["connected"], "connected_as": status.get("connected_as")}


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
