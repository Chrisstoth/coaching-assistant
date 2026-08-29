"""Session coordinates within the macro/meso/micro planning hierarchy."""

from __future__ import annotations

from datetime import date
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models


def _normalise_rows(rows: list, attr: str = "sequence_index") -> bool:
    """Give rows unique positive sequence values while preserving valid ones."""
    changed = False
    used: set[int] = set()
    next_value = 1
    for row in rows:
        value = getattr(row, attr, None)
        if isinstance(value, int) and value > 0 and value not in used:
            used.add(value)
            continue
        while next_value in used:
            next_value += 1
        setattr(row, attr, next_value)
        used.add(next_value)
        next_value += 1
        changed = True
    return changed


def ensure_cycle_sequences(db: DBSession) -> bool:
    """Backfill missing hierarchy positions without changing valid positions."""
    changed = False
    macros = db.query(models.TrainingMacro).order_by(
        models.TrainingMacro.date_from, models.TrainingMacro.id,
    ).all()
    macro_groups: dict[tuple, list] = {}
    for macro in macros:
        scope = (macro.season_id, macro.squad or "")
        macro_groups.setdefault(scope, []).append(macro)
    for rows in macro_groups.values():
        changed = _normalise_rows(rows) or changed

    for macro in macros:
        blocks = db.query(models.SeasonBlock).filter(
            models.SeasonBlock.macro_id == macro.id,
        ).order_by(models.SeasonBlock.date_from, models.SeasonBlock.id).all()
        changed = _normalise_rows(blocks) or changed
        for block in blocks:
            micros = db.query(models.Microcycle).filter(
                models.Microcycle.block_id == block.id,
            ).order_by(models.Microcycle.week_start, models.Microcycle.id).all()
            changed = _normalise_rows(micros) or changed
    return changed


def next_macro_sequence(db: DBSession, season_id: Optional[int], squad: Optional[str]) -> int:
    rows = db.query(models.TrainingMacro).filter(
        models.TrainingMacro.season_id == season_id,
        models.TrainingMacro.squad == squad,
    ).all()
    return max((row.sequence_index or 0 for row in rows), default=0) + 1


def next_block_sequence(db: DBSession, macro_id: Optional[int]) -> int:
    rows = db.query(models.SeasonBlock).filter(models.SeasonBlock.macro_id == macro_id).all()
    return max((row.sequence_index or 0 for row in rows), default=0) + 1


def next_micro_sequence(db: DBSession, block_id: Optional[int]) -> int:
    rows = db.query(models.Microcycle).filter(models.Microcycle.block_id == block_id).all()
    return max((row.sequence_index or 0 for row in rows), default=0) + 1


def code_for(micro: models.Microcycle, session_sequence: int) -> Optional[str]:
    block = micro.block
    macro = micro.macro or (block.macro if block else None)
    if not macro or not block:
        return None
    parts = (
        macro.sequence_index,
        block.sequence_index,
        micro.sequence_index,
        session_sequence,
    )
    if not all(isinstance(value, int) and value > 0 for value in parts):
        return None
    return ".".join(str(value) for value in parts)


def cycle_context(session: models.Session) -> Optional[dict]:
    micro = session.microcycle
    if not micro:
        return None
    block = micro.block
    macro = micro.macro or (block.macro if block else None)
    return {
        "code": session.cycle_code,
        "session_sequence": session.session_sequence,
        "microcycle_id": micro.id,
        "microcycle_sequence": micro.sequence_index,
        "microcycle_label": micro.label,
        "week_start": micro.week_start.isoformat(),
        "week_end": micro.week_end.isoformat(),
        "mesocycle_id": block.id if block else None,
        "mesocycle_sequence": block.sequence_index if block else None,
        "mesocycle_name": block.name if block else None,
        "phase_type": block.phase_type if block else None,
        "macrocycle_id": macro.id if macro else None,
        "macrocycle_sequence": macro.sequence_index if macro else None,
        "macrocycle_name": macro.name if macro else None,
        "season_id": macro.season_id if macro else None,
    }


def find_microcycle(
    db: DBSession,
    session_date: date,
    squad: Optional[str] = None,
) -> Optional[models.Microcycle]:
    candidates = db.query(models.Microcycle).filter(
        models.Microcycle.week_start <= session_date,
        models.Microcycle.week_end >= session_date,
    ).order_by(models.Microcycle.week_start, models.Microcycle.id).all()
    if not candidates:
        return None
    if squad:
        exact = [row for row in candidates if row.squad == squad]
        if len(exact) == 1:
            return exact[0]
        if len(exact) > 1:
            return None
    compatible = [row for row in candidates if not row.squad or not squad]
    return compatible[0] if len(compatible) == 1 else None


def _planned_sequence(micro: models.Microcycle, session: models.Session) -> Optional[int]:
    matches = []
    for index, item in enumerate(micro.sessions or [], 1):
        if not isinstance(item, dict) or str(item.get("date") or "") != session.date.isoformat():
            continue
        slot_text = str(item.get("slot_label") or "").lower()
        if session.start_time and session.start_time in slot_text:
            return index
        matches.append(index)
    return matches[0] if len(matches) == 1 else None


def link_session(
    session: models.Session,
    db: DBSession,
    *,
    microcycle: Optional[models.Microcycle] = None,
    session_sequence: Optional[int] = None,
    ensure_sequences: bool = True,
) -> bool:
    """Link one session when its weekly plan can be identified unambiguously."""
    if not session.date:
        return False
    if ensure_sequences:
        ensure_cycle_sequences(db)
    micro = microcycle or session.microcycle or find_microcycle(db, session.date, session.squad)
    if not micro:
        return False

    if session_sequence is None:
        session_sequence = session.session_sequence or _planned_sequence(micro, session)
    if session_sequence is None:
        used = [value for (value,) in db.query(models.Session.session_sequence).filter(
            models.Session.microcycle_id == micro.id,
            models.Session.session_sequence.isnot(None),
        ).all()]
        session_sequence = max(used, default=0) + 1

    session.microcycle = micro
    session.session_sequence = int(session_sequence)
    session.cycle_code = code_for(micro, session.session_sequence)
    return bool(session.cycle_code)


def _match_pool_slot(db: DBSession, micro: models.Microcycle, item: dict, item_date: date):
    candidates = db.query(models.PoolSlot).filter(
        models.PoolSlot.day_of_week == item_date.weekday(),
        models.PoolSlot.active.is_(True),
    ).order_by(models.PoolSlot.time).all()
    if micro.squad:
        squad_rows = [row for row in candidates if row.squad == micro.squad]
        if squad_rows:
            candidates = squad_rows
    label = str(item.get("slot_label") or "").strip().lower()
    exact = [row for row in candidates if (
        label and (label == (row.label or "").strip().lower() or row.time in label)
    )]
    if len(exact) == 1:
        return exact[0]
    return candidates[0] if len(candidates) == 1 else None


def materialize_microcycle(micro: models.Microcycle, db: DBSession) -> list[models.Session]:
    """Create/link concrete Session rows for a confirmed weekly plan."""
    ensure_cycle_sequences(db)
    materialized: list[models.Session] = []
    enriched: list = []

    for index, raw_item in enumerate(micro.sessions or [], 1):
        if not isinstance(raw_item, dict):
            enriched.append(raw_item)
            continue
        item = dict(raw_item)
        try:
            item_date = date.fromisoformat(str(item.get("date")))
        except (TypeError, ValueError):
            enriched.append(item)
            continue
        if item_date < micro.week_start or item_date > micro.week_end:
            enriched.append(item)
            continue

        pool_slot = _match_pool_slot(db, micro, item, item_date)
        session = db.query(models.Session).filter(
            models.Session.microcycle_id == micro.id,
            models.Session.session_sequence == index,
        ).first()
        if not session and pool_slot:
            session = db.query(models.Session).filter(
                models.Session.date == item_date,
                models.Session.pool_slot_id == pool_slot.id,
            ).first()
        if not session and not pool_slot:
            unlinked = db.query(models.Session).filter(
                models.Session.date == item_date,
                models.Session.microcycle_id.is_(None),
            ).all()
            if micro.squad:
                unlinked = [row for row in unlinked if row.squad == micro.squad]
            if len(unlinked) == 1:
                session = unlinked[0]

        if not session:
            emphasis = (item.get("key_emphasis") or "").strip()
            session_type = (item.get("session_type") or item.get("energy_focus") or "Session").strip()
            session = models.Session(
                date=item_date,
                start_time=pool_slot.time if pool_slot else None,
                end_time=pool_slot.end_time if pool_slot else None,
                squad=micro.squad or (pool_slot.squad if pool_slot else None),
                title=emphasis or session_type.replace("_", " ").title(),
                coach_intent=emphasis or None,
                energy_system_focus=item.get("energy_focus") or item.get("session_type"),
                pool_slot_id=pool_slot.id if pool_slot else None,
                course=pool_slot.course if pool_slot else None,
                status="planned" if item_date > date.today() else "active",
                source="microcycle",
            )
            db.add(session)
            db.flush()
        else:
            if not session.energy_system_focus:
                session.energy_system_focus = item.get("energy_focus") or item.get("session_type")
            if not session.coach_intent:
                session.coach_intent = item.get("key_emphasis") or None

        link_session(
            session, db, microcycle=micro, session_sequence=index,
            ensure_sequences=False,
        )
        item["session_id"] = session.id
        item["pool_slot_id"] = session.pool_slot_id
        item["cycle_code"] = session.cycle_code
        enriched.append(item)
        materialized.append(session)

    micro.sessions = enriched
    return materialized


def backfill_session_links(db: DBSession) -> int:
    """Link historical session rows only when one microcycle is unambiguous."""
    ensure_cycle_sequences(db)
    linked = 0
    sessions = db.query(models.Session).filter(models.Session.microcycle_id.is_(None)).order_by(
        models.Session.date, models.Session.start_time, models.Session.id,
    ).all()
    for session in sessions:
        if link_session(session, db, ensure_sequences=False):
            linked += 1
    return linked
