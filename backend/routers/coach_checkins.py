"""Milestone and ad-hoc reflective check-ins for the coach."""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.database import get_db
from backend.services.claude_service import MODEL, get_client, response_text

router = APIRouter()

CHECKIN_MODES = {"scheduled", "monthly_reminder", "off"}


class CheckInStart(BaseModel):
    milestone_key: Optional[str] = None
    checkin_type: str = "adhoc"
    scope_type: Optional[str] = None
    scope_id: Optional[int] = None
    title: Optional[str] = None
    due_date: Optional[date] = None


def _settings_mode(db: DBSession) -> str:
    row = db.query(models.CoachCheckInSettings).filter(models.CoachCheckInSettings.id == 1).first()
    return row.mode if row and row.mode in CHECKIN_MODES else "scheduled"


def _opening_question(kind: str) -> str:
    return {
        "season_start": "As this season begins, what feels most important to you—and what are you most uncertain or concerned about?",
        "meso_midpoint": "At the midpoint of this block, does the squad look and feel as you expected? What is landing, and what is worrying you?",
        "meso_end": "Looking back over this block, what adaptation did you actually see, and where did reality differ from the plan?",
        "post_meet": "With a little distance from the meet, what do you think genuinely worked—and what result or pattern is bothering you?",
        "macro_end": "Across this whole macro, what would you keep, change, or stop before beginning the next preparation cycle?",
        "season_end": "Looking across the season, what changed in the swimmers and in your own thinking as a coach?",
        "monthly": "What has been occupying your coaching thoughts recently—something encouraging, uncertain, frustrating, or worth exploring?",
        "adhoc": "What is on your mind as a coach right now? Start with whatever feels most useful: a worry, an idea, a motivation, or something you are reconsidering.",
    }.get(kind, "What feels most useful to reflect on right now?")


def _scope_context(row: models.CoachCheckIn, db: DBSession) -> str:
    if row.scope_type == "season" and row.scope_id:
        scope = db.query(models.Season).filter(models.Season.id == row.scope_id).first()
        if scope:
            return f"Season: {scope.name}, {scope.date_from} to {scope.date_to}. Existing season narrative: {scope.narrative or 'None yet'}"
    if row.scope_type == "macro" and row.scope_id:
        scope = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == row.scope_id).first()
        if scope:
            return f"Macro: {scope.name}, {scope.date_from} to {scope.date_to}. Existing intent: {scope.narrative or 'None yet'}"
    if row.scope_type == "meso" and row.scope_id:
        scope = db.query(models.SeasonBlock).filter(models.SeasonBlock.id == row.scope_id).first()
        if scope:
            return f"Meso: {scope.name}, {scope.date_from} to {scope.date_to}, phase {scope.phase_type or 'unspecified'}. Notes: {scope.notes or 'None'}"
    if row.scope_type == "meet" and row.scope_id:
        scope = db.query(models.Meet).filter(models.Meet.id == row.scope_id).first()
        if scope:
            return f"Meet: {scope.name} on {scope.date}."
    return "No fixed planning scope; this is an open coaching reflection."


def _out(row: models.CoachCheckIn, full: bool = False) -> dict:
    result = {
        "id": row.id,
        "milestone_key": row.milestone_key,
        "checkin_type": row.checkin_type,
        "scope_type": row.scope_type,
        "scope_id": row.scope_id,
        "title": row.title,
        "due_date": row.due_date.isoformat() if row.due_date else None,
        "status": row.status,
        "summary": row.summary,
        "created_at": row.created_at,
        "completed_at": row.completed_at,
    }
    if full:
        result["messages"] = row.messages or []
        result["opening_question"] = _opening_question(row.checkin_type)
    return result


def _candidate(key, kind, scope_type, scope_id, title, due):
    return {
        "milestone_key": key, "checkin_type": kind,
        "scope_type": scope_type, "scope_id": scope_id,
        "title": title, "due_date": due.isoformat(),
    }


def _scheduled_candidates(db: DBSession, today: date) -> list[dict]:
    lower, upper = today - timedelta(days=7), today + timedelta(days=3)
    candidates = []

    seasons = db.query(models.Season).filter(models.Season.is_current.is_(True)).all()
    for season in seasons:
        for kind, due, label in (
            ("season_start", season.date_from, "Season-opening coaching check-in"),
            ("season_end", season.date_to, "End-of-season coaching review"),
        ):
            if lower <= due <= upper:
                candidates.append(_candidate(f"{kind}:season:{season.id}", kind, "season", season.id, f"{label} · {season.name}", due))

    blocks = db.query(models.SeasonBlock).all()
    for block in blocks:
        duration = (block.date_to - block.date_from).days + 1
        milestones = [("meso_end", block.date_to, "End-of-meso review")]
        if duration >= 22:
            milestones.insert(0, ("meso_midpoint", block.date_from + timedelta(days=(duration - 1) // 2), "Mid-meso check-in"))
        for kind, due, label in milestones:
            if lower <= due <= upper:
                candidates.append(_candidate(f"{kind}:meso:{block.id}", kind, "meso", block.id, f"{label} · {block.name}", due))

    macros = db.query(models.TrainingMacro).all()
    for macro in macros:
        if lower <= macro.date_to <= upper:
            candidates.append(_candidate(f"macro_end:macro:{macro.id}", "macro_end", "macro", macro.id, f"Macro review · {macro.name}", macro.date_to))
        if macro.primary_meet and macro.primary_meet.date:
            due = macro.primary_meet.date + timedelta(days=1)
            if lower <= due <= upper:
                candidates.append(_candidate(f"post_meet:meet:{macro.primary_meet.id}", "post_meet", "meet", macro.primary_meet.id, f"Post-meet reflection · {macro.primary_meet.name}", due))
    return candidates


@router.get("/settings")
def get_settings(db: DBSession = Depends(get_db)):
    return {"mode": _settings_mode(db)}


@router.put("/settings")
def update_settings(body: dict = Body(...), db: DBSession = Depends(get_db)):
    mode = body.get("mode")
    if mode not in CHECKIN_MODES:
        raise HTTPException(422, "Mode must be scheduled, monthly_reminder or off")
    row = db.query(models.CoachCheckInSettings).filter(models.CoachCheckInSettings.id == 1).first()
    if not row:
        row = models.CoachCheckInSettings(id=1, mode=mode)
        db.add(row)
    else:
        row.mode = mode
    db.commit()
    return {"mode": row.mode}


@router.get("/due")
def due_checkins(as_of: Optional[date] = None, db: DBSession = Depends(get_db)):
    today = as_of or date.today()
    mode = _settings_mode(db)
    if mode == "off":
        return {"mode": mode, "items": []}
    if mode == "monthly_reminder":
        candidates = [_candidate(
            f"monthly:{today:%Y-%m}", "monthly", None, None,
            f"Monthly coaching reflection · {today.strftime('%B')}", today.replace(day=1),
        )]
    else:
        candidates = _scheduled_candidates(db, today)

    keys = [item["milestone_key"] for item in candidates]
    existing = {
        row.milestone_key: row for row in db.query(models.CoachCheckIn).filter(
            models.CoachCheckIn.milestone_key.in_(keys)
        ).all()
    } if keys else {}
    items = []
    for item in candidates:
        row = existing.get(item["milestone_key"])
        if row and row.status in {"completed", "skipped"}:
            continue
        items.append({**item, "id": row.id if row else None, "status": row.status if row else "due"})
    items.sort(key=lambda item: item["due_date"])
    return {"mode": mode, "items": items}


@router.get("")
def list_checkins(limit: int = 30, db: DBSession = Depends(get_db)):
    rows = db.query(models.CoachCheckIn).order_by(models.CoachCheckIn.created_at.desc()).limit(limit).all()
    return [_out(row) for row in rows]


@router.post("/start", status_code=201)
def start_checkin(body: CheckInStart, db: DBSession = Depends(get_db)):
    if body.milestone_key:
        existing = db.query(models.CoachCheckIn).filter(models.CoachCheckIn.milestone_key == body.milestone_key).first()
        if existing:
            return _out(existing, full=True)
    row = models.CoachCheckIn(
        milestone_key=body.milestone_key,
        checkin_type=body.checkin_type,
        scope_type=body.scope_type,
        scope_id=body.scope_id,
        title=(body.title or "Ad-hoc coaching check-in").strip(),
        due_date=body.due_date,
        status="in_progress",
        messages=[],
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _out(row, full=True)


@router.get("/{checkin_id}")
def get_checkin(checkin_id: int, db: DBSession = Depends(get_db)):
    row = db.query(models.CoachCheckIn).filter(models.CoachCheckIn.id == checkin_id).first()
    if not row:
        raise HTTPException(404, "Check-in not found")
    return _out(row, full=True)


@router.post("/{checkin_id}/chat")
def checkin_chat(checkin_id: int, body: dict = Body(...), db: DBSession = Depends(get_db)):
    row = db.query(models.CoachCheckIn).filter(models.CoachCheckIn.id == checkin_id).first()
    if not row:
        raise HTTPException(404, "Check-in not found")
    if row.status != "in_progress":
        raise HTTPException(409, "This check-in is already closed")
    message = str(body.get("message") or "").strip()
    if not message:
        raise HTTPException(400, "Message required")
    messages = list(row.messages or [])
    messages.append({"role": "coach", "message": message})
    history = [{
        "role": "user" if item["role"] == "coach" else "assistant",
        "content": item["message"],
    } for item in messages]
    system = f"""You are conducting a reflective check-in with a competitive swimming coach.
This is a {row.checkin_type.replace('_', ' ')} check-in titled {row.title}.
{_scope_context(row, db)}

Explore the coach's thoughts, motivations, uncertainty, observations, worries and evolving philosophy.
Ask one thoughtful question at a time. Reflect back useful patterns without becoming flattering or clinical.
Keep planning facts tied to their season/macro/meso scope; do not turn them into permanent coaching identity.
After roughly four useful coach responses, say that there is enough to complete the check-in, while allowing them to continue."""
    response = get_client().messages.create(model=MODEL, max_tokens=500, system=system, messages=history)
    reply = response_text(response).strip()
    messages.append({"role": "ai", "message": reply})
    row.messages = messages
    db.commit()
    return {"reply": reply, "messages": messages}


@router.post("/{checkin_id}/complete")
def complete_checkin(checkin_id: int, db: DBSession = Depends(get_db)):
    row = db.query(models.CoachCheckIn).filter(models.CoachCheckIn.id == checkin_id).first()
    if not row:
        raise HTTPException(404, "Check-in not found")
    coach_messages = [item["message"] for item in (row.messages or []) if item.get("role") == "coach"]
    if not coach_messages:
        raise HTTPException(400, "Add at least one reflection before completing the check-in")
    prompt = f"""Summarise this coaching check-in in concise prose.
Separate: what the coach observed; what they are uncertain or concerned about; what they intend to do next;
and any durable coaching belief that may be worth revisiting later. Do not claim the coach profile was updated.

CHECK-IN: {row.title}
SCOPE: {_scope_context(row, db)}
COACH RESPONSES:
{chr(10).join(f'- {message}' for message in coach_messages)}"""
    response = get_client().messages.create(model=MODEL, max_tokens=700, messages=[{"role": "user", "content": prompt}])
    row.summary = response_text(response).strip()
    row.status = "completed"
    row.completed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return _out(row, full=True)


@router.post("/{checkin_id}/skip")
def skip_checkin(checkin_id: int, db: DBSession = Depends(get_db)):
    row = db.query(models.CoachCheckIn).filter(models.CoachCheckIn.id == checkin_id).first()
    if not row:
        raise HTTPException(404, "Check-in not found")
    row.status = "skipped"
    row.completed_at = datetime.now(timezone.utc)
    db.commit()
    return _out(row)
