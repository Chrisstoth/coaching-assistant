"""Training groups on the Swimmers page: set them up, move swimmers between them."""

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.database import get_db
from backend.services import groups as svc

router = APIRouter()


class GroupIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=60)
    description: Optional[str] = Field(default=None, max_length=1000)
    squad: Optional[str] = Field(default=None, max_length=120)


class GroupPatch(BaseModel):
    name: Optional[str] = Field(default=None, max_length=60)
    description: Optional[str] = Field(default=None, max_length=1000)
    sort_order: Optional[int] = None


class MoveIn(BaseModel):
    swimmer_ids: list[int] = Field(..., min_length=1, max_length=100)
    group_id: Optional[int] = None          # None takes them out of groups
    date_from: Optional[date] = None        # default: today
    note: Optional[str] = Field(default=None, max_length=500)


class OrderIn(BaseModel):
    ids: list[int] = Field(..., min_length=1)


class CopyIn(BaseModel):
    macro_id: int


def _group(db: DBSession, group_id: int) -> models.TrainingGroup:
    group = db.query(models.TrainingGroup).filter(models.TrainingGroup.id == group_id).first()
    if not group or not group.active:
        raise HTTPException(status_code=404, detail="Group not found")
    return group


@router.get("")
def list_groups(squad: Optional[str] = None, on: Optional[date] = None, db: DBSession = Depends(get_db)):
    return svc.overview(db, squad, on)


@router.post("", status_code=201)
def create_group(body: GroupIn, db: DBSession = Depends(get_db)):
    try:
        group = svc.create_group(db, body.name, body.description, body.squad)
    except svc.GroupError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    db.commit()
    return {"id": group.id, "name": group.name}


@router.patch("/{group_id}")
def update_group(group_id: int, body: GroupPatch, db: DBSession = Depends(get_db)):
    group = _group(db, group_id)
    try:
        svc.update_group(db, group, name=body.name, description=body.description, sort_order=body.sort_order)
    except svc.GroupError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    db.commit()
    return {"id": group.id, "name": group.name}


@router.delete("/{group_id}")
def close_group(group_id: int, db: DBSession = Depends(get_db)):
    """Stops using the group from today. Past weeks keep who was in it."""
    group = _group(db, group_id)
    svc.close_group(db, group)
    db.commit()
    return {"closed": group.id}


@router.post("/order")
def reorder(body: OrderIn, db: DBSession = Depends(get_db)):
    for i, gid in enumerate(body.ids):
        group = db.query(models.TrainingGroup).filter(models.TrainingGroup.id == gid).first()
        if group:
            group.sort_order = i + 1
    db.commit()
    return {"ok": True}


@router.post("/move")
def move_swimmers(body: MoveIn, db: DBSession = Depends(get_db)):
    when = body.date_from or date.today()
    try:
        for sid in body.swimmer_ids:
            svc.move(db, sid, body.group_id, when, body.note)
    except svc.GroupError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc))
    db.commit()
    return {"moved": len(body.swimmer_ids), "date_from": when.isoformat()}


@router.post("/copy-from-plan")
def copy_from_plan(body: CopyIn, db: DBSession = Depends(get_db)):
    """Make the squad's groups from the lists saved on a macrocycle."""
    macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == body.macro_id).first()
    if not macro:
        raise HTTPException(status_code=404, detail="Macrocycle not found")
    made = svc.copy_plan_groups(db, macro)
    db.commit()
    return {"created": [g.name for g in made]}


@router.get("/history/{swimmer_id}")
def swimmer_history(swimmer_id: int, db: DBSession = Depends(get_db)):
    return svc.history_out(db, swimmer_id)
