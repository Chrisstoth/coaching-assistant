"""How each member of the staff sounds.

Every specialist keeps one voice, and one way of speaking, wherever they talk in
the app, so the coach comes to know who is speaking without looking. The voices
are made by OpenAI's speech model, which follows a short description of the
speaker - accent, pace, manner - as well as the base voice.

Phones make their own voices too, but every phone has a different set, so a
specialist would sound different on each device. The page falls back to the
phone's voice only when this service cannot be reached.

The same line spoken twice (replaying a message) is served from a small cache
rather than paid for again.
"""

from __future__ import annotations

import hashlib
import os
import re
import threading
from collections import OrderedDict
from dataclasses import dataclass

SPEECH_MODEL = os.getenv("OPENAI_SPEECH_MODEL", "gpt-4o-mini-tts")
MAX_CHARS = 1800
CACHE_ENTRIES = 120


@dataclass(frozen=True)
class Voice:
    base: str          # the speech model's base voice
    manner: str        # how this person speaks


VOICES = {
    "interviewer": Voice("sage", "A calm, warm British coaching colleague with a neutral southern English accent. "
                                 "Conversational and unhurried; asks questions with genuine curiosity."),
    "physiologist": Voice("coral", "A thoughtful sports scientist with a soft Scottish accent. Calm, careful and "
                                   "measured, with a slight pause before an important point."),
    "analyst": Voice("ash", "A sharp performance analyst with a London accent. Brisk and precise, a little quicker "
                            "than average, leaning on the numbers."),
    "planner": Voice("onyx", "A steady, experienced periodisation planner with a Yorkshire accent. Deep, deliberate "
                             "and unflappable; speaks like someone who has seen many seasons."),
    "manager": Voice("nova", "A warm, caring swimmer manager with a gentle Irish accent. Friendly and encouraging, "
                             "always thinking about the swimmer as a person."),
    "meets": Voice("echo", "An upbeat, organised meet manager with a Welsh accent. Energetic and practical, "
                           "like someone with a clipboard and a timetable."),
    "sessions": Voice("shimmer", "An enthusiastic poolside session writer with an Australian accent. Lively and "
                                 "practical, sounds like she is standing on deck."),
}
DEFAULT_SPEAKER = "interviewer"

_cache: "OrderedDict[str, bytes]" = OrderedDict()
_lock = threading.Lock()


class SpeechUnavailable(Exception):
    """The speech service is not set up or did not answer; the page uses the phone's voice."""


def speakable(text: str) -> str:
    """What is worth saying aloud: no markers, links or formatting."""
    text = re.sub(r"\[\[[^\]]*\]\]", " ", text or "")
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"[*_#`>|]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:MAX_CHARS]


def speak(text: str, speaker: str) -> bytes:
    """MP3 audio of ``speaker`` saying ``text``."""
    voice = VOICES.get(speaker) or VOICES[DEFAULT_SPEAKER]
    words = speakable(text)
    if not words:
        raise ValueError("Nothing to say")
    key = hashlib.sha256(f"{SPEECH_MODEL}|{voice.base}|{voice.manner}|{words}".encode()).hexdigest()
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise SpeechUnavailable("OPENAI_API_KEY not configured on server")
    import openai

    try:
        response = openai.OpenAI(api_key=api_key).audio.speech.create(
            model=SPEECH_MODEL,
            voice=voice.base,
            input=words,
            response_format="mp3",
            # Passed through as-is so older SDK versions still send it.
            extra_body={"instructions": voice.manner},
        )
        audio = response.read() if hasattr(response, "read") else response.content
    except Exception as exc:
        raise SpeechUnavailable(str(exc)) from exc
    _record_usage(words)

    with _lock:
        _cache[key] = audio
        while len(_cache) > CACHE_ENTRIES:
            _cache.popitem(last=False)
    return audio


def _record_usage(words: str) -> None:
    # The speech endpoint reports no token counts. Roughly four characters make
    # a text token, and a minute of speech (about 900 characters) is about 1,250
    # audio tokens - enough to keep the cost log honest, not exact.
    from backend.services.claude_service import record_ai_usage
    record_ai_usage("openai", SPEECH_MODEL, "staff_speech",
                    input_tokens=len(words) // 4, output_tokens=int(len(words) * 1.4))
