"""LaneWatch: the detailed race analysis the coach has captured, read live.

LaneWatch holds what a results sheet cannot: reaction time, the 15m time,
underwater speed off the dive and off each wall, breakouts, stroke rate length
by length, and how much the back half falls away. The performance analyst
needs exactly that.

How the link works, and why:

  * "Connect with LaneWatch" (OAuth 2.0 authorisation code + PKCE): the
    coach is sent to hub.lanewatch.app/connect, signs in THERE and approves,
    and comes back with a one-time code that this server swaps for a
    read-only key. No LaneWatch sign-in ever passes through this app.
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
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.orm import Session as DBSession

from backend import models

LANEWATCH_API_URL = os.getenv(
    "LANEWATCH_API_URL", "https://lanewatch-api-vbne6vd2pa-nw.a.run.app/api/v1").rstrip("/")
APP_NAME = "Coaching Assistant"
# Where the coach approves the connection, and who this app is to LaneWatch
# (registered there in connected_app_clients with its return addresses).
CONNECT_URL = os.getenv("LANEWATCH_CONNECT_URL", "https://hub.lanewatch.app/connect")
CLIENT_ID = os.getenv("LANEWATCH_CLIENT_ID", "coaching-assistant")
ATTEMPT_MINUTES = 15
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

def _request(method: str, path: str, token: Optional[str], body: Optional[dict] = None):
    try:
        response = httpx.request(method, LANEWATCH_API_URL + path, json=body, timeout=TIMEOUT_SECONDS,
                                 headers={"Authorization": f"Bearer {token}"} if token else {})
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


def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def start_connect(db: DBSession, redirect_uri: str) -> str:
    """Begin "Connect with LaneWatch": the address to send the coach to."""
    if not re.fullmatch(r"(https://[^\s/]+|http://(localhost|127\.0\.0\.1)(:\d+)?)/lanewatch/callback",
                        redirect_uri or ""):
        raise LaneWatchError("This app's address can't be used to connect LaneWatch.")
    stale = datetime.now(timezone.utc) - timedelta(minutes=ATTEMPT_MINUTES)
    db.query(models.LaneWatchConnectAttempt).filter(
        models.LaneWatchConnectAttempt.created_at < stale).delete(synchronize_session=False)
    attempt = models.LaneWatchConnectAttempt(
        state=secrets.token_urlsafe(24), code_verifier=secrets.token_urlsafe(48), redirect_uri=redirect_uri,
        created_at=datetime.now(timezone.utc),
    )
    db.add(attempt)
    db.commit()
    return CONNECT_URL + "?" + urlencode({
        "client_id": CLIENT_ID,
        "redirect_uri": redirect_uri,
        "state": attempt.state,
        "code_challenge": _pkce_challenge(attempt.code_verifier),
        "code_challenge_method": "S256",
    })


def finish_connect(db: DBSession, state: str, code: str) -> models.LaneWatchConnection:
    """LaneWatch sent the coach back with a one-time code: swap it, with the
    verifier only this server holds, for a read-only key."""
    attempt = db.query(models.LaneWatchConnectAttempt).filter(
        models.LaneWatchConnectAttempt.state == (state or "")).first()
    created = attempt.created_at if attempt else None
    if created is not None and created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    if (not attempt or attempt.used_at is not None
            or created < datetime.now(timezone.utc) - timedelta(minutes=ATTEMPT_MINUTES)):
        raise LaneWatchError("This connection link has expired or was already used. Start connecting again.")
    attempt.used_at = datetime.now(timezone.utc)
    db.commit()
    code = (code or "").strip()
    if not code or len(code) > 200:
        raise LaneWatchError("LaneWatch didn't send a connection code. Start connecting again.")
    issued = _request("POST", "/connected-apps/token", None, {
        "grant_type": "authorization_code",
        "code": code,
        "client_id": CLIENT_ID,
        "redirect_uri": attempt.redirect_uri,
        "code_verifier": attempt.code_verifier,
    })
    return _save_key(db, str(issued.get("access_token") or ""))


def _save_key(db: DBSession, key: str) -> models.LaneWatchConnection:
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
# Pairing LaneWatch races with the swims in the times history
# ---------------------------------------------------------------------------
#
# Most races analysed in LaneWatch are also official results here. Pairing
# them lets the official time and splits sit next to LaneWatch's analysis.
# Only the LaneWatch race's id is kept on the swim; the race is still read
# live, so a swimmer who stops sharing stops being readable.
#
# A race is the same swim when it is the same swimmer (through the confirmed
# swimmer pairing), event and course, within a day (a pasted gala gives every
# swim the gala's first day), and close in time. Coaches may keep the official
# time in LaneWatch or their own from the video, so a time up to a second out
# still pairs; the closest wins, the round settles a heat against a final, and
# when two swims are too close to call the coach chooses.

PAIR_SECONDS = 1.0       # how far a LaneWatch time may be from the official one
CLEAR_MARGIN = 0.3       # how much closer the best swim must be than the next
PAIRED = ("auto", "coach")


def _lw_course(value) -> Optional[str]:
    text = str(value or "").strip().upper()
    if text.endswith("Y"):
        return "SCY"     # yards: never the same swim as a metric result
    if text.startswith("L") or text == "50M":
        return "LCM"
    if text.startswith("S") or text == "25M":
        return "SCM"
    return None


def _round_code(value) -> Optional[str]:
    text = str(value or "").strip().upper()
    if not text:
        return None
    if text[0] in ("H", "P"):              # heat, prelim
        return "H"
    if text[0] == "F" or text in ("A", "B", "C"):
        return "F"
    if text.startswith("SEMI") or text == "S":
        return "S"
    if text[0] == "R":
        return "R"
    return None


def _log_date(value):
    try:
        return datetime.strptime(str(value or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _swim_course(swim: dict) -> Optional[str]:
    course = (swim.get("course") or "").upper()
    if course in ("SCM", "LCM"):
        return course
    event = (swim.get("event") or "").upper()
    return "LCM" if "LCM" in event else "SCM" if "SCM" in event else None


def match_races(logs: list, swims: list) -> dict:
    """
    Pair one swimmer's LaneWatch races with their swims here. Pure: no I/O.

    logs: LaneWatch races ({id, event, course, date, round, time}).
    swims: {id, event, course, date, round, time_seconds, lanewatch_log_id,
            lanewatch_paired_by}.
    Returns {"pairs": [(swim_id, log_id)], "choices": [{"log", "options"}],
             "unmatched": [log]} - unmatched races have no swim here (yet).
    """
    from backend.services.event_normalizer import canonicalize_event

    taken_logs = {s["lanewatch_log_id"] for s in swims if s.get("lanewatch_paired_by") in PAIRED}
    taken_swims = {s["id"] for s in swims if s.get("lanewatch_paired_by") in PAIRED}
    rejected = {(s["id"], s["lanewatch_log_id"]) for s in swims if s.get("lanewatch_paired_by") == "unpaired"}
    for swim in swims:
        swim["_event"] = canonicalize_event(swim.get("event") or "")
        swim["_course"] = _swim_course(swim)
        swim["_round"] = _round_code(swim.get("round"))

    proposals = []
    unmatched = []
    for log in logs:
        log_id = str(log.get("id") or "")
        if not log_id or log_id in taken_logs:
            continue
        course, day, seconds = _lw_course(log.get("course")), _log_date(log.get("date")), log.get("time")
        round_code = _round_code(log.get("round"))
        if round_code == "R" or course == "SCY" or not day or not isinstance(seconds, (int, float)) or seconds <= 0:
            continue
        event = canonicalize_event(log.get("event") or "")
        candidates = []
        for swim in swims:
            if swim["id"] in taken_swims or (swim["id"], log_id) in rejected:
                continue
            if swim["_event"] != event or not swim.get("date") or not swim.get("time_seconds"):
                continue
            if course and swim["_course"] and course != swim["_course"]:
                continue
            if abs((swim["date"] - day).days) > 1:
                continue
            gap = abs(float(swim["time_seconds"]) - float(seconds))
            if gap <= PAIR_SECONDS:
                candidates.append((round(gap, 2), swim))
        if round_code and any(s["_round"] == round_code for _, s in candidates):
            candidates = [(g, s) for g, s in candidates if s["_round"] in (round_code, None)]
        candidates.sort(key=lambda pair: pair[0])
        if candidates:
            proposals.append((log, candidates))
        else:
            unmatched.append(log)

    # Closest pairs first, so one swim never goes to two races.
    proposals.sort(key=lambda proposal: proposal[1][0][0])
    pairs, choices, claimed = [], [], set()
    for log, candidates in proposals:
        candidates = [(g, s) for g, s in candidates if s["id"] not in claimed]
        if not candidates:
            unmatched.append(log)
            continue
        best_gap, best = candidates[0]
        runner_up = candidates[1][0] if len(candidates) > 1 else None
        if runner_up is None or best_gap == 0 < runner_up or runner_up - best_gap >= CLEAR_MARGIN:
            pairs.append((best["id"], str(log["id"])))
            claimed.add(best["id"])
        else:
            choices.append({"log": log, "options": [s["id"] for _, s in candidates]})
    return {"pairs": pairs, "choices": choices, "unmatched": unmatched}


def _swim_summary(swim: models.SwimTime) -> dict:
    return {
        "swim_time_id": swim.id, "event": swim.event, "date": swim.date.isoformat() if swim.date else None,
        "time_seconds": swim.time_seconds, "round": swim.round, "meet": swim.meet,
    }


def _race_summary(log: dict) -> dict:
    return {
        "lanewatch_log_id": str(log.get("id")), "event": log.get("event"), "course": log.get("course"),
        "date": str(log.get("date") or "")[:10] or None, "time_seconds": log.get("time"),
        "round": log.get("round"), "meet": log.get("meet"),
    }


def pair_races(db: DBSession, swimmer_ids: Optional[list] = None) -> dict:
    """Pair every paired swimmer's LaneWatch races with their swims here."""
    if not get_connection(db):
        return {"connected": False, "paired": 0, "already_paired": 0, "choices": [], "unmatched": 0,
                "unmatched_races": [], "unreadable": []}
    links = db.query(models.LaneWatchSwimmerLink)
    if swimmer_ids is not None:
        links = links.filter(models.LaneWatchSwimmerLink.swimmer_id.in_(list(swimmer_ids)))
    paired = already = 0
    choices, unmatched_races, unreadable = [], [], []
    for link in links.all():
        name = link.swimmer.name if link.swimmer else link.lanewatch_name
        try:
            result = swim_logs(db, link.lanewatch_swimmer_id)
        except LaneWatchError as exc:
            if exc.status == 401:
                raise
            unreadable.append({"swimmer": name, "reason": str(exc)})
            continue
        if result["note"]:
            unreadable.append({"swimmer": name, "reason": result["note"]})
            continue
        rows = db.query(models.SwimTime).filter(models.SwimTime.swimmer_id == link.swimmer_id).all()
        by_id = {row.id: row for row in rows}
        swims = [{
            "id": row.id, "event": row.event, "course": row.course, "date": row.date, "round": row.round,
            "time_seconds": row.time_seconds, "lanewatch_log_id": row.lanewatch_log_id,
            "lanewatch_paired_by": row.lanewatch_paired_by,
        } for row in rows]
        already += sum(1 for s in swims if s["lanewatch_paired_by"] in PAIRED)
        found = match_races(result["logs"], swims)
        for swim_id, log_id in found["pairs"]:
            by_id[swim_id].lanewatch_log_id = log_id
            by_id[swim_id].lanewatch_paired_by = "auto"
            paired += 1
        for choice in found["choices"]:
            choices.append({
                "swimmer_id": link.swimmer_id, "swimmer": name, "race": _race_summary(choice["log"]),
                "options": [_swim_summary(by_id[swim_id]) for swim_id in choice["options"]],
            })
        unmatched_races += [{"swimmer": name, **_race_summary(log)} for log in found["unmatched"]]
    db.commit()
    unmatched_races.sort(key=lambda race: race["date"] or "", reverse=True)
    return {
        "connected": True, "paired": paired, "already_paired": already, "choices": choices,
        "unmatched": len(unmatched_races), "unmatched_races": unmatched_races[:30], "unreadable": unreadable,
    }


def choose_race(db: DBSession, swim_time_id: int, lanewatch_log_id: str) -> None:
    """The coach says which swim a LaneWatch race is."""
    swim = db.query(models.SwimTime).filter(models.SwimTime.id == swim_time_id).first()
    if not swim:
        raise LaneWatchError("That swim isn't in the app.", status=404)
    link = db.query(models.LaneWatchSwimmerLink).filter(
        models.LaneWatchSwimmerLink.swimmer_id == swim.swimmer_id).first()
    if not link:
        raise LaneWatchError("This swimmer isn't paired with a LaneWatch swimmer yet.", status=400)
    logs = swim_logs(db, link.lanewatch_swimmer_id)["logs"]
    if not any(str(log.get("id")) == str(lanewatch_log_id) for log in logs):
        raise LaneWatchError("That LaneWatch race isn't one of this swimmer's shared races.", status=400)
    # A race is one swim: take it off any other swim it was on.
    for other in db.query(models.SwimTime).filter(
            models.SwimTime.swimmer_id == swim.swimmer_id,
            models.SwimTime.lanewatch_log_id == str(lanewatch_log_id),
            models.SwimTime.lanewatch_paired_by.in_(PAIRED),
            models.SwimTime.id != swim.id).all():
        other.lanewatch_log_id, other.lanewatch_paired_by = None, None
    swim.lanewatch_log_id, swim.lanewatch_paired_by = str(lanewatch_log_id), "coach"
    db.commit()


def unpair_race(db: DBSession, swim_time_id: int) -> None:
    """The coach says this swim is not that race; it is never suggested again."""
    swim = db.query(models.SwimTime).filter(models.SwimTime.id == swim_time_id).first()
    if not swim:
        raise LaneWatchError("That swim isn't in the app.", status=404)
    if swim.lanewatch_paired_by in PAIRED:
        swim.lanewatch_paired_by = "unpaired"
        db.commit()


def pair_races_quietly(swimmer_ids: Optional[list] = None) -> None:
    """After an import: pair what can be paired, never failing the import."""
    from backend.database import SessionLocal
    try:
        with SessionLocal() as db:
            if get_connection(db) and db.query(models.LaneWatchSwimmerLink).count():
                pair_races(db, swimmer_ids)
    except Exception:  # noqa: BLE001 - background work; the coach can run it from Settings
        pass


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


def official_line(swim) -> str:
    """The official result a LaneWatch race is paired with, for the analyst."""
    if swim is None:
        return ""
    where = ", ".join(x for x in (swim.meet, swim.round) if x)
    text = f" | OFFICIAL RESULT {swim.time_seconds:.2f}s" + (f" ({where})" if where else "")
    splits = [s for s in (swim.splits or []) if isinstance(s, (int, float))]
    if len(splits) >= 2:
        text += ", official splits " + ", ".join(f"{s:.2f}" for s in splits)
    return text


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
    # The official result each race is paired with, side by side.
    official = {
        row.lanewatch_log_id: row
        for row in db.query(models.SwimTime).filter(
            models.SwimTime.swimmer_id == swimmer.id,
            models.SwimTime.lanewatch_paired_by.in_(PAIRED),
        ).all()
    }
    lines = [f"LANEWATCH RACE ANALYSIS for {swimmer.name} ({len(analysed)} analysed races, newest first):"]
    lines += [f"  {race_line(l)}{official_line(official.get(str(l.get('id'))))}" for l in analysed[:limit]]
    findings = race_findings(analysed)
    lines.append("  PATTERNS: " + ("; ".join(findings) if findings else "none clear yet"))
    return "\n".join(lines)
