from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models

router = APIRouter()


class CohortCreate(BaseModel):
    name: str
    colour: Optional[str] = "teal"
    goals: Optional[str] = None
    target_meet_ids: Optional[list[int]] = []


class CohortUpdate(BaseModel):
    name: Optional[str] = None
    colour: Optional[str] = None
    goals: Optional[str] = None
    target_meet_ids: Optional[list[int]] = None


def _cohort_out(c: models.PlanningCohort, db: DBSession) -> dict:
    swimmers = (
        db.query(models.Swimmer)
        .filter(models.Swimmer.planning_cohort_id == c.id)
        .order_by(models.Swimmer.name)
        .all()
    )
    meets = []
    if c.target_meet_ids:
        for mid in c.target_meet_ids:
            m = db.query(models.Meet).filter(models.Meet.id == mid).first()
            if m:
                meets.append({"id": m.id, "name": m.name, "date": str(m.date) if m.date else None})
    return {
        "id": c.id,
        "name": c.name,
        "colour": c.colour,
        "goals": c.goals,
        "target_meet_ids": c.target_meet_ids or [],
        "target_meets": meets,
        "swimmers": [
            {"id": s.id, "name": s.name, "squad": s.squad, "has_profile": bool(s.physical_profile)}
            for s in swimmers
        ],
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


@router.get("")
def list_cohorts(db: DBSession = Depends(get_db)):
    cohorts = db.query(models.PlanningCohort).order_by(models.PlanningCohort.name).all()
    return [_cohort_out(c, db) for c in cohorts]


@router.post("", status_code=201)
def create_cohort(body: CohortCreate, db: DBSession = Depends(get_db)):
    cohort = models.PlanningCohort(
        name=body.name,
        colour=body.colour,
        goals=body.goals,
        target_meet_ids=body.target_meet_ids or [],
    )
    db.add(cohort)
    db.commit()
    db.refresh(cohort)
    return _cohort_out(cohort, db)


@router.get("/{cohort_id}")
def get_cohort(cohort_id: int, db: DBSession = Depends(get_db)):
    c = db.query(models.PlanningCohort).filter(models.PlanningCohort.id == cohort_id).first()
    if not c:
        raise HTTPException(404, "Cohort not found")
    return _cohort_out(c, db)


@router.patch("/{cohort_id}")
def update_cohort(cohort_id: int, body: CohortUpdate, db: DBSession = Depends(get_db)):
    c = db.query(models.PlanningCohort).filter(models.PlanningCohort.id == cohort_id).first()
    if not c:
        raise HTTPException(404, "Cohort not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(c, field, value)
    db.commit()
    db.refresh(c)
    return _cohort_out(c, db)


@router.delete("/{cohort_id}", status_code=204)
def delete_cohort(cohort_id: int, db: DBSession = Depends(get_db)):
    c = db.query(models.PlanningCohort).filter(models.PlanningCohort.id == cohort_id).first()
    if not c:
        raise HTTPException(404, "Cohort not found")
    # Unassign all swimmers
    db.query(models.Swimmer).filter(
        models.Swimmer.planning_cohort_id == cohort_id
    ).update({"planning_cohort_id": None})
    db.delete(c)
    db.commit()


@router.put("/{cohort_id}/swimmers")
def set_cohort_swimmers(cohort_id: int, body: dict, db: DBSession = Depends(get_db)):
    """Replace the full member list for a cohort. body: {"swimmer_ids": [...]}"""
    c = db.query(models.PlanningCohort).filter(models.PlanningCohort.id == cohort_id).first()
    if not c:
        raise HTTPException(404, "Cohort not found")
    swimmer_ids = body.get("swimmer_ids", [])
    # Remove anyone currently in this cohort who isn't in the new list
    db.query(models.Swimmer).filter(
        models.Swimmer.planning_cohort_id == cohort_id
    ).update({"planning_cohort_id": None})
    # Assign new members
    if swimmer_ids:
        db.query(models.Swimmer).filter(
            models.Swimmer.id.in_(swimmer_ids)
        ).update({"planning_cohort_id": cohort_id}, synchronize_session=False)
    db.commit()
    db.refresh(c)
    return _cohort_out(c, db)
