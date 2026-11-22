"""Read accepted meet entries from a Gala Organiser "meet entries" page.

The page reaches the app from the coach's own browser (copied and pasted, or
saved and uploaded): Gala Organiser puts a "not a robot" check in front of
servers, so it cannot be fetched from here. Every swimmer row carries their
swimrankings ID, entry times, and the session/event number of each swim, so it
is read directly (no AI). Other pages are reduced to plain text for the AI.
"""
import re
from datetime import datetime
from html import unescape
from html.parser import HTMLParser
from typing import Optional

_STROKES = {
    "free": "Freestyle", "back": "Backstroke", "breast": "Breaststroke",
    "fly": "Butterfly", "im": "Individual Medley",
}
# Withdrawn/rejected entries are highlighted green, refunded ones blue. A page
# copied from a browser carries the colour as rgb()/hex rather than its name.
_STATUS_BY_COLOUR = [
    (re.compile(r"background(?:-color)?:(?:green|rgb\(0,128,0\)|#008000|#080)(?![0-9a-z])"), "withdrawn"),
    (re.compile(r"background(?:-color)?:(?:blue|rgb\(0,0,255\)|#0000ff|#00f)(?![0-9a-z])"), "refunded"),
]


class EntriesPageError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Gala Organiser parsing
# ---------------------------------------------------------------------------

class _TableReader(HTMLParser):
    """Collect page headings, list items and table rows, keeping each cell's style."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = None
        self.list_items: list[str] = []
        self.tables: list[dict] = []  # {"heading", "rows": [[{"text", "style", "header"}]]}
        self._heading = None
        self._capture: Optional[str] = None  # h2 / h4 / li / cell
        self._buffer: list[str] = []
        self._row = None
        self._cell = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ("h2", "h4", "li") and self._cell is None:
            self._capture, self._buffer = tag, []
        elif tag == "table":
            self.tables.append({"heading": self._heading, "rows": []})
        elif tag == "tr" and self.tables:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = {"text": "", "style": (attrs.get("style") or "").lower(), "header": tag == "th"}
            self._buffer = []
        elif tag == "br" and self._cell is not None:
            self._buffer.append("\n")

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None:
            self._cell["text"] = re.sub(r"[ \t\r\xa0]+", " ", "".join(self._buffer)).strip()
            self._row.append(self._cell)
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row and self.tables:
                self.tables[-1]["rows"].append(self._row)
            self._row = None
        elif tag == self._capture and self._cell is None:
            text = " ".join("".join(self._buffer).split())
            if tag == "h2" and not self.title:
                self.title = text
            elif tag == "h4":
                self._heading = text
            elif tag == "li":
                self.list_items.append(text)
            self._capture = None

    def handle_data(self, data):
        if self._cell is not None or self._capture:
            self._buffer.append(data)


def _event_from_header(text: str) -> Optional[dict]:
    parts = [part.strip() for part in text.split("\n") if part.strip()]
    if len(parts) < 2 or not parts[0].isdigit():
        return None
    stroke = _STROKES.get(parts[1].lower())
    if not stroke:
        return None
    event = {"event": f"{parts[0]} {stroke}", "session": None, "number": None}
    if len(parts) > 2:
        match = re.fullmatch(r"(\d+)\.(\d+)", parts[2])
        if match:
            event["session"], event["number"] = int(match.group(1)), int(match.group(2))
    return event


def _clean_entry_time(text: str) -> tuple[Optional[str], bool]:
    text = (text or "").strip()
    if not text:
        return None, False
    converted = "*" in text
    value = text.replace("*", "").strip()
    match = re.fullmatch(r"(\d+):(\d{2}\.\d{2})", value)
    if match:  # 00:39.17 -> 39.17, 01:09.99 -> 1:09.99
        minutes = int(match.group(1))
        value = f"{minutes}:{match.group(2)}" if minutes else match.group(2)
    return value or None, converted


def _split_swimmer(text: str) -> dict:
    match = re.match(r"^(.*?)\s*\((\d+)\)\s*$", text)
    name_part, swimmer_id = (match.group(1), match.group(2)) if match else (text, None)
    surname, _, first = name_part.partition(",")
    surname, first = surname.strip(), first.strip()
    display = f"{first} {surname.title() if surname.isupper() else surname}".strip() if first else surname
    return {"name": display, "surname": surname, "first_name": first, "swimrankings_id": swimmer_id}


def _parse_session_line(text: str) -> Optional[dict]:
    match = re.match(
        r"Session\s+(\d+)\s*\((\d{1,2}/\d{1,2}/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)\)"
        r"(?:.*?Warm\s*Up\s*at\s*(\d{1,2}:\d{2}\s*[AP]M))?",
        text, re.IGNORECASE,
    )
    if not match:
        return None

    def clock(value):
        return datetime.strptime(value.upper().replace(" ", ""), "%I:%M%p").strftime("%H:%M") if value else None

    day = datetime.strptime(match.group(2), "%d/%m/%Y").date()
    return {
        "number": int(match.group(1)),
        "date": day.isoformat(),
        "start_time": clock(match.group(3)),
        "warm_up_time": clock(match.group(4)),
    }


def parse_gala_organiser_entries(html: str) -> dict:
    reader = _TableReader()
    reader.feed(html)

    swimmers: dict[str, dict] = {}
    events_by_key: dict[tuple, dict] = {}
    for table in reader.tables:
        heading = (table["heading"] or "").lower()
        gender = "F" if "female" in heading else "M" if "male" in heading else None
        if not table["rows"] or "relay" in heading:
            continue
        header = [cell["text"] for cell in table["rows"][0]]
        lowered = [text.lower() for text in header]
        if "swimmer" not in lowered:
            continue
        swimmer_col = lowered.index("swimmer")
        club_col = lowered.index("club") if "club" in lowered else None
        age_col = lowered.index("age") if "age" in lowered else None
        columns = {index: _event_from_header(text) for index, text in enumerate(header)}
        for column in columns.values():
            if column and column["number"] is not None:
                events_by_key[(gender, column["number"])] = {**column, "gender": gender}

        for row in table["rows"][1:]:
            if len(row) <= swimmer_col:
                continue
            person = _split_swimmer(row[swimmer_col]["text"])
            if not person["name"]:
                continue
            key = person["swimrankings_id"] or person["name"].lower()
            record = swimmers.setdefault(key, {
                **person,
                "club": row[club_col]["text"] if club_col is not None and club_col < len(row) else None,
                "age": row[age_col]["text"] if age_col is not None and age_col < len(row) else None,
                "gender": gender,
                "events": [],
            })
            for index, cell in enumerate(row):
                column = columns.get(index)
                if not column:
                    continue
                entry_time, converted = _clean_entry_time(cell["text"])
                if not entry_time:
                    continue
                style = re.sub(r"\s+", "", cell["style"])
                status = next((label for pattern, label in _STATUS_BY_COLOUR if pattern.search(style)), "accepted")
                record["events"].append({
                    "event": column["event"],
                    "entry_time": entry_time,
                    "converted_time": converted,
                    "session": column["session"],
                    "number": column["number"],
                    "status": status,
                })

    if not swimmers:
        raise EntriesPageError("Couldn't find an entries table on that page")

    sessions = []
    for text in reader.list_items:
        session = _parse_session_line(text)
        if session:
            session["events"] = [
                {
                    "number": event["number"],
                    "name": f"{'Girls' if event['gender'] == 'F' else 'Boys' if event['gender'] == 'M' else ''} {event['event']}".strip(),
                    "gender": event["gender"],
                }
                for event in sorted(events_by_key.values(), key=lambda item: item["number"])
                if event["session"] == session["number"]
            ]
            sessions.append(session)

    return {
        "meet_title": reader.title,
        "swimmers": list(swimmers.values()),
        "sessions": sessions,
    }


def schedule_from_sessions(sessions: list[dict]) -> dict:
    """Shape Gala Organiser sessions like the schedule extractor's output."""
    timetable, by_date, events = [], {}, []
    for index, session in enumerate(sessions):
        day = datetime.fromisoformat(session["date"]).date()
        timetable.append({
            "name": f"Session {session['number']} · {day.strftime('%a %d %b')}",
            "date": session["date"],
            "start_time": session["start_time"],
            "warm_up_time": session["warm_up_time"],
            "order_index": index,
            "events": session["events"],
        })
        names = [event["name"] for event in session["events"]]
        by_date.setdefault(session["date"], []).extend(names)
        events.extend(names)
    return {"sessions": timetable, "by_date": by_date, "events": events}


def page_text(html: str) -> str:
    """Strip a page down to readable text for the AI entries reader."""
    html = re.sub(r"(?is)<(script|style|head)\b.*?</\1>", " ", html)
    html = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|li|h\d)>", "\n", html)
    html = re.sub(r"(?i)</t[dh]>", " | ", html)
    text = unescape(re.sub(r"<[^>]+>", " ", html))
    lines = [" ".join(line.split()) for line in text.splitlines()]
    return "\n".join(line for line in lines if line)
