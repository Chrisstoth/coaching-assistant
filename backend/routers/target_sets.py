"""Target sets: training target times worked out from each swimmer's PBs."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.database import get_db
from backend.services import target_times as tt

router = APIRouter()


class TargetSetIn(BaseModel):
    name: str = Field("", max_length=120)
    squad: Optional[str] = None
    base_distance: Optional[int] = Field(100, ge=25, le=1500)
    rep_distance: int = Field(25, ge=25, le=1500)
    offsets: list[float] = Field(default_factory=lambda: [0, 0.5, 1.0])
    course: str = "SCM"
    strokes: Optional[list[str]] = None
    decimals: int = Field(1, ge=1, le=2)

    @field_validator("squad")
    @classmethod
    def _squad(cls, v):
        return (v or "").strip() or None

    @field_validator("offsets")
    @classmethod
    def _offsets(cls, v):
        cleaned = []
        for o in v:
            o = round(float(o), 2)
            if not -30 <= o <= 60:
                raise ValueError("Each step must be between −30 and +60 seconds")
            if o not in cleaned:
                cleaned.append(o)
        if not cleaned:
            raise ValueError("Add at least one time, e.g. 0 for PB pace")
        if len(cleaned) > 6:
            raise ValueError("Up to six times per set")
        return cleaned

    @field_validator("course")
    @classmethod
    def _course(cls, v):
        v = (v or "SCM").upper()
        if v not in tt.COURSES:
            raise ValueError("Course must be SCM or LCM")
        return v

    @field_validator("strokes")
    @classmethod
    def _strokes(cls, v):
        if not v:
            return None
        unknown = [s for s in v if s not in tt.STROKES]
        if unknown:
            raise ValueError(f"Unknown stroke: {', '.join(unknown)}")
        return [s for s in tt.STROKES if s in v]


def _name_for(body: TargetSetIn) -> str:
    if body.name.strip():
        return body.name.strip()
    base = f"{body.base_distance} PB" if body.base_distance else "Event PB"
    return f"{base} pace for {body.rep_distance}s"


def _serialize(ts: models.TargetSet) -> dict:
    return {
        "id": ts.id, "name": ts.name, "squad": ts.squad,
        "base_distance": ts.base_distance, "rep_distance": ts.rep_distance,
        "offsets": ts.offsets or [0], "course": ts.course or "SCM",
        "strokes": ts.strokes, "decimals": ts.decimals or 1,
        "summary": tt.describe(ts), "columns": tt.columns(ts),
    }


def _get_or_404(set_id: int, db: DBSession) -> models.TargetSet:
    ts = db.query(models.TargetSet).filter(models.TargetSet.id == set_id).first()
    if not ts:
        raise HTTPException(status_code=404, detail="Target set not found")
    return ts


@router.get("")
def list_target_sets(db: DBSession = Depends(get_db)):
    sets = db.query(models.TargetSet).order_by(models.TargetSet.name).all()
    squads = [row[0] for row in db.query(models.Swimmer.squad).filter(
        models.Swimmer.active == True, models.Swimmer.squad != None,  # noqa: E711,E712
    ).distinct().order_by(models.Swimmer.squad).all()]
    return {"sets": [_serialize(s) for s in sets], "squads": squads, "strokes": tt.STROKES}


@router.post("", status_code=201)
def create_target_set(body: TargetSetIn, db: DBSession = Depends(get_db)):
    data = body.model_dump()
    data["name"] = _name_for(body)
    ts = models.TargetSet(**data)
    db.add(ts)
    db.commit()
    db.refresh(ts)
    return _serialize(ts)


@router.put("/{set_id}")
def update_target_set(set_id: int, body: TargetSetIn, db: DBSession = Depends(get_db)):
    ts = _get_or_404(set_id, db)
    data = body.model_dump()
    data["name"] = _name_for(body)
    for key, value in data.items():
        setattr(ts, key, value)
    db.commit()
    db.refresh(ts)
    return _serialize(ts)


@router.delete("/{set_id}", status_code=204)
def delete_target_set(set_id: int, db: DBSession = Depends(get_db)):
    db.delete(_get_or_404(set_id, db))
    db.commit()


@router.post("/preview")
def preview_target_set(body: TargetSetIn, db: DBSession = Depends(get_db)):
    """The squad's times for a set that hasn't been saved yet."""
    draft = models.TargetSet(**{**body.model_dump(), "name": _name_for(body)})
    return {"set": _serialize(draft), **tt.build_table(draft, db)}


@router.get("/swimmer/{swimmer_id}")
def swimmer_target_times(swimmer_id: int, db: DBSession = Depends(get_db)):
    swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
    if not swimmer:
        raise HTTPException(status_code=404, detail="Swimmer not found")
    sets = db.query(models.TargetSet).order_by(models.TargetSet.name).all()
    return tt.swimmer_sets(swimmer, sets, db)


@router.get("/{set_id}/table")
def target_set_table(set_id: int, squad: Optional[str] = None, db: DBSession = Depends(get_db)):
    ts = _get_or_404(set_id, db)
    return {"set": _serialize(ts), **tt.build_table(ts, db, squad=squad)}
