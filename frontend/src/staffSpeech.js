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

// The leveller: every voice is evened out and brought up to one strong,
// steady loudness before it reaches the coach's ears - like radio. Each
// sentence is made separately, and the speech service does not make them
// equally loud; some voices (Sam's especially) are softer than others. Poolside
// is noisy, so quiet is worse than loud.
//
// Sound only passes through it while its audio context is running. If the
// phone has suspended it, lines play through the plain element instead, so
// the staff are never silenced - just not levelled.
const SPEAKER_TRIM = { interviewer: 1.3 }
const LEVEL_GAIN = 1.6
let leveller = null

function levelled() {
  if (leveller !== null) return leveller || null
  try {
    const Context = window.AudioContext || window.webkitAudioContext
    if (!Context || typeof Audio === 'undefined') throw new Error('no audio context')
    const context = new Context()
    const el = new Audio()
    const source = context.createMediaElementSource(el)
    const evener = context.createDynamicsCompressor()
    evener.threshold.value = -30
    evener.knee.value = 12
    evener.ratio.value = 4
    evener.attack.value = 0.005
    evener.release.value = 0.25
    const gain = context.createGain()
    gain.gain.value = LEVEL_GAIN
    // A hard ceiling after the boost, so it is loud but never distorts.
    const ceiling = context.createDynamicsCompressor()
    ceiling.threshold.value = -2
    ceiling.knee.value = 0
    ceiling.ratio.value = 20
    ceiling.attack.value = 0.001
    ceiling.release.value = 0.1
    source.connect(evener).connect(gain).connect(ceiling).connect(context.destination)
    leveller = { context, element: el, gain }
  } catch {
    leveller = false
  }
  return leveller || null
}

// The element to play the next line through, set to its speaker's level.
function playerFor(speaker) {
  const level = levelled()
  if (level && level.context.state === 'running') {
    level.gain.gain.value = LEVEL_GAIN * (SPEAKER_TRIM[speaker] || 1)
    return level.element
  }
  return element()
}

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
  const level = levelled()
  if (level) {
    level.context.resume?.().catch(() => {})
    level.element.src = silence()
    level.element.play().catch(() => {})
  }
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
  for (const el of [audio, leveller ? leveller.element : null]) {
    if (!el) continue
    el.pause()
    el.onended = null
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
  // Usually called from a tap, which is when a phone lets the leveller start.
  const level = levelled()
  if (level && level.context.state !== 'running') level.context.resume?.()?.catch?.(() => {})
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
  const playOn = async (el) => {
    el.onended = done
    el.src = url
    el.defaultPlaybackRate = PLAYBACK_RATE
    el.playbackRate = PLAYBACK_RATE
    try {
      await el.play()
    } catch (e) {
      el.onended = null
      throw e
    }
  }
  const level = leveller || null
  if (level && level.context.state !== 'running') {
    await Promise.race([level.context.resume?.(), new Promise(resolve => setTimeout(resolve, 300))]).catch(() => {})
    if (run !== generation) return
  }
  const player = playerFor(item.speaker)
  try {
    await playOn(player)
    return
  } catch {
    if (run !== generation) return
  }
  // The levelled player was refused: the plain one, then the phone's voice.
  if (player !== element()) {
    try {
      await playOn(element())
      return
    } catch {
      if (run !== generation) return
    }
  }
  phoneVoice(item.text, item.speaker, done)
}
