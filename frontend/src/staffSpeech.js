import { liveFetch } from './api'
import { forSpeaking } from './audioRoute'

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
let running = false         // working through the queue
let holding = false         // more lines are still on their way (a reply being written)
const listeners = new Set()
const finishedListeners = new Set()
const cache = new Map()     // speaker|text -> promise of an object URL for its audio

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

// Anything being said, or still to come.
export function isBusy() {
  return running || holding
}

// Call from a tap before any automatic speaking.
export function unlock() {
  forSpeaking()
  const el = element()
  if (!el) return
  el.src = silence()
  el.play().catch(() => {})
  try { window.speechSynthesis?.resume() } catch { /* not available */ }
}

export function stop() {
  generation += 1
  queue = []
  running = false
  holding = false
  playing = null
  if (audio) {
    audio.pause()
    audio.onended = null
  }
  try { window.speechSynthesis?.cancel() } catch { /* not available */ }
  notify()
}

// A little quicker than the voices' natural pace: conversation, not narration.
const PLAYBACK_RATE = 1.08

// Lines are spoken a sentence or two at a time. Every piece is requested at
// once, so the first sentence plays while the rest are still being made, and
// the next speaker's audio is ready the moment the last one stops.
const FIRST_PIECE = 140
const PIECE = 260

export function pieces(text) {
  // A sentence ends at . ! or ? followed by a space - never inside 2:15.4.
  const sentences = text.replace(/([.!?]+["')\]]*)\s+/g, '$1\u0000').split('\u0000').map(part => `${part} `)
  const out = []
  let current = ''
  for (const sentence of sentences) {
    const limit = out.length ? PIECE : FIRST_PIECE
    if (current && (current + sentence).length > limit) {
      out.push(current.trim())
      current = sentence
    } else {
      current += sentence
    }
  }
  if (current.trim()) out.push(current.trim())
  return out.filter(Boolean)
}

function queued(items) {
  const out = []
  for (const item of Array.isArray(items) ? items : [items]) {
    if (!item?.text?.trim()) continue
    const speaker = item.speaker || 'interviewer'
    for (const text of pieces(item.text)) {
      out.push({ text, speaker, key: item.key ?? null, audio: fetchAudio(text, speaker).catch(() => null) })
    }
  }
  return out
}

// Read one line now, or several in order. Each item: { text, speaker, key? }.
export function say(items) {
  stop()
  queue = queued(items)
  running = true
  next(generation)
}

// While a reply is still being written, running out of lines is a pause, not
// the end: hands-free must not open the mic between two sentences.
// Returns a token for the reply's lines: once anything stops the speaking
// (the coach tapping "My turn"), the rest of that reply stays quiet.
export function hold() {
  holding = true
  return generation
}

// Add lines after whatever is already being said - for a reply that arrives
// a sentence at a time.
export function enqueue(items, token = generation) {
  if (token !== generation) return
  queue.push(...queued(items))
  if (!running) {
    running = true
    next(generation)
  }
}

export function release(token = generation) {
  if (token !== generation) return
  holding = false
  if (!running) {
    for (const listener of finishedListeners) listener()
  }
}

function fetchAudio(text, speaker) {
  const cacheKey = `${speaker}|${text}`
  if (!cache.has(cacheKey)) {
    const request = (async () => {
      const res = await liveFetch('/staff/speak', {
        method: 'POST',
        body: JSON.stringify({ text, speaker }),
      })
      if (!res.ok) throw new Error(`Speech unavailable (${res.status})`)
      return URL.createObjectURL(await res.blob())
    })()
    // A failed request is forgotten, so the next attempt asks again.
    request.catch(() => cache.delete(cacheKey))
    cache.set(cacheKey, request)
  }
  return cache.get(cacheKey)
}

function phoneVoice(text, speaker, done) {
  const synth = window.speechSynthesis
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return done()
  const utterance = new SpeechSynthesisUtterance(text)
  const tone = FALLBACK[speaker] || FALLBACK.interviewer
  utterance.lang = 'en-GB'
  utterance.pitch = tone.pitch
  utterance.rate = tone.rate * PLAYBACK_RATE
  utterance.onend = done
  utterance.onerror = done
  synth.speak(utterance)
}

async function next(run) {
  if (run !== generation) return
  const item = queue.shift()
  if (!item) {
    running = false
    playing = null
    notify()
    if (!holding) {
      for (const listener of finishedListeners) listener()
    }
    return
  }
  if (!playing || playing.key !== item.key || playing.speaker !== item.speaker) {
    playing = { key: item.key, speaker: item.speaker }
    notify()
  }
  const done = () => { if (run === generation) next(run) }
  forSpeaking()
  const url = await item.audio
  if (run !== generation) return
  if (!url) {
    phoneVoice(item.text, item.speaker, done)
    return
  }
  try {
    const el = element()
    el.onended = done
    el.src = url
    el.defaultPlaybackRate = PLAYBACK_RATE
    el.playbackRate = PLAYBACK_RATE
    await el.play()
  } catch {
    if (run !== generation) return
    phoneVoice(item.text, item.speaker, done)
  }
}
