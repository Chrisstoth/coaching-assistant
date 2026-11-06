"""Writing sessions in the Session Builder (see backend/services/session_builder.py)."""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend import models
from backend.database import get_db
from backend.services import session_builder as B
from backend.services import session_notation as N
from backend.services.cycle_codes import link_session
from sqlalchemy.orm import Session as DBSession

router = APIRouter()


class NewSession(BaseModel):
    date: date
    pool_slot_id: Optional[int] = None
    squad: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    audience: Optional[dict] = None


class SaveSession(BaseModel):
    session: dict
    audience: Optional[dict] = None


class ScaleSettings(BaseModel):
    effort_scale: Optional[str] = None
    custom_scales: Optional[list[dict]] = None
    hidden_scales: Optional[list[str]] = None


class Audience(BaseModel):
    kind: str = "squad"            # squad / group / camp / swimmer
    label: Optional[str] = None
    training_group_ids: list[int] = []
    swimmer_ids: list[int] = []


class ParseText(BaseModel):
    text: str
    speech: bool = False


def _get(db: DBSession, session_id: int) -> models.Session:
    s = db.query(models.Session).filter(models.Session.id == session_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    return s


def _settings_out(db: DBSession) -> dict:
    sc = B.load_scales(db)
    return {"effort_scale": B.usual_scale(db), "scales": B.scale_choices(db),
            "standard": [{"key": k, **N.EFF_SYSTEMS[k], "hidden": k in sc["hidden"]} for k in N.STANDARD],
            "custom": sc["custom"]}


@router.get("/settings")
def get_settings(db: DBSession = Depends(get_db)):
    return _settings_out(db)


@router.put("/settings")
def put_settings(body: ScaleSettings, db: DBSession = Depends(get_db)):
    """The usual scale, the club's own scales (the whole list), and which standard ones to hide."""
    try:
        if body.custom_scales is not None or body.hidden_scales is not None:
            B.save_scales(db, body.custom_scales, body.hidden_scales)
        if body.effort_scale:
            B.set_usual_scale(db, body.effort_scale)
    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(e))
    return _settings_out(db)


@router.post("/sessions", status_code=201)
def new_session(body: NewSession, db: DBSession = Depends(get_db)):
    """A new session for a date (and pool slot), started from the season plan's groups.

    If the slot already has a session on that date, that one is opened instead, so
    a planned session is never duplicated by accident."""
    slot = db.query(models.PoolSlot).filter(models.PoolSlot.id == body.pool_slot_id).first() if body.pool_slot_id else None
    if slot:
        existing = db.query(models.Session).filter(models.Session.date == body.date,
                                                   models.Session.pool_slot_id == slot.id).first()
        if existing and existing.status != "cancelled":
            return B.payload(db, existing)
    s = models.Session(
        date=body.date, pool_slot_id=slot.id if slot else None,
        squad=body.squad or (slot.squad if slot else None),
        start_time=body.start_time or (slot.time if slot else None),
        end_time=body.end_time or (slot.end_time if slot else None),
        course=slot.course if slot else None, status="active", source="builder", audience=body.audience,
    )
    db.add(s)
    db.flush()
    link_session(s, db)
    B.apply_builder(db, s, B.blank_builder(db, s))
    return B.payload(db, s)


@router.get("/sessions/{session_id}")
def get_session(session_id: int, db: DBSession = Depends(get_db)):
    return B.payload(db, _get(db, session_id))


@router.put("/sessions/{session_id}")
def save_session(session_id: int, body: SaveSession, db: DBSession = Depends(get_db)):
    s = _get(db, session_id)
    if s.status == "cancelled":
        raise HTTPException(status_code=409, detail="A cancelled session can't be edited.")
    if body.audience is not None:
        s.audience = body.audience
    result = B.apply_builder(db, s, body.session)
    return {"id": s.id, **result}


@router.put("/sessions/{session_id}/audience")
def set_audience(session_id: int, body: Audience, db: DBSession = Depends(get_db)):
    """Who the session was for: the whole squad, a group, a camp or one swimmer."""
    if body.kind not in ("squad", "group", "camp", "swimmer"):
        raise HTTPException(status_code=422, detail="Choose squad, group, camp or swimmer")
    s = _get(db, session_id)
    s.audience = None if body.kind == "squad" and not body.label else body.model_dump()
    db.commit()
    return {"audience": s.audience}


@router.post("/sessions/{session_id}/copy-next-week", status_code=201)
def copy_next_week(session_id: int, db: DBSession = Depends(get_db)):
    new = B.copy_to_next_week(db, _get(db, session_id))
    return B.payload(db, new)


@router.get("/plan-groups")
def get_plan_groups(on: date, squad: Optional[str] = None, db: DBSession = Depends(get_db)):
    """The season plan's training groups on a date, to add to a session."""
    return B.plan_groups(db, on, squad)


@router.post("/parse")
def parse(body: ParseText):
    """Read typed or spoken sets the way the builder does (for imports and the staff)."""
    text = N.normalize_dictation(body.text, body.speech) if "\n" not in body.text else body.text
    nodes = N.parse_text(text)
    return {"text": text, "items": nodes, "stats": N.stats_of(nodes), "zones": N.item_zones(nodes)}


# ---------------------------------------------------------------- the staff in the builder

class ReviewIn(BaseModel):
    session: dict


class CommentDecision(BaseModel):
    action: str                     # accept / dismiss / useful
    reason: Optional[str] = None
    useful: Optional[bool] = None


class DraftIn(BaseModel):
    session: dict
    brief: str


@router.post("/sessions/{session_id}/review")
def review(session_id: int, body: ReviewIn, db: DBSession = Depends(get_db)):
    """The staff read the session as it stands and pin comments to lines."""
    from backend.services import builder_staff
    s = _get(db, session_id)
    B.apply_builder(db, s, body.session)
    return {"comments": builder_staff.review(db, s, s.builder)}


@router.get("/sessions/{session_id}/comments")
def comments(session_id: int, db: DBSession = Depends(get_db)):
    from backend.services import builder_staff
    return {"comments": builder_staff.comments_out(db, _get(db, session_id))}


@router.post("/comments/{note_id}")
def decide_comment(note_id: int, body: CommentDecision, db: DBSession = Depends(get_db)):
    from backend.services import builder_staff, workbooks
    try:
        return builder_staff.decide(db, note_id, body.action, body.reason, body.useful)
    except workbooks.WorkbookError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/sessions/{session_id}/draft")
def draft(session_id: int, body: DraftIn, db: DBSession = Depends(get_db)):
    """Jess drafts the session from the coach's brief, in the notation. Nothing is saved until the coach keeps it."""
    from backend.services import builder_staff
    if not body.brief.strip():
        raise HTTPException(status_code=422, detail="Tell Jess what the session is for.")
    return builder_staff.draft(db, _get(db, session_id), body.session, body.brief)
