from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from typing import Optional
from datetime import date, timedelta
from collections import defaultdict
import json, os

from backend.database import get_db
from backend import models
from backend.services.cycle_codes import (
    code_for,
    ensure_cycle_sequences,
    materialize_microcycle,
    next_block_sequence,
    next_macro_sequence,
    next_micro_sequence,
)

router = APIRouter()

PHASE_COLOURS = {
    'base': 'blue', 'build': 'green', 'peak': 'orange',
    'taper': 'yellow', 'competition': 'red', 'recovery': 'teal', 'transition': 'pool',
}

VOLUME_KEYS = ['aerobic', 'threshold', 'vo2', 'race_pace', 'lact_tol', 'short_race_pace', 'kicking', 'sprint']

class BlockIn(BaseModel):
    macro_id: Optional[int] = None
    sequence_index: Optional[int] = Field(default=None, ge=1)
    name: str
    squad: Optional[str] = None
    phase_type: Optional[str] = None
    date_from: date
    date_to: date
    emphasis: Optional[dict] = None
    group_intents: Optional[dict] = None
    notes: Optional[str] = None


class BlockUpdate(BaseModel):
    macro_id: Optional[int] = None
    sequence_index: Optional[int] = Field(default=None, ge=1)
    name: Optional[str] = None
    squad: Optional[str] = None
    phase_type: Optional[str] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    emphasis: Optional[dict] = None
    group_intents: Optional[dict] = None
    notes: Optional[str] = None


class MacroIn(BaseModel):
    season_id: Optional[int] = None
    primary_meet_id: Optional[int] = None
    sequence_index: int = Field(default=0, ge=0)
    name: str
    squad: Optional[str] = None
    date_from: date
    date_to: date
    narrative: Optional[str] = None
    group_definitions: Optional[dict] = None
    mesos: list[BlockIn] = Field(default_factory=list)


class MacroUpdate(BaseModel):
    season_id: Optional[int] = None
    primary_meet_id: Optional[int] = None
    sequence_index: Optional[int] = Field(default=None, ge=1)
    name: Optional[str] = None
    squad: Optional[str] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    narrative: Optional[str] = None
    group_definitions: Optional[dict] = None


class MicrocycleIn(BaseModel):
    macro_id: Optional[int] = None
    block_id: Optional[int] = None
    sequence_index: Optional[int] = Field(default=None, ge=1)
    squad: Optional[str] = None
    week_start: date
    week_end: Optional[date] = None
    label: str
    meso_position_note: Optional[str] = None
    progression_note: Optional[str] = None
    recovery_placement: Optional[str] = None
    next_week_direction: Optional[str] = None
    coach_flags: list = Field(default_factory=list)
    sessions: list = Field(default_factory=list)
    status: str = "draft"
    notes: Optional[str] = None


class MicrocycleUpdate(BaseModel):
    macro_id: Optional[int] = None
    block_id: Optional[int] = None
    sequence_index: Optional[int] = Field(default=None, ge=1)
    squad: Optional[str] = None
    week_start: Optional[date] = None
    week_end: Optional[date] = None
    label: Optional[str] = None
    meso_position_note: Optional[str] = None
    progression_note: Optional[str] = None
    recovery_placement: Optional[str] = None
    next_week_direction: Optional[str] = None
    coach_flags: Optional[list] = None
    sessions: Optional[list] = None
    status: Optional[str] = None
    notes: Optional[str] = None


def _ensure_date_order(date_from: date, date_to: date, label: str):
    if date_to < date_from:
        raise HTTPException(422, f"{label} end date must be on or after its start date")

def _block_out(b: models.SeasonBlock, today: date) -> dict:
    total_days = (b.date_to - b.date_from).days + 1
    total_weeks = max(1, round(total_days / 7))
    days_in = max(0, (today - b.date_from).days)
    week_in = min(total_weeks, days_in // 7 + 1) if b.date_from <= today <= b.date_to else None
    return {
        "id": b.id, "macro_id": b.macro_id, "sequence_index": b.sequence_index,
        "cycle_prefix": (
            f"{b.macro.sequence_index}.{b.sequence_index}"
            if b.macro and b.macro.sequence_index and b.sequence_index else None
        ),
        "name": b.name, "squad": b.squad, "phase_type": b.phase_type,
        "date_from": b.date_from.isoformat(), "date_to": b.date_to.isoformat(),
        "emphasis": b.emphasis, "group_intents": b.group_intents, "notes": b.notes,
        "created_at": b.created_at,
        "is_current": b.date_from <= today <= b.date_to,
        "is_past": b.date_to < today,
        "week_in": week_in, "total_weeks": total_weeks,
        "colour": PHASE_COLOURS.get(b.phase_type or '', 'pool'),
    }


def _micro_out(m: models.Microcycle) -> dict:
    sessions = []
    for index, raw in enumerate(m.sessions or [], 1):
        if not isinstance(raw, dict):
            sessions.append(raw)
            continue
        item = dict(raw)
        item.setdefault("cycle_code", code_for(m, index))
        sessions.append(item)
    return {
        "id": m.id, "macro_id": m.macro_id, "block_id": m.block_id,
        "sequence_index": m.sequence_index,
        "cycle_prefix": code_for(m, 1).rsplit(".", 1)[0] if code_for(m, 1) else None,
        "squad": m.squad, "week_start": m.week_start.isoformat(),
        "week_end": m.week_end.isoformat(), "label": m.label,
        "meso_position_note": m.meso_position_note,
        "progression_note": m.progression_note,
        "recovery_placement": m.recovery_placement,
        "next_week_direction": m.next_week_direction,
        "coach_flags": m.coach_flags or [], "sessions": sessions,
        "status": m.status, "notes": m.notes, "created_at": m.created_at,
    }


# ---------------------------------------------------------------------------
# Macros
# ---------------------------------------------------------------------------

@router.get("/macros")
def get_macros(db: Session = Depends(get_db)):
    if ensure_cycle_sequences(db):
        db.commit()
    today = date.today()
    macros = db.query(models.TrainingMacro).order_by(models.TrainingMacro.date_from).all()
    result = []
    for m in macros:
        mesos = db.query(models.SeasonBlock).filter(models.SeasonBlock.macro_id == m.id).order_by(models.SeasonBlock.date_from).all()
        result.append({
            "id": m.id, "season_id": m.season_id, "primary_meet_id": m.primary_meet_id,
            "sequence_index": m.sequence_index, "cycle_prefix": str(m.sequence_index),
            "name": m.name, "squad": m.squad,
            "date_from": m.date_from.isoformat(), "date_to": m.date_to.isoformat(),
            "narrative": m.narrative, "group_definitions": m.group_definitions,
            "created_at": m.created_at,
            "is_current": m.date_from <= today <= m.date_to,
            "is_past": m.date_to < today,
            "mesos": [_block_out(b, today) for b in mesos],
        })
    return result


@router.post("/macros", status_code=201)
def create_macro(data: MacroIn, db: Session = Depends(get_db)):
    _ensure_date_order(data.date_from, data.date_to, "Macro")
    macro = models.TrainingMacro(
        season_id=data.season_id,
        primary_meet_id=data.primary_meet_id,
        sequence_index=(data.sequence_index if data.sequence_index > 0 else next_macro_sequence(db, data.season_id, data.squad)),
        name=data.name,
        squad=data.squad,
        date_from=data.date_from,
        date_to=data.date_to,
        narrative=data.narrative,
        group_definitions=data.group_definitions,
    )
    db.add(macro)
    db.flush()

    for meso_index, meso_data in enumerate(data.mesos, 1):
        _ensure_date_order(meso_data.date_from, meso_data.date_to, "Meso")
        meso = models.SeasonBlock(
            macro_id=macro.id,
            sequence_index=meso_data.sequence_index or meso_index,
            name=meso_data.name,
            squad=meso_data.squad or data.squad,
            phase_type=meso_data.phase_type,
            date_from=meso_data.date_from,
            date_to=meso_data.date_to,
            emphasis=meso_data.emphasis,
            group_intents=meso_data.group_intents,
            notes=meso_data.notes,
        )
        db.add(meso)

    db.commit()
    db.refresh(macro)
    today = date.today()
    mesos = db.query(models.SeasonBlock).filter(models.SeasonBlock.macro_id == macro.id).all()
    return {
        "id": macro.id, "season_id": macro.season_id, "primary_meet_id": macro.primary_meet_id,
        "sequence_index": macro.sequence_index, "cycle_prefix": str(macro.sequence_index),
        "name": macro.name, "squad": macro.squad,
        "date_from": macro.date_from.isoformat(), "date_to": macro.date_to.isoformat(),
        "narrative": macro.narrative, "group_definitions": macro.group_definitions,
        "mesos": [_block_out(b, today) for b in mesos],
    }


@router.patch("/macros/{macro_id}")
def update_macro(macro_id: int, data: MacroUpdate, db: Session = Depends(get_db)):
    macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == macro_id).first()
    if not macro:
        raise HTTPException(404, "Macro not found")
    changes = data.model_dump(exclude_unset=True)
    next_from = changes.get("date_from", macro.date_from)
    next_to = changes.get("date_to", macro.date_to)
    _ensure_date_order(next_from, next_to, "Macro")
    for k, v in changes.items():
        setattr(macro, k, v)
    db.commit()
    db.refresh(macro)
    return macro


@router.delete("/macros/{macro_id}", status_code=204)
def delete_macro(macro_id: int, db: Session = Depends(get_db)):
    macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == macro_id).first()
    if not macro:
        raise HTTPException(404, "Macro not found")
    db.delete(macro)
    db.commit()


# ---------------------------------------------------------------------------
# Blocks (mesos)
# ---------------------------------------------------------------------------

@router.get("/blocks")
def get_blocks(db: Session = Depends(get_db)):
    if ensure_cycle_sequences(db):
        db.commit()
    blocks = db.query(models.SeasonBlock).order_by(models.SeasonBlock.date_from).all()
    today = date.today()
    return [_block_out(b, today) for b in blocks]

@router.post("/blocks", status_code=201)
def create_block(data: BlockIn, db: Session = Depends(get_db)):
    _ensure_date_order(data.date_from, data.date_to, "Meso")
    payload = data.model_dump()
    payload["sequence_index"] = data.sequence_index or next_block_sequence(db, data.macro_id)
    block = models.SeasonBlock(**payload)
    db.add(block)
    db.commit()
    db.refresh(block)
    return block

@router.patch("/blocks/{block_id}")
def update_block(block_id: int, data: BlockUpdate, db: Session = Depends(get_db)):
    block = db.query(models.SeasonBlock).filter(models.SeasonBlock.id == block_id).first()
    if not block:
        raise HTTPException(404, "Block not found")
    changes = data.model_dump(exclude_unset=True)
    next_from = changes.get("date_from", block.date_from)
    next_to = changes.get("date_to", block.date_to)
    _ensure_date_order(next_from, next_to, "Meso")
    for k, v in changes.items():
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


# ---------------------------------------------------------------------------
# Microcycles (weekly plans)
# ---------------------------------------------------------------------------

@router.get("/microcycles")
def get_microcycles(
    macro_id: Optional[int] = None,
    block_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    db: Session = Depends(get_db),
):
    if ensure_cycle_sequences(db):
        db.commit()
    q = db.query(models.Microcycle)
    if macro_id is not None:
        q = q.filter(models.Microcycle.macro_id == macro_id)
    if block_id is not None:
        q = q.filter(models.Microcycle.block_id == block_id)
    if date_from is not None:
        q = q.filter(models.Microcycle.week_end >= date_from)
    if date_to is not None:
        q = q.filter(models.Microcycle.week_start <= date_to)
    return [_micro_out(m) for m in q.order_by(models.Microcycle.week_start).all()]


@router.post("/microcycles", status_code=201)
def create_microcycle(data: MicrocycleIn, db: Session = Depends(get_db)):
    week_end = data.week_end or data.week_start + timedelta(days=6)
    _ensure_date_order(data.week_start, week_end, "Microcycle")
    duplicate = db.query(models.Microcycle).filter(
        models.Microcycle.block_id == data.block_id,
        models.Microcycle.week_start == data.week_start,
    ).first()
    if duplicate:
        raise HTTPException(409, "A microcycle already exists for this block and week")
    if data.block_id is not None:
        block = db.query(models.SeasonBlock).filter(models.SeasonBlock.id == data.block_id).first()
        if not block:
            raise HTTPException(404, "Meso block not found")
        if data.week_start > block.date_to or week_end < block.date_from:
            raise HTTPException(422, "Microcycle must overlap its meso block")
    payload = data.model_dump(exclude={"week_end"})
    payload["sequence_index"] = data.sequence_index or next_micro_sequence(db, data.block_id)
    micro = models.Microcycle(**payload, week_end=week_end)
    db.add(micro)
    db.flush()
    if micro.status in {"confirmed", "completed"}:
        materialize_microcycle(micro, db)
    db.commit()
    db.refresh(micro)
    return _micro_out(micro)


@router.patch("/microcycles/{micro_id}")
def update_microcycle(micro_id: int, data: MicrocycleUpdate, db: Session = Depends(get_db)):
    micro = db.query(models.Microcycle).filter(models.Microcycle.id == micro_id).first()
    if not micro:
        raise HTTPException(404, "Microcycle not found")
    changes = data.model_dump(exclude_unset=True)
    next_start = changes.get("week_start", micro.week_start)
    next_end = changes.get("week_end", micro.week_end)
    _ensure_date_order(next_start, next_end, "Microcycle")
    for key, value in changes.items():
        setattr(micro, key, value)
    if micro.status in {"confirmed", "completed"} and ({"status", "sessions"} & set(changes)):
        materialize_microcycle(micro, db)
    db.commit()
    db.refresh(micro)
    return _micro_out(micro)


@router.delete("/microcycles/{micro_id}", status_code=204)
def delete_microcycle(micro_id: int, db: Session = Depends(get_db)):
    micro = db.query(models.Microcycle).filter(models.Microcycle.id == micro_id).first()
    if not micro:
        raise HTTPException(404, "Microcycle not found")
    db.delete(micro)
    db.commit()


@router.get("/blocks/{block_id}/progress")
def get_block_progress(block_id: int, db: Session = Depends(get_db)):
    """Week-by-week SwimmerSessionLoad aggregation for all swimmers in the block date range."""
    block = db.query(models.SeasonBlock).filter(models.SeasonBlock.id == block_id).first()
    if not block:
        raise HTTPException(404, "Block not found")

    q = db.query(models.Session).filter(
        models.Session.date >= block.date_from,
        models.Session.date <= block.date_to,
        models.Session.status != 'cancelled',
    )
    if block.squad:
        q = q.filter(models.Session.squad == block.squad)
    session_ids = [s.id for s in q.all()]

    if not session_ids:
        return {"weeks": [], "swimmers": [], "group_intents": block.group_intents or {}}

    loads = db.query(models.SwimmerSessionLoad).filter(
        models.SwimmerSessionLoad.session_id.in_(session_ids)
    ).all()

    def iso_week(d):
        yr, wk, _ = d.isocalendar()
        return f"{yr}-W{wk:02d}"

    # Build ordered week list across block range
    all_weeks, seen = [], set()
    d = block.date_from
    while d <= block.date_to:
        lbl = iso_week(d)
        if lbl not in seen:
            all_weeks.append(lbl)
            seen.add(lbl)
        d += timedelta(days=7)

    swimmer_weeks: dict = defaultdict(lambda: defaultdict(lambda: {k: 0 for k in VOLUME_KEYS}))
    swimmer_ids_seen = set()

    for load in loads:
        wk = iso_week(load.session_date)
        swimmer_ids_seen.add(load.swimmer_id)
        for k in VOLUME_KEYS:
            swimmer_weeks[load.swimmer_id][wk][k] += (load.volume_breakdown or {}).get(k, 0)

    swimmers = db.query(models.Swimmer).filter(
        models.Swimmer.id.in_(swimmer_ids_seen)
    ).order_by(models.Swimmer.name).all()

    result = []
    for s in swimmers:
        weeks_out = []
        for wk in all_weeks:
            vols = dict(swimmer_weeks[s.id].get(wk, {k: 0 for k in VOLUME_KEYS}))
            weeks_out.append({"week": wk, "volumes": vols, "total": sum(vols.values())})
        result.append({"id": s.id, "name": s.name, "squad": s.squad, "weeks": weeks_out})

    return {"weeks": all_weeks, "swimmers": result, "group_intents": block.group_intents or {}}


@router.post("/blocks/{block_id}/ai-analysis")
def analyse_block(block_id: int, db: Session = Depends(get_db)):
    """Block review skill — phase delivery, group analysis, attendance, adaptation signals, next block recommendation."""
    try:
        from backend.routers.skills import run_block_review
        result = run_block_review(block_id, db)
        return {"analysis": result["analysis"]}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Block review failed: {str(e)}")

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
            "timetable_session_count": db.query(models.MeetSession).filter(models.MeetSession.meet_id == m.id).count(),
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
