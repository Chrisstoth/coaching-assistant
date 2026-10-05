"""One turn of the profile interview, sent as it happens.

A spoken interview felt like call and response: the staff reacted, then the
interviewer wrote the whole of its next question, then the voices were made,
and only then did anyone speak. Here the steps overlap:

- The staff's reactions and the interviewer's reply are written at the same
  time.
- The reply is sent a sentence at a time, so the page can show it and start
  speaking it before it is finished.
- The staff get a moment's head start: if a specialist's note is ready before
  the interviewer's first sentence has to go, it goes first, as it would in
  person. A note that arrives later is still kept and shown, but is not read
  aloud over the interviewer.

The work runs on its own thread with its own database session and saves the
turn to the interview draft whatever happens to the connection, so a phone
that drops out finds the reply waiting when it comes back - as before.

Events, one JSON object per line:
  {"type": "staff", "message": {...}, "late": bool}
  {"type": "sentence", "text": "..."}
  {"type": "done", "reply": "...", "messages": [...], "staff_questions": [...]}
  {"type": "error", "detail": "..."}
"""

from __future__ import annotations

import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from backend import models
from backend.database import SessionLocal
from backend.services import claude_service, interview_staff

log = logging.getLogger(__name__)

# How long the interviewer's first sentence waits for the staff, at most.
STAFF_HEAD_START_S = 2.5

# A sentence ends at . ! or ? followed by a space, or at a blank line. Never
# inside a time like 2:15.4.
_SENTENCE_END = re.compile(r"([.!?]+[\"')\]]*)\s+|\n\s*\n")
_MARKERS = re.compile(r"\[\[[^\]]*\]\]")


def spoken_form(text: str) -> str:
    """What is said aloud of a sentence: no markers, no list or heading marks."""
    text = _MARKERS.sub(" ", text)
    text = re.sub(r"^[\s*#>-]+", "", text)
    text = re.sub(r"[*_#`]+", "", text)
    return re.sub(r"\s+", " ", text).strip()


class Sentences:
    """Cuts streamed text into whole sentences as they complete."""

    def __init__(self):
        self.buffer = ""

    def feed(self, text: str) -> list:
        self.buffer += text
        out = []
        while True:
            match = _SENTENCE_END.search(self.buffer)
            if not match:
                break
            # Wait for a marker that has started but not finished.
            head = self.buffer[:match.end()]
            if head.count("[[") > head.count("]]"):
                break
            out.append(head)
            self.buffer = self.buffer[match.end():]
        return [s for s in (spoken_form(part) for part in out) if s]

    def flush(self) -> list:
        rest, self.buffer = self.buffer, ""
        said = spoken_form(rest)
        return [said] if said else []


def run_turn(swimmer_id: int, messages: list, spoken: bool, emit: Callable[[dict], None]) -> None:
    """Write, send and save one interviewer turn. ``emit`` receives each event."""
    with SessionLocal() as db:
        draft = db.query(models.ProfileWizardDraft).filter(
            models.ProfileWizardDraft.swimmer_id == swimmer_id,
        ).first()
        swimmer = db.get(models.Swimmer, swimmer_id)
        try:
            _write_turn(db, swimmer, draft, messages, spoken, emit)
        except Exception as exc:
            log.exception("Interview turn failed for swimmer %s", swimmer_id)
            try:
                db.rollback()
                draft = db.query(models.ProfileWizardDraft).filter(
                    models.ProfileWizardDraft.swimmer_id == swimmer_id,
                ).first()
                if draft:
                    draft.awaiting_reply = False
                    db.commit()
            except Exception:
                pass
            emit({"type": "error",
                  "detail": "The interview reply did not complete. Your answer is saved; retry when ready."})
            return


def _write_turn(db, swimmer, draft, messages, spoken, emit) -> None:
    questions = [dict(q) for q in (draft.staff_questions or [])]
    started = time.monotonic()

    hearing = None
    if not messages:
        context = claude_service.build_foundation_interview_context(swimmer, db)
        questions = interview_staff.open_agenda(db, swimmer, context["foundation"]["coverage"])
    else:
        hearing = interview_staff.plan_hearing(db, swimmer, messages, questions)

    staff_said: list = []
    pool = ThreadPoolExecutor(max_workers=1)
    reactions = pool.submit(interview_staff.run_hearing, hearing) if hearing else None

    def take_reactions():
        """The staff's notes, once - spoken if the interviewer has not started."""
        nonlocal reactions
        if reactions is None or not reactions.done():
            return
        results, reactions = reactions.result(), None
        staff_said.extend(interview_staff.apply_hearing(hearing, results, questions))

    released = False
    waiting: list = []
    spoken_staff = 0

    def release():
        nonlocal released, spoken_staff
        take_reactions()
        for message in staff_said[spoken_staff:]:
            emit({"type": "staff", "message": message, "late": False})
        spoken_staff = len(staff_said)
        released = True
        for sentence in waiting:
            emit({"type": "sentence", "text": sentence})
        waiting.clear()

    sentences = Sentences()
    parts = []
    try:
        for delta in claude_service.wizard_chat_stream(swimmer, messages, db, questions, spoken=spoken):
            parts.append(delta)
            for sentence in sentences.feed(delta):
                if released:
                    emit({"type": "sentence", "text": sentence})
                else:
                    waiting.append(sentence)
            if not released and waiting and (
                reactions is None or reactions.done() or time.monotonic() - started > STAFF_HEAD_START_S
            ):
                release()
        waiting.extend(sentences.flush())
        if not released:
            # The whole reply is written; give the staff what is left of their head start.
            if reactions is not None:
                try:
                    reactions.result(timeout=max(0.0, STAFF_HEAD_START_S - (time.monotonic() - started)))
                except Exception:
                    pass
            release()
        else:
            for sentence in waiting:
                emit({"type": "sentence", "text": sentence})
            waiting.clear()

        # A note that arrived after the interviewer started is kept and shown,
        # not read over the top of them.
        if reactions is not None:
            try:
                reactions.result(timeout=20)
            except Exception:
                pass
            take_reactions()
        for message in staff_said[spoken_staff:]:
            emit({"type": "staff", "message": message, "late": True})
    finally:
        pool.shutdown(wait=False)

    reply, asks_for = interview_staff.take_marker("".join(parts), questions)
    turn = {"role": "assistant", "content": reply}
    if asks_for:
        turn["asks_for"] = asks_for
    draft.messages = [*messages, *staff_said, turn]
    draft.staff_questions = questions
    draft.awaiting_reply = False
    db.commit()
    emit({
        "type": "done",
        "reply": reply,
        "messages": draft.messages,
        "staff_questions": interview_staff.public(questions),
    })
