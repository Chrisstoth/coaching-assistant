import { getToken } from './api'

// The staff speaking aloud, each in their own voice (see staff_voice.py on the
// server). One player for the whole app: starting a new line stops the last,
// and lines queued together are read in order - a specialist's note, then the
// interviewer's next question.
//
// iPhones only let a page play sound it started from a tap. `unlock()` is
// called from the tap that turns voice on; the same audio element is then
// reused, which Safari allows to keep playing later lines.
//
// If the server's voices are unavailable, the phone's own voice reads the line,
// pitched and paced a little differently per person so they stay apart.

const FALLBACK = {
  interviewer: { pitch: 1.0, rate: 1.0 },
  physiologist: { pitch: 1.1, rate: 0.92 },
  analyst: { pitch: 0.95, rate: 1.12 },
  planner: { pitch: 0.75, rate: 0.9 },
  manager: { pitch: 1.2, rate: 1.0 },
  meets: { pitch: 1.05, rate: 1.1 },
  sessions: { pitch: 1.15, rate: 1.08 },
}

// A twentieth of a second of silence (8 kHz, 8-bit WAV), played from the unlocking tap.
function silence() {
  const samples = 400
  const bytes = new Uint8Array(44 + samples)
  const view = new DataView(bytes.buffer)
  const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, 36 + samples, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true)
  text(36, 'data'); view.setUint32(40, samples, true)
  bytes.fill(128, 44)
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`
}

let audio = null
let queue = []
let playing = null          // { key, speaker } of the line being heard
let generation = 0          // bumped by stop(), so a late fetch does not play
const listeners = new Set()
const finishedListeners = new Set()
const cache = new Map()     // key -> object URL of audio already fetched

function element() {
  if (!audio && typeof Audio !== 'undefined') audio = new Audio()
  return audio
}

function notify() {
  for (const listener of listeners) listener(playing)
}

export function onSpeaking(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Called when everything queued has been said - not when it was stopped -
// so hands-free listening can begin once the staff have finished talking.
export function onFinished(listener) {
  finishedListeners.add(listener)
  return () => finishedListeners.delete(listener)
}

export function speakingNow() {
  return playing
}

// Call from a tap before any automatic speaking.
export function unlock() {
  const el = element()
  if (!el) return
  el.src = silence()
  el.play().catch(() => {})
  try { window.speechSynthesis?.resume() } catch { /* not available */ }
}

export function stop() {
  generation += 1
  queue = []
  playing = null
  if (audio) {
    audio.pause()
    audio.onended = null
  }
  try { window.speechSynthesis?.cancel() } catch { /* not available */ }
  notify()
}

// Read one line now, or several in order. Each item: { text, speaker, key? }.
export function say(items) {
  stop()
  queue = (Array.isArray(items) ? items : [items]).filter(item => item?.text?.trim())
  next(generation)
}

async function fetchAudio(text, speaker) {
  const cacheKey = `${speaker}|${text}`
  if (cache.has(cacheKey)) return cache.get(cacheKey)
  const token = getToken()
  const res = await fetch('/api/staff/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ text, speaker }),
  })
  if (!res.ok) throw new Error(`Speech unavailable (${res.status})`)
  const url = URL.createObjectURL(await res.blob())
  cache.set(cacheKey, url)
  return url
}

function phoneVoice(text, speaker, done) {
  const synth = window.speechSynthesis
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return done()
  const utterance = new SpeechSynthesisUtterance(text)
  const tone = FALLBACK[speaker] || FALLBACK.interviewer
  utterance.lang = 'en-GB'
  utterance.pitch = tone.pitch
  utterance.rate = tone.rate
  utterance.onend = done
  utterance.onerror = done
  synth.speak(utterance)
}

async function next(run) {
  if (run !== generation) return
  const item = queue.shift()
  if (!item) {
    playing = null
    notify()
    for (const listener of finishedListeners) listener()
    return
  }
  const speaker = item.speaker || 'interviewer'
  playing = { key: item.key ?? null, speaker }
  notify()
  const done = () => { if (run === generation) next(run) }
  try {
    const url = await fetchAudio(item.text, speaker)
    if (run !== generation) return
    const el = element()
    el.onended = done
    el.src = url
    await el.play()
  } catch {
    if (run !== generation) return
    phoneVoice(item.text, speaker, done)
  }
}
