import base64
from fastapi import APIRouter, Depends, HTTPException, Body, UploadFile, File, Form
from typing import Optional
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models
from backend.services.claude_service import (
    get_client, MODEL, get_system_prompt, get_swimmer_full_context,
    build_meets_context, build_periodization_context, build_session_writing_context,
    detect_topics, extract_slot_hint, classify_intent, _strip_json,
    extract_benchmarks_from_conversation, extract_coaching_intent,
    get_tools, execute_tool,
)

router = APIRouter()

MAX_HISTORY = 40

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
    msgs = q.order_by(models.CoachAIMessage.created_at.asc()).all()
    return [{"id": m.id, "role": m.role, "message": m.message, "created_at": m.created_at} for m in msgs]


@router.post("/messages")
def send_message(body: dict = Body(...), db: DBSession = Depends(get_db)):
    text = body.get("message", "").strip()
    thread_id = body.get("thread_id")
    brief = body.get("brief", False)
    if not text:
        raise HTTPException(status_code=400, detail="Message required")

    db.add(models.CoachAIMessage(role="user", message=text, thread_id=thread_id))
    db.commit()

    all_msgs = (
        db.query(models.CoachAIMessage)
        .filter(models.CoachAIMessage.thread_id == thread_id)
        .order_by(models.CoachAIMessage.created_at.asc())
        .all()
    )
    recent = all_msgs[-MAX_HISTORY:]
    messages = [{"role": m.role, "content": m.message} for m in recent]

    # Choose system prompt based on thread type
    thread_obj = db.query(models.AIThread).filter(models.AIThread.id == thread_id).first() if thread_id else None
    is_season_plan_thread = thread_obj and thread_obj.thread_type == "season_plan"
    is_athlete_plan_thread = thread_obj and thread_obj.thread_type == "athlete_planning"

    if is_season_plan_thread:
        from backend.services.claude_service import get_season_plan_system_prompt
        system = get_season_plan_system_prompt(db, macro_id=thread_obj.macro_id)
    elif is_athlete_plan_thread:
        from backend.services.claude_service import get_athlete_plan_system_prompt
        system = get_athlete_plan_system_prompt(db)
    else:
        system = get_system_prompt(db)
        if brief:
            system += "\n\nPOOLSIDE MODE: The coach is at the pool. Keep all responses under 5 sentences. Use bullet points. Lead with the most actionable finding. No background context, no caveats unless critical."

    # Detect topics from current message + recent history to decide what extra context to inject
    topics = detect_topics(text, messages[:-1])

    # Build thread context string to pass to specialist skills
    from backend.routers.skills import _format_thread_context
    thread_context = _format_thread_context(messages[:-1]) if len(messages) > 1 else None

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

    if 'competition' in topics:
        meets_ctx = build_meets_context(db)
        if meets_ctx:
            system += f"\n\n---\n{meets_ctx}"

    if 'planning' in topics:
        period_ctx = build_periodization_context(db)
        if period_ctx:
            system += f"\n\n---\n{period_ctx}"

    if 'register' in topics:
        # Inject register context — find likely session and list expected attendees
        from datetime import date as date_type, timedelta as tdelta
        slot_hint = extract_slot_hint(text)
        today_d = date_type.today()
        recent_sessions = (
            db.query(models.Session)
            .filter(
                models.Session.date >= today_d - tdelta(days=3),
                models.Session.date <= today_d,
                models.Session.status != 'cancelled',
            )
            .order_by(models.Session.date.desc())
            .limit(5)
            .all()
        )
        if recent_sessions:
            reg_lines = ["RECENT SESSIONS AVAILABLE FOR REGISTER:"]
            for s in recent_sessions:
                entries = db.query(models.SessionEntry).filter(models.SessionEntry.session_id == s.id).count()
                status = "register taken" if entries > 0 else "no register yet"
                reg_lines.append(f"  {s.date} | {s.title or 'Session'} | {status}")
            system += "\n\n---\n" + "\n".join(reg_lines)
            system += "\n\nREGISTER MODE — help the coach identify which session to register, then ask who attended and what groups they were in."

    if 'session_writing' in topics:
        slot_hint = extract_slot_hint(text)
        session_ctx = build_session_writing_context(db, slot_hint)
        if session_ctx:
            system += f"\n\n---\nSESSION MODE — you are either helping design a session or reviewing one the coach has proposed. Either way, use the context below.\n\nIf the coach is proposing/describing their own session: act as a reviewer. Check it against the energy system distribution, stated intents, and individual swimmer needs listed below. Flag genuine concerns — patterns, gaps, mismatches with stated goals — but don't manufacture issues. One well-placed question or observation is better than a list.\n\nIf the coach is asking you to generate a session: propose one, but explain the reasoning — why this energy system, why this structure, what it does for these swimmers.\n\n{session_ctx}"

    # Inject full profiles for any swimmers mentioned by name in this message
    mentioned_now = _find_mentioned_swimmers(text, db)
    if mentioned_now:
        profiles_block = "\n\n".join(get_swimmer_full_context(s, db) for s in mentioned_now)
        system += f"\n\n---\n{profiles_block}"

    tools = get_tools()
    loop_messages = list(messages)

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1500,
        system=system,
        messages=loop_messages,
        tools=tools,
    )

    # Tool-calling loop — max 5 iterations to prevent runaway
    tools_called = set()
    for _ in range(5):
        if response.stop_reason != "tool_use":
            break
        tool_uses = [b for b in response.content if b.type == "tool_use"]
        tool_results = []
        for tu in tool_uses:
            tools_called.add(tu.name)
            result = execute_tool(tu.name, tu.input, db)
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
            model=MODEL,
            max_tokens=1500,
            system=system,
            messages=loop_messages,
            tools=tools,
        )

    reply = next((b.text for b in response.content if hasattr(b, "text")), "").strip()
    db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
    db.commit()

    # Secondary operations — none of these should crash the endpoint after reply is saved
    WRITE_TOOLS = {
        "update_swimmer_status", "add_swimmer_observation",
        "update_season_plan", "add_meso", "update_meso", "delete_meso",
        "update_session", "create_season_plan",
    }
    already_handled = tools_called & WRITE_TOOLS
    intent = {"intent": "general", "suggested_action": None}
    saved_benchmarks = []
    saved_intents = []
    try:
        all_mentioned = _all_mentioned_swimmers(messages, db)
        intent = classify_intent(messages + [{"role": "assistant", "content": reply}], all_mentioned, db)

        if already_handled and intent.get("intent") in ("status_change", "coaching_intent"):
            intent["suggested_action"] = None

        full_convo = "\n".join(
            f"{'Coach' if m['role'] == 'user' else 'AI'}: {m['content']}"
            for m in messages[-10:]
        ) + f"\nAI: {reply}"

        if 'benchmark' in topics and all_mentioned:
            saved_benchmarks = extract_benchmarks_from_conversation(full_convo, all_mentioned, db)

        if intent.get("intent") == "coaching_intent" and intent.get("confidence") == "high" and all_mentioned:
            saved_intents = extract_coaching_intent(full_convo, all_mentioned, db)
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
        },
        "saved_benchmarks": saved_benchmarks,
        "saved_intents": saved_intents,
    }


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
            model=MODEL, max_tokens=300,
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
    all_msgs = q.order_by(models.CoachAIMessage.created_at.asc()).all()
    if not all_msgs:
        raise HTTPException(status_code=400, detail="No conversation to extract from")

    conversation = "\n".join(
        f"{'Coach' if m.role == 'user' else 'AI'}: {m.message}" for m in all_msgs[-40:]
    )
    today = date_type.today().isoformat()

    response = get_client().messages.create(
        model=MODEL,
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
    all_msgs = (
        db.query(models.CoachAIMessage)
        .filter(models.CoachAIMessage.thread_id == thread_id)
        .order_by(models.CoachAIMessage.created_at.asc())
        .all()
    )
    recent = all_msgs[-MAX_HISTORY:]
    history = [{"role": m.role, "content": m.message} for m in recent[:-1]]  # exclude the message we just added

    # Always inject session writing context for photo messages
    slot_hint = extract_slot_hint(text)
    session_ctx = build_session_writing_context(db, slot_hint)
    system = get_system_prompt(db)
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
        max_tokens=1500,
        system=system,
        messages=loop_messages_img,
        tools=tools,
    )

    # Tool-calling loop — max 5 iterations
    tools_called_img = set()
    for _ in range(5):
        if response.stop_reason != "tool_use":
            break
        tool_uses = [b for b in response.content if b.type == "tool_use"]
        tool_results = []
        for tu in tool_uses:
            tools_called_img.add(tu.name)
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
            max_tokens=1500,
            system=system,
            messages=loop_messages_img,
            tools=tools,
        )

    reply = next((b.text for b in response.content if hasattr(b, "text")), "").strip()
    db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
    db.commit()

    # Secondary operations — safe, cannot crash the endpoint after reply is saved
    topics = detect_topics(text, history[-6:])
    already_handled_img = tools_called_img & {"update_swimmer_status", "add_swimmer_observation"}
    intent = {"intent": "general", "suggested_action": None}
    saved_benchmarks = []
    saved_intents = []
    try:
        all_mentioned = _all_mentioned_swimmers([{"role": "user", "content": text}], db)
        intent = classify_intent(
            history + [{"role": "user", "content": text}, {"role": "assistant", "content": reply}],
            all_mentioned, db,
        )
        if already_handled_img and intent.get("intent") in ("status_change", "coaching_intent"):
            intent["suggested_action"] = None

        full_convo = "\n".join(f"{'Coach' if m['role'] == 'user' else 'AI'}: {m['content'] if isinstance(m['content'], str) else text}" for m in history[-8:]) + f"\nCoach: {text}\nAI: {reply}"
        if all_mentioned:
            if 'benchmark' in topics:
                saved_benchmarks = extract_benchmarks_from_conversation(full_convo, all_mentioned, db)
            if intent.get("intent") == "coaching_intent" and intent.get("confidence") == "high":
                saved_intents = extract_coaching_intent(full_convo, all_mentioned, db)
    except Exception:
        pass

    return {
        "reply": reply,
        "context_injected": [],
        "topics_detected": list(topics) or ["session_writing"],
        "suggested_action": intent.get("suggested_action") or "Review & create session",
        "intent": {
            "type": intent.get("intent") or "session_writing",
            "swimmer_id": intent.get("swimmer_id"),
            "swimmer_name": intent.get("swimmer_name"),
        },
        "saved_benchmarks": saved_benchmarks,
        "saved_intents": saved_intents,
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
    all_msgs = q.order_by(models.CoachAIMessage.created_at.asc()).all()
    if not all_msgs:
        raise HTTPException(status_code=400, detail="No conversation to extract meet from")

    conversation = "\n".join(
        f"{'Coach' if m.role == 'user' else 'AI'}: {m.message}" for m in all_msgs[-30:]
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
        model=MODEL,
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
    from datetime import date as date_type, timedelta

    text = body.get("message", "")
    slot_hint = extract_slot_hint(text)

    # Find the most recent matching session (within last 3 days)
    today = date_type.today()
    cutoff = today - timedelta(days=3)

    q = db.query(models.Session).filter(
        models.Session.date >= cutoff,
        models.Session.date <= today,
        models.Session.status != 'cancelled',
    ).order_by(models.Session.date.desc())

    sessions = q.all()

    # Filter by day hint
    matched_session = None
    if slot_hint.get('dow') is not None:
        for s in sessions:
            if s.date and s.date.weekday() == slot_hint['dow']:
                matched_session = s
                break

    # Fall back to most recent
    if not matched_session and sessions:
        matched_session = sessions[0]

    if not matched_session:
        return {"error": "No recent session found. Try specifying the date or creating the session first.", "sessions": []}

    # Get expected attendees from schedule
    from backend.routers.schedule import expected_attendance as _expected
    try:
        attendees = _expected(matched_session.date, squad=matched_session.squad, db=db)
    except Exception:
        attendees = []

    # Check if register already taken
    existing_entries = db.query(models.SessionEntry).filter(
        models.SessionEntry.session_id == matched_session.id
    ).count()

    return {
        "session_id": matched_session.id,
        "session_title": matched_session.title or f"Session {matched_session.date}",
        "session_date": matched_session.date.isoformat(),
        "register_taken": existing_entries > 0,
        "attendees": attendees,
    }


@router.post("/parse-register")
def parse_register(body: dict = Body(...), db: DBSession = Depends(get_db)):
    """
    Parse a freetext attendance description into a structured register.
    e.g. "everyone's here except Tom and Sarah, Tom's injured"
    """
    import json

    session_id = body.get("session_id")
    message = body.get("message", "")
    attendees = body.get("attendees", [])  # list of {id, name, expected}

    if not attendees:
        raise HTTPException(status_code=400, detail="Attendees list required")

    attendee_list = "\n".join(f"- {a['name']} (expected: {'yes' if a.get('expected') else 'no'})" for a in attendees)

    parse_prompt = f"""Parse this attendance message into a register for the following swimmers.

EXPECTED SWIMMERS:
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
        model=MODEL,
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
    all_msgs = q.order_by(models.CoachAIMessage.created_at.asc()).all()
    if not all_msgs:
        raise HTTPException(status_code=400, detail="No conversation to pin")

    conversation = "\n".join(
        f"{'Coach' if m.role == 'user' else 'AI'}: {m.message}" for m in all_msgs[-30:]
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
        model=MODEL,
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
        transcript = client.audio.transcriptions.create(model="whisper-1", file=buf)
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
