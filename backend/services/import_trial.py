"""The sample import trial (step 4): how well Maggie reads each period's files,
how many questions she'd ask, and what it costs - before the full history.

    python -m backend.services.import_trial <session folder> [<session folder> ...]

The coach's Excel template is read by code for every spreadsheet (free). Other
files are decoded by the AI, about ten per period. Where the Session Builder
holds the exact session (this season), Maggie's reading is checked against it.
Nothing is saved except the report, which goes in Maggie's import log.
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

from backend.services import history_import as H
from backend.services import session_notation as N

PER_STRATUM = 10
TRUTH = Path(__file__).resolve().parents[2] / "shared" / "notation" / "sessions"


def _stratum(f: H.FileInfo) -> str:
    where = "Leeds" if "leeds" in str(f.path).lower() else ("camp" if f.camp else "BPSC")
    return f"{f.period} {where} {f.ext}"


def _truth() -> dict:
    """The Session Builder's exact sessions by (date, slot)."""
    out = {}
    for p in TRUTH.glob("*.json"):
        s = json.loads(p.read_text(encoding="utf8"))["session"]
        if "Silver 2" not in (s.get("title") or ""):
            out[(s["date"], s.get("slot"))] = N.normalize_session(s)
    return out


def _spread(items, n):
    if len(items) <= n:
        return list(items)
    step = len(items) / n
    return [items[int(i * step)] for i in range(n)]


def run(roots, per_stratum: int = PER_STRATUM, use_ai: bool = True) -> dict:
    from backend.database import SessionLocal, init_db
    from backend import models
    init_db()   # the app's own startup upgrade, so Maggie's workbook exists
    started = datetime.now(timezone.utc)
    files, skipped = H.find_files(roots)
    seen, dupes = {}, 0
    unique = []
    for f in files:
        if H.fingerprint(f) in seen:
            dupes += 1
            continue
        seen[f.sha1] = f
        unique.append(f)

    glossary = ""
    with SessionLocal() as db:
        from backend.services import workbooks as W
        W.ensure_workbooks(db)
        g = W.get_page(db, "records", "glossary.md")
        glossary = W.parse(g.content)[1] if g else ""

    strata = defaultdict(list)
    for f in unique:
        strata[_stratum(f)].append(f)
    results = []
    truth = _truth()
    for name, group in sorted(strata.items()):
        sample = group if group[0].ext == ".xlsx" else _spread(group, per_stratum)
        # this season's PDFs: prefer the ones the Session Builder holds exactly
        if group[0].ext == ".pdf" and group[0].period == "2026-2027":
            known = [f for f in group if f.date and (f.date.isoformat(), f.slot) in truth and not f.camp]
            sample = (known + [f for f in sample if f not in known])[:per_stratum]
        ai_used = 0
        for f in sample:
            # every spreadsheet goes through the template reader (free); the AI is used on at
            # most per_stratum files that need it
            r = H.read_file(f, glossary=glossary, use_ai=False)
            if r.status == "skipped" and use_ai and ai_used < per_stratum:
                ai_used += 1
                r = H.read_file(f, glossary=glossary, use_ai=True)
            r.stratum = name
            t = truth.get((f.date.isoformat(), f.slot)) if f.date and not f.camp else None
            r.truth = [x["dist"] for x in N.totals_for(t)] if t else None
            results.append(r)

    with SessionLocal() as db:
        cost = sum(x.estimated_cost_usd or 0 for x in db.query(models.AIUsageLog).filter(
            models.AIUsageLog.operation == "history_import_decode", models.AIUsageLog.created_at >= started.replace(tzinfo=None)).all())
    return {"files": len(files), "unique": len(unique), "duplicates": dupes, "skipped": dict(skipped),
            "strata": {k: len(v) for k, v in strata.items()}, "results": results, "cost_usd": cost}


def summarise(report: dict) -> dict:
    by = defaultdict(lambda: Counter())
    terms = Counter()
    truth_checks = []
    for r in report["results"]:
        c = by[r.stratum]
        c["files"] += 1
        c[r.status] += 1
        c["blocks"] += r.blocks_checked
        c["blocks_ok"] += r.blocks_matching
        c["blocks_explained"] += r.blocks_explained
        c["flagged"] += len(r.flagged)
        c["ai"] += r.method == "ai" and r.status != "skipped"
        if r.stated_total:
            c["stated"] += 1
            c["stated_ok"] += not r.total_mismatch
        for t in r.unknown_terms:
            terms[t.strip()] += 1
        if r.truth is not None and r.session:
            got = [t["dist"] for t in N.totals_for(r.session)]
            truth_checks.append({"file": r.info.path.name, "builder": r.truth, "maggie": got,
                                 "exact": sorted(got) == sorted(r.truth)})
    ai = [r for r in report["results"] if r.method == "ai" and r.status != "skipped"]
    return {"by_stratum": {k: dict(v) for k, v in sorted(by.items())}, "terms": terms.most_common(40),
            "truth": truth_checks, "ai_files": len(ai),
            "cost_per_ai_file": (report["cost_usd"] / len(ai)) if ai else 0.0}


def markdown(report: dict, summary: dict) -> str:
    lines = [f"Sample import trial, {date.today().day} {date.today():%b %Y}", "",
             f"- {report['files']} session files found, {report['unique']} after removing {report['duplicates']} duplicates.",
             f"- AI cost: ${report['cost_usd']:.2f} for {summary['ai_files']} files (about ${summary['cost_per_ai_file']:.3f} a file).", "",
             "## By period and format", "",
             "| Period | Files | Read by code | Read by AI | Clean | Need a look | Failed | Blocks agreeing with Excel* | AI reading matches the file's own total |",
             "|---|---|---|---|---|---|---|---|---|"]
    for k, c in summary["by_stratum"].items():
        blocks = f"{c.get('blocks_ok', 0) + c.get('blocks_explained', 0)}/{c.get('blocks', 0)}" if c.get("blocks") else "-"
        stated = f"{c.get('stated_ok', 0)}/{c.get('stated', 0)}" if c.get("stated") else "-"
        coded = c["files"] - c.get("ai", 0) - c.get("skipped", 0) - c.get("failed", 0)
        lines.append(f"| {k} | {c['files']} | {max(coded, 0)} | {c.get('ai', 0)} | {c.get('clean', 0)} | {c.get('doubts', 0)} | {c.get('failed', 0)} | {blocks} | {stated} |")
    lines += ["", "*or the difference is Excel's own fault: a row with no total formula, a time typed in by hand, a total over the wrong rows.",
              "Files neither read by code nor by AI were left for the full import (the trial reads at most ten a period with the AI)."]
    if summary["truth"]:
        exact = sum(1 for t in summary["truth"] if t["exact"])
        lines += ["", "## Checked against the Session Builder (the exact sessions)", "",
                  f"{exact} of {len(summary['truth'])} read with exactly the right total distance per group.", ""]
        lines += [f"- {t['file']}: builder {t['builder']} m, Maggie {t['maggie']} m{' ✓' if t['exact'] else ''}" for t in summary["truth"]]
    if summary["terms"]:
        lines += ["", "## Shorthand to ask the coach about (how many files used it)", ""]
        lines += [f"- {t} ({n})" for t, n in summary["terms"]]
    fails = [r for r in report["results"] if r.status == "failed"]
    if fails:
        lines += ["", "## Files that couldn't be read", ""] + [f"- {r.info.path.name}: {r.error}" for r in fails[:20]]
    return "\n".join(lines) + "\n"


def save_to_log(text: str) -> str:
    from backend.database import SessionLocal
    from backend.services import workbooks as W
    path = f"import-log/trial-{date.today().isoformat()}.md"
    content = W.render({"title": f"Sample import trial {date.today().isoformat()}", "kind": "log",
                        "summary": "How well each period's files read, the shorthand to ask about, and the cost"}, text)
    with SessionLocal() as db:
        if W.get_page(db, "records", path):
            p = W.get_page(db, "records", path)
            W._revise(db, p, content, "records", "trial run again", f"import:trial-{date.today().isoformat()}")
            db.commit()
        else:
            W.create_page(db, "records", path, content, author="records", reason="sample import trial",
                          trigger=f"import:trial-{date.today().isoformat()}")
    return path


if __name__ == "__main__":
    roots = sys.argv[1:]
    report = run(roots)
    summary = summarise(report)
    text = markdown(report, summary)
    print(text)
    print("Saved to Maggie's workbook:", save_to_log(text))
    out = [{"file": str(r.info.path), "stratum": r.stratum, "method": r.method, "status": r.status, "totals": r.totals,
            "notes": r.notes, "flagged": r.flagged, "unknown_terms": r.unknown_terms, "error": r.error,
            "session": r.session} for r in report["results"]]
    import tempfile
    dump = Path(tempfile.gettempdir()) / "import-trial-results.json"
    dump.write_text(json.dumps(out, default=str, indent=1), encoding="utf8")
    print("Every file's reading:", dump)
