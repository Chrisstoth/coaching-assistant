import { useEffect, useRef, useState } from 'react'
import useLiveSpeech from '../hooks/useLiveSpeech'
import useWhisperVoice, { primeMicrophone } from '../hooks/useWhisperVoice'

/* Taking the register by talking. The words show as they're said and the
   register below ticks along with them (see registerTalk.js). Phones without
   live speech record each phrase and send it, with the squad's names to help
   the spelling: slower, but still hands-free between phrases.

   Words it can't place are listed for a tap; each tap teaches it the name for
   next time. When the coach stops talking with words still unplaced, the quick
   model is asked who they might be: a suggestion to tap, never a tick.

   The page owns the register; this owns the listening and shows what was heard. */
export default function RegisterTalk({
  text, onText, result, unnamedOut, onUnnamedOut, pick, swimmers, suggestions, tidying, onTidy,
  onUndo, onClose, prompt, useGroups,
}) {
  const live = useLiveSpeech()
  const useLive = live.supported && !live.failed
  const textRef = useRef(text)
  textRef.current = text

  // The live words become the transcript as they settle.
  const lastLive = useRef('')
  // Typed or tapped: the listening carries on from the edited words.
  const edit = (next) => {
    if (useLive && live.listening) { live.rebase(next); lastLive.current = next }
    onText(next)
  }
  useEffect(() => {
    if (!useLive || !live.listening || live.text === lastLive.current) return
    lastLive.current = live.text
    onText(live.text)
  }, [live.text, live.listening, useLive]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fallback: record a phrase, send it, add the words, listen for the next.
  const [keepGoing, setKeepGoing] = useState(false)
  const recorded = useWhisperVoice(
    (said) => onText(`${textRef.current} ${said}`.trim()),
    { prompt, onNoSpeech: () => setKeepGoing(false) },
  )
  useEffect(() => {
    if (!useLive && keepGoing && !recorded.recording && !recorded.transcribing && !recorded.error) recorded.start({ autoStop: true })
  }, [useLive, keepGoing, recorded.recording, recorded.transcribing, recorded.error]) // eslint-disable-line react-hooks/exhaustive-deps

  const listening = useLive ? live.listening : keepGoing || recorded.recording || recorded.transcribing
  // Stopped talking with words still unplaced: ask who they might be.
  // A moment's wait, so the last words are in first.
  const wasListening = useRef(false)
  const tidyRef = useRef(onTidy)
  tidyRef.current = onTidy
  useEffect(() => {
    const stopped = wasListening.current && !listening
    wasListening.current = listening
    if (!stopped) return undefined
    const wait = window.setTimeout(() => tidyRef.current(), 700)
    return () => window.clearTimeout(wait)
  }, [listening])
  const toggle = () => {
    if (useLive) {
      if (live.listening) live.stop()
      else { lastLive.current = text; live.start(text) }
      return
    }
    if (keepGoing || recorded.recording) { setKeepGoing(false); recorded.stop() }
    else { primeMicrophone(); recorded.clearError(); setKeepGoing(true) }
  }
  const stopAll = () => {
    if (live.listening) live.stop()
    setKeepGoing(false)
    if (recorded.recording) recorded.cancel()
  }

  const heard = result?.heard || []
  // Everything still to place: names it half-recognised, then words it didn't know at all.
  // A word said twice is asked about once: the answer covers both.
  const leftovers = [
    ...(result?.unsure || []),
    ...(result?.unknown || []).map(word => ({ heard: word, ids: [], names: [], kind: 'unknown' })),
  ].filter((item, i, all) => all.findIndex(o => o.heard.toLowerCase() === item.heard.toLowerCase()) === i)
  const status = useLive
    ? (live.listening ? 'Listening…' : 'Tap and talk')
    : recorded.transcribing ? 'Writing that down…' : recorded.recording ? 'Listening… pause when done' : keepGoing ? 'Getting ready…' : 'Tap and talk'
  const problem = live.failed && !recorded.supported
    ? 'This phone won\'t let the app listen. Type the names below instead.'
    : recorded.error

  return (
    <div className="mx-3 mt-3 border border-accent-700/50 bg-accent-900/15 rounded-lg p-3 space-y-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-pressed={listening}
          aria-label={listening ? 'Stop listening' : 'Start talking'}
          className={`shrink-0 w-14 h-14 rounded-full flex items-center justify-center transition-colors ${listening ? 'bg-red-600 animate-pulse' : 'bg-accent-600'}`}
        >
          <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-pool-100">{status}</p>
          <p className="text-[11px] text-pool-400 leading-snug mt-0.5">
            {useGroups
              ? 'Say a group, then who\'s in it, or each name and their group. "Ben\'s off", "everyone else in Distance".'
              : 'Say who\'s here, or "everyone\'s in except Ben and Amy".'}
          </p>
        </div>
      </div>

      {problem && <p className="text-xs text-amber-300">{problem}</p>}

      <div>
        <textarea
          value={text}
          onChange={e => edit(e.target.value)}
          rows={2}
          placeholder={useGroups ? 'e.g. Group 1 Girls: Amy, Sophie, Ella. Group 2: Josh, Ben.' : 'e.g. Amy, Sophie, Josh, Ben'}
          aria-label="What was said"
          className="w-full bg-pool-800 border border-pool-600 rounded-lg px-3 py-2 text-sm text-pool-100"
        />
        {live.interim && <p className="text-xs text-pool-400 italic mt-1">{live.interim}…</p>}
      </div>

      {(heard.length > 0 || result?.bulk?.length > 0) && (
        <div className="flex flex-wrap gap-1.5" aria-label="What was heard">
          {heard.map(h => (
            <span key={h.id} className={`text-xs rounded px-2 py-1 ${h.attended ? 'bg-green-900/40 text-green-200' : 'bg-pool-700 text-pool-400 line-through'}`}>
              {h.name.split(' ')[0]}{h.attended ? (useGroups ? ` · ${h.group || 'group?'}` : '') : ' · out'}
            </span>
          ))}
          {(result?.bulk || []).map((b, i) => (
            <span key={`bulk-${i}`} className="text-xs rounded px-2 py-1 bg-teal-900/40 text-teal-200">
              {b.scope === 'rest' ? 'Everyone else' : 'Everyone'}{b.attended ? (b.group ? ` · ${b.group}` : ' · in') : ' · out'}
            </span>
          ))}
        </div>
      )}

      {leftovers.length > 0 && (
        <div className="space-y-2" aria-label="Words to check">
          {leftovers.map(item => {
            const suggested = suggestions[item.heard.toLowerCase()]
            const choices = item.names.length ? item.ids.map((id, i) => ({ id, name: item.names[i] })) : []
            return (
              <div key={item.heard} className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-amber-200">
                  {item.kind === 'ambiguous' ? `Which ${item.heard}?` : `Heard “${item.heard}”: who?`}
                </span>
                {suggested && !choices.some(c => c.id === suggested.id) && (
                  <button type="button" onClick={() => edit(pick(item.heard, suggested.id))}
                    className="text-xs rounded px-2.5 py-1.5 bg-teal-900/50 border border-teal-600/60 text-teal-100">
                    {suggested.name}?
                  </button>
                )}
                {choices.map(c => (
                  <button key={c.id} type="button" onClick={() => edit(pick(item.heard, c.id))}
                    className={`text-xs rounded px-2.5 py-1.5 border ${suggested?.id === c.id ? 'bg-teal-900/50 border-teal-600/60 text-teal-100' : 'bg-amber-900/40 border-amber-700/50 text-amber-100'}`}>
                    {c.name}
                  </button>
                ))}
                {item.kind !== 'ambiguous' && (
                  <select value="" onChange={e => e.target.value && edit(pick(item.heard, Number(e.target.value)))}
                    aria-label={`Who is ${item.heard}?`}
                    className="text-xs bg-pool-800 border border-pool-600 rounded px-2 py-1.5 text-pool-200 max-w-[10rem]">
                    <option value="">Someone else…</option>
                    {swimmers.map(sw => <option key={sw.id} value={sw.id}>{sw.name}</option>)}
                  </select>
                )}
              </div>
            )
          })}
          {tidying && <p className="text-[11px] text-pool-400">Working out who those might be…</p>}
          {!tidying && !listening && leftovers.some(item => item.kind !== 'ambiguous' && !suggestions[item.heard.toLowerCase()]) && (
            <button type="button" onClick={onTidy} className="text-[11px] text-accent-400">Work out who these might be</button>
          )}
          <p className="text-[11px] text-pool-500">Your pick is remembered, so it's ticked straight away next time.</p>
        </div>
      )}

      <label className="flex items-start gap-2 text-xs text-pool-300">
        <input type="checkbox" checked={unnamedOut} onChange={e => onUnnamedOut(e.target.checked)} className="mt-0.5" />
        <span>Anyone I don't name is out{result?.unnamedMarkedOut ? ' (done)' : ''}</span>
      </label>

      <div className="flex gap-2">
        <button type="button" onClick={() => { stopAll(); onUndo() }} disabled={!text}
          className="flex-1 bg-pool-700 rounded-lg py-2 text-xs font-semibold disabled:opacity-40">
          Undo all
        </button>
        <button type="button" onClick={() => { stopAll(); onClose() }}
          className="flex-1 bg-accent-600 rounded-lg py-2 text-xs font-semibold">
          Done talking
        </button>
      </div>
    </div>
  )
}
