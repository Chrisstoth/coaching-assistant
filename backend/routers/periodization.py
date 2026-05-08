from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models
from backend.services.claude_service import generate_micro_plan

router = APIRouter()


@router.post("/{swimmer_id}/micro")
def generate_micro_cycle(swimmer_id: int, db: DBSession = Depends(get_db)):
    swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
    if not swimmer:
        raise HTTPException(status_code=404, detail="Swimmer not found")

    plan_data = generate_micro_plan(swimmer, db)

    from datetime import datetime
    date_from = None
    date_to = None
    if plan_data.get("date_from"):
        try:
            date_from = datetime.strptime(plan_data["date_from"], "%Y-%m-%d").date()
        except ValueError:
            pass
    if plan_data.get("date_to"):
        try:
            date_to = datetime.strptime(plan_data["date_to"], "%Y-%m-%d").date()
        except ValueError:
            pass

    plan = models.PeriodizationPlan(
        swimmer_id=swimmer_id,
        plan_type="micro",
        date_from=date_from,
        date_to=date_to,
        focus=plan_data.get("focus"),
        content=plan_data,
        rationale=plan_data.get("rationale"),
        ai_generated=True,
    )
    db.add(plan)
    db.commit()

    return {
        "plan_id": plan.id,
        "swimmer": swimmer.name,
        **plan_data,
    }


@router.get("/{swimmer_id}")
def list_plans(swimmer_id: int, db: DBSession = Depends(get_db)):
    plans = (
        db.query(models.PeriodizationPlan)
        .filter(models.PeriodizationPlan.swimmer_id == swimmer_id)
        .order_by(models.PeriodizationPlan.created_at.desc())
        .all()
    )
    return [
        {
            "id": p.id,
            "plan_type": p.plan_type,
            "date_from": p.date_from,
            "date_to": p.date_to,
            "focus": p.focus,
            "coach_approved": p.coach_approved,
            "created_at": p.created_at,
        }
        for p in plans
    ]


@router.put("/{swimmer_id}/{plan_id}/approve")
def approve_plan(swimmer_id: int, plan_id: int, db: DBSession = Depends(get_db)):
    plan = db.query(models.PeriodizationPlan).filter(
        models.PeriodizationPlan.id == plan_id,
        models.PeriodizationPlan.swimmer_id == swimmer_id,
    ).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    plan.coach_approved = True
    db.commit()
    return {"approved": True}
