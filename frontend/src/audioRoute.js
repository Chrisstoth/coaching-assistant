// Where the phone sends sound.
//
// While a page uses the microphone, an iPhone treats it like a phone call, and
// Safari can leave it that way after the mic is off - so the staff's voices
// came out of the phone's own speaker instead of the coach's earbuds. Saying
// which we are doing puts it right: "play and record" only while listening to
// the coach, and plain playback, which goes to the earbuds, while the staff
// speak.
//
// Uses the Audio Session API where the browser has it (Safari); elsewhere
// this does nothing. On Android the call mode comes from echo cancellation,
// which useWhisperVoice turns off instead.

function setType(type) {
  try {
    const session = typeof navigator !== 'undefined' ? navigator.audioSession : null
    if (session && session.type !== type) session.type = type
  } catch {
    // Not allowed here; the phone keeps its own choice.
  }
}

export function forListening() {
  setType('play-and-record')
}

export function forSpeaking() {
  setType('playback')
}
