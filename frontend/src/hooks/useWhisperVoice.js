import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

/**
 * Push-to-talk dictation via the server's Whisper endpoint.
 *
 * Preferred over the browser's SpeechRecognition API because that is missing or
 * unreliable on iOS Safari — the phone a coach actually holds at poolside.
 *
 * Hands-free: `start({ autoStop: true })` listens until the coach has spoken
 * and then paused, so nobody has to tap to finish. If nobody speaks at all,
 * listening ends without sending anything and `onNoSpeech` is called.
 */

// How long a pause ends an answer, and how long to wait for one to start.
// Short enough to feel like conversation ("Done, send it" is quicker still);
// a longer answer, where the coach is thinking, is allowed a longer pause.
const SILENCE_MS = 1400
const LONG_ANSWER_SILENCE_MS = 2000
const LONG_ANSWER_MS = 8000
const NO_SPEECH_MS = 9000
const MAX_MS = 180000

// One audio context, started from a tap (phones only allow that) and reused.
let sharedContext = null
export function primeMicrophone() {
  try {
    const Context = window.AudioContext || window.webkitAudioContext
    if (!Context) return
    if (!sharedContext) sharedContext = new Context()
    sharedContext.resume?.()
  } catch {
    // No pause detection; the coach taps to finish instead.
  }
}

// Phones can suspend the audio context when they switch between playing the
// staff's voices and recording - most often with Bluetooth. Wake it before
// each answer; a suspended context hears nothing at all.
async function wakeContext() {
  if (!sharedContext || sharedContext.state === 'running') return
  try {
    await Promise.race([sharedContext.resume(), new Promise(resolve => setTimeout(resolve, 600))])
  } catch {
    // Still asleep; the listener notices and stops relying on it.
  }
}

// A short rising tone: "your turn". Useful with earbuds, where the coach is not
// looking at the screen. Returns how long it lasts, in milliseconds.
const BEEP_MS = 180
function beep() {
  if (!sharedContext) return 0
  try {
    const start = sharedContext.currentTime
    const tone = sharedContext.createOscillator()
    const volume = sharedContext.createGain()
    tone.type = 'sine'
    tone.frequency.setValueAtTime(660, start)
    tone.frequency.linearRampToValueAtTime(990, start + BEEP_MS / 1000)
    volume.gain.setValueAtTime(0.0001, start)
    volume.gain.exponentialRampToValueAtTime(0.25, start + 0.02)
    volume.gain.exponentialRampToValueAtTime(0.0001, start + BEEP_MS / 1000)
    tone.connect(volume).connect(sharedContext.destination)
    tone.start(start)
    tone.stop(start + BEEP_MS / 1000 + 0.02)
    return BEEP_MS
  } catch {
    return 0
  }
}

// Listen for the speaker pausing.
//
// What counts as talking is judged against the background, and the background
// is learnt all the time rather than measured once: the quietest moments of
// the last few seconds (the gaps between words) are the room. Measuring it
// once at the start went wrong when the coach began talking straight after the
// beep - their own voice became "the room", and anything quieter than their
// loudest words looked like a pause.
const TICK_MS = 50
const ROOM_WINDOW = 120            // readings: six seconds
const ROOM_PERCENTILE = 0.1
const QUIETEST_TALKING = 0.006     // earbuds' noise suppression makes voices quiet

export function talkingThreshold(levels) {
  if (!levels.length) return QUIETEST_TALKING
  const sorted = [...levels].sort((a, b) => a - b)
  const room = sorted[Math.floor((sorted.length - 1) * ROOM_PERCENTILE)]
  return Math.max(QUIETEST_TALKING, room * 2.2, room + 0.004)
}

// A real microphone is never perfectly silent. Readings this small for this
// long mean the listener itself is not getting sound, not that the room is quiet.
const DEAF_LEVEL = 0.00002
const DEAF_AFTER_MS = 1500

function watchForPause(stream, { onPause, onNothing, onDeaf }) {
  if (!sharedContext || sharedContext.state !== 'running') {
    onDeaf()
    return () => {}
  }
  const source = sharedContext.createMediaStreamSource(stream)
  const analyser = sharedContext.createAnalyser()
  analyser.fftSize = 2048
  source.connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  const started = Date.now()
  const levels = []
  let loudTicks = 0
  let firstVoice = 0
  let lastVoice = 0
  let alive = false

  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (const sample of samples) sum += sample * sample
    const level = Math.sqrt(sum / samples.length)
    const now = Date.now()
    if (level > DEAF_LEVEL) alive = true
    if (!alive && now - started > DEAF_AFTER_MS) {
      window.clearInterval(timer)
      onDeaf()
      return
    }

    const threshold = talkingThreshold(levels)
    levels.push(level)
    if (levels.length > ROOM_WINDOW) levels.shift()

    if (level > threshold) {
      loudTicks += 1
      // A couple of loud readings in a row, not one click or knock.
      if (loudTicks >= 2) {
        if (!firstVoice) firstVoice = now
        lastVoice = now
      }
    } else {
      loudTicks = 0
    }

    const heard = Boolean(firstVoice)
    const pause = lastVoice - firstVoice > LONG_ANSWER_MS ? LONG_ANSWER_SILENCE_MS : SILENCE_MS
    if (heard && now - lastVoice > pause) onPause()
    else if (!heard && now - started > NO_SPEECH_MS) onNothing()
    else if (now - started > MAX_MS) onPause()
  }, TICK_MS)

  return () => {
    window.clearInterval(timer)
    try { source.disconnect() } catch { /* already gone */ }
  }
}

/**
 * `onResult(text, { unsure })` - `unsure` when listening ended because it
 * thought nobody spoke; the words are still given, to be checked, not sent.
 * `onNoSpeech` - the recording really was empty.
 * `onCannotTell` - this phone is not letting the pause detection hear, so the
 * coach finishes with a tap instead; recording carries on.
 */
export default function useWhisperVoice(onResult, { onNoSpeech, onCannotTell } = {}) {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const discardRef = useRef(false)
  const unwatchRef = useRef(() => {})
  const noSpeechRef = useRef(onNoSpeech)
  noSpeechRef.current = onNoSpeech
  const cannotTellRef = useRef(onCannotTell)
  cannotTellRef.current = onCannotTell
  const unsureRef = useRef(false)
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder)

  const finish = useCallback((discard = false, unsure = false) => {
    unwatchRef.current()
    unwatchRef.current = () => {}
    discardRef.current = discard
    unsureRef.current = unsure
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    setRecording(false)
  }, [])

  const start = useCallback(async ({ autoStop = false } = {}) => {
    if (recording || transcribing) return
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      const recorder = new MediaRecorder(stream, { mimeType })
      chunksRef.current = []
      discardRef.current = false
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        if (discardRef.current) return
        const blob = new Blob(chunksRef.current, { type: mimeType })
        setTranscribing(true)
        const unsure = unsureRef.current
        try {
          const result = await api.transcribeAudio(blob)
          if (result?.text?.trim()) onResult(result.text, { unsure })
          else if (unsure) noSpeechRef.current?.()
        } catch (e) {
          setError(`Transcription failed: ${e.message}`)
        }
        setTranscribing(false)
      }
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
      if (autoStop) await wakeContext()
      if (autoStop) {
        // Beep once the mic is really open - with Bluetooth earbuds that
        // takes a moment - then start measuring the room after the beep, so
        // the tone itself is not mistaken for talking.
        let unwatch = () => {}
        const wait = window.setTimeout(() => {
          unwatch = watchForPause(stream, {
            onPause: () => finish(false),
            // Never thrown away: what was recorded is written down to check.
            onNothing: () => finish(false, true),
            onDeaf: () => cannotTellRef.current?.(),
          })
        }, beep() + 120)
        unwatchRef.current = () => {
          window.clearTimeout(wait)
          unwatch()
        }
      }
    } catch (e) {
      setError(e.name === 'NotAllowedError'
        ? 'Microphone blocked — tap the lock icon in your address bar to allow it.'
        : `Microphone unavailable: ${e.message}`)
    }
  }, [recording, transcribing, onResult, finish])

  const stop = useCallback(() => finish(false), [finish])
  const cancel = useCallback(() => finish(true), [finish])

  useEffect(() => () => finish(true), [finish])

  return { recording, transcribing, supported, start, stop, cancel, error, clearError: () => setError(null) }
}
