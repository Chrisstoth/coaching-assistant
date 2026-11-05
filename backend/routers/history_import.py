"""Maggie's desk: the history import queue, her questions, and the style review."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.database import get_db
from backend.services import import_queue as Q
from backend.services import style_review as SR
from backend.services import workbooks as W
from backend.services.ai_operations import enqueue_operation, operation_out

router = APIRouter()


class Roots(BaseModel):
    roots: list[str]


class RunIn(BaseModel):
    limit: int = 50
    use_ai: bool = True


class ItemDecision(BaseModel):
    action: str                  # import / skip
    draft: Optional[dict] = None


class Answer(BaseModel):
    term: str
    meaning: str


class StyleAnswer(BaseModel):
    statement: str
    choice: str                  # moved_on / still_do / sometimes
    reason: Optional[str] = None


def _settings(db: DBSession) -> models.SessionPresentationSettings:
    s = db.query(models.SessionPresentationSettings).first()
    if not s:
        s = models.SessionPresentationSettings(id=1)
        db.add(s)
        db.flush()
    return s


@router.get("")
def overview(db: DBSession = Depends(get_db)):
    return {"roots": _settings(db).import_roots or [], **Q.overview(db), "questions": len(Q.questions(db))}


@router.put("/roots")
def set_roots(body: Roots, db: DBSession = Depends(get_db)):
    s = _settings(db)
    s.import_roots = [r.strip() for r in body.roots if r.strip()]
    db.commit()
    return {"roots": s.import_roots}


@router.post("/scan")
def scan(db: DBSession = Depends(get_db)):
    roots = _settings(db).import_roots or []
    if not roots:
        raise HTTPException(status_code=422, detail="Add the folders your sessions are in first.")
    return Q.scan(db, roots)


@router.post("/run", status_code=202)
def run(body: RunIn, db: DBSession = Depends(get_db)):
    """Maggie reads the next files in the background; the page shows progress from the counts."""
    op = enqueue_operation(db, operation_type="history_import_batch", title=f"Maggie reads {body.limit} old sessions",
                           payload={"limit": max(1, min(body.limit, 200)), "use_ai": body.use_ai})
    db.commit()
    return operation_out(op)


@router.get("/items")
def items(status: str = "pending", limit: int = 30, offset: int = 0, db: DBSession = Depends(get_db)):
    rows = db.query(models.ImportItem).filter(models.ImportItem.club == Q.CLUB, models.ImportItem.status == status) \
        .order_by(models.ImportItem.file_date.desc()).offset(offset).limit(limit).all()
    return [Q.item_out(r) for r in rows]


@router.post("/items/{item_id}")
def decide(item_id: int, body: ItemDecision, db: DBSession = Depends(get_db)):
    it = db.get(models.ImportItem, item_id)
    if not it:
        raise HTTPException(status_code=404, detail="No such file")
    if body.action == "skip":
        Q.skip(db, it)
    elif body.action == "import":
        s = Q.import_item(db, it, body.draft)
        if not s:
            raise HTTPException(status_code=422, detail=it.error or "Could not import it")
    else:
        raise HTTPException(status_code=422, detail="Import or skip")
    return Q.item_out(it)


@router.get("/questions")
def questions(db: DBSession = Depends(get_db)):
    return Q.questions(db)


@router.post("/questions")
def answer(body: Answer, db: DBSession = Depends(get_db)):
    try:
        return Q.answer(db, body.term, body.meaning)
    except W.WorkbookError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/style")
def style_stats(db: DBSession = Depends(get_db)):
    return SR.period_stats(db)


@router.post("/style/candidates")
def style_candidates(db: DBSession = Depends(get_db)):
    return {"statements": SR.candidates(db)}


@router.post("/style/answer")
def style_answer(body: StyleAnswer, db: DBSession = Depends(get_db)):
    try:
        return SR.answer(db, body.statement, body.choice, body.reason)
    except W.WorkbookError as e:
        raise HTTPException(status_code=422, detail=str(e))
