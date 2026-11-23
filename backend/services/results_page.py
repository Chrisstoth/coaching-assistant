"""Read a club's results for one meet from a pasted swimmingresults.org page.

The coach opens swimmingresults.org -> Results by club -> their club -> the
meet, selects the page, copies it and pastes it on the gala. Each row carries
the Swim England member number, name, event, round, time and WA points, so it
is read directly (no AI). The page does not show the day of each swim or the
course; those come from the gala in the app.

A pasted page arrives as tab-separated text (desktop browsers) and/or as HTML
(phones often copy each cell on its own line, so the HTML table is used then).
"""
import re
from html import unescape
from typing import Optional

from backend.services.importer import parse_time_to_seconds


class ResultsPageError(ValueError):
    pass


_EVENT = r"\d{2,4}\s*m?\s+(?:Freestyle|Backstroke|Breaststroke|Butterfly|Individual\s+Medley|Free|Back|Breast|Fly|IM)"
# A row whose cells have lost their tabs (e.g. text copied out of a PDF).
_LOOSE_ROW = re.compile(
    rf"^(?P<member>\d{{4,9}})\s+(?P<name>.+?)\s+(?P<yob>\d{{2}})\s+(?P<category>\S.*?/(?:Male|Female|Mixed))\s+"
    rf"(?P<club>.+?)\s+(?P<event>{_EVENT})\s+(?P<round>[A-Za-z]{{1,2}})\s+"
    rf"(?P<time>(?:\d{{1,2}}:)?\d{{1,2}}[.:]\d{{2}})(?:\s+(?P<wa>\d+))?\s*$",
    re.IGNORECASE,
)
_HEADER_NAMES = {
    "member": "member", "name": "name", "yob": "yob", "eligibility category": "category",
    "club swum": "club", "event": "event", "round": "round", "time": "time", "wa pts": "wa",
}
_BLOCK_END = re.compile(r"</(?:tr|p|h[1-6]|li|table|div)>|<br\s*/?>", re.IGNORECASE)
_CELL_END = re.compile(r"</t[dh]>", re.IGNORECASE)
_TAG = re.compile(r"<[^>]+>")


def _html_lines(html: str) -> list[str]:
    """The pasted HTML as text lines, one table row per line with tab-separated cells."""
    text = _CELL_END.sub("\t", html)
    text = _BLOCK_END.sub("\n", text)
    text = unescape(_TAG.sub("", text)).replace("\xa0", " ")
    return [line.rstrip("\t ") for line in text.splitlines()]


def _is_header(line: str) -> bool:
    lowered = line.lower()
    return all(word in lowered for word in ("member", "event", "time"))


def _clean_title(line: str) -> str:
    return " ".join(line.split())


def _row_from_cells(cells: list[str], columns: dict[str, int]) -> Optional[dict]:
    def cell(name):
        index = columns.get(name)
        return cells[index].strip() if index is not None and index < len(cells) else ""

    member, event, time = cell("member"), cell("event"), cell("time")
    if not re.fullmatch(r"\d{4,9}", member) or not event:
        return None
    return {
        "member": member, "name": " ".join(cell("name").split()), "event": event,
        "round": cell("round").upper() or None, "time": time, "wa": cell("wa"),
    }


def _read_lines(lines: list[str]) -> tuple[list[dict], list[str]]:
    """Rows and meet titles found in one page's lines."""
    rows, titles = [], []
    columns: Optional[dict[str, int]] = None
    previous = ""
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if _is_header(line):
            if "\t" in raw:
                headers = [" ".join(part.split()).lower() for part in raw.strip().split("\t")]
                columns = {_HEADER_NAMES[h]: i for i, h in enumerate(headers) if h in _HEADER_NAMES}
            else:
                columns = None
            # The meet's name sits just above its results table.
            if previous and previous not in titles:
                titles.append(previous)
            continue
        row = None
        if "\t" in raw and columns:
            row = _row_from_cells(raw.strip().split("\t"), columns)
        if row is None:
            match = _LOOSE_ROW.match(" ".join(line.split()))
            if match:
                row = {
                    "member": match["member"], "name": match["name"], "event": match["event"],
                    "round": match["round"].upper(), "time": match["time"], "wa": match["wa"] or "",
                }
        if row:
            rows.append(row)
        else:
            previous = _clean_title(line)
    return rows, titles


def parse_results_pages(pages: list[dict]) -> dict:
    """
    Read every pasted page ({"html", "text"}). Returns the meet titles seen, the
    swims ({member, name, event, round, seconds, wa_points}) and rows whose time
    couldn't be read (DQ, DNS...).
    """
    swims, not_timed, titles = [], [], []
    for page in pages:
        # Read the plain text and the HTML, and keep whichever gave more rows.
        found: tuple[list[dict], list[str]] = ([], [])
        candidates = [
            page.get("text", "").splitlines() if page.get("text") else None,
            _html_lines(page["html"]) if page.get("html") else None,
        ]
        for lines in candidates:
            if lines:
                attempt = _read_lines(lines)
                if len(attempt[0]) > len(found[0]):
                    found = attempt
        rows, page_titles = found
        titles += [title for title in page_titles if title not in titles]
        for row in rows:
            seconds = parse_time_to_seconds(row["time"].replace(";", ":"))
            if seconds is None or seconds <= 0:
                not_timed.append(f"{row['name']} - {row['event']}: {row['time'] or 'no time'}")
                continue
            swims.append({
                "member": row["member"],
                "name": row["name"],
                "event": " ".join(row["event"].split()),
                "round": row["round"],
                "seconds": seconds,
                "wa_points": float(row["wa"]) if row["wa"].isdigit() else None,
            })
    if not swims:
        raise ResultsPageError(
            "No results found in what was pasted. Open the meet on swimmingresults.org "
            "(Results by club), select the whole page, copy it and paste it here."
        )
    return {"titles": titles, "swims": swims, "not_timed": not_timed}


def course_from_title(title: str) -> Optional[str]:
    lowered = title.lower()
    if re.search(r"short\s*course|\(sc\)|\bscm?\b", lowered):
        return "SCM"
    if re.search(r"long\s*course|\(lc\)|\blcm?\b", lowered):
        return "LCM"
    return None
