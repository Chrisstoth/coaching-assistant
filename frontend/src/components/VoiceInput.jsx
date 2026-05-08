import { useState, useRef } from 'react'

export default function VoiceInput({ onTranscript, placeholder = 'Tap mic to speak...' }) {
  const [listening, setListening] = useState(false)
  const [text, setText] = useState('')
  const recRef = useRef(null)

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
  const supported = Boolean(SpeechRecognition)

  const toggle = () => {
    if (!supported) return

    if (listening) {
      recRef.current?.stop()
      setListening(false)
      return
    }

    const rec = new SpeechRecognition()
    rec.continuous = false
    rec.interimResults = false
    rec.lang = 'en-GB'

    rec.onresult = (e) => {
      const transcript = e.results[0][0].transcript
      const combined = text ? `${text} ${transcript}` : transcript
      setText(combined)
      onTranscript?.(combined)
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)

    rec.start()
    recRef.current = rec
    setListening(true)
  }

  const handleChange = (e) => {
    setText(e.target.value)
    onTranscript?.(e.target.value)
  }

  return (
    <div className="flex gap-2 items-start">
      <textarea
        className="flex-1 bg-pool-700 rounded-lg p-3 text-sm text-pool-200 placeholder-pool-400 border border-pool-600 focus:border-accent-500 focus:outline-none resize-none"
        rows={3}
        value={text}
        onChange={handleChange}
        placeholder={placeholder}
      />
      {supported && (
        <button
          type="button"
          onClick={toggle}
          className={`rounded-full p-3 text-xl flex-shrink-0 transition-colors ${
            listening
              ? 'bg-red-500 text-white animate-pulse'
              : 'bg-pool-700 text-pool-400 hover:bg-pool-600'
          }`}
          aria-label={listening ? 'Stop recording' : 'Start voice input'}
        >
          🎤
        </button>
      )}
    </div>
  )
}
