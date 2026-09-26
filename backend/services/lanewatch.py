"""LaneWatch: the detailed race analysis the coach has captured, read live.

LaneWatch holds what a results sheet cannot: reaction time, the 15m time,
underwater speed off the dive and off each wall, breakouts, stroke rate length
by length, and how much the back half falls away. The performance analyst
needs exactly that.

How the link works, and why:

  * The coach signs in to LaneWatch (in the browser, with whichever sign-in
    they use there) and LaneWatch issues this app a read-only key. The coach's
    LaneWatch login never passes through here beyond that one exchange.
  * The key acts as the coach and LaneWatch enforces everything: only the
    coach's roster, only swims each swimmer has shared with them, only while
    the subscription that funds it is live. This app cannot widen that.
  * The key is stored encrypted. "Disconnect" revokes it at LaneWatch too.
  * Race data is read live and kept in memory for a few minutes at most. It is
    never copied into this database, so a swimmer who stops sharing stops
    being readable straight away.

The per-race numbers come from LaneWatch's own summary (metrics_json), which
is computed by the same code that draws its charts. Only the length-by-length
splits and stroke rates are rebuilt here, following LaneWatch's documented
rules (race_metrics.dart), because the summary does not carry them.
"""

from __future__ import annotations

import base64
import hashlib
import os
import re
import threading
import time
from datetime import datetime, timezone
from typing import Optional

import httpx
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.orm import Session as DBSession

from backend import models

LANEWATCH_API_URL = os.getenv(
    "LANEWATCH_API_URL", "https://lanewatch-api-vbne6vd2pa-nw.a.run.app/api/v1").rstrip("/")
APP_NAME = "Coaching Assistant"
KEY_PREFIX = "lwk_"
TIMEOUT_SECONDS = 15
CACHE_SECONDS = 300
_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


class LaneWatchError(Exception):
    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------------------
# The key, encrypted at rest
# ---------------------------------------------------------------------------

def _fernet() -> Fernet:
    secret = os.getenv("LANEWATCH_KEY_SECRET") or os.getenv("SECRET_KEY")
    if not secret:
        raise LaneWatchError("The server has no SECRET_KEY set, so it cannot store a LaneWatch key safely.")
    digest = hashlib.sha256(b"lanewatch-connection-key:" + secret.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_key(key: str) -> str:
    return _fernet().encrypt(key.encode("utf-8")).decode("ascii")


def decrypt_key(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken:
        raise LaneWatchError("The stored LaneWatch key cannot be read (the server secret changed). Connect again.")


# ---------------------------------------------------------------------------
# Talking to LaneWatch
# ---------------------------------------------------------------------------

def _request(method: str, path: str, token: str, body: Optional[dict] = None):
    try:
        response = httpx.request(method, LANEWATCH_API_URL + path, json=body, timeout=TIMEOUT_SECONDS,
                                 headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError:
        raise LaneWatchError("LaneWatch could not be reached just now. Try again shortly.")
    if response.status_code >= 400:
        detail = None
        try:
            detail = response.json().get("detail")
        except Exception:
            pass
        raise LaneWatchError(str(detail) if detail else f"LaneWatch refused that ({response.status_code}).",
                             status=response.status_code)
    if not response.content:
        return {}
    return response.json()


_cache: dict = {}
_cache_lock = threading.Lock()


def _cached(key: str):
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        _cache.pop(key, None)
    return None


def _remember(key: str, value) -> None:
    with _cache_lock:
        _cache[key] = (time.monotonic() + CACHE_SECONDS, value)


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def get_connection(db: DBSession) -> Optional[models.LaneWatchConnection]:
    return db.query(models.LaneWatchConnection).order_by(models.LaneWatchConnection.id.desc()).first()


def status(db: DBSession) -> dict:
    conn = get_connection(db)
    linked = db.query(models.LaneWatchSwimmerLink).count()
    if not conn:
        return {"connected": False, "linked": linked}
    return {
        "connected": True,
        "connected_as": conn.connected_as,
        "role": conn.lanewatch_role,
        "key_hint": conn.key_hint,
        "last_error": conn.last_error,
        "linked": linked,
        "since": conn.created_at.isoformat() if conn.created_at else None,
    }


def connect(db: DBSession, id_token: str) -> models.LaneWatchConnection:
    """Swap a LaneWatch sign-in for a read-only key. The sign-in token is used
    once, here, and not kept."""
    id_token = (id_token or "").strip()
    if not id_token or len(id_token) > 8000:
        raise LaneWatchError("Sign in to LaneWatch first.")
    created = _request("POST", "/connected-apps", id_token, {"name": APP_NAME})
    key = str(created.get("key") or "")
    if not key.startswith(KEY_PREFIX):
        raise LaneWatchError("LaneWatch did not return a connection key.")
    info = _request("GET", "/connected-apps/current", key)

    # One connection at a time: a new one replaces, and revokes, the old.
    previous = get_connection(db)
    if previous:
        try:
            _request("DELETE", "/connected-apps/current", decrypt_key(previous.key_encrypted))
        except LaneWatchError:
            pass
        db.delete(previous)

    conn = models.LaneWatchConnection(
        key_encrypted=encrypt_key(key), key_hint=key[-4:],
        connected_as=info.get("display_name"), lanewatch_role=info.get("role"),
        last_checked_at=datetime.now(timezone.utc),
    )
    db.add(conn)
    db.commit()
    clear_cache()
    return conn


def disconnect(db: DBSession) -> dict:
    """Revoke the key at LaneWatch and forget it here. Swimmer pairings stay,
    so connecting again does not mean matching everyone again."""
    conn = get_connection(db)
    if not conn:
        return {"disconnected": False, "revoked_at_lanewatch": False}
    revoked = False
    try:
        _request("DELETE", "/connected-apps/current", decrypt_key(conn.key_encrypted))
        revoked = True
    except LaneWatchError:
        revoked = False
    db.delete(conn)
    db.commit()
    clear_cache()
    return {"disconnected": True, "revoked_at_lanewatch": revoked}


def _read(db: DBSession, path: str):
    conn = get_connection(db)
    if not conn:
        raise LaneWatchError("LaneWatch is not connected.")
    try:
        data = _request("GET", path, decrypt_key(conn.key_encrypted))
    except LaneWatchError as exc:
        if exc.status == 401:
            conn.last_error = "LaneWatch no longer accepts this connection. Connect again."
            db.commit()
        raise
    if conn.last_error:
        conn.last_error = None
    conn.last_checked_at = datetime.now(timezone.utc)
    db.commit()
    return data


def roster(db: DBSession) -> list:
    hit = _cached("roster")
    if hit is not None:
        return hit
    data = _read(db, "/coach_swimmers/as_coach/me")
    rows = data.get("rows", []) if isinstance(data, dict) else []
    rows = [r for r in rows if isinstance(r, dict) and _UUID.match(str(r.get("id", "")))]
    _remember("roster", rows)
    return rows


def swim_logs(db: DBSession, lanewatch_swimmer_id: str) -> dict:
    """{"logs": [...], "note": why there is nothing, or None}."""
    if not _UUID.match(lanewatch_swimmer_id or ""):
        return {"logs": [], "note": "not a LaneWatch swimmer"}
    key = f"logs:{lanewatch_swimmer_id}"
    hit = _cached(key)
    if hit is not None:
        return hit
    try:
        data = _read(db, f"/swim-logs/for/{lanewatch_swimmer_id}")
    except LaneWatchError as exc:
        if exc.status in (403, 404):
            result = {"logs": [], "note": str(exc)}
            _remember(key, result)
            return result
        raise
    result = {"logs": data if isinstance(data, list) else [], "note": None}
    _remember(key, result)
    return result


# ---------------------------------------------------------------------------
# Pairing LaneWatch swimmers with swimmers here
# ---------------------------------------------------------------------------

def _norm(name: str) -> str:
    return " ".join(re.sub(r"[^a-z ]", " ", (name or "").lower()).split())


def _dob(value) -> Optional[str]:
    return str(value)[:10] if value else None


def suggest_links(db: DBSession) -> dict:
    """Current pairings, suggested ones, and who is left over on each side.

    A suggestion needs the same name; the same date of birth makes it strong,
    a different one rules it out. Nothing is paired until the coach confirms.
    """
    lw_rows = roster(db)
    by_id = {str(r["id"]): r for r in lw_rows}
    links = db.query(models.LaneWatchSwimmerLink).all()
    linked_local = {l.swimmer_id for l in links}
    linked_remote = {l.lanewatch_swimmer_id for l in links}
    swimmers = db.query(models.Swimmer).filter(models.Swimmer.active.is_(True)).order_by(models.Swimmer.name).all()

    def shares(row):
        return row.get("cloud_visibility") in ("coach", "club", "public") or row.get("is_manual")

    current = []
    for link in links:
        row = by_id.get(link.lanewatch_swimmer_id)
        current.append({
            "swimmer_id": link.swimmer_id, "swimmer_name": link.swimmer.name if link.swimmer else None,
            "lanewatch_swimmer_id": link.lanewatch_swimmer_id,
            "lanewatch_name": (row or {}).get("name") or link.lanewatch_name,
            "on_roster": row is not None, "shares": bool(row and shares(row)),
        })

    suggestions = []
    for swimmer in swimmers:
        if swimmer.id in linked_local:
            continue
        for row in lw_rows:
            rid = str(row["id"])
            if rid in linked_remote or _norm(row.get("name")) != _norm(swimmer.name):
                continue
            here, there = _dob(swimmer.dob), _dob(row.get("date_of_birth"))
            if here and there and here != there:
                continue
            suggestions.append({
                "swimmer_id": swimmer.id, "swimmer_name": swimmer.name,
                "lanewatch_swimmer_id": rid, "lanewatch_name": row.get("name"),
                "confidence": "name and date of birth" if here and there else "name only",
                "shares": bool(shares(row)),
            })
            break

    suggested_remote = {s["lanewatch_swimmer_id"] for s in suggestions}
    unmatched = [
        {"lanewatch_swimmer_id": str(r["id"]), "lanewatch_name": r.get("name"),
         "date_of_birth": _dob(r.get("date_of_birth")), "shares": bool(shares(r))}
        for r in lw_rows if str(r["id"]) not in linked_remote and str(r["id"]) not in suggested_remote
    ]
    return {"links": current, "suggestions": suggestions, "unmatched": unmatched}


def save_links(db: DBSession, pairs: list) -> int:
    """Pair swimmers the coach confirmed. Only swimmers actually on the coach's
    LaneWatch roster can be paired - an id from anywhere else is refused."""
    by_id = {str(r["id"]): r for r in roster(db)}
    saved = 0
    for pair in pairs:
        swimmer_id = pair.get("swimmer_id")
        remote = str(pair.get("lanewatch_swimmer_id") or "")
        if remote not in by_id:
            raise LaneWatchError("That swimmer is not on your LaneWatch roster.")
        swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
        if not swimmer:
            raise LaneWatchError("Swimmer not found.")
        db.query(models.LaneWatchSwimmerLink).filter(
            (models.LaneWatchSwimmerLink.swimmer_id == swimmer.id)
            | (models.LaneWatchSwimmerLink.lanewatch_swimmer_id == remote)
        ).delete(synchronize_session=False)
        db.add(models.LaneWatchSwimmerLink(swimmer_id=swimmer.id, lanewatch_swimmer_id=remote,
                                           lanewatch_name=by_id[remote].get("name")))
        saved += 1
    db.commit()
    return saved


def unlink(db: DBSession, swimmer_id: int) -> bool:
    count = db.query(models.LaneWatchSwimmerLink).filter(
        models.LaneWatchSwimmerLink.swimmer_id == swimmer_id).delete()
    db.commit()
    return bool(count)


# ---------------------------------------------------------------------------
# What the analyst reads
# ---------------------------------------------------------------------------

# (key in LaneWatch's summary, label, unit). Direction and meaning follow
# skill_metrics.dart in the LaneWatch app.
METRICS = [
    ("reaction_time", "reaction", "s"),
    ("time_15m", "15m", "s"),
    ("uw_speed_start", "underwater off the dive", "m/s"),
    ("uw_speed_turns", "underwater off the walls", "m/s"),
    ("swim_speed", "free-swim speed", "m/s"),
    ("breakout_dist_start", "breakout off the dive", "m"),
    ("breakout_dist_turns", "breakout off the walls", "m"),
    ("kick_count", "fly kicks per wall", ""),
    ("uw_time_pct", "race underwater", "%"),
    ("stroke_rate", "stroke rate", "spm"),
    ("rate_drop", "back-half stroke rate change", "%"),
    ("half_drop", "back half slower than front half by", "%"),
]


def _pool_length(course: Optional[str]) -> int:
    return 50 if (course or "").upper().startswith("L") else 25


def absolute_splits(details: dict, pool_length: int) -> dict:
    """{race distance: cumulative seconds}, from any of LaneWatch's three
    stored conventions. A port of RaceMetrics.absoluteSplits."""
    lengths = [l for l in (details or {}).get("lengths") or [] if isinstance(l, dict)]
    union, conflict = {}, False
    for length in lengths:
        for k, v in (length.get("distanceTimes") or {}).items():
            try:
                dist, sec = float(k), float(v)
            except (TypeError, ValueError):
                continue
            if dist <= 0 or sec <= 0:
                continue
            if dist in union and abs(union[dist] - sec) > 0.001:
                conflict = True
            else:
                union[dist] = sec
    if not conflict and union:
        keys = sorted(union)
        if all(union[keys[i]] > union[keys[i - 1]] for i in range(1, len(keys))):
            return union
    relative = {}
    for length in lengths:
        base = int(length.get("lengthIndex") or 0) * pool_length
        for k, v in (length.get("distanceTimes") or {}).items():
            try:
                key, sec = float(k), float(v)
            except (TypeError, ValueError):
                continue
            if key <= 0 or sec <= 0:
                continue
            relative[base + key if key <= pool_length else key] = sec
    return relative


def lap_splits(details: dict, pool_length: int) -> list:
    """Split times per 50 (or per 25 when there are no 50s), in race order."""
    points = sorted(absolute_splits(details, pool_length).items())
    clean = []
    for dist, sec in points:
        if not clean or sec > clean[-1][1]:
            clean.append((dist, sec))
    has50 = any(d % 50 == 0 for d, _ in clean)
    size = 25 if (not has50 and any(d % 25 == 0 for d, _ in clean)) else 50
    laps, previous = [], 0.0
    for dist, sec in clean:
        if dist % size == 0:
            laps.append(round(sec - previous, 2))
            previous = sec
    return laps


def length_rates(details: dict) -> list:
    """Average stroke rate (spm) for each length. Values above 10 are already
    spm; smaller ones are cycle times in seconds."""
    rates = []
    for length in sorted((l for l in (details or {}).get("lengths") or [] if isinstance(l, dict)),
                         key=lambda l: l.get("lengthIndex") or 0):
        spms = []
        for raw in length.get("strokeRates") or []:
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            if value > 10:
                spms.append(value)
            elif value > 0:
                spms.append(60 / value)
        if spms:
            rates.append(round(sum(spms) / len(spms), 1))
    return rates


def _fmt(value, unit: str) -> str:
    if unit in ("s", "m/s", "m"):
        text = f"{value:.2f}"
    elif unit == "%":
        text = f"{value:+.1f}"
    else:
        text = f"{value:.0f}" if float(value).is_integer() else f"{value:.1f}"
    return text + (unit if unit in ("s", "%") else f" {unit}" if unit else "")


def race_line(log: dict) -> str:
    metrics = log.get("metrics_json") or {}
    details = log.get("details_json") or {}
    head = f"{str(log.get('date') or '')[:10]} {log.get('event') or ''} {log.get('course') or ''}".strip()
    extras = [x for x in (log.get("round"), log.get("meet")) if x]
    if extras:
        head += f" ({', '.join(extras)})"
    if log.get("time"):
        head += f" {float(log['time']):.2f}s"
    parts = [head]
    shown = [f"{label} {_fmt(metrics[key], unit)}" for key, label, unit in METRICS
             if isinstance(metrics.get(key), (int, float))]
    if shown:
        parts.append(", ".join(shown))
    pool = _pool_length(log.get("course"))
    laps = lap_splits(details, pool)
    if len(laps) >= 2:
        parts.append("splits " + ", ".join(f"{s:.2f}" for s in laps))
    rates = length_rates(details)
    if len(rates) >= 2:
        parts.append("stroke rate by length " + ", ".join(f"{r:.0f}" for r in rates))
    return " | ".join(parts)


def _mean(values: list) -> Optional[float]:
    values = [v for v in values if isinstance(v, (int, float))]
    return sum(values) / len(values) if values else None


def race_findings(logs: list) -> list:
    """Patterns across races, worked out here so the model reports them rather
    than guessing at them. Conservative: two races at least, and clear margins."""
    findings = []
    measured = [l for l in logs if l.get("metrics_json")]
    long_races = [l for l in measured if (l.get("distance") or 0) >= 100]
    halves = [l["metrics_json"].get("half_drop") for l in long_races]
    avg_half = _mean(halves)
    if avg_half is not None and len([h for h in halves if h is not None]) >= 2:
        if avg_half >= 8:
            findings.append(f"fades: the back half averages {avg_half:.1f}% slower than the front "
                            f"across {len(long_races)} races of 100 or more")
        elif avg_half <= 0:
            findings.append(f"finishes strongly: the back half averages {abs(avg_half):.1f}% "
                            "faster or level with the front")
    drops = [l["metrics_json"].get("rate_drop") for l in long_races]
    avg_drop = _mean(drops)
    if avg_drop is not None and len([d for d in drops if d is not None]) >= 2 and avg_drop <= -8:
        findings.append(f"stroke rate falls away late: {avg_drop:.1f}% in the back half on average")
    slower_under = [l for l in measured
                    if isinstance(l["metrics_json"].get("uw_speed_turns"), (int, float))
                    and isinstance(l["metrics_json"].get("swim_speed"), (int, float))
                    and l["metrics_json"]["uw_speed_turns"] < l["metrics_json"]["swim_speed"]]
    if len(slower_under) >= 2:
        findings.append(f"underwater off the walls is slower than their swimming in {len(slower_under)} "
                        f"of {len(measured)} analysed races - staying under is costing time")
    return findings


def analyst_lines(db: DBSession, swimmer, limit: int = 8) -> str:
    """One swimmer's analysed races for the performance analyst, or why not."""
    link = db.query(models.LaneWatchSwimmerLink).filter(
        models.LaneWatchSwimmerLink.swimmer_id == swimmer.id).first()
    if not link:
        return ""
    if not get_connection(db):
        return f"LANEWATCH RACE ANALYSIS for {swimmer.name}: LaneWatch is not connected."
    try:
        result = swim_logs(db, link.lanewatch_swimmer_id)
    except LaneWatchError as exc:
        return f"LANEWATCH RACE ANALYSIS for {swimmer.name}: unavailable ({exc})."
    if result["note"]:
        return f"LANEWATCH RACE ANALYSIS for {swimmer.name}: none readable ({result['note']})."
    logs = sorted(result["logs"], key=lambda l: str(l.get("date") or ""), reverse=True)
    analysed = [l for l in logs if l.get("metrics_json") or (l.get("details_json") or {}).get("lengths")]
    if not analysed:
        return (f"LANEWATCH RACE ANALYSIS for {swimmer.name}: {len(logs)} swims shared, "
                "none with race analysis captured.")
    lines = [f"LANEWATCH RACE ANALYSIS for {swimmer.name} ({len(analysed)} analysed races, newest first):"]
    lines += [f"  {race_line(l)}" for l in analysed[:limit]]
    findings = race_findings(analysed)
    lines.append("  PATTERNS: " + ("; ".join(findings) if findings else "none clear yet"))
    return "\n".join(lines)
