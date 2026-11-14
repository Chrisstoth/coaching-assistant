"""Session notation: how a session is written, read and added up.

A line-for-line Python twin of frontend/src/notation/core.js and zones.js,
which come unchanged from the coach's BPSC Session Builder. The frontend reads
sets as the coach types; this module reads them for imports, the Session
Writer and the staff. Both are tested against the same reference answers in
shared/notation/cases.json (backend/tests/test_session_notation.py), so a set
means the same thing everywhere.

Model: a session has blocks; a block has items; an item is a line
{t:'line', reps, dist, desc, int, int2, rest, est, eff} or a round
{t:'round', times, note, items}. Times are seconds. Intensity (eff) is stored
on one common scale (Effort /20, 6-21), whatever scale it is shown in.

Porting notes (where JavaScript and Python differ):
- js_round rounds halves up, as Math.round does (Python's round() doesn't).
- Regex end anchors use \\Z: Python's $ also matches before a final newline.
- `x or y` is only used where the JavaScript is `x || y`; `??` becomes an
  explicit `is None` check, because 0 and '' are values there.
"""

from __future__ import annotations

import copy
import math
import random
import re
import string
from datetime import datetime
from typing import Optional

I = re.IGNORECASE

# ---------------------------------------------------------------- helpers


def uid() -> str:
    return "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(8))


def js_round(x: float) -> int:
    return math.floor(x + 0.5)


def js_str(v) -> str:
    """A number as JavaScript's String() writes it (4.0 -> '4')."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        if v.is_integer():
            return str(int(v))
        return repr(v)
    return str(v)


def _num(s: str):
    """JavaScript's +"14" / +"14.5"."""
    f = float(s)
    return int(f) if f.is_integer() else f


def fmt_time(sec) -> str:
    if sec is None or (isinstance(sec, float) and math.isnan(sec)):
        return ""
    sec = js_round(sec)
    m, s = sec // 60, sec % 60
    return f"{m}:{s:02d}"


def parse_time(v) -> Optional[int]:
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    m = re.fullmatch(r"(\d+):(\d{1,2})", s)
    if m:
        return int(m.group(1)) * 60 + int(m.group(2))
    m = re.fullmatch(r"(\d+)\.(\d{2})", s)
    if m:
        return int(m.group(1)) * 60 + int(m.group(2))
    m = re.fullmatch(r"(\d+)", s)
    if m:
        n = int(m.group(1))
        return n * 60 if n < 10 else n
    return None


def fmt_dist(m) -> str:
    return f"{js_round(m):,}"


def clock_mins(hhmm) -> Optional[int]:
    m = re.match(r"(\d{1,2}):(\d{2})", str(hhmm or ""))
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def clock_add(hhmm, sec) -> str:
    base = clock_mins(hhmm)
    if base is None:
        return ""
    t = math.floor(base + sec / 60)
    return f"{(t // 60) % 24:02d}:{t % 60:02d}"


def slot_seconds(s: dict) -> Optional[int]:
    a, b = clock_mins(s.get("start")), clock_mins(s.get("end"))
    return None if a is None or b is None or b <= a else (b - a) * 60


def parse_effort(v) -> Optional[dict]:
    if not v:
        return None
    s = str(v)
    nums = [_num(x) for x in re.findall(r"\d+(?:\.\d+)?", s)]
    if not nums:
        return None
    kind = "build" if re.search(r"->|→|>", s) else ("mix" if len(nums) > 1 else "single")
    return {"lo": nums[0], "hi": nums[-1], "mean": sum(nums) / len(nums), "kind": kind}


# ---------------------------------------------------------------- intensity scales
# Every effort value is stored on one common scale (Effort /20, 6-21) and shown in
# the chosen system. Lined up by heart rate where a system publishes it and by
# purpose otherwise (see the builder's scale chart).


def _z(label, lo, hi, c, **extra):
    z = {"label": label, "lo": lo, "hi": hi, "c": c}
    z.update(extra)
    return z


EFF_SYSTEMS = {
    "effort20": {"name": "Effort /20", "short": "Effort/20", "hint": "/20", "numeric": True},
    "rpe": {"name": "RPE 0–10 (Borg CR10)", "short": "RPE", "hint": "1–10", "zones": [
        _z("1", 0, 7.5, 7, note="very easy"), _z("2", 7.5, 9.5, 8.5, note="easy"), _z("3", 9.5, 11.5, 10.5, note="moderate"),
        _z("4", 11.5, 13.5, 12.5, note="somewhat hard"), _z("5", 13.5, 15, 14.25, note="hard"), _z("6", 15, 16.5, 15.75),
        _z("7", 16.5, 17.5, 17, note="very hard"), _z("8", 17.5, 18.5, 18), _z("9", 18.5, 19.75, 19.1), _z("10", 19.75, 99, 20.5, note="maximal")]},
    "bpsc": {"name": "BPSC HR colours", "short": "HR colour", "hint": "Red…", "colored": True, "zones": [
        _z("White", 0, 12.5, 10, color="#F1F2F4", note="≤24"), _z("Yellow", 12.5, 14.5, 13.5, color="#F4D03F", note="25"),
        _z("Pink", 14.5, 16.5, 15.5, color="#F29AC2", note="26–28"), _z("Red", 16.5, 17.5, 17, color="#D62839", note="29–30"),
        _z("Purple", 17.5, 18.5, 18, color="#7D3C98", note="31–33"), _z("Blue", 18.5, 20.5, 19.5, color="#1F6FD1", note="max effort / race pace"),
        _z("Gold", 20.5, 99, 21, color="#C9A227", note="speed & power")]},
    "urbanchek": {"name": "Urbanchek colours", "short": "Urbanchek", "hint": "Pink…", "colored": True, "zones": [
        _z("White", 0, 11.5, 9, color="#F1F2F4", note="easy aerobic"), _z("Pink", 11.5, 15.5, 13.5, color="#F29AC2", note="aerobic"),
        _z("Red", 15.5, 17.25, 16.5, color="#D62839", note="threshold"), _z("Blue", 17.25, 17.75, 17.5, color="#1F6FD1", note="just above threshold"),
        _z("Purple", 17.75, 18.75, 18, color="#7D3C98", note="VO2 max / race pace"), _z("Green", 18.75, 99, 19.5, color="#2E9D57", note="lactate production / sprint")]},
    "sweetenham": {"name": "Sweetenham (British Swimming)", "short": "Sweetenham", "hint": "A3…", "zones": [
        _z("A1", 0, 12.5, 10, note="aerobic, ≤60 bbm"), _z("A2", 12.5, 14.5, 13.5, note="aerobic, 50–60 bbm"),
        _z("A3", 14.5, 16.5, 15.5, note="aerobic development, 30–50 bbm"), _z("AT", 16.5, 17.5, 17, note="anaerobic threshold, 20–30 bbm"),
        _z("MVO2", 17.5, 18.5, 18, alias=["vo2"], note="VO2 max, 10–20 bbm"), _z("LT", 18.5, 19.25, 19, note="lactate tolerance"),
        _z("LP", 19.25, 20.5, 20, note="lactate production"), _z("Speed", 20.5, 99, 21, alias=["sp", "hvo", "sprint"], note="HVO / alactic sprint")]},
    "maglischo": {"name": "Maglischo energy systems", "short": "Maglischo", "hint": "EN2…", "zones": [
        _z("REC", 0, 9.5, 8, note="recovery"), _z("EN1", 9.5, 15.5, 12.5, note="basic endurance"), _z("EN2", 15.5, 17.5, 16.5, note="threshold endurance"),
        _z("EN3", 17.5, 18.5, 18, note="overload endurance"), _z("SP1", 18.5, 19.25, 19, note="lactate tolerance"),
        _z("SP2", 19.25, 20.5, 20, note="lactate production"), _z("SP3", 20.5, 99, 21, note="power")]},
}
EFF_ORDER = ["effort20", "rpe", "bpsc", "urbanchek", "sweetenham", "maglischo"]
DEFAULT_SYS = "effort20"

# Every club is offered the standard scales; anything else is the club's own
# (BPSC's HR colours are BPSC's own). A club's scales are club data
# (session_builder.load_scales) and sit beside these without changing them:
# a copy that keeps a standard key (e.g. "bpsc") shows instead of it.
STANDARD = ["effort20", "rpe", "urbanchek", "sweetenham", "maglischo"]
CUSTOM: dict = {}


def system(key):
    return CUSTOM.get(key) or EFF_SYSTEMS.get(key)


def use_scales(custom) -> None:
    CUSTOM.clear()
    for s in custom or []:
        if s.get("key"):
            CUSTOM[s["key"]] = s


def _shows_numbers(sys) -> bool:
    return sys == "effort20" or not (system(sys) or {}).get("zones")


def zone_for(v, sys):
    zs = (system(sys) or {}).get("zones")
    if not zs:
        return None
    for z in zs:
        if z["lo"] <= v < z["hi"]:
            return z
    return zs[0] if v < zs[0]["lo"] else zs[-1]


def eff_from_canon(text, sys=DEFAULT_SYS) -> str:
    """Stored (common scale) -> what the chosen system shows."""
    if not text:
        return text or ""
    if _shows_numbers(sys):
        return re.sub(r"\d+\.\d+", lambda m: js_str(js_round(float(m.group(0)))), str(text))
    return re.sub(r"\d+(?:\.\d+)?", lambda m: zone_for(_num(m.group(0)), sys)["label"], str(text))


def canon_of(tok: str, sys):
    if re.match(r"\d", tok):
        if sys == "rpe":
            want = str(min(10, max(1, js_round(float(tok)))))
            z = next((q for q in EFF_SYSTEMS["rpe"]["zones"] if q["label"] == want), None)
            return z["c"] if z else None
        return _num(tok)
    t = tok.lower()
    for k in (sys, "bpsc", "sweetenham", "maglischo", "urbanchek", *CUSTOM):
        S = system(k)
        if not S or not S.get("zones") or k == "rpe":
            continue
        for q in S["zones"]:
            if q["label"].lower() == t or t in q.get("alias", []):
                return q["c"]
    return None


def eff_to_canon(text, sys=DEFAULT_SYS) -> str:
    """What was typed (any system's labels, or numbers in the chosen system) -> common scale."""
    if not text:
        return ""

    def rep(m):
        v = canon_of(m.group(0), sys)
        return m.group(0) if v is None else js_str(v)

    return re.sub(r"[A-Za-z][A-Za-z0-9]*|\d+(?:\.\d+)?", rep, str(text))


def eff_avg_text(a, sys=DEFAULT_SYS) -> str:
    if a is None:
        return ""
    if _shows_numbers(sys):
        return f"{a:.1f}/20"
    return zone_for(a, sys)["label"]


# ---------------------------------------------------------------- model


def new_line(p: Optional[dict] = None) -> dict:
    p = p or {}

    def g(k, d=None):
        v = p.get(k)
        return d if v is None else v

    n = {"id": uid(), "t": "line", "reps": g("reps"), "dist": g("dist"), "desc": g("desc", ""), "int": g("int"),
         "int2": g("int2"), "rest": g("rest"), "est": g("est"), "eff": g("eff", "")}
    # talk (seconds) is only there on a talk line, so ordinary sets keep their shape
    if p.get("talk") is not None:
        n["talk"] = p["talk"]
    return n


def new_round(times=2, items=None, note="") -> dict:
    return {"id": uid(), "t": "round", "times": times, "note": note, "items": items if items is not None else []}


def new_block(name="Block", groups=None, items=None) -> dict:
    b = {"id": uid(), "name": name, "groups": list(groups) if isinstance(groups, list) else [], "items": items or []}
    if isinstance(groups, str) and groups.strip():
        b["group"] = groups.strip()
    return b


def normalize_session(s: dict) -> dict:
    """Bring older sessions (one free-text group per block) into the named-groups model."""
    if not s:
        return s
    blocks = s.get("blocks") or []
    if not isinstance(s.get("groups"), list):
        s["groups"] = []
        for b in blocks:
            g = (b.get("group") or "").strip()
            if g and not any(x["name"].lower() == g.lower() for x in s["groups"]):
                s["groups"].append({"id": "g" + uid(), "name": g})
    ids = {g["id"] for g in s["groups"]}
    for b in blocks:
        if isinstance(b.get("group"), str):
            g = b["group"].strip()
            m = next((x for x in s["groups"] if x["name"].lower() == g.lower()), None) if g else None
            b["groups"] = [m["id"]] if m else (b["groups"] if isinstance(b.get("groups"), list) else [])
            del b["group"]
        if not isinstance(b.get("groups"), list):
            b["groups"] = []
        b["groups"] = [i for i in b["groups"] if i in ids]
    return s


def session_groups(s: dict) -> list:
    gs = s.get("groups")
    return gs if gs else [{"id": None, "name": ""}]


def group_name(s: dict, gid) -> str:
    g = next((x for x in (s.get("groups") or []) if x.get("id") == gid), None)
    return (g or {}).get("name") or ""


def block_group_names(s: dict, b: dict) -> list:
    if b.get("groups"):
        return [n for n in (group_name(s, i) for i in b["groups"]) if n]
    return []


def applies_to(b: dict, gid) -> bool:
    return gid is None or not b.get("groups") or gid in b["groups"]


def session_for_group(s: dict, gid) -> dict:
    """One group's session: the blocks it swims (shared ones included)."""
    if gid is None or not any(g.get("id") == gid for g in (s.get("groups") or [])):
        return s
    out = dict(s)
    out["blocks"] = [b for b in s["blocks"] if applies_to(b, gid)]
    out["groups"] = [g for g in s["groups"] if g.get("id") == gid]
    out["_group"] = group_name(s, gid)
    return out


# ---------------------------------------------------------------- turnaround
# A send-off (@1:30, with an optional second lane @1:30/1:40), or a rest interval
# (r20) with an estimated swim time per rep (~1:20).

T_SO = r"(\d{1,2}[:.]\d{2}|\d{2,3})"
T_SO2 = r"(?:\s*/\s*(\d{1,2}[:.]\d{2}|\d{2,3}))?"
T_R = r"(\d{1,2}[:.]\d{2}|:\d{2}|\d{1,3})"
T_RU = r"(?:\s*(s|secs?|seconds|mins?|minutes)\b)?"
T_END = r"(?=[\s,;)\]]|\Z)"

_RX_AT = re.compile(r"(?:^|\s)@\s*(\d+(?:[:.]\d{1,2})?)" + T_SO2 + T_END)
_RX_PAREN = re.compile(r"\(\s*" + T_SO + T_SO2 + r"\s*\)")
_RX_ONOFF = re.compile(r"(?:^|\s)(?:on|off)\s+" + T_SO + T_SO2 + T_END, I)
_RX_R = re.compile(r"(?:^|\s)@?r\s*" + T_R + T_RU + T_END, I)
_RX_W = re.compile(r"(?:^|\s)(?:w/)\s*" + T_R + T_RU + T_END, I)
_RX_RESTWORD = re.compile(r"(?:^|\s)rest\s+" + T_R + T_RU + T_END, I)
_RX_NREST = re.compile(r"(?:^|\s)(\d{1,2}[:.]\d{2}|:\d{2}|\d{1,3}(?=\s*(?:s|secs?|seconds|mins?|minutes)\b))" + T_RU + r"\s+rest\b", I)
_RX_EST = re.compile(r"(?:^|\s)(?:~|≈|est\.?\s+)\s*" + T_SO + T_END, I)


def parse_rest(v, unit=None):
    x = str(v).strip()
    if re.fullmatch(r":\d{2}", x):
        return int(x[1:])
    if re.fullmatch(r"\d{1,3}", x):
        return int(x) * 60 if unit and re.match(r"m", unit, I) else int(x)
    return parse_time(x)


def rest_short(sec) -> str:
    return js_str(sec) if sec < 60 else fmt_time(sec)


def rest_label(sec) -> str:
    return f"{js_str(sec)}s rest" if sec < 60 else f"{fmt_time(sec)} rest"


def extract_timing(text) -> dict:
    s = " " + str(text or "") + " "
    out = {"int": None, "int2": None, "rest": None, "est": None}

    def cut(m):
        return s[:m.start()] + " " + s[m.end():]

    m = _RX_AT.search(s) or _RX_PAREN.search(s) or _RX_ONOFF.search(s)
    if m:
        out["int"] = parse_time(m.group(1))
        if m.group(2):
            out["int2"] = parse_time(m.group(2))
        s = cut(m)
    else:
        m = _RX_R.search(s) or _RX_W.search(s)
        if m:
            out["rest"] = parse_rest(m.group(1), m.group(2))
            s = cut(m)
        else:
            m = _RX_RESTWORD.search(s)
            if m:
                out["rest"] = parse_rest(m.group(1), m.group(2))
                s = cut(m)
                out["restWord"] = True
            else:
                m = _RX_NREST.search(s)
                if m:
                    out["rest"] = parse_rest(m.group(1), m.group(2))
                    s = cut(m)
    m = _RX_EST.search(s)
    if m:
        out["est"] = parse_time(m.group(1))
        s = cut(m)
    out["s"] = re.sub(r"\s{2,}", " ", s).strip()
    return out


def has_timing(t) -> bool:
    return bool(t) and (t.get("int") is not None or t.get("rest") is not None or t.get("est") is not None)


def timing_mode(t) -> str:
    if t.get("int") is not None:
        return "send"
    return "rest" if (t.get("rest") is not None or t.get("est") is not None) else "none"


def line_timing(n: dict) -> dict:
    return {k: n.get(k) for k in ("int", "int2", "rest", "est")}


def per_rep(t: dict, has_dist: bool) -> dict:
    """Seconds per rep for each lane; a rest set needs an estimated swim time."""
    if t.get("int") is not None:
        return {"per": t["int"], "per2": t["int2"] if t.get("int2") is not None else t["int"]}
    if t.get("est") is not None:
        v = t["est"] + (t.get("rest") or 0)
        return {"per": v, "per2": v}
    if t.get("rest") is not None and not has_dist:
        return {"per": t["rest"], "per2": t["rest"]}
    if t.get("int2") is not None:
        return {"per": 0, "per2": t["int2"]}
    return {"per": 0, "per2": 0}


def _coalesce(*vals):
    for v in vals:
        if v is not None:
            return v
    return None


def merge_timing(base: dict, own) -> dict:
    """A numbered line's own turnaround; anything it leaves out comes from line 1."""
    if not has_timing(own):
        return base
    if own.get("int") is not None:
        return {"int": own["int"], "int2": own.get("int2"), "rest": None, "est": None}
    if own.get("rest") is not None:
        return {"int": None, "int2": None, "rest": own["rest"], "est": _coalesce(own.get("est"), base.get("est"))}
    if base.get("int") is not None:
        return base
    return {"int": None, "int2": None, "rest": base.get("rest"), "est": own.get("est")}


def part_timings(n: dict, edit: bool = False):
    dp = desc_parts(n.get("desc"), 1 if edit else 2, bool(edit))
    if not dp:
        return None
    base = line_timing(n)
    parts = []
    for p in dp["parts"]:
        tm = extract_timing(p["text"])
        own = has_timing(tm)
        parts.append({"n": p["n"], "raw": p["text"], "text": tm["s"] if own else p["text"], "own": tm if own else None})
    first = merge_timing(base, parts[0]["own"] if parts else None)
    for i, p in enumerate(parts):
        p["eff"] = first if i == 0 else merge_timing(first, p["own"])
    out = dict(dp)
    out["parts"] = parts
    out["first"] = first
    return out


def cell_text(t) -> str:
    """The timing in its short typed form ("1:30", "1:30/1:40", "r20", "r20 ~1:20", "~6:00")."""
    if not t:
        return ""
    if t.get("int") is not None:
        two = t.get("int2") is not None and t["int2"] != t["int"]
        return fmt_time(t["int"]) + ("/" + fmt_time(t["int2"]) if two else "")
    bits = ["r" + rest_short(t["rest"]) if t.get("rest") is not None else "", "~" + fmt_time(t["est"]) if t.get("est") is not None else ""]
    return " ".join(b for b in bits if b)


def timing_token(t) -> str:
    return ("@" if t and t.get("int") is not None else "") + cell_text(t)


def parse_timing_cell(v):
    x = re.sub(r"^@\s*", "", str(v or "").strip())
    if not x:
        return {"int": None, "rest": None}
    one = parse_time(x)
    if one is not None:
        return {"int": one, "rest": None}
    two = re.fullmatch(r"([\d:.]+)\s*/\s*([\d:.]+)", x)
    if two and parse_time(two.group(1)) is not None and parse_time(two.group(2)) is not None:
        return {"int": parse_time(two.group(1)), "int2": parse_time(two.group(2)), "rest": None}
    tm = extract_timing(x)
    if tm["s"]:
        return None
    if tm["int"] is not None:
        return {"int": tm["int"], "int2": tm["int2"], "rest": None}
    o = {"int": None, "rest": tm["rest"]}
    if tm["est"] is not None:
        o["est"] = tm["est"]
    return o


def hoist_first_timing(line: dict) -> None:
    if has_timing(line):
        return
    pe = desc_parts(line.get("desc"), 1, True)
    if not pe:
        return
    tm = extract_timing(pe["parts"][0]["text"])
    if not has_timing(tm):
        return
    for k in ("int", "int2", "rest", "est"):
        line[k] = tm.get(k)
    texts = [q["text"] for q in pe["parts"]]
    texts[0] = tm["s"]
    line["desc"] = build_desc(pe["rawPrefix"], texts)


# ---------------------------------------------------------------- totals


def node_stats(n: dict) -> dict:
    if n.get("t") == "round":
        return stats_of(n.get("items"), n.get("times"))
    if is_talk_line(n):
        t = n.get("talk") or 0
        return {"dist": 0, "time": t, "time2": t, "et": 0, "kt": 0}
    reps = n.get("reps") or 1
    dist = n.get("dist") or 0
    hd = bool(dist)
    time = time2 = 0
    pt = part_timings(n)
    if pt and any(q["own"] for q in pt["parts"]):
        # each numbered line covers reps / lines reps when that divides evenly, otherwise
        # one rep each; reps with no line follow line 1
        k = len(pt["parts"])
        each = reps // k if reps % k == 0 else 1
        covered = min(k, math.floor(reps / each))
        for i in range(covered):
            r = per_rep(pt["parts"][i]["eff"], hd)
            time += each * r["per"]
            time2 += each * r["per2"]
        left = reps - each * covered
        if left > 0:
            r = per_rep(pt["first"], hd)
            time += left * r["per"]
            time2 += left * r["per2"]
    else:
        r = per_rep(line_timing(n), hd)
        time = reps * r["per"]
        time2 = reps * r["per2"]
    e = parse_effort(n.get("eff"))
    return {"dist": reps * dist, "time": time, "time2": time2,
            "et": time * e["mean"] if e and time else 0, "kt": time if e and time else 0}


def stats_of(items, times=None) -> dict:
    k = 1 if times is None else (times or 0)
    acc = {"dist": 0, "time": 0, "time2": 0, "et": 0, "kt": 0}
    for n in items or []:
        s = node_stats(n)
        for key in acc:
            acc[key] += s[key]
    return {key: v * k for key, v in acc.items()}


def avg_eff(st: dict):
    return st["et"] / st["kt"] if st["kt"] else None


def _expand_seq(items, out, sys):
    for n in items or []:
        if len(out) > 3000:
            return
        if n.get("t") == "round":
            for _ in range(n.get("times") or 0):
                _expand_seq(n.get("items"), out, sys)
        else:
            st = node_stats(n)
            if st["time"] > 0:
                out.append({"time": st["time"], "eff": parse_effort(n.get("eff")), "label": line_text(n, sys)})


def totals_for(s: dict, sys=DEFAULT_SYS) -> list:
    res = []
    for g in session_groups(s):
        gid = g.get("id")
        acc = {"dist": 0, "time": 0, "time2": 0, "et": 0, "kt": 0}
        seq = []
        for b in s.get("blocks") or []:
            if applies_to(b, gid):
                st = stats_of(b.get("items"))
                for key in acc:
                    acc[key] += st[key]
                _expand_seq(b.get("items"), seq, sys)
        res.append({"g": g.get("name"), "gid": gid, **acc, "seq": seq})
    return res


def block_starts(s: dict) -> dict:
    """Block id -> the times (seconds from the start) it begins, one per group timeline."""
    res: dict = {}
    for g in session_groups(s):
        t = 0
        for b in s.get("blocks") or []:
            if applies_to(b, g.get("id")):
                arr = res.setdefault(b.get("id"), [])
                if t not in arr:
                    arr.append(t)
                t += stats_of(b.get("items"))["time"]
    return res


# ---------------------------------------------------------------- text format

DIST_END = r"(?!\d|[:.]\d|s\b|secs?\b|\s*min|\))"
RX_ROUND = re.compile(r"^(\d+)\s*(?:x|×|rounds?\b)(?!\s*\d+" + DIST_END + r")\s*(.*)\Z", I)
RX_REPS = re.compile(r"^(\d+)\s*[x×]\s*(\d+)" + DIST_END + r"\s*(?:m\b)?\s*(.*)\Z", I)
RX_DIST = re.compile(r"^(\d+)" + DIST_END + r"\s*(?:m\b)?\s*(.*)\Z", I)
RX_PREFIX = re.compile(r"^(\d+)\s*(?:[x×]|rounds?\b)\s*(?:of\b\s*)?", I)
SET_START = re.compile(r"^(?:\d+\s*[x×]\s*\d|\d+\s*(?:[x×]|rounds?\b)\s*(?:of\b\s*)?\(|\d{2,4}(?:\s*m\b)?(?=[\s,;)]|\Z))", I)
PURE_TIME = re.compile(r"^\s*(\d{1,2}[:.]\d{2}|\d{2,3})\s*\Z")
RX_STRONG = re.compile(r"^\d+\s*[x×]\s*\d|^\d+\s*(?:[x×]|rounds?\b)\s*(?:of\b\s*)?\(", I)
RX_SENDOFF = re.compile(r"(?:^|\s)@\s*\d|\(\s*(?:\d{1,2}[:.]\d{2}|\d{2,3})\s*\)|(?:^|\s)(?:on|off)\s+(?:\d{1,2}[:.]\d{2}|\d{2,3})(?=[\s,;)]|\Z)", I)
PART_LINE = re.compile(r"^\s*\d{1,2}\)\s*\S")


def match_paren(s: str, open_at: int) -> int:
    d = 0
    for i in range(open_at, len(s)):
        if s[i] == "(":
            d += 1
        elif s[i] == ")":
            d -= 1
            if d == 0:
                return i
    return -1


def split_sets(s: str, loose: bool = False) -> list:
    """Split "4 x 50, 2 x 100" into sets. "N x M" after a comma always starts a set; a
    bare distance only does inside a round's brackets, or when the part before the
    comma has its own send-off, so "50 No Free, 25 Free" stays one description."""
    parts, d, sq, start = [], 0, 0, 0
    for i, c in enumerate(s):
        if c == "(":
            d += 1
        elif c == ")":
            d = max(0, d - 1)
        elif c == "[":
            sq += 1
        elif c == "]":
            sq = max(0, sq - 1)
        elif c in ",;" and not d and not sq:
            nxt = s[i + 1:].strip()
            if (SET_START.search(nxt) and not re.match(r"\d+\s*(?:m\s*)?each\b", nxt, I)
                    and (loose or RX_STRONG.search(nxt) or RX_SENDOFF.search(s[start:i]))):
                parts.append(s[start:i])
                start = i + 1
    parts.append(s[start:])
    return [x.strip() for x in parts if x.strip()]


def parse_line_nodes(text, loose: bool = False) -> list:
    """One typed line -> one or more sets. A leading "N x" or "N rounds of" applies to
    everything after it on the line."""
    s = str(text).strip()
    if not s:
        return []
    m = RX_PREFIX.search(s)
    if m:
        n = int(m.group(1)) or 1
        rest = s[m.end():]
        if rest[:1] == "(":
            close = match_paren(rest, 0)
            inner = rest[1:] if close < 0 else rest[1:close]
            if not PURE_TIME.search(inner):
                rnd = new_round(n, parse_line_nodes(inner, True))
                after = "" if close < 0 else rest[close + 1:].strip()
                if re.match(r"[,;]", after):
                    return [rnd] + parse_line_nodes(after[1:], loose)
                if after:
                    t = re.fullmatch(r"(?:\(\s*(\d{1,2}[:.]\d{2}|\d{2,3})\s*\)|(?:@|on\s+|off\s+)\s*(\d{1,2}[:.]\d{2}|\d{2,3}))", after, I)
                    items = rnd["items"]
                    only = items[0] if len(items) == 1 and items[0]["t"] == "line" and items[0].get("int") is None else None
                    if t and only:
                        only["int"] = parse_time(t.group(1) or t.group(2))
                    else:
                        rnd["note"] = re.sub(r"^[-–:]\s*", "", after, count=1)
                return [rnd]
        if re.match(r"\d+\s*[x×]\s*\d", rest) or (re.search("round", m.group(0), I) and SET_START.search(rest)):
            return [new_round(n, parse_line_nodes(rest, True))]
    parts = split_sets(s, loose)
    if len(parts) == 1:
        nodes = [parse_set_line(parts[0])]
    else:
        nodes = [x for p in parts for x in parse_line_nodes(p, loose)]
    return [x for x in nodes if x]


# Talk: time the coach spends explaining the next set (its purpose, the details, a word
# with one swimmer) before anyone pushes off. "Talk 3 min purpose and turns" -> a talk
# line {talk: 180, desc: 'purpose and turns'}. It counts toward the session time; no
# metres, no intensity. The time comes first: m:ss, a number with a unit (90s, 2 min,
# 3m, 1.5 mins), or a bare minute count ("Talk 2"). "Explain" needs m:ss, seconds or
# "min", so "Explain 50 fly" and "Explain 25m underwater" stay notes. Anything over half
# an hour isn't a talk.
TALK_T = r"(\d{1,2}[:.]\d{2}|\d{1,3}(?:\.\d)?\s*(?:s|secs?|seconds?|m|mins?|minutes?)\b|\d{1,2}(?![\d:.]|\s*[x×]))"
RX_TALK = re.compile(r"^(?:(?:coach|team)\s+)?(talk|brief(?:ing)?|chat|explain)\b\s*(?:for\s+)?(?:[:\-–]\s*)?" + TALK_T + r"(?!\d)(.*)\Z", I)
TALK_MAX = 1800


def is_talk_line(n) -> bool:
    return bool(n) and n.get("t") == "line" and n.get("talk") is not None


def talk_secs(v):
    x = str("" if v is None else v).strip()
    if re.fullmatch(r"\d{1,2}[:.]\d{2}", x):
        return parse_time(x)
    m = re.fullmatch(r"(\d{1,3}(?:\.\d)?)\s*([a-z]*)", x, I)
    if not m:
        return None
    n, u = _num(m.group(1)), m.group(2).lower()
    if not u:
        return n * 60 if n < 10 else n
    return js_round(n * 60 if u.startswith("m") else n)


def parse_talk(text):
    m = RX_TALK.match(str(text).strip())
    if not m:
        return None
    if re.match(r"explain", m.group(1), I) and re.fullmatch(r"\d+(?:\.\d)?(?:\s*m)?", m.group(2), I):
        return None
    t = talk_secs(m.group(2))
    if not t or t > TALK_MAX:
        return None
    desc = re.sub(r"\s{2,}", " ", re.sub(r"^[\s,;:\-–]+", "", m.group(3), count=1)).strip()
    return new_line({"desc": desc, "talk": t})


def parse_set_line(text):
    s = str(text).strip()
    if not s:
        return None
    talk = parse_talk(s)
    if talk:
        return talk
    m = RX_ROUND.search(s)
    if m:
        rest = re.sub(r"^[:\-–]\s*|^of\s+", "", m.group(2), count=1, flags=I).strip()
        if rest and SET_START.search(rest):
            return new_round(int(m.group(1)) or 1, parse_line_nodes(rest, True))
        return new_round(int(m.group(1)) or 1, [], rest)
    p = {"reps": None, "dist": None, "desc": "", "int": None, "int2": None, "rest": None, "est": None, "eff": ""}
    em = re.search(r"\[([^\]]*)\]", s)
    if em:
        p["eff"] = eff_to_canon(em.group(1).strip())
        s = (s[:em.start()] + " " + s[em.end():]).strip()
    else:
        e2 = re.search(r"\s(?:e|eff|effort)\s*(\d[\d.\s>\-/→]*)\Z", s, I)
        if e2:
            p["eff"] = eff_to_canon(e2.group(1).strip())
            s = s[:e2.start()].strip()
    # "4 x 50 alt max dive start (1:10) and max finish (1:50)": alternating reps,
    # each option on its own turnaround
    if not desc_parts(s, 1, True):
        q = RX_REPS.search(s) or RX_DIST.search(s)
        after = q.group(q.re.groups) if q else s
        am = re.fullmatch(r"(alt(?:ernate|ernating)?\.?)\s+(.+)", after, I)
        if am:
            opts = [x.strip() for x in re.split(r"\s+(?:and|&|then)\s+|\s*;\s*|\s+/\s+|,\s+(?=\S)", am.group(2), flags=I) if x and x.strip()]
            if len(opts) >= 2 and len([x for x in opts if has_timing(extract_timing(x))]) >= 2:
                s = s[:len(s) - len(after)] + am.group(1) + " " + " ".join(f"{i + 1}) {x}" for i, x in enumerate(opts))
    # timing typed before the numbered lines is the set's; timing after "2) …" belongs to that line
    pm = desc_parts(s, 1, True)
    tail = s[pm["at"]:].strip() if pm else ""
    tm = extract_timing(s[:pm["at"]] if pm else s)
    s = tm["s"]
    for k in ("int", "int2", "rest", "est"):
        if tm.get(k) is not None:
            p[k] = tm[k]
    m = RX_REPS.search(s)
    if m:
        p["reps"], p["dist"], s = int(m.group(1)), int(m.group(2)), m.group(3)
    else:
        m = RX_DIST.search(s)
        if m:
            p["dist"], s = int(m.group(1)), m.group(2)
    d = re.sub(r"^[\s,;:\-–]+", "", s, count=1)
    d = re.sub(r"^as\s+", "", d, count=1, flags=I)
    d = re.sub(r"[\s,;]+\Z", "", d, count=1)
    p["desc"] = re.sub(r"\s{2,}", " ", d).strip()
    if not p["desc"] and tm.get("restWord") and not tail and p["dist"] is None:
        p["desc"] = "Rest"
    if tail:
        p["desc"] = (p["desc"] + " " if p["desc"] else "") + tail
    if p["reps"] == 1:
        p["reps"] = None
    line = new_line(p)
    hoist_first_timing(line)
    return line


def parse_text(text) -> list:
    """A block written as text; indenting puts sets inside the round above."""
    root: list = []
    stack = None
    last = None
    for raw in re.split(r"\r?\n", str(text).replace("\t", "  ")):
        if not raw.strip():
            continue
        if PART_LINE.search(raw) and last and last.get("t") == "line" and not is_talk_line(last):
            add_part(last, raw)
            continue
        ind = len(re.match(r" *", raw).group(0))
        if stack is None:
            stack = [{"ind": ind, "items": root}]
        while len(stack) > 1 and ind < stack[-1]["ind"]:
            stack.pop()
            top = stack[-1]
            last = top["items"][-1] if top["items"] else None
        top = stack[-1]
        target = top
        if ind > top["ind"] and last and last.get("t") == "round" and any(x is last for x in top["items"]):
            stack.append({"ind": ind, "items": last["items"]})
            target = stack[-1]
        nodes = parse_line_nodes(raw)
        if not nodes:
            continue
        target["items"].extend(nodes)
        last = nodes[-1]
    return root


def desc_parts(desc, min_parts: int = 2, keep_empty: bool = False):
    """"1) Kick 2) Drill 3) Swim 4) Build" -> what each rep does. Markers start at 1 and
    never go backwards (a repeat of the same number is allowed); any other "N)" is text."""
    s = str(desc or "")
    marks = []
    for m in re.finditer(r"(^|[\s,;/]+)(\d{1,2})\)", s):
        n = int(m.group(2))
        last = marks[-1] if marks else None
        if (n != last["n"] and n != last["n"] + 1) if last else n != 1:
            continue
        end = m.end()
        while end < len(s) and s[end] == " ":
            end += 1
        marks.append({"n": n, "sepAt": m.start(), "end": end})
    if len(marks) < max(1, min_parts):
        return None
    raw_prefix = s[:marks[0]["sepAt"]].strip()
    prefix = re.sub(r"[\s,;/:\-–]+\Z", "", raw_prefix).strip()
    parts = []
    for i, k in enumerate(marks):
        stop = marks[i + 1]["sepAt"] if i + 1 < len(marks) else len(s)
        parts.append({"n": k["n"], "text": re.sub(r"[\s,;/]+\Z", "", s[k["end"]:stop]).strip()})
    if not keep_empty:
        parts = [p for p in parts if p["text"]]
        if len(parts) < min_parts:
            return None
    return {"prefix": prefix, "rawPrefix": raw_prefix, "parts": parts, "at": marks[0]["sepAt"]}


def build_desc(prefix, texts) -> str:
    bits = [str(prefix or "").strip()] + [f"{i + 1}) {str(t or '').strip()}".strip() for i, t in enumerate(texts)]
    return " ".join(b for b in bits if b)


def plain_desc(desc) -> str:
    """The description as it should print: unfinished empty "N)" lines dropped."""
    d = str(desc or "")
    pe = desc_parts(d, 1, True)
    if not pe or all(p["text"] for p in pe["parts"]):
        return d.strip()
    keep = [p["text"] for p in pe["parts"] if p["text"]]
    return build_desc(pe["rawPrefix"], keep) if keep else pe["rawPrefix"]


def _no_dist(n) -> bool:
    return n.get("dist") is None or n.get("dist") == ""


def _bare(n) -> bool:
    return (n.get("t") == "line" and n.get("talk") is None and _no_dist(n) and not ((n.get("reps") or 0) > 1)
            and all(n.get(k) is None for k in ("int", "int2", "rest", "est")) and not n.get("eff"))


def is_note_line(n: dict) -> bool:
    """A line with words only, e.g. "Fins on" or "Explain the main set"."""
    return _bare(n) and bool(plain_desc(n.get("desc"))) and not desc_parts(n.get("desc"))


def is_blank_line(n: dict) -> bool:
    return _bare(n) and not plain_desc(n.get("desc"))


def add_part(line: dict, text: str, sys=DEFAULT_SYS) -> None:
    """"2) swim" said or typed after "2x100 kick": the set's own text becomes line 1;
    numbers always continue in order."""
    t = text.strip()
    eff = ""
    pe0 = desc_parts(line.get("desc"), 1, True)
    have = len(pe0["parts"]) if pe0 else 0
    nm = re.match(r"(\d{1,2})\)\s*", t)
    if nm:
        nxt = have + 1
        if not have and int(nm.group(1)) >= 2 and str(line.get("desc") or "").strip():
            line["desc"] = "1) " + str(line["desc"]).strip()
            nxt = 2
        t = f"{nxt}) " + t[nm.end():]
    em = re.search(r"\[([^\]]*)\]", t)
    if em:
        eff = eff_to_canon(em.group(1).strip(), sys)
        t = re.sub(r"\s{2,}", " ", t[:em.start()] + " " + t[em.end():]).strip()
    line["desc"] = (line["desc"] + " " if line.get("desc") else "") + t
    if eff and not line.get("eff"):
        line["eff"] = eff
    hoist_first_timing(line)


def time_text(st: dict) -> str:
    return fmt_time(st["time"]) + (" / " + fmt_time(st["time2"]) if st["time2"] != st["time"] else "")


def line_text(n: dict, sys=DEFAULT_SYS) -> str:
    if is_talk_line(n):
        return " ".join(x for x in ["Talk " + fmt_time(n["talk"]), plain_desc(n.get("desc"))] if x)
    parts = []
    if not _no_dist(n):
        parts.append((js_str(n["reps"]) + "x" if n.get("reps") and n["reps"] > 1 else "") + js_str(n["dist"]))
    d = plain_desc(n.get("desc"))
    pe = desc_parts(d, 1, True)
    if pe:
        if pe["rawPrefix"]:
            parts.append(pe["rawPrefix"])
    elif d:
        parts.append(d)
    tt = timing_token(line_timing(n)) or ("@" + fmt_time(n["int2"]) if n.get("int2") is not None else "")
    if tt:
        parts.append(tt)
    if n.get("eff"):
        parts.append("[" + eff_from_canon(n["eff"], sys) + "]")
    if pe:
        parts.append(d[pe["at"]:].strip())
    return " ".join(parts)


def items_to_text(items, depth: int = 0, sys=DEFAULT_SYS) -> list:
    pad = "  " * depth
    out = []
    for n in items or []:
        if n.get("t") == "round":
            out.append(pad + js_str(n.get("times") or 1) + "x" + (" " + n["note"] if n.get("note") else ""))
            out.extend(items_to_text(n.get("items"), depth + 1, sys))
        elif not is_blank_line(n):
            out.append(pad + line_text(n, sys))
    return out


_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def _date(s):
    try:
        return datetime.strptime(str(s), "%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def display_title(s: dict) -> str:
    if s.get("title") and s["title"].strip():
        return s["title"].strip()
    d = _date(s.get("date")) if s.get("date") else None
    if d:
        return f"{_WEEKDAYS[d.weekday()]} {d.day} {_MONTHS[d.month - 1]} {d.year}"
    return "Untitled session"


def group_label(g) -> str:
    return g or "Everyone"


def has_note_text(b: dict) -> bool:
    return bool(str(b.get("text") or "").strip())


def session_text(s: dict, sys=DEFAULT_SYS) -> str:
    out = [display_title(s) + (" · " + s["slot"] if s.get("slot") else "")
           + (" · " + s["start"] + "–" + s["end"] if s.get("start") and s.get("end") else "")]
    line2 = " · ".join(x for x in [s.get("venue"), "Week " + s["weekKey"] if s.get("weekKey") else ""] if x)
    if line2:
        out.append(line2)
    aims = [a for a in (s.get("aims") or []) if a and a.strip()]
    if aims:
        out.append("Aims: " + "; ".join(aims))
    for b in s.get("blocks") or []:
        st = stats_of(b.get("items"))
        gn = block_group_names(s, b)
        label = (" (" + ", ".join(gn) + ")") if gn else ""
        if b.get("kind") == "notes":
            if not has_note_text(b):
                continue
            out.extend(["", (b.get("name") or "Notes").upper() + label] + str(b["text"]).strip().split("\n"))
            continue
        out.append("")
        out.append((b.get("name") or "Block").upper() + label + " · " + fmt_dist(st["dist"]) + " m · " + time_text(st))
        out.extend(items_to_text(b.get("items"), 0, sys))
    out.append("")
    out.append("Totals: " + " | ".join(group_label(t["g"]) + " " + fmt_dist(t["dist"]) + " m · " + time_text(t) for t in totals_for(s, sys)))
    return "\n".join(out)


def clone_with_new_ids(n: dict) -> dict:
    c = copy.deepcopy(n)

    def re_id(x):
        x["id"] = uid()
        for y in x.get("items") or []:
            re_id(y)

    re_id(c)
    return c


def parts_note(n: dict, k: int) -> str:
    reps = n.get("reps") or 1
    if k < 2 or reps == k:
        return ""
    alt = bool(re.match(r"alt", (desc_parts(n.get("desc"), 1, True) or {}).get("rawPrefix") or "", I))
    if reps % k == 0:
        return f"alternating, {js_str(reps // k)} of each" if alt else f"each part ×{js_str(reps // k)}"
    return f"{k} parts for {reps} reps"


# ---------------------------------------------------------------- dictation
# Turn how sets are said ("four by fifty on one ten, twenty seconds rest") into the
# shorthand the parser reads. speech=True for a microphone transcript: number words
# become digits and "on 110" means 1:10. Typing gets the safe rules only.

NUMW = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
        "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
        "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
NUMWORD = ("(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|"
           "nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)")
DKW = "(on|off|at|rest|recovery|about|around|roughly|approximately|approx|estimate|est|hold|holding)"
EST = r"(?:about|around|roughly|approximately|approx\.?|estimated?|est)"


def cap_first(x: str) -> str:
    return x[:1].upper() + x[1:]


def _nw(x):
    return None if x is None else NUMW.get(x.lower())


def _digit(v) -> bool:
    return v is not None and 0 < v < 10


def words_to_digits(text: str) -> str:
    w = [x for x in re.split(r"\s+", re.sub(r"([a-z])-([a-z])", r"\1 \2", text, flags=I)) if x]
    out = []
    at = lambda j: w[j] if j < len(w) else None  # noqa: E731
    i = 0
    while i < len(w):
        if re.fullmatch("a", w[i], I) and re.fullmatch("hundred", at(i + 1) or "", I):
            w[i] = "one"
        cur = _nw(w[i])
        if cur is None:
            out.append(w[i])
            i += 1
            continue
        i += 1
        if 0 < cur < 10 and re.fullmatch("hundred", at(i) or "", I):
            cur *= 100
            i += 1
            if re.fullmatch("and", at(i) or "", I) and _nw(at(i + 1)) is not None:
                i += 1
            t = _nw(at(i))
            if t is not None and 0 < t < 100:
                cur += t
                i += 1
                if t >= 20 and _digit(_nw(at(i))):
                    cur += _nw(at(i))
                    i += 1
        elif cur >= 20 and _digit(_nw(at(i))):
            cur += _nw(at(i))
            i += 1
        out.append(str(cur))
        if re.fullmatch("oh", at(i) or "", I) and _digit(_nw(at(i + 1))):
            out.append("0" + str(_nw(at(i + 1))))
            i += 2
    return " ".join(out)


def looks_spoken(t) -> bool:
    x = str(t or "").strip()
    return bool(
        re.search(r"\b\d+\s+(?:by|times|lots of)\s+\d", x, I)
        or re.match("(?:a|" + NUMWORD + r")(?:[\s-]+" + NUMWORD + r"|\s+hundred)*\s+(?:by|times|x|lots of)\b", x, I)
        or re.match("(?:a|" + NUMWORD + r")(?:[\s-]+" + NUMWORD + r")*\s+hundred\b", x, I)
        or re.match(NUMWORD + r"[\s-]+(?:fifties|hundreds|twenty[\s-]?fives|seventy[\s-]?fives)\b", x, I)
        or re.match(r"(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b", x, I)
    )


def normalize_dictation(raw, speech: bool = False, sys=DEFAULT_SYS) -> str:
    t = str(raw or "").strip()
    sub = re.sub
    if speech:
        t = sub(r"([^\d])[.,;!?]+(?=\s|\Z)", r"\1", t)
        t = sub(r"\b(twenty|seventy)[\s-]?fives\b", lambda m: "25s" if re.match("t", m.group(1), I) else "75s", t, flags=I)
        t = sub(r"\bone[\s-]fifties\b", "150s", t, flags=I)
        t = sub(r"\bfifties\b", "50s", t, flags=I)
        t = sub(r"\btwo hundreds\b", "200s", t, flags=I)
        t = sub(r"\bhundreds\b", "100s", t, flags=I)
        t = sub(r"^(for|fore)\s+(by|times|lots of|x)\b", r"4 \2", t, count=1, flags=I)
        t = sub(r"^(to|too)\s+(by|times|lots of|x)\b", r"2 \2", t, count=1, flags=I)
        t = sub(r"^(won)\s+(by|times|x)\b", r"1 \2", t, count=1, flags=I)
        t = sub(r"^(line|number|part)\s+(to|too)\b", r"\1 2", t, count=1, flags=I)
        t = sub(r"^(line|number|part)\s+(for|fore)\b", r"\1 4", t, count=1, flags=I)
        t = sub(r"^(line|number|part)\s+won\b", r"\1 1", t, count=1, flags=I)
        t = words_to_digits(t)
        t = sub(r"\bplus\b", "+", t, flags=I)
        t = sub(r"\bheart rate\b", "HR", t, flags=I)
        t = sub(r"\b(HR)\s+(\d{2})\s+(?:to|through)\s+(\d{2})\b", r"\1 \2-\3", t, flags=I)
        t = sub(r"\b(build|builds|descend|descending)\s+(\d)\s+(?:to|through)\s+(\d)\b",
                lambda m: f"{cap_first(m.group(1))} {m.group(2)}-{m.group(3)}", t, flags=I)
        t = sub(r"^(\d+)\s+(25|50|75|100|150|200|250|300|400|500|800)s\b(?!\s+(?:rest|recovery|break))", r"\1x\2", t, count=1, flags=I)
    # reps x distance: "4 by 50", "4 times 50", "4 lots of 50", "4 by 1 50" (= 150)
    t = sub(r"\b(\d+)\s*(?:x|×|by|times|lots of)\s*(\d)\s+(\d{2})\b(?!\s*(?:seconds?|secs?|minutes?)\b)",
            lambda m: f"{m.group(1)}x{m.group(2)}{m.group(3)}", t, flags=I)
    t = sub(r"\b(\d+)\s*(?:×|by|times|lots of)\s*(\d+)\b", r"\1x\2", t, flags=I)
    t = sub(r"\b(\d+)\s+x\s+(\d+)\b", r"\1x\2", t, flags=I)
    t = sub(r"\b(\d+)\s+times\s+(?:through|round|around)\b", r"\1x", t, flags=I)
    # send-off words: "every 1:10", "on the 1:10", "leaving on 1:10"
    t = sub(r"\b(?:leaving|leave|going|go)\s+(on|every)\b", r"\1", t, flags=I)
    t = sub(r"\bevery\s+(?=(?:the\s+)?(?:\d{1,2}:\d{2}|\d{1,3}\b|a minute))", "on ", t, flags=I)
    t = sub(r"\b" + DKW + r"\s+the\s+(?=\d|a minute)", r"\1 ", t, flags=I)
    # times after a keyword: "1 minute 10", "a minute and a half", "1 10", and (speech) "110"
    t = sub(r"\ba minute and a half\b", "1:30", t, flags=I)
    t = sub(r"\b(\d{1,2}) and a half minutes\b", r"\1:30", t, flags=I)
    t = sub(r"\b(\d{1,2}) minutes? and a half\b", r"\1:30", t, flags=I)
    t = sub(r"\ba minute\b", "1 minute", t, flags=I)
    t = sub(r"\b" + DKW + r"\s+(\d{1,2})\s+minutes?(?:\s+(?:and\s+)?(\d{1,2})(?:\s+seconds?)?)?\b",
            lambda m: f"{m.group(1)} {m.group(2)}:{m.group(3).rjust(2, '0') if m.group(3) is not None else '00'}", t, flags=I)
    t = sub(r"\b" + DKW + r"\s+(\d)\s+(\d{2})\b(?!\s*(?:seconds?|secs?)\b)",
            lambda m: f"{m.group(1)} {m.group(2)}:{m.group(3)}" if int(m.group(3)) < 60 else m.group(0), t, flags=I)
    if speech:
        t = sub(r"\b" + DKW + r"\s+(\d)(\d{2})\b(?!\s*(?:seconds?|secs?)\b)",
                lambda m: f"{m.group(1)} {m.group(2)}:{m.group(3)}" if int(m.group(3)) < 60 else m.group(0), t, flags=I)
    # estimated swim time: "about 1:20 each", "roughly 45 seconds a rep"
    t = sub(r"\b" + EST + r"\s+(\d{1,2}:\d{2})(?:\s+(?:each|per\s+(?:rep|one|swim|\d+)|a\s+(?:rep|swim)))?\b", r"~\1", t, flags=I)
    t = sub(r"\b" + EST + r"\s+(\d{1,3})\s+(?:seconds?|secs?)(?:\s+(?:each|per\s+(?:rep|one|swim|\d+)|a\s+(?:rep|swim)))?\b",
            lambda m: "~" + fmt_time(int(m.group(1))), t, flags=I)
    # rest: "with 20 seconds rest", "1 minute rest", "rest 30 seconds", "20 seconds recovery"
    t = sub(r"\b(?:with\s+)?(\d{1,3})\s*(?:s|secs?|seconds?)\s+(?:of\s+)?(?:rest|recovery|break)\b", r"\1s rest", t, flags=I)
    t = sub(r"\b(?:with\s+)?(\d{1,2})\s+minutes?\s+(?:of\s+)?(?:rest|recovery|break)\b", r"\1:00 rest", t, flags=I)
    t = sub(r"\b(?:with\s+)?(\d{1,2}:\d{2})\s+(?:of\s+)?(?:rest|recovery|break)\b", r"\1 rest", t, flags=I)
    t = sub(r"\b(?:rest|recovery)\s+(?:of\s+|for\s+)?(\d{1,3})\s*(?:s|secs?|seconds?)\b", r"rest \1", t, flags=I)
    t = sub(r"\brecovery\s+(?=\d)", "rest ", t, flags=I)
    t = sub(r"\b" + DKW + r"\s+(\d{1,3})\s+(?:seconds?|secs?)\b", r"\1 \2", t, flags=I)
    t = sub(r"\bat\s+(\d{1,2}:\d{2})\b", r"on \1", t, flags=I)

    # intensity: "effort 14", "effort 14 to 18", "effort 14 building to 18", "zone red"
    def eff(m):
        a, b, c = m.group(1), m.group(2), m.group(3)

        def ok(x):
            return bool(re.fullmatch(r"\d{1,2}", x)) or canon_of(x, sys) is not None

        if not ok(a) or (b and not ok(b)) or (c and not ok(c)):
            return m.group(0)
        return f"[{a}{'-' + b if b else ('->' + c if c else '')}]"

    t = sub(r"\b(?:effort|intensity|zone)\s+(?:of\s+|at\s+)?([a-z0-9]+)(?:\s+(?:to|through|-)\s+([a-z0-9]+)|\s+(?:building|build|builds)\s+to\s+([a-z0-9]+))?\b",
            eff, t, flags=I)
    # numbered lines: "line 2 build on 4:45" -> "2) build on 4:45"
    t = sub(r"^(?:line|number|no\.?|part|step)\s+(\d{1,2})\b[\s:,.\-]*", r"\1) ", t, count=1, flags=I)
    t = sub(r"\s{2,}", " ", t)
    t = sub(r"[\s.]+\Z", "", t, count=1)
    return t.strip()


# ---------------------------------------------------------------- training zones
# How much of a session falls in each kind of work (twin of frontend/src/notation/zones.js).
# Default bands follow Sweetenham's zones on the common scale; a club can replace them.
# One intensity puts the whole set in that zone; a mix or build shares it equally between
# the values given; "kick" in the description counts as kicking; no intensity is
# "unspecified", never guessed.

DEFAULT_ZONE_BANDS = [
    {"zone": "recovery", "below": 9.5},
    {"zone": "aerobic", "below": 16.5},
    {"zone": "threshold", "below": 17.5},
    {"zone": "vo2", "below": 18.5},
    {"zone": "lact_tol", "below": 19.25},
    {"zone": "race_pace", "below": 20.5},
    {"zone": "sprint", "below": math.inf},
]
ZONE_KEYS = ["recovery", "aerobic", "threshold", "vo2", "lact_tol", "race_pace", "sprint", "kicking", "unspecified"]
_KICK = re.compile(r"\bkick", I)


def zone_of_value(v, bands=DEFAULT_ZONE_BANDS) -> str:
    for b in bands:
        if v < b["below"]:
            return b["zone"]
    return bands[-1]["zone"]


def _empty_zones() -> dict:
    return {k: {"dist": 0, "time": 0} for k in ZONE_KEYS}


def _add_zone_line(acc, n, k, bands):
    # the coach talking isn't training: it has no zone
    if n.get("talk") is not None:
        return
    st = node_stats(n)
    dist, time = st["dist"] * k, st["time"] * k
    if not dist and not time:
        return
    if _KICK.search(str(n.get("desc") or "")):
        acc["kicking"]["dist"] += dist
        acc["kicking"]["time"] += time
        return
    if not parse_effort(n.get("eff")):
        acc["unspecified"]["dist"] += dist
        acc["unspecified"]["time"] += time
        return
    nums = [_num(x) for x in re.findall(r"\d+(?:\.\d+)?", str(n["eff"]))]
    share = 1 / len(nums)
    for v in nums:
        z = zone_of_value(v, bands)
        acc[z]["dist"] += dist * share
        acc[z]["time"] += time * share


def _walk_zones(acc, items, k, bands):
    for n in items or []:
        if n.get("t") == "round":
            _walk_zones(acc, n.get("items"), k * (n.get("times") or 0), bands)
        else:
            _add_zone_line(acc, n, k, bands)


def item_zones(items, bands=DEFAULT_ZONE_BANDS) -> dict:
    acc = _empty_zones()
    _walk_zones(acc, items, 1, bands)
    return acc


def session_zones(s: dict, bands=DEFAULT_ZONE_BANDS) -> list:
    """Zones for each group in a session: the shared blocks plus the group's own."""
    res = []
    for g in session_groups(s):
        acc = _empty_zones()
        for b in s.get("blocks") or []:
            if b.get("kind") != "notes" and applies_to(b, g.get("id")):
                _walk_zones(acc, b.get("items"), 1, bands)
        res.append({"g": g.get("name"), "gid": g.get("id"), "zones": acc})
    return res
