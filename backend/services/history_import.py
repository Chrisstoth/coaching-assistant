"""Reading the coach's old session files into the app (Maggie, the Records Officer).

The pipeline (docs/design/workers-and-workbooks.md, section 8):

1. Find: walk the session folders; the originals are only ever read.
2. Remove duplicates: the same file content counts once.
3. Read: the coach's Excel session template is read by code (a port of the
   Session Builder's own Excel import, which checks every block against the
   totals in the sheet). Word and PDF files are read as text.
4. Decode: text that code can't read is turned into the shared notation by
   the AI, using Maggie's glossary and format notes.
5. Check in code: every line must parse; totals are worked out by the parser.
6. Questions are about patterns ("37 sheets use 'BK'"), not single items.

Nothing here writes sessions; the trial only reports. Saving comes later.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Optional
from xml.etree import ElementTree as ET

from backend.services import session_notation as N

READABLE = {".xlsx", ".docx", ".pdf", ".txt", ".rtf"}
SKIPPED = {".doc", ".xls", ".jpg", ".jpeg", ".png", ".heic", ".ini", ".tmp"}
CAMP_WORDS = re.compile(r"camp|lanzarote|cyprus|tenerife|majorca|mallorca|spain", re.I)
WEEK_CODE = re.compile(r"^\d+\.\d+\.\d+$")
NOT_SESSION = re.compile(r"calendar|schedule|\bplan\b|planner|results|entries|qualif|times\b|register|letter|invoice|team sheet", re.I)


# ---------------------------------------------------------------- finding files

@dataclass
class FileInfo:
    path: Path
    period: str                    # e.g. "2014-2015"
    squad: Optional[str]
    camp: Optional[str]            # the camp folder's name, when the session was on a camp
    week_code: Optional[str]       # e.g. "1.2.2" from this season's week folders
    ext: str
    sha1: str = ""
    date: Optional[date] = None
    slot: Optional[str] = None     # AM / PM


def _season_of(parts) -> Optional[str]:
    """The season from a folder name: "2014-2015" or "2015-16"."""
    for p in reversed(parts):
        m = re.search(r"\b(20\d\d)-(20\d\d|\d\d)\b", p)
        if m:
            end = m.group(2) if len(m.group(2)) == 4 else m.group(1)[:2] + m.group(2)
            return f"{m.group(1)}-{end}"
    return None


def _season_range(period: Optional[str]):
    if not period:
        return None
    a, b = (int(x) for x in period.split("-"))
    return date(a, 7, 1), date(b, 9, 30)


_MON = {m[:3]: i + 1 for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                               "september", "october", "november", "december"])}


def _written_date(name: str, period: Optional[str]) -> Optional[date]:
    """"26th Nov 2014", "14th September 2015", "5th August" (the season gives the year)."""
    m = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(20\d\d))?", name, re.I)
    if not m:
        return None
    day, month = int(m.group(1)), _MON[m.group(2).lower()]
    year = int(m.group(3)) if m.group(3) else None
    if year is None and period and period != "unknown":
        a, b = (int(x) for x in period.split("-"))
        year = a if month >= 7 else b
    try:
        return date(year, month, day) if year else None
    except ValueError:
        return None


def guess_date(name: str, period: Optional[str]) -> Optional[date]:
    """Six digits at the start of a file name are YYMMDD or DDMMYY (the season decides
    which); otherwise a written date like "26th Nov 2014"."""
    m = re.match(r"\s*(\d{2})(\d{2})(\d{2})\b", name)
    if not m:
        return _written_date(name, period)
    x, y, z = (int(g) for g in m.groups())
    cands = []
    for yy, mm, dd in ((x, y, z), (z, y, x)):
        try:
            cands.append(date(2000 + yy, mm, dd))
        except ValueError:
            pass
    rng = _season_range(period)
    if rng:
        inside = [d for d in cands if rng[0] <= d <= rng[1]]
        if inside:
            return inside[0]
    return cands[0] if len(cands) == 1 else None


def find_files(roots) -> tuple[list, Counter]:
    """Every session file under the given folders, and a count of files that can't be read."""
    found, skipped = [], Counter()
    for root in roots:
        root = Path(root)
        if not root.exists():
            continue
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            ext = path.suffix.lower()
            if ext not in READABLE:
                skipped[ext or "(none)"] += 1
                continue
            rel = path.relative_to(root.parent) if root.parent != root else path
            parts = rel.parts
            period = _season_of(path.parts)
            camp = next((p for p in parts[:-1] if CAMP_WORDS.search(p)), None)
            week = next((p for p in parts[:-1] if WEEK_CODE.match(p)), None)
            squad = next((p for p in parts[:-1] if re.match(r"silver\s*\d", p, re.I)), None)
            info = FileInfo(path=path, period=period or "unknown", squad=squad.title() if squad else None, camp=camp,
                            week_code=week, ext=ext, date=guess_date(path.stem, period))
            m = re.search(r"\b(AM|PM)\b", path.stem.replace("-", " "), re.I)
            info.slot = m.group(1).upper() if m else None
            if not info.date or NOT_SESSION.search(path.stem):   # a plan, a calendar, a times list…
                skipped["not a session"] += 1
                continue
            found.append(info)
    return found, skipped


def fingerprint(info: FileInfo) -> str:
    h = hashlib.sha1()
    h.update(info.path.read_bytes())
    info.sha1 = h.hexdigest()
    return info.sha1


# ---------------------------------------------------------------- the coach's Excel template
# A port of the Session Builder's importSession(): reads the coach's session-plan
# layout back into the builder model, and checks each block against Excel's totals.

def _js_val(v):
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, time):
        return (v.hour * 3600 + v.minute * 60 + v.second) / 86400
    if isinstance(v, timedelta):
        return v.total_seconds() / 86400
    if isinstance(v, datetime):
        return (v - datetime(1899, 12, 30)).total_seconds() / 86400
    return v


def read_cells(path_or_bytes) -> dict:
    from openpyxl import load_workbook
    data = path_or_bytes.read_bytes() if isinstance(path_or_bytes, Path) else path_or_bytes
    wf = load_workbook(io.BytesIO(data), data_only=False)
    wv = load_workbook(io.BytesIO(data), data_only=True)
    sf, sv = wf[wf.sheetnames[0]], wv[wv.sheetnames[0]]
    cells = {}
    for row in sf.iter_rows():
        for c in row:
            raw = c.value
            f = None
            if isinstance(raw, str) and raw.startswith("="):
                f = raw[1:]
            elif raw is not None and hasattr(raw, "text") and str(getattr(raw, "text", "")).startswith("="):
                f = raw.text[1:]
            v = _js_val(sv[c.coordinate].value) if f is not None else _js_val(raw)
            if v is None and f is None and not c.has_style:
                continue
            cells[c.coordinate] = {"v": v, "f": f}
    return cells


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _cell_secs(c) -> Optional[int]:
    if not c or c["v"] is None or c["v"] == "":
        return None
    v = c["v"]
    if _num(v):
        return N.js_round(v * 86400) if 0 < v < 1 else (N.parse_time(N.js_str(v)) if v >= 1 else None)
    return N.parse_time(str(v).strip())


USUAL_TIMES = {"Mon AM": ("05:30", "07:00"), "Mon PM": ("20:30", "21:30"), "Tue PM": ("20:00", "21:00"),
               "Wed AM": ("05:30", "07:00"), "Thu AM": ("05:30", "07:00"), "Fri PM": ("20:30", "21:30"),
               "Sun AM": ("06:00", "07:45")}
MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]


def _title_date(t: str):
    x = (t or "").lower()
    m = re.search(r"(\d{1,2})(?:st|nd|rd|th)?\s+(" + "|".join(MONTHS) + r")\b(?:\s+(?:am|pm))?(?:\s+(\d{4}))?", x)
    if not m:
        return None
    sl = re.search(r"\b(am|pm)\b", x)
    return {"day": int(m.group(1)), "month": MONTHS.index(m.group(2)) + 1, "year": int(m.group(3)) if m.group(3) else None,
            "slot": sl.group(1).upper() if sl else None}


def import_template(cells: dict, file_name: str) -> dict:
    """{session, notes, blocks}: the builder session, what to tell the coach, and each block's check."""
    notes = []
    c = lambda ref: cells.get(ref)  # noqa: E731
    v = lambda ref: cells[ref]["v"] if ref in cells else None  # noqa: E731

    def s(ref):
        x = v(ref)
        return "" if x is None else re.sub(r"\s+", " ", N.js_str(x)).strip()

    rows = sorted({int(re.search(r"\d+", k).group(0)) for k in cells})

    def is_header(r):
        fi = (c(f"I{r}") or {}).get("f") or ""
        return bool(re.search(r"effort|^notes$", s(f"H{r}"), re.I)) or (
            bool(re.match(r"SUM\(", fi, re.I)) and isinstance(v(f"A{r}"), str) and not re.match(r"\d", s(f"A{r}")))

    fm = re.search(r"(\d{2})(\d{2})(\d{2})[ _-]+[A-Za-z]+[ _-]+(AM|PM)", file_name or "", re.I)
    td = _title_date(s("A1"))
    sdate, slot = "", ""
    if fm:
        sdate, slot = f"20{fm.group(1)}-{fm.group(2)}-{fm.group(3)}", fm.group(4).upper()
    if not sdate and td and td["year"]:
        sdate = f"{td['year']}-{td['month']:02d}-{td['day']:02d}"
    if not slot and td and td["slot"]:
        slot = td["slot"]
    try:
        d_obj = date.fromisoformat(sdate) if sdate else None
    except ValueError:
        d_obj = None
    if fm and td and d_obj:
        if td["day"] != d_obj.day or td["month"] != d_obj.month:
            notes.append(f"The title says “{s('A1')}”, but the file name says {d_obj:%A} {d_obj.day} {d_obj:%B}. I used the file name.")
        elif td["slot"] and td["slot"] != slot:
            notes.append(f"The title says {td['slot']}, but the file name says {slot}. I used {slot}.")
    session = {"title": "", "date": sdate, "slot": slot or "AM", "start": "", "end": "", "venue": "", "coach": "",
               "weekKey": "", "aims": ["", ""], "blocks": []}
    tm = re.search(r"(\d{1,2})[:.](\d{2})\s*[-–]\s*(\d{1,2})[:.](\d{2})", s("E2"))
    if tm:
        session["start"] = f"{int(tm.group(1)):02d}:{tm.group(2)}"
        session["end"] = f"{int(tm.group(3)):02d}:{tm.group(4)}"
    elif d_obj:
        u = USUAL_TIMES.get(f"{d_obj:%a} {session['slot']}")
        if u:
            session["start"], session["end"] = u
    first = next((r for r in rows if is_header(r)), float("inf"))
    for r in rows:
        if r >= first:
            break
        a = s(f"A{r}")
        al = a.lower()
        if re.match(r"week key", al):
            session["weekKey"] = s(f"D{r}")
        elif re.match(r"aim\s*1", al):
            session["aims"][0] = s(f"D{r}")
        elif re.match(r"aim\s*2", al):
            session["aims"][1] = s(f"D{r}")
        elif r == 2 and a:
            session["venue"] = a
        elif r == 3 and a:
            session["coach"] = a

    round_mul = None
    round_until = None
    checks = []
    block = rnd = last = None
    either = or_next = False
    leftovers, no_sendoff = [], []

    def close_block():
        if block and block.get("_mult", 1) > 1 and not any(n["t"] == "round" for n in block["items"]):
            block["items"] = [N.new_round(block["_mult"], block["items"])]
        if block:
            block.pop("_mult", None)

    rest_re = r"\s*\((?:(\d{1,3}s|\d{1,2}:\d{2}) rest)?(?:(?: · )?est\. (\d{1,2}:\d{2}))?\)"
    for r in rows:
        if r < first:
            continue
        if is_header(r):
            close_block()
            name = re.sub(r":\s*$", "", s(f"A{r}"))
            e = s(f"E{r}")
            if not e or re.match(r"all\b", e, re.I):
                group = ""
            elif re.match(r"group\b", name, re.I) and not e.lower().startswith(name.lower()):
                group = f"{name} {e}"
            else:
                group = e
            block = N.new_block(name or "Block", group)
            if re.fullmatch(r"notes", s(f"H{r}"), re.I):
                block["kind"] = "notes"
                block["text"] = ""
                block["name"] = name or "Additional notes"
                session["blocks"].append(block)
                rnd = last = None
                continue
            f_i = (c(f"I{r}") or {}).get("f") or ""
            f_j = (c(f"J{r}") or {}).get("f") or ""
            mm = re.search(r"\)\s*\*\s*(\d+)\s*$", f_i)
            block["_mult"] = int(mm.group(1)) if mm else 1
            r_i = re.search(r"SUM\(I(\d+):I(\d+)\)", f_i, re.I)
            r_j = re.search(r"SUM\(J(\d+):J(\d+)\)", f_j, re.I)
            checks.append({"block": block, "row": r,
                           "excelDist": v(f"I{r}") if _num(v(f"I{r}")) else None,
                           "excelTime": N.js_round(v(f"J{r}") * 86400) if _num(v(f"J{r}")) else None,
                           "rI": (int(r_i.group(1)), int(r_i.group(2))) if r_i else None,
                           "rJ": (int(r_j.group(1)), int(r_j.group(2))) if r_j else None,
                           "lines": [], "reasons": []})
            session["blocks"].append(block)
            rnd = last = None
            either = or_next = False
            continue
        if not block:
            continue
        if re.match(r"session total", s(f"A{r}"), re.I):
            continue
        if block.get("kind") == "notes":
            E = s(f"E{r}")
            if E:
                block["text"] = block["text"] + "\n" + E if block["text"] else E
            continue
        chk = checks[-1]
        A, aS, B, C, E = v(f"A{r}"), s(f"A{r}"), s(f"B{r}"), v(f"C{r}"), s(f"E{r}")
        F, G, H = _cell_secs(c(f"F{r}")), _cell_secs(c(f"G{r}")), s(f"H{r}")
        no_dist = C is None or C == ""
        # The 2023-24 template writes a round as "2 x  Fins on" with a total that multiplies the
        # rows under it (=SUM(I11:I16)*A10). Not in the builder's own reader; only this pattern triggers it.
        if rnd is not None and round_until is not None and r > round_until:
            rnd, last, round_until = None, None, None      # past the rows that round's formula covers
        older_round = (_num(A) and re.fullmatch(r"x", B, re.I) and no_dist
                       and re.search(rf"SUM\(I\d+:I(\d+)\)\s*\*\s*A{r}\b", (c(f"I{r}") or {}).get("f") or "", re.I))
        if re.fullmatch(r"\d+\s*x", aS, re.I) or (_num(A) and re.fullmatch(r"x", B, re.I) and no_dist and not E) or older_round:
            m_int = re.match(r"\d+", aS)
            rnd = N.new_round(int(m_int.group(0)) if m_int and int(m_int.group(0)) else 1, [], E)
            block["items"].append(rnd)
            last = None
            round_mul = None
            round_until = int(older_round.group(1)) if older_round else None
            continue
        if rnd and _num(C):
            f_i = re.sub(r"[A-Z]+\d+\*[A-Z]+\d+", "", (c(f"I{r}") or {}).get("f") or "")
            mul = "*" in f_i
            if round_mul is None:
                round_mul = mul
            elif round_mul and not mul:
                rnd = last = None
        if no_dist and (re.match(r"either\b", aS, re.I) or (not aS and re.fullmatch(r"either", E, re.I))):
            either = True
            continue
        if no_dist and (re.fullmatch(r"or", aS, re.I) or (not aS and re.fullmatch(r"or", E, re.I))):
            or_next = True
            continue
        has_dist = _num(C)
        reps = A if _num(A) else None
        if has_dist or (reps is not None and (E or G is not None)):
            label = re.sub(r"\s+", " ", f"{N.js_str(reps or 1)} x {N.js_str(C) if has_dist else ''} {E}").strip()
            chk["lines"].append(r)
            if or_next and last:
                last["desc"] = f"{last['desc'] + ', ' if last['desc'] else ''}or {label}"
                or_next = False
                if not (c(f"I{r}") or {}).get("f"):
                    chk.setdefault("noFormula", []).append(r)
                continue
            desc_e, rest_v, est_v = E, None, None
            ra = re.search(rest_re, desc_e)
            if ra and (ra.group(1) or ra.group(2)):
                if ra.group(1):
                    rest_v = N.parse_rest(re.sub(r"s$", "", ra.group(1)))
                if ra.group(2):
                    est_v = N.parse_time(ra.group(2))
                desc_e = (desc_e[:ra.start()] + desc_e[ra.end():]).strip()
            line = N.new_line({"reps": reps if reps and reps != 1 else None, "dist": C if has_dist else None, "desc": desc_e,
                               "int": G if G is not None else F, "int2": F if (G is not None and F is not None and F != G) else None,
                               "rest": rest_v, "est": est_v, "eff": H})
            (rnd["items"] if rnd else block["items"]).append(line)
            last = line
            if has_dist and C >= 50 and G is not None and G / (C / 100) < 50:
                notes.append(f"Row {r}: {label} on {N.fmt_time(G)} works out at {N.fmt_time(G / (C / 100))} per 100. Is that a typo?")
            if has_dist and C > 0 and G is None and F is None and rest_v is None and est_v is None:
                no_sendoff.append(r)
            if either:
                notes.append(f"Row {r} starts an “either … or”. The first option counts in the totals and the second sits in its description.")
                either = False
            if not (c(f"I{r}") or {}).get("f"):
                chk.setdefault("noFormula", []).append(r)
            jc = c(f"J{r}")
            if jc and jc["f"] is None and _num(jc["v"]) and G is not None:
                typed = N.js_round(jc["v"] * 86400)
                want = (reps or 1) * G * (rnd["times"] if rnd else 1)
                if typed != want:
                    chk["reasons"].append(f"row {r} ({label}) has its time typed in as {N.fmt_time(typed)}, but {N.js_str(reps or 1)} × {N.fmt_time(G)} is {N.fmt_time(want)}")
            continue
        if last and re.match(r"\d{1,2}\)", E) and N.desc_parts(last["desc"] + " " + E, 1, True):
            add = E
            ra = re.search(rest_re, add)
            if ra and (ra.group(1) or ra.group(2)):
                add = (add[:ra.start()] + (" r" + N.rest_short(N.parse_rest(re.sub(r"s$", "", ra.group(1)))) if ra.group(1) else "")
                       + (" ~" + ra.group(2) if ra.group(2) else "") + add[ra.end():]).strip()
            if G is not None:
                add += f" @{N.fmt_time(G)}" + (f"/{N.fmt_time(F)}" if F is not None and F != G else "")
            elif F is not None:
                add += f" @{N.fmt_time(F)}"
            last["desc"] = f"{last['desc']} {add}"
            if H:
                last["eff"] = f"{last['eff']}/{H}" if last["eff"] else H
            continue
        if E or F is not None:
            if last:
                add = " ".join(x for x in [E, f"({N.fmt_time(F)} send-off)" if F is not None else ""] if x)
                sep = " " if re.match(r"\d{1,2}\)", E) else " / "
                last["desc"] = f"{last['desc']}{sep}{add}" if last["desc"] else add
                if H:
                    last["eff"] = f"{last['eff']}/{H}" if last["eff"] else H
            elif E:
                n = N.new_line({"desc": E})
                (rnd["items"] if rnd else block["items"]).append(n)
                last = n
            continue
        if H:
            leftovers.append(r)
    close_block()
    if no_sendoff:
        many = len(no_sendoff) > 1
        notes.append(f"Row{'s' if many else ''} {', '.join(map(str, no_sendoff))} {'have' if many else 'has'} no send-off, so {'their' if many else 'its'} time isn’t in the totals.")
    if leftovers:
        notes.append(f"Ignored stray effort numbers with no set beside them (row{'s' if len(leftovers) > 1 else ''} {', '.join(map(str, leftovers))}).")
    blocks = []
    for i, k in enumerate(checks):
        ours = N.stats_of(k["block"]["items"])
        reasons = list(k["reasons"])
        if k.get("noFormula"):
            nf = k["noFormula"]
            reasons.append(f"row{'s' if len(nf) > 1 else ''} {', '.join(map(str, nf))} {'have' if len(nf) > 1 else 'has'} no total formula, so Excel left {'them' if len(nf) > 1 else 'it'} out")
        if k["lines"]:
            lo, hi = min(k["lines"]), max(k["lines"])
            nxt = checks[i + 1]["row"] if i + 1 < len(checks) else float("inf")
            if k["rI"] and (k["rI"][0] > lo or k["rI"][1] < hi or k["rI"][1] >= nxt):
                reasons.append(f"Excel’s distance total adds up rows {k['rI'][0]}–{k['rI'][1]}, but this block’s sets are on rows {lo}–{hi}")
            if k["rJ"] and (k["rJ"][0] > lo or k["rJ"][1] < hi or k["rJ"][1] >= nxt):
                reasons.append(f"Excel’s time total adds up rows {k['rJ'][0]}–{k['rJ'][1]}, but this block’s sets are on rows {lo}–{hi}")
        dist_ok = k["excelDist"] is None or abs(k["excelDist"] - ours["dist"]) < 0.5
        time_ok = k["excelTime"] is None or abs(k["excelTime"] - ours["time"]) < 2
        blocks.append({"name": k["block"]["name"], "group": k["block"].get("group") or "", "excelDist": k["excelDist"],
                       "excelTime": k["excelTime"], "dist": ours["dist"], "time": ours["time"], "match": dist_ok and time_ok,
                       "reasons": [] if dist_ok and time_ok else reasons})
    N.normalize_session(session)
    return {"session": session, "notes": notes, "blocks": blocks}


def looks_like_template(cells: dict) -> bool:
    """The coach's template has an effort column (H) on its block headers and SUM totals in column I."""
    heads = sum(1 for k, c in cells.items() if k.startswith("H") and isinstance(c["v"], str) and re.search(r"effort", c["v"], re.I))
    sums = sum(1 for k, c in cells.items() if k.startswith("I") and c["f"] and re.match(r"SUM\(", c["f"], re.I))
    return heads >= 1 or sums >= 2


# ---------------------------------------------------------------- text from Word and PDF

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def docx_text(data: bytes) -> str:
    """A Word file's text: paragraphs as lines, table rows with their cells split by ' | '."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    body = root.find(f"{_W}body")
    out = []

    def para(p):
        bits = []
        for el in p.iter():
            if el.tag == f"{_W}t" and el.text:
                bits.append(el.text)
            elif el.tag in (f"{_W}tab",):
                bits.append("\t")
            elif el.tag in (f"{_W}br", f"{_W}cr"):
                bits.append("\n")
        return "".join(bits)

    for el in list(body) if body is not None else []:
        if el.tag == f"{_W}p":
            out.append(para(el))
        elif el.tag == f"{_W}tbl":
            for tr in el.iter(f"{_W}tr"):
                cells = [" ".join(para(p) for p in tc.iter(f"{_W}p")).strip() for tc in tr.iter(f"{_W}tc")]
                if any(cells):
                    out.append(" | ".join(cells))
    return "\n".join(line.rstrip() for line in out if line.strip())


def rtf_text(data: bytes) -> str:
    """Plain text from a rich-text (.rtf) file: control words and hidden groups removed."""
    s = data.decode("latin-1", errors="ignore")
    s = re.sub(r"\\\r?\n", "\n", s)                                         # a backslash at a line end is a new paragraph
    s = re.sub(r"\{\\\*[^{}]*\}", "", s)                                   # {\* ...} hidden groups
    s = re.sub(r"\{\\(?:fonttbl|colortbl|stylesheet|info)(?:[^{}]|\{[^{}]*\})*\}", "", s)
    s = re.sub(r"\\'([0-9a-fA-F]{2})", lambda m: bytes([int(m.group(1), 16)]).decode("cp1252", errors="ignore"), s)
    s = re.sub(r"\\(?:par|line|row)\b ?", "\n", s)
    s = re.sub(r"\\(?:tab|cell)\b ?", "\t", s)
    s = re.sub(r"\\[a-zA-Z]+-?\d* ?", "", s)
    s = re.sub(r"[{}]", "", s)
    return "\n".join(line.strip() for line in s.splitlines() if line.strip())


def pdf_text(data: bytes) -> str:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    return "\n".join((page.extract_text() or "") for page in reader.pages).strip()


def xlsx_text(cells: dict) -> str:
    """Any other spreadsheet as rows of text, for the AI to read."""
    rows = {}
    for ref, c in cells.items():
        m = re.match(r"([A-Z]+)(\d+)", ref)
        if c["v"] not in (None, ""):
            rows.setdefault(int(m.group(2)), []).append((m.group(1), N.js_str(c["v"])))
    return "\n".join(" | ".join(v for _, v in sorted(cols, key=lambda x: (len(x[0]), x[0]))) for _, cols in sorted(rows.items()))


# ---------------------------------------------------------------- decoding with the AI

DECODE_SYSTEM = """You are Maggie, the Records Officer for a swimming club. You turn the coach's old session
files into the club's session notation, exactly as written - you never invent, round off or improve a set.

THE NOTATION (one set per line):
- "4x100 Free build @1:30" - reps x distance, description, send-off (@1:30, or "on 1:30").
- Two lanes: "@1:30/1:40". Rest instead of a send-off: "r20" or "20s rest", with the swim time if known: "r20 ~1:20".
- Intensity in square brackets, as written: "[14]", "[14-16]" (mixed), "[12->16]" (build), "[Red]", "[A3]", "[HVO]".
- Numbered lines for what each rep does: "4x100 1) Kick 2) Drill 3) Swim 4) Build".
- A round: a line "3x" (or "3x Descend each round") and the sets in it indented by two spaces underneath.
- A line with words only ("Fins on") is a note.
- Keep the coach's words for descriptions, including shorthand.
- Alternatives ("3 or 2 x 200 IM, lane dependent"): write the first option as the set and keep the
  alternative in its description: "3x200 IM (or 2x200, lane dependent) @3:45/4:00".
- If the file states a total distance ("2600 or 2800m", "Total 3.8k"), give it as stated_total in metres
  (the first figure if there are two); never work it out yourself.

GROUPS: if the file gives different sets to different groups, name the groups as the file does and say which
blocks each group swims; blocks every group swims have "groups": [].

Return JSON only:
{
  "date": "YYYY-MM-DD or null", "slot": "AM" | "PM" | null, "title": "...", "aims": ["..."],
  "groups": ["group names, or [] for one group"],
  "blocks": [{"name": "Warm up", "groups": [], "text": "notation lines, newline separated"}],
  "stated_total": 2600 or null,
  "unknown_terms": ["shorthand you could not be sure of, e.g. 'BK'"],
  "doubts": ["anything you were unsure about, one short sentence each"]
}"""


def decode_with_ai(text: str, info: FileInfo, glossary: str = "", formats: str = "", model: Optional[str] = None) -> dict:
    from backend.services import claude_service
    hints = [f"File: {info.path.name}", f"Season folder: {info.period}"]
    if info.date:
        hints.append(f"Date from the file name: {info.date.isoformat()}")
    if info.camp:
        hints.append(f"On a camp: {info.camp}")
    user = "\n".join(hints)
    if glossary.strip():
        user += f"\n\nTHE COACH'S GLOSSARY:\n{glossary.strip()}"
    if formats.strip():
        user += f"\n\nNOTES ON THIS FILE LAYOUT:\n{formats.strip()}"
    user += f"\n\nTHE FILE'S TEXT:\n{text[:15000]}"
    response = claude_service.get_client().messages.create(
        model=model or claude_service.FAST_MODEL, max_tokens=4000, system=DECODE_SYSTEM,
        messages=[{"role": "user", "content": user}], operation="history_import_decode")
    raw = claude_service.response_text(response) or ""
    m = re.search(r"\{.*\}", raw, re.S)
    try:
        return json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        return {}


def builder_from_decode(d: dict, info: FileInfo) -> tuple[dict, list]:
    """A builder session from Maggie's decoding, and the lines that didn't read as sets."""
    groups = [{"id": f"g{i + 1}", "name": str(n)} for i, n in enumerate(d.get("groups") or []) if str(n).strip()]
    by_name = {g["name"].lower(): g["id"] for g in groups}
    blocks, flagged = [], []
    for b in d.get("blocks") or []:
        text = str(b.get("text") or "")
        items = N.parse_text(text)
        for raw in text.splitlines():
            line = raw.strip()
            if not line:
                continue
            nodes = N.parse_line_nodes(line)
            # a line with numbers that reads as words only, or as a set with no distance, needs a look
            if re.search(r"\d", line) and nodes and all(n["t"] == "line" and N.is_note_line(n) for n in nodes) \
                    and not re.match(r"^\d{1,2}\)", line):
                flagged.append(line)
        blk = N.new_block(str(b.get("name") or "Block"), [by_name[g.lower()] for g in (b.get("groups") or []) if str(g).lower() in by_name])
        blk["items"] = items
        blocks.append(blk)
    when = d.get("date") or (info.date.isoformat() if info.date else "")
    session = {"title": d.get("title") or "", "date": when, "slot": d.get("slot") or info.slot or "AM", "start": "", "end": "",
               "venue": "", "coach": "", "weekKey": info.week_code or "", "aims": (list(d.get("aims") or []) + ["", ""])[:2],
               "groups": groups, "blocks": blocks}
    return N.normalize_session(session), flagged


# ---------------------------------------------------------------- one file

@dataclass
class Result:
    info: FileInfo
    method: str = ""               # template / ai / failed
    status: str = ""               # clean / doubts / failed
    session: Optional[dict] = None
    totals: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    flagged: list = field(default_factory=list)
    unknown_terms: list = field(default_factory=list)
    blocks_checked: int = 0
    blocks_matching: int = 0
    blocks_explained: int = 0      # Excel's own total is wrong (a missing formula, a typed-in time, the wrong rows)
    stated_total: Optional[float] = None   # the total the file itself states, when it does
    total_mismatch: bool = False
    error: str = ""


def read_file(info: FileInfo, glossary: str = "", formats: str = "", use_ai: bool = True) -> Result:
    res = Result(info=info)
    try:
        data = info.path.read_bytes()
        text = ""
        if info.ext == ".xlsx":
            cells = read_cells(data)
            if looks_like_template(cells):
                out = import_template(cells, info.path.name)
                res.method, res.session, res.notes = "template", out["session"], out["notes"]
                res.blocks_checked = sum(1 for b in out["blocks"] if b["excelDist"] is not None or b["excelTime"] is not None)
                res.blocks_matching = sum(1 for b in out["blocks"] if b["match"] and (b["excelDist"] is not None or b["excelTime"] is not None))
                res.blocks_explained = sum(1 for b in out["blocks"] if not b["match"] and b["reasons"])
                res.notes += [f"{b['name']}: Excel {b['excelDist']} m, read {b['dist']} m. {'; '.join(b['reasons'])}" for b in out["blocks"] if not b["match"]]
            else:
                text = xlsx_text(cells)
        elif info.ext == ".docx":
            text = docx_text(data)
        elif info.ext == ".pdf":
            text = pdf_text(data)
        elif info.ext == ".rtf":
            text = rtf_text(data)
        elif info.ext == ".txt":
            text = data.decode("utf-8-sig", errors="ignore") if data[:3] == b"\xef\xbb\xbf" else data.decode("cp1252", errors="ignore")
        if res.method != "template":
            if not text.strip():
                raise ValueError("no readable text in the file")
            if not use_ai:
                res.method, res.status = "ai", "skipped"
                return res
            d = decode_with_ai(text, info, glossary, formats)
            if not d.get("blocks"):
                raise ValueError("the AI could not read a session from it")
            res.method = "ai"
            res.session, res.flagged = builder_from_decode(d, info)
            res.unknown_terms = [str(t) for t in d.get("unknown_terms") or []]
            res.notes += [str(x) for x in d.get("doubts") or []]
            # the file's own total is the check: the reading must land within 5% of it for some group
            try:
                stated = float(d.get("stated_total") or 0)
            except (TypeError, ValueError):
                stated = 0
            if stated:
                got = [t["dist"] for t in N.totals_for(res.session)]
                res.stated_total = stated
                if not any(abs(g - stated) <= 0.05 * stated for g in got):
                    res.notes.append(f"The file says {N.js_round(stated)} m in total but I read {', '.join(N.fmt_dist(g) for g in got)} m.")
                    res.total_mismatch = True
        res.totals = [{"group": t["g"] or "All", "dist": t["dist"], "time": t["time"]} for t in N.totals_for(res.session)]
        empty = not any(t["dist"] for t in res.totals)
        mismatch = res.method == "template" and res.blocks_matching + res.blocks_explained < res.blocks_checked
        res.status = "doubts" if (res.flagged or res.unknown_terms or mismatch or empty or res.notes) else "clean"
    except Exception as e:  # noqa: BLE001 - one bad file must not stop a batch
        res.method, res.status, res.error = res.method or "failed", "failed", str(e)[:300]
    return res
