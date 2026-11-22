"""Notes the coach takes during a session, and how the debrief reads them.

A note can be about the whole session, one set, one or more swimmers, or a mix.
They are the coach's own words written at the time, so the debrief treats them as
evidence alongside what the coach says afterwards, and proposes records from them
for the coach to confirm. Nothing here writes to a swimmer's record directly.
"""
import os
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models

MAX_TEXT = 2000
MAX_LABEL = 300


def _club_zone():
    """The club's clock, for showing when a note was made. The server runs on UTC."""
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(os.getenv("APP_TIMEZONE", "Europe/London"))
    except Exception:  # noqa: BLE001 - no zone data: fall back to the server's clock
        return None


def clean_swimmer_ids(db: DBSession, ids) -> list[int]:
    """Only swimmers that exist, each once, in the order given."""
    wanted = []
    for value in ids or []:
        try:
            number = int(value)
        except (TypeError, ValueError):
            continue
        if number not in wanted:
            wanted.append(number)
    if not wanted:
        return []
    known = {row.id for row in db.query(models.Swimmer.id).filter(models.Swimmer.id.in_(wanted)).all()}
    return [number for number in wanted if number in known]


def clean_set_ref(ref) -> Optional[dict]:
    if not isinstance(ref, dict):
        return None
    label = str(ref.get("label") or "").strip()[:MAX_LABEL]
    block_id = str(ref.get("block_id") or "").strip() or None
    line_id = str(ref.get("line_id") or "").strip() or None
    if not (label or block_id or line_id):
        return None
    return {"block_id": block_id, "line_id": line_id, "label": label or None}


def parse_noted_at(value) -> datetime:
    """When the note was made, in UTC (stored that way so SQLite and Postgres agree)."""
    if isinstance(value, datetime):
        moment = value
    else:
        try:
            moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return datetime.now(timezone.utc)
    moment = moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def notes_for(db: DBSession, session_id: int) -> list[models.SessionNote]:
    return db.query(models.SessionNote).filter(
        models.SessionNote.session_id == session_id,
    ).order_by(models.SessionNote.noted_at, models.SessionNote.id).all()


def _names(db: DBSession, notes) -> dict[int, str]:
    ids = {number for note in notes for number in (note.swimmer_ids or [])}
    if not ids:
        return {}
    return {row.id: row.name for row in db.query(models.Swimmer).filter(models.Swimmer.id.in_(ids)).all()}


def note_out(note: models.SessionNote, names: dict[int, str]) -> dict:
    return {
        "id": note.id,
        "session_id": note.session_id,
        "client_id": note.client_id,
        "text": note.text,
        "swimmer_ids": list(note.swimmer_ids or []),
        "swimmer_names": [names[i] for i in (note.swimmer_ids or []) if i in names],
        "set_ref": note.set_ref,
        "kind": note.kind,
        "tagged_by": note.tagged_by,
        "noted_at": note.noted_at,
        "created_at": note.created_at,
    }


# ---------------------------------------------------------------- understanding a note

KINDS = ("technique", "effort", "behaviour", "injury", "illness", "attendance", "general")
KIND_WORDS = {
    "technique": "technique", "effort": "effort / how they swam it", "behaviour": "behaviour",
    "injury": "injury", "illness": "illness", "attendance": "attendance", "general": "general",
}


def clean_kind(kind) -> Optional[str]:
    kind = str(kind or "").strip().lower()
    return kind if kind in KINDS else None


def candidate_swimmers(db: DBSession, session: models.Session) -> list[dict]:
    """Who a note could be about: those marked in on the register first, then the
    rest of the squad and anyone else on the register."""
    entries = db.query(models.SessionEntry).filter(models.SessionEntry.session_id == session.id).all()
    here = {e.swimmer_id for e in entries if e.attended}
    ids = {e.swimmer_id for e in entries}
    q = db.query(models.Swimmer).filter(models.Swimmer.active == True)  # noqa: E712
    squad = q.filter(models.Swimmer.squad == session.squad).all() if session.squad else []
    others = q.filter(models.Swimmer.id.in_(ids)).all() if ids else []
    if not squad and not others:
        squad = q.all()
    seen, out = set(), []
    for s in sorted([*squad, *others], key=lambda s: (s.id not in here, s.name)):
        if s.id in seen:
            continue
        seen.add(s.id)
        out.append({"id": s.id, "name": s.name, "here": s.id in here})
    return out


def _words(text: str) -> list[str]:
    import re
    return re.sub(r"[^a-z0-9' ]+", " ", (text or "").lower()).split()


def names_in(text: str, swimmers: list[dict], aliases: dict[str, int]) -> list[int]:
    """Swimmers named in the words: full names, first names (when only one swimmer
    has it, or they're here), surnames, and names the coach has taught the app."""
    words = _words(text)
    joined = " " + " ".join(words) + " "
    found = []
    firsts: dict = {}
    for s in swimmers:
        firsts.setdefault(_words(s["name"])[0] if _words(s["name"]) else "", []).append(s)
    for s in swimmers:
        parts = _words(s["name"])
        if not parts:
            continue
        full = " " + " ".join(parts) + " "
        same_first = firsts.get(parts[0], [])
        first_ok = len(same_first) == 1 or (s.get("here") and sum(1 for x in same_first if x.get("here")) == 1)
        if full in joined or (first_ok and f" {parts[0]} " in joined) or (
                len(parts) > 1 and len(parts[-1]) > 3 and f" {parts[-1]} " in joined):
            found.append(s["id"])
    known = {s["id"] for s in swimmers}
    for heard, sid in aliases.items():
        if sid in known and sid not in found and f" {heard} " in joined:
            found.append(sid)
    return found


def _ask_model(prompt: str) -> Optional[dict]:
    """The quick model's answer as JSON, or None when it can't be asked."""
    import json
    from backend.services.claude_service import FAST_MODEL, _strip_json, get_client
    try:
        response = get_client().messages.create(
            model=FAST_MODEL, max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        return json.loads(_strip_json(response.content[0].text))
    except Exception:  # noqa: BLE001 - no key, no signal, odd answer: fall back to the names
        return None


def understand(db: DBSession, session: models.Session, text: str, sets: list[dict],
               want_set: bool = True) -> dict:
    """
    Work out from the coach's words who a note is about, which set (if any) and
    what kind of note it is. The quick model reads the words with the squad's
    names and the session's sets; if it can't answer, names said in the words
    are matched directly. Nothing is invented: unknown ids are dropped.

    sets: [{"value": "line:abc" | "block:xyz", "block_id", "line_id", "label"}]
    Returns {"swimmer_ids", "set_ref", "kind"}.
    """
    swimmers = candidate_swimmers(db, session)
    aliases = {row.heard: row.swimmer_id for row in db.query(models.SwimmerNameAlias).all()}
    fallback = {"swimmer_ids": names_in(text, swimmers, aliases), "set_ref": None, "kind": None}
    if not swimmers and not sets:
        return fallback

    roster = "\n".join(f"- {s['id']}: {s['name']}{' (here)' if s['here'] else ''}" for s in swimmers[:80])
    set_list = "\n".join(f"- {s['value']}: {s['label']}" for s in (sets or [])[:60]) if want_set else ""
    taught = ", ".join(f'"{h}" = {sid}' for h, sid in list(aliases.items())[:40])
    prompt = f"""A swimming coach said or typed this note during a training session:
"{text[:1000]}"

The swimmers (id: name). Phone speech recognition often mishears names, so judge by sound and
common nicknames (Olly = Oliver). Names the coach has taught the app: {taught or 'none'}.
{roster or '(none listed)'}
{f'''
The session's sets (id: what it is):
{set_list}
''' if set_list else ''}
Answer:
- swimmer_ids: the swimmers the note is about. "Everyone", "the squad" or "the group" means none of them
  individually: give []. Only ids from the list; [] when unsure.
- set: {'the id of the set or block it is about, or null if it is about the session in general or you are not fairly sure' if set_list else 'null'}.
- kind: one of {', '.join(KINDS)}. technique = how they swim (stroke, turns, starts, underwater);
  effort = how hard or how well they swam it, times, pace; behaviour = attitude, focus, messing about;
  attendance = late, left early, missed part; general = anything else.
Return only JSON: {{"swimmer_ids": [12], "set": "line:abc" or null, "kind": "technique"}}"""
    answer = _ask_model(prompt)
    if not isinstance(answer, dict):
        return fallback

    known = {s["id"] for s in swimmers}
    ids = []
    for value in answer.get("swimmer_ids") or []:
        if isinstance(value, int) and value in known and value not in ids:
            ids.append(value)
    set_ref = None
    if want_set and answer.get("set"):
        chosen = next((s for s in sets or [] if s.get("value") == answer.get("set")), None)
        if chosen:
            set_ref = clean_set_ref(chosen)
    return {"swimmer_ids": ids, "set_ref": set_ref, "kind": clean_kind(answer.get("kind"))}


def notes_out(db: DBSession, notes) -> list[dict]:
    names = _names(db, notes)
    return [note_out(note, names) for note in notes]


def _clock(moment) -> str:
    """The time on the pool clock when the note was made, e.g. "20:42"."""
    if not moment:
        return ""
    if not moment.tzinfo:            # SQLite hands it back without its zone; it was stored as UTC
        moment = moment.replace(tzinfo=timezone.utc)
    zone = _club_zone()
    return (moment.astimezone(zone) if zone else moment.astimezone()).strftime("%H:%M")


def notes_text(db: DBSession, session_id: Optional[int]) -> str:
    """The session's notes as plain lines for the staff to read, or "" if none."""
    if not session_id:
        return ""
    notes = notes_for(db, session_id)
    if not notes:
        return ""
    names = _names(db, notes)
    lines = []
    for note in notes:
        about = []
        who = [names[i] for i in (note.swimmer_ids or []) if i in names]
        if who:
            about.append(", ".join(who))
        if note.set_ref and note.set_ref.get("label"):
            about.append(f"set: {note.set_ref['label']}")
        if note.kind and note.kind != "general":
            about.append(KIND_WORDS.get(note.kind, note.kind))
        prefix = " ".join(filter(None, [_clock(note.noted_at), f"[{' · '.join(about)}]" if about else ""]))
        lines.append(f"  - {prefix}: {note.text}" if prefix else f"  - {note.text}")
    return "\n".join(lines)
