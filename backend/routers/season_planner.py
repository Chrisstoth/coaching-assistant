"""The coach's Season Planner inside the app: its documents and named versions.

The planner's own screen code runs in the app unchanged and saves through
here (frontend/src/planner). Each squad has one plan and one roster.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.database import get_db

router = APIRouter()
CLUB = "default"
KEYS = ("plan", "roster")


class DocIn(BaseModel):
    data: dict
    revision: Optional[int] = None


class VersionIn(BaseModel):
    name: Optional[str] = None
    savedAt: Optional[str] = None
    plan: dict
    roster: Optional[dict] = None


def _doc(db, squad, key):
    return db.query(models.PlanDoc).filter_by(club=CLUB, squad=squad, key=key).first()


@router.get("/squads")
def squads(db: DBSession = Depends(get_db)):
    return sorted({d.squad for d in db.query(models.PlanDoc).filter_by(club=CLUB, key="plan")})


@router.get("/{squad}/docs")
def docs(squad: str, db: DBSession = Depends(get_db)):
    out = {}
    for k in KEYS:
        d = _doc(db, squad, k)
        out[k] = {"data": d.data, "revision": d.revision} if d else None
    return out


@router.put("/{squad}/docs/{key}")
def put_doc(squad: str, key: str, body: DocIn, db: DBSession = Depends(get_db)):
    if key not in KEYS:
        raise HTTPException(status_code=404, detail="Unknown document")
    d = _doc(db, squad, key)
    if d and body.revision is not None and body.revision != d.revision:
        raise HTTPException(status_code=409, detail="The plan was changed on another device; it has been reloaded.")
    before = d.data if d else None
    if not d:
        d = models.PlanDoc(club=CLUB, squad=squad, key=key, data=body.data, revision=1)
        db.add(d)
    else:
        d.data, d.revision = body.data, d.revision + 1
    db.commit()
    revision = d.revision
    # The swimmers and their groups live in the roster; the groups themselves in the plan.
    from backend.services import season_planner
    try:
        if key == "roster":
            season_planner.sync_swimmers(db, squad, before, body.data)
        season_planner.after_save(db, squad)
    except Exception:  # noqa: BLE001 - the plan is saved even if following it in the app fails
        db.rollback()
    return {"revision": revision}


@router.get("/{squad}/versions")
def versions(squad: str, limit: int = 40, db: DBSession = Depends(get_db)):
    rows = db.query(models.PlanVersion).filter_by(club=CLUB, squad=squad).order_by(models.PlanVersion.id.desc()).limit(limit).all()
    return [{"id": str(v.id), "name": v.name, "savedAt": v.saved_at} for v in rows]


@router.get("/{squad}/versions/{vid}")
def version(squad: str, vid: int, db: DBSession = Depends(get_db)):
    v = db.query(models.PlanVersion).filter_by(club=CLUB, squad=squad, id=vid).first()
    if not v:
        raise HTTPException(status_code=404, detail="No such version")
    return {"id": str(v.id), "name": v.name, "savedAt": v.saved_at, "plan": v.plan, "roster": v.roster}


@router.post("/{squad}/versions", status_code=201)
def add_version(squad: str, body: VersionIn, db: DBSession = Depends(get_db)):
    v = models.PlanVersion(club=CLUB, squad=squad, name=body.name, saved_at=body.savedAt, plan=body.plan, roster=body.roster)
    db.add(v)
    db.commit()
    return {"id": str(v.id)}


@router.delete("/{squad}/versions/{vid}", status_code=204)
def delete_version(squad: str, vid: int, db: DBSession = Depends(get_db)):
    db.query(models.PlanVersion).filter_by(club=CLUB, squad=squad, id=vid).delete()
    db.commit()
