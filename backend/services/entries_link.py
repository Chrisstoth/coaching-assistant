"""Read accepted entries for a meet from a web link.

Gala Organiser "meet entries" pages are read directly (no AI): every swimmer row
carries their swimrankings ID, entry times, and the session/event number of each
swim. Other sites are fetched and handed back as plain text for the AI reader.
"""
import ipaddress
import re
import socket
from datetime import datetime
from html import unescape
from html.parser import HTMLParser
from typing import Optional
from urllib.parse import urlparse

import httpx

MAX_PAGE_BYTES = 5 * 1024 * 1024
_BROWSER_HEADERS = {
    # Gala Organiser refuses requests that do not look like a browser.
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
}
_STROKES = {
    "free": "Freestyle", "back": "Backstroke", "breast": "Breaststroke",
    "fly": "Butterfly", "im": "Individual Medley",
}
_STATUS_BY_COLOUR = {"green": "withdrawn", "blue": "refunded"}


class EntriesLinkError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------

def _check_public_url(url: str) -> str:
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise EntriesLinkError("That doesn't look like a web link — it should start with https://")
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(parsed.hostname, None)}
    except socket.gaierror as exc:
        raise EntriesLinkError(f"Couldn't find the website {parsed.hostname}") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address.split("%")[0])
        if not ip.is_global:
            raise EntriesLinkError("That link points somewhere private and can't be opened")
    return parsed.geturl()


def fetch_page(url: str) -> str:
    url = _check_public_url(url)
    try:
        with httpx.Client(headers=_BROWSER_HEADERS, timeout=20, follow_redirects=True) as client:
            response = client.get(url)
    except httpx.HTTPError as exc:
        raise EntriesLinkError(f"Couldn't open the link: {exc}") from exc
    if response.status_code >= 400:
        raise EntriesLinkError(f"The website refused the link (error {response.status_code})")
    # Every redirect hop must also stay on the public internet.
    _check_public_url(str(response.url))
    if len(response.content) > MAX_PAGE_BYTES:
        raise EntriesLinkError("That page is too large to read")
    return response.text


def is_gala_organiser(url: str) -> bool:
    host = (urlparse((url or "").strip()).hostname or "").lower()
    return host == "galaorganiser.co.uk" or host.endswith(".galaorganiser.co.uk")


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
                status = next(
                    (label for colour, label in _STATUS_BY_COLOUR.items() if f"background-color: {colour}" in cell["style"]),
                    "accepted",
                )
                record["events"].append({
                    "event": column["event"],
                    "entry_time": entry_time,
                    "converted_time": converted,
                    "session": column["session"],
                    "number": column["number"],
                    "status": status,
                })

    if not swimmers:
        raise EntriesLinkError("Couldn't find an entries table on that page")

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
