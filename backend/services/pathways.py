"""Pathways: what each swimmer is aiming at, and from when.

A pathway belongs to a macrocycle and sets a target meet. Swimmers in one
training group can be on different pathways - a national-level swimmer in a
group of regional swimmers branches onto the Winter Nationals plan from a
date, while the others stay on theirs. A membership therefore has dates, and
"which pathway is this swimmer on" is always asked on a day.

A membership counts on a day when it is active and the day falls between its
dates (a missing date means open-ended).
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models


def covers(m: models.PathwayMembership, on: date) -> bool:
    return bool(m.active) and (not m.date_from or m.date_from <= on) and (not m.date_to or m.date_to >= on)


def _macro_memberships(db: DBSession, macro_id: int, swimmer_ids=None) -> list:
    q = db.query(models.PathwayMembership).join(models.PlanningPathway).filter(
        models.PlanningPathway.macro_id == macro_id,
        models.PlanningPathway.active.is_(True),
        models.PathwayMembership.active.is_(True),
    )
    if swimmer_ids is not None:
        q = q.filter(models.PathwayMembership.swimmer_id.in_(list(swimmer_ids)))
    return q.all()


def pathways_on(db: DBSession, macro_id: int, on: date, swimmer_ids=None) -> dict:
    """swimmer_id -> the membership in force that day (the latest start wins)."""
    out = {}
    for m in sorted(_macro_memberships(db, macro_id, swimmer_ids), key=lambda m: m.date_from or date.min):
        if covers(m, on):
            out[m.swimmer_id] = m
    return out


def upcoming(db: DBSession, macro_id: int, after: date, swimmer_ids=None) -> dict:
    """swimmer_id -> the next membership that starts after a day."""
    out = {}
    for m in sorted(_macro_memberships(db, macro_id, swimmer_ids), key=lambda m: m.date_from or date.min):
        if m.date_from and m.date_from > after:
            out.setdefault(m.swimmer_id, m)
    return out


def macro_on(db: DBSession, on: date) -> Optional[models.TrainingMacro]:
    return db.query(models.TrainingMacro).filter(
        models.TrainingMacro.date_from <= on, models.TrainingMacro.date_to >= on,
    ).order_by(models.TrainingMacro.date_from).first()


def close_others(db: DBSession, swimmer_id: int, pathway: models.PlanningPathway, date_from: date) -> None:
    """A swimmer joining a pathway from a date leaves their other one in that macro the day before."""
    for m in _macro_memberships(db, pathway.macro_id, [swimmer_id]):
        if m.pathway_id == pathway.id:
            continue
        if m.date_from and m.date_from >= date_from:
            db.delete(m)                        # a later plan for them is replaced
        elif not m.date_to or m.date_to >= date_from:
            m.date_to = date_from - timedelta(days=1)
    db.flush()


def describe(m: models.PathwayMembership, today: Optional[date] = None) -> str:
    """'Winter Nationals (close) from 12 Oct' - the way the staff read a membership."""
    today = today or date.today()
    bits = [f"{m.pathway.name} ({m.qualification_status or 'unknown'})"]
    if m.date_from and m.date_from > today:
        bits.append(f"from {m.date_from}")
    if m.date_to:
        bits.append(f"until {m.date_to}")
    return " ".join(bits)
