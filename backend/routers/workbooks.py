"""The staff's workbooks, for the coach to read, edit, compare and restore (backend/services/workbooks.py)."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend.services import workbooks as W

router = APIRouter()


class PageEdit(BaseModel):
    path: str
    content: str
    base_version: Optional[int] = None
    reason: Optional[str] = None


class Restore(BaseModel):
    path: str
    version: int


class Lock(BaseModel):
    path: str
    headings: list[str] = []


class Undo(BaseModel):
    trigger: str


class SnapshotIn(BaseModel):
    name: str


def _fail(e: W.WorkbookError):
    raise HTTPException(status_code=409 if isinstance(e, W.Conflict) else 422, detail=str(e))


def _page_out(p, w: Optional[W.Worker] = None) -> dict:
    out = {"role": p.role, "path": p.path, "title": p.title, "kind": p.kind, "summary": p.summary,
           "confidence": p.confidence, "swimmer_ids": p.swimmer_ids or [], "locked": p.locked or [],
           "version": p.version, "content": p.content,
           "updated_at": p.updated_at.isoformat() if p.updated_at else None}
    if w and p.path == "job.md":
        out["fixed"] = W.fixed_job(w)
    return out


@router.get("")
def list_workbooks(db: DBSession = Depends(get_db)):
    W.ensure_workbooks(db)
    out = []
    for w in W.workers().values():
        pages = W.pages(db, w.role)
        latest = max((p.updated_at for p in pages if p.updated_at), default=None)
        out.append({"role": w.role, "name": w.name, "title": w.title, "pages": len(pages),
                    "updated_at": latest.isoformat() if latest else None})
    return out


@router.get("/search")
def search(q: str, role: Optional[str] = None, db: DBSession = Depends(get_db)):
    return W.search(db, q, role)


@router.get("/snapshots")
def list_snapshots(db: DBSession = Depends(get_db)):
    from backend import models
    rows = db.query(models.WorkbookSnapshot).filter(models.WorkbookSnapshot.club == W.CLUB).order_by(models.WorkbookSnapshot.id.desc()).all()
    return [{"id": s.id, "name": s.name, "pages": len(s.versions or {}), "at": s.created_at.isoformat() if s.created_at else None} for s in rows]


@router.post("/snapshots", status_code=201)
def take_snapshot(body: SnapshotIn, db: DBSession = Depends(get_db)):
    s = W.snapshot(db, body.name)
    return {"id": s.id, "name": s.name}


@router.post("/snapshots/{snapshot_id}/restore")
def restore_snapshot(snapshot_id: int, db: DBSession = Depends(get_db)):
    try:
        return W.restore_snapshot(db, snapshot_id)
    except W.WorkbookError as e:
        _fail(e)


@router.post("/undo")
def undo(body: Undo, db: DBSession = Depends(get_db)):
    return W.undo_trigger(db, body.trigger)


@router.get("/{role}")
def workbook(role: str, db: DBSession = Depends(get_db)):
    try:
        w = W.worker(role)
    except W.WorkbookError as e:
        raise HTTPException(status_code=404, detail=str(e))
    W.ensure_workbooks(db)
    return {"role": w.role, "name": w.name, "title": w.title,
            "pages": [{k: v for k, v in _page_out(p).items() if k != "content"} for p in W.pages(db, role)]}


@router.get("/{role}/page")
def get_page(role: str, path: str, db: DBSession = Depends(get_db)):
    p = W.get_page(db, role, path)
    if not p:
        raise HTTPException(status_code=404, detail="No such page")
    return _page_out(p, W.worker(role))


@router.put("/{role}/page")
def put_page(role: str, body: PageEdit, db: DBSession = Depends(get_db)):
    try:
        p = W.write_page(db, role, body.path, body.content, author=W.COACH, base_version=body.base_version,
                         reason=body.reason or "edited by the coach")
    except W.WorkbookError as e:
        _fail(e)
    return _page_out(p, W.worker(role))


@router.get("/{role}/history")
def page_history(role: str, path: str, db: DBSession = Depends(get_db)):
    return W.history(db, role, path)


@router.get("/{role}/revision")
def page_revision(role: str, path: str, version: int, db: DBSession = Depends(get_db)):
    r = W.revision(db, role, path, version)
    if not r:
        raise HTTPException(status_code=404, detail="No such version")
    return {"version": r.version, "content": r.content, "author": r.author, "reason": r.reason, "trigger": r.trigger}


@router.post("/{role}/restore")
def restore(role: str, body: Restore, db: DBSession = Depends(get_db)):
    try:
        p = W.restore(db, role, body.path, body.version)
    except W.WorkbookError as e:
        _fail(e)
    return _page_out(p, W.worker(role))


@router.put("/{role}/lock")
def lock(role: str, body: Lock, db: DBSession = Depends(get_db)):
    try:
        p = W.set_locked(db, role, body.path, body.headings)
    except W.WorkbookError as e:
        _fail(e)
    return {"path": p.path, "locked": p.locked}


# ---------------------------------------------------------------- the weekly review

class Tick(BaseModel):
    role: str
    path: str


class Outcome(BaseModel):
    outcome: str


@router.get("/review/asks")
def review_asks(db: DBSession = Depends(get_db)):
    """What the staff need from the coach, in one list (the Home screen)."""
    from backend.services import staff_asks
    return staff_asks.asks(db)


@router.get("/review/week")
def review_week(db: DBSession = Depends(get_db)):
    """The coach's one short list: what changed this week, gaps, predictions and track records."""
    from backend.services import weekly_review
    return weekly_review.this_week(db)


@router.post("/review/tick")
def review_tick(body: Tick, db: DBSession = Depends(get_db)):
    from backend.services import weekly_review
    try:
        weekly_review.tick(db, body.role, body.path)
    except W.WorkbookError as e:
        _fail(e)
    return {"ok": True}


@router.post("/review/run", status_code=202)
def review_run(db: DBSession = Depends(get_db)):
    from backend.services.ai_operations import enqueue_operation, operation_out
    from datetime import date as _date
    op = enqueue_operation(db, operation_type="weekly_review", title="The staff's weekly review",
                           idempotency_key=f"weekly:{_date.today().isoformat()}")
    db.commit()
    return operation_out(op)


@router.post("/predictions/{prediction_id}")
def mark_prediction(prediction_id: int, body: Outcome, db: DBSession = Depends(get_db)):
    from backend.services import predictions
    try:
        p = predictions.mark(db, prediction_id, body.outcome)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"id": p.id, "outcome": p.outcome}
