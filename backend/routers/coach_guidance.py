"""The coach's rules for the staff - see services/coach_guidance."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.database import get_db
from backend.services import coach_guidance as svc

router = APIRouter()


class RuleIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=500)
    role: Optional[str] = None


class RulePatch(BaseModel):
    text: Optional[str] = Field(default=None, max_length=500)
    active: Optional[bool] = None


def _rule(db: DBSession, rule_id: int) -> models.CoachGuidance:
    rule = db.get(models.CoachGuidance, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    return rule


@router.get("")
def list_rules(db: DBSession = Depends(get_db)):
    return [svc.out(r) for r in svc.rules(db, include_inactive=True)]


@router.post("", status_code=201)
def add_rule(body: RuleIn, db: DBSession = Depends(get_db)):
    return svc.out(svc.add(db, body.text, body.role, source="Added by you"))


@router.patch("/{rule_id}")
def update_rule(rule_id: int, body: RulePatch, db: DBSession = Depends(get_db)):
    rule = _rule(db, rule_id)
    if body.text is not None:
        if not body.text.strip():
            raise HTTPException(status_code=422, detail="A rule needs some words")
        rule.text = body.text.strip()
    if body.active is not None:
        rule.active = body.active
    db.commit()
    return svc.out(rule)


@router.delete("/{rule_id}", status_code=204)
def delete_rule(rule_id: int, db: DBSession = Depends(get_db)):
    db.delete(_rule(db, rule_id))
    db.commit()
