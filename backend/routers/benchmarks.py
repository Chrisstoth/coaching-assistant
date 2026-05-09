from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from pydantic import BaseModel
from typing import Optional
from datetime import date

from backend.database import get_db
from backend import models

router = APIRouter()


class BenchmarkIn(BaseModel):
    swimmer_id: int
    distance: int
    stroke: str
    effort: str
    time_seconds: float
    date: date
    notes: Optional[str] = None
    session_id: Optional[int] = None


class TargetIn(BaseModel):
    swimmer_id: int
    label: str
    description: Optional[str] = None
    distance: Optional[int] = None
    stroke: Optional[str] = None
    effort: Optional[str] = None
    target_time_seconds: Optional[float] = None
    deadline: Optional[date] = None


@router.post("/benchmarks", status_code=201)
def log_benchmark(data: BenchmarkIn, db: Session = Depends(get_db)):
    entry = models.BenchmarkLog(**data.model_dump())
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@router.get("/benchmarks/{swimmer_id}")
def get_benchmarks(swimmer_id: int, db: Session = Depends(get_db)):
    logs = (
        db.query(models.BenchmarkLog)
        .filter(models.BenchmarkLog.swimmer_id == swimmer_id)
        .order_by(models.BenchmarkLog.date.desc())
        .all()
    )
    return logs


@router.get("/benchmarks/{swimmer_id}/current")
def get_current_benchmarks(swimmer_id: int, db: Session = Depends(get_db)):
    """Latest benchmark per distance/stroke/effort combination."""
    all_logs = (
        db.query(models.BenchmarkLog)
        .filter(models.BenchmarkLog.swimmer_id == swimmer_id)
        .order_by(models.BenchmarkLog.date.desc())
        .all()
    )
    seen = {}
    for log in all_logs:
        key = (log.distance, log.stroke, log.effort)
        if key not in seen:
            seen[key] = log
    return list(seen.values())


@router.delete("/benchmarks/{benchmark_id}", status_code=204)
def delete_benchmark(benchmark_id: int, db: Session = Depends(get_db)):
    entry = db.query(models.BenchmarkLog).filter(models.BenchmarkLog.id == benchmark_id).first()
    if not entry:
        raise HTTPException(404, "Benchmark not found")
    db.delete(entry)
    db.commit()


@router.post("/targets", status_code=201)
def create_target(data: TargetIn, db: Session = Depends(get_db)):
    target = models.SwimmerTarget(**data.model_dump())
    db.add(target)
    db.commit()
    db.refresh(target)
    return target


@router.get("/targets/{swimmer_id}")
def get_targets(swimmer_id: int, db: Session = Depends(get_db)):
    return (
        db.query(models.SwimmerTarget)
        .filter(models.SwimmerTarget.swimmer_id == swimmer_id)
        .order_by(models.SwimmerTarget.achieved, models.SwimmerTarget.deadline)
        .all()
    )


@router.patch("/targets/{target_id}")
def update_target(target_id: int, data: dict, db: Session = Depends(get_db)):
    target = db.query(models.SwimmerTarget).filter(models.SwimmerTarget.id == target_id).first()
    if not target:
        raise HTTPException(404, "Target not found")
    for k, v in data.items():
        if hasattr(target, k):
            setattr(target, k, v)
    db.commit()
    db.refresh(target)
    return target


@router.delete("/targets/{target_id}", status_code=204)
def delete_target(target_id: int, db: Session = Depends(get_db)):
    target = db.query(models.SwimmerTarget).filter(models.SwimmerTarget.id == target_id).first()
    if not target:
        raise HTTPException(404, "Target not found")
    db.delete(target)
    db.commit()
