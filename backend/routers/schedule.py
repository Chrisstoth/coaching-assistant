from datetime import date
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models
from backend.services.availability import availability_on_date, normalise_reason

router = APIRouter()

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


# ---------------------------------------------------------------------------
# Pool slots (master timetable)
# ---------------------------------------------------------------------------

class PoolSlotCreate(BaseModel):
    day_of_week: int
    time: str                 # "06:00"
    end_time: Optional[str] = None  # "07:30"
    squad: Optional[str] = None
    label: Optional[str] = None
    course: Optional[str] = None  # SCM / LCM
    lanes: Optional[int] = None
    has_blocks: bool = False
    pool_config: Optional[str] = None  # full_pool / deep_end / shallow_end
    alternate_ends: bool = False


@router.get("/slots")
def list_slots(db: DBSession = Depends(get_db)):
    slots = (
        db.query(models.PoolSlot)
        .filter(models.PoolSlot.active == True)
        .order_by(models.PoolSlot.day_of_week, models.PoolSlot.time)
        .all()
    )
    return [_slot_out(s) for s in slots]


@router.post("/slots", status_code=201)
def create_slot(body: PoolSlotCreate, db: DBSession = Depends(get_db)):
    time_range = f"{body.time}–{body.end_time}" if body.end_time else body.time
    slot = models.PoolSlot(
        day_of_week=body.day_of_week,
        time=body.time,
        end_time=body.end_time,
        squad=body.squad,
        label=body.label or f"{DAYS[body.day_of_week]} {time_range}{' ' + body.squad if body.squad else ''}",
        course=body.course,
        lanes=body.lanes,
        has_blocks=body.has_blocks,
        pool_config=body.pool_config,
        alternate_ends=body.alternate_ends,
    )
    db.add(slot)
    db.commit()
    db.refresh(slot)
    return _slot_out(slot)


@router.patch("/slots/{slot_id}")
def update_slot(slot_id: int, body: PoolSlotCreate, db: DBSession = Depends(get_db)):
    slot = db.query(models.PoolSlot).filter(models.PoolSlot.id == slot_id).first()
    if not slot:
        raise HTTPException(status_code=404, detail="Slot not found")
    time_range = f"{body.time}–{body.end_time}" if body.end_time else body.time
    slot.day_of_week = body.day_of_week
    slot.time = body.time
    slot.end_time = body.end_time
    slot.squad = body.squad
    slot.label = body.label or f"{DAYS[body.day_of_week]} {time_range}{' ' + body.squad if body.squad else ''}"
    slot.course = body.course
    slot.lanes = body.lanes
    slot.has_blocks = body.has_blocks
    slot.pool_config = body.pool_config
    slot.alternate_ends = body.alternate_ends
    db.commit()
    db.refresh(slot)
    return _slot_out(slot)


@router.delete("/slots/{slot_id}", status_code=204)
def delete_slot(slot_id: int, db: DBSession = Depends(get_db)):
    slot = db.query(models.PoolSlot).filter(models.PoolSlot.id == slot_id).first()
    if not slot:
        raise HTTPException(status_code=404, detail="Slot not found")
    slot.active = False
    db.commit()


@router.get("/slots/{slot_id}/swimmers")
def slot_swimmers(slot_id: int, db: DBSession = Depends(get_db)):
    """All swimmers expected at this slot."""
    links = (
        db.query(models.SwimmerSlot)
        .filter(models.SwimmerSlot.pool_slot_id == slot_id)
        .all()
    )
    swimmer_ids = [l.swimmer_id for l in links]
    swimmers = db.query(models.Swimmer).filter(models.Swimmer.id.in_(swimmer_ids)).all()
    return [{"id": s.id, "name": s.name, "squad": s.squad} for s in swimmers]


# ---------------------------------------------------------------------------
# Swimmer attendance pattern (expected)
# ---------------------------------------------------------------------------

@router.get("/swimmers/{swimmer_id}")
def get_swimmer_slots(swimmer_id: int, db: DBSession = Depends(get_db)):
    """Which slots does this swimmer normally attend?"""
    links = (
        db.query(models.SwimmerSlot)
        .filter(models.SwimmerSlot.swimmer_id == swimmer_id)
        .all()
    )
    slot_ids = {l.pool_slot_id for l in links}
    all_slots = (
        db.query(models.PoolSlot)
        .filter(models.PoolSlot.active == True)
        .order_by(models.PoolSlot.day_of_week, models.PoolSlot.time)
        .all()
    )
    return [
        {**_slot_out(s), "attending": s.id in slot_ids}
        for s in all_slots
    ]


@router.put("/swimmers/{swimmer_id}")
def set_swimmer_slots(
    swimmer_id: int,
    slot_ids: list[int],
    db: DBSession = Depends(get_db),
):
    """Replace a swimmer's full attendance pattern with the given slot IDs."""
    swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
    if not swimmer:
        raise HTTPException(status_code=404, detail="Swimmer not found")

    db.query(models.SwimmerSlot).filter(models.SwimmerSlot.swimmer_id == swimmer_id).delete()

    for slot_id in slot_ids:
        db.add(models.SwimmerSlot(swimmer_id=swimmer_id, pool_slot_id=slot_id))

    db.commit()
    return {"attending": slot_ids}


# ---------------------------------------------------------------------------
# Exceptions (holiday, exams, etc.)
# ---------------------------------------------------------------------------

class ExceptionCreate(BaseModel):
    reason: str               # holiday / exams / work / injury / other
    date_from: date
    date_to: date
    notes: Optional[str] = None


@router.get("/swimmers/{swimmer_id}/exceptions")
def get_exceptions(swimmer_id: int, db: DBSession = Depends(get_db)):
    excs = (
        db.query(models.SwimmerException)
        .filter(models.SwimmerException.swimmer_id == swimmer_id)
        .order_by(models.SwimmerException.date_from)
        .all()
    )
    return [_exc_out(e) for e in excs]


@router.post("/swimmers/{swimmer_id}/exceptions", status_code=201)
def add_exception(swimmer_id: int, body: ExceptionCreate, db: DBSession = Depends(get_db)):
    swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
    if not swimmer:
        raise HTTPException(status_code=404, detail="Swimmer not found")
    if body.date_to < body.date_from:
        raise HTTPException(status_code=422, detail="Availability end date must be on or after its start date")
    payload = body.model_dump()
    payload["reason"] = normalise_reason(payload["reason"])
    exc = models.SwimmerException(swimmer_id=swimmer_id, **payload)
    db.add(exc)
    if payload["reason"] == "competition":
        existing_load = db.query(models.SwimmerLoadEvent).filter(
            models.SwimmerLoadEvent.swimmer_id == swimmer_id,
            models.SwimmerLoadEvent.event_type == "competition",
            models.SwimmerLoadEvent.date_from == body.date_from,
            models.SwimmerLoadEvent.date_to == body.date_to,
        ).first()
        if not existing_load:
            db.add(models.SwimmerLoadEvent(
                swimmer_id=swimmer_id,
                event_type="competition",
                date_from=body.date_from,
                date_to=body.date_to,
                severity=2,
                description=body.notes or "Competition",
                resolved=body.date_to <= date.today(),
            ))
    db.commit()
    db.refresh(exc)
    return _exc_out(exc)


@router.delete("/swimmers/{swimmer_id}/exceptions/{exc_id}", status_code=204)
def delete_exception(swimmer_id: int, exc_id: int, db: DBSession = Depends(get_db)):
    exc = db.query(models.SwimmerException).filter(
        models.SwimmerException.id == exc_id,
        models.SwimmerException.swimmer_id == swimmer_id,
    ).first()
    if not exc:
        raise HTTPException(status_code=404, detail="Exception not found")
    db.delete(exc)
    db.commit()


# ---------------------------------------------------------------------------
# Expected attendance for a specific date (used by register)
# ---------------------------------------------------------------------------

@router.get("/expected/{session_date}")
def expected_attendance(session_date: date, squad: Optional[str] = None, db: DBSession = Depends(get_db)):
    """
    Given a date, return which swimmers are expected based on:
    - Their slot attendance pattern matches that day of week
    - They have no active exception covering that date
    """
    dow = session_date.weekday()  # 0=Mon

    # Find matching slots for this day
    slot_q = db.query(models.PoolSlot).filter(
        models.PoolSlot.day_of_week == dow,
        models.PoolSlot.active == True,
    )
    if squad:
        slot_q = slot_q.filter(
            (models.PoolSlot.squad == squad) | (models.PoolSlot.squad == None)
        )
    slots = slot_q.all()
    slot_ids = [s.id for s in slots]

    if not slot_ids:
        return []

    # Swimmers linked to those slots
    links = db.query(models.SwimmerSlot).filter(
        models.SwimmerSlot.pool_slot_id.in_(slot_ids)
    ).all()
    swimmer_ids = list({l.swimmer_id for l in links})

    availability = availability_on_date(db, swimmer_ids, session_date)
    excluded = set(availability)

    swimmers = db.query(models.Swimmer).filter(
        models.Swimmer.id.in_(swimmer_ids),
        models.Swimmer.active == True,
    ).order_by(models.Swimmer.name).all()

    return [
        {
            "id": s.id,
            "name": s.name,
            "squad": s.squad,
            "expected": s.id not in excluded,
            "exception_reason": availability.get(s.id, {}).get("reason"),
            "availability": _availability_out(availability.get(s.id)),
        }
        for s in swimmers
    ]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _slot_out(s: models.PoolSlot) -> dict:
    return {
        "id": s.id,
        "day_of_week": s.day_of_week,
        "day_name": DAYS[s.day_of_week],
        "time": s.time,
        "end_time": s.end_time,
        "squad": s.squad,
        "label": s.label,
        "course": s.course,
        "lanes": s.lanes,
        "has_blocks": s.has_blocks,
        "pool_config": s.pool_config,
        "alternate_ends": s.alternate_ends,
    }


def _exc_out(e: models.SwimmerException) -> dict:
    return {
        "id": e.id,
        "reason": e.reason,
        "date_from": e.date_from,
        "date_to": e.date_to,
        "notes": e.notes,
    }


def _availability_out(item: Optional[dict]) -> Optional[dict]:
    if not item:
        return None
    return {
        **item,
        "date_from": item["date_from"].isoformat(),
        "date_to": item["date_to"].isoformat(),
    }
