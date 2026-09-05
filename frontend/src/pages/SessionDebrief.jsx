import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import useWhisperVoice from '../hooks/useWhisperVoice'

const KIND_LABELS = {
  observation: 'Note',
  benchmark: 'Benchmark',
  intent: 'Training intent',
  watchpoint: 'Watch next time',
}

const KIND_COLORS = {
  observation: 'bg-pool-700 text-pool-200',
  benchmark: 'bg-emerald-900 text-emerald-200',
  intent: 'bg-blue-900 text-blue-200',
  watchpoint: 'bg-amber-900 text-amber-200',
}

const CONFIDENCE_HINT = {
  low: 'The coach was vague here — worth checking.',
  moderate: null,
  high: null,
}

function ReviewProposal({ proposal, decision, onChange }) {
  const [editing, setEditing] = useState(false)
  const rejected = decision?.status === 'rejected'

  return (
    <div className={`rounded-xl border p-3 space-y-2 transition-opacity ${
      rejected ? 'border-pool-700/40 bg-pool-800/40 opacity-50' : 'border-pool-700 bg-pool-800'
    }`}>
      <div className="flex items-center gap-2">
        <span className={`text-[10px] rounded-full px-2 py-0.5 font-medium ${KIND_COLORS[proposal.kind] || KIND_COLORS.observation}`}>
          {KIND_LABELS[proposal.kind] || proposal.kind}
        </span>
        {proposal.confidence === 'low' && (
          <span className="text-[10px] rounded-full px-2 py-0.5 bg-amber-900/40 text-amber-300">low confidence</span>
        )}
      </div>

      {editing ? (
        <textarea
          value={decision?.content ?? proposal.content}
          onChange={e => onChange({ ...decision, status: 'accepted', content: e.target.value })}
          rows={3}
          className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none resize-none"
        />
      ) : (
        <p className="text-sm text-pool-200">{decision?.content ?? proposal.content}</p>
      )}

      {proposal.evidence && (
        <p className="text-[11px] text-pool-500 italic">you said: “{proposal.evidence}”</p>
      )}
      {CONFIDENCE_HINT[proposal.confidence] && (
        <p className="text-[11px] text-amber-400/80">{CONFIDENCE_HINT[proposal.confidence]}</p>
      )}

      <div className="flex gap-2 pt-0.5">
        <button
          onClick={() => onChange({ ...decision, status: rejected ? 'accepted' : 'rejected' })}
          className="text-[11px] text-pool-500 hover:text-pool-300"
        >
          {rejected ? 'Keep after all' : 'Drop this'}
        </button>
        {!rejected && (
          <button onClick={() => setEditing(!editing)} className="text-[11px] text-accent-400">
            {editing ? 'Done editing' : 'Edit wording'}
          </button>
        )}
      </div>
    </div>
  )
}

export default function SessionDebrief() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const sessionId = params.get('session')

  const [debrief, setDebrief] = useState(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [decisions, setDecisions] = useState({})
  const [error, setError] = useState('')
  const endRef = useRef(null)

  const {
    recording, transcribing, supported: voiceSupported,
    start: startVoice, stop: stopVoice, error: voiceError, clearError: clearVoiceError,
  } = useWhisperVoice(useCallback((text) => {
    setInput(prev => (prev ? `${prev} ${text}` : text))
  }, []))

  // Start or resume, then poll while the background write-up runs.
  useEffect(() => {
    let cancelled = false
    const open = async () => {
      try {
        const row = id
          ? await api.getSessionDebrief(id)
          : await api.startSessionDebrief(sessionId ? { session_id: Number(sessionId) } : {})
        if (cancelled) return
        setDebrief(row)
        if (!id) navigate(`/debrief/${row.id}`, { replace: true })
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
    }
    open()
    return () => { cancelled = true }
  }, [id, navigate, sessionId])

  useEffect(() => {
    if (debrief?.status !== 'processing') return undefined
    const timer = setInterval(async () => {
      try {
        const row = await api.getSessionDebrief(debrief.id)
        setDebrief(row)
      } catch { /* keep polling; the job may still be queued */ }
    }, 2500)
    return () => clearInterval(timer)
  }, [debrief?.status, debrief?.id])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [debrief?.messages?.length])

  const send = async () => {
    const message = input.trim()
    if (!message || sending) return
    setSending(true)
    setError('')
    // Show the coach's words immediately — the reply takes a moment.
    setDebrief(prev => ({ ...prev, messages: [...(prev.messages || []), { role: 'coach', message }] }))
    setInput('')
    try {
      const result = await api.sendDebriefMessage(debrief.id, message)
      setDebrief(prev => ({ ...prev, messages: result.messages }))
    } catch (e) {
      setError(e.message)
      setInput(message)
      setDebrief(prev => ({ ...prev, messages: (prev.messages || []).slice(0, -1) }))
    }
    setSending(false)
  }

  const finish = async () => {
    setFinishing(true)
    setError('')
    try {
      setDebrief(await api.completeSessionDebrief(debrief.id))
    } catch (e) { setError(e.message) }
    setFinishing(false)
  }

  const commit = async () => {
    setCommitting(true)
    setError('')
    try {
      const payload = (debrief.proposals || []).map(proposal => ({
        id: proposal.id,
        status: decisions[proposal.id]?.status || 'accepted',
        content: decisions[proposal.id]?.content ?? proposal.content,
      }))
      const result = await api.commitSessionDebrief(debrief.id, payload)
      setDebrief(result)
    } catch (e) { setError(e.message) }
    setCommitting(false)
  }

  if (error && !debrief) return <div className="p-4 text-red-400 text-sm">{error}</div>
  if (!debrief) return <div className="p-4 text-pool-400">Loading…</div>

  const keptCount = (debrief.proposals || []).filter(
    p => (decisions[p.id]?.status || 'accepted') !== 'rejected'
  ).length

  return (
    <div className="flex flex-col min-h-screen">
      <div className="bg-pool-800 px-4 pt-4 pb-3 sticky top-0 z-10">
        <div className="flex items-start gap-3">
          <Link to={debrief.session_id ? `/sessions/${debrief.session_id}` : '/'} className="text-pool-400 text-2xl leading-none">‹</Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-bold leading-tight truncate">
              {debrief.session_title || debrief.title || 'Session debrief'}
            </h1>
            <p className="text-xs text-pool-400 mt-0.5">
              {debrief.status === 'in_progress' && 'Talk it through — tap the mic'}
              {debrief.status === 'processing' && 'Writing it up…'}
              {debrief.status === 'ready' && 'Check what to save'}
              {debrief.status === 'committed' && 'Saved'}
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 px-4 py-4 space-y-3">
        {/* Conversation */}
        {debrief.status === 'in_progress' && (debrief.messages || []).map((item, index) => (
          <div key={index} className={item.role === 'coach' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm ${
              item.role === 'coach' ? 'bg-accent-600 text-white' : 'bg-pool-800 text-pool-200'
            }`}>
              {item.message}
            </div>
          </div>
        ))}
        {sending && <p className="text-xs text-pool-500">Thinking…</p>}

        {debrief.status === 'processing' && (
          <div className="rounded-2xl border border-teal-700/50 bg-teal-950/35 px-4 py-5 text-center">
            <p className="text-sm text-teal-100">Writing up the session.</p>
            <p className="text-xs text-teal-400/80 mt-1">
              This runs in the background — you can leave this page and come back.
            </p>
          </div>
        )}

        {/* Summary + review */}
        {(debrief.status === 'ready' || debrief.status === 'committed') && (
          <>
            {debrief.summary && (
              <div className="bg-pool-800 rounded-xl p-4">
                <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-1.5">Session summary</p>
                <p className="text-sm text-pool-200 whitespace-pre-line">{debrief.summary}</p>
              </div>
            )}

            {debrief.status === 'ready' && (debrief.proposals || []).length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide">
                  To save · {keptCount} of {debrief.proposals.length}
                </p>
                <p className="text-[11px] text-pool-500">
                  Nothing is on a swimmer&apos;s record until you save. Drop anything that isn&apos;t right.
                </p>
                {Object.entries((debrief.proposals || []).reduce((acc, p) => {
                  (acc[p.swimmer_name || 'Unassigned'] = acc[p.swimmer_name || 'Unassigned'] || []).push(p)
                  return acc
                }, {})).map(([name, items]) => (
                  <div key={name} className="space-y-2">
                    <p className="text-xs font-semibold text-pool-300 pt-1">{name}</p>
                    {items.map(proposal => (
                      <ReviewProposal
                        key={proposal.id}
                        proposal={proposal}
                        decision={decisions[proposal.id]}
                        onChange={(next) => setDecisions(prev => ({ ...prev, [proposal.id]: next }))}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}

            {debrief.status === 'ready' && !(debrief.proposals || []).length && (
              <p className="text-sm text-pool-400">
                Nothing specific enough to record from this one — the summary is saved above.
              </p>
            )}

            {debrief.status === 'committed' && (
              <div className="rounded-xl border border-green-700/50 bg-green-950/30 px-4 py-3">
                <p className="text-sm text-green-200">
                  Saved to {(debrief.proposals || []).filter(p => p.status === 'accepted').length} swimmer record
                  {(debrief.proposals || []).filter(p => p.status === 'accepted').length === 1 ? '' : 's'}.
                </p>
              </div>
            )}
          </>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}
        {voiceError && (
          <button onClick={clearVoiceError} className="block text-xs text-amber-400 text-left">{voiceError} (tap to dismiss)</button>
        )}
        <div ref={endRef} />
      </div>

      {/* Composer / actions */}
      <div className="sticky bottom-0 bg-pool-900 border-t border-pool-700 px-4 py-3 space-y-2">
        {debrief.status === 'in_progress' && (
          <>
            <div className="flex gap-2 items-end">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder={transcribing ? 'Transcribing…' : 'Say how it went…'}
                rows={2}
                className="flex-1 bg-pool-800 rounded-xl px-3 py-2.5 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none resize-none"
              />
              {voiceSupported && (
                <button
                  onClick={recording ? stopVoice : startVoice}
                  disabled={transcribing}
                  aria-label={recording ? 'Stop recording' : 'Start voice input'}
                  className={`rounded-full p-3 text-xl shrink-0 disabled:opacity-50 ${
                    recording ? 'bg-red-500 text-white animate-pulse' : 'bg-pool-800 text-pool-400'
                  }`}
                >
                  🎤
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={finish}
                disabled={finishing || sending}
                className="flex-1 bg-pool-700 rounded-xl py-2.5 text-sm font-semibold text-pool-200 disabled:opacity-40"
              >
                {finishing ? 'Finishing…' : 'Finish + write up'}
              </button>
              <button
                onClick={send}
                disabled={sending || !input.trim()}
                className="flex-1 bg-accent-600 rounded-xl py-2.5 text-sm font-semibold disabled:opacity-40"
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>
        )}

        {debrief.status === 'ready' && (debrief.proposals || []).length > 0 && (
          <button
            onClick={commit}
            disabled={committing}
            className="w-full bg-accent-600 rounded-xl py-3 text-sm font-semibold disabled:opacity-40"
          >
            {committing ? 'Saving…' : keptCount ? `Save ${keptCount} to swimmer records` : 'Save nothing'}
          </button>
        )}

        {(debrief.status === 'committed' || (debrief.status === 'ready' && !(debrief.proposals || []).length)) && (
          <button
            onClick={() => navigate(debrief.session_id ? `/sessions/${debrief.session_id}` : '/')}
            className="w-full bg-pool-700 rounded-xl py-3 text-sm font-semibold text-pool-200"
          >
            Done
          </button>
        )}
      </div>
    </div>
  )
}
