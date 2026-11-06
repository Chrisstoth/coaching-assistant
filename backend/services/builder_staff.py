"""The staff in the Session Builder: live comments pinned to lines, and Jess drafting.

Live comments: when the coach pauses or asks, the physiologist, analyst,
planner and swimmer manager read the session with their own data and pin at
most two short comments each to particular lines. Each comment is either a
safety flag (load spike, a swimmer back from injury, hard days stacked...) or
a preference. The coach accepts, dismisses or marks it useful:

- a dismissed preference, with a reason, is written into that worker's
  "Not to flag" page, so they learn what the coach doesn't want raised;
- a safety flag can be acknowledged but is never switched off;
- workers are judged on "was this useful?", never on agreement.

Jess drafts: from a brief (typed or spoken), the Session Writer writes the
session straight into the builder notation, in the coach's current style, and
the parser checks every line.
"""

from __future__ import annotations

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.database import SessionLocal
from backend.services import session_notation as N
from backend.services import workbooks as W

log = logging.getLogger(__name__)

REVIEWERS = ("physiologist", "analyst", "planner", "manager")
MAX_PER_WORKER = 2
PREFS_PAGE = "preferences.md"


# ---------------------------------------------------------------- the session as numbered lines

def line_index(b: dict) -> list:
    """Every set and round in the session with its id, block and groups, as the staff read it."""
    s = N.normalize_session(json.loads(json.dumps(b)))
    sys = s.get("effSys") or N.DEFAULT_SYS
    out = []

    def walk(items, block, groups, depth):
        for n in items or []:
            if n.get("t") == "round":
                out.append({"id": n["id"], "block": block, "groups": groups,
                            "text": "  " * depth + f"{n.get('times') or 1}x round" + (f" - {n['note']}" if n.get("note") else "")})
                walk(n.get("items"), block, groups, depth + 1)
            elif not N.is_blank_line(n):
                out.append({"id": n["id"], "block": block, "groups": groups, "text": "  " * depth + N.line_text(n, sys)})

    for blk in s.get("blocks") or []:
        if blk.get("kind") == "notes":
            continue
        walk(blk.get("items"), blk.get("name") or "Block", N.block_group_names(s, blk) or ["everyone"], 0)
    return out


def _attendees(b: dict) -> list:
    ids = []
    for g in b.get("groups") or []:
        ids += [int(x) for x in g.get("swimmer_ids") or [] if str(x).isdigit()]
    return sorted(set(ids))


def _session_text_for_staff(b: dict, lines: list) -> str:
    totals = N.totals_for(N.normalize_session(json.loads(json.dumps(b))))
    head = [f"SESSION: {b.get('date')} {b.get('slot') or ''} · " + " | ".join(f"{t['g'] or 'everyone'} {N.fmt_dist(t['dist'])} m, {N.fmt_time(t['time'])}" for t in totals)]
    aims = [a for a in (b.get("aims") or []) if a]
    if aims:
        head.append("AIMS: " + "; ".join(aims))
    return "\n".join(head) + "\n" + "\n".join(f"[{l['id']}] ({l['block']}, {', '.join(l['groups'])}) {l['text']}" for l in lines)


# ---------------------------------------------------------------- live comments

_REVIEW = """You are {name}, the {title} on a swimming coach's staff, reading a session as the coach writes it.
Your remit: {remit}
Watch for: {watch_for}
Your safety flags (always raise these if your data shows them): {safety}

Read the session with YOUR data. Pin at most {max_n} short comments to particular lines, only where your
data gives a clear reason that could change the coach's mind. Staying quiet is normal and good.

- Name the swimmer or figure behind every comment, in one or two sentences.
- "flag": "safety" only for one of your safety flags; anything else is "preference".
- Never repeat something the coach has told you not to flag (below), unless it is a safety flag.
- Never invent data. The coach decides; you advise.

{prefs}

Return JSON only:
{{"comments": [{{"line_id": "ab12cd34", "flag": "safety|preference", "message": "...", "swimmer_ids": []}}]}}
or {{"comments": []}}."""


def _ask(system: str, user: str, operation: str, max_tokens: int = 700) -> dict:
    from backend.services import claude_service
    from backend.services.staff_room import STAFF_MODEL
    response = claude_service.get_client().messages.create(
        model=STAFF_MODEL, max_tokens=max_tokens, system=system,
        messages=[{"role": "user", "content": user}], operation=operation)
    raw = claude_service.response_text(response) or ""
    m = re.search(r"\{.*\}", raw, re.S)
    try:
        return json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        return {}


def _not_to_flag(db: DBSession, role: str) -> str:
    text = W.read_page(db, role, PREFS_PAGE)
    return ("WHAT THE COACH HAS TOLD YOU NOT TO FLAG:\n" + W.parse(text)[1].strip()) if text else ""


def review_one(role: str, b: dict, lines: list, squad: Optional[str], ask=None) -> list:
    """One worker's comments on the session (own database connection: runs in parallel)."""
    from backend.services.staff_room import ROSTER, Subject, role_context
    ask = ask or _ask
    db = SessionLocal()
    try:
        r = ROSTER[role]
        w = W.worker(role)
        try:
            day = date.fromisoformat(b.get("date") or "")
        except ValueError:
            day = None
        data = role_context(role, db, Subject(session_date=day, squad=squad, attendee_ids=_attendees(b)))
        system = _REVIEW.format(name=r.name, title=r.title, remit=r.remit, watch_for=r.watch_for,
                                safety="; ".join(w.safety) or "none", max_n=MAX_PER_WORKER, prefs=_not_to_flag(db, role))
        out = ask(system, f"{_session_text_for_staff(b, lines)}\n\nYOUR DATA:\n{data}", "builder_comments")
    except Exception:  # noqa: BLE001 - one worker failing must not stop the others
        log.exception("builder review failed for %s", role)
        return []
    finally:
        db.close()
    known = {l["id"]: l for l in lines}
    clean = []
    for c in (out.get("comments") or [])[:MAX_PER_WORKER]:
        if not isinstance(c, dict) or not str(c.get("message") or "").strip():
            continue
        lid = c.get("line_id") if c.get("line_id") in known else None
        clean.append({"role": role, "line_id": lid, "block": known[lid]["block"] if lid else None,
                      "flag": "safety" if c.get("flag") == "safety" and w.safety else "preference",
                      "message": str(c["message"]).strip()[:400],
                      "swimmer_ids": [int(x) for x in c.get("swimmer_ids") or [] if str(x).isdigit()]})
    return clean


def review(db: DBSession, session: models.Session, b: dict, ask=None) -> list:
    """All the reviewers, in parallel. Replaces the session's undecided comments with the new ones."""
    lines = line_index(b)
    if not lines:
        return comments_out(db, session)
    with ThreadPoolExecutor(max_workers=len(REVIEWERS)) as pool:
        results = list(pool.map(lambda role: review_one(role, b, lines, session.squad, ask), REVIEWERS))
    db.query(models.StaffNote).filter(models.StaffNote.session_id == session.id, models.StaffNote.trigger == "builder",
                                      models.StaffNote.status == "open").delete(synchronize_session=False)
    for c in [c for r in results for c in r]:
        db.add(models.StaffNote(role=c["role"], kind="concern" if c["flag"] == "safety" else "observation",
                                message=c["message"], swimmer_ids=c["swimmer_ids"], session_id=session.id,
                                trigger="builder", topic=f"Session {session.date}", flag=c["flag"],
                                anchor={"line_id": c["line_id"], "block": c["block"]}, status="open"))
    db.commit()
    return comments_out(db, session)


def comments_out(db: DBSession, session: models.Session) -> list:
    from backend.services.staff_room import ROSTER
    rows = db.query(models.StaffNote).filter(models.StaffNote.session_id == session.id,
                                             models.StaffNote.trigger == "builder").order_by(models.StaffNote.id).all()
    return [{"id": n.id, "role": n.role, "name": ROSTER[n.role].name if n.role in ROSTER else n.role,
             "flag": n.flag, "message": n.message, "line_id": (n.anchor or {}).get("line_id"),
             "block": (n.anchor or {}).get("block"), "status": n.status, "useful": n.useful, "reply": n.coach_reply}
            for n in rows if n.status != "superseded"]


def decide(db: DBSession, note_id: int, action: str, reason: Optional[str] = None, useful: Optional[bool] = None) -> dict:
    """The coach's answer: accept, dismiss (with an optional reason), or useful / not useful."""
    n = db.get(models.StaffNote, note_id)
    if not n or n.trigger != "builder":
        raise W.WorkbookError("No such comment")
    if useful is not None:
        n.useful = bool(useful)
    if action == "accept":
        n.status = "resolved"
    elif action == "dismiss":
        n.status = "dismissed"
        n.coach_reply = (reason or "").strip()[:400] or None
        if n.flag == "preference" and n.coach_reply:
            _learn_preference(db, n)
    elif action != "useful":
        raise W.WorkbookError("Accept, dismiss or useful")
    db.commit()
    return {"id": n.id, "status": n.status, "useful": n.useful}


def _learn_preference(db: DBSession, n: models.StaffNote) -> None:
    """A dismissed preference goes into that worker's 'Not to flag' page (written by the coach)."""
    line = f"- {n.coach_reply} (when I said: “{n.message[:160]}”)"
    page = W.get_page(db, n.role, PREFS_PAGE)
    if page:
        current = W.read_section(page.content, "Not to flag") or ""
        body = "\n".join(x for x in current.splitlines()[1:] if x.strip())
        W.write_section(db, n.role, PREFS_PAGE, "Not to flag", (body + "\n" + line).strip(), author=W.COACH,
                        reason="a dismissed comment", trigger=f"comment:{n.id}")
    else:
        content = W.render({"title": "What the coach doesn't want flagged", "kind": "philosophy",
                            "summary": "Preferences the coach has dismissed, with reasons"},
                           "Safety flags are never switched off by anything here.\n\n## Not to flag\n" + line + "\n")
        W.create_page(db, n.role, PREFS_PAGE, content, author=W.COACH, reason="a dismissed comment", trigger=f"comment:{n.id}")


# ---------------------------------------------------------------- Jess drafts

_DRAFT = """You are Jess, the Session Writer on a swimming coach's staff. Write the session the coach asks for,
straight into the club's session notation, in the coach's CURRENT style. Never use anything the coach has
moved on from.

THE NOTATION (one set per line):
- "4x100 Free build @1:30 [14]" - reps x distance, description, send-off, intensity in square brackets
  on the coach's scale ({scale}); "[14-16]" mixed, "[12->16]" build.
- Two lanes "@1:30/1:40"; rest instead of a send-off "r20 ~1:20" (rest, then the swim time).
- Numbered lines for what each rep does: "4x100 1) Kick 2) Drill 3) Swim 4) Build".
- A round: a line "3x" (optionally "3x descend each round") with its sets indented two spaces underneath.
- A line with words only ("Fins on") is a note.

GROUPS: use the session's groups as given. A block for everyone has "groups": [].

{context}

Return JSON only:
{{"title": "...", "aims": ["...", "..."],
  "blocks": [{{"name": "Warm up", "groups": [], "text": "notation lines"}}],
  "note_for_coach": "one sentence: how this fits the week, or what you weren't sure about"}}"""


def _recent_examples(db: DBSession, squad: Optional[str], before: date, n: int = 2) -> str:
    """The coach's own recent sessions (last 12 months), the best guide to the current style."""
    q = db.query(models.Session).filter(models.Session.builder.isnot(None), models.Session.date < before,
                                        models.Session.date >= before - timedelta(days=365))
    if squad:
        q = q.filter(models.Session.squad == squad)
    out = []
    for s in q.order_by(models.Session.date.desc()).limit(n).all():
        b = N.normalize_session(json.loads(json.dumps(s.builder)))
        out.append(N.session_text(b, b.get("effSys") or N.DEFAULT_SYS)[:2500])
    return "\n\n---\n\n".join(out)


def draft(db: DBSession, session: models.Session, current: dict, brief: str, ask=None) -> dict:
    """Jess's draft as builder blocks, plus the lines that didn't read as sets."""
    from backend.services import session_workshop
    ask = ask or _ask
    W.ensure_workbooks(db)
    parts = [session_workshop.writing_context(db, session.date, session.squad, _attendees(current))]
    try:
        from backend.services import season_planner
        week_plan = season_planner.staff_lines(db, session.squad, session.date)
        if week_plan:
            parts.append(week_plan)
    except Exception:  # noqa: BLE001 - the plan is extra context, never a blocker
        pass
    for path in ("style/current-style.md", "style/moved-on-from.md"):
        text = W.read_page(db, "sessions", path)
        if text:
            parts.append(f"YOUR PAGE {path}:\n{W.parse(text)[1].strip()[:2000]}")
    examples = _recent_examples(db, session.squad, session.date)
    if examples:
        parts.append("THE COACH'S RECENT SESSIONS (how they write now):\n" + examples)
    groups = [g.get("name") for g in current.get("groups") or [] if g.get("name")]
    parts.append("THE SESSION'S GROUPS: " + (", ".join(groups) or "one group (everyone)"))
    if current.get("start") and current.get("end"):
        parts.append(f"POOL TIME: {current['start']}-{current['end']}")
    from backend.services.session_builder import load_scales
    load_scales(db)
    sys_def = N.system(current.get("effSys") or N.DEFAULT_SYS) or N.EFF_SYSTEMS[N.DEFAULT_SYS]
    scale = sys_def.get("name", "Effort /20")
    if sys_def.get("zones"):
        scale += " - levels, easiest first: " + ", ".join(z["label"] for z in sys_def["zones"])
    system = _DRAFT.format(scale=scale, context="\n\n".join(p for p in parts if p))
    out = ask(system, f"THE COACH'S BRIEF:\n{brief.strip()}", "builder_draft", max_tokens=2500)
    by_name = {(g.get("name") or "").lower(): g["id"] for g in current.get("groups") or []}
    blocks, flagged = [], []
    for blk in out.get("blocks") or []:
        text = str(blk.get("text") or "")
        nb = N.new_block(str(blk.get("name") or "Block"), [by_name[x.lower()] for x in blk.get("groups") or [] if str(x).lower() in by_name])
        nb["items"] = N.parse_text(text)
        blocks.append(nb)
        for raw in text.splitlines():
            line = raw.strip()
            nodes = N.parse_line_nodes(line) if line else []
            if line and re.search(r"\d", line) and nodes and all(x["t"] == "line" and N.is_note_line(x) for x in nodes) \
                    and not re.match(r"^\d{1,2}\)", line):
                flagged.append(line)
    return {"title": str(out.get("title") or ""), "aims": [str(a) for a in (out.get("aims") or [])][:2],
            "blocks": blocks, "flagged": flagged, "note": str(out.get("note_for_coach") or "")[:300]}
