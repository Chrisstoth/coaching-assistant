"""Workbooks: what each member of staff knows, written down as markdown pages.

Each worker (the physiologist, the analyst ... and Maggie, the Records Officer)
keeps a workbook: pages they write themselves, one section at a time, plus a
job description the coach can direct. The rules (docs/design/workers-and-workbooks.md):

- Every save is a new version with who wrote it, why and what prompted it.
  Restoring copies an old version forward; nothing is ever overwritten.
- A worker writes only to its own workbook, and only one section at a time.
  It can read every workbook.
- The coach's edits win: a worker's edit made against an older version is
  refused, and sections the coach has locked are the coach's alone.
- Every change from one conversation (one "trigger") can be undone together,
  and named snapshots can be restored.
- Deleting a swimmer removes their pages, every old version of them, and their
  name from other pages.

A page's text starts with a small header the app reads:

    ---
    title: Ruby W - training response
    kind: case
    swimmers: [14]
    confidence: hypothesis
    summary: Possibly needs 48h after race-pace sets
    ---
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models

CLUB = "default"                  # one club for now; every page is tagged so others can follow
COACH = "coach"                   # the author name for the coach's own edits
MAX_WORKER_PAGE = 12_000          # a worker's page stays short; the tidy-up turns journals into casebook pages
MAX_COACH_PAGE = 60_000
KINDS = ("job", "philosophy", "case", "journal", "glossary", "format", "log", "style", "watchlist", "findings", "reference")
CONFIDENCE = ("hypothesis", "seen-once", "pattern")


class WorkbookError(Exception):
    """A change the rules don't allow (shown to whoever asked for it)."""


class Conflict(WorkbookError):
    """The page changed since it was read: read it again and redo the change."""


# ---------------------------------------------------------------- the staff

@dataclass
class Worker:
    role: str
    name: str
    title: str
    remit: str
    watch_for: str
    evidence: str
    predicts: str
    safety: list = field(default_factory=list)
    quiet: str = ""
    writes: str = ""
    starter: dict = field(default_factory=dict)   # path -> (title, kind, body)


def _roster() -> dict:
    from backend.services.staff_room import ROSTER
    return ROSTER


_FIXED = {
    "physiologist": dict(
        evidence="Sessions each swimmer actually attended (register), the group they swam, the zone metres worked out in code, "
                 "the coach's session notes and swimmer responses (good / flat / ill / injured), illness and injury records, growth.",
        predicts="How a swimmer will respond to a block, e.g. 'Ruby flat after 2 race-pace days in a row' - checked against the register responses.",
        safety=["week-on-week load jump of more than 15%", "a swimmer returning from injury or illness",
                "hard days stacked with no recovery", "a growth spurt changing what a swimmer can absorb"],
        quiet="When the numbers are ordinary and nothing would change a decision.",
        writes="swimmers/, squad/, philosophy/, journal/, watch-list.md, findings.md"),
    "analyst": dict(
        evidence="Race results, splits, pacing, LaneWatch race analysis, personal bests and qualifying gaps; the sessions a swimmer attended before a race.",
        predicts="Race times at named meets, e.g. 'Ruby 200 free under 2:10 at County' - checked against the result.",
        safety=[],
        quiet="When there is no new race evidence since the last look.",
        writes="swimmers/, meets/, squad/, journal/, watch-list.md, findings.md"),
    "planner": dict(
        evidence="The season plan, what was actually swum (builder sessions and the register), meet priorities, the staff's findings.",
        predicts="Whether a block will land the peak on the priority meet, e.g. 'Girls peak for County in week 1.3.4'.",
        safety=["no recovery week after a competition", "a planned load the register shows won't happen"],
        quiet="When the plan and what was swum agree.",
        writes="season/, blocks/, journal/, watch-list.md, findings.md"),
    "manager": dict(
        evidence="Attendance, availability, school year, status, group moves, the swimmer's foundation profile.",
        predicts="Attendance through busy periods, e.g. 'Year 11s drop to 2 sessions a week in May'.",
        safety=["a swimmer's attendance or wellbeing changing sharply", "exam years and life load"],
        quiet="When attendance and groups are steady.",
        writes="swimmers/, squad/, journal/, watch-list.md"),
    "meets": dict(
        evidence="The competition calendar, entries, timetables and results.",
        predicts="Entries and qualifiers for a meet, e.g. '6 swimmers qualify for Regionals'.",
        safety=["two races too close together for a swimmer"],
        quiet="When nothing is due.",
        writes="meets/, journal/, watch-list.md"),
    "sessions": dict(
        evidence="The coach's builder sessions (recent ones first), what was swum as written or changed, debriefs, the plan for the week.",
        predicts="How a session will go, e.g. 'this main set runs 4 minutes over'.",
        safety=["a session well over the pool time", "the same group given hard sessions back to back"],
        quiet="When the session fits the plan and the coach's current style.",
        writes="style/, sets/, journal/, watch-list.md",
        starter={
            "style/current-style.md": ("Current style", "style",
                "How the coach writes sessions now. Confirmed by the coach; this overrides everything else.\n\n## Structure\n\n## Sets the coach uses a lot\n\n## Intensity and send-offs\n"),
            "style/moved-on-from.md": ("Moved on from", "style",
                "Practices the coach no longer uses, each with the coach's reason. Never used unless the coach asks.\n\n## Moved on from\n"),
            "style/history.md": ("Style history", "style",
                "How the coach's sessions changed over time, by period.\n\n## BPSC 2014-16\n\n## Leeds 2015-17\n\n## BPSC 2018-22\n\n## BPSC 2022-now\n"),
        }),
}

RECORDS = Worker(
    role="records", name="Maggie", title="Records Officer",
    remit="Reading and decoding the coach's old session files and registers into the app's notation, keeping the glossary of "
          "the coach's shorthand, and keeping the import log. Speaks only about data.",
    watch_for="A file layout seen for the first time, shorthand not in the glossary, totals that don't match the file, "
              "dates that disagree, names that match no swimmer, the same session in two folders.",
    evidence="The files themselves and the glossary; never a guess. A line that won't read is flagged, not guessed.",
    predicts="How many files of a batch will read cleanly, checked when the batch is done.",
    safety=[],
    quiet="In coaching discussions. Maggie speaks only about data and imports.",
    writes="formats/, glossary.md, import-log/, journal/",
    starter={
        "glossary.md": ("Glossary", "glossary",
            "The coach's terms and shorthand, approved by the coach. Shared by every member of staff.\n\n## Strokes and drills\n\n## Equipment\n\n## Intensity\n\n## Groups\n"),
    },
)


def workers() -> dict:
    """Every member of staff with a workbook, in staff order."""
    out = {}
    roster = _roster()
    from backend.services.staff_room import ROLE_ORDER
    for key in ROLE_ORDER:
        r = roster[key]
        f = _FIXED.get(key, {})
        out[key] = Worker(role=key, name=r.name, title=r.title, remit=r.remit, watch_for=r.watch_for,
                          evidence=f.get("evidence", ""), predicts=f.get("predicts", ""), safety=f.get("safety", []),
                          quiet=f.get("quiet", ""), writes=f.get("writes", ""), starter=f.get("starter", {}))
    out[RECORDS.role] = RECORDS
    return out


def worker(role: str) -> Worker:
    w = workers().get(role)
    if not w:
        raise WorkbookError(f"No member of staff called {role!r}")
    return w


def fixed_job(w: Worker) -> str:
    """The part of a job description the app sets: how this worker operates."""
    safety = "\n".join(f"- {s}" for s in w.safety) or "- none of their own; they raise others' safety flags when they see them"
    return (f"# {w.name}, {w.title}\n\n## What I do\n{w.remit}\n\n## What I watch for\n{w.watch_for}\n\n"
            f"## What counts as evidence\n{w.evidence}\n\n## What I predict (so it can be checked)\n{w.predicts}\n\n"
            f"## Safety flags (always raised; the coach can acknowledge them, never switch them off)\n{safety}\n\n"
            f"## When I stay quiet\n{w.quiet}\n\n## Where I write\nOnly in my own workbook: {w.writes}. I can read every workbook.\n")


JOB_TEMPLATE = ("Your direction for {name}. Anything here shapes what {name} focuses on and how they speak; "
                "it can't switch off their safety flags.\n\n## Focus\n\n## Priorities\n\n## How I'd like you to speak\n")


# ---------------------------------------------------------------- page header

_HEADER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.S)


def parse(content: str) -> tuple[dict, str]:
    """Split a page into its header fields and its body."""
    m = _HEADER.match(content or "")
    if not m:
        return {}, content or ""
    meta = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        k, v = k.strip(), v.strip()
        if v.startswith("[") and v.endswith("]"):
            meta[k] = [x.strip().strip("'\"") for x in v[1:-1].split(",") if x.strip()]
        else:
            meta[k] = v.strip("'\"")
    return meta, content[m.end():]


def render(meta: dict, body: str) -> str:
    lines = []
    for k in ("title", "kind", "swimmers", "confidence", "last_reviewed", "summary"):
        v = meta.get(k)
        if v in (None, "", []):
            continue
        lines.append(f"{k}: [{', '.join(str(x) for x in v)}]" if isinstance(v, list) else f"{k}: {v}")
    return "---\n" + "\n".join(lines) + "\n---\n\n" + body.lstrip("\n")


def _apply_meta(page: models.WorkbookPage, content: str) -> None:
    meta, _ = parse(content)
    page.title = (meta.get("title") or page.title or page.path).strip()[:200]
    kind = (meta.get("kind") or page.kind or "case").strip().lower()
    page.kind = kind if kind in KINDS else "case"
    page.summary = (meta.get("summary") or "").strip()[:500] or None
    conf = (meta.get("confidence") or "").strip().lower()
    page.confidence = conf if conf in CONFIDENCE else None
    ids = []
    for x in meta.get("swimmers") or []:
        try:
            ids.append(int(x))
        except (TypeError, ValueError):
            pass
    page.swimmer_ids = ids
    try:
        page.last_reviewed = date.fromisoformat(meta["last_reviewed"]) if meta.get("last_reviewed") else None
    except ValueError:
        page.last_reviewed = None


# ---------------------------------------------------------------- sections

_HEAD = re.compile(r"^(#{1,6})\s+(.*?)\s*$", re.M)


def sections(body: str) -> list[dict]:
    """[{level, heading, start, end}] for each heading in a page body (end = where the section stops)."""
    heads = [(len(m.group(1)), m.group(2), m.start()) for m in _HEAD.finditer(body)]
    out = []
    for i, (lvl, h, start) in enumerate(heads):
        end = len(body)
        for lvl2, _, s2 in heads[i + 1:]:
            if lvl2 <= lvl:
                end = s2
                break
        out.append({"level": lvl, "heading": h, "start": start, "end": end})
    return out


def _norm(h: str) -> str:
    return re.sub(r"\s+", " ", (h or "").strip().lower())


def read_section(content: str, heading: str) -> Optional[str]:
    _, body = parse(content)
    for s in sections(body):
        if _norm(s["heading"]) == _norm(heading):
            return body[s["start"]:s["end"]].rstrip() + "\n"
    return None


def replace_section(content: str, heading: str, text: str) -> str:
    """The page with one section's text replaced (or added at the end)."""
    meta, body = parse(content)
    text = text.strip("\n")
    for s in sections(body):
        if _norm(s["heading"]) == _norm(heading):
            new = f"{'#' * s['level']} {s['heading']}\n{text}\n\n"
            body = body[:s["start"]] + new + body[s["end"]:].lstrip("\n")
            break
    else:
        body = body.rstrip("\n") + f"\n\n## {heading.strip()}\n{text}\n"
    return render(meta, body) if meta else body


# ---------------------------------------------------------------- reading

def _q(db: DBSession, role: Optional[str] = None, include_archived: bool = False):
    q = db.query(models.WorkbookPage).filter(models.WorkbookPage.club == CLUB)
    if role:
        q = q.filter(models.WorkbookPage.role == role)
    if not include_archived:
        q = q.filter(models.WorkbookPage.archived.is_(False))
    return q


def get_page(db: DBSession, role: str, path: str, include_archived: bool = False) -> Optional[models.WorkbookPage]:
    return _q(db, role, include_archived).filter(models.WorkbookPage.path == path).first()


def pages(db: DBSession, role: str) -> list:
    return _q(db, role).order_by(models.WorkbookPage.path).all()


def read_index(db: DBSession, role: str) -> str:
    """One line per page: what a worker reads first, to pick the two or three pages it needs."""
    lines = []
    for p in pages(db, role):
        bits = [p.kind] + ([p.confidence] if p.confidence else [])
        when = p.updated_at.date().isoformat() if p.updated_at else ""
        lines.append(f"- {p.path} - {p.title}" + (f": {p.summary}" if p.summary else "") + f" ({', '.join(bits)}; v{p.version}{', ' + when if when else ''})")
    return "\n".join(lines) or "(no pages yet)"


def read_page(db: DBSession, role: str, path: str, section: Optional[str] = None) -> Optional[str]:
    p = get_page(db, role, path)
    if not p:
        return None
    return read_section(p.content, section) if section else p.content


def search(db: DBSession, query: str, role: Optional[str] = None, limit: int = 10) -> list:
    """Pages whose words match, best first. Plain matching keeps it working on any database."""
    words = [w for w in re.findall(r"[a-z0-9]+", (query or "").lower()) if len(w) > 1]
    if not words:
        return []
    scored = []
    for p in _q(db, role).all():
        hay_t = f"{p.title} {p.summary or ''} {p.path}".lower()
        hay_c = (p.content or "").lower()
        score = sum(3 * hay_t.count(w) + hay_c.count(w) for w in words)
        if score:
            scored.append((score, p))
    scored.sort(key=lambda x: (-x[0], x[1].path))
    return [{"role": p.role, "path": p.path, "title": p.title, "summary": p.summary, "score": s} for s, p in scored[:limit]]


# ---------------------------------------------------------------- writing

def _check_author(page_role: str, author: str) -> None:
    if author != COACH and author != page_role:
        raise WorkbookError(f"{author} can't write in the {page_role} workbook; workers write only in their own.")


def _revise(db: DBSession, page: models.WorkbookPage, content: str, author: str, reason: Optional[str], trigger: Optional[str]) -> models.WorkbookPage:
    limit = MAX_COACH_PAGE if author == COACH else MAX_WORKER_PAGE
    if len(content) > limit:
        raise WorkbookError(f"That page would be {len(content)} characters; the limit is {limit}. Move older notes into a summary.")
    page.version = (page.version or 0) + 1
    page.content = content
    _apply_meta(page, content)
    db.add(models.PageRevision(page=page, version=page.version, content=content, author=author,
                               reason=(reason or "").strip()[:500] or None, trigger=trigger))
    return page


def create_page(db: DBSession, role: str, path: str, content: str, *, author: str, reason: Optional[str] = None,
                trigger: Optional[str] = None, title: Optional[str] = None, kind: Optional[str] = None, coach: Optional[str] = None) -> models.WorkbookPage:
    worker(role)
    _check_author(role, author)
    path = _clean_path(path)
    if path == "job.md" and author != COACH:
        raise WorkbookError("Only the coach writes the job direction.")
    existing = get_page(db, role, path, include_archived=True)
    if existing and not existing.archived:
        raise WorkbookError(f"{path} already exists; change a section of it instead.")
    if existing:   # bring an archived page back as a new version
        existing.archived = False
        page = _revise(db, existing, content, author, reason or "brought back", trigger)
    else:
        page = models.WorkbookPage(club=CLUB, coach=coach, role=role, path=path, title=title or path, kind=kind or "case", version=0, locked=[])
        db.add(page)
        page = _revise(db, page, content, author, reason, trigger)
    db.commit()
    return page


def write_page(db: DBSession, role: str, path: str, content: str, *, author: str, base_version: Optional[int],
               reason: Optional[str] = None, trigger: Optional[str] = None) -> models.WorkbookPage:
    """Replace a whole page. The coach's tool; a worker changes one section at a time."""
    if author != COACH:
        raise WorkbookError("Workers change one section at a time.")
    p = get_page(db, role, _clean_path(path))
    if not p:
        return create_page(db, role, path, content, author=author, reason=reason, trigger=trigger)
    if base_version is not None and base_version != p.version:
        raise Conflict(f"This page changed since you opened it (now version {p.version}).")
    _revise(db, p, content, author, reason, trigger)
    db.commit()
    return p


def write_section(db: DBSession, role: str, path: str, heading: str, text: str, *, author: str, reason: Optional[str] = None,
                  trigger: Optional[str] = None, base_version: Optional[int] = None, header: Optional[dict] = None) -> models.WorkbookPage:
    """Replace (or add) one section of a page. A worker's main tool.

    `header` updates the page's header fields at the same time (e.g. its confidence)."""
    path = _clean_path(path)
    _check_author(role, author)
    if path == "job.md" and author != COACH:
        raise WorkbookError("Only the coach writes the job direction.")
    p = get_page(db, role, path)
    if not p:
        meta = {k: v for k, v in (header or {}).items() if v not in (None, "", [])}
        content = replace_section("", heading, text)
        return create_page(db, role, path, render(meta, content) if meta else content, author=author, reason=reason, trigger=trigger)
    if base_version is not None and base_version != p.version:
        raise Conflict(f"{path} changed since it was read (now version {p.version}); read it again first.")
    if author != COACH and _norm(heading) in {_norm(h) for h in (p.locked or [])}:
        raise WorkbookError(f"The coach has locked '{heading}' on {path}; suggest the change instead.")
    content = replace_section(p.content, heading, text)
    if header:
        meta, body = parse(content)
        meta.update({k: v for k, v in header.items() if v not in (None, "", [])})
        content = render(meta, body)
    _revise(db, p, content, author, reason, trigger)
    db.commit()
    return p


def may_write(role: str, path: str) -> bool:
    """Whether a path is inside the folders this worker writes in (their job description's 'Where I write')."""
    w = worker(role)
    allowed = [x.strip() for x in w.writes.split(",") if x.strip()]
    path = _clean_path(path)
    return any(path.startswith(a) if a.endswith("/") else path == a for a in allowed)


def append_journal(db: DBSession, role: str, text: str, *, author: Optional[str] = None, trigger: Optional[str] = None,
                   on: Optional[date] = None) -> models.WorkbookPage:
    """A dated line in this month's journal (the tidy-up later turns these into casebook entries)."""
    on = on or date.today()
    author = author or role
    _check_author(role, author)
    path = f"journal/{on:%Y-%m}.md"
    line = f"- **{on.day} {on:%b}** {text.strip()}"
    p = get_page(db, role, path)
    if not p:
        content = render({"title": f"Journal {on:%B %Y}", "kind": "journal"}, line + "\n")
        return create_page(db, role, path, content, author=author, reason="journal", trigger=trigger)
    _revise(db, p, p.content.rstrip("\n") + "\n" + line + "\n", author, "journal", trigger)
    db.commit()
    return p


def set_locked(db: DBSession, role: str, path: str, headings: list) -> models.WorkbookPage:
    p = get_page(db, role, _clean_path(path))
    if not p:
        raise WorkbookError("No such page")
    p.locked = [h.strip() for h in headings if h and h.strip()]
    db.commit()
    return p


def _clean_path(path: str) -> str:
    path = (path or "").strip().strip("/").replace("\\", "/")
    if not path or ".." in path.split("/") or not re.fullmatch(r"[A-Za-z0-9_\-./ ]+", path):
        raise WorkbookError("A page path is a short name like swimmers/ruby-w.md")
    return path if path.endswith(".md") else path + ".md"


# ---------------------------------------------------------------- history

def history(db: DBSession, role: str, path: str) -> list:
    p = get_page(db, role, _clean_path(path), include_archived=True)
    if not p:
        return []
    return [{"version": r.version, "author": r.author, "reason": r.reason, "trigger": r.trigger,
             "at": r.created_at.isoformat() if r.created_at else None} for r in reversed(p.revisions)]


def revision(db: DBSession, role: str, path: str, version: int) -> Optional[models.PageRevision]:
    p = get_page(db, role, _clean_path(path), include_archived=True)
    if not p:
        return None
    return next((r for r in p.revisions if r.version == version), None)


def restore(db: DBSession, role: str, path: str, version: int, *, author: str = COACH, trigger: Optional[str] = None) -> models.WorkbookPage:
    """Bring an old version back as the newest one. Nothing is lost."""
    r = revision(db, role, path, version)
    if not r:
        raise WorkbookError(f"No version {version} of that page")
    p = r.page
    p.archived = False
    _revise(db, p, r.content, author, f"restored version {version}", trigger)
    db.commit()
    return p


def undo_trigger(db: DBSession, trigger: str) -> dict:
    """Undo every change one conversation (or debrief, or import) made.

    A page is put back to how it was before that conversation, unless someone
    changed it afterwards - those pages are listed and left for the coach."""
    done, skipped = [], []
    revs = db.query(models.PageRevision).filter(models.PageRevision.trigger == trigger).all()
    for page_id in sorted({r.page_id for r in revs}):
        p = db.get(models.WorkbookPage, page_id)
        if not p or p.club != CLUB:
            continue
        ours = [r for r in p.revisions if r.trigger == trigger]
        first = min(r.version for r in ours)
        later = [r for r in p.revisions if r.version > first and r.trigger != trigger]
        if later:
            skipped.append({"role": p.role, "path": p.path, "why": "changed again afterwards"})
            continue
        if first == 1:
            p.archived = True
            db.add(models.PageRevision(page=p, version=p.version + 1, content=p.content, author=COACH,
                                       reason=f"undid {trigger} (page set aside)", trigger=None))
            p.version += 1
        else:
            before = next(r for r in p.revisions if r.version == first - 1)
            _revise(db, p, before.content, COACH, f"undid {trigger}", None)
        done.append({"role": p.role, "path": p.path})
    db.commit()
    return {"undone": done, "skipped": skipped}


def snapshot(db: DBSession, name: str) -> models.WorkbookSnapshot:
    s = models.WorkbookSnapshot(club=CLUB, name=name.strip()[:120] or "Snapshot",
                                versions={str(p.id): p.version for p in _q(db).all()})
    db.add(s)
    db.commit()
    return s


def restore_snapshot(db: DBSession, snapshot_id: int) -> dict:
    s = db.get(models.WorkbookSnapshot, snapshot_id)
    if not s or s.club != CLUB:
        raise WorkbookError("No such snapshot")
    restored, set_aside = [], []
    for p in _q(db, include_archived=True).all():
        want = s.versions.get(str(p.id))
        if want is None:
            if not p.archived:
                p.archived = True
                set_aside.append(p.path)
            continue
        current = next((r for r in p.revisions if r.version == p.version), None)
        target = next((r for r in p.revisions if r.version == want), None)
        if target and (p.archived or not current or current.content != target.content):
            p.archived = False
            _revise(db, p, target.content, COACH, f"restored snapshot '{s.name}'", None)
            restored.append(p.path)
    db.commit()
    return {"restored": restored, "set_aside": set_aside}


# ---------------------------------------------------------------- swimmers leaving

def forget_swimmer(db: DBSession, swimmer_id: int, name: Optional[str]) -> int:
    """A swimmer's data removed for good: their own pages with every old version,
    their id from shared pages, and their name from every version of every page."""
    removed = 0
    for p in _q(db, include_archived=True).all():
        ids = list(p.swimmer_ids or [])
        if ids == [swimmer_id]:
            db.delete(p)
            removed += 1
            continue
        if swimmer_id in ids:
            p.swimmer_ids = [i for i in ids if i != swimmer_id]
    if name and name.strip():
        pattern = re.compile(re.escape(name.strip()), re.I)
        for p in _q(db, include_archived=True).all():
            p.content = pattern.sub("[a former swimmer]", p.content)
            for r in p.revisions:
                r.content = pattern.sub("[a former swimmer]", r.content)
    db.commit()
    return removed


# ---------------------------------------------------------------- starter kit and job direction

def ensure_workbooks(db: DBSession) -> None:
    """Give every member of staff their starter pages (once)."""
    changed = False
    for w in workers().values():
        if not get_page(db, w.role, "job.md", include_archived=True):
            body = JOB_TEMPLATE.format(name=w.name)
            db.add(_starter(w.role, "job.md", f"{w.name}: your direction", "job", body))
            changed = True
        for path, (title, kind, body) in w.starter.items():
            if not get_page(db, w.role, path, include_archived=True):
                db.add(_starter(w.role, path, title, kind, body))
                changed = True
    if changed:
        db.commit()


def _starter(role, path, title, kind, body) -> models.WorkbookPage:
    content = render({"title": title, "kind": kind}, body)
    page = models.WorkbookPage(club=CLUB, role=role, path=path, title=title, kind=kind, version=1, content=content, locked=[])
    page.revisions.append(models.PageRevision(version=1, content=content, author="app", reason="starter page"))
    return page


def job_direction(db: DBSession, role: str) -> str:
    """The coach's own direction for a worker (the editable part of the job description), if written."""
    p = get_page(db, role, "job.md")
    if not p:
        return ""
    _, body = parse(p.content)
    text = []
    for s in sections(body):
        chunk = body[s["start"]:s["end"]].split("\n", 1)
        if len(chunk) > 1 and chunk[1].strip():
            text.append(f"{s['heading']}: {chunk[1].strip()}")
    return "\n".join(text)


def job_direction_block(db: DBSession, role: str) -> str:
    text = job_direction(db, role)
    return f"THE COACH'S DIRECTION FOR YOU (follow it; it never switches off a safety flag):\n{text}" if text else ""
