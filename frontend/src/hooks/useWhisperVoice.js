import { useCallback, useRef, useState } from 'react'
import { api } from '../api'

/**
 * Push-to-talk dictation via the server's Whisper endpoint.
 *
 * Preferred over the browser's SpeechRecognition API because that is missing or
 * unreliable on iOS Safari — the phone a coach actually holds at poolside.
 */
export default function useWhisperVoice(onResult) {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder)

  const start = useCallback(async () => {
    if (recording || transcribing) return
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      const recorder = new MediaRecorder(stream, { mimeType })
      chunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
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
    } catch (e) {
      setError(e.name === 'NotAllowedError'
        ? 'Microphone blocked — tap the lock icon in your address bar to allow it.'
        : `Microphone unavailable: ${e.message}`)
    }
  }, [recording, transcribing, onResult])

  const stop = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    setRecording(false)
  }, [])

  return { recording, transcribing, supported, start, stop, error, clearError: () => setError(null) }
}
