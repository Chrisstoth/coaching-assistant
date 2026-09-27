"""Writing a session with the staff, live.

The coach types a brief - the aims for the session. The Session Writer drafts
it from the brief and the plan: the week, the block, and what each expected
swimmer is working towards. The other specialists then read the draft with
their own data and suggest changes to particular lines, each with a reason.
Nothing in the draft changes until the coach accepts a suggestion; two
suggestions on the same line are the coach's call.

The page polls the workshop while this happens, so the coach watches the
draft arrive and the suggestions land one specialist at a time. When the coach
is happy, `finish` hands the session to the session planner in the same shape
as a normal draft, so saving, the zone breakdown and printing all work as
before.
"""

from __future__ import annotations

import json
import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.database import SessionLocal

log = logging.getLogger(__name__)

# The specialists who review a draft, in the order their cards appear.
REVIEWERS = ("physiologist", "analyst", "planner", "manager")
MAX_SUGGESTIONS = 3
CHANGES = ("replace", "add_after", "remove")

_lock = threading.Lock()


# ---------------------------------------------------------------------------
# The plan a session sits in
# ---------------------------------------------------------------------------

def _as_date(value) -> Optional[date]:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def plan_brief(db: DBSession, day, squad: Optional[str], swimmer_ids: list) -> str:
    """What the Session Writer needs to know about the plan before writing.

    The week and block, the planned load, each expected swimmer's group, aim
    and pathway, and what the training figures say about them.
    """
    from backend.services import groups as group_svc
    from backend.services.staff_room import Subject, _week_plan_lines

    day = _as_date(day)
    if not day:
        return ""
    lines = []
    try:
        lines += _week_plan_lines(db, Subject(session_date=day, squad=squad))
    except Exception:
        log.exception("week plan lines failed")
    monday = day - timedelta(days=day.weekday())
    macro = db.query(models.TrainingMacro).filter(
        models.TrainingMacro.date_from <= day, models.TrainingMacro.date_to >= day,
    ).order_by(models.TrainingMacro.date_from).first()
    if macro:
        point = db.query(models.SeasonLoadPoint).filter(
            models.SeasonLoadPoint.macro_id == macro.id, models.SeasonLoadPoint.week_start == monday,
            models.SeasonLoadPoint.pathway_id.is_(None),
        ).first()
        if point and point.overall is not None:
            lines.append(f"PLANNED LOAD THIS WEEK: {point.overall}/100" + (f" ({point.note})" if point.note else ""))

    ids = [int(i) for i in swimmer_ids or []]
    if ids:
        try:
            towards, aims = group_svc.plan_context(db, ids, day)
        except Exception:
            towards, aims = {}, []
        flags = {}
        try:
            from backend.services import training_load
            swimmers = db.query(models.Swimmer).filter(models.Swimmer.id.in_(ids)).all()
            for profile in training_load.load_profiles(db, swimmers, day):
                if profile.flags:
                    flags[profile.swimmer_id] = "; ".join(profile.flags[:3])
        except Exception:
            log.exception("load profiles failed")
        names = {s.id: s.name for s in db.query(models.Swimmer).filter(models.Swimmer.id.in_(ids)).all()}
        who = []
        for sid in ids:
            bits = [b for b in (towards.get(sid), flags.get(sid)) if b]
            if bits:
                who.append(f"  {names.get(sid, sid)}: " + " | ".join(bits))
        if who:
            lines.append("WHAT EACH EXPECTED SWIMMER IS WORKING TOWARDS:")
            lines += who
        lines += aims
    if not lines:
        return ""
    lines.append("Write the session to serve this plan and the coach's brief. The groups in the session "
                 "are the sets for this session (Group 1 = set 1), chosen from who comes - not the "
                 "training groups. Say in plan_alignment how the session fits the week and block.")
    return "THE PLAN THIS SESSION SITS IN:\n" + "\n".join(lines)


def writing_context(db: DBSession, day, squad: Optional[str], swimmer_ids: list) -> str:
    """Everything the Session Writer reads besides the brief: the coach's rules, then the plan."""
    from backend.services import coach_guidance
    parts = [coach_guidance.prompt_block(db, "sessions"), plan_brief(db, day, squad, swimmer_ids)]
    return "\n\n".join(p for p in parts if p)


# ---------------------------------------------------------------------------
# The draft as lines the staff can point at
# ---------------------------------------------------------------------------

def _line(text: str) -> dict:
    return {"id": uuid.uuid4().hex[:8], "text": str(text).strip()}


def to_draft(parsed: dict) -> dict:
    sections = []
    if parsed.get("warm_up"):
        sections.append({"key": "warm_up", "label": "Warm up", "lines": [_line(parsed["warm_up"])]})
    for key, group in (parsed.get("groups") or {}).items():
        sets = group.get("sets") or []
        if isinstance(sets, str):
            sets = [s for s in sets.splitlines() if s.strip()]
        sections.append({"key": str(key), "label": group.get("label") or f"Group {key}",
                         "lines": [_line(s) for s in sets if str(s).strip()]})
    if parsed.get("cool_down"):
        sections.append({"key": "cool_down", "label": "Cool down", "lines": [_line(parsed["cool_down"])]})
    return {"title": parsed.get("title"), "coach_intent": parsed.get("coach_intent"),
            "energy_focus": parsed.get("energy_focus"), "sections": sections}


def to_parsed(draft: dict, base: Optional[dict] = None) -> dict:
    """Back to the planner's shape, keeping anything else the planner returned."""
    parsed = dict(base or {})
    parsed["title"] = draft.get("title")
    parsed["coach_intent"] = draft.get("coach_intent")
    groups = {}
    parsed["warm_up"] = None
    parsed["cool_down"] = None
    for section in draft.get("sections") or []:
        texts = [line["text"] for line in section["lines"] if line["text"].strip()]
        if section["key"] == "warm_up":
            parsed["warm_up"] = "; ".join(texts) or None
        elif section["key"] == "cool_down":
            parsed["cool_down"] = "; ".join(texts) or None
        elif texts:
            groups[section["key"]] = {"label": section["label"], "sets": texts}
    parsed["groups"] = groups
    return parsed


def draft_text(draft: dict) -> str:
    """The draft as the staff read it: every line with its id."""
    out = [f"TITLE: {draft.get('title') or ''}", f"INTENT: {draft.get('coach_intent') or ''}"]
    for section in draft.get("sections") or []:
        out.append(f"[{section['label']}]" if section["key"] in ("warm_up", "cool_down")
                   else f"[Set {section['key']}: {section['label']}]")
        for line in section["lines"]:
            out.append(f"  {line['id']}: {line['text']}")
    return "\n".join(out)


def _find(draft: dict, line_id: str):
    for section in draft.get("sections") or []:
        for i, line in enumerate(section["lines"]):
            if line["id"] == line_id:
                return section, i
    return None, None


class WorkshopError(ValueError):
    pass


def apply(draft: dict, suggestion: dict) -> dict:
    """The draft with one suggestion carried out. Raises if its line has gone."""
    draft = json.loads(json.dumps(draft))
    section, i = _find(draft, suggestion["line_id"])
    if section is None:
        raise WorkshopError("That line has changed since the suggestion was made.")
    change = suggestion["change"]
    if change == "replace":
        section["lines"][i]["text"] = suggestion["text"]
    elif change == "add_after":
        section["lines"].insert(i + 1, _line(suggestion["text"]))
    elif change == "remove":
        section["lines"].pop(i)
    return draft


# ---------------------------------------------------------------------------
# Running a workshop
# ---------------------------------------------------------------------------

def _update(workshop_id: int, change) -> None:
    """Read, change and save a workshop under one lock - the specialists finish at once."""
    with _lock:
        db = SessionLocal()
        try:
            row = db.get(models.SessionWorkshop, workshop_id)
            if row:
                change(row)
                db.commit()
        finally:
            db.close()


def _set_voice(row, role: str, **fields) -> None:
    voices = [dict(v) for v in (row.voices or [])]
    for v in voices:
        if v["role"] == role:
            v.update(fields)
    row.voices = voices


_REVIEW_SYSTEM = """You are the {title} on a swimming coach's staff, helping write a training session live.
Your remit: {remit}
Watch for: {watch_for}

The coach wrote a brief and the Session Writer drafted the session below. Read it with YOUR data and
suggest changes to particular lines - at most {max_n} - only where your data gives a clear reason.

Rules:
- The coach's brief is the coach's decision. Never remove, shorten or change anything the brief asks for;
  improve how the session delivers it. If the draft misses or waters down something the brief asks
  for (e.g. the brief says underwater kick and the draft says kick), suggest the fix.
- Every line you write or add must be something the swimmers swim (distance, reps, send-off, pace or
  target). Never add notes, questions, reminders or labels as lines - put a question in your comment.
- "Set 1", "Set 2" are the sets in this one session, picked from who turns up. They are not training
  groups; do not comment on training group set-up here.
- Only suggest what your own data supports, and name the swimmer or figure in the reason (one short
  sentence). When your data is thin, say so in the comment and suggest nothing.
- If the draft already works from your point of view, suggest nothing.

Each line has an id. A change is one of:
- "replace": rewrite that line (give the full new text)
- "add_after": add a new line after that line (give the text)
- "remove": take that line out (text may be empty)

Return JSON only:
{{"comment": "one short sentence, under 25 words - your view of the draft", "suggestions": [
  {{"line_id": "ab12cd34", "change": "replace|add_after|remove", "text": "...", "reason": "..."}}]}}"""


def review(db: DBSession, role: str, draft: dict, brief: str, day: Optional[date], squad: Optional[str],
           attendee_ids: list) -> dict:
    """One specialist's view of the draft: a comment and up to three line changes."""
    from backend.services.claude_service import get_client, response_text
    from backend.services.staff_room import ROSTER, STAFF_MODEL, Subject, role_context

    spec = ROSTER[role]
    subject = Subject(session_date=day, squad=squad, attendee_ids=list(attendee_ids))
    try:
        data = role_context(role, db, subject)
    except Exception:
        log.exception("role context failed for %s", role)
        data = ""
    message = (f"COACH'S BRIEF:\n{brief}\n\nTHE DRAFT:\n{draft_text(draft)}\n\n"
               f"YOUR DATA:\n{data or '(nothing on file)'}")
    response = get_client().messages.create(
        model=STAFF_MODEL, max_tokens=900,
        system=_REVIEW_SYSTEM.format(title=spec.title, remit=spec.remit, watch_for=spec.watch_for,
                                     max_n=MAX_SUGGESTIONS),
        messages=[{"role": "user", "content": message}],
    )
    raw = response_text(response).strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        raw = raw[4:] if raw.startswith("json") else raw
    start, end = raw.find("{"), raw.rfind("}")
    out = json.loads(raw[start:end + 1]) if start >= 0 else {}
    known = {line["id"] for s in draft["sections"] for line in s["lines"]}
    clean = []
    for item in (out.get("suggestions") or [])[:MAX_SUGGESTIONS]:
        if not isinstance(item, dict):
            continue
        change = str(item.get("change") or "")
        text = str(item.get("text") or "").strip()
        if item.get("line_id") not in known or change not in CHANGES or (change != "remove" and not text):
            continue
        clean.append({"line_id": item["line_id"], "change": change, "text": text[:400],
                      "reason": str(item.get("reason") or "").strip()[:300]})
    return {"comment": str(out.get("comment") or "").strip()[:300], "suggestions": clean}


def run(workshop_id: int) -> None:
    """Draft, then have the specialists review. Runs behind the page, which polls."""
    from backend.routers.coaching_context import get_current_coaching_context
    from backend.services import claude_service
    from backend.services.staff_room import ROSTER

    db = SessionLocal()
    try:
        row = db.get(models.SessionWorkshop, workshop_id)
        brief, day, squad = row.brief, row.date, row.squad
        attendee_ids = [s["id"] for s in row.expected or []]
        context = get_current_coaching_context(db)
        plan = writing_context(db, day, squad, attendee_ids)
        result = claude_service.plan_and_analyse_session(
            session_text=brief, date_str=day.isoformat() if day else None, squad=squad,
            expected_swimmers=row.expected or [], coaching_context="\n\n".join(p for p in (context, plan) if p),
            db=db,
        )
    except Exception as exc:
        log.exception("session workshop draft failed")
        message = ("The Session Writer could not finish the draft. Tap Start again to try once more"
                   f" - your brief is still in the box. ({str(exc)[:120]})")
        _update(workshop_id, lambda r: (setattr(r, "status", "failed"), setattr(r, "error", message)))
        return
    finally:
        db.close()

    draft = to_draft(result.get("parsed") or {})

    def drafted(r):
        r.draft = draft
        r.result = {k: v for k, v in result.items() if k != "parsed"} | {"parsed": result.get("parsed")}
        r.status = "reviewing"
        r.voices = [{"role": role, "title": ROSTER[role].title, "status": "thinking", "comment": ""}
                    for role in REVIEWERS]
    _update(workshop_id, drafted)

    def one(role: str) -> None:
        db = SessionLocal()
        try:
            out = review(db, role, draft, brief, day, squad, attendee_ids)
        except Exception:
            log.exception("session workshop review failed for %s", role)
            _update(workshop_id, lambda r: _set_voice(r, role, status="failed",
                                                      comment="Could not look at this one."))
            return
        finally:
            db.close()

        def landed(r):
            items = [dict(s) for s in (r.suggestions or [])]
            for s in out["suggestions"]:
                items.append({**s, "id": uuid.uuid4().hex[:8], "role": role, "title": ROSTER[role].title,
                              "status": "pending"})
            r.suggestions = items
            _set_voice(r, role, status="done" if out["suggestions"] else "quiet",
                       comment=out["comment"] or ("Nothing to change." if not out["suggestions"] else ""))
        _update(workshop_id, landed)

    with ThreadPoolExecutor(max_workers=len(REVIEWERS)) as pool:
        list(pool.map(one, REVIEWERS))
    _update(workshop_id, lambda r: setattr(r, "status", "ready"))


def start(db: DBSession, *, brief: str, day: Optional[date], squad: Optional[str], pool_slot_id,
          expected: list, pool_slot: Optional[dict], background: bool = True) -> models.SessionWorkshop:
    row = models.SessionWorkshop(brief=brief, date=day, squad=squad, pool_slot_id=pool_slot_id,
                                 expected=expected, pool_slot=pool_slot, status="drafting",
                                 voices=[], suggestions=[])
    db.add(row)
    db.commit()
    db.refresh(row)
    if background:
        threading.Thread(target=run, args=(row.id,), daemon=True).start()
    else:
        run(row.id)
        db.refresh(row)
    return row


# ---------------------------------------------------------------------------
# The coach's decisions
# ---------------------------------------------------------------------------

def decide(db: DBSession, row: models.SessionWorkshop, suggestion_id: str, accept: bool) -> None:
    items = [dict(s) for s in row.suggestions or []]
    target = next((s for s in items if s["id"] == suggestion_id), None)
    if not target:
        raise WorkshopError("No such suggestion")
    if target["status"] != "pending":
        raise WorkshopError("That suggestion has already been decided")
    if accept:
        row.draft = apply(row.draft, target)
        target["status"] = "accepted"
        # Other suggestions on a line that has now changed or gone need a fresh look.
        for other in items:
            if other is not target and other["status"] == "pending" and other["line_id"] == target["line_id"] \
                    and target["change"] != "add_after":
                other["status"] = "superseded"
    else:
        target["status"] = "rejected"
    row.suggestions = items
    db.commit()


_REPLY_SYSTEM = """You are the {title} on a swimming coach's staff. You suggested a change to one line of a
session and the coach has answered you. Take the answer seriously: the coach knows their swimmers and
their own way of writing sessions.

Return JSON only:
{{"response": "one or two short sentences back to the coach",
  "revised": {{"change": "replace|add_after|remove", "text": "...", "reason": "..."}} or null,
  "lesson": "a standing rule about how this coach works, or null"}}

- If your point still stands, keep the point but write it the coach's way (their style of sets) as "revised".
- If the coach's answer means your suggestion should go, set "revised" to null and say so.
- "lesson": only when the answer says something general about how this coach coaches or writes sessions -
  not a one-off about today. Write it as an instruction to every member of staff, e.g. "Write main sets as
  varied, mixed structures that keep swimmers engaged - not plain straight repeats like 8x300." Else null.
- Every line you write must be something swimmers swim (distance, reps, send-off, pace) - never a note.

{rules}"""


def _line_text(draft: dict, line_id: str) -> str:
    section, i = _find(draft, line_id)
    return section["lines"][i]["text"] if section is not None else "(line no longer in the session)"


def reply(db: DBSession, row: models.SessionWorkshop, suggestion_id: str, text: str) -> dict:
    """The coach answers a suggestion; its specialist revises it, withdraws it, and may offer a rule."""
    from backend.services import coach_guidance
    from backend.services.claude_service import get_client, response_text
    from backend.services.staff_room import ROSTER, STAFF_MODEL

    text = (text or "").strip()
    if not text:
        raise WorkshopError("Say something back first")
    items = [dict(s) for s in row.suggestions or []]
    target = next((s for s in items if s["id"] == suggestion_id), None)
    if not target:
        raise WorkshopError("No such suggestion")
    if target["status"] != "pending":
        raise WorkshopError("That suggestion has already been decided")
    spec = ROSTER[target["role"]]
    thread = list(target.get("thread") or [])
    history = "\n".join(f"{'COACH' if t['who'] == 'coach' else 'YOU'}: {t['text']}" for t in thread)
    draft = row.draft or {}
    session_text = draft_text(draft)
    line_now = _line_text(draft, target["line_id"])
    message = (f"COACH'S BRIEF:\n{row.brief}\n\nTHE SESSION:\n{session_text}\n\n"
               f"YOUR SUGGESTION on line {target['line_id']} (currently: {line_now}):\n"
               f"  {target['change']}: {target.get('text') or ''}\n  because: {target.get('reason') or ''}\n\n"
               + (f"SO FAR:\n{history}\n\n" if history else "")
               + f"THE COACH SAYS:\n{text}")
    response = get_client().messages.create(
        model=STAFF_MODEL, max_tokens=700,
        system=_REPLY_SYSTEM.format(title=spec.title, rules=coach_guidance.prompt_block(db, target["role"])),
        messages=[{"role": "user", "content": message}],
    )
    raw = response_text(response).strip()
    start, end = raw.find("{"), raw.rfind("}")
    out = json.loads(raw[start:end + 1]) if start >= 0 else {}

    thread.append({"who": "coach", "text": text[:600]})
    thread.append({"who": target["role"], "text": str(out.get("response") or "Understood.").strip()[:400]})
    target["thread"] = thread
    revised = out.get("revised") if isinstance(out.get("revised"), dict) else None
    change = str((revised or {}).get("change") or "")
    new_text = str((revised or {}).get("text") or "").strip()
    if revised and change in CHANGES and (change == "remove" or new_text):
        target.update(change=change, text=new_text[:400],
                      reason=str(revised.get("reason") or target.get("reason") or "").strip()[:300])
    else:
        target["status"] = "withdrawn"
    lesson = str(out.get("lesson") or "").strip()
    if lesson and lesson.lower() != "null":
        target["lesson"] = lesson[:500]
        target["lesson_saved"] = False
    row.suggestions = items
    db.commit()
    return target


def remember(db: DBSession, row: models.SessionWorkshop, suggestion_id: str, text: Optional[str] = None):
    """The coach keeps a rule a specialist offered - edited first if they like."""
    from backend.services import coach_guidance
    from backend.services.staff_room import ROSTER
    items = [dict(s) for s in row.suggestions or []]
    target = next((s for s in items if s["id"] == suggestion_id), None)
    if not target or not (text or target.get("lesson")):
        raise WorkshopError("There is nothing to remember here")
    rule = coach_guidance.add(db, text or target["lesson"],
                              source=f"Your reply to the {ROSTER[target['role']].title}")
    target["lesson"] = rule.text
    target["lesson_saved"] = True
    row.suggestions = items
    db.commit()
    return rule


def edit_line(db: DBSession, row: models.SessionWorkshop, line_id: str, text: str) -> None:
    """The coach rewrites a line themselves."""
    draft = json.loads(json.dumps(row.draft))
    section, i = _find(draft, line_id)
    if section is None:
        raise WorkshopError("That line is no longer in the session")
    if text.strip():
        section["lines"][i]["text"] = text.strip()
    else:
        section["lines"].pop(i)
    row.draft = draft
    items = [dict(s) for s in row.suggestions or []]
    for s in items:
        if s["status"] == "pending" and s["line_id"] == line_id:
            s["status"] = "superseded"
    row.suggestions = items
    db.commit()


def finish(db: DBSession, row: models.SessionWorkshop) -> dict:
    """The session as the planner's own draft, with the zone breakdown worked out afresh."""
    from backend.routers.sessions import finish_plan_result
    result = json.loads(json.dumps(row.result or {}))
    parsed = to_parsed(row.draft or {}, result.get("parsed"))
    result["parsed"] = parsed
    accepted = [s for s in row.suggestions or [] if s["status"] == "accepted"]
    # The planner's conversation carries on from the session as it now stands,
    # so a later "make the main set shorter" revises this version, not the first.
    messages = list(result.get("messages") or [])
    if messages and accepted:
        messages.append({"role": "user", "content": "The coach accepted these changes from the staff: "
                         + "; ".join(f"{s['title']}: {s['reason']}" for s in accepted)
                         + ". Return the plan as it now stands."})
        messages.append({"role": "assistant", "content": json.dumps(
            {k: v for k, v in result.items() if k not in ("messages",)})})
    result["messages"] = messages
    selected_slot = None
    if row.pool_slot_id:
        selected_slot = db.get(models.PoolSlot, row.pool_slot_id)
    return finish_plan_result(db, result, row.date.isoformat() if row.date else None,
                              row.expected or [], selected_slot)


def out(row: models.SessionWorkshop) -> dict:
    return {
        "id": row.id, "status": row.status, "brief": row.brief,
        "date": row.date.isoformat() if row.date else None, "squad": row.squad,
        "draft": row.draft, "voices": row.voices or [], "suggestions": row.suggestions or [],
        "expected": row.expected or [], "error": row.error,
        "plan_alignment": (row.result or {}).get("plan_alignment"),
    }
