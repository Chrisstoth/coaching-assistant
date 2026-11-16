import { useCallback, useEffect, useRef, useState } from 'react'

const Recognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null

/**
 * The phone's own speech recognition, kept listening until stopped: words show
 * as they are said, with no upload and no wait. One phrase at a time
 * (continuous mode repeats words on Android), restarted after each pause.
 *
 * `text` is everything settled so far; `interim` the words still being said.
 * `failed` is set when this phone won't do it (blocked, or no speech service),
 * so the caller can fall back to recording.
 */
export default function useLiveSpeech({ lang = 'en-GB' } = {}) {
  const [listening, setListening] = useState(false)
  const [text, setText] = useState('')
  const [interim, setInterim] = useState('')
  const [failed, setFailed] = useState(null)
  const wanted = useRef(false)
  const current = useRef(null)
  const settled = useRef('')

  const listen = useCallback(() => {
    const rec = new Recognition()
    rec.lang = lang
    rec.continuous = false
    rec.interimResults = true
    rec.maxAlternatives = 1
    let phrase = ''
    rec.onresult = (event) => {
      let done = ''
      let going = ''
      for (let i = 0; i < event.results.length; i += 1) {
        const said = event.results[i][0].transcript
        if (event.results[i].isFinal) done += `${said} `
        else going += said
      }
      phrase = done.trim()
      setText(`${settled.current} ${phrase}`.trim())
      setInterim(going.trim())
    }
    rec.onerror = (event) => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(event.error)) {
        wanted.current = false
        setFailed(event.error)
      }
    }
    rec.onend = () => {
      if (phrase) settled.current = `${settled.current} ${phrase}`.trim()
      setInterim('')
      if (!wanted.current) { setListening(false); return }
      try { listen() } catch { wanted.current = false; setListening(false) }
    }
    current.current = rec
    rec.start()
  }, [lang])

  const start = useCallback((from = '') => {
    if (!Recognition || wanted.current) return
    settled.current = from
    setText(from)
    setInterim('')
    setFailed(null)
    wanted.current = true
    try {
      listen()
      setListening(true)
    } catch {
      wanted.current = false
      setFailed('start')
    }
  }, [listen])

  const stop = useCallback(() => {
    wanted.current = false
    try { current.current?.stop() } catch { /* already stopped */ }
    setListening(false)
  }, [])

  // The words were edited (typed, or a name tapped) while listening: carry on from those.
  const rebase = useCallback((from) => {
    settled.current = from
    setText(from)
  }, [])

  useEffect(() => () => {
    wanted.current = false
    try { current.current?.abort() } catch { /* already stopped */ }
  }, [])

  return { supported: Boolean(Recognition), listening, text, interim, failed, start, stop, rebase }
}
