import json
from typing import Optional
from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException, Query
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models
from backend.services.importer import import_swimrankings_csv, import_combined_swims_xlsx
from backend.services.qualification_service import recalculate_standard_set

router = APIRouter()


def _refresh_confirmed_qualification_sets(db: DBSession) -> int:
    set_ids = [row.id for row in db.query(models.QualificationStandardSet).filter(
        models.QualificationStandardSet.status == "confirmed",
    ).all()]
    for set_id in set_ids:
        recalculate_standard_set(set_id, db)
    return len(set_ids)


@router.post("/import/combined")
async def import_combined_workbook(
    file: UploadFile = File(...),
    tracker_file: Optional[UploadFile] = File(None),
    squad: str = Form("Silver 1"),
    replace_existing: bool = Form(True),
    reconcile_roster: bool = Form(True),
    db: DBSession = Depends(get_db),
):
    """Import current squad members and all their race times from one .xlsx workbook."""
    if not file.filename or not file.filename.lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Combined import must be an .xlsx workbook")
    content = await file.read()
    tracker_content = await tracker_file.read() if tracker_file else None
    try:
        result = import_combined_swims_xlsx(
            content, squad, db,
            replace_existing=replace_existing,
            reconcile_roster=reconcile_roster,
            tracker_content=tracker_content,
        )
        result["qualification_sets_refreshed"] = _refresh_confirmed_qualification_sets(db)
        return result
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Combined import failed: {exc}") from exc


@router.post("/import/csv")
async def import_csv(
    file: UploadFile = File(...),
    event_name: str = Form(""),
    db: DBSession = Depends(get_db),
):
    if not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="File must be a .csv")
    content = await file.read()
    result = import_swimrankings_csv(content, event_name, db)
    result["qualification_sets_refreshed"] = _refresh_confirmed_qualification_sets(db)
    return result


@router.post("/import/csv/bulk")
async def import_csv_bulk(
    files: list[UploadFile] = File(...),
    event_names: str = Form("[]"),   # JSON array of strings, matching file order
    db: DBSession = Depends(get_db),
):
    """
    Import multiple swimrankings CSV files in one request.
    event_names: JSON array e.g. '["100 Freestyle", "200 Backstroke"]'
    If shorter than files list, remaining files get empty event name (inferred).
    """
    try:
        names = json.loads(event_names)
    except Exception:
        names = []

    summary = {"files": [], "total_imported": 0, "total_skipped": 0, "total_errors": 0}

    for i, file in enumerate(files):
        event_name = names[i] if i < len(names) else ""
        content = await file.read()
        try:
            result = import_swimrankings_csv(content, event_name, db)
            summary["files"].append({
                "filename": file.filename,
                "event": event_name or "(inferred)",
                "imported": result["imported"],
                "skipped": result["skipped"],
                "errors": result["errors"],
            })
            summary["total_imported"] += result["imported"]
            summary["total_skipped"] += result["skipped"]
            summary["total_errors"] += len(result["errors"])
        except Exception as e:
            summary["files"].append({"filename": file.filename, "error": str(e)})
            summary["total_errors"] += 1

    summary["qualification_sets_refreshed"] = _refresh_confirmed_qualification_sets(db)
    return summary


@router.delete("", status_code=200)
def delete_times(
    swimmer_id: Optional[int] = Query(None),
    db: DBSession = Depends(get_db),
):
    """
    Delete swim times.
    - No params: deletes ALL times for ALL swimmers.
    - ?swimmer_id=X: deletes only that swimmer's times.
    Returns count of deleted rows.
    """
    q = db.query(models.SwimTime)
    if swimmer_id is not None:
        q = q.filter(models.SwimTime.swimmer_id == swimmer_id)
    count = q.count()
    q.delete(synchronize_session=False)
    db.commit()
    return {"deleted": count, "qualification_sets_refreshed": _refresh_confirmed_qualification_sets(db)}
