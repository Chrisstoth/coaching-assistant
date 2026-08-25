import base64
import json
import os
import re
from datetime import date, datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Body, UploadFile, File, Form
from typing import Optional
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models
from backend.services.claude_service import (
    get_client, MODEL, FAST_MODEL, PRIMARY_EFFORT, PLANNING_EFFORT, TRANSCRIPTION_MODEL,
    COACHING_CONTEXT_CHAR_LIMIT,
    record_ai_usage, get_system_prompt, build_session_writing_context,
    detect_topics, extract_slot_hint, _strip_json,
    extract_benchmarks_from_conversation, extract_coaching_intent,
    get_tools, execute_tool, save_wizard_profile,
)
from backend.services.agent_policy import choose_agent_route
from backend.services.availability import availability_on_date

router = APIRouter()

MAX_HISTORY = max(6, min(int(os.getenv("AI_MAX_HISTORY", "20")), 40))
GENERAL_HISTORY = max(6, min(int(os.getenv("AI_GENERAL_HISTORY", "10")), MAX_HISTORY))
ATHLETE_HISTORY = max(8, min(int(os.getenv("AI_ATHLETE_HISTORY", "12")), MAX_HISTORY))
SUMMARY_BATCH_SIZE = max(4, min(int(os.getenv("AI_SUMMARY_BATCH_SIZE", "8")), 20))
SUMMARY_CHAR_LIMIT = max(1200, min(int(os.getenv("AI_SUMMARY_CHAR_LIMIT", "3500")), 6000))


def _conversation_action(text: str, topics: set[str], messages: list, swimmers: list) -> dict:
    """Choose review actions locally so chat replies are not delayed by another API call."""
    lower = " ".join((text or "").lower().split())
    swimmer = swimmers[0] if len(swimmers) == 1 else None
    user_turns = sum(1 for message in messages if message.get("role") == "user")

    status_requested = any(status in lower for status in (
        "injury", "injured", "sabbatical", "active status",
    )) and any(
        verb in lower for verb in ("put ", "mark ", "status", "going on", "return")
    )
    if swimmer and status_requested:
        if "sabbatical" in lower:
            new_status = "sabbatical"
        elif "return" in lower or "back to training" in lower or "active status" in lower:
            new_status = "active"
        else:
            new_status = "injury"
        return {
            "intent": "status_change",
            "swimmer_id": swimmer.id,
            "swimmer_name": swimmer.name,
            "new_status": new_status,
            "suggested_action": f"Mark {swimmer.name} as {new_status}",
        }

    if swimmer and "benchmark" in topics:
        return {
            "intent": "benchmark_capture",
            "swimmer_id": swimmer.id,
            "swimmer_name": swimmer.name,
            "suggested_action": f"Extract and save benchmark for {swimmer.name}",
        }

    profile_requested = any(signal in lower for signal in (
        "update her profile", "update his profile", "update their profile",
        "update the profile", "save this to", "remember this about",
    ))
    if swimmer and user_turns >= 2 and (
        topics.intersection({"biological", "performance", "coaching_intent"})
        or profile_requested
    ):
        return {
            "intent": "athlete_profile_update",
            "swimmer_id": swimmer.id,
            "swimmer_name": swimmer.name,
            "suggested_action": f"Update {swimmer.name}'s profile from this conversation",
        }

    if "session_writing" in topics and user_turns >= 2:
        return {"intent": "session_writing", "suggested_action": "Review and create this session"}

    if any(signal in lower for signal in ("create this meet", "add this meet", "save this meet")):
        return {"intent": "meet_creation", "suggested_action": "Review and create this meet"}

    return {"intent": "general", "suggested_action": None}


def _history_limit_for_thread(thread) -> int:
    if thread and thread.thread_type == "season_plan":
        return MAX_HISTORY
    if thread and thread.thread_type == "athlete_planning":
        return ATHLETE_HISTORY
    return GENERAL_HISTORY


def _thread_memory(
    thread,
    recent_messages: list,
    db: DBSession,
    history_limit: int = MAX_HISTORY,
) -> str:
    """Return bounded long-term conversation memory and periodically roll it up cheaply.

    Durable coaching facts belong in structured tables; this summary only preserves decisions,
    assumptions and unresolved questions from messages that have fallen out of recent history.
    """
    if not thread or len(recent_messages) < history_limit:
        return ""

    oldest_recent_id = recent_messages[0].id
    through_id = thread.summarized_through_message_id or 0
    unsummarized = db.query(models.CoachAIMessage).filter(
        models.CoachAIMessage.thread_id == thread.id,
        models.CoachAIMessage.id < oldest_recent_id,
        models.CoachAIMessage.id > through_id,
    ).order_by(models.CoachAIMessage.id).limit(SUMMARY_BATCH_SIZE).all()
    should_roll_up = bool(unsummarized) and (
        not thread.rolling_summary or len(unsummarized) >= SUMMARY_BATCH_SIZE
    )

    if should_roll_up and unsummarized:
        transcript = "\n".join(
            f"{'Coach' if m.role == 'user' else 'AI'}: {m.message[:1200]}"
            for m in unsummarized
        )
        prompt = f"""Maintain a compact memory for a swimming coaching conversation.
Preserve only agreed decisions, dates, competition priorities, plan changes, athlete-specific
constraints, coach preferences, and unresolved questions. Do not preserve pleasantries or
duplicate database facts. Merge the new archived messages into the prior memory.

PRIOR MEMORY:
{thread.rolling_summary or 'None'}

NEW ARCHIVED MESSAGES:
{transcript}

Return plain text under 450 words with short labelled bullets."""
        try:
            response = get_client().messages.create(
                model=FAST_MODEL,
                max_tokens=650,
                messages=[{"role": "user", "content": prompt}],
            )
            summary = response.content[0].text.strip()[:SUMMARY_CHAR_LIMIT]
            thread.rolling_summary = summary
            thread.summarized_through_message_id = unsummarized[-1].id
            thread.summary_updated_at = datetime.now(timezone.utc)
            db.commit()
        except Exception:
            db.rollback()

    # Between roll-ups, include at most one batch of newly archived messages verbatim.
    through_id = thread.summarized_through_message_id or 0
    bridge = db.query(models.CoachAIMessage).filter(
        models.CoachAIMessage.thread_id == thread.id,
        models.CoachAIMessage.id < oldest_recent_id,
        models.CoachAIMessage.id > through_id,
    ).order_by(models.CoachAIMessage.id.desc()).limit(SUMMARY_BATCH_SIZE).all()
    bridge.reverse()
    parts = []
    if thread.rolling_summary:
        parts.append("ROLLING THREAD MEMORY (older decisions; structured database data overrides this):\n" + thread.rolling_summary)
    if bridge:
        bridge_text = "\n".join(
            f"{'Coach' if m.role == 'user' else 'AI'}: {m.message[:500]}" for m in bridge
        )
        parts.append("RECENT ARCHIVED CONTEXT (awaiting next roll-up):\n" + bridge_text)
    return "\n\n".join(parts)

# Phrases that mean "generate a session for me" — triggers the planning skill
# Phrases that mean "give me a systematic review of this swimmer"
_REVIEW_SWIMMER_SIGNALS = [
    'how is ', 'how\'s ', 'how are ', 'review ', 'adaptation review',
    'give me an update on ', 'update on ', 'how is she doing', 'how is he doing',
    'where is ', 'where\'s ', 'assess ', 'assessment of ',
    'how has ', 'how have ', 'check on ', 'check in on ',
    'is she adapting', 'is he adapting', 'is she responding', 'is he responding',
]

def _is_swimmer_review(text: str, db) -> Optional[str]:
    """Returns swimmer name if message is a review request for a specific swimmer, else None."""
    t = text.lower()
    if not any(k in t for k in _REVIEW_SWIMMER_SIGNALS):
        return None
    # Check if any active swimmer name appears in the message
    swimmers = db.query(models.Swimmer).filter(models.Swimmer.status == 'active').all()
    for s in swimmers:
        name_parts = s.name.lower().split()
        first = name_parts[0] if name_parts else ""
        if (len(first) >= 4 and first in t) or s.name.lower() in t:
            return s.name
    return None


_BLOCK_REVIEW_SIGNALS = [
    'how did the', 'how did that', 'review the block', 'review this block',
    'review the meso', 'review this meso', 'block review', 'meso review',
    'how did the last block', 'how did the last meso', 'how has the block gone',
    'block analysis', 'meso analysis', 'analyse the block', 'analyze the block',
    'how is the block going', 'how is the meso going',
    'wrap up the block', 'end of block',
]

def _is_block_review(text: str, db) -> Optional[int]:
    """Returns block_id if the message is a block review request, else None."""
    t = text.lower()
    if not any(k in t for k in _BLOCK_REVIEW_SIGNALS):
        return None
    from datetime import date as date_type
    today = date_type.today()
    # Current block first
    current = db.query(models.SeasonBlock).filter(
        models.SeasonBlock.date_from <= today,
        models.SeasonBlock.date_to >= today,
    ).order_by(models.SeasonBlock.date_from).first()
    if current:
        return current.id
    # Most recent past block
    recent = db.query(models.SeasonBlock).filter(
        models.SeasonBlock.date_to < today,
    ).order_by(models.SeasonBlock.date_to.desc()).first()
    if recent:
        return recent.id
    return None


_MESO_PLAN_SIGNALS = [
    'plan the next block', 'plan the next phase', 'plan a block', 'plan a meso',
    'what should the next block be', 'what should the next phase be', 'what phase is next',
    'what comes next', 'next phase', 'next block', 'next meso',
    'what phase should we do', 'help me plan the next', 'plan the season',
    'build the next block', 'build the next phase', 'build a meso',
    'structure the next', 'design the next block', 'recommend a phase',
]

def _is_meso_plan(text: str) -> bool:
    t = text.lower()
    return any(k in t for k in _MESO_PLAN_SIGNALS)


_RACE_ANALYSIS_SIGNALS = [
    'race analysis', 'analyse the meet', 'analyze the meet',
    'how did we do at', 'how did we perform', 'how did the meet go',
    'meet analysis', 'post meet', 'post-meet', 'review the meet',
    'how did the last meet go', 'how did the competition go',
    'what happened at', 'results from', 'how were the results',
]

def _is_race_analysis(text: str, db) -> Optional[int]:
    """Returns meet_id if the message is a post-meet race analysis request, else None."""
    t = text.lower()
    if not any(k in t for k in _RACE_ANALYSIS_SIGNALS):
        return None
    from datetime import date as date_type
    today = date_type.today()
    # Check if a specific meet name appears in the text
    meets = db.query(models.Meet).order_by(models.Meet.date.desc()).limit(20).all()
    for m in meets:
        if m.name and len(m.name) >= 4 and m.name.lower()[:15] in t:
            return m.id
    # Default: most recent past meet
    recent = db.query(models.Meet).filter(
        models.Meet.date <= today,
    ).order_by(models.Meet.date.desc()).first()
    return recent.id if recent else None


_TAPER_PLAN_SIGNALS = [
    'taper for', 'taper plan', 'plan a taper', 'plan the taper',
    'taper programme', 'taper program', 'pre-meet taper',
    'how should we taper', 'design a taper', 'build a taper',
    'plan her taper', 'plan his taper',
]

def _is_taper_plan(text: str, db) -> Optional[str]:
    """Returns swimmer name if message is a taper plan request, else None."""
    t = text.lower()
    if not any(k in t for k in _TAPER_PLAN_SIGNALS):
        return None
    swimmers = db.query(models.Swimmer).filter(models.Swimmer.status == 'active').all()
    for s in swimmers:
        name_parts = s.name.lower().split()
        first = name_parts[0] if name_parts else ""
        if (len(first) >= 4 and first in t) or s.name.lower() in t:
            return s.name
    return None


_GENERATE_SESSION_SIGNALS = [
    'plan a session', 'make a session', 'write a session', 'design a session',
    'build a session', 'create a session', 'generate a session',
    'session for monday', 'session for tuesday', 'session for wednesday',
    'session for thursday', 'session for friday', 'session for saturday', 'session for sunday',
    'session for tomorrow', 'session for today', 'session for next',
    "what's the session", "what's our session", 'plan the session', 'write the session',
]

def _is_session_generation(text: str) -> bool:
    t = text.lower()
    return any(k in t for k in _GENERATE_SESSION_SIGNALS)


_SUGGEST_GROUPS_SIGNALS = [
    'suggest groups', 'group the squad', 'squad groups', 'training groups',
    'how should i group', 'how should we group', 'who should be in which group',
    'review the groups', 'update the groups', 'change the groups', 'group composition',
    'split the squad', 'squad composition', 'who goes in', 'group assignment',
    'group recommendations', 'which group should', 'reorganise groups', 'reorganize groups',
]

def _is_suggest_groups(text: str) -> bool:
    t = text.lower()
    return any(k in t for k in _SUGGEST_GROUPS_SIGNALS)


_MICRO_PLAN_SIGNALS = [
    'plan the week', 'plan this week', 'weekly plan', 'week plan',
    'plan next week', "what's the week", "what sessions this week",
    'micro plan', 'week structure', 'session sequence', 'sequence the week',
    'plan the sessions this week', 'sessions for the week', 'weekly schedule',
    'map out the week', 'structure the week',
]

def _is_micro_plan(text: str) -> bool:
    t = text.lower()
    return any(k in t for k in _MICRO_PLAN_SIGNALS)


_SEASON_PLAN_SIGNALS = [
    "plan the season", "plan a season", "plan next season", "season plan",
    "let's plan", "lets plan", "build the season", "season structure",
    "review the season plan", "open the season plan", "season planning",
    "annual plan", "macro plan", "plan the macro", "build a macro",
    "plan the year", "year plan",
]

def _is_season_plan_navigation(text: str) -> bool:
    t = text.lower()
    return any(k in t for k in _SEASON_PLAN_SIGNALS)


_ATHLETE_PLAN_SIGNALS = [
    "athlete planning", "athlete plan", "discuss the athletes", "discuss the swimmers",
    "talk about the athletes", "individual planning", "swimmer planning",
    "swimmer development", "open the athlete chat", "athlete chat", "athletes chat",
    "open athlete planning", "athlete development",
]

def _is_athlete_plan_navigation(text: str) -> bool:
    t = text.lower()
    return any(k in t for k in _ATHLETE_PLAN_SIGNALS)


_MACRO_PLAN_SIGNALS = [
    "plan the macro", "plan a macro", "plan the season", "plan next season",
    "build the season", "season structure", "annual plan", "plan the year",
    "create a macro", "new macro", "build a macro",
]

def _is_macro_plan(text: str) -> bool:
    t = text.lower()
    return any(k in t for k in _MACRO_PLAN_SIGNALS)


def _extract_target_date(text: str):
    """Best-effort date extraction from natural language. Returns date or None."""
    from datetime import date as date_type, timedelta
    import re
    today = date_type.today()
    t = text.lower()
    days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    if 'tomorrow' in t:
        return today + timedelta(days=1)
    if 'today' in t:
        return today
    for i, day in enumerate(days):
        if day in t:
            current_dow = today.weekday()
            delta = (i - current_dow) % 7
            if delta == 0:
                delta = 7  # next week if same day
            return today + timedelta(days=delta)
    # ISO date pattern
    match = re.search(r'\d{4}-\d{2}-\d{2}', text)
    if match:
        from datetime import datetime
        try:
            return datetime.strptime(match.group(), "%Y-%m-%d").date()
        except ValueError:
            pass
    return None


# ---------------------------------------------------------------------------
# Thread management
# ---------------------------------------------------------------------------

@router.get("/threads")
def get_threads(db: DBSession = Depends(get_db)):
    threads = db.query(models.AIThread).order_by(models.AIThread.created_at.asc()).all()
    return [{"id": t.id, "name": t.name, "created_at": t.created_at} for t in threads]


@router.post("/threads")
def create_thread(body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    thread = models.AIThread(
        name=body.get("name") or None,
        thread_type=body.get("thread_type", "general"),
        macro_id=body.get("macro_id") or None,
    )
    db.add(thread)
    db.commit()
    db.refresh(thread)
    return {
        "id": thread.id,
        "name": thread.name,
        "thread_type": thread.thread_type,
        "macro_id": thread.macro_id,
        "created_at": thread.created_at,
    }


@router.get("/threads")
def list_threads(db: DBSession = Depends(get_db)):
    threads = db.query(models.AIThread).order_by(models.AIThread.created_at.desc()).all()
    result = []
    for t in threads:
        last_msg = db.query(models.CoachAIMessage).filter(
            models.CoachAIMessage.thread_id == t.id
        ).order_by(models.CoachAIMessage.created_at.desc()).first()
        result.append({
            "id": t.id,
            "name": t.name,
            "thread_type": t.thread_type or "general",
            "macro_id": t.macro_id,
            "created_at": t.created_at,
            "last_message_at": last_msg.created_at if last_msg else t.created_at,
        })
    return result


@router.post("/threads/season-plan")
def get_or_create_season_plan_thread(body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    """Get the existing season planning thread for a macro, or create one."""
    macro_id = body.get("macro_id")

    # Find existing season_plan thread for this macro (or any if no macro_id)
    q = db.query(models.AIThread).filter(models.AIThread.thread_type == "season_plan")
    if macro_id:
        q = q.filter(models.AIThread.macro_id == macro_id)
    existing = q.order_by(models.AIThread.created_at.desc()).first()

    if existing:
        msg_count = db.query(models.CoachAIMessage).filter(
            models.CoachAIMessage.thread_id == existing.id
        ).count()
        return {
            "id": existing.id,
            "name": existing.name,
            "thread_type": existing.thread_type,
            "macro_id": existing.macro_id,
            "created_at": existing.created_at,
            "message_count": msg_count,
            "is_new": False,
        }

    # Create new season plan thread
    macro_name = None
    if macro_id:
        macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == macro_id).first()
        macro_name = macro.name if macro else None
    else:
        # Find current macro
        from datetime import date as date_type
        today = date_type.today()
        macro = db.query(models.TrainingMacro).filter(
            models.TrainingMacro.date_from <= today,
            models.TrainingMacro.date_to >= today,
        ).order_by(models.TrainingMacro.date_from).first()
        if macro:
            macro_id = macro.id
            macro_name = macro.name

    thread_name = f"Season Plan{f' — {macro_name}' if macro_name else ''}"
    thread = models.AIThread(name=thread_name, thread_type="season_plan", macro_id=macro_id)
    db.add(thread)
    db.commit()
    db.refresh(thread)
    return {
        "id": thread.id,
        "name": thread.name,
        "thread_type": thread.thread_type,
        "macro_id": thread.macro_id,
        "created_at": thread.created_at,
        "message_count": 0,
        "is_new": True,
    }


@router.post("/threads/athlete-planning")
def get_or_create_athlete_plan_thread(body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    """Get the existing athlete planning thread, or create one."""
    existing = db.query(models.AIThread).filter(
        models.AIThread.thread_type == "athlete_planning"
    ).order_by(models.AIThread.created_at.desc()).first()

    if existing:
        msg_count = db.query(models.CoachAIMessage).filter(
            models.CoachAIMessage.thread_id == existing.id
        ).count()
        return {
            "id": existing.id,
            "name": existing.name,
            "thread_type": existing.thread_type,
            "created_at": existing.created_at,
            "message_count": msg_count,
            "is_new": False,
        }

    thread = models.AIThread(name="Athletes", thread_type="athlete_planning")
    db.add(thread)
    db.commit()
    db.refresh(thread)
    return {
        "id": thread.id,
        "name": thread.name,
        "thread_type": thread.thread_type,
        "created_at": thread.created_at,
        "message_count": 0,
        "is_new": True,
    }


@router.patch("/threads/{thread_id}")
def rename_thread(thread_id: int, body: dict = Body(...), db: DBSession = Depends(get_db)):
    thread = db.query(models.AIThread).filter(models.AIThread.id == thread_id).first()
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    thread.name = body.get("name", thread.name)
    db.commit()
    return {"id": thread.id, "name": thread.name}


@router.delete("/threads/{thread_id}", status_code=204)
def delete_thread(thread_id: int, db: DBSession = Depends(get_db)):
    thread = db.query(models.AIThread).filter(models.AIThread.id == thread_id).first()
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    db.delete(thread)
    db.commit()


def _find_mentioned_swimmers(text: str, db: DBSession) -> list:
    swimmers = db.query(models.Swimmer).filter(models.Swimmer.status == 'active').all()
    text_lower = text.lower()
    matched = []
    for s in swimmers:
        name_parts = s.name.lower().split()
        first = name_parts[0] if name_parts else ""
        full = s.name.lower()
        if (len(first) >= 4 and first in text_lower) or full in text_lower:
            matched.append(s)
    return matched


def _all_mentioned_swimmers(messages: list, db: DBSession) -> list:
    """Find all swimmers mentioned across the full conversation, deduplicated."""
    seen_ids = set()
    result = []
    for msg in messages:
        for s in _find_mentioned_swimmers(msg.get("content", ""), db):
            if s.id not in seen_ids:
                seen_ids.add(s.id)
                result.append(s)
    return result


@router.get("/messages")
def get_messages(thread_id: Optional[int] = None, db: DBSession = Depends(get_db)):
    q = db.query(models.CoachAIMessage)
    if thread_id is not None:
        q = q.filter(models.CoachAIMessage.thread_id == thread_id)
    msgs = q.order_by(models.CoachAIMessage.id.desc()).limit(200).all()
    msgs.reverse()
    return [{"id": m.id, "role": m.role, "message": m.message, "created_at": m.created_at} for m in msgs]


_REGISTER_MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2,
    "mar": 3, "march": 3, "apr": 4, "april": 4,
    "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10, "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}


def _extract_register_date(text: str, today: Optional[date] = None) -> Optional[date]:
    """Extract an explicit calendar date, including compact input like 24thaugust."""
    today = today or date.today()
    value = (text or "").lower()

    iso_match = re.search(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b", value)
    if iso_match:
        try:
            return date(int(iso_match.group(1)), int(iso_match.group(2)), int(iso_match.group(3)))
        except ValueError:
            return None

    numeric_match = re.search(r"\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b", value)
    if numeric_match:
        year = int(numeric_match.group(3)) if numeric_match.group(3) else today.year
        if year < 100:
            year += 2000
        try:
            return date(year, int(numeric_match.group(2)), int(numeric_match.group(1)))
        except ValueError:
            return None

    month_names = "|".join(sorted(_REGISTER_MONTHS, key=len, reverse=True))
    named_match = re.search(
        rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s*({month_names})(?:\s+(\d{{4}}))?\b",
        value,
    )
    if not named_match:
        return None
    try:
        return date(
            int(named_match.group(3)) if named_match.group(3) else today.year,
            _REGISTER_MONTHS[named_match.group(2)],
            int(named_match.group(1)),
        )
    except ValueError:
        return None


def _matches_period(start_time: Optional[str], period: Optional[str]) -> bool:
    if not period:
        return True
    try:
        is_am = int((start_time or "").split(":", 1)[0]) < 12
    except (TypeError, ValueError):
        return False
    return (period == "AM" and is_am) or (period == "PM" and not is_am)


def _availability_json(item: Optional[dict]) -> Optional[dict]:
    if not item:
        return None
    return {
        **item,
        "date_from": item["date_from"].isoformat(),
        "date_to": item["date_to"].isoformat(),
    }


def _register_attendees(session: models.Session, db: DBSession) -> list[dict]:
    """Return every active swimmer; timetable links are display hints only."""
    swimmers = db.query(models.Swimmer).filter(
        models.Swimmer.status == "active",
    ).order_by(models.Swimmer.name).all()
    swimmer_ids = [swimmer.id for swimmer in swimmers]
    usual_ids = set()
    if session.pool_slot_id:
        usual_ids = {
            row[0] for row in db.query(models.SwimmerSlot.swimmer_id).filter(
                models.SwimmerSlot.pool_slot_id == session.pool_slot_id,
            ).all()
        }
    unavailable = availability_on_date(db, swimmer_ids, session.date)
    existing = {
        row.swimmer_id: row for row in db.query(models.SessionEntry).filter(
            models.SessionEntry.session_id == session.id,
        ).all()
    }
    return [
        {
            "id": swimmer.id,
            "name": swimmer.name,
            "squad": swimmer.squad,
            "attended": existing.get(swimmer.id).attended if existing.get(swimmer.id) else None,
            "group_done": existing.get(swimmer.id).group_done if existing.get(swimmer.id) else None,
            "usual_for_slot": swimmer.id in usual_ids,
            # Retained for older clients, but it describes planning only.
            "expected": swimmer.id in usual_ids and swimmer.id not in unavailable,
            "exception_reason": unavailable.get(swimmer.id, {}).get("reason"),
            "availability": _availability_json(unavailable.get(swimmer.id)),
        }
        for swimmer in swimmers
    ]


def _register_option(label: str, start_time: Optional[str], end_time: Optional[str]) -> str:
    time_range = start_time or "time not set"
    if start_time and end_time:
        time_range = f"{start_time}–{end_time}"
    return f"{label} ({time_range})"


def _resolve_register_request(
    text: str,
    db: DBSession,
    today: Optional[date] = None,
) -> dict:
    """Resolve an existing session or materialise the requested recurring slot."""
    today = today or date.today()
    hint = extract_slot_hint(text)
    explicit_date = _extract_register_date(text, today)

    if explicit_date and hint.get("dow") is not None and explicit_date.weekday() != hint["dow"]:
        actual_day = explicit_date.strftime("%A")
        return {
            "error": f"That date is a {actual_day}, not the day named in the request. Please confirm which one you mean.",
            "sessions": [],
        }

    if explicit_date:
        target_date = explicit_date
    elif hint.get("dow") is not None:
        days_back = (today.weekday() - hint["dow"]) % 7
        target_date = today - timedelta(days=days_back)
    else:
        target_date = today

    period = hint.get("time_period")
    sessions_on_date = db.query(models.Session).filter(
        models.Session.date == target_date,
    ).order_by(models.Session.start_time).all()
    active_sessions = [
        session for session in sessions_on_date
        if session.status != "cancelled" and _matches_period(session.start_time, period)
    ]

    if len(active_sessions) > 1:
        return {
            "error": "More than one session matches. Please include the session time.",
            "sessions": [
                {
                    "session_id": session.id,
                    "label": session.title or "Session",
                    "time": session.start_time,
                    "end_time": session.end_time,
                }
                for session in active_sessions
            ],
        }

    session = active_sessions[0] if active_sessions else None
    created_from_slot = False

    if session is None:
        cancelled_slot_ids = {
            row.pool_slot_id for row in sessions_on_date
            if row.status == "cancelled" and row.pool_slot_id is not None
        }
        slots = db.query(models.PoolSlot).filter(
            models.PoolSlot.day_of_week == target_date.weekday(),
            models.PoolSlot.active == True,
        ).order_by(models.PoolSlot.time).all()
        slots = [
            slot for slot in slots
            if slot.id not in cancelled_slot_ids and _matches_period(slot.time, period)
        ]

        if len(slots) > 1:
            return {
                "error": "More than one scheduled session matches. Please include the session time.",
                "sessions": [
                    {
                        "slot_id": slot.id,
                        "label": slot.label or "Session",
                        "time": slot.time,
                        "end_time": slot.end_time,
                    }
                    for slot in slots
                ],
            }
        if not slots:
            return {
                "error": "No non-cancelled session matches that date and time. Check the schedule or create the session first.",
                "sessions": [],
            }

        slot = slots[0]
        session = models.Session(
            date=target_date,
            start_time=slot.time,
            end_time=slot.end_time,
            squad=slot.squad,
            title=slot.label,
            pool_slot_id=slot.id,
            course=slot.course,
            status="active",
            source="calendar",
        )
        db.add(session)
        db.commit()
        db.refresh(session)
        created_from_slot = True

    attendees = _register_attendees(session, db)
    group_numbers = sorted(group.group_number for group in (session.groups or []))
    if not group_numbers and isinstance(session.planned_content, dict):
        for key in session.planned_content:
            match = re.search(r"\d+", str(key))
            if match:
                group_numbers.append(int(match.group()))
        group_numbers.sort()
    register_group_count = session.register_group_count or (len(group_numbers) if group_numbers else None)
    existing_entries = db.query(models.SessionEntry).filter(
        models.SessionEntry.session_id == session.id,
    ).count()
    return {
        "session_id": session.id,
        "session_title": session.title or f"Session {session.date}",
        "session_date": session.date.isoformat(),
        "session_time": session.start_time,
        "session_end_time": session.end_time,
        "register_taken": existing_entries > 0,
        "created_from_slot": created_from_slot,
        "register_group_count": register_group_count,
        "register_group_numbers": group_numbers,
        "attendees": attendees,
    }


def _register_reply(result: dict) -> str:
    if result.get("error"):
        options = result.get("sessions") or []
        if options:
            labels = ", ".join(
                _register_option(item.get("label") or "Session", item.get("time"), item.get("end_time"))
                for item in options
            )
            return f"{result['error']} Available matches: {labels}."
        return result["error"]

    session_date = date.fromisoformat(result["session_date"])
    date_label = session_date.strftime("%A %-d %B") if os.name != "nt" else session_date.strftime("%A %#d %B")
    time_label = _register_option(
        result["session_title"], result.get("session_time"), result.get("session_end_time")
    )
    squad_count = len(result.get("attendees", []))
    usual_count = sum(1 for attendee in result.get("attendees", []) if attendee.get("usual_for_slot"))
    suffix = f"The register is ready below with all {squad_count} active swimmers."
    if usual_count:
        suffix += f" {usual_count} are marked as usually attending this slot."
    return f"Found {time_label} on {date_label}. {suffix}"


def _is_session_cancellation_request(text: str) -> bool:
    """Recognise cancellation statements while leaving the final action to UI confirmation."""
    lower = " ".join((text or "").lower().split())
    cancellation_words = re.search(
        r"\b(cancel|cancelled|cancellation|call(?:ed)? off|not on|isn't on|wasn't on|bank holiday|public holiday)\b",
        lower,
    )
    session_words = re.search(
        r"\b(session|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|am|pm)\b",
        lower,
    )
    return bool(cancellation_words and session_words)


def _cancellation_reason_from_text(text: str) -> Optional[str]:
    lower = (text or "").lower()
    if "bank holiday" in lower or "public holiday" in lower:
        return "Public holiday"
    if "holiday" in lower:
        return "Holiday / scheduled break"
    if "pool" in lower and any(word in lower for word in ("closed", "closure", "unavailable")):
        return "Pool closure"
    if "coach" in lower and any(word in lower for word in ("away", "unavailable", "ill")):
        return "Coach unavailable"
    return None


def _resolve_cancellation_request(text: str, db: DBSession, today: Optional[date] = None) -> dict:
    """Resolve one calendar occurrence without mutating it."""
    today = today or date.today()
    hint = extract_slot_hint(text)
    explicit_date = _extract_register_date(text, today)

    if explicit_date and hint.get("dow") is not None and explicit_date.weekday() != hint["dow"]:
        return {
            "error": f"That date is a {explicit_date.strftime('%A')}, not the day named in the request.",
        }

    if explicit_date:
        target_date = explicit_date
    elif hint.get("dow") is not None:
        target_date = today - timedelta(days=(today.weekday() - hint["dow"]) % 7)
    else:
        target_date = today

    period = hint.get("time_period")
    occurrences = db.query(models.Session).filter(
        models.Session.date == target_date,
    ).order_by(models.Session.start_time).all()
    matching = [
        row for row in occurrences
        if row.status != "cancelled" and _matches_period(row.start_time, period)
    ]
    if len(matching) > 1:
        return {
            "error": "More than one session matches. Please include the session time.",
            "sessions": [
                {"label": row.title or "Session", "time": row.start_time, "end_time": row.end_time}
                for row in matching
            ],
        }

    if matching:
        row = matching[0]
        return {
            "session_id": row.id,
            "slot_id": row.pool_slot_id,
            "date": target_date.isoformat(),
            "label": row.title or "Session",
            "time": row.start_time,
            "end_time": row.end_time,
            "squad": row.squad,
            "suggested_reason": _cancellation_reason_from_text(text),
        }

    cancelled = [
        row for row in occurrences
        if row.status == "cancelled" and _matches_period(row.start_time, period)
    ]
    if len(cancelled) == 1:
        return {"error": f"{cancelled[0].title or 'That session'} is already recorded as cancelled."}

    cancelled_slot_ids = {row.pool_slot_id for row in occurrences if row.status == "cancelled"}
    slots = db.query(models.PoolSlot).filter(
        models.PoolSlot.day_of_week == target_date.weekday(),
        models.PoolSlot.active == True,
    ).order_by(models.PoolSlot.time).all()
    slots = [
        slot for slot in slots
        if slot.id not in cancelled_slot_ids and _matches_period(slot.time, period)
    ]
    if len(slots) != 1:
        return {
            "error": (
                "More than one scheduled session matches. Please include the session time."
                if len(slots) > 1
                else "No non-cancelled scheduled session matches that date and time."
            ),
            "sessions": [
                {"label": slot.label or "Session", "time": slot.time, "end_time": slot.end_time}
                for slot in slots
            ],
        }

    slot = slots[0]
    return {
        "session_id": None,
        "slot_id": slot.id,
        "date": target_date.isoformat(),
        "label": slot.label or "Session",
        "time": slot.time,
        "end_time": slot.end_time,
        "squad": slot.squad,
        "suggested_reason": _cancellation_reason_from_text(text),
    }


def _cancellation_reply(result: dict) -> str:
    if result.get("error"):
        return result["error"]
    target_date = date.fromisoformat(result["date"])
    date_label = target_date.strftime("%A %-d %B") if os.name != "nt" else target_date.strftime("%A %#d %B")
    session_label = _register_option(result["label"], result.get("time"), result.get("end_time"))
    return (
        f"I found {session_label} on {date_label}. Confirm the cancellation and its reason below. "
        "This records only that occurrence; the recurring timetable stays unchanged."
    )


@router.post("/messages")
def send_message(body: dict = Body(...), db: DBSession = Depends(get_db)):
    text = body.get("message", "").strip()
    thread_id = body.get("thread_id")
    brief = body.get("brief", False)
    if not text:
        raise HTTPException(status_code=400, detail="Message required")

    db.add(models.CoachAIMessage(role="user", message=text, thread_id=thread_id))
    db.commit()

    thread_obj = db.query(models.AIThread).filter(models.AIThread.id == thread_id).first() if thread_id else None
    history_limit = _history_limit_for_thread(thread_obj)
    recent = (
        db.query(models.CoachAIMessage)
        .filter(models.CoachAIMessage.thread_id == thread_id)
        .order_by(models.CoachAIMessage.id.desc())
        .limit(history_limit)
        .all()
    )
    recent.reverse()
    messages = [{"role": m.role, "content": m.message} for m in recent]
    topics = detect_topics(text, messages[:-1])

    # Cancellation is deterministic and confirmation-gated: chat resolves the
    # occurrence, then the shared calendar dialog performs the actual change.
    if _is_session_cancellation_request(text):
        cancellation_data = _resolve_cancellation_request(text, db)
        reply = _cancellation_reply(cancellation_data)
        db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
        db.commit()
        return {
            "reply": reply,
            "context_injected": [],
            "topics_detected": ["session_cancellation"],
            "suggested_action": None,
            "intent": {"type": "session_cancellation"},
            "saved_benchmarks": [],
            "saved_intents": [],
            "skill_result": None,
            "register_data": None,
            "cancellation_data": None if cancellation_data.get("error") else cancellation_data,
            "model_route": {"tier": "deterministic", "reason": "session_cancellation", "model": None},
            "tools_called": [],
        }

    # Registers are deterministic application state, not a question for the
    # language model. Resolve the exact date/slot and return the register card.
    if "register" in topics:
        register_data = _resolve_register_request(text, db)
        reply = _register_reply(register_data)
        db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
        db.commit()
        return {
            "reply": reply,
            "context_injected": [],
            "topics_detected": ["register"],
            "suggested_action": None,
            "intent": {"type": "register"},
            "saved_benchmarks": [],
            "saved_intents": [],
            "skill_result": None,
            "register_data": register_data,
            "model_route": {"tier": "deterministic", "reason": "register_workflow", "model": None},
            "tools_called": [],
        }

    # Choose system prompt based on thread type
    is_season_plan_thread = thread_obj and thread_obj.thread_type == "season_plan"
    is_athlete_plan_thread = thread_obj and thread_obj.thread_type == "athlete_planning"

    if is_season_plan_thread:
        from backend.services.claude_service import get_season_plan_system_prompt
        system = get_season_plan_system_prompt(db, macro_id=thread_obj.macro_id)
    elif is_athlete_plan_thread:
        from backend.services.claude_service import get_athlete_plan_system_prompt
        system = get_athlete_plan_system_prompt(db)
    else:
        system = get_system_prompt(
            db,
            include_squad_snapshot=False,
            include_recent_sessions=False,
            include_active_notes=False,
            include_approaching_targets=False,
        )
        if brief:
            system += "\n\nPOOLSIDE MODE: The coach is at the pool. Keep all responses under 5 sentences. Use bullet points. Lead with the most actionable finding. No background context, no caveats unless critical."

    memory = _thread_memory(thread_obj, recent, db, history_limit)
    if memory:
        system += f"\n\n---\n{memory}"

    # Build thread context string to pass to specialist skills
    from backend.routers.skills import _format_thread_context
    recent_thread_context = _format_thread_context(messages[:-1]) if len(messages) > 1 else ""
    thread_context = "\n\n".join(part for part in (memory, recent_thread_context) if part) or None

    # --- Season Plan Navigation (general thread only) ---
    if not is_season_plan_thread and not is_athlete_plan_thread and _is_season_plan_navigation(text):
        reply = "Opening the season planning chat for you."
        db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
        db.commit()
        return {
            "reply": reply,
            "context_injected": [],
            "topics_detected": ["season_plan_navigation"],
            "suggested_action": {"type": "open_season_plan_thread"},
            "intent": {"type": "season_plan_navigation"},
            "saved_benchmarks": [],
            "saved_intents": [],
            "skill_result": None,
        }

    # --- Athlete Plan Navigation (general thread only) ---
    if not is_season_plan_thread and not is_athlete_plan_thread and _is_athlete_plan_navigation(text):
        reply = "Opening the athlete planning chat for you."
        db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
        db.commit()
        return {
            "reply": reply,
            "context_injected": [],
            "topics_detected": ["athlete_plan_navigation"],
            "suggested_action": {"type": "open_athlete_plan_thread"},
            "intent": {"type": "athlete_plan_navigation"},
            "saved_benchmarks": [],
            "saved_intents": [],
            "skill_result": None,
        }

    # In a season plan thread, also route plan_macro requests
    if is_season_plan_thread and _is_macro_plan(text):
        from backend.routers.skills import run_plan_macro
        try:
            result = run_plan_macro(text, db, coach_context=thread_context)
            reply = result["reply"]
            draft = result.get("draft")
        except Exception as e:
            reply = f"I had trouble planning the macro: {str(e)}."
            draft = None

        db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
        db.commit()
        return {
            "reply": reply,
            "context_injected": [],
            "topics_detected": ["macro_plan"],
            "suggested_action": None,
            "intent": {"type": "macro_plan"},
            "saved_benchmarks": [],
            "saved_intents": [],
            "skill_result": {"type": "macro_plan", "draft": draft} if draft else None,
        }

    # --- Taper Planning Skill ---
    taper_swimmer_name = _is_taper_plan(text, db)
    if taper_swimmer_name:
        from backend.routers.skills import run_plan_taper
        try:
            result = run_plan_taper(taper_swimmer_name, db, coach_context=thread_context, brief=brief)
            reply = result["reply"]
        except Exception as e:
            reply = f"I had trouble planning the taper: {str(e)}."

        db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
        db.commit()
        return {
            "reply": reply,
            "context_injected": [taper_swimmer_name],
            "topics_detected": ["taper_plan"],
            "suggested_action": None,
            "intent": {"type": "taper_plan", "swimmer_name": taper_swimmer_name},
            "saved_benchmarks": [],
            "saved_intents": [],
            "skill_result": {
                "type": "taper_plan",
                "swimmer_id": result.get("swimmer_id"),
                "swimmer_name": result.get("swimmer_name"),
            },
        }

    # --- Meso Planning Skill ---
    # "What should the next block be?" type requests get the periodization specialist.
    if _is_meso_plan(text):
        from backend.routers.skills import run_plan_meso
        try:
            result = run_plan_meso(text, db, coach_context=thread_context, brief=brief)
            reply = result["reply"]
            draft = result.get("draft")
        except Exception as e:
            reply = f"I had trouble planning the meso: {str(e)}."
            draft = None

        db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
        db.commit()
        return {
            "reply": reply,
            "context_injected": [],
            "topics_detected": ["meso_planning"],
            "suggested_action": None,
            "intent": {"type": "meso_planning"},
            "saved_benchmarks": [],
            "saved_intents": [],
            "skill_result": {"type": "meso_plan", "draft": draft} if draft else None,
        }

    # --- Group Composition Skill ---
    if _is_suggest_groups(text):
        from backend.routers.skills import run_suggest_groups
        try:
            result = run_suggest_groups(text, db, coach_context=thread_context)
            reply = result["reply"]
            draft = result.get("draft")
        except Exception as e:
            reply = f"I had trouble analysing group composition: {str(e)}."
            draft = None

        db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
        db.commit()
        return {
            "reply": reply,
            "context_injected": [],
            "topics_detected": ["suggest_groups"],
            "suggested_action": None,
            "intent": {"type": "suggest_groups"},
            "saved_benchmarks": [],
            "saved_intents": [],
            "skill_result": {"type": "suggest_groups", "draft": draft} if draft else None,
        }

    # --- Micro Planning Skill ---
    if _is_micro_plan(text):
        from backend.routers.skills import run_plan_micro
        target_date = _extract_target_date(text)
        try:
            result = run_plan_micro(text, db, week_start=target_date, coach_context=thread_context)
            reply = result["reply"]
            draft = result.get("draft")
        except Exception as e:
            reply = f"I had trouble planning the week: {str(e)}."
            draft = None

        db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
        db.commit()
        return {
            "reply": reply,
            "context_injected": [],
            "topics_detected": ["micro_plan"],
            "suggested_action": None,
            "intent": {"type": "micro_plan"},
            "saved_benchmarks": [],
            "saved_intents": [],
            "skill_result": {"type": "micro_plan", "draft": draft} if draft else None,
        }

    # --- Race Analysis Skill ---
    # "How did we do at the meet?" type requests get the specialist post-meet analysis.
    race_meet_id = _is_race_analysis(text, db)
    if race_meet_id:
        from backend.routers.skills import run_race_analysis
        try:
            result = run_race_analysis(race_meet_id, db, coach_context=thread_context, brief=brief)
            reply = result["reply"]
        except Exception as e:
            reply = f"I had trouble running the race analysis: {str(e)}."

        db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
        db.commit()
        return {
            "reply": reply,
            "context_injected": [result.get("meet_name", "meet")],
            "topics_detected": ["race_analysis"],
            "suggested_action": None,
            "intent": {"type": "race_analysis", "meet_id": race_meet_id},
            "saved_benchmarks": [],
            "saved_intents": [],
            "skill_result": {
                "type": "race_analysis",
                "meet_id": race_meet_id,
                "meet_name": result.get("meet_name"),
            },
        }

    # --- Block Review Skill ---
    # "How did the last block go?" type requests get the squad-level meso analysis.
    review_block_id = _is_block_review(text, db)
    if review_block_id:
        from backend.routers.skills import run_block_review
        try:
            result = run_block_review(review_block_id, db, coach_context=thread_context, brief=brief)
            reply = result["reply"]
        except Exception as e:
            reply = f"I had trouble running the block review: {str(e)}."

        db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
        db.commit()
        return {
            "reply": reply,
            "context_injected": [result.get("block_name", "block")],
            "topics_detected": ["block_review"],
            "suggested_action": None,
            "intent": {"type": "block_review", "block_id": review_block_id},
            "saved_benchmarks": [],
            "saved_intents": [],
            "skill_result": {
                "type": "block_review",
                "block_id": review_block_id,
                "block_name": result.get("block_name"),
            },
        }

    # --- Swimmer Adaptation Review Skill ---
    # "How is [name] doing?" type requests get the systematic framework, not a general answer.
    review_swimmer_name = _is_swimmer_review(text, db)
    if review_swimmer_name:
        from backend.routers.skills import run_adaptation_review
        try:
            result = run_adaptation_review(review_swimmer_name, db, save_to_profile=True, coach_context=thread_context, brief=brief)
            reply = result["reply"]
        except Exception as e:
            reply = f"I had trouble running the adaptation review: {str(e)}."

        db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
        db.commit()
        return {
            "reply": reply,
            "context_injected": [review_swimmer_name],
            "topics_detected": ["adaptation_review"],
            "suggested_action": None,
            "intent": {"type": "adaptation_review", "swimmer_name": review_swimmer_name},
            "saved_benchmarks": [],
            "saved_intents": [],
            "skill_result": {
                "type": "adaptation_review",
                "swimmer_id": result.get("swimmer_id"),
                "swimmer_name": result.get("swimmer_name"),
            },
        }

    # --- Session Planning Skill ---
    # Explicit "generate a session" requests go to the specialized skill, not the general AI.
    if _is_session_generation(text):
        from backend.routers.skills import run_plan_session
        target_date = _extract_target_date(text)
        try:
            skill_result = run_plan_session(text, db, target_date=target_date, coach_context=thread_context, brief=brief)
            reply = skill_result["reply"]
            draft = skill_result["draft"]
        except Exception as e:
            reply = f"I had trouble generating the session: {str(e)}. Try asking again or use the manual session form."
            draft = None

        db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
        db.commit()
        return {
            "reply": reply,
            "context_injected": [],
            "topics_detected": ["session_planning"],
            "suggested_action": None,
            "intent": {"type": "session_planning"},
            "saved_benchmarks": [],
            "saved_intents": [],
            "skill_result": {"type": "session_plan", "draft": draft} if draft else None,
        }

    # Names are resolved for response metadata and optional confirmed captures.
    # The model retrieves the evidence it needs through compact read tools.
    mentioned_now = _find_mentioned_swimmers(text, db)
    resolved_swimmers = _all_mentioned_swimmers(messages, db)
    if resolved_swimmers:
        resolved_lines = "\n".join(
            f"- {swimmer.name}: swimmer_id={swimmer.id}"
            for swimmer in resolved_swimmers[:6]
        )
        system += f"""

---
RESOLVED DATABASE IDENTITIES:
{resolved_lines}
Use these IDs directly with read tools; do not call find_swimmer for these athletes.
Call independent read tools together in the same response where possible."""

    tools = get_tools()
    loop_messages = list(messages)
    route = choose_agent_route(
        text,
        topics,
        thread_obj.thread_type if thread_obj else None,
    )
    selected_model = FAST_MODEL if route.tier == "fast" else MODEL
    planning_request = (
        is_season_plan_thread or is_athlete_plan_thread
        or 'planning' in topics or 'session_writing' in topics
    )
    selected_effort = PLANNING_EFFORT if selected_model == MODEL and planning_request else None
    response_tokens = 900 if route.tier == "fast" else 1500

    response = get_client().messages.create(
        operation="general_agent_initial",
        model=selected_model,
        effort=selected_effort,
        max_tokens=response_tokens,
        system=system,
        messages=loop_messages,
        tools=tools,
        cache_control={"type": "ephemeral"},
    )

    # Tool-calling loop — bounded by route to prevent runaway cost
    tools_called = set()
    if route.tier == "fast":
        max_tool_rounds = 2
    elif is_season_plan_thread or 'planning' in topics or 'session_writing' in topics:
        max_tool_rounds = 4
    else:
        max_tool_rounds = 3
    completed_tool_calls = set()
    for _ in range(max_tool_rounds):
        if response.stop_reason != "tool_use":
            break
        tool_uses = [b for b in response.content if b.type == "tool_use"]
        tool_results = []
        for tu in tool_uses:
            tools_called.add(tu.name)
            call_key = (tu.name, json.dumps(tu.input, sort_keys=True, default=str))
            if call_key in completed_tool_calls:
                result = f"Tool '{tu.name}' was already called with these inputs; use the existing result."
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": result,
                })
                continue
            completed_tool_calls.add(call_key)
            try:
                result = execute_tool(tu.name, tu.input, db)
            except Exception as e:
                result = f"Tool '{tu.name}' failed: {str(e)}"
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tu.id,
                "content": result,
            })
        loop_messages = loop_messages + [
            {"role": "assistant", "content": response.content},
            {"role": "user", "content": tool_results},
        ]
        response = get_client().messages.create(
            operation="general_agent_tool_followup",
            model=selected_model,
            effort=selected_effort,
            max_tokens=response_tokens,
            system=system,
            messages=loop_messages,
            tools=tools,
            cache_control={"type": "ephemeral"},
        )

    reply = next((b.text for b in response.content if hasattr(b, "text")), "").strip()
    if not reply:
        reply = "Done." if tools_called else "I'm not sure how to respond to that — could you rephrase?"
    db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
    db.commit()

    # Secondary operations — none of these should crash the endpoint after reply is saved
    intent = {"intent": "general", "suggested_action": None}
    saved_benchmarks = []
    saved_intents = []
    try:
        intent = _conversation_action(text, topics, messages, resolved_swimmers)
    except Exception:
        pass

    return {
        "reply": reply,
        "context_injected": [s.name for s in mentioned_now],
        "topics_detected": list(topics),
        "suggested_action": intent.get("suggested_action"),
        "intent": {
            "type": intent.get("intent"),
            "swimmer_id": intent.get("swimmer_id"),
            "swimmer_name": intent.get("swimmer_name"),
            "new_status": intent.get("new_status"),
        },
        "saved_benchmarks": saved_benchmarks,
        "saved_intents": saved_intents,
        "model_route": {
            "tier": route.tier,
            "reason": route.reason,
            "model": selected_model,
        },
        "tools_called": sorted(tools_called),
    }


@router.post("/actions/save-benchmark")
def save_benchmark_action(body: dict = Body(...), db: DBSession = Depends(get_db)):
    """Extract and save a benchmark only after the coach confirms the action."""
    swimmer_id = body.get("swimmer_id")
    conversation = str(body.get("conversation") or "").strip()
    swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
    if not swimmer:
        raise HTTPException(status_code=404, detail="Swimmer not found")
    if not conversation:
        raise HTTPException(status_code=400, detail="Conversation required")
    saved = extract_benchmarks_from_conversation(conversation, [swimmer], db)
    return {"saved": saved}


@router.post("/actions/save-coaching-intent")
def save_coaching_intent_action(body: dict = Body(...), db: DBSession = Depends(get_db)):
    """Extract and save a coaching intent only after the coach confirms the action."""
    swimmer_id = body.get("swimmer_id")
    conversation = str(body.get("conversation") or "").strip()
    swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
    if not swimmer:
        raise HTTPException(status_code=404, detail="Swimmer not found")
    if not conversation:
        raise HTTPException(status_code=400, detail="Conversation required")
    saved = extract_coaching_intent(conversation, [swimmer], db)
    return {"saved": saved}


@router.post("/actions/update-athlete-profile")
def update_athlete_profile_action(body: dict = Body(...), db: DBSession = Depends(get_db)):
    """Update a swimmer profile from a confirmed chat conversation."""
    swimmer_id = body.get("swimmer_id")
    swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
    if not swimmer:
        raise HTTPException(status_code=404, detail="Swimmer not found")

    messages = []
    for item in (body.get("messages") or [])[-30:]:
        role = item.get("role") if isinstance(item, dict) else None
        content = str(item.get("content") or "").strip() if isinstance(item, dict) else ""
        if role in {"user", "assistant"} and content:
            messages.append({"role": role, "content": content[:4000]})
    if not messages:
        raise HTTPException(status_code=400, detail="Conversation messages required")

    saved = save_wizard_profile(swimmer, messages, db, preserve_existing=True)
    return {"saved": saved}


def _build_extraction_prompt(conversation: str, today: str) -> str:
    return f"""Extract a structured training session from this coaching conversation. Today's date: {today}.

CONVERSATION:
{conversation}

Return JSON:
{{
  "title": "session title",
  "date": "YYYY-MM-DD — use the date discussed, or today if not specified",
  "squad": "squad name if mentioned, else null",
  "energy_system_focus": "aerobic / threshold / vo2max / speed_endurance / sprint / recovery / mixed",
  "coach_intent": "1-2 sentences: why this session, what's the training goal",
  "groups": [
    {{
      "group_number": 1,
      "description": "Overall group description and load level",
      "sub_groups": [
        {{
          "label": "A",
          "aim": "Sprint focus — stroke rate and underwaters",
          "sets": ["8x50 @ race pace 1:00", "4x25 fast + 25 easy"],
          "swimmer_names": ["Tom", "Jake"]
        }},
        {{
          "label": "B",
          "aim": "Distance base — aerobic engine",
          "sets": ["4x200 @ threshold 30s", "8x100 descending"],
          "swimmer_names": ["Sarah", "Emily"]
        }}
      ]
    }}
  ]
}}

Rules:
- Include all groups discussed (typically 1-3)
- Sets should be as specific as the conversation allows — use the actual distances/reps/rest if mentioned
- If a set wasn't fleshed out, mark it as "TBC"
- Create sub-groups within each group when swimmers have different event profiles (sprint vs distance), different training needs, or different sets were discussed. Use gender, age, target events, and any individual notes from the conversation to cluster. If all swimmers in a group are doing the same sets, one sub-group is fine.
- If no sub-groups were discussed, still output one sub-group per group with all swimmers in it (label "A")
- Return only valid JSON"""


def _parse_sub_group_volumes(sets: list) -> dict:
    """Parse a list of set descriptions and estimate metres per energy system."""
    import json
    if not sets:
        return {}
    prompt = f"""Parse these swimming training sets and estimate the total metres for each energy system category.

Sets:
{chr(10).join(f'- {s}' for s in sets)}

Return JSON only with these exact keys (use 0 for categories not present):
{{"aerobic": 0, "threshold": 0, "vo2": 0, "race_pace": 0, "lact_tol": 0, "short_race_pace": 0, "kicking": 0, "sprint": 0}}

Guidelines:
- aerobic: steady-state, long reps, low intensity (e.g. 400s/800s easy, long sets)
- threshold: controlled hard effort, 3-5 min pace (e.g. "threshold", "T-pace", cruise intervals)
- vo2: hard intervals, 2-3 min pace (e.g. "VO2", hard 200s/400s with recovery)
- race_pace: event-specific pace (e.g. "race pace", "RP", "competition pace")
- lact_tol: very hard repeated efforts with incomplete recovery (e.g. "lact tol", "LT", red sets)
- short_race_pace: fast short efforts 10-50m at race pace or faster
- kicking: kick sets of any intensity (count the distance kicked)
- sprint: maximal effort sprints, usually ≤50m (e.g. "all out", "max effort", "blast")

If a set says "8x100" assume 100m per rep. Count warm-up/cool-down as aerobic.
Return only valid JSON, no explanation."""

    try:
        response = get_client().messages.create(
            model=FAST_MODEL, max_tokens=300,
            messages=[{"role": "user", "content": prompt}]
        )
        return json.loads(_strip_json(response.content[0].text))
    except Exception:
        return {}


def _save_session_from_data(data: dict, db: DBSession) -> int:
    """Save a session dict (from extraction or draft edit) to DB. Returns session_id."""
    import json as _json
    from datetime import date as date_type, datetime

    today = date_type.today().isoformat()
    try:
        session_date = datetime.strptime(data.get("date", today), "%Y-%m-%d").date()
    except Exception:
        session_date = date_type.today()

    session = models.Session(
        date=session_date,
        title=data.get("title", "AI-designed session"),
        squad=data.get("squad"),
        energy_system_focus=data.get("energy_system_focus"),
        coach_intent=data.get("coach_intent"),
        individual_mods=data.get("individual_mods") or None,
        source="ai_chat",
    )
    db.add(session)
    db.flush()

    all_swimmers = db.query(models.Swimmer).filter(models.Swimmer.status == 'active').all()
    name_map = {s.name.lower(): s.id for s in all_swimmers}
    for s in all_swimmers:
        first = s.name.split()[0].lower()
        if first not in name_map:
            name_map[first] = s.id

    for grp in (data.get("groups") or []):
        # Collect all swimmer names across sub-groups for the group-level target_swimmer_ids
        all_sg_swimmer_names = []
        for sg_data in (grp.get("sub_groups") or []):
            all_sg_swimmer_names.extend(sg_data.get("swimmer_names") or [])
        # Fall back to group-level swimmer_names if sub_groups not present
        group_swimmer_names = grp.get("swimmer_names") or all_sg_swimmer_names
        swimmer_ids = [name_map[n.lower()] for n in group_swimmer_names if n.lower() in name_map]

        group_obj = models.SessionGroup(
            session_id=session.id,
            group_number=grp.get("group_number", 1),
            description=grp.get("description", ""),
            sets=grp.get("sets") or [],
            target_swimmer_ids=swimmer_ids,
            volume_breakdown=grp.get("volume_breakdown") or None,
        )
        db.add(group_obj)
        db.flush()  # get group_obj.id

        for sg_data in (grp.get("sub_groups") or []):
            swimmer_ids_sg = [name_map[n.lower()] for n in (sg_data.get("swimmer_names") or []) if n.lower() in name_map]
            sets_list = sg_data.get("sets") or []
            volumes = _parse_sub_group_volumes(sets_list)
            db.add(models.SessionSubGroup(
                session_group_id=group_obj.id,
                label=sg_data.get("label", "A"),
                aim=sg_data.get("aim"),
                sets=sets_list,
                swimmer_ids=swimmer_ids_sg,
                volume_breakdown=volumes,
            ))

    db.commit()
    db.refresh(session)
    return session.id


@router.post("/extract-session")
def extract_session_draft(body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    """Extract session structure from conversation — returns draft JSON without saving."""
    import json
    from datetime import date as date_type

    thread_id = body.get("thread_id")
    q = db.query(models.CoachAIMessage)
    if thread_id is not None:
        q = q.filter(models.CoachAIMessage.thread_id == thread_id)
    all_msgs = q.order_by(models.CoachAIMessage.id.desc()).limit(40).all()
    all_msgs.reverse()
    if not all_msgs:
        raise HTTPException(status_code=400, detail="No conversation to extract from")

    conversation = "\n".join(
        f"{'Coach' if m.role == 'user' else 'AI'}: {m.message}" for m in all_msgs
    )
    today = date_type.today().isoformat()

    response = get_client().messages.create(
        model=FAST_MODEL,
        max_tokens=1200,
        messages=[{"role": "user", "content": _build_extraction_prompt(conversation, today)}],
    )

    data = json.loads(_strip_json(response.content[0].text))
    return data  # draft only — nothing saved


@router.post("/create-session")
def create_session_from_chat(body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    """Save a confirmed session draft to the DB. Accepts the pre-edited draft directly."""
    if not body:
        raise HTTPException(status_code=400, detail="Session data required")
    try:
        session_id = _save_session_from_data(body, db)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save session: {str(e)}")
    session = db.query(models.Session).filter(models.Session.id == session_id).first()
    return {"session_id": session_id, "title": session.title, "date": session.date.isoformat()}


@router.post("/messages-with-image")
async def send_message_with_image(
    message: str = Form(default=""),
    image: UploadFile = File(...),
    thread_id: Optional[int] = Form(default=None),
    db: DBSession = Depends(get_db),
):
    """Send a message with an attached image. Claude reads the image inline."""
    image_bytes = await image.read()
    media_type = image.content_type or "image/jpeg"
    image_b64 = base64.standard_b64encode(image_bytes).decode("utf-8")

    text = message.strip() or "Here's a session photo."

    # Save user message (text only for history — image is transient)
    display_text = f"[Photo attached] {text}" if text != "Here's a session photo." else "[Photo: session whiteboard]"
    db.add(models.CoachAIMessage(role="user", message=display_text, thread_id=thread_id))
    db.commit()

    # Build history for this thread
    thread_obj = db.query(models.AIThread).filter(models.AIThread.id == thread_id).first() if thread_id else None
    history_limit = MAX_HISTORY  # image/session planning keeps the richer planning window
    recent = (
        db.query(models.CoachAIMessage)
        .filter(models.CoachAIMessage.thread_id == thread_id)
        .order_by(models.CoachAIMessage.id.desc())
        .limit(history_limit)
        .all()
    )
    recent.reverse()
    history = [{"role": m.role, "content": m.message} for m in recent[:-1]]  # exclude the message we just added

    # Always inject session writing context for photo messages
    slot_hint = extract_slot_hint(text)
    session_ctx = build_session_writing_context(db, slot_hint)
    system = get_system_prompt(db)
    memory = _thread_memory(thread_obj, recent, db, history_limit)
    if memory:
        system += f"\n\n---\n{memory}"
    if session_ctx:
        system += f"\n\n---\nSESSION WRITING MODE — extracting session from photo. Use slot and attendee context below.\n{session_ctx}"

    # Multimodal user message: image + text
    user_content = [
        {
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": image_b64},
        },
        {
            "type": "text",
            "text": f"{text}\n\nPlease read this session photo and extract the training content. Identify the groups (Group 1/2/3 or A/B/C or similar), the sets for each group, and any swimmer names if visible. Then recommend which of the expected attendees (from the context above) should be in each group, with brief reasoning. Present it clearly so we can confirm before creating the session.",
        },
    ]

    loop_messages_img = history + [{"role": "user", "content": user_content}]

    tools = get_tools()
    response = get_client().messages.create(
        model=MODEL,
        effort=PLANNING_EFFORT,
        max_tokens=1500,
        system=system,
        messages=loop_messages_img,
        tools=tools,
        cache_control={"type": "ephemeral"},
    )

    # Tool-calling loop — retain planning depth without allowing runaway repeats.
    tools_called_img = set()
    completed_tool_calls_img = set()
    for _ in range(4):
        if response.stop_reason != "tool_use":
            break
        tool_uses = [b for b in response.content if b.type == "tool_use"]
        tool_results = []
        for tu in tool_uses:
            tools_called_img.add(tu.name)
            call_key = (tu.name, json.dumps(tu.input, sort_keys=True, default=str))
            if call_key in completed_tool_calls_img:
                result = f"Tool '{tu.name}' was already called with these inputs; use the existing result."
            else:
                completed_tool_calls_img.add(call_key)
                result = execute_tool(tu.name, tu.input, db)
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tu.id,
                "content": result,
            })
        loop_messages_img = loop_messages_img + [
            {"role": "assistant", "content": response.content},
            {"role": "user", "content": tool_results},
        ]
        response = get_client().messages.create(
            model=MODEL,
            effort=PLANNING_EFFORT,
            max_tokens=1500,
            system=system,
            messages=loop_messages_img,
            tools=tools,
            cache_control={"type": "ephemeral"},
        )

    reply = next((b.text for b in response.content if hasattr(b, "text")), "").strip()
    db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
    db.commit()

    # A photographed session always uses the explicit review-and-create flow.
    # It needs neither an extra classifier call nor background profile writes.
    topics = detect_topics(text, history[-6:])

    return {
        "reply": reply,
        "context_injected": [],
        "topics_detected": list(topics) or ["session_writing"],
        "suggested_action": "Review & create session",
        "intent": {
            "type": "session_writing",
            "swimmer_id": None,
            "swimmer_name": None,
        },
        "saved_benchmarks": [],
        "saved_intents": [],
    }


@router.post("/create-meet")
def create_meet_from_chat(body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    """Extract a meet + swimmer entries from the current conversation and save to DB."""
    import json
    from datetime import date as date_type

    thread_id = body.get("thread_id")
    q = db.query(models.CoachAIMessage)
    if thread_id is not None:
        q = q.filter(models.CoachAIMessage.thread_id == thread_id)
    all_msgs = q.order_by(models.CoachAIMessage.id.desc()).limit(30).all()
    all_msgs.reverse()
    if not all_msgs:
        raise HTTPException(status_code=400, detail="No conversation to extract meet from")

    conversation = "\n".join(
        f"{'Coach' if m.role == 'user' else 'AI'}: {m.message}" for m in all_msgs
    )
    today = date_type.today().isoformat()

    extraction_prompt = f"""Extract a competition meet and swimmer entries from this coaching conversation. Today's date: {today}.

CONVERSATION:
{conversation}

Return JSON:
{{
  "name": "meet name",
  "date": "YYYY-MM-DD — start date",
  "date_to": "YYYY-MM-DD — end date if multi-day, else same as date",
  "location": "venue/city or null",
  "course": "SCM or LCM or null",
  "level": "club / regional / national / international or null",
  "notes": "any other context mentioned, or null",
  "entries": [
    {{
      "swimmer_name": "first name or full name",
      "events": ["100 Freestyle", "200 Breaststroke"],
      "priority": "A or B or C — A=peak target, B=good swim, C=experience. Default B if not discussed.",
      "target_times": {{"100 Freestyle": "58.50"}} or null
    }}
  ]
}}

Rules:
- Use full event names like "100 Freestyle", "200 Breaststroke SCM" etc.
- Include every swimmer mentioned with their events
- Return only valid JSON"""

    response = get_client().messages.create(
        model=FAST_MODEL,
        max_tokens=800,
        messages=[{"role": "user", "content": extraction_prompt}],
    )

    data = json.loads(_strip_json(response.content[0].text))

    from datetime import datetime
    def parse_date(s):
        try:
            return datetime.strptime(s, "%Y-%m-%d").date() if s else None
        except Exception:
            return None

    meet = models.Meet(
        name=data.get("name", "Meet"),
        date=parse_date(data.get("date")),
        date_to=parse_date(data.get("date_to")),
        location=data.get("location"),
        course=data.get("course"),
        level=data.get("level"),
        notes=data.get("notes"),
    )
    db.add(meet)
    db.flush()

    # Resolve swimmer names and create targets
    all_swimmers = db.query(models.Swimmer).filter(models.Swimmer.status == 'active').all()
    name_map = {s.name.lower(): s.id for s in all_swimmers}
    for s in all_swimmers:
        first = s.name.split()[0].lower()
        if first not in name_map:
            name_map[first] = s.id

    for entry in (data.get("entries") or []):
        swimmer_id = name_map.get(entry.get("swimmer_name", "").lower())
        if not swimmer_id:
            continue
        target = models.MeetTarget(
            meet_id=meet.id,
            swimmer_id=swimmer_id,
            events=entry.get("events", []),
            priority=entry.get("priority", "B"),
            target_times=entry.get("target_times"),
        )
        db.add(target)

    db.commit()
    db.refresh(meet)
    return {"meet_id": meet.id, "name": meet.name, "date": meet.date.isoformat() if meet.date else None}


@router.post("/start-register")
def start_register(body: dict = Body(...), db: DBSession = Depends(get_db)):
    """
    Identify the session for a register from day/time hint and return expected attendees.
    Called when coach says 'let's take a register for Monday PM'.
    """
    return _resolve_register_request(body.get("message", ""), db)


@router.post("/parse-register")
def parse_register(body: dict = Body(...), db: DBSession = Depends(get_db)):
    """
    Parse a freetext attendance description into a structured register.
    e.g. "everyone's here except Tom and Sarah, Tom's injured"
    """
    import json

    session_id = body.get("session_id")
    message = body.get("message", "")
    attendees = body.get("attendees", [])  # full active squad list

    if not attendees:
        raise HTTPException(status_code=400, detail="Attendees list required")

    attendee_list = "\n".join(
        f"- {a['name']} (usual for this slot: {'yes' if a.get('usual_for_slot') else 'no'})"
        for a in attendees
    )

    parse_prompt = f"""Parse this attendance message into a register for the following swimmers.

ACTIVE SQUAD REGISTER (every swimmer must remain in the result):
{attendee_list}

COACH'S MESSAGE: "{message}"

Return JSON:
{{
  "attendance": [
    {{
      "name": "swimmer name exactly as listed above",
      "present": true or false,
      "group": 1 or 2 or 3 or null,
      "note": "any observation mentioned, or null"
    }}
  ]
}}

Rules:
- If coach says "everyone except X" → mark all present except named
- If coach says "present: A, B, C" → mark only those as present
- Group assignment: if coach says "Group 1/2/3" or "A group/B group" map to 1/2/3
- If group not mentioned, use null
- Return only valid JSON"""

    response = get_client().messages.create(
        model=FAST_MODEL,
        max_tokens=600,
        messages=[{"role": "user", "content": parse_prompt}],
    )

    data = json.loads(_strip_json(response.content[0].text))

    # Match parsed names back to IDs
    name_to_id = {a['name'].lower(): a['id'] for a in attendees}
    first_to_id = {}
    for a in attendees:
        first = a['name'].split()[0].lower()
        if first not in first_to_id:
            first_to_id[first] = a['id']

    result = []
    for entry in (data.get("attendance") or []):
        name = entry.get("name", "").lower()
        sid = name_to_id.get(name) or first_to_id.get(name.split()[0] if name else "")
        if sid:
            result.append({
                "swimmer_id": sid,
                "name": entry.get("name"),
                "present": entry.get("present", False),
                "group": entry.get("group"),
                "note": entry.get("note"),
            })

    return {"session_id": session_id, "attendance": result}


@router.post("/submit-register")
def submit_register(body: dict = Body(...), db: DBSession = Depends(get_db)):
    """Save a confirmed attendance list as SessionEntry records."""
    session_id = body.get("session_id")
    attendance = body.get("attendance", [])

    if not session_id:
        raise HTTPException(status_code=400, detail="session_id required")

    session = db.query(models.Session).filter(models.Session.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Remove existing entries for this session (allow re-submission)
    db.query(models.SessionEntry).filter(models.SessionEntry.session_id == session_id).delete()

    for entry in attendance:
        db.add(models.SessionEntry(
            session_id=session_id,
            swimmer_id=entry["swimmer_id"],
            attended=entry.get("present", False),
            group_done=entry.get("group"),
            coach_observation=entry.get("note"),
        ))

    db.commit()

    # Feedback loop — if this session was AI-planned, prompt the coach for a quality check
    feedback_prompt = None
    if session.source in ("ai_chat", "skill") and session.coach_intent:
        attended_count = sum(1 for e in attendance if e.get("present", False))
        feedback_prompt = (
            f"Register saved ({attended_count} attended). "
            f"The session intent was: *{session.coach_intent[:150]}* — "
            f"how did it go? Did the session achieve what was planned?"
        )

    return {"saved": len(attendance), "session_id": session_id, "feedback_prompt": feedback_prompt}


@router.post("/pin-to-sessions")
def pin_to_sessions(body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    """Summarise current conversation into a coaching note for pinning."""
    thread_id = body.get("thread_id")
    q = db.query(models.CoachAIMessage)
    if thread_id is not None:
        q = q.filter(models.CoachAIMessage.thread_id == thread_id)
    all_msgs = q.order_by(models.CoachAIMessage.id.desc()).limit(30).all()
    all_msgs.reverse()
    if not all_msgs:
        raise HTTPException(status_code=400, detail="No conversation to pin")

    conversation = "\n".join(
        f"{'Coach' if m.role == 'user' else 'AI'}: {m.message}" for m in all_msgs
    )

    summary_prompt = f"""The following is a coaching conversation. Extract a concise coaching note that can be pinned to session planning for a specific date range.

CONVERSATION:
{conversation}

Return JSON:
{{
  "title": "short title (e.g. 'Tom — Coventry LC prep this week')",
  "body": "3-6 bullet points covering: the situation, the plan for each session, key things to watch, what to do after the event",
  "swimmer_names": ["list of swimmer first names mentioned"]
}}

Return only valid JSON."""

    response = get_client().messages.create(
        model=FAST_MODEL,
        max_tokens=600,
        messages=[{"role": "user", "content": summary_prompt}],
    )

    import json
    from backend.services.claude_service import _strip_json
    data = json.loads(_strip_json(response.content[0].text))

    swimmer_names = data.get("swimmer_names", [])
    swimmer_ids = []
    resolved_names = []
    for name in swimmer_names:
        match = db.query(models.Swimmer).filter(
            models.Swimmer.name.ilike(f"%{name}%"),
            models.Swimmer.status == 'active'
        ).first()
        if match:
            swimmer_ids.append(match.id)
            resolved_names.append(match.name)

    return {
        "title": data.get("title", "Coaching note"),
        "body": data.get("body", ""),
        "swimmer_ids": swimmer_ids,
        "swimmer_names": resolved_names,
    }


@router.post("/transcribe")
async def transcribe_audio(audio: UploadFile = File(...)):
    """Transcribe an audio file using OpenAI Whisper. Returns {text: '...'}."""
    import io, os
    import openai as _openai

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not configured on server")

    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="No audio data received")

    filename = audio.filename or "audio.webm"

    try:
        client = _openai.OpenAI(api_key=api_key)
        buf = io.BytesIO(audio_bytes)
        buf.name = filename
        transcript = client.audio.transcriptions.create(model=TRANSCRIPTION_MODEL, file=buf)
        usage = getattr(transcript, "usage", None)
        record_ai_usage(
            "openai",
            TRANSCRIPTION_MODEL,
            "transcribe_audio",
            input_tokens=getattr(usage, "input_tokens", 0) if usage else 0,
            output_tokens=getattr(usage, "output_tokens", 0) if usage else 0,
        )
        return {"text": transcript.text}
    except _openai.AuthenticationError:
        raise HTTPException(status_code=500, detail="Invalid OpenAI API key — check server config")
    except _openai.RateLimitError:
        raise HTTPException(status_code=429, detail="OpenAI rate limit reached — try again shortly")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription error: {str(e)}")


@router.delete("/messages")
def clear_messages(thread_id: Optional[int] = None, db: DBSession = Depends(get_db)):
    q = db.query(models.CoachAIMessage)
    if thread_id is not None:
        q = q.filter(models.CoachAIMessage.thread_id == thread_id)
    q.delete()
    if thread_id is not None:
        thread = db.query(models.AIThread).filter(models.AIThread.id == thread_id).first()
        if thread:
            thread.rolling_summary = None
            thread.summarized_through_message_id = None
            thread.summary_updated_at = None
    db.commit()
    return {"cleared": True}


@router.get("/context-status")
def context_status(db: DBSession = Depends(get_db)):
    profile = (
        db.query(models.CoachingProfile)
        .filter(models.CoachingProfile.is_current == True)
        .first()
    )
    if not profile:
        return {"active": False}
    return {"active": True, "title": profile.title, "created_at": profile.created_at}


@router.get("/usage")
def ai_usage(days: int = 30, db: DBSession = Depends(get_db)):
    """Return aggregate AI usage only; prompts and coaching data are never logged here."""
    days = max(1, min(days, 365))
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (
        db.query(models.AIUsageLog)
        .filter(models.AIUsageLog.created_at >= cutoff)
        .all()
    )
    def empty_counters():
        return {
            "calls": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "estimated_cost_usd": 0.0,
        }

    totals = empty_counters()
    by_model = {}
    by_operation = {}
    for row in rows:
        key = f"{row.provider}:{row.model}"
        item = by_model.setdefault(
            key,
            {"provider": row.provider, "model": row.model, **empty_counters()},
        )
        operation_key = row.operation or "unknown"
        operation_item = by_operation.setdefault(
            operation_key,
            {"operation": operation_key, **empty_counters()},
        )
        for target in (totals, item, operation_item):
            target["calls"] += 1
            target["input_tokens"] += row.input_tokens or 0
            target["output_tokens"] += row.output_tokens or 0
            target["cache_read_tokens"] += row.cache_read_tokens or 0
            target["cache_write_tokens"] += row.cache_write_tokens or 0
            target["estimated_cost_usd"] += row.estimated_cost_usd or 0
    totals["estimated_cost_usd"] = round(totals["estimated_cost_usd"], 6)
    for item in by_model.values():
        item["estimated_cost_usd"] = round(item["estimated_cost_usd"], 6)
    for item in by_operation.values():
        item["estimated_cost_usd"] = round(item["estimated_cost_usd"], 6)
    return {
        "days": days,
        "totals": totals,
        "by_model": sorted(by_model.values(), key=lambda x: x["estimated_cost_usd"], reverse=True),
        "by_operation": sorted(
            by_operation.values(),
            key=lambda x: x["estimated_cost_usd"],
            reverse=True,
        ),
        "configuration": {
            "primary_model": MODEL,
            "fast_model": FAST_MODEL,
            "primary_effort": PRIMARY_EFFORT,
            "planning_effort": PLANNING_EFFORT,
            "transcription_model": TRANSCRIPTION_MODEL,
            "history_messages": MAX_HISTORY,
            "history_limits": {
                "general": GENERAL_HISTORY,
                "athlete_planning": ATHLETE_HISTORY,
                "season_planning": MAX_HISTORY,
            },
            "summary_batch_messages": SUMMARY_BATCH_SIZE,
            "summary_character_limit": SUMMARY_CHAR_LIMIT,
            "routine_coaching_context_character_limit": COACHING_CONTEXT_CHAR_LIMIT,
            "memory_strategy": "rolling summary + bounded recent history + task-scoped database retrieval",
            "general_agent_routing": "fast model for short factual retrieval; primary model for coaching judgement and planning",
            "general_agent_write_policy": "read-only tools with confirmation or draft review for changes",
            "general_agent_tools": [tool["name"] for tool in get_tools()],
        },
    }
