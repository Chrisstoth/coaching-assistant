"""What the staff need from the coach, in one list for the Home screen.

- safety flags on sessions, waiting to be acknowledged
- predictions past their date that only the coach can mark (not race times)
- workbook pages the staff changed this week that the coach hasn't read
- Maggie's shorthand questions

Each part is read on its own, so one failing never empties the list. Each item
carries what it is attached to and what started it, so Home can open it in
place and the coach can deal with it there.
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models

# What started a note, in the coach's words.
TRIGGERS = {
    "builder": "Reading the session in the Session Builder",
    "coach_message": "Something you said to the staff",
    "plan_draft": "Drafting the plan",
    "swimmer_review": "A swimmer review",
    "reply": "A reply in a staff conversation",
}


def _trigger(trigger: Optional[str]) -> Optional[str]:
    if not trigger:
        return None
    if trigger.startswith("weekly:"):
        return "The staff's weekly review"
    return TRIGGERS.get(trigger)


def _day(when) -> Optional[str]:
    return when.date().isoformat() if when else None


def _session(s) -> Optional[dict]:
    if not s:
        return None
    return {"id": s.id, "date": s.date.isoformat() if s.date else None, "title": s.title,
            "squad": s.squad, "time": s.start_time}


def _swimmer_names(db: DBSession, ids) -> dict:
    ids = {i for i in ids if isinstance(i, int)}
    if not ids:
        return {}
    return dict(db.query(models.Swimmer.id, models.Swimmer.name).filter(models.Swimmer.id.in_(ids)).all())


def asks(db: DBSession, today: Optional[date] = None) -> dict:
    today = today or date.today()
    from backend.services import workbooks as W
    names = {k: v.name for k, v in W.workers().items()}
    items = []

    try:
        flags = db.query(models.StaffNote).filter(models.StaffNote.flag == "safety", models.StaffNote.status == "open") \
            .order_by(models.StaffNote.created_at.desc()).limit(20).all()
        swimmers = _swimmer_names(db, {i for n in flags for i in (n.swimmer_ids or [])})
        for n in flags:
            anchor = n.anchor if isinstance(n.anchor, dict) else {}
            items.append({
                "kind": "safety", "key": f"note:{n.id}", "note_id": n.id, "who": names.get(n.role, n.role),
                "text": n.message, "question": n.question,
                "link": f"/builder/{n.session_id}" if n.session_id else "/workbooks",
                "raised": _day(n.created_at), "trigger": _trigger(n.trigger),
                "session": _session(db.get(models.Session, n.session_id) if n.session_id else None),
                "block": anchor.get("block"),
                "swimmers": [swimmers[i] for i in (n.swimmer_ids or []) if i in swimmers],
                "can_rate": n.trigger == "builder", "useful": n.useful,
            })
    except Exception:  # noqa: BLE001
        db.rollback()

    try:
        due = db.query(models.Prediction).filter(models.Prediction.outcome.is_(None), models.Prediction.kind != "race_time",
                                                 models.Prediction.due.isnot(None), models.Prediction.due <= today).all()
        swimmers = _swimmer_names(db, {p.swimmer_id for p in due})
        for p in due:
            items.append({
                "kind": "prediction", "key": f"prediction:{p.id}", "prediction_id": p.id, "who": names.get(p.role, p.role),
                "text": f"Did this happen? {p.statement}", "statement": p.statement, "link": "/workbooks",
                "raised": _day(p.created_at), "due": p.due.isoformat(), "trigger": _trigger(p.trigger),
                "swimmers": [swimmers[p.swimmer_id]] if p.swimmer_id in swimmers else [],
            })
    except Exception:  # noqa: BLE001
        db.rollback()

    try:
        from backend.services import weekly_review
        unread = [c for c in weekly_review.this_week(db, today)["changes"] if not c["reviewed"]]
        if unread:
            who = sorted({c["name"] for c in unread})
            items.append({"kind": "review", "key": "review", "who": ", ".join(who),
                          "text": f"{len(unread)} workbook page{'s' if len(unread) != 1 else ''} changed this week, to read and tick",
                          "link": "/workbooks",
                          "pages": [{k: c[k] for k in ("role", "name", "path", "title", "summary", "reason")} for c in unread[:12]]})
    except Exception:  # noqa: BLE001
        db.rollback()

    try:
        from backend.services import import_queue
        q = import_queue.questions(db)
        if q:
            items.append({"kind": "question", "key": "question", "who": "Maggie",
                          "text": f"{len(q)} bit{'s' if len(q) != 1 else ''} of your shorthand to explain", "link": "/history-import",
                          "terms": q[:6]})
    except Exception:  # noqa: BLE001
        db.rollback()

    return {"count": len(items), "items": items}
