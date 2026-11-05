"""Predictions and each worker's track record (step 8).

Workers write down what they expect, in a form that can be checked. A race
time is checked in code against the results; anything else the coach marks
right or wrong. The track record shows how far to trust each worker - which
is how they are judged, never by how often the coach agrees with them.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models

STROKES = {"free": "Freestyle", "freestyle": "Freestyle", "back": "Backstroke", "backstroke": "Backstroke",
           "breast": "Breaststroke", "breaststroke": "Breaststroke", "fly": "Butterfly", "butterfly": "Butterfly",
           "im": "IM", "medley": "IM", "individual medley": "IM"}
GRACE_DAYS = 7          # after the due date, a prediction with no swim is closed as "no result"


def parse_time(text) -> Optional[float]:
    s = str(text or "").strip()
    m = re.fullmatch(r"(?:(\d+):)?(\d{1,2})(?:[.,](\d{1,2}))?", s)
    if not m:
        return None
    mins, secs, hund = int(m.group(1) or 0), int(m.group(2)), m.group(3) or "0"
    return mins * 60 + secs + int(hund.ljust(2, "0")) / 100


def fmt(seconds: float) -> str:
    m, s = divmod(seconds, 60)
    return f"{int(m)}:{s:05.2f}" if m else f"{s:.2f}"


def add(db: DBSession, role: str, p: dict, trigger: Optional[str] = None) -> Optional[models.Prediction]:
    """One prediction from a worker, if it can be checked."""
    statement = str(p.get("statement") or "").strip()
    if not statement:
        return None
    row = models.Prediction(role=role, statement=statement[:400], kind="other", trigger=trigger)
    if p.get("due"):
        try:
            row.due = date.fromisoformat(str(p["due"]))
        except ValueError:
            pass
    if p.get("kind") == "race_time":
        target = parse_time(p.get("target"))
        stroke = STROKES.get(str(p.get("stroke") or "").strip().lower())
        try:
            dist, sid = int(p.get("distance")), int(p.get("swimmer_id"))
        except (TypeError, ValueError):
            dist = sid = None
        if not (target and stroke and dist and sid and db.get(models.Swimmer, sid)):
            return None                                  # a race prediction that can't be checked isn't kept
        row.kind, row.target_seconds, row.stroke, row.distance, row.swimmer_id = "race_time", target, stroke, dist, sid
        row.course = "LCM" if str(p.get("course") or "").upper().startswith("L") else "SCM"
        if p.get("meet_id"):
            meet = db.get(models.Meet, int(p["meet_id"]))
            if meet:
                row.meet_id = meet.id
                row.due = row.due or meet.date_to or meet.date
    if not row.due:
        row.due = date.today() + timedelta(weeks=6)
    db.add(row)
    db.commit()
    return row


def _event_match(t: models.SwimTime, p: models.Prediction) -> bool:
    if t.distance and t.distance != p.distance:
        return False
    if t.course and p.course and t.course.upper() != p.course:
        return False
    stroke = (t.stroke or t.event or "").lower()
    return p.stroke.lower()[:4] in stroke or (p.stroke == "IM" and ("medley" in stroke or re.search(r"\bim\b", stroke)))


def check(db: DBSession, today: Optional[date] = None) -> int:
    """Check every open race-time prediction against the results. Returns how many were settled."""
    today = today or date.today()
    settled = 0
    for p in db.query(models.Prediction).filter(models.Prediction.outcome.is_(None), models.Prediction.kind == "race_time").all():
        made = p.created_at.date() if p.created_at else today - timedelta(days=365)
        q = db.query(models.SwimTime).filter(models.SwimTime.swimmer_id == p.swimmer_id, models.SwimTime.date >= made,
                                             models.SwimTime.date <= (p.due or today) + timedelta(days=1))
        if p.meet_id:
            q = q.filter(models.SwimTime.meet_id == p.meet_id)
        swims = [t for t in q.all() if _event_match(t, p)]
        if swims:
            best = min(t.time_seconds for t in swims)
            p.outcome = "right" if best <= p.target_seconds else "wrong"
            p.actual = f"swam {fmt(best)} (target {fmt(p.target_seconds)})"
        elif p.due and today > p.due + timedelta(days=GRACE_DAYS):
            p.outcome, p.actual = "no result", "no swim in that event by the due date"
        else:
            continue
        p.checked_at = datetime.now(timezone.utc)
        settled += 1
    db.commit()
    return settled


def mark(db: DBSession, prediction_id: int, outcome: str) -> models.Prediction:
    if outcome not in ("right", "wrong", "no result"):
        raise ValueError("Right, wrong or no result")
    p = db.get(models.Prediction, prediction_id)
    if not p:
        raise ValueError("No such prediction")
    p.outcome, p.checked_at = outcome, datetime.now(timezone.utc)
    p.actual = p.actual or "marked by the coach"
    db.commit()
    return p


def track_record(db: DBSession) -> dict:
    out = defaultdict(Counter)
    for p in db.query(models.Prediction).all():
        out[p.role][p.outcome or "open"] += 1
    return {role: {**c, "rate": round(100 * c["right"] / (c["right"] + c["wrong"])) if (c["right"] + c["wrong"]) else None}
            for role, c in out.items()}


def open_lines(db: DBSession, role: str) -> str:
    rows = db.query(models.Prediction).filter(models.Prediction.role == role, models.Prediction.outcome.is_(None)).all()
    return "\n".join(f"- {p.statement} (due {p.due:%d %b})" for p in rows if p.due) or "(none)"


def out(p: models.Prediction, names: dict) -> dict:
    return {"id": p.id, "role": p.role, "name": names.get(p.role, p.role), "statement": p.statement, "kind": p.kind,
            "due": p.due.isoformat() if p.due else None, "outcome": p.outcome, "actual": p.actual}
