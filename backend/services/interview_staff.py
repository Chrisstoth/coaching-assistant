"""The staff's part in a swimmer's foundation interview.

The interviewer leads, but the profile it builds belongs to the specialists as
much as to the coach: the physiologist owns aerobic base, fatigue and training
response; the analyst owns speed, race patterns and how the swimmer races under
pressure; the swimmer manager owns the swimmer as a person. So:

1. Before the first question, each of them reads their own slice of the
   swimmer's data and hands the interviewer the questions only the coach can
   answer - at most two each, often none.
2. The interviewer works those questions in where they fit and says who is
   asking. It tags the message with [[ASKING_FOR <id>]], which is stripped
   before the coach sees it.
3. When the coach answers, the specialist who asked hears the answer. They may
   connect it to their data in a short note in the chat, and may ask one
   follow-up. A specialist the coach names directly ("what does the physio
   think?") answers too.
4. When the coach saves the profile, the specialists' notes are kept as staff
   notes on the swimmer, so the next staff meeting starts from what was learnt.

Messages from a specialist are stored in the interview transcript as assistant
messages with a ``speaker``. The interviewer reads them as colleagues' remarks
alongside the coach's answer (see ``for_model``).
Everything here runs on the fast staff model and fails quiet: a specialist who
cannot be reached simply says nothing, and the interview carries on.
"""

from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services import claude_service
from backend.services import staff_room
from backend.services.staff_room import ROSTER, Subject

# Who sits in on a foundation interview, and the areas each of them owns.
INTERVIEW_STAFF = {
    "physiologist": ("aerobic base", "fatigue and recovery", "training response"),
    "analyst": ("sprint and power", "race patterns", "competition mindset"),
    "manager": ("motivation", "hard-training mindset", "coachability"),
}
MAX_QUESTIONS_EACH = 2
MAX_FOLLOW_UP_DEPTH = 1
MARKER = re.compile(r"\[\[ASKING_FOR\s+([a-z0-9]+)\]\]", re.IGNORECASE)


def speaker_title(role: Optional[str]) -> str:
    """How a specialist is named in a transcript: "Fiona, Physiologist"."""
    if role not in ROSTER:
        return "Staff"
    r = ROSTER[role]
    return f"{r.name}, {r.title}" if r.name else r.title


def _ask(system: str, user: str, max_tokens: int, operation: str) -> Optional[dict]:
    """One fast staff call. Looked up through claude_service at call time so
    tests that patch its client patch this too."""
    try:
        response = claude_service.get_client().messages.create(
            model=staff_room.STAFF_MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            operation=operation,
        )
    except Exception:
        return None
    return staff_room._parse_json(claude_service.response_text(response) or "")


def _gender_rule() -> str:
    return 'Use he or she only where the data gives the swimmer\'s gender (M/F); otherwise use their name or "they".'


def _role_data(db: DBSession, swimmer: models.Swimmer, roles) -> dict:
    """Each specialist's data, read before any threads start: the session is
    not shared across threads."""
    subject = Subject(swimmer_ids=[swimmer.id])
    data = {}
    for role in roles:
        try:
            data[role] = staff_room.role_context(role, db, subject)
        except Exception:
            data[role] = "(no data on file for this yet)"
    return data


def _in_parallel(fn, items) -> list:
    items = list(items)
    if not items:
        return []
    with ThreadPoolExecutor(max_workers=len(items)) as pool:
        return list(pool.map(fn, items))


# ---------------------------------------------------------------------------
# Before the interview: each specialist's questions
# ---------------------------------------------------------------------------

_AGENDA_SYSTEM = """You are {staff_name}, the {title} on a swimming coaching staff.

Your remit: {remit}

The head coach is about to be interviewed to build {name}'s foundation profile.
It covers nine areas: aerobic base, sprint and power, race patterns, fatigue and
recovery, training response, motivation, competition mindset, hard-training
mindset and coachability. The areas that are yours: {areas}.

Read your data and decide what you need the coach to tell you - things only the
coach can see from the poolside, which your data raises or cannot settle.
- Ground each question in your data: name the date, time, set or figure behind it.
- Ask about {name} specifically. Never invent data.
- {gender}
- At most {max_questions} questions; fewer is better. None if your areas are
  already well covered or your data gives you nothing to go on.

Return JSON only:
{{"questions": [{{"area": "one of your areas", "question": "what you want to ask the coach", "why": "what in your data makes you ask, in twenty words or fewer"}}]}}"""


def open_agenda(db: DBSession, swimmer: models.Swimmer, coverage: Optional[dict] = None) -> list:
    """The staff's questions for this interview, in seating order."""
    if not staff_room.staff_room_enabled():
        return []
    covered = ", ".join(a["label"] for a in (coverage or {}).get("areas", []) if a.get("complete")) or "none"
    missing = ", ".join((coverage or {}).get("missing_areas", [])) or "none"
    data = _role_data(db, swimmer, INTERVIEW_STAFF)

    def run(role):
        r = ROSTER[role]
        system = _AGENDA_SYSTEM.format(
            staff_name=r.name, title=r.title, remit=r.remit, name=swimmer.name,
            areas=", ".join(INTERVIEW_STAFF[role]), gender=_gender_rule(),
            max_questions=MAX_QUESTIONS_EACH,
        )
        user = (f"FOUNDATION AREAS ALREADY CONFIRMED: {covered}\n"
                f"STILL MISSING: {missing}\n\nYOUR DATA:\n{data[role]}")
        return role, _ask(system, user, 700, f"interview_agenda_{role}")

    questions = []
    for role, raw in _in_parallel(run, INTERVIEW_STAFF):
        items = (raw or {}).get("questions") or []
        for item in items[:MAX_QUESTIONS_EACH]:
            if not isinstance(item, dict):
                continue
            text = str(item.get("question") or "").strip()
            if not text:
                continue
            questions.append(_question(questions, role, text[:500],
                                       why=str(item.get("why") or "").strip()[:240],
                                       area=str(item.get("area") or "").strip()[:60]))
    return questions


def _question(existing: list, role: str, text: str, *, why: str = "", area: str = "",
              parent: Optional[str] = None) -> dict:
    return {
        "id": f"s{len(existing) + 1}",
        "role": role,
        "question": text,
        "why": why,
        "area": area,
        "parent": parent,
        "status": "open",       # open / asked / answered
        "answer": None,
        "note": None,
    }


def prompt_block(questions: list) -> str:
    """What the interviewer is told about the staff's questions."""
    if not questions:
        return ""
    lines = []
    for q in questions:
        label = f"{q['id']} · {speaker_title(q['role'])}" + (f" ({q['area']})" if q.get("area") else "")
        if q["status"] == "open":
            why = f" - because {q['why']}" if q.get("why") else ""
            lines.append(f"- OPEN {label}: {q['question']}{why}")
        elif q["status"] == "asked":
            lines.append(f"- ASKED, awaiting answer {label}: {q['question']}")
        else:
            lines.append(f"- ANSWERED {label}: {q['question']}")
    return f"""YOUR STAFF COLLEAGUES' QUESTIONS:
The specialists on the coaching staff each own part of this profile and read the swimmer's data before the interview.
{chr(10).join(lines)}

WORKING WITH THE STAFF:
- When you reach an area a colleague has an OPEN question on, ask theirs instead of writing your own. A follow-up from a colleague comes first.
- Say who is asking, by first name and role, and keep their substance, e.g. "Fiona, our physiologist, wants to know: ...". After the first time, the first name alone is enough.
- When a message asks a colleague's question, end it with a line containing only [[ASKING_FOR <id>]] using that question's id. Still one question per message.
- Paragraphs in the coach's turn that start with a name and title in brackets, e.g. [Fiona, Physiologist], are your colleagues speaking to the coach, not the coach. Build on what they say; do not repeat it.
- Before finishing, ask any OPEN colleague question the coach has not already answered in passing."""


def take_marker(reply: str, questions: list) -> tuple:
    """Strip the interviewer's marker and mark that question asked.

    Returns (clean reply, question id or None). An id the staff never asked is
    ignored rather than trusted.
    """
    match = MARKER.search(reply or "")
    clean = MARKER.sub("", reply or "").rstrip()
    if not match:
        return clean, None
    qid = match.group(1).lower()
    for q in questions:
        if q["id"] == qid:
            if q["status"] == "open":
                q["status"] = "asked"
            return clean, qid
    return clean, None


# ---------------------------------------------------------------------------
# During the interview: hearing the coach's answers
# ---------------------------------------------------------------------------

_HEAR_SYSTEM = """You are {staff_name}, the {title} on a swimming coaching staff.

Your remit: {remit}

The head coach is being interviewed to build {name}'s foundation profile, and the
staff are sitting in. {situation}

Return JSON only:
{{"note": "...", "follow_up": "..."}}
- note: {note_rule}
- follow_up: {follow_up_rule}
Rules: be specific - use the names, dates and numbers in your data. Never invent
data. {gender} Plain coaching language, no thanks, no preamble, no restating
what the coach said."""

_NOTE_WHEN_ASKED = ("one or two sentences to the coach, only if the answer connects to your data - "
                    "it agrees with it, contradicts it, or explains it - or changes what you would "
                    "recommend. Otherwise null.")
_NOTE_WHEN_ADDRESSED = "your answer to the coach in two or three sentences, from your data. Never null."
_FOLLOW_UP_ALLOWED = ("one short question, only if the answer left something you genuinely need "
                      "unclear. Otherwise null.")
_FOLLOW_UP_NONE = "always null."


def _transcript_tail(messages: list, count: int = 6) -> str:
    lines = []
    for m in messages[-count:]:
        who = "Coach" if m.get("role") == "user" else (
            speaker_title(m["speaker"]) if m.get("speaker") else "Interviewer")
        lines.append(f"{who}: {m.get('content', '')}")
    return "\n".join(lines)


def _depth(question: dict, questions: list) -> int:
    by_id = {q["id"]: q for q in questions}
    depth, current = 0, question
    while current.get("parent") and current["parent"] in by_id:
        depth += 1
        current = by_id[current["parent"]]
    return depth


def hear_answer(db: DBSession, swimmer: models.Swimmer, messages: list, questions: list) -> list:
    """Let the staff hear the coach's latest answer.

    Returns the specialist messages to show before the interviewer's next
    question. Updates ``questions`` in place: the answered question is marked,
    and a follow-up joins the list.
    """
    if not messages or messages[-1].get("role") != "user" or not staff_room.staff_room_enabled():
        return []
    coach_text = messages[-1].get("content", "")
    asking = None
    for m in reversed(messages[:-1]):
        if m.get("role") == "assistant" and not m.get("speaker"):
            asking = m.get("asks_for")
            break
    asked = next((q for q in questions if q["id"] == asking and q["status"] == "asked"), None)

    # Who speaks: whoever asked, then anyone the coach named directly.
    speakers = []
    if asked:
        speakers.append((asked["role"], asked))
    for role in staff_room.addressed_roles(coach_text, db):
        if role not in [r for r, _ in speakers]:
            speakers.append((role, None))
    if not speakers:
        return []

    data = _role_data(db, swimmer, [r for r, _ in speakers])
    tail = _transcript_tail(messages)

    def run(entry):
        role, question = entry
        r = ROSTER[role]
        if question:
            situation = (f"You asked the coach: \"{question['question']}\"\n"
                         f"The coach answered: \"{coach_text}\"")
            follow_up_rule = (_FOLLOW_UP_ALLOWED if _depth(question, questions) < MAX_FOLLOW_UP_DEPTH
                              else _FOLLOW_UP_NONE)
            note_rule = _NOTE_WHEN_ASKED
        else:
            situation = f"The coach spoke to you directly: \"{coach_text}\""
            follow_up_rule, note_rule = _FOLLOW_UP_NONE, _NOTE_WHEN_ADDRESSED
        system = _HEAR_SYSTEM.format(staff_name=r.name, title=r.title, remit=r.remit, name=swimmer.name,
                                     situation=situation, note_rule=note_rule,
                                     follow_up_rule=follow_up_rule, gender=_gender_rule())
        user = f"THE INTERVIEW SO FAR:\n{tail}\n\nYOUR DATA:\n{data[role]}"
        return role, question, _ask(system, user, 500, f"interview_hear_{role}")

    said = []
    for role, question, raw in _in_parallel(run, speakers):
        raw = raw or {}
        note = _text(raw.get("note"), 700)
        if question:
            question["status"] = "answered"
            question["answer"] = coach_text[:1500]
            question["note"] = note
            follow_up = _text(raw.get("follow_up"), 500)
            if follow_up:
                questions.append(_question(questions, role, follow_up,
                                           area=question.get("area", ""), parent=question["id"]))
        if note:
            said.append({"role": "assistant", "speaker": role, "content": note})
    return said


def _text(value, limit: int) -> Optional[str]:
    text = str(value or "").strip()
    return text[:limit] if text and text.lower() != "null" else None


# ---------------------------------------------------------------------------
# For the interviewer, the synthesis, and the staff afterwards
# ---------------------------------------------------------------------------

def for_model(messages: list) -> list:
    """The transcript as alternating user/assistant turns for the model.

    The staff speak straight after the coach, before the interviewer, so a
    specialist's message joins the coach's turn under their title. Were it an
    assistant turn, a transcript ending on it would have the interviewer carry
    on the specialist's sentence.
    """
    turns = []
    for m in messages:
        role = "user" if m.get("role") == "user" else "assistant"
        content = str(m.get("content") or "")
        if role == "assistant" and m.get("speaker"):
            role = "user"
            content = f"[{speaker_title(m['speaker'])}] {content}"
        if turns and turns[-1]["role"] == role:
            turns[-1]["content"] += "\n\n" + content
        else:
            turns.append({"role": role, "content": content})
    return turns


def keep_notes(db: DBSession, swimmer: models.Swimmer, messages: list) -> list:
    """Keep what each specialist said in the interview as staff notes on the
    swimmer, once the coach has saved the profile."""
    notes = []
    for m in messages:
        role = m.get("speaker")
        if m.get("role") != "assistant" or role not in ROSTER or not (m.get("content") or "").strip():
            continue
        note = models.StaffNote(
            role=role, kind="observation", message=m["content"][:900],
            swimmer_ids=[swimmer.id], addressed_to="coach", trigger="profile_interview",
            topic=f"Foundation profile interview: {swimmer.name}"[:500], status="open",
        )
        db.add(note)
        notes.append(note)
    return notes


def public(questions: list) -> list:
    """What the coach's screen shows of the staff's questions."""
    return [{"id": q["id"], "role": q["role"], "question": q["question"], "status": q["status"],
             "area": q.get("area") or ""} for q in questions or []]
