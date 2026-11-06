"""What the staff need from the coach, in one list for the Home screen.

- safety flags on sessions, waiting to be acknowledged
- predictions past their date that only the coach can mark (not race times)
- workbook pages the staff changed this week that the coach hasn't read
- Maggie's shorthand questions

Each part is read on its own, so one failing never empties the list.
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models


def asks(db: DBSession, today: Optional[date] = None) -> dict:
    today = today or date.today()
    from backend.services import workbooks as W
    names = {k: v.name for k, v in W.workers().items()}
    items = []

    try:
        flags = db.query(models.StaffNote).filter(models.StaffNote.flag == "safety", models.StaffNote.status == "open") \
            .order_by(models.StaffNote.created_at.desc()).limit(20).all()
        for n in flags:
            items.append({"kind": "safety", "who": names.get(n.role, n.role), "text": n.message,
                          "link": f"/builder/{n.session_id}" if n.session_id else "/workbooks"})
    except Exception:  # noqa: BLE001
        db.rollback()

    try:
        due = db.query(models.Prediction).filter(models.Prediction.outcome.is_(None), models.Prediction.kind != "race_time",
                                                 models.Prediction.due.isnot(None), models.Prediction.due <= today).all()
        for p in due:
            items.append({"kind": "prediction", "who": names.get(p.role, p.role),
                          "text": f"Did this happen? {p.statement}", "link": "/workbooks", "prediction_id": p.id})
    except Exception:  # noqa: BLE001
        db.rollback()

    try:
        from backend.services import weekly_review
        unread = [c for c in weekly_review.this_week(db, today)["changes"] if not c["reviewed"]]
        if unread:
            who = sorted({c["name"] for c in unread})
            items.append({"kind": "review", "who": ", ".join(who),
                          "text": f"{len(unread)} workbook page{'s' if len(unread) != 1 else ''} changed this week, to read and tick",
                          "link": "/workbooks"})
    except Exception:  # noqa: BLE001
        db.rollback()

    try:
        from backend.services import import_queue
        q = import_queue.questions(db)
        if q:
            items.append({"kind": "question", "who": "Maggie",
                          "text": f"{len(q)} bit{'s' if len(q) != 1 else ''} of your shorthand to explain", "link": "/history-import"})
    except Exception:  # noqa: BLE001
        db.rollback()

    return {"count": len(items), "items": items}
