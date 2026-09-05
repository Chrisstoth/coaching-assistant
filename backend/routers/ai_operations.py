"""Visible lifecycle and retry controls for persistent AI operations."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.database import get_db
from backend.services.ai_operations import operation_out, utcnow

router = APIRouter()


@router.get("")
def list_operations(limit: int = 100, db: DBSession = Depends(get_db)):
    limit = max(1, min(limit, 250))
    rows = db.query(models.AIOperation).order_by(
        models.AIOperation.created_at.desc(), models.AIOperation.id.desc(),
    ).limit(limit).all()
    counts = {status: 0 for status in ("queued", "running", "completed", "failed")}
    for status, count in db.query(models.AIOperation.status, func.count(models.AIOperation.id)).group_by(models.AIOperation.status):
        counts[status] = count
    return {"items": [operation_out(row) for row in rows], "counts": counts}


@router.post("/{operation_id}/retry")
def retry_operation(operation_id: int, db: DBSession = Depends(get_db)):
    row = db.query(models.AIOperation).filter(models.AIOperation.id == operation_id).first()
    if not row:
        raise HTTPException(404, "AI operation not found")
    if row.status not in {"failed", "queued"}:
        raise HTTPException(409, "Only failed or waiting operations can be retried")
    row.status = "queued"
    row.attempts = 0
    row.available_at = utcnow()
    row.started_at = None
    row.completed_at = None
    row.error = None
    db.commit()
    db.refresh(row)
    return operation_out(row)
