import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../api'

function ThinkingDots() {
  return (
    <div className="flex gap-1 items-center h-5">
      {[0, 1, 2].map(i => (
        <div
          key={i}
          className="w-1.5 h-1.5 bg-pool-400 rounded-full animate-bounce"
          style={{ animationDelay: `${i * 150}ms`, animationDuration: '0.9s' }}
        />
      ))}
    </div>
  )
}

function MessageContent({ text }) {
  const lines = text.split('\n')
  return (
    <div className="space-y-1">
      {lines.map((line, i) => (
        line.trim() === '' ? <br key={i} /> : <p key={i}>{line}</p>
      ))}
    </div>
  )
}

const FOUNDATION_FIELDS = {
  physical: [
    ['aerobic_base', 'Aerobic base'],
    ['sprint_tendency', 'Sprint and power'],
    ['race_pattern', 'Race patterns'],
    ['fatigue_profile', 'Fatigue and recovery'],
    ['training_response', 'Training response'],
  ],
  psychological: [
    ['motivation_style', 'Motivation'],
    ['competition_response', 'Competition mindset'],
    ['response_to_hard_training', 'Response to hard training'],
    ['coachability', 'Coachability and feedback'],
  ],
}

function FoundationDraftReview({ draft, saving, onSave, onCancel }) {
  const [form, setForm] = useState(() => ({
    physical: Object.fromEntries(
      FOUNDATION_FIELDS.physical.map(([key]) => [key, draft.physical?.[key]?.value || '']),
    ),
    psychological: Object.fromEntries(
      FOUNDATION_FIELDS.psychological.map(([key]) => [key, draft.psychological?.[key]?.value || '']),
    ),
  }))

  const update = (section, field, value) => {
    setForm(previous => ({
      ...previous,
      [section]: { ...previous[section], [field]: value },
    }))
  }
  const allFields = [...FOUNDATION_FIELDS.physical, ...FOUNDATION_FIELDS.psychological]
  const filled = allFields.filter(([key]) => (
    (form.physical[key] || form.psychological[key] || '').trim()
  )).length
  const sourceCounts = draft.source_counts || {}

  const confidenceStyle = {
    confirmed: 'bg-green-900/30 text-green-300 border-green-800/50',
    supported: 'bg-blue-900/30 text-blue-300 border-blue-800/50',
    missing: 'bg-amber-900/30 text-amber-300 border-amber-800/50',
  }
  const confidenceLabel = {
    confirmed: 'Already confirmed',
    supported: 'Existing evidence',
    missing: 'Needs your input',
  }

  return (
    <div className="space-y-4">
      <div className="bg-pool-800 border border-pool-700 rounded-2xl p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-pool-100">Review the carry-over draft</p>
            <p className="text-xs text-pool-400 mt-1 leading-relaxed">
              Edit anything that is inaccurate. Blank fields remain unconfirmed and can be completed through the interview later.
            </p>
          </div>
          <button type="button" onClick={onCancel} disabled={saving} className="text-pool-500 text-lg">×</button>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-3 text-[10px] text-pool-400">
          <span className="bg-pool-900/60 rounded-md px-2 py-1">{sourceCounts.living_profiles || 0} living profiles</span>
          <span className="bg-pool-900/60 rounded-md px-2 py-1">{sourceCounts.observations || 0} observations</span>
          <span className="bg-pool-900/60 rounded-md px-2 py-1">{sourceCounts.coaching_notes || 0} coaching notes</span>
        </div>
      </div>

      {Object.entries(FOUNDATION_FIELDS).map(([section, fields]) => (
        <section key={section} className="space-y-2.5">
          <h2 className="text-xs uppercase tracking-wide text-pool-500 px-1">
            {section === 'physical' ? 'Physical foundation' : 'Psychological foundation'}
          </h2>
          {fields.map(([key, label]) => {
            const evidence = draft[section]?.[key] || { confidence: 'missing', evidence: '' }
            const confidence = evidence.confidence || 'missing'
            return (
              <label key={key} className="block bg-pool-800 border border-pool-700 rounded-xl p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-semibold text-pool-200">{label}</span>
                  <span className={`text-[9px] border rounded-full px-2 py-0.5 ${confidenceStyle[confidence] || confidenceStyle.missing}`}>
                    {confidenceLabel[confidence] || confidenceLabel.missing}
                  </span>
                </div>
                <textarea
                  value={form[section][key]}
                  onChange={event => update(section, key, event.target.value)}
                  rows={form[section][key] ? 3 : 2}
                  placeholder="Add what you know, or leave blank for the interview"
                  className="w-full bg-pool-900/60 border border-pool-600 rounded-lg px-3 py-2 text-xs text-pool-100 placeholder-pool-600 resize-y focus:outline-none focus:border-accent-500"
                />
                <p className="text-[10px] text-pool-500 mt-1.5 leading-relaxed">{evidence.evidence}</p>
              </label>
            )
          })}
        </section>
      ))}

      <div className="sticky bottom-0 bg-pool-950/95 border-t border-pool-700 py-3 space-y-2">
        <p className="text-[10px] text-pool-500 text-center">
          {filled}/9 fields ready · {9 - filled} will remain to cover
        </p>
        <button
          type="button"
          onClick={() => onSave(form)}
          disabled={saving || filled === 0}
          className="w-full bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded-xl py-3 text-sm font-semibold"
        >
          {saving ? 'Saving reviewed foundation…' : 'Confirm and save reviewed fields'}
        </button>
        <p className="text-[10px] text-pool-600 text-center">Only this confirmation writes to the swimmer’s foundation.</p>
      </div>
    </div>
  )
}

export default function ProfileWizard() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [swimmer, setSwimmer] = useState(null)
  const [messages, setMessages] = useState([]) // [{role:'user'|'assistant', content:'...'}]
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)  // initial AI opener
  const [sending, setSending] = useState(false)
  const [pendingReply, setPendingReply] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState('loading') // loading | choice | chat | draft
  const [draft, setDraft] = useState(null)
  const [drafting, setDrafting] = useState(false)
  const [draftSaving, setDraftSaving] = useState(false)

  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  const recoverAfterRequestError = useCallback(async (submittedMessages, requestError) => {
    try {
      const interviewDraft = await api.getProfileWizardDraft(id)
      const stored = interviewDraft.messages || []
      const completedReply = (
        stored.length === submittedMessages.length + 1
        && stored.slice(0, -1).every((message, index) => (
          message.role === submittedMessages[index]?.role
          && message.content === submittedMessages[index]?.content
        ))
        && stored.at(-1)?.role === 'assistant'
      )
      if (completedReply) {
        setMessages(stored)
        setPendingReply(false)
        return
      }
      if (interviewDraft.awaiting_reply) {
        setPendingReply(true)
        return
      }
    } catch {
      // Fall through to the request error while retaining the on-screen answer.
    }
    setError(requestError?.name === 'TimeoutError'
      ? 'The reply is taking longer than expected. Your answer is still here; try the reply again.'
      : requestError.message)
  }, [id])

  const startInterview = useCallback(async () => {
    setMode('chat')
    setLoading(true)
    setError(null)
    setMessages([])
    setPendingReply(false)
    try {
      await api.discardProfileWizardDraft(id)
      const data = await api.profileWizardChat(id, [])
      if (data.pending) {
        setPendingReply(true)
      } else {
        setMessages([{ role: 'assistant', content: data.reply }])
      }
    } catch (e) {
      await recoverAfterRequestError([], e)
    }
    setLoading(false)
  }, [id, recoverAfterRequestError])

  // Restore a server-side interview draft before showing the start choices.
  useEffect(() => {
    if (!id) return
    Promise.all([api.getSwimmer(id), api.getProfileWizardDraft(id)])
      .then(([swimmerData, interviewDraft]) => {
        setSwimmer(swimmerData)
        if (interviewDraft.messages?.length || interviewDraft.awaiting_reply) {
          setMessages(interviewDraft.messages || [])
          setPendingReply(Boolean(interviewDraft.awaiting_reply))
          setMode('chat')
        } else if (swimmerData.profile_status?.has_profile) {
          setMode('choice')
        } else {
          startInterview()
          return
        }
        setLoading(false)
      })
      .catch(e => {
        setError(e.message)
        setLoading(false)
      })
  }, [id, startInterview])

  // A reply may finish after navigation or a dropped browser connection. Poll
  // the persisted draft so it appears as soon as the server has saved it.
  useEffect(() => {
    if (!pendingReply || !id) return undefined
    let cancelled = false
    const check = async () => {
      try {
        const interviewDraft = await api.getProfileWizardDraft(id)
        if (cancelled) return
        if (!interviewDraft.awaiting_reply) {
          setMessages(interviewDraft.messages || [])
          setPendingReply(false)
          if (interviewDraft.messages?.at(-1)?.role !== 'assistant') {
            setError('The reply did not finish, but your answer is saved. Try the reply again.')
          }
        }
      } catch {
        // Keep the visible draft and try again; no coach answer is lost.
      }
    }
    check()
    const timer = window.setInterval(check, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [id, pendingReply])

  // Scroll to bottom on new message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setError(null)

    const userMsg = { role: 'user', content: text }
    const next = [...messages, userMsg]
    setMessages(next)
    setSending(true)

    try {
      const data = await api.profileWizardChat(id, next)
      if (data.pending) {
        setPendingReply(true)
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: data.reply }])
      }
    } catch (e) {
      await recoverAfterRequestError(next, e)
    }
    setSending(false)
  }, [id, input, messages, recoverAfterRequestError, sending])

  const retryLastReply = async () => {
    if (sending || messages.at(-1)?.role !== 'user') return
    setSending(true)
    setPendingReply(false)
    setError(null)
    try {
      const data = await api.profileWizardChat(id, messages, true)
      if (data.pending) {
        setPendingReply(true)
      } else {
        setMessages(previous => [...previous, { role: 'assistant', content: data.reply }])
      }
    } catch (e) {
      await recoverAfterRequestError(messages, e)
    }
    setSending(false)
  }

  const discardInterview = async () => {
    if (!window.confirm('Discard this unfinished interview and start again? The confirmed swimmer profile will not change.')) return
    setError(null)
    try {
      await api.discardProfileWizardDraft(id)
      setMessages([])
      setPendingReply(false)
      setMode('choice')
    } catch (e) {
      setError(e.message)
    }
  }

  const saveProfile = async () => {
    if (saving || saved) return
    setSaving(true)
    setError(null)
    try {
      await api.profileWizardSave(id, messages)
      setPendingReply(false)
      setSaved(true)
    } catch (e) {
      setError(e.message)
    }
    setSaving(false)
  }

  const prepareExistingDraft = async () => {
    if (drafting) return
    setDrafting(true)
    setError(null)
    try {
      const result = await api.previewFoundationFromEvidence(id)
      setDraft(result)
      setMode('draft')
    } catch (e) {
      setError(e.message)
    }
    setDrafting(false)
  }

  const saveReviewedDraft = async (reviewed) => {
    if (draftSaving) return
    setDraftSaving(true)
    setError(null)
    try {
      await api.saveReviewedFoundation(id, reviewed)
      setSaved(true)
    } catch (e) {
      setError(e.message)
    }
    setDraftSaving(false)
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const canSave = messages.length >= 6 && messages.at(-1)?.role === 'assistant' && !saved // at least a few exchanges

  return (
    <div className="fixed inset-0 bg-pool-950 flex flex-col max-w-lg mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between px-4 h-14 border-b border-pool-700/60 shrink-0">
        <button
          onClick={() => navigate(`/swimmers/${id}`)}
          className="flex items-center gap-2 text-pool-400 hover:text-pool-200 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
          </svg>
          <span className="text-sm">{swimmer?.name || 'Back'}</span>
        </button>

        <div className="text-center">
          <p className="text-sm font-semibold text-pool-100">Foundation Profile</p>
          {swimmer && <p className="text-xs text-pool-500">{swimmer.name}</p>}
        </div>

        {mode === 'chat' ? (
        <button
          onClick={saveProfile}
          disabled={!canSave || saving || saved}
          className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
            saved
              ? 'bg-green-800/50 text-green-400'
              : canSave
              ? 'bg-accent-600 text-white hover:bg-accent-500'
              : 'text-pool-600 cursor-not-allowed'
          }`}
        >
          {saved ? 'Saved' : saving ? 'Saving…' : 'Save Profile'}
        </button>
        ) : <span className="w-16" />}
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        <div className="bg-accent-700/20 border border-accent-700/40 rounded-xl px-3 py-2.5">
          <p className="text-xs font-medium text-accent-400">One foundation, nine coaching areas</p>
          <p className="text-[11px] text-pool-400 mt-1 leading-relaxed">
            Complete this core picture once. Future confirmed notes add to it, while race, training and technical summaries develop separately through the season.
          </p>
        </div>

        {mode === 'choice' && !saved && (
          <div className="bg-pool-800 border border-pool-700 rounded-2xl p-4 space-y-4">
            <div>
              <p className="text-sm font-semibold text-pool-100">Existing evidence is ready to review</p>
              <p className="text-xs text-pool-400 mt-1 leading-relaxed">
                LANEWATCH can draft the nine foundation areas from existing living profiles, observations and coaching notes. You will review every field before anything is saved.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="bg-pool-900/50 rounded-xl px-3 py-2">
                <p className="text-lg font-semibold text-accent-300">{swimmer?.profile_status?.living_built || 0}/{swimmer?.profile_status?.living_total || 4}</p>
                <p className="text-[10px] text-pool-500">living sections</p>
              </div>
              <div className="bg-pool-900/50 rounded-xl px-3 py-2">
                <p className="text-lg font-semibold text-amber-300">{swimmer?.profile_status?.completed_areas || 0}/{swimmer?.profile_status?.total_areas || 9}</p>
                <p className="text-[10px] text-pool-500">foundation confirmed</p>
              </div>
            </div>
            <button
              type="button"
              onClick={prepareExistingDraft}
              disabled={drafting}
              className="w-full bg-accent-600 hover:bg-accent-500 disabled:opacity-50 rounded-xl py-3 text-sm font-semibold"
            >
              {drafting ? 'Reviewing existing evidence…' : 'Draft from existing evidence'}
            </button>
            <button
              type="button"
              onClick={startInterview}
              disabled={drafting}
              className="w-full border border-pool-600 text-pool-300 rounded-xl py-2.5 text-xs font-semibold disabled:opacity-50"
            >
              Continue with interview instead
            </button>
            <p className="text-[10px] text-pool-600 text-center">Drafting does not change the swimmer’s profile.</p>
          </div>
        )}

        {mode === 'draft' && draft && !saved && (
          <FoundationDraftReview
            draft={draft}
            saving={draftSaving}
            onSave={saveReviewedDraft}
            onCancel={() => {
              setDraft(null)
              setMode('choice')
            }}
          />
        )}

        {mode === 'chat' && messages.length > 0 && !saved && (
          <div className="flex items-center justify-between gap-3 bg-pool-900/60 border border-pool-700 rounded-xl px-3 py-2">
            <p className="text-[10px] text-pool-500 leading-relaxed">
              Interview draft saved automatically — you can leave and return here.
            </p>
            <button
              type="button"
              onClick={discardInterview}
              disabled={sending || pendingReply}
              className="shrink-0 text-[10px] text-pool-400 underline disabled:opacity-40"
            >
              Start over
            </button>
          </div>
        )}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-pool-700 rounded-2xl rounded-bl-sm px-4 py-3">
              <ThinkingDots />
            </div>
          </div>
        )}

        {mode === 'chat' && !loading && messages.length === 0 && !error && (
          <p className="text-pool-500 text-sm text-center pt-8">Starting profiling session…</p>
        )}

        {mode === 'chat' && messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
              m.role === 'user'
                ? 'bg-accent-700 text-white rounded-br-sm'
                : 'bg-pool-700 text-pool-200 rounded-bl-sm'
            }`}>
              <MessageContent text={m.content} />
            </div>
          </div>
        ))}

        {mode === 'chat' && sending && (
          <div className="flex justify-start">
            <div className="bg-pool-700 rounded-2xl rounded-bl-sm px-4 py-3">
              <ThinkingDots />
            </div>
          </div>
        )}

        {mode === 'chat' && pendingReply && !sending && (
          <div className="bg-amber-900/20 border border-amber-800/50 rounded-xl px-3 py-2.5">
            <div className="flex items-center gap-2">
              <ThinkingDots />
              <p className="text-xs text-amber-200">Your answer is saved. Waiting for the reply…</p>
            </div>
            <p className="text-[10px] text-pool-500 mt-1.5">You can leave this screen; the interview will resume here.</p>
          </div>
        )}

        {error && (
          <div className="bg-red-900/20 border border-red-800/50 rounded-xl px-3 py-2 text-xs text-red-300">
            {error}
            {mode === 'chat' && messages.at(-1)?.role === 'user' && !sending && !pendingReply && (
              <button
                type="button"
                onClick={retryLastReply}
                className="block mt-2 text-red-200 underline font-semibold"
              >
                Try the reply again
              </button>
            )}
          </div>
        )}

        {saved && (
          <div className="bg-green-900/20 border border-green-800/50 rounded-xl px-4 py-3 text-sm text-green-300 text-center">
            Foundation saved — {swimmer?.name}'s existing profile has been safely updated.
            <br />
            <button
              onClick={() => navigate(`/swimmers/${id}`)}
              className="mt-2 text-xs text-green-400 underline"
            >
              Back to {swimmer?.name}
            </button>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      {!saved && mode === 'chat' && (
        <div className="px-4 pb-6 pt-2 border-t border-pool-700/60 shrink-0">
          <div className="flex items-end gap-2 bg-pool-800 border border-pool-600 rounded-2xl px-3 py-2.5 focus-within:border-accent-500 transition-colors">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              disabled={pendingReply}
              placeholder="Reply…"
              rows={1}
              className="flex-1 bg-transparent text-sm text-pool-100 placeholder-pool-500 resize-none focus:outline-none leading-relaxed"
              style={{ maxHeight: '120px', overflowY: 'auto' }}
              onInput={e => {
                e.target.style.height = 'auto'
                e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
              }}
            />
            <button
              onClick={send}
              disabled={!input.trim() || sending || pendingReply}
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-accent-600 disabled:opacity-40 transition-opacity"
            >
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 10.5 7.5-7.5m0 0 7.5 7.5M12 3v18" />
              </svg>
            </button>
          </div>
          {!canSave && messages.length > 0 && !saved && (
            <p className="text-xs text-pool-600 text-center mt-2">
              Continue the conversation — "Save Profile" unlocks after a few exchanges
            </p>
          )}
        </div>
      )}
    </div>
  )
}
