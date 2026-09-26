"""Individual athlete plans: drafted by the staff, edited and finalised by the coach."""

from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend import models
from backend.database import get_db
from backend.services import swimmer_plan

router = APIRouter()


class PlanIn(BaseModel):
    swimmer_id: int
    audience: str = "performance"
    period_from: Optional[date] = None
    period_to: Optional[date] = None
    title: Optional[str] = Field(default=None, max_length=160)


class SectionChange(BaseModel):
    key: str
    content: Optional[str] = Field(default=None, max_length=8000)
    title: Optional[str] = Field(default=None, max_length=120)
    included: Optional[bool] = None


class PlanUpdate(BaseModel):
    title: Optional[str] = Field(default=None, max_length=160)
    audience: Optional[str] = None
    period_from: Optional[date] = None
    period_to: Optional[date] = None
    sections: list[SectionChange] = Field(default_factory=list)


class RedraftIn(BaseModel):
    instruction: Optional[str] = Field(default=None, max_length=1000)


def _plan_or_404(db: Session, plan_id: int) -> models.SwimmerPlan:
    plan = db.query(models.SwimmerPlan).filter(models.SwimmerPlan.id == plan_id).first()
    if not plan:
        raise HTTPException(404, "Plan not found")
    return plan


def _draft_or_409(plan: models.SwimmerPlan) -> None:
    if plan.status == "final":
        raise HTTPException(409, "This plan is final. Make a new version to change it.")


@router.get("")
def list_plans(swimmer_id: int, db: Session = Depends(get_db)):
    rows = db.query(models.SwimmerPlan).filter(models.SwimmerPlan.swimmer_id == swimmer_id).order_by(
        models.SwimmerPlan.id.desc()).all()
    return [{k: v for k, v in swimmer_plan.plan_out(p).items() if k != "sections"} for p in rows]


@router.post("", status_code=201)
def create_plan(body: PlanIn, db: Session = Depends(get_db)):
    swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == body.swimmer_id).first()
    if not swimmer:
        raise HTTPException(404, "Swimmer not found")
    if body.period_from and body.period_to and body.period_to < body.period_from:
        raise HTTPException(422, "The plan must end after it starts.")
    plan = swimmer_plan.create_plan(db, swimmer, audience=body.audience, period_from=body.period_from,
                                    period_to=body.period_to, title=body.title)
    return swimmer_plan.plan_out(plan)


@router.get("/{plan_id}")
def get_plan(plan_id: int, db: Session = Depends(get_db)):
    return swimmer_plan.plan_out(_plan_or_404(db, plan_id))


@router.patch("/{plan_id}")
def update_plan(plan_id: int, body: PlanUpdate, db: Session = Depends(get_db)):
    plan = _plan_or_404(db, plan_id)
    _draft_or_409(plan)
    if body.title:
        plan.title = body.title
    if body.audience in swimmer_plan.AUDIENCES:
        plan.audience = body.audience
    if body.period_from:
        plan.period_from = body.period_from
    if body.period_to:
        plan.period_to = body.period_to
    if body.sections:
        swimmer_plan.update_sections(plan, [c.model_dump(exclude_none=True) for c in body.sections])
    db.commit()
    db.refresh(plan)
    return swimmer_plan.plan_out(plan)


@router.post("/{plan_id}/sections/{key}/redraft")
def redraft(plan_id: int, key: str, body: RedraftIn, db: Session = Depends(get_db)):
    plan = _plan_or_404(db, plan_id)
    _draft_or_409(plan)
    try:
        swimmer_plan.redraft_section(db, plan, key, body.instruction)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    db.refresh(plan)
    return swimmer_plan.plan_out(plan)


@router.post("/{plan_id}/redraft")
def redraft_all(plan_id: int, db: Session = Depends(get_db)):
    """Redraft every section the coach has not edited - after a change of dates or reader."""
    plan = _plan_or_404(db, plan_id)
    _draft_or_409(plan)
    swimmer_plan.draft_all(db, plan)
    db.commit()
    db.refresh(plan)
    return swimmer_plan.plan_out(plan)


@router.post("/{plan_id}/finalise")
def finalise(plan_id: int, db: Session = Depends(get_db)):
    plan = _plan_or_404(db, plan_id)
    _draft_or_409(plan)
    if not any(s.get("included") and (s.get("content") or "").strip() for s in plan.sections or []):
        raise HTTPException(422, "There is nothing in this plan yet.")
    plan.status = "final"
    plan.finalised_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(plan)
    return swimmer_plan.plan_out(plan)


@router.post("/{plan_id}/copy", status_code=201)
def new_version(plan_id: int, db: Session = Depends(get_db)):
    """Start a new draft from any plan, keeping its wording to build on."""
    source = _plan_or_404(db, plan_id)
    plan = models.SwimmerPlan(
        swimmer_id=source.swimmer_id, audience=source.audience, period_from=source.period_from,
        period_to=source.period_to, title=source.title,
        sections=[dict(s) for s in source.sections or []], status="draft",
    )
    db.add(plan)
    db.commit()
    db.refresh(plan)
    return swimmer_plan.plan_out(plan)


@router.delete("/{plan_id}", status_code=204)
def delete_plan(plan_id: int, db: Session = Depends(get_db)):
    plan = _plan_or_404(db, plan_id)
    _draft_or_409(plan)
    db.delete(plan)
    db.commit()
