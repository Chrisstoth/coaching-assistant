"""A swimmer's goals, edited from the swimmer's page. The same list the Season
Planner shows and the athlete plan prints (backend/services/goals.py)."""

from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend import models
from backend.database import get_db
from backend.services import goals as goal_svc

router = APIRouter()


class GoalIn(BaseModel):
    swimmer_id: int
    text: str = Field(default="", max_length=300)
    description: Optional[str] = Field(default=None, max_length=1200)
    event: Optional[str] = Field(default=None, max_length=40)
    target_time_seconds: Optional[float] = Field(default=None, gt=0)
    course: Optional[str] = None
    meet_id: Optional[int] = None
    deadline: Optional[date] = None
    achieved: bool = False


class GoalUpdate(BaseModel):
    text: Optional[str] = Field(default=None, max_length=300)
    description: Optional[str] = Field(default=None, max_length=1200)
    event: Optional[str] = Field(default=None, max_length=40)
    target_time_seconds: Optional[float] = Field(default=None, gt=0)
    course: Optional[str] = None
    meet_id: Optional[int] = None
    deadline: Optional[date] = None
    achieved: Optional[bool] = None


def _changes(body: BaseModel, partial: bool) -> dict:
    data = body.model_dump(exclude_unset=partial, exclude={"swimmer_id"})
    if "text" in data:
        data["label"] = (data.pop("text") or "").strip()
    if "event" in data:
        data["event"] = (data["event"] or "").strip() or None
    return data


def _swimmer(db: Session, swimmer_id: int) -> models.Swimmer:
    s = db.get(models.Swimmer, swimmer_id)
    if not s:
        raise HTTPException(404, "Swimmer not found")
    return s


def _goal(db: Session, goal_id: int) -> models.SwimmerTarget:
    row = db.get(models.SwimmerTarget, goal_id)
    if not row:
        raise HTTPException(404, "Goal not found")
    return row


def _check_meet(db: Session, meet_id: Optional[int]) -> None:
    if meet_id and not db.get(models.Meet, meet_id):
        raise HTTPException(422, "That meet isn't in the Meets tab")


@router.get("")
def list_goals(swimmer_id: int, db: Session = Depends(get_db)):
    """The swimmer's goals, with what's needed to edit them: their events and the meets ahead."""
    swimmer = _swimmer(db, swimmer_id)
    rows = goal_svc.goals_of(db, swimmer.id)
    mine = [goal_svc.short_event(t.get("event") if isinstance(t, dict) else t) for t in swimmer.target_events or []]
    mine = [e for e in dict.fromkeys(mine) if e]
    used = {r.meet_id for r in rows if r.meet_id}
    since = date.today() - timedelta(days=14)
    meets = db.query(models.Meet).filter(models.Meet.date != None).order_by(models.Meet.date).all()  # noqa: E711
    return {
        "goals": [goal_svc.goal_out(db, r) for r in rows],
        "events": mine,
        "all_events": goal_svc.EVENTS,
        "meets": [{"id": m.id, "name": m.name, "date": m.date.isoformat(),
                   "course": "LC" if m.course == "LCM" else "SC" if m.course == "SCM" else None}
                  for m in meets if (m.date_to or m.date) >= since or m.id in used],
    }


@router.post("", status_code=201)
def create_goal(body: GoalIn, db: Session = Depends(get_db)):
    swimmer = _swimmer(db, body.swimmer_id)
    _check_meet(db, body.meet_id)
    row = models.SwimmerTarget(swimmer_id=swimmer.id, label="")
    db.add(row)
    goal_svc.apply(db, row, _changes(body, partial=False))
    db.commit()
    goal_svc.write_to_rosters(db, swimmer)
    db.refresh(row)
    return goal_svc.goal_out(db, row)


@router.patch("/{goal_id}")
def update_goal(goal_id: int, body: GoalUpdate, db: Session = Depends(get_db)):
    row = _goal(db, goal_id)
    changes = _changes(body, partial=True)
    if "meet_id" in changes:
        _check_meet(db, changes["meet_id"])
    goal_svc.apply(db, row, changes)
    db.commit()
    goal_svc.write_to_rosters(db, row.swimmer)
    db.refresh(row)
    return goal_svc.goal_out(db, row)


@router.delete("/{goal_id}", status_code=204)
def delete_goal(goal_id: int, db: Session = Depends(get_db)):
    row = _goal(db, goal_id)
    swimmer = row.swimmer
    db.delete(row)
    db.commit()
    goal_svc.write_to_rosters(db, swimmer)
