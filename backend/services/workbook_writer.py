"""After a session: the staff update their workbooks (the first full loop).

When the coach finishes a register, Fiona (physiologist) reads how each swimmer
went and Jess (Session Writer) reads whether the session was swum as written.
Each may make a few small edits to their own workbook: a journal line, or one
section of a page, with a confidence and a link to the session. Code checks
every edit before it is saved: the page must be in their own folders, the edit
small, and the whole conversation is tagged so it can be undone together.
"""

from __future__ import annotations

import json
import re
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services import session_notation as N
from backend.services import workbooks as W

WRITERS = ("physiologist", "sessions")
MAX_EDITS = 3

SYSTEM = """You are {name}, the {title} on a swimming club's coaching staff. You keep a workbook: short
markdown pages about what you have learned about this squad. A session has just finished; read what
happened and decide whether anything is worth writing down. Most sessions need one journal line or nothing.

How you write:
- Only what the evidence shows. Every new point names the session it came from ("session {session_id}, {date}").
- Confidence: "hypothesis" for a first sighting, "seen-once", or "pattern" only with three or more sightings
  you can point to. Never call something a pattern on one session.
- Plain coaching language. Never a medical diagnosis.
- Write only in your own folders: {writes}. A swimmer's page is at the path given next to their name.
- Change one section of a page at a time; keep what is already there unless the evidence changes it.

{direction}

Return JSON only:
{{"edits": [
  {{"kind": "journal", "text": "one dated line, e.g. Ruby flat after race pace on two days running (session 12)"}},
  {{"kind": "section", "path": "swimmers/ruby-wheeler.md", "title": "Ruby Wheeler", "heading": "Recovery",
    "text": "the whole new text of that section, as markdown", "confidence": "hypothesis",
    "summary": "one line for the page index", "swimmers": [14]}}
]}}
At most {max_edits} edits. Return {{"edits": []}} when nothing is worth writing."""


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-") or "swimmer"


def _session_lines(session: models.Session) -> str:
    if session.builder:
        b = N.normalize_session(json.loads(json.dumps(session.builder)))
        return N.session_text(b, b.get("effSys") or N.DEFAULT_SYS)
    parts = []
    for g in sorted(session.groups or [], key=lambda g: g.group_number):
        sets = g.sets.get("text") or g.sets.get("raw") if isinstance(g.sets, dict) else g.sets
        parts.append(f"Group {g.group_number} {g.description or ''}:\n{sets or '(no sets recorded)'}")
    return "\n\n".join(parts) or "(no sets recorded)"


def _register_lines(db: DBSession, session: models.Session) -> tuple[str, list]:
    names = {}
    group_name = {g.group_number: (g.description or f"Group {g.group_number}") for g in session.groups or []}
    lines = []
    for e in sorted(session.entries or [], key=lambda e: e.swimmer_id):
        s = db.get(models.Swimmer, e.swimmer_id)
        if not s or e.attended is None:
            continue
        names[s.id] = s.name
        if not e.attended:
            lines.append(f"- {s.name}: absent")
            continue
        bits = [f"swam {group_name.get(e.group_done or e.group_planned, 'the session')}"]
        if e.response:
            bits.append(f"went {e.response}")
        if e.coach_observation:
            bits.append(f"coach's note: {e.coach_observation.strip()}")
        lines.append(f"- {s.name} (id {s.id}, page swimmers/{slug(s.name)}.md): " + "; ".join(bits))
    return "\n".join(lines) or "(no register taken)", list(names)


def _context(db: DBSession, role: str, session: models.Session) -> str:
    register, swimmer_ids = _register_lines(db, session)
    swum = session.as_swum or {}
    parts = [f"SESSION {session.id}, {session.date.isoformat()} ({session.squad or 'squad'})",
             "WHAT WAS WRITTEN:\n" + _session_lines(session)[:5000],
             "SWUM AS WRITTEN?: " + ({"as_written": "yes", "changed": f"changed on deck - {swum.get('note') or 'no detail'}"}.get(swum.get("status")) or "not recorded"),
             "REGISTER:\n" + register,
             "YOUR WORKBOOK (index):\n" + W.read_index(db, role)]
    pages = []
    if role == "physiologist":
        for sid in swimmer_ids:
            s = db.get(models.Swimmer, sid)
            text = W.read_page(db, role, f"swimmers/{slug(s.name)}.md") if s else None
            if text:
                pages.append(f"--- swimmers/{slug(s.name)}.md ---\n{text[:1500]}")
    else:
        for path in ("style/current-style.md", "style/moved-on-from.md"):
            text = W.read_page(db, role, path)
            if text:
                pages.append(f"--- {path} ---\n{text[:1500]}")
    if pages:
        parts.append("PAGES YOU MAY UPDATE:\n" + "\n\n".join(pages)[:6000])
    return "\n\n".join(parts)


def _ask(system: str, user: str) -> dict:
    from backend.services import claude_service
    response = claude_service.get_client().messages.create(
        model=claude_service.FAST_MODEL, max_tokens=1500, system=system,
        messages=[{"role": "user", "content": user}], operation="workbook_update")
    raw = claude_service.response_text(response) or ""
    m = re.search(r"\{.*\}", raw, re.S)
    try:
        return json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        return {}


def apply_edits(db: DBSession, role: str, edits: list, session: models.Session) -> dict:
    """Save the edits that pass the rules; report the rest."""
    trigger = f"session:{session.id}"
    reason = f"after the {session.date:%d %b} session"
    saved, refused = [], []
    for e in (edits or [])[:MAX_EDITS]:
        try:
            if e.get("kind") == "journal" and str(e.get("text") or "").strip():
                W.append_journal(db, role, str(e["text"])[:400], trigger=trigger, on=session.date)
                saved.append("journal")
            elif e.get("kind") == "section":
                path = str(e.get("path") or "")
                if not W.may_write(role, path):
                    raise W.WorkbookError(f"{path} is outside {role}'s folders")
                conf = str(e.get("confidence") or "").lower()
                header = {"title": e.get("title"), "kind": "style" if path.startswith("style/") else "case",
                          "confidence": conf if conf in W.CONFIDENCE else "hypothesis",
                          "summary": str(e.get("summary") or "")[:200] or None,
                          "swimmers": [int(x) for x in e.get("swimmers") or [] if str(x).isdigit()]}
                W.write_section(db, role, path, str(e.get("heading") or "Notes")[:80], str(e.get("text") or "")[:3000],
                                author=role, reason=reason, trigger=trigger, header=header)
                saved.append(W._clean_path(path))
        except W.WorkbookError as err:
            db.rollback()
            refused.append(str(err))
    return {"saved": saved, "refused": refused}


def update_after_session(db: DBSession, session: models.Session, ask=None) -> dict:
    """Each writer reads the session and updates their workbook. `ask` can be swapped in tests."""
    ask = ask or _ask
    W.ensure_workbooks(db)
    out = {}
    for role in WRITERS:
        w = W.worker(role)
        if role == "sessions" and not session.as_swum and not session.builder:
            continue      # nothing for Jess to learn from a session that wasn't written in the builder
        system = SYSTEM.format(name=w.name, title=w.title, writes=w.writes, max_edits=MAX_EDITS,
                               session_id=session.id, date=session.date.isoformat(),
                               direction=W.job_direction_block(db, role))
        reply = ask(system, _context(db, role, session))
        out[role] = apply_edits(db, role, reply.get("edits") or [], session)
    return out


def recent_notes(db: DBSession, limit: int = 6) -> list:
    """What the staff wrote most recently, for the top of the Session Builder."""
    rows = []
    for role in WRITERS:
        w = W.worker(role)
        journals = [p for p in W.pages(db, role) if p.kind == "journal"]
        for p in sorted(journals, key=lambda p: p.path, reverse=True)[:2]:
            for line in reversed([x for x in W.parse(p.content)[1].splitlines() if x.startswith("- ")]):
                rows.append({"role": role, "name": w.name, "text": line[2:].strip(), "page": p.path,
                             "at": p.updated_at.isoformat() if p.updated_at else None})
    rows.sort(key=lambda r: r["page"], reverse=True)
    return rows[:limit]
