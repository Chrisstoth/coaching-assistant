"""Maggie's import queue: the coach's old session files into the app (step 7).

1. scan()     - every session file in the chosen folders becomes a queue item
                (one per distinct file content; originals are only read).
2. process()  - Maggie reads an item (code for the Excel template, the AI for
                the rest). Her reading is kept on the item, so a file is never
                paid for twice. A clean reading becomes a session at once; an
                uncertain one waits for the coach.
3. The coach approves, skips or opens a waiting item, and answers Maggie's
   questions about shorthand. An answer goes into the glossary, and the items
   that used that term are read again.

Imported sessions are marked source="history"; who they were for comes from
the folder (a camp folder makes a camp session). A session already in the app
for the same date, time of day and squad is never imported twice.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services import history_import as H
from backend.services import session_builder as SB
from backend.services import session_notation as N
from backend.services import workbooks as W

CLUB = W.CLUB


def glossary_text(db: DBSession) -> str:
    W.ensure_workbooks(db)
    g = W.get_page(db, "records", "glossary.md")
    return W.parse(g.content)[1] if g else ""


def scan(db: DBSession, roots) -> dict:
    files, skipped = H.find_files(roots)
    known = {sha for (sha,) in db.query(models.ImportItem.sha1).filter(models.ImportItem.club == CLUB)}
    added = 0
    for f in files:
        sha = H.fingerprint(f)
        if sha in known:
            continue
        known.add(sha)
        db.add(models.ImportItem(club=CLUB, path=str(f.path), sha1=sha, period=f.period, camp=f.camp, squad=f.squad,
                                 file_date=f.date, slot=f.slot, week_code=f.week_code, status="new"))
        added += 1
    db.commit()
    return {"found": len(files), "added": added, "skipped": dict(skipped)}


def _info(item: models.ImportItem) -> H.FileInfo:
    p = Path(item.path)
    return H.FileInfo(path=p, period=item.period or "unknown", squad=item.squad, camp=item.camp, week_code=item.week_code,
                      ext=p.suffix.lower(), sha1=item.sha1, date=item.file_date, slot=item.slot)


def _existing_session(db: DBSession, d: Optional[date], slot: Optional[str], squad: Optional[str], camp: Optional[str]):
    """A session already in the app for the same day, time of day, squad and camp-or-home."""
    if not d:
        return None
    for s in db.query(models.Session).filter(models.Session.date == d).all():
        s_slot = (s.builder or {}).get("slot") or (SB.slot_of(s.start_time) if s.start_time else None)
        if s_slot and slot and s_slot != slot:
            continue
        if bool(camp) != ((s.audience or {}).get("kind") == "camp"):
            continue
        if squad and s.squad and s.squad != squad:
            continue
        if s.builder or s.groups:
            return s
    return None


def process(db: DBSession, item: models.ImportItem, use_ai: bool = True) -> str:
    """Read one queued file and either import it or leave it for the coach."""
    info = _info(item)
    if not info.path.exists():
        item.status, item.error = "failed", "The file is no longer there (it may be online only in Dropbox)."
        db.commit()
        return item.status
    r = H.read_file(info, glossary=glossary_text(db), use_ai=use_ai)
    item.method, item.error = r.method, r.error or None
    if r.status == "skipped":
        db.commit()
        return item.status                              # left as new until the AI may be used
    if r.status == "failed":
        item.status = "failed"
        db.commit()
        return item.status
    item.draft = r.session
    item.totals, item.notes, item.flagged, item.terms = r.totals, r.notes, r.flagged, r.unknown_terms
    if r.status == "clean":
        import_item(db, item)
    else:
        item.status = "pending"
        db.commit()
    return item.status


def import_item(db: DBSession, item: models.ImportItem, draft: Optional[dict] = None) -> Optional[models.Session]:
    """Make the session from an item's reading (once)."""
    if item.session_id:
        return db.get(models.Session, item.session_id)
    b = json.loads(json.dumps(draft or item.draft or {}))
    try:
        d = date.fromisoformat(b.get("date") or "") if b.get("date") else item.file_date
    except ValueError:
        d = item.file_date
    if not d:
        item.status, item.error = "pending", "No date for this session; add one before importing."
        db.commit()
        return None
    slot = b.get("slot") or item.slot or "AM"
    dup = _existing_session(db, d, slot, item.squad, item.camp)
    if dup:
        item.status, item.session_id = "duplicate", dup.id
        db.commit()
        return dup
    b["date"], b["slot"] = d.isoformat(), slot
    squad = item.squad or ("Leeds" if "leeds" in item.path.lower() else None)
    s = models.Session(date=d, squad=squad, status="completed", source="history",
                       start_time=b.get("start") or None, end_time=b.get("end") or None,
                       audience={"kind": "camp", "label": item.camp} if item.camp else None)
    db.add(s)
    db.flush()
    SB.apply_builder(db, s, b)
    item.session_id, item.status = s.id, "imported"
    db.commit()
    return s


def skip(db: DBSession, item: models.ImportItem) -> None:
    item.status = "skipped"
    db.commit()


def questions(db: DBSession, limit: int = 30) -> list:
    """Shorthand Maggie wasn't sure of, most used first, with an example of each."""
    count, example = Counter(), {}
    for it in db.query(models.ImportItem).filter(models.ImportItem.club == CLUB, models.ImportItem.status == "pending").all():
        for t in {str(x).strip() for x in it.terms or [] if str(x).strip()}:
            count[t] += 1
            example.setdefault(t, Path(it.path).name)
    return [{"term": t, "files": n, "example": example[t]} for t, n in count.most_common(limit)]


def answer(db: DBSession, term: str, meaning: str) -> dict:
    """The coach's answer goes into the glossary, and the files that used the term are read again."""
    term, meaning = term.strip(), meaning.strip()
    if not term or not meaning:
        raise W.WorkbookError("Give the term and what it means.")
    W.ensure_workbooks(db)
    page = W.get_page(db, "records", "glossary.md")
    current = W.read_section(page.content, "Shorthand") or ""
    body = "\n".join(x for x in current.splitlines()[1:] if x.strip())
    W.write_section(db, "records", "glossary.md", "Shorthand", (body + f"\n- **{term}**: {meaning}").strip(), author=W.COACH,
                    reason=f"answered Maggie's question about {term}", trigger=f"glossary:{term}")
    again = 0
    for it in db.query(models.ImportItem).filter(models.ImportItem.club == CLUB, models.ImportItem.status == "pending").all():
        if term in {str(x).strip() for x in it.terms or []}:
            it.status = "new"
            again += 1
    db.commit()
    return {"term": term, "to_read_again": again}


def overview(db: DBSession) -> dict:
    by = defaultdict(Counter)
    for it in db.query(models.ImportItem.period, models.ImportItem.status).filter(models.ImportItem.club == CLUB).all():
        by[it.period or "unknown"][it.status] += 1
    return {"periods": {k: dict(v) for k, v in sorted(by.items())}}


def item_out(it: models.ImportItem) -> dict:
    preview = ""
    if it.draft:
        b = N.normalize_session(json.loads(json.dumps(it.draft)))
        preview = N.session_text(b, b.get("effSys") or N.DEFAULT_SYS)
    return {"id": it.id, "file": Path(it.path).name, "folder": str(Path(it.path).parent), "period": it.period, "camp": it.camp,
            "date": it.file_date.isoformat() if it.file_date else None, "slot": it.slot, "status": it.status,
            "method": it.method, "totals": it.totals or [], "notes": it.notes or [], "flagged": it.flagged or [],
            "terms": it.terms or [], "error": it.error, "session_id": it.session_id, "preview": preview}


def run_batch(db: DBSession, limit: int = 50, use_ai: bool = True) -> dict:
    """Read the next queued files (oldest seasons last, so this season's are first)."""
    items = db.query(models.ImportItem).filter(models.ImportItem.club == CLUB, models.ImportItem.status == "new") \
        .order_by(models.ImportItem.period.desc(), models.ImportItem.file_date.desc()).limit(limit).all()
    done = Counter(process(db, it, use_ai=use_ai) for it in items)
    return {"read": len(items), **dict(done)}
