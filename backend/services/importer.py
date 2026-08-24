"""
Handles ingestion of swimrankings CSVs and bulk .xlsx session files.
"""
import re
import io
from datetime import datetime, date, time as dt_time, timedelta
from typing import Optional
import pandas as pd
from rapidfuzz import process as fuzzy_process
from sqlalchemy.orm import Session as DBSession

from backend import models


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

def parse_time_to_seconds(time_value) -> Optional[float]:
    """Convert Excel times, HH:MM:SS, MM:SS.ss or SS.ss to seconds."""
    if time_value is None or pd.isna(time_value):
        return None
    if isinstance(time_value, dt_time):
        return (
            time_value.hour * 3600
            + time_value.minute * 60
            + time_value.second
            + time_value.microsecond / 1_000_000
        )
    if isinstance(time_value, (timedelta, pd.Timedelta)):
        return float(time_value.total_seconds())
    if isinstance(time_value, (int, float)):
        numeric = float(time_value)
        return numeric * 86400 if 0 < numeric < 1 else numeric

    time_str = str(time_value).strip()
    if ":" in time_str:
        parts = time_str.split(":")
        try:
            if len(parts) == 3:
                return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
            if len(parts) == 2:
                return float(parts[0]) * 60 + float(parts[1])
            return None
        except ValueError:
            return None
    try:
        return float(time_str)
    except ValueError:
        return None


def parse_date_value(value) -> Optional[date]:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    parsed = (
        pd.to_datetime(text, format="%Y-%m-%d", errors="coerce")
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text)
        else pd.to_datetime(text, dayfirst=True, errors="coerce")
    )
    return None if pd.isna(parsed) else parsed.date()


def clean_swimrankings_id(value) -> Optional[str]:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip() or None


def clean_optional_text(value) -> Optional[str]:
    if value is None or pd.isna(value):
        return None
    text = str(value).strip()
    return text if text and text.lower() != "nan" else None


def infer_distance_from_time(time_seconds: float, stroke: str) -> Optional[int]:
    """
    Rough distance inference from time + stroke.
    Returns most likely distance in metres, or None.
    """
    if time_seconds is None:
        return None
    stroke_lower = (stroke or "").lower()
    # Very rough ranges for each distance/stroke combo
    ranges = {
        50: (20, 80),
        100: (45, 200),
        200: (100, 400),
        400: (230, 600),
        800: (480, 1100),
        1500: (900, 2200),
    }
    # Butterfly and backstroke are slightly slower at 200+
    for dist, (lo, hi) in ranges.items():
        if lo <= time_seconds <= hi:
            return dist
    return None


# ---------------------------------------------------------------------------
# Swimmer matching
# ---------------------------------------------------------------------------

def match_or_create_swimmer(
    name: str,
    swimrankings_id: Optional[str],
    dob: Optional[str],
    gender: Optional[str],
    db: DBSession,
    threshold: int = 85,
) -> models.Swimmer:
    """
    Return existing Swimmer or create a new one.
    Matching priority: swimrankings_id > exact name > fuzzy name.
    """
    # 1. Match by swimrankings ID
    if swimrankings_id:
        existing = db.query(models.Swimmer).filter(
            models.Swimmer.swimrankings_id == str(swimrankings_id)
        ).first()
        if existing:
            return existing

    # 2. Exact name match
    existing = db.query(models.Swimmer).filter(
        models.Swimmer.name == name
    ).first()
    if existing:
        return existing

    # 3. Fuzzy name match
    all_names = [s.name for s in db.query(models.Swimmer.name).all()]
    if all_names:
        result = fuzzy_process.extractOne(name, all_names)
        match, score = (result[0], result[1]) if result else (None, 0)
        if score >= threshold:
            existing = db.query(models.Swimmer).filter(
                models.Swimmer.name == match
            ).first()
            if existing:
                return existing

    # 4. Create new swimmer
    parsed_dob = None
    if dob and not pd.isna(dob):
        for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%m/%d/%Y"):
            try:
                parsed_dob = datetime.strptime(str(dob), fmt).date()
                break
            except ValueError:
                continue

    swimmer = models.Swimmer(
        name=name,
        swimrankings_id=str(swimrankings_id) if swimrankings_id and not pd.isna(swimrankings_id) else None,
        dob=parsed_dob,
        gender=str(gender)[0].upper() if gender and not pd.isna(gender) else None,
        active=True,
    )
    db.add(swimmer)
    db.flush()  # get ID without full commit
    return swimmer


# ---------------------------------------------------------------------------
# Swimrankings CSV import
# ---------------------------------------------------------------------------

def import_swimrankings_csv(
    file_content: bytes,
    event_name: str,
    db: DBSession,
) -> dict:
    """
    Parse a swimrankings CSV export and upsert times into the DB.

    Expected columns (subset used):
    Time, WA Pts, Round, Date, Meet, Venue, Club, Level,
    Name, ID, Stroke, Course, Split 1-8, Gender, Age, WA Points/Age, DoB
    """
    df = pd.read_csv(io.BytesIO(file_content))
    df.columns = [c.strip() for c in df.columns]

    results = {"imported": 0, "skipped": 0, "new_swimmers": 0, "errors": []}

    split_cols = [c for c in df.columns if re.match(r"Split \d+", c)]

    for _, row in df.iterrows():
        try:
            name = str(row.get("Name", "")).strip()
            if not name:
                continue

            swimmer = match_or_create_swimmer(
                name=name,
                swimrankings_id=row.get("ID"),
                dob=row.get("DoB"),
                gender=row.get("Gender"),
                db=db,
            )
            is_new = swimmer.id is None
            if is_new:
                results["new_swimmers"] += 1

            time_seconds = parse_time_to_seconds(row.get("Time"))
            if time_seconds is None:
                results["errors"].append(f"Could not parse time for {name}: {row.get('Time')}")
                continue

            stroke = str(row.get("Stroke", "")).strip()
            course = str(row.get("Course", "")).strip().upper()

            # Parse distance from event_name if it starts with a number, else infer from time
            distance = None
            if event_name:
                m = re.match(r'^(\d+)', event_name.strip())
                if m:
                    distance = int(m.group(1))
            if distance is None:
                distance = infer_distance_from_time(time_seconds, stroke)

            # Build canonical event string: always "{base} {course}"
            # Strip any existing course suffix from event_name to avoid duplication
            base = (event_name or f"{distance or '?'} {stroke}").strip()
            for suffix in ('SCM', 'LCM'):
                if base.upper().endswith(suffix):
                    base = base[:-len(suffix)].strip()
            constructed_event = f"{base} {course}".strip() if course else base

            # Parse date
            raw_date = row.get("Date")
            parsed_date = None
            if raw_date and not pd.isna(raw_date):
                for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
                    try:
                        parsed_date = datetime.strptime(str(raw_date), fmt).date()
                        break
                    except ValueError:
                        continue

            # Splits
            splits = []
            for sc in split_cols:
                val = row.get(sc)
                splits.append(parse_time_to_seconds(val) if val and not pd.isna(val) else None)

            # Dedup: same swimmer + event + date + time
            existing_time = db.query(models.SwimTime).filter(
                models.SwimTime.swimmer_id == swimmer.id,
                models.SwimTime.event == constructed_event,
                models.SwimTime.date == parsed_date,
                models.SwimTime.time_seconds == time_seconds,
            ).first()

            if existing_time:
                results["skipped"] += 1
                continue

            wa_pts = None
            raw_wa = row.get("WA Pts")
            if raw_wa and not pd.isna(raw_wa):
                try:
                    wa_pts = float(raw_wa)
                except ValueError:
                    pass

            wa_pts_age = None
            raw_wpa = row.get("WA Points/Age")
            if raw_wpa and not pd.isna(raw_wpa):
                try:
                    wa_pts_age = float(raw_wpa)
                except ValueError:
                    pass

            age_at_swim = None
            raw_age = row.get("Age")
            if raw_age and not pd.isna(raw_age):
                try:
                    age_at_swim = float(raw_age)
                except ValueError:
                    pass

            swim_time = models.SwimTime(
                swimmer_id=swimmer.id,
                event=constructed_event,
                stroke=stroke,
                course=course,
                distance=distance,
                time_seconds=time_seconds,
                wa_points=wa_pts,
                wa_points_age=wa_pts_age,
                date=parsed_date,
                meet=str(row.get("Meet", "")).strip() or None,
                venue=str(row.get("Venue", "")).strip() or None,
                level=str(row.get("Level", "")).strip() or None,
                round=str(row.get("Round", "")).strip() or None,
                splits=splits if any(s is not None for s in splits) else None,
                age_at_swim=age_at_swim,
                source="csv",
            )
            db.add(swim_time)
            results["imported"] += 1

        except Exception as e:
            results["errors"].append(f"Row error ({row.get('Name', '?')}): {str(e)}")

    db.commit()
    return results


# ---------------------------------------------------------------------------
# Combined squad + all-swims workbook
# ---------------------------------------------------------------------------

COMBINED_REQUIRED_COLUMNS = {
    "Time", "Date", "Name", "ID", "Stroke", "Course", "Gender", "DoB",
}


def import_combined_swims_xlsx(
    file_content: bytes,
    squad: str,
    db: DBSession,
    replace_existing: bool = True,
    reconcile_roster: bool = True,
    tracker_content: Optional[bytes] = None,
) -> dict:
    """
    Import one Swim England-style workbook containing the current roster and all swims.

    Each unique ID becomes/updates one swimmer. When replace_existing is true, existing
    race times for swimmers in the workbook are replaced so the workbook is the source
    of truth. Coaching profiles, observations and other swimmer data are preserved.
    """
    try:
        df = pd.read_excel(io.BytesIO(file_content), sheet_name=0)
    except Exception as exc:
        raise ValueError(f"Could not read workbook: {exc}") from exc

    df.columns = [str(c).strip() for c in df.columns]
    missing = sorted(COMBINED_REQUIRED_COLUMNS - set(df.columns))
    if missing:
        raise ValueError(f"Combined workbook is missing required columns: {', '.join(missing)}")
    if df.empty:
        raise ValueError("Combined workbook contains no swims")

    # Parse and validate all race rows before replacing anything in the database.
    parsed_rows = []
    errors = []
    split_cols = [c for c in df.columns if re.fullmatch(r"Split \d+", c)]
    for row_number, (_, row) in enumerate(df.iterrows(), start=2):
        external_id = clean_swimrankings_id(row.get("ID"))
        name = clean_optional_text(row.get("Name"))
        event_base = clean_optional_text(row.get("Stroke"))
        time_seconds = parse_time_to_seconds(row.get("Time"))
        swim_date = parse_date_value(row.get("Date"))
        raw_course = (clean_optional_text(row.get("Course")) or "").upper()
        course = {"S": "SCM", "SC": "SCM", "SCM": "SCM",
                  "L": "LCM", "LC": "LCM", "LCM": "LCM"}.get(raw_course)

        if not external_id or not name or not event_base or time_seconds is None or not swim_date or not course:
            errors.append(f"Row {row_number}: missing or invalid ID, name, event, time, date, or course")
            continue

        distance_match = re.match(r"^(\d+)\s+(.+)$", event_base)
        distance = int(distance_match.group(1)) if distance_match else infer_distance_from_time(time_seconds, event_base)
        stroke = distance_match.group(2).strip() if distance_match else event_base
        event = f"{event_base} {course}"
        splits = [parse_time_to_seconds(row.get(column)) for column in split_cols]

        def optional_float(column):
            value = row.get(column)
            if value is None or pd.isna(value):
                return None
            try:
                return float(value)
            except (TypeError, ValueError):
                return None

        parsed_rows.append({
            "external_id": external_id,
            "name": name,
            "dob": parse_date_value(row.get("DoB")),
            "gender": clean_optional_text(row.get("Gender")),
            "event": event,
            "stroke": stroke,
            "course": course,
            "distance": distance,
            "time_seconds": time_seconds,
            "wa_points": optional_float("WA Pts"),
            "wa_points_age": optional_float("WA Points/Age"),
            "date": swim_date,
            "meet": clean_optional_text(row.get("Meet")),
            "venue": clean_optional_text(row.get("Venue")),
            "level": clean_optional_text(row.get("Level")),
            "round": clean_optional_text(row.get("Round")),
            "splits": splits if any(value is not None for value in splits) else None,
            "age_at_swim": optional_float("Age"),
        })

    if not parsed_rows:
        raise ValueError("Combined workbook contains no valid swim rows")
    if len(errors) > max(20, int(len(df) * 0.05)):
        raise ValueError(f"Too many invalid rows ({len(errors)} of {len(df)}); no data was changed")

    tracker_by_external_id = {}
    if tracker_content:
        try:
            tracker_df = pd.read_csv(io.BytesIO(tracker_content))
        except Exception as exc:
            raise ValueError(f"Could not read tracker CSV: {exc}") from exc
        tracker_df.columns = [str(c).strip() for c in tracker_df.columns]
        tracker_required = {"ID", "Homeclub", "CS Start Date"}
        tracker_missing = sorted(tracker_required - set(tracker_df.columns))
        if tracker_missing:
            raise ValueError(f"Tracker CSV is missing required columns: {', '.join(tracker_missing)}")
        for _, tracker_row in tracker_df.iterrows():
            external_id = clean_swimrankings_id(tracker_row.get("ID"))
            if external_id:
                tracker_by_external_id[external_id] = {
                    "homeclub": clean_optional_text(tracker_row.get("Homeclub")),
                    "club_start": parse_date_value(tracker_row.get("CS Start Date")),
                }

    squad_label = squad.strip()
    initial_swimmer_ids = {row[0] for row in db.query(models.Swimmer.id).all()}
    reconciliation_candidates = []
    if reconcile_roster and squad_label:
        reconciliation_candidates = (
            db.query(models.Swimmer)
            .filter(models.Swimmer.squad == squad_label, models.Swimmer.active == True)
            .all()
        )
        # One-time migration from the old roster importer, which left squad blank.
        # Only claim unassigned swimmers when the entire active database is unassigned.
        if not reconciliation_candidates:
            active_swimmers = db.query(models.Swimmer).filter(models.Swimmer.active == True).all()
            if active_swimmers and all(not swimmer.squad for swimmer in active_swimmers):
                reconciliation_candidates = active_swimmers
    swimmer_by_external_id = {}
    member_rows = {}
    for row in parsed_rows:
        member_rows.setdefault(row["external_id"], row)

    for external_id, row in member_rows.items():
        swimmer = match_or_create_swimmer(
            name=row["name"],
            swimrankings_id=external_id,
            dob=row["dob"],
            gender=row["gender"],
            db=db,
        )
        # Identity and current squad fields in this workbook are authoritative.
        swimmer.name = row["name"]
        swimmer.swimrankings_id = external_id
        if row["dob"]:
            swimmer.dob = row["dob"]
        if row["gender"]:
            swimmer.gender = row["gender"][0].upper()
        if squad_label:
            swimmer.squad = squad_label
        swimmer.active = True
        if swimmer.status == "inactive":
            swimmer.status = "active"
        tracker = tracker_by_external_id.get(external_id)
        if tracker is not None:
            # Preserve free-form coaching notes while refreshing tracker metadata lines.
            note_lines = [
                line for line in (swimmer.profile_notes or "").splitlines()
                if not line.startswith("Home club swimmer:") and not line.startswith("Squad start:")
            ]
            is_homeclub = (tracker["homeclub"] or "").upper() in {"Y", "YES", "1", "TRUE"}
            note_lines.append(f"Home club swimmer: {'Yes' if is_homeclub else 'No'}")
            if tracker["club_start"]:
                note_lines.append(f"Squad start: {tracker['club_start'].isoformat()}")
            swimmer.profile_notes = "\n".join(line for line in note_lines if line.strip())
        db.flush()
        swimmer_by_external_id[external_id] = swimmer

    swimmer_ids = [swimmer.id for swimmer in swimmer_by_external_id.values()]
    imported_swimmer_ids = set(swimmer_ids)
    marked_inactive = 0
    for swimmer in reconciliation_candidates:
        if swimmer.id not in imported_swimmer_ids:
            swimmer.active = False
            swimmer.status = "inactive"
            if not swimmer.squad:
                swimmer.squad = squad_label
            marked_inactive += 1

    deleted_times = 0
    if replace_existing:
        deleted_times = (
            db.query(models.SwimTime)
            .filter(models.SwimTime.swimmer_id.in_(swimmer_ids))
            .delete(synchronize_session=False)
        )
        known_keys = set()
    else:
        known_keys = {
            (swimmer_id, event, swim_date, time_seconds)
            for swimmer_id, event, swim_date, time_seconds in (
                db.query(
                    models.SwimTime.swimmer_id,
                    models.SwimTime.event,
                    models.SwimTime.date,
                    models.SwimTime.time_seconds,
                )
                .filter(models.SwimTime.swimmer_id.in_(swimmer_ids))
                .all()
            )
        }

    imported = 0
    duplicate_rows = 0
    for row in parsed_rows:
        swimmer = swimmer_by_external_id[row["external_id"]]
        key = (swimmer.id, row["event"], row["date"], row["time_seconds"])
        if key in known_keys:
            duplicate_rows += 1
            continue
        known_keys.add(key)
        db.add(models.SwimTime(
            swimmer_id=swimmer.id,
            event=row["event"],
            stroke=row["stroke"],
            course=row["course"],
            distance=row["distance"],
            time_seconds=row["time_seconds"],
            wa_points=row["wa_points"],
            wa_points_age=row["wa_points_age"],
            date=row["date"],
            meet=row["meet"],
            venue=row["venue"],
            level=row["level"],
            round=row["round"],
            splits=row["splits"],
            age_at_swim=row["age_at_swim"],
            source="combined_xlsx",
        ))
        imported += 1

    db.commit()
    created = sum(swimmer.id not in initial_swimmer_ids for swimmer in swimmer_by_external_id.values())
    return {
        "members_in_file": len(swimmer_by_external_id),
        "swimmers_created": created,
        "swimmers_updated": len(swimmer_by_external_id) - created,
        "swimmers_marked_inactive": marked_inactive,
        "times_imported": imported,
        "times_replaced": deleted_times,
        "duplicate_rows_skipped": duplicate_rows,
        "invalid_rows_skipped": len(errors),
        "errors": errors[:20],
        "squad": squad_label or None,
        "tracker_members_matched": len(set(member_rows) & set(tracker_by_external_id)),
        "tracker_members_missing": len(set(member_rows) - set(tracker_by_external_id)) if tracker_content else 0,
    }


# ---------------------------------------------------------------------------
# Excel session import (single file)
# ---------------------------------------------------------------------------

def import_session_xlsx(
    file_content: bytes,
    filename: str,
    db: DBSession,
) -> dict:
    """
    Parse a single .xlsx session file.
    Tries to extract: date, title, group structure (1/2/3), set content.
    Returns the created Session id and any warnings.
    """
    result = {"session_id": None, "warnings": []}

    # Infer date from filename (e.g. "2024-03-15 Thursday AM.xlsx")
    inferred_date = None
    date_match = re.search(r"(\d{4}-\d{2}-\d{2}|\d{2}[\-/]\d{2}[\-/]\d{4})", filename)
    if date_match:
        for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
            try:
                inferred_date = datetime.strptime(date_match.group(1), fmt).date()
                break
            except ValueError:
                continue

    xl = pd.ExcelFile(io.BytesIO(file_content))
    sheet_name = xl.sheet_names[0]
    df = xl.parse(sheet_name, header=None)

    # Flatten all cell values into text lines for parsing
    lines = []
    for _, row in df.iterrows():
        row_text = " | ".join(
            str(v).strip() for v in row if v is not None and str(v).strip() not in ("", "nan")
        )
        if row_text:
            lines.append(row_text)

    raw_text = "\n".join(lines)

    # Try to pick up a title from first non-empty row
    title = lines[0][:120] if lines else filename.replace(".xlsx", "")

    # Try to detect date in sheet content if not in filename
    if not inferred_date:
        for line in lines[:5]:
            for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
                try:
                    inferred_date = datetime.strptime(line.strip(), fmt).date()
                    break
                except ValueError:
                    continue
            if inferred_date:
                break

    if not inferred_date:
        result["warnings"].append(f"Could not infer date from '{filename}' — session saved without date")

    # Group detection: look for "Group 1/2/3" or "Lane 1/2/3" markers
    groups_raw = {}
    current_group = None
    group_pattern = re.compile(r"group\s*(\d)", re.IGNORECASE)
    for line in lines:
        gm = group_pattern.search(line)
        if gm:
            current_group = int(gm.group(1))
            groups_raw[current_group] = []
        elif current_group is not None:
            groups_raw[current_group].append(line)

    if not groups_raw:
        # No explicit group markers — treat whole session as group 1
        groups_raw[1] = lines
        result["warnings"].append("No group markers found — all content assigned to Group 1")

    # Build session
    planned_content = {
        str(g): {"sets": "\n".join(content)} for g, content in groups_raw.items()
    }

    session = models.Session(
        date=inferred_date,
        title=title,
        planned_content=planned_content,
        source="excel",
        coach_notes=f"Imported from: {filename}",
    )
    db.add(session)
    db.flush()

    for group_num, content in groups_raw.items():
        sg = models.SessionGroup(
            session_id=session.id,
            group_number=group_num,
            description="\n".join(content[:5]),  # first 5 lines as description
            sets={"raw": "\n".join(content)},
        )
        db.add(sg)

    db.commit()
    result["session_id"] = session.id
    return result


# ---------------------------------------------------------------------------
# Bulk Excel session import
# ---------------------------------------------------------------------------

def bulk_import_sessions(
    files: list[tuple[str, bytes]],
    db: DBSession,
) -> dict:
    """
    Import multiple .xlsx session files.
    files: list of (filename, bytes) tuples
    """
    summary = {"sessions_created": 0, "errors": [], "warnings": [], "session_ids": []}

    for filename, content in files:
        try:
            result = import_session_xlsx(content, filename, db)
            if result["session_id"]:
                summary["sessions_created"] += 1
                summary["session_ids"].append(result["session_id"])
            summary["warnings"].extend([f"[{filename}] {w}" for w in result["warnings"]])
        except Exception as e:
            summary["errors"].append(f"[{filename}] {str(e)}")

    return summary
