import { useEffect, useState } from 'react'
import { onSpeaking, say, speakingNow, stop } from '../staffSpeech'
import { staffStyle } from '../staffRoom'

export function useSpeaking() {
  const [playing, setPlaying] = useState(speakingNow())
  useEffect(() => onSpeaking(setPlaying), [])
  return playing
}

// Hear this line in the speaker's own voice; tap again to stop.
export default function SpeakButton({ text, speaker, speakKey, className = '' }) {
  const playing = useSpeaking()
  const active = playing && playing.key === speakKey
  const title = staffStyle(speaker).name || `the ${staffStyle(speaker).title}`
  return (
    <button
      type="button"
      onClick={() => (active ? stop() : say({ text, speaker, key: speakKey }))}
      className={`inline-flex items-center gap-1 text-[10px] ${active ? 'text-accent-300' : 'text-pool-500 hover:text-pool-300'} ${className}`}
      aria-label={active ? `Stop ${title}` : `Hear ${title}`}
    >
      {active ? (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
        </svg>
      )}
      {active ? 'Stop' : 'Hear'}
    </button>
  )
}
