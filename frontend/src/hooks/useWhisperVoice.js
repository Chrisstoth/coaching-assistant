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
// Coaches think mid-answer, so the pause is generous.
const SILENCE_MS = 2200
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

// Listen for the speaker pausing. The level of the room is measured for the
// first moments, so a noisy pool hall does not count as talking.
function watchForPause(stream, { onPause, onNothing }) {
  if (!sharedContext) return () => {}
  const source = sharedContext.createMediaStreamSource(stream)
  const analyser = sharedContext.createAnalyser()
  analyser.fftSize = 1024
  source.connect(analyser)
  const samples = new Uint8Array(analyser.fftSize)
  const started = Date.now()
  let room = 0
  let roomReadings = 0
  let heard = false
  let lastVoice = 0

  const timer = window.setInterval(() => {
    analyser.getByteTimeDomainData(samples)
    let sum = 0
    for (const sample of samples) {
      const centred = (sample - 128) / 128
      sum += centred * centred
    }
    const level = Math.sqrt(sum / samples.length)
    const now = Date.now()
    if (now - started < 400) {
      room = (room * roomReadings + level) / (roomReadings + 1)
      roomReadings += 1
      return
    }
    if (level > Math.max(0.025, room * 2.5)) {
      heard = true
      lastVoice = now
    }
    if (heard && now - lastVoice > SILENCE_MS) onPause()
    else if (!heard && now - started > NO_SPEECH_MS) onNothing()
    else if (now - started > MAX_MS) onPause()
  }, 100)

  return () => {
    window.clearInterval(timer)
    try { source.disconnect() } catch { /* already gone */ }
  }
}

export default function useWhisperVoice(onResult, { onNoSpeech } = {}) {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const discardRef = useRef(false)
  const unwatchRef = useRef(() => {})
  const noSpeechRef = useRef(onNoSpeech)
  noSpeechRef.current = onNoSpeech
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder)

  const finish = useCallback((discard = false) => {
    unwatchRef.current()
    unwatchRef.current = () => {}
    discardRef.current = discard
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
        try {
          const result = await api.transcribeAudio(blob)
          if (result?.text) onResult(result.text)
        } catch (e) {
          setError(`Transcription failed: ${e.message}`)
        }
        setTranscribing(false)
      }
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
      if (autoStop) {
        // Beep once the mic is really open - with Bluetooth earbuds that
        // takes a moment - then start measuring the room after the beep, so
        // the tone itself is not mistaken for talking.
        let unwatch = () => {}
        const wait = window.setTimeout(() => {
          unwatch = watchForPause(stream, {
            onPause: () => finish(false),
            onNothing: () => {
              finish(true)
              noSpeechRef.current?.()
            },
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
