from typing import Optional, Union
import base64
import difflib
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Body, UploadFile, File
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models
from backend.services import openai_service

router = APIRouter()

LEVELS = ["club", "regional", "national", "international"]


class MeetCreate(BaseModel):
    name: str
    start_date: Optional[str] = Field(default=None, alias="date")
    end_date: Optional[str] = Field(default=None, alias="date_to")
    location: Optional[str] = None
    course: Optional[str] = None       # SCM / LCM
    level: Optional[str] = None        # club / regional / national / international
    warm_up_time: Optional[str] = None # "07:30"
    notes: Optional[str] = None

    class Config:
        populate_by_name = True


class MeetTargetCreate(BaseModel):
    swimmer_id: int
    events: list[str] = []
    priority: Optional[str] = None     # A / B / C
    target_times: Optional[dict] = None  # {"100 Freestyle": "52.50"}
    notes: Optional[str] = None


class MeetTargetUpdate(BaseModel):
    events: Optional[list[str]] = None
    priority: Optional[str] = None
    target_times: Optional[dict] = None
    notes: Optional[str] = None


@router.get("")
def list_meets(db: DBSession = Depends(get_db)):
    meets = db.query(models.Meet).order_by(models.Meet.date).all()
    return [_meet_summary(m, db) for m in meets]


@router.post("", status_code=201)
def create_meet(body: MeetCreate, db: DBSession = Depends(get_db)):
    data = body.model_dump(by_alias=True)
    # Parse date strings to date objects (by_alias already mapped start_date -> date, end_date -> date_to)
    if data.get('date'):
        data['date'] = datetime.fromisoformat(data['date']).date()
    if data.get('date_to'):
        data['date_to'] = datetime.fromisoformat(data['date_to']).date()
    meet = models.Meet(**data)
    db.add(meet)
    db.commit()
    db.refresh(meet)
    return _meet_summary(meet, db)


@router.get("/{meet_id}")
def get_meet(meet_id: int, db: DBSession = Depends(get_db)):
    meet = _get_or_404(meet_id, db)
    return _meet_detail(meet, db)


@router.put("/{meet_id}")
def update_meet(meet_id: int, body: dict = Body(...), db: DBSession = Depends(get_db)):
    meet = _get_or_404(meet_id, db)
    allowed = {"name", "date", "date_to", "location", "course", "level", "warm_up_time", "notes"}
    for k, v in body.items():
        if k in allowed:
            setattr(meet, k, v)
    db.commit()
    return _meet_detail(meet, db)


@router.delete("/{meet_id}", status_code=204)
def delete_meet(meet_id: int, db: DBSession = Depends(get_db)):
    meet = _get_or_404(meet_id, db)
    db.delete(meet)
    db.commit()


# ---------------------------------------------------------------------------
# Targets (swimmer assignments)
# ---------------------------------------------------------------------------

@router.post("/{meet_id}/targets", status_code=201)
def add_target(meet_id: int, body: MeetTargetCreate, db: DBSession = Depends(get_db)):
    _get_or_404(meet_id, db)
    # Upsert — if swimmer already assigned, update instead
    existing = db.query(models.MeetTarget).filter(
        models.MeetTarget.meet_id == meet_id,
        models.MeetTarget.swimmer_id == body.swimmer_id,
    ).first()
    if existing:
        if body.events is not None:
            existing.events = body.events
        if body.priority is not None:
            existing.priority = body.priority
        if body.target_times is not None:
            existing.target_times = body.target_times
        if body.notes is not None:
            existing.notes = body.notes
        db.commit()
        db.refresh(existing)
        return _target_out(existing, db)

    target = models.MeetTarget(meet_id=meet_id, **body.model_dump())
    db.add(target)
    db.commit()
    db.refresh(target)
    return _target_out(target, db)


@router.put("/{meet_id}/targets/{target_id}")
def update_target(meet_id: int, target_id: int, body: MeetTargetUpdate, db: DBSession = Depends(get_db)):
    target = db.query(models.MeetTarget).filter(
        models.MeetTarget.id == target_id,
        models.MeetTarget.meet_id == meet_id,
    ).first()
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")
    if body.events is not None:
        target.events = body.events
    if body.priority is not None:
        target.priority = body.priority
    if body.target_times is not None:
        target.target_times = body.target_times
    if body.notes is not None:
        target.notes = body.notes
    db.commit()
    return _target_out(target, db)


@router.delete("/{meet_id}/targets/{target_id}", status_code=204)
def remove_target(meet_id: int, target_id: int, db: DBSession = Depends(get_db)):
    target = db.query(models.MeetTarget).filter(
        models.MeetTarget.id == target_id,
        models.MeetTarget.meet_id == meet_id,
    ).first()
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")
    db.delete(target)
    db.commit()


# ---------------------------------------------------------------------------
# Document extraction
# ---------------------------------------------------------------------------

@router.post("/{meet_id}/extract-schedule")
async def extract_schedule(
    meet_id: int,
    schedule_file: UploadFile = File(...),
    db: DBSession = Depends(get_db)
):
    """
    Extract events and dates from a meet schedule document.
    """
    meet = _get_or_404(meet_id, db)

    schedule_content = await schedule_file.read()
    mime_type = schedule_file.content_type or "application/pdf"

    # Build date context for the prompt
    date_context = ""
    if meet.date:
        date_context = f"The gala runs from {meet.date}"
        if meet.date_to and meet.date_to != meet.date:
            date_context += f" to {meet.date_to}"
        date_context += "."

    if mime_type.startswith("image/"):
        schedule_data = openai_service.parse_schedule_image(schedule_content, mime_type, date_context)
    else:
        schedule_data = openai_service.parse_schedule_document(schedule_content, date_context)

    return {
        "events": schedule_data.get("events", []),
        "by_date": schedule_data.get("by_date", {}),
        "meet_id": meet_id,
    }


@router.post("/{meet_id}/extract-entries")
async def extract_entries(
    meet_id: int,
    entries_file: UploadFile = File(...),
    db: DBSession = Depends(get_db)
):
    """
    Extract swimmer names and their registered events from an entries document.
    """
    meet = _get_or_404(meet_id, db)

    # Get all squad swimmers for cross-referencing
    swimmers = db.query(models.Swimmer).filter(models.Swimmer.status == 'active').all()
    swimmer_names = {s.name.lower(): s for s in swimmers}

    entries_content = await entries_file.read()
    mime_type = entries_file.content_type or "text/plain"

    if mime_type.startswith("image/"):
        entries_data = openai_service.parse_entries_image(entries_content, mime_type)
    else:
        text_content = entries_content.decode('utf-8', errors='ignore')
        entries_data = openai_service.parse_entries_text(text_content)

    # Cross-reference swimmers with fuzzy matching
    extracted_swimmers = {}
    unmatched = []

    for swimmer_entry in entries_data.get("swimmers", []):
        name = swimmer_entry.get("name", "").strip()
        events = swimmer_entry.get("events", [])

        if not name:
            continue

        name_lower = name.lower()
        best_match = None
        best_score = 0.6

        for squad_name, swimmer in swimmer_names.items():
            score = difflib.SequenceMatcher(None, name_lower, squad_name).ratio()
            if score > best_score:
                best_score = score
                best_match = swimmer.name

        if best_match:
            if best_match not in extracted_swimmers:
                extracted_swimmers[best_match] = []
            extracted_swimmers[best_match].extend(events)
        else:
            unmatched.append({"name": name, "events": events, "match_score": best_score})

    return {
        "swimmers": extracted_swimmers,
        "unmatched": unmatched,
        "meet_id": meet_id,
    }


@router.post("/{meet_id}/combine-extractions")
async def combine_extractions(
    meet_id: int,
    body: dict = Body(...),
    db: DBSession = Depends(get_db)
):
    """
    Combine schedule and entries extractions and optionally auto-assign swimmers.
    Expects: {
        "events": [...],
        "swimmers": {"name": [...events]},
        "auto_assign": bool
    }
    """
    meet = _get_or_404(meet_id, db)

    events = body.get("events", [])
    swimmers_to_assign = body.get("swimmers", {})
    auto_assign = body.get("auto_assign", False)

    result = {
        "events": events,
        "swimmers": swimmers_to_assign,
        "assigned": []
    }

    if auto_assign:
        swimmers = db.query(models.Swimmer).all()
        swimmer_map = {s.name: s for s in swimmers}

        for swimmer_name, events_list in swimmers_to_assign.items():
            if swimmer_name in swimmer_map:
                try:
                    # Create or update meet target
                    existing = db.query(models.MeetTarget).filter(
                        models.MeetTarget.meet_id == meet_id,
                        models.MeetTarget.swimmer_id == swimmer_map[swimmer_name].id,
                    ).first()

                    if existing:
                        existing.events = list(set(existing.events or []) | set(events_list))
                    else:
                        target = models.MeetTarget(
                            meet_id=meet_id,
                            swimmer_id=swimmer_map[swimmer_name].id,
                            events=events_list,
                            priority="B"
                        )
                        db.add(target)

                    result["assigned"].append(swimmer_name)
                except Exception as e:
                    pass

        db.commit()

    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_or_404(meet_id: int, db: DBSession) -> models.Meet:
    meet = db.query(models.Meet).filter(models.Meet.id == meet_id).first()
    if not meet:
        raise HTTPException(status_code=404, detail="Meet not found")
    return meet


def _meet_summary(m: models.Meet, db: DBSession) -> dict:
    count = db.query(models.MeetTarget).filter(models.MeetTarget.meet_id == m.id).count()
    return {
        "id": m.id,
        "name": m.name,
        "date": m.date,
        "date_to": m.date_to,
        "location": m.location,
        "course": m.course,
        "level": m.level,
        "swimmer_count": count,
    }


def _meet_detail(m: models.Meet, db: DBSession) -> dict:
    targets = db.query(models.MeetTarget).filter(models.MeetTarget.meet_id == m.id).all()
    return {
        **_meet_summary(m, db),
        "warm_up_time": m.warm_up_time,
        "notes": m.notes,
        "targets": [_target_out(t, db) for t in targets],
    }


def _target_out(t: models.MeetTarget, db: DBSession) -> dict:
    swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == t.swimmer_id).first()
    return {
        "id": t.id,
        "swimmer_id": t.swimmer_id,
        "swimmer_name": swimmer.name if swimmer else None,
        "squad": swimmer.squad if swimmer else None,
        "events": t.events or [],
        "priority": t.priority,
        "target_times": t.target_times or {},
        "notes": t.notes,
    }
