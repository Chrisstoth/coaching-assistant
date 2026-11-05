"""How the coach's sessions changed over the years (step 7's style review).

Code measures each season's sessions (distance, the mix of training zones,
kick, rounds, set shapes, equipment). Jess turns the differences into short
statements; the coach answers each one: moved on, still do, or sometimes. The
answers fill Jess's style pages, so she writes in the coach's current style
and never brings back what the coach has moved on from.
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from datetime import date
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services import session_notation as N
from backend.services import workbooks as W

EQUIPMENT = {"fins": r"\bfins?\b", "paddles": r"\bpaddles?\b", "pull": r"\bpull\b", "snorkel": r"\bsnorkel\b",
             "band": r"\bband\b", "kickboard": r"\b(?:kick\s*)?boards?\b", "drill": r"\bdrills?\b", "underwater": r"\bu/?w\b|underwater"}
ANSWERS = {"moved_on": "Moved on from", "still_do": "Still do", "sometimes": "Sometimes"}


def season_of(d: date) -> str:
    start = d.year if d.month >= 8 else d.year - 1
    return f"{start}-{start + 1}"


def _lines(items, k=1):
    for n in items or []:
        if n.get("t") == "round":
            yield from _lines(n.get("items"), k * (n.get("times") or 0))
        else:
            yield n, k


def period_stats(db: DBSession, min_sessions: int = 5) -> dict:
    """{period: figures} over every session written in (or imported into) the builder."""
    acc = defaultdict(lambda: {"sessions": 0, "metres": 0.0, "zones": Counter(), "rounds": 0, "sets": 0,
                               "shapes": Counter(), "equipment": Counter(), "long_sets": 0})
    for s in db.query(models.Session).filter(models.Session.builder.isnot(None)).all():
        b = N.normalize_session(json.loads(json.dumps(s.builder)))
        who = s.squad or "squad"
        key = f"{season_of(s.date)} {who}"
        a = acc[key]
        a["sessions"] += 1
        totals = N.totals_for(b)
        a["metres"] += max((t["dist"] for t in totals), default=0)
        for z in N.session_zones(b)[:1]:
            for zone, v in z["zones"].items():
                a["zones"][zone] += v["dist"]
        for blk in b.get("blocks") or []:
            a["rounds"] += sum(1 for n in blk.get("items") or [] if n.get("t") == "round")
            for n, k in _lines(blk.get("items")):
                if not n.get("dist"):
                    continue
                a["sets"] += 1
                reps = n.get("reps") or 1
                a["shapes"][f"{reps}x{n['dist']}" if reps > 1 else str(n["dist"])] += 1
                if reps * n["dist"] >= 800:
                    a["long_sets"] += 1
                desc = str(n.get("desc") or "").lower()
                for name, rx in EQUIPMENT.items():
                    if re.search(rx, desc):
                        a["equipment"][name] += 1
    out = {}
    for key, a in sorted(acc.items()):
        if a["sessions"] < min_sessions:
            continue
        total = sum(a["zones"].values()) or 1
        out[key] = {
            "sessions": a["sessions"],
            "avg_metres": round(a["metres"] / a["sessions"]),
            "zone_share": {z: round(100 * v / total) for z, v in a["zones"].most_common() if v},
            "rounds_per_session": round(a["rounds"] / a["sessions"], 1),
            "long_sets_per_session": round(a["long_sets"] / a["sessions"], 2),
            "top_shapes": [s for s, _ in a["shapes"].most_common(8)],
            "equipment_per_session": {e: round(n / a["sessions"], 2) for e, n in a["equipment"].most_common()},
        }
    return out


_SYSTEM = """You are Jess, the Session Writer on a swimming coach's staff. Below are figures for the coach's sessions,
season by season. Find the clearest ways the coach's sessions have CHANGED over the years - things they used
to do and seem to do less or more now. Only what the figures show; no advice.

Return JSON only:
{"statements": [{"statement": "Long pull sets (800 m and over) were in most sessions in 2015-16; almost none since 2024.",
                 "then": "2015-2016", "now": "2025-2026"}]}
At most 8 statements, the clearest first."""


def candidates(db: DBSession, ask=None) -> list:
    stats = period_stats(db)
    if len(stats) < 2:
        return []
    if ask is None:
        from backend.services.builder_staff import _ask as ask_fn
        ask = lambda system, user: ask_fn(system, user, "style_review", max_tokens=1500)  # noqa: E731
    out = ask(_SYSTEM, json.dumps(stats, indent=1))
    return [{"statement": str(x.get("statement") or "").strip()[:300], "then": x.get("then"), "now": x.get("now")}
            for x in (out.get("statements") or []) if isinstance(x, dict) and str(x.get("statement") or "").strip()][:8]


def answer(db: DBSession, statement: str, choice: str, reason: Optional[str] = None) -> dict:
    """The coach's answer, written into Jess's style pages by the coach."""
    if choice not in ANSWERS:
        raise W.WorkbookError("Moved on, still do, or sometimes")
    W.ensure_workbooks(db)
    line = f"- {statement.strip()}" + (f" (coach: {reason.strip()})" if reason and reason.strip() else "")
    if choice == "moved_on":
        path, heading = "style/moved-on-from.md", "Moved on from"
    else:
        path, heading = "style/current-style.md", "Still do" if choice == "still_do" else "Sometimes"
    page = W.get_page(db, "sessions", path)
    current = W.read_section(page.content, heading) if page else None
    body = "\n".join(x for x in (current or "").splitlines()[1:] if x.strip())
    W.write_section(db, "sessions", path, heading, (body + "\n" + line).strip(), author=W.COACH,
                    reason="the style review", trigger="style-review")
    return {"page": path, "section": heading}
