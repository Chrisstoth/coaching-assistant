"""Writing a session with the staff, live - see services/session_workshop."""

from datetime import date as Date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.database import get_db
from backend.services import session_workshop as svc

router = APIRouter()


class StartIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    date: Optional[Date] = None
    pool_slot_id: Optional[int] = None
    squad: Optional[str] = Field(default=None, max_length=120)


class DecideIn(BaseModel):
    accept: bool


class LineIn(BaseModel):
    text: str = Field(default="", max_length=400)


def _row(db: DBSession, workshop_id: int) -> models.SessionWorkshop:
    row = db.get(models.SessionWorkshop, workshop_id)
    if not row:
        raise HTTPException(status_code=404, detail="Session workshop not found")
    return row


@router.post("", status_code=201)
def start(body: StartIn, db: DBSession = Depends(get_db)):
    from backend.routers.sessions import resolve_expected_swimmers
    expected, slot, squad = resolve_expected_swimmers(
        db, body.date.isoformat() if body.date else None, body.pool_slot_id, body.squad)
    pool_slot = ({"id": slot.id, "label": slot.label, "time": slot.time, "end_time": slot.end_time,
                  "squad": slot.squad, "course": slot.course} if slot else None)
    row = svc.start(db, brief=body.text.strip(), day=body.date, squad=squad, pool_slot_id=body.pool_slot_id,
                    expected=expected, pool_slot=pool_slot)
    return svc.out(row)


@router.get("/{workshop_id}")
def get(workshop_id: int, db: DBSession = Depends(get_db)):
    return svc.out(_row(db, workshop_id))


@router.post("/{workshop_id}/suggestions/{suggestion_id}")
def decide(workshop_id: int, suggestion_id: str, body: DecideIn, db: DBSession = Depends(get_db)):
    row = _row(db, workshop_id)
    try:
        svc.decide(db, row, suggestion_id, body.accept)
    except svc.WorkshopError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return svc.out(row)


@router.patch("/{workshop_id}/lines/{line_id}")
def edit_line(workshop_id: int, line_id: str, body: LineIn, db: DBSession = Depends(get_db)):
    row = _row(db, workshop_id)
    try:
        svc.edit_line(db, row, line_id, body.text)
    except svc.WorkshopError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return svc.out(row)


@router.post("/{workshop_id}/finish")
def finish(workshop_id: int, db: DBSession = Depends(get_db)):
    """The session in the planner's own shape, ready to save."""
    row = _row(db, workshop_id)
    if not row.draft:
        raise HTTPException(status_code=409, detail="The session has not been drafted yet")
    result = svc.finish(db, row)
    result["pool_slot"] = row.pool_slot
    return result
