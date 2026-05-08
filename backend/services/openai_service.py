"""
Vision and physiological reasoning — uses Claude (same API as everything else).
File kept as openai_service.py so import paths don't need changing.
"""
import base64
import json
from backend.services.claude_service import get_client, MODEL


def parse_whiteboard_photo(image_bytes: bytes, mime_type: str = "image/jpeg") -> dict:
    """
    Use Claude Vision to extract a structured session from a whiteboard photo.
    Returns {title, groups: {1: {description, sets}, 2: ..., 3: ...}, notes}
    """
    b64 = base64.b64encode(image_bytes).decode()

    prompt = """This is a photo of a swimming training session written on a whiteboard or paper.

Extract the session content and return it as JSON with this structure:
{
  "title": "session title if visible, or null",
  "date": "date if visible in DD/MM/YYYY format, or null",
  "groups": {
    "1": {"description": "...", "sets": "full text of sets for group 1"},
    "2": {"description": "...", "sets": "full text of sets for group 2"},
    "3": {"description": "...", "sets": "full text of sets for group 3"}
  },
  "notes": "any other notes visible",
  "energy_system_focus": "aerobic/threshold/speed/recovery/mixed — infer from the content"
}

Only include groups that actually appear in the image.
If groups are not explicitly labelled, infer from context (different columns, colours, lane numbers).
Preserve the exact set notation as written (distances, intervals, reps).
Return only JSON."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=2000,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime_type,
                            "data": b64,
                        },
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    return json.loads(raw)


def physiological_analysis(swimmer_context: str, question: str) -> str:
    """
    Deep physiological reasoning about a swimmer using Claude.
    """
    system = """You are a sports scientist specialising in competitive swimming physiology.
You have deep knowledge of:
- Energy systems (aerobic, anaerobic glycolytic, phosphocreatine)
- Swimming-specific lactate threshold and VO2max markers
- Biological adaptation timelines to different training stimuli
- Age and gender-specific physiological development in swimmers
- Taper and peaking physiology

Answer the coach's question with evidence-based reasoning. Be specific, practical, and cite physiological mechanisms where relevant.
Keep answers concise (under 300 words unless more detail is genuinely needed)."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=600,
        system=system,
        messages=[
            {
                "role": "user",
                "content": f"SWIMMER CONTEXT:\n{swimmer_context}\n\nQUESTION:\n{question}",
            }
        ],
    )

    return response.content[0].text.strip()


def parse_schedule_image(image_bytes: bytes, mime_type: str = "image/jpeg", date_context: str = "") -> dict:
    """
    Extract swimming meet schedule/timetable events from an image.
    Returns {"events": [...], "by_date": {"2026-05-15": ["100 Freestyle", ...]}}
    """
    b64 = base64.b64encode(image_bytes).decode()

    date_instruction = ""
    if date_context:
        date_instruction = f" {date_context} For each event, note which day it occurs on."

    prompt = f"""This is an image of a swimming meet schedule or timetable.
Extract all the swimming events listed and their days.{date_instruction}

Return as JSON:
{{
  "events": ["50 Freestyle", "100 Freestyle", "200 Freestyle", ...],
  "by_date": {{
    "2026-05-15": ["Event 1", "Event 2"],
    "2026-05-16": ["Event 3"]
  }}
}}

Include all individual events, relays, and heats. Use standard swimming event naming.
If no specific dates are visible, use "TBD" as the date key.
Return only valid JSON."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1000,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime_type,
                            "data": b64,
                        },
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    try:
        return json.loads(raw)
    except:
        return {"events": [], "by_date": {}}


def parse_schedule_document(file_bytes: bytes, date_context: str = "") -> dict:
    """
    Extract events from a schedule PDF/document.
    For now, returns minimal data; would need pdfplumber for full PDF parsing.
    """
    # Placeholder - in production, use pdfplumber or similar
    return {"events": [], "by_date": {}}


def parse_entries_image(image_bytes: bytes, mime_type: str = "image/jpeg") -> dict:
    """
    Extract swimmer names and their registered events from an accepted entries image.
    Returns {"swimmers": [{"name": "John Doe", "events": ["100 Free", ...]}, ...]}
    """
    b64 = base64.b64encode(image_bytes).decode()

    prompt = """This is an image of an accepted entries list for a swimming meet.
Extract the swimmer names and their registered events and return as JSON:
{
  "swimmers": [
    {"name": "Swimmer Name", "events": ["100 Freestyle", "200 Freestyle", ...]},
    ...
  ]
}

Return only valid JSON."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=2000,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime_type,
                            "data": b64,
                        },
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    try:
        return json.loads(raw)
    except:
        return {"swimmers": []}


def parse_entries_text(text_content: str) -> dict:
    """
    Parse plain text accepted entries list.
    Simple heuristic: look for patterns like "Name: event1, event2"
    """
    prompt = """This is an accepted entries list for a swimming meet in plain text format.
Extract swimmer names and their registered events.
Return as JSON:
{
  "swimmers": [
    {"name": "Swimmer Name", "events": ["100 Freestyle", "200 Freestyle", ...]},
    ...
  ]
}

Return only valid JSON."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=2000,
        messages=[
            {
                "role": "user",
                "content": f"Accepted entries list:\n\n{text_content}",
            }
        ],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    try:
        return json.loads(raw)
    except:
        return {"swimmers": []}
