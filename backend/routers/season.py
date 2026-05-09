from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import date, timedelta

from backend.database import get_db
from backend import models

router = APIRouter()

PHASE_COLOURS = {
    'base': 'blue', 'build': 'green', 'peak': 'orange',
    'taper': 'yellow', 'competition': 'red', 'recovery': 'teal', 'transition': 'pool',
}

class BlockIn(BaseModel):
    name: str
    phase_type: Optional[str] = None
    date_from: date
    date_to: date
    emphasis: Optional[dict] = None
    notes: Optional[str] = None

@router.get("/blocks")
def get_blocks(db: Session = Depends(get_db)):
    blocks = db.query(models.SeasonBlock).order_by(models.SeasonBlock.date_from).all()
    today = date.today()
    result = []
    for b in blocks:
        # Calculate week number within block and total weeks
        total_days = (b.date_to - b.date_from).days + 1
        total_weeks = max(1, round(total_days / 7))
        days_in = max(0, (today - b.date_from).days)
        week_in = min(total_weeks, days_in // 7 + 1) if b.date_from <= today <= b.date_to else None
        is_current = b.date_from <= today <= b.date_to
        is_past = b.date_to < today
        result.append({
            "id": b.id, "name": b.name, "phase_type": b.phase_type,
            "date_from": b.date_from.isoformat(), "date_to": b.date_to.isoformat(),
            "emphasis": b.emphasis, "notes": b.notes, "created_at": b.created_at,
            "is_current": is_current, "is_past": is_past,
            "week_in": week_in, "total_weeks": total_weeks,
            "colour": PHASE_COLOURS.get(b.phase_type or '', 'pool'),
        })
    return result

@router.post("/blocks", status_code=201)
def create_block(data: BlockIn, db: Session = Depends(get_db)):
    block = models.SeasonBlock(**data.model_dump())
    db.add(block)
    db.commit()
    db.refresh(block)
    return block

@router.patch("/blocks/{block_id}")
def update_block(block_id: int, data: dict, db: Session = Depends(get_db)):
    block = db.query(models.SeasonBlock).filter(models.SeasonBlock.id == block_id).first()
    if not block:
        raise HTTPException(404, "Block not found")
    for k, v in data.items():
        if hasattr(block, k):
            setattr(block, k, v)
    db.commit()
    db.refresh(block)
    return block

@router.delete("/blocks/{block_id}", status_code=204)
def delete_block(block_id: int, db: Session = Depends(get_db)):
    block = db.query(models.SeasonBlock).filter(models.SeasonBlock.id == block_id).first()
    if not block:
        raise HTTPException(404, "Block not found")
    db.delete(block)
    db.commit()

@router.get("/summary")
def get_season_summary(db: Session = Depends(get_db)):
    """
    Current block + upcoming meets + actual vs planned energy system distribution
    + active coaching intents per swimmer in current block period.
    """
    today = date.today()

    # Current block
    current_block = db.query(models.SeasonBlock).filter(
        models.SeasonBlock.date_from <= today,
        models.SeasonBlock.date_to >= today,
    ).first()

    # Next block
    next_block = db.query(models.SeasonBlock).filter(
        models.SeasonBlock.date_from > today,
    ).order_by(models.SeasonBlock.date_from).first()

    # Upcoming meets (next 10 weeks)
    upcoming_meets = db.query(models.Meet).filter(
        models.Meet.date >= today,
        models.Meet.date <= today + timedelta(weeks=10),
    ).order_by(models.Meet.date).limit(8).all()

    meets_out = []
    for m in upcoming_meets:
        target_count = db.query(models.MeetTarget).filter(models.MeetTarget.meet_id == m.id).count()
        a_count = db.query(models.MeetTarget).filter(models.MeetTarget.meet_id == m.id, models.MeetTarget.priority == 'A').count()
        meets_out.append({
            "id": m.id, "name": m.name,
            "date": m.date.isoformat() if m.date else None,
            "date_to": m.date_to.isoformat() if m.date_to else None,
            "course": m.course, "level": m.level,
            "target_count": target_count, "a_count": a_count,
        })

    # Actual energy system distribution over current block period (or last 4 weeks if no block)
    period_from = current_block.date_from if current_block else today - timedelta(weeks=4)
    sessions = db.query(models.Session).filter(
        models.Session.date >= period_from,
        models.Session.date <= today,
        models.Session.status != 'cancelled',
        models.Session.energy_system_focus.isnot(None),
    ).all()
    actual_dist = {}
    for s in sessions:
        f = s.energy_system_focus
        actual_dist[f] = actual_dist.get(f, 0) + 1

    # Gap analysis vs planned emphasis
    gap_analysis = []
    if current_block and current_block.emphasis and actual_dist:
        total_sessions = sum(actual_dist.values())
        for focus, planned_pct in current_block.emphasis.items():
            actual_count = actual_dist.get(focus, 0)
            actual_pct = round(actual_count / total_sessions * 100) if total_sessions else 0
            diff = actual_pct - planned_pct
            if abs(diff) >= 10:  # only flag meaningful gaps
                gap_analysis.append({
                    "focus": focus,
                    "planned": planned_pct,
                    "actual": actual_pct,
                    "diff": diff,
                })

    # Active coaching intents (last 30 days or within current block)
    intent_from = current_block.date_from if current_block else today - timedelta(days=30)
    intents = db.query(models.SwimmerObservation).filter(
        models.SwimmerObservation.obs_type == 'coaching_intent',
        models.SwimmerObservation.date >= intent_from,
    ).order_by(models.SwimmerObservation.date.desc()).limit(15).all()

    intents_out = []
    for i in intents:
        swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == i.swimmer_id).first()
        intents_out.append({
            "swimmer_name": swimmer.name if swimmer else "?",
            "content": i.content,
            "date": i.date.isoformat() if i.date else None,
        })

    return {
        "current_block": {
            "id": current_block.id, "name": current_block.name,
            "phase_type": current_block.phase_type,
            "date_from": current_block.date_from.isoformat(),
            "date_to": current_block.date_to.isoformat(),
            "emphasis": current_block.emphasis,
            "notes": current_block.notes,
        } if current_block else None,
        "next_block": {
            "id": next_block.id, "name": next_block.name,
            "date_from": next_block.date_from.isoformat(),
            "phase_type": next_block.phase_type,
        } if next_block else None,
        "upcoming_meets": meets_out,
        "actual_distribution": actual_dist,
        "sessions_analysed": len(sessions),
        "gap_analysis": gap_analysis,
        "active_intents": intents_out,
    }
