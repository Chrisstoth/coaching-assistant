import io
from datetime import date, datetime
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Body, UploadFile, File
from pydantic import BaseModel
import pandas as pd
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models
from backend.services import claude_service
from backend.services.importer import match_or_create_swimmer

router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class SwimmerCreate(BaseModel):
    name: str
    dob: Optional[date] = None
    gender: Optional[str] = None
    squad: Optional[str] = None
    active: bool = True
    status: str = "active"  # active / sabbatical / injury
    swimrankings_id: Optional[str] = None
    # target_events: [{"event": "100 Freestyle", "course": "SCM|LCM|Both"}, ...]
    target_events: Optional[list[dict]] = []
    course_bias: Optional[str] = None
    strengths: Optional[str] = None
    weaknesses: Optional[str] = None
    profile_notes: Optional[str] = None
    historical_background: Optional[str] = None


class SwimmerUpdate(BaseModel):
    name: Optional[str] = None
    dob: Optional[date] = None
    gender: Optional[str] = None
    squad: Optional[str] = None
    active: Optional[bool] = None
    status: Optional[str] = None  # active / sabbatical / injury
    target_events: Optional[list[dict]] = None
    course_bias: Optional[str] = None
    strengths: Optional[str] = None
    weaknesses: Optional[str] = None
    profile_notes: Optional[str] = None


class ProfileChatMessage(BaseModel):
    message: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
def list_swimmers(
    squad: Optional[str] = None,
    active_only: bool = True,
    db: DBSession = Depends(get_db),
):
    q = db.query(models.Swimmer)
    if active_only:
        q = q.filter(models.Swimmer.active == True)
    if squad:
        q = q.filter(models.Swimmer.squad == squad)
    swimmers = q.order_by(models.Swimmer.name).all()
    return [_swimmer_summary(s) for s in swimmers]


@router.post("", status_code=201)
def create_swimmer(body: SwimmerCreate, db: DBSession = Depends(get_db)):
    swimmer = models.Swimmer(
        name=body.name,
        dob=body.dob,
        gender=body.gender,
        squad=body.squad,
        active=body.active,
        swimrankings_id=body.swimrankings_id,
        target_events=body.target_events or [],
        strengths=body.strengths,
        weaknesses=body.weaknesses,
        profile_notes=body.profile_notes,
    )
    db.add(swimmer)
    db.commit()
    db.refresh(swimmer)

    narrative = None
    if body.historical_background:
        narrative = claude_service.build_historical_narrative(
            swimmer, body.historical_background, db
        )

    result = _swimmer_detail(swimmer, db)
    if narrative:
        result["training_history_narrative"] = narrative
    return result


@router.get("/{swimmer_id}")
def get_swimmer(swimmer_id: int, db: DBSession = Depends(get_db)):
    swimmer = _get_or_404(swimmer_id, db)
    return _swimmer_detail(swimmer, db)


@router.put("/{swimmer_id}")
def update_swimmer(swimmer_id: int, body: SwimmerUpdate, db: DBSession = Depends(get_db)):
    swimmer = _get_or_404(swimmer_id, db)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(swimmer, field, value)
    db.commit()
    db.refresh(swimmer)
    return _swimmer_detail(swimmer, db)


@router.delete("/{swimmer_id}", status_code=204)
def delete_swimmer(swimmer_id: int, db: DBSession = Depends(get_db)):
    swimmer = _get_or_404(swimmer_id, db)
    _cascade_delete_swimmer(swimmer_id, db)
    db.delete(swimmer)
    db.commit()


@router.post("/bulk-delete", status_code=200)
def bulk_delete_swimmers(body: dict = Body(...), db: DBSession = Depends(get_db)):
    """Delete multiple swimmers by ID with full cascade."""
    ids = body.get("ids", [])
    if not ids:
        return {"deleted": 0}
    deleted = 0
    for swimmer_id in ids:
        swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
        if swimmer:
            _cascade_delete_swimmer(swimmer_id, db)
            db.delete(swimmer)
            deleted += 1
    db.commit()
    return {"deleted": deleted}


def _cascade_delete_swimmer(swimmer_id: int, db: DBSession):
    """Delete all child records for a swimmer before deleting the swimmer row."""
    db.query(models.SwimTime).filter(models.SwimTime.swimmer_id == swimmer_id).delete()
    db.query(models.SessionEntry).filter(models.SessionEntry.swimmer_id == swimmer_id).delete()
    db.query(models.MeetTarget).filter(models.MeetTarget.swimmer_id == swimmer_id).delete()
    db.query(models.SwimmerSlot).filter(models.SwimmerSlot.swimmer_id == swimmer_id).delete()
    db.query(models.SwimmerException).filter(models.SwimmerException.swimmer_id == swimmer_id).delete()
    db.query(models.Schedule).filter(models.Schedule.swimmer_id == swimmer_id).delete()
    db.query(models.PeriodizationPlan).filter(models.PeriodizationPlan.swimmer_id == swimmer_id).delete()
    db.query(models.SwimmerObservation).filter(models.SwimmerObservation.swimmer_id == swimmer_id).delete()
    db.query(models.SwimmerLoadEvent).filter(models.SwimmerLoadEvent.swimmer_id == swimmer_id).delete()
    db.query(models.SwimmerProfileVersion).filter(models.SwimmerProfileVersion.swimmer_id == swimmer_id).delete()
    db.query(models.TrainingHistoryNarrative).filter(models.TrainingHistoryNarrative.swimmer_id == swimmer_id).delete()
    db.query(models.AIAnalysis).filter(models.AIAnalysis.swimmer_id == swimmer_id).delete()
    db.query(models.ProfileConversation).filter(models.ProfileConversation.swimmer_id == swimmer_id).delete()


# ---------------------------------------------------------------------------
# Profile chat
# ---------------------------------------------------------------------------

@router.post("/{swimmer_id}/profile/chat")
def profile_chat(swimmer_id: int, body: ProfileChatMessage, db: DBSession = Depends(get_db)):
    swimmer = _get_or_404(swimmer_id, db)
    reply = claude_service.profile_chat(swimmer, body.message, db)
    return {"reply": reply}


@router.post("/{swimmer_id}/profile/synthesise")
def synthesise_profile(swimmer_id: int, db: DBSession = Depends(get_db)):
    swimmer = _get_or_404(swimmer_id, db)
    profile = claude_service.synthesise_profile(swimmer, db)
    return {"physical": profile.get("physical"), "psychological": profile.get("psychological")}


@router.get("/{swimmer_id}/profile/conversation")
def get_conversation(swimmer_id: int, db: DBSession = Depends(get_db)):
    swimmer = _get_or_404(swimmer_id, db)
    history = (
        db.query(models.ProfileConversation)
        .filter(models.ProfileConversation.swimmer_id == swimmer.id)
        .order_by(models.ProfileConversation.created_at.asc())
        .all()
    )
    return [{"role": e.role, "message": e.message, "created_at": e.created_at} for e in history]


# ---------------------------------------------------------------------------
# Schedule
# ---------------------------------------------------------------------------

class ScheduleEntry(BaseModel):
    day_of_week: Optional[int] = None
    session_time: Optional[str] = None
    status: str = "regular"
    notes: Optional[str] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None


@router.post("/{swimmer_id}/schedule", status_code=201)
def add_schedule(swimmer_id: int, body: ScheduleEntry, db: DBSession = Depends(get_db)):
    swimmer = _get_or_404(swimmer_id, db)
    entry = models.Schedule(swimmer_id=swimmer.id, **body.model_dump())
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return {"id": entry.id}


@router.get("/{swimmer_id}/schedule")
def get_schedule(swimmer_id: int, db: DBSession = Depends(get_db)):
    _get_or_404(swimmer_id, db)
    entries = db.query(models.Schedule).filter(models.Schedule.swimmer_id == swimmer_id).all()
    return [
        {
            "id": e.id,
            "day_of_week": e.day_of_week,
            "session_time": e.session_time,
            "status": e.status,
            "notes": e.notes,
            "date_from": e.date_from,
            "date_to": e.date_to,
        }
        for e in entries
    ]


# ---------------------------------------------------------------------------
# Observations
# ---------------------------------------------------------------------------

OBS_TYPES = ["race", "aerobic", "threshold", "vo2", "speed", "recovery", "physical", "general"]


class ObservationCreate(BaseModel):
    obs_type: str
    date: Optional[date] = None
    event: Optional[str] = None
    energy_zone: Optional[str] = None
    content: str
    structured: Optional[dict] = None
    session_id: Optional[int] = None


@router.get("/{swimmer_id}/observations")
def get_observations(
    swimmer_id: int,
    obs_type: Optional[str] = None,
    limit: int = 50,
    db: DBSession = Depends(get_db),
):
    _get_or_404(swimmer_id, db)
    q = (
        db.query(models.SwimmerObservation)
        .filter(models.SwimmerObservation.swimmer_id == swimmer_id)
    )
    if obs_type:
        q = q.filter(models.SwimmerObservation.obs_type == obs_type)
    obs = q.order_by(models.SwimmerObservation.date.desc(), models.SwimmerObservation.created_at.desc()).limit(limit).all()
    return [_obs_out(o) for o in obs]


@router.post("/{swimmer_id}/observations", status_code=201)
def add_observation(swimmer_id: int, body: ObservationCreate, db: DBSession = Depends(get_db)):
    _get_or_404(swimmer_id, db)
    obs = models.SwimmerObservation(swimmer_id=swimmer_id, **body.model_dump())
    db.add(obs)
    db.commit()
    db.refresh(obs)
    return _obs_out(obs)


@router.delete("/{swimmer_id}/observations/{obs_id}", status_code=204)
def delete_observation(swimmer_id: int, obs_id: int, db: DBSession = Depends(get_db)):
    obs = db.query(models.SwimmerObservation).filter(
        models.SwimmerObservation.id == obs_id,
        models.SwimmerObservation.swimmer_id == swimmer_id,
    ).first()
    if not obs:
        raise HTTPException(status_code=404, detail="Observation not found")
    db.delete(obs)
    db.commit()


# ---------------------------------------------------------------------------
# Racing narrative
# ---------------------------------------------------------------------------

@router.get("/{swimmer_id}/racing-narrative")
def get_racing_narrative(swimmer_id: int, db: DBSession = Depends(get_db)):
    _get_or_404(swimmer_id, db)
    narrative = (
        db.query(models.TrainingHistoryNarrative)
        .filter(
            models.TrainingHistoryNarrative.swimmer_id == swimmer_id,
            models.TrainingHistoryNarrative.source == "racing",
        )
        .order_by(models.TrainingHistoryNarrative.created_at.desc())
        .first()
    )
    return {"narrative": narrative.narrative if narrative else ""}


@router.post("/{swimmer_id}/racing-narrative")
def save_racing_narrative(swimmer_id: int, body: dict = Body(...), db: DBSession = Depends(get_db)):
    """Replace the swimmer's racing narrative (single living document)."""
    _get_or_404(swimmer_id, db)
    text = (body.get("narrative") or "").strip()
    db.query(models.TrainingHistoryNarrative).filter(
        models.TrainingHistoryNarrative.swimmer_id == swimmer_id,
        models.TrainingHistoryNarrative.source == "racing",
    ).delete()
    if text:
        db.add(models.TrainingHistoryNarrative(
            swimmer_id=swimmer_id,
            narrative=text,
            source="racing",
        ))
    db.commit()
    return {"narrative": text}


@router.post("/{swimmer_id}/profile/race/synthesise")
def synthesise_race_profile(swimmer_id: int, body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    """Synthesise a new versioned race profile from race observations + times."""
    swimmer = _get_or_404(swimmer_id, db)
    return claude_service.synthesise_race_profile(swimmer, db, conversation_context=body.get("conversation_context"))


@router.post("/{swimmer_id}/profile/training/synthesise")
def synthesise_training_profile(swimmer_id: int, body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    """Synthesise a new versioned training response profile from training observations."""
    swimmer = _get_or_404(swimmer_id, db)
    return claude_service.synthesise_training_profile(swimmer, db, conversation_context=body.get("conversation_context"))


@router.get("/{swimmer_id}/profile/race")
def get_race_profiles(swimmer_id: int, db: DBSession = Depends(get_db)):
    """Return all versioned race profiles, newest first."""
    _get_or_404(swimmer_id, db)
    versions = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer_id,
            models.SwimmerProfileVersion.profile_type == "race",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .all()
    )
    return [_profile_version_out(v) for v in versions]


@router.get("/{swimmer_id}/profile/training")
def get_training_profiles(swimmer_id: int, db: DBSession = Depends(get_db)):
    """Return all versioned training profiles, newest first."""
    _get_or_404(swimmer_id, db)
    versions = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer_id,
            models.SwimmerProfileVersion.profile_type == "training",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .all()
    )
    return [_profile_version_out(v) for v in versions]


@router.post("/{swimmer_id}/profile/biological/synthesise")
def synthesise_biological_profile(swimmer_id: int, body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    """Synthesise a new versioned biological profile from all available data."""
    swimmer = _get_or_404(swimmer_id, db)
    conversation_context = body.get("conversation_context")
    obs_count = db.query(models.SwimmerObservation).filter(
        models.SwimmerObservation.swimmer_id == swimmer_id
    ).count()
    times_count = db.query(models.SwimTime).filter(
        models.SwimTime.swimmer_id == swimmer_id
    ).count()
    has_profile_notes = bool(swimmer.profile_notes or swimmer.physical_profile or swimmer.psychological_profile)
    if obs_count == 0 and times_count == 0 and not has_profile_notes and not conversation_context:
        raise HTTPException(
            status_code=422,
            detail="Not enough data to build a biological profile. Add some observations or import race times first."
        )
    return claude_service.synthesise_biological_profile(swimmer, db, conversation_context=conversation_context)


@router.post("/{swimmer_id}/profile/technical/synthesise")
def synthesise_technical_profile(swimmer_id: int, body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    """Synthesise a technical profile — stroke mechanics, race execution, coachability."""
    swimmer = _get_or_404(swimmer_id, db)
    return claude_service.synthesise_technical_profile(swimmer, db, conversation_context=body.get("conversation_context"))


@router.delete("/{swimmer_id}/profile/{profile_type}", status_code=204)
def delete_profile_versions(swimmer_id: int, profile_type: str, db: DBSession = Depends(get_db)):
    """Delete all versioned profiles of a given type for this swimmer."""
    _get_or_404(swimmer_id, db)
    db.query(models.SwimmerProfileVersion).filter(
        models.SwimmerProfileVersion.swimmer_id == swimmer_id,
        models.SwimmerProfileVersion.profile_type == profile_type,
    ).delete()
    db.commit()


@router.get("/{swimmer_id}/profile/technical")
def get_technical_profiles(swimmer_id: int, db: DBSession = Depends(get_db)):
    _get_or_404(swimmer_id, db)
    versions = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer_id,
            models.SwimmerProfileVersion.profile_type == "technical",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .all()
    )
    return [_profile_version_out(v) for v in versions]


@router.get("/{swimmer_id}/profile/biological")
def get_biological_profiles(swimmer_id: int, db: DBSession = Depends(get_db)):
    _get_or_404(swimmer_id, db)
    versions = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer_id,
            models.SwimmerProfileVersion.profile_type == "biological",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .all()
    )
    return [_profile_version_out(v) for v in versions]


@router.get("/{swimmer_id}/profile/performance/debug-prompt")
def debug_performance_prompt(swimmer_id: int, db: DBSession = Depends(get_db)):
    """Return the exact prompt that would be sent to Claude — without calling the API."""
    swimmer = _get_or_404(swimmer_id, db)
    prompt, _ = claude_service.build_performance_analysis_prompt(swimmer, db)
    return {"char_count": len(prompt), "approx_tokens": len(prompt) // 4, "prompt": prompt}


@router.post("/{swimmer_id}/profile/performance/synthesise")
def synthesise_performance_analysis(swimmer_id: int, db: DBSession = Depends(get_db)):
    """Analyse all race times to identify performance gains and training priorities."""
    swimmer = _get_or_404(swimmer_id, db)
    times_count = db.query(models.SwimTime).filter(
        models.SwimTime.swimmer_id == swimmer_id
    ).count()
    if times_count < 3:
        raise HTTPException(
            status_code=422,
            detail=f"Not enough times to analyse — only {times_count} recorded. Import at least 3 race times via the Import page first."
        )
    try:
        return claude_service.synthesise_performance_analysis(swimmer, db)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{swimmer_id}/profile/performance")
def get_performance_analyses(swimmer_id: int, db: DBSession = Depends(get_db)):
    _get_or_404(swimmer_id, db)
    versions = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer_id,
            models.SwimmerProfileVersion.profile_type == "performance_analysis",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .all()
    )
    return [_profile_version_out(v) for v in versions]


# ---------------------------------------------------------------------------
# Load events
# ---------------------------------------------------------------------------

LOAD_EVENT_TYPES = ["competition", "illness", "injury", "travel", "camp", "extra_load", "other"]


class LoadEventCreate(BaseModel):
    event_type: str
    date_from: date
    date_to: Optional[date] = None
    severity: int = 2          # 1=mild 2=moderate 3=significant
    description: Optional[str] = None
    resolved: bool = True


@router.get("/{swimmer_id}/load-events")
def get_load_events(swimmer_id: int, db: DBSession = Depends(get_db)):
    _get_or_404(swimmer_id, db)
    events = (
        db.query(models.SwimmerLoadEvent)
        .filter(models.SwimmerLoadEvent.swimmer_id == swimmer_id)
        .order_by(models.SwimmerLoadEvent.date_from.desc())
        .all()
    )
    return [_load_event_out(e) for e in events]


@router.post("/{swimmer_id}/load-events", status_code=201)
def add_load_event(swimmer_id: int, body: LoadEventCreate, db: DBSession = Depends(get_db)):
    _get_or_404(swimmer_id, db)
    event = models.SwimmerLoadEvent(swimmer_id=swimmer_id, **body.model_dump())
    db.add(event)
    db.commit()
    db.refresh(event)
    return _load_event_out(event)


@router.patch("/{swimmer_id}/load-events/{event_id}")
def update_load_event(swimmer_id: int, event_id: int, body: dict = Body(...), db: DBSession = Depends(get_db)):
    event = db.query(models.SwimmerLoadEvent).filter(
        models.SwimmerLoadEvent.id == event_id,
        models.SwimmerLoadEvent.swimmer_id == swimmer_id,
    ).first()
    if not event:
        raise HTTPException(status_code=404, detail="Load event not found")
    for field, value in body.items():
        if hasattr(event, field):
            setattr(event, field, value)
    db.commit()
    db.refresh(event)
    return _load_event_out(event)


@router.delete("/{swimmer_id}/load-events/{event_id}", status_code=204)
def delete_load_event(swimmer_id: int, event_id: int, db: DBSession = Depends(get_db)):
    event = db.query(models.SwimmerLoadEvent).filter(
        models.SwimmerLoadEvent.id == event_id,
        models.SwimmerLoadEvent.swimmer_id == swimmer_id,
    ).first()
    if not event:
        raise HTTPException(status_code=404, detail="Load event not found")
    db.delete(event)
    db.commit()


# ---------------------------------------------------------------------------
# Readiness assessment
# ---------------------------------------------------------------------------

@router.post("/{swimmer_id}/readiness")
def generate_readiness(swimmer_id: int, db: DBSession = Depends(get_db)):
    """Generate a current fatigue/readiness assessment for this swimmer."""
    import json as _json
    from datetime import timedelta
    swimmer = _get_or_404(swimmer_id, db)
    cutoff = datetime.utcnow() - timedelta(weeks=8)
    recent_entries = db.query(models.SessionEntry).filter(
        models.SessionEntry.swimmer_id == swimmer_id,
        models.SessionEntry.attended == True,
    ).join(models.Session).filter(models.Session.date >= cutoff.date()).count()
    load_events_count = db.query(models.SwimmerLoadEvent).filter(
        models.SwimmerLoadEvent.swimmer_id == swimmer_id
    ).count()
    if recent_entries == 0 and load_events_count == 0:
        raise HTTPException(
            status_code=422,
            detail="Not enough data to assess readiness. Register attendance in at least one session, or log a load event (competition, illness, etc.) in the Attendance tab."
        )
    assessment = claude_service.generate_readiness_assessment(swimmer, db)
    db.add(models.AIAnalysis(
        swimmer_id=swimmer.id,
        analysis_type="readiness",
        content=_json.dumps(assessment),
        model_used="claude-sonnet-4-6",
    ))
    db.commit()
    return assessment


@router.get("/{swimmer_id}/attendance-stats")
def get_attendance_stats(swimmer_id: int, db: DBSession = Depends(get_db)):
    """Attendance percentages — overall, last 4 weeks, per slot, and weekly breakdown."""
    _get_or_404(swimmer_id, db)
    return claude_service.build_attendance_stats(swimmer_id, db)


@router.get("/{swimmer_id}/context")
def get_swimmer_context(swimmer_id: int, db: DBSession = Depends(get_db)):
    """
    Return the assembled AI context for this swimmer — exactly what gets passed to Claude
    for any analysis, plus a breakdown of all contributing data points.
    """
    swimmer = _get_or_404(swimmer_id, db)

    # Build the context string
    assembled = claude_service.build_swimmer_context(swimmer, db)

    # Build the breakdown summary
    obs_all = (
        db.query(models.SwimmerObservation)
        .filter(models.SwimmerObservation.swimmer_id == swimmer_id)
        .all()
    )
    obs_by_type: dict = {}
    for o in obs_all:
        obs_by_type[o.obs_type] = obs_by_type.get(o.obs_type, 0) + 1

    race_versions = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer_id,
            models.SwimmerProfileVersion.profile_type == "race",
        )
        .count()
    )
    training_versions = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer_id,
            models.SwimmerProfileVersion.profile_type == "training",
        )
        .count()
    )
    times_count = (
        db.query(models.SwimTime)
        .filter(models.SwimTime.swimmer_id == swimmer_id)
        .count()
    )
    histories_count = (
        db.query(models.TrainingHistoryNarrative)
        .filter(models.TrainingHistoryNarrative.swimmer_id == swimmer_id)
        .count()
    )

    biological_versions = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer_id,
            models.SwimmerProfileVersion.profile_type == "biological",
        )
        .count()
    )
    breakdown = {
        "observations": {
            "total": len(obs_all),
            "by_type": obs_by_type,
        },
        "race_profile_versions": race_versions,
        "training_profile_versions": training_versions,
        "biological_profile_versions": biological_versions,
        "times": times_count,
        "training_histories": histories_count,
        "has_physical_profile": bool(swimmer.physical_profile),
        "has_psychological_profile": bool(swimmer.psychological_profile),
        "has_course_bias": bool(swimmer.course_bias),
        "target_event_count": len(swimmer.target_events or []),
    }

    return {"breakdown": breakdown, "assembled_context": assembled}


# ---------------------------------------------------------------------------
# Times summary
# ---------------------------------------------------------------------------

@router.get("/{swimmer_id}/times")
def get_swimmer_times(
    swimmer_id: int,
    event: Optional[str] = None,
    limit: int = 50,
    db: DBSession = Depends(get_db),
):
    _get_or_404(swimmer_id, db)
    q = db.query(models.SwimTime).filter(models.SwimTime.swimmer_id == swimmer_id)
    if event:
        q = q.filter(models.SwimTime.event == event)
    times = q.order_by(models.SwimTime.date.desc()).limit(limit).all()
    return [_format_time(t) for t in times]


# ---------------------------------------------------------------------------
# Roster CSV import
# ---------------------------------------------------------------------------

@router.post("/import/roster")
async def import_roster(file: UploadFile = File(...), db: DBSession = Depends(get_db)):
    """
    Bulk-create swimmers from a roster file.

    Accepts tab-separated or comma-separated files with these columns:
      ID, Swimmer Name, Date of Birth, Gender, Homeclub, Squad Start date

    ID maps to swimrankings_id so times imports will automatically link up.
    """
    content = await file.read()

    # Auto-detect separator (tab or comma)
    sample = content[:2000].decode("utf-8", errors="ignore")
    sep = "\t" if "\t" in sample else ","

    df = pd.read_csv(io.BytesIO(content), sep=sep)
    df.columns = [c.strip() for c in df.columns]

    # Normalise column names — support both the swimrankings format and a plain format
    col_map = {
        "ID": "swimrankings_id",
        "Swimmer Name": "name",
        "Date of Birth": "dob",
        "Gender": "gender",
        "Homeclub": "homeclub",
        "Squad Start date": "squad_start",
        # plain fallbacks
        "name": "name",
        "dob": "dob",
        "gender": "gender",
        "swimrankings_id": "swimrankings_id",
        "squad": "squad",
    }
    df = df.rename(columns={c: col_map[c] for c in df.columns if c in col_map})

    created, updated, errors = 0, 0, []

    for _, row in df.iterrows():
        name = str(row.get("name", "")).strip()
        if not name or name == "nan":
            continue
        try:
            swimmer = match_or_create_swimmer(
                name=name,
                swimrankings_id=row.get("swimrankings_id"),
                dob=row.get("dob"),
                gender=row.get("gender"),
                db=db,
            )
            is_new = swimmer.id is None

            # Homeclub is Y/blank — flag whether swimmer came through the club
            homeclub = str(row.get("homeclub", "")).strip().upper()
            if homeclub and homeclub != "NAN":
                is_home = homeclub in ("Y", "YES", "1", "TRUE")
                swimmer.profile_notes = f"Home club swimmer: {'Yes' if is_home else 'No'}"

            # squad_start stored in notes if no squad column
            squad_start = str(row.get("squad_start", "")).strip()
            if squad_start and squad_start != "nan":
                existing_notes = swimmer.profile_notes or ""
                if "Squad start:" not in existing_notes:
                    swimmer.profile_notes = (existing_notes + f"\nSquad start: {squad_start}").strip()

            # plain squad column if present
            squad_val = str(row.get("squad", "")).strip()
            if squad_val and squad_val != "nan":
                swimmer.squad = squad_val

            db.flush()
            if is_new:
                created += 1
            else:
                updated += 1
        except Exception as e:
            errors.append(f"{name}: {str(e)}")

    db.commit()
    return {"created": created, "updated": updated, "errors": errors}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_or_404(swimmer_id: int, db: DBSession) -> models.Swimmer:
    swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
    if not swimmer:
        raise HTTPException(status_code=404, detail="Swimmer not found")
    return swimmer


def _swimmer_summary(s: models.Swimmer) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "dob": s.dob,
        "age": models.get_age_at_dec31(s.dob),
        "age_group": models.get_age_group(s.dob),
        "school_year": models.get_school_year(s.dob),
        "squad": s.squad,
        "gender": s.gender,
        "active": s.active,
        "status": s.status,
        "target_events": s.target_events,
        "course_bias": s.course_bias,
        "has_profile": bool(s.physical_profile or s.psychological_profile),
    }


def _swimmer_detail(s: models.Swimmer, db: DBSession) -> dict:
    histories = (
        db.query(models.TrainingHistoryNarrative)
        .filter(models.TrainingHistoryNarrative.swimmer_id == s.id)
        .order_by(models.TrainingHistoryNarrative.created_at.desc())
        .all()
    )
    latest_race = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == s.id,
            models.SwimmerProfileVersion.profile_type == "race",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .first()
    )
    latest_training = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == s.id,
            models.SwimmerProfileVersion.profile_type == "training",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .first()
    )
    latest_biological = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == s.id,
            models.SwimmerProfileVersion.profile_type == "biological",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .first()
    )
    return {
        "id": s.id,
        "name": s.name,
        "dob": s.dob,
        "age_group": models.get_age_group(s.dob),
        "school_year": models.get_school_year(s.dob),
        "gender": s.gender,
        "squad": s.squad,
        "active": s.active,
        "status": s.status,
        "swimrankings_id": s.swimrankings_id,
        "target_events": s.target_events,
        "strengths": s.strengths,
        "weaknesses": s.weaknesses,
        "profile_notes": s.profile_notes,
        "physical_profile": s.physical_profile,
        "psychological_profile": s.psychological_profile,
        "training_histories": [
            {"narrative": h.narrative, "source": h.source, "created_at": h.created_at}
            for h in histories
        ],
        "course_bias": s.course_bias,
        "created_at": s.created_at,
        "latest_race_profile": _profile_version_out(latest_race) if latest_race else None,
        "latest_training_profile": _profile_version_out(latest_training) if latest_training else None,
        "latest_biological_profile": _profile_version_out(latest_biological) if latest_biological else None,
    }


def _load_event_out(e: models.SwimmerLoadEvent) -> dict:
    return {
        "id": e.id,
        "event_type": e.event_type,
        "date_from": e.date_from,
        "date_to": e.date_to,
        "severity": e.severity,
        "description": e.description,
        "resolved": e.resolved,
        "created_at": e.created_at,
    }


def _profile_version_out(v: models.SwimmerProfileVersion) -> dict:
    return {
        "id": v.id,
        "profile_type": v.profile_type,
        "data": v.data,
        "change_summary": v.change_summary,
        "obs_count": v.obs_count,
        "created_at": v.created_at.isoformat() if v.created_at else None,
    }


def _obs_out(o: models.SwimmerObservation) -> dict:
    return {
        "id": o.id,
        "obs_type": o.obs_type,
        "date": o.date,
        "event": o.event,
        "energy_zone": o.energy_zone,
        "content": o.content,
        "structured": o.structured,
        "ai_summary": o.ai_summary,
        "session_id": o.session_id,
        "created_at": o.created_at,
    }


def _format_time(t: models.SwimTime) -> dict:
    secs = t.time_seconds
    mins = int(secs // 60)
    sec_part = secs % 60
    display = f"{mins}:{sec_part:05.2f}" if mins > 0 else f"{sec_part:.2f}"
    return {
        "id": t.id,
        "event": t.event,
        "time_seconds": t.time_seconds,
        "time_display": display,
        "wa_points": t.wa_points,
        "date": t.date,
        "meet": t.meet,
        "round": t.round,
        "splits": t.splits,
        "source": t.source,
    }
