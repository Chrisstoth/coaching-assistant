"""The coaching staff, callable from any page.

A page describes what just happened and what it concerns; the staff meet and
return anything worth saying. Notes are kept, so they can be pinned to the week
or swimmer they are about and answered later.
"""

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend import models
from backend.database import get_db
from backend.services.staff_actions import actions_for
from backend.services.staff_room import (
    ROLE_ORDER, ROSTER, Subject, apply_action, convene, decide, decline_action, note_out,
    reply_to_note, staff_room_enabled,
)

router = APIRouter()


class ConveneIn(BaseModel):
    topic: str = Field(..., min_length=1, max_length=6000)
    coach_text: Optional[str] = Field(default=None, max_length=4000)
    trigger: str = "coach_message"
    thread_id: Optional[int] = None
    roles: list[str] = Field(default_factory=list)
    swimmer_ids: list[int] = Field(default_factory=list)
    macro_id: Optional[int] = None
    block_id: Optional[int] = None
    week_start: Optional[date] = None
    session_id: Optional[int] = None
    meet_id: Optional[int] = None
    session_date: Optional[date] = None
    squad: Optional[str] = Field(default=None, max_length=120)
    attendee_ids: list[int] = Field(default_factory=list)


class ReplyIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)


class NoteUpdate(BaseModel):
    status: str


class DecideIn(BaseModel):
    choice: Optional[str] = None          # the role whose position the coach backs
    text: Optional[str] = Field(default=None, max_length=2000)


@router.get("/roster")
def get_roster():
    return {
        "enabled": staff_room_enabled(),
        "staff": [{"role": key, "title": ROSTER[key].title, "remit": ROSTER[key].remit,
                   "can": [spec.label for spec in actions_for(key)]} for key in ROLE_ORDER],
    }


@router.post("/convene")
def convene_staff(body: ConveneIn, db: Session = Depends(get_db)):
    subject = Subject(
        swimmer_ids=list(body.swimmer_ids), macro_id=body.macro_id, block_id=body.block_id,
        week_start=body.week_start, session_id=body.session_id, meet_id=body.meet_id,
        session_date=body.session_date, squad=body.squad, attendee_ids=list(body.attendee_ids),
    )
    notes = convene(db, topic=body.topic, subject=subject, trigger=body.trigger,
                    thread_id=body.thread_id, roles=body.roles, coach_text=body.coach_text)
    return {"notes": [note_out(n) for n in notes]}


@router.get("/notes")
def list_notes(
    thread_id: Optional[int] = None,
    macro_id: Optional[int] = None,
    swimmer_id: Optional[int] = None,
    week_start: Optional[date] = None,
    meet_id: Optional[int] = None,
    status: Optional[str] = None,
    ids: Optional[str] = None,
    limit: int = 50,
    db: Session = Depends(get_db),
):
    q = db.query(models.StaffNote)
    if ids:
        wanted = [int(part) for part in ids.split(",") if part.strip().isdigit()][:200]
        # A page following its own conversation also wants the replies to it.
        q = q.filter(models.StaffNote.id.in_(wanted) | models.StaffNote.parent_id.in_(wanted))
    if thread_id:
        q = q.filter(models.StaffNote.thread_id == thread_id)
    if macro_id:
        q = q.filter(models.StaffNote.macro_id == macro_id)
    if week_start:
        q = q.filter(models.StaffNote.week_start == week_start)
    if meet_id:
        q = q.filter(models.StaffNote.meet_id == meet_id)
    if status:
        q = q.filter(models.StaffNote.status == status)
    rows = q.order_by(models.StaffNote.id.desc()).limit(max(1, min(limit, 200)) * (3 if swimmer_id else 1)).all()
    if swimmer_id:
        # swimmer_ids is a JSON list; filter here rather than rely on JSON operators.
        rows = [n for n in rows if swimmer_id in (n.swimmer_ids or [])][:limit]
    rows.reverse()
    return [note_out(n) for n in rows]


@router.post("/notes/{note_id}/reply")
def reply(note_id: int, body: ReplyIn, db: Session = Depends(get_db)):
    note = db.query(models.StaffNote).filter(models.StaffNote.id == note_id).first()
    if not note:
        raise HTTPException(404, "Note not found")
    response = reply_to_note(db, note_id, body.text)
    db.refresh(note)
    return {"note": note_out(note), "response": note_out(response) if response else None}


@router.patch("/notes/{note_id}")
def update_note(note_id: int, body: NoteUpdate, db: Session = Depends(get_db)):
    if body.status not in ("open", "resolved", "dismissed"):
        raise HTTPException(422, "Status must be open, resolved or dismissed")
    note = db.query(models.StaffNote).filter(models.StaffNote.id == note_id).first()
    if not note:
        raise HTTPException(404, "Note not found")
    note.status = body.status
    db.commit()
    db.refresh(note)
    return note_out(note)


@router.post("/notes/{note_id}/apply")
def apply(note_id: int, db: Session = Depends(get_db)):
    """The coach approved what a specialist proposed."""
    note = db.query(models.StaffNote).filter(models.StaffNote.id == note_id).first()
    if not note:
        raise HTTPException(404, "Note not found")
    if not note.proposed_action:
        raise HTTPException(422, "Nothing was proposed on this note")
    note, follow_ups = apply_action(db, note_id)
    return {"note": note_out(note), "follow_ups": [note_out(n) for n in follow_ups]}


@router.post("/notes/{note_id}/decline")
def decline(note_id: int, db: Session = Depends(get_db)):
    note = decline_action(db, note_id)
    if not note:
        raise HTTPException(404, "Note not found")
    return note_out(note)


@router.post("/notes/{note_id}/decide")
def make_the_call(note_id: int, body: DecideIn, db: Session = Depends(get_db)):
    """The coach settles a disagreement between the staff."""
    note = db.query(models.StaffNote).filter(models.StaffNote.id == note_id).first()
    if not note or note.kind != "decision":
        raise HTTPException(404, "Decision not found")
    try:
        note, follow_ups = decide(db, note_id, body.choice, body.text)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    return {"note": note_out(note), "follow_ups": [note_out(n) for n in follow_ups]}
