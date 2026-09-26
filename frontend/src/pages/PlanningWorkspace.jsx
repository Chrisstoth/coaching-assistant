import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import SeasonTimeline from '../components/SeasonTimeline'
import PathwayBoard from '../components/PathwayBoard'
import { describeDraft, draftFromResult, saveDraft, takeStashedDraft } from '../planDrafts'
import StaffVoices, { StaffThinking } from '../components/StaffVoices'
import StaffNotesPanel from '../components/StaffNotesPanel'
import { draftTopic, mergeConversation } from '../staffRoom'

// The planning conversation and the picture it produces, side by side.
//
// The year comes first: divide it into macrocycles, then pick one and plan what
// goes inside it. The macrocycle in focus is passed with every message, so the
// assistant plans that one rather than guessing from today's date.

// Only one layout is mounted. Rendering both and hiding one with CSS would run
// two chat panels, each trying to open the planning thread at once.
function useIsWide() {
  const query = '(min-width: 1024px)'
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches
  const [wide, setWide] = useState(read)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia(query)
    const onChange = (e) => setWide(e.matches)
    setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return wide
}

function weekSpan(macro) {
  const days = (new Date(`${macro.date_to}T00:00:00`) - new Date(`${macro.date_from}T00:00:00`)) / 86400000
  return Math.max(1, Math.round((days + 1) / 7))
}

function suggestionsFor(macros, macro) {
  if (macros.length === 0) {
    return [{ label: 'Divide the year into macrocycles', text: 'Divide the year into macrocycles around my key meets.' }]
  }
  const out = []
  if (macro) {
    const planned = (macro.mesos || []).length > 0
    out.push(planned
      ? { label: 'Plan the next block', text: 'Plan the next block in this macrocycle.' }
      : { label: 'Plan this macrocycle', text: 'Plan the phases inside this macrocycle.' })
  }
  out.push({
    label: 'Branch the pathways',
    text: 'Who is aiming at which meet, and where do the others go if they miss the qualifying time?',
  })
  return out
}

function ChatPanel({ macro, macros, onDraft, onPlanChanged, onStaffChanged }) {
  const navigate = useNavigate()
  const [thread, setThread] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [action, setAction] = useState(null)
  const [staffNotes, setStaffNotes] = useState([])
  const [staffThinking, setStaffThinking] = useState(false)
  const endRef = useRef(null)

  const loadStaff = async (threadId) => {
    const rows = await api.getStaffNotes({ thread_id: threadId, limit: 100 }).catch(() => null)
    if (Array.isArray(rows)) setStaffNotes(rows)
  }

  // One planning conversation for the whole year. Which macrocycle it is about
  // travels with each message instead of splitting the history per macro.
  useEffect(() => {
    let cancelled = false
    api.getOrCreateSeasonPlanThread()
      .then(async (t) => {
        if (cancelled) return
        setThread(t)
        const msgs = await api.getAIChatMessages(t.id).catch(() => [])
        if (!cancelled) setMessages(Array.isArray(msgs) ? msgs : [])
        if (!cancelled) loadStaff(t.id)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, sending, staffNotes, staffThinking])

  const send = async (override) => {
    const text = (override ?? input).trim()
    if (!text || sending || !thread) return
    setInput('')
    setAction(null)
    setMessages(prev => [...prev, { id: `local-${Date.now()}`, role: 'user', message: text }])
    setSending(true)
    try {
      const res = await api.sendAIChatMessage(text, thread.id, false, macro ? macro.id : null)
      const fresh = await api.getAIChatMessages(thread.id).catch(() => null)
      if (Array.isArray(fresh)) setMessages(fresh)
      else if (res.reply) {
        setMessages(prev => [...prev, { id: `reply-${Date.now()}`, role: 'assistant', message: res.reply }])
      }
      const drafted = draftFromResult(res)
      if (drafted) onDraft(drafted)
      else if (res.suggested_action && typeof res.suggested_action === 'object') setAction(res.suggested_action)
      onPlanChanged()
      convene(text, res.reply, drafted)
    } catch (e) {
      setMessages(prev => [...prev, {
        id: `err-${Date.now()}`, role: 'assistant',
        message: `Something went wrong sending that: ${e.message}`,
      }])
    }
    setSending(false)
  }

  // The staff hear what the coach said, what the lead assistant answered, and any
  // plan it proposed. The chair decides whether anyone has something to add, so
  // most exchanges cost one cheap call and produce nothing.
  const convene = async (coachText, reply, drafted) => {
    const topic = [
      `Coach: ${coachText}`,
      reply ? `Lead assistant replied: ${String(reply).slice(0, 900)}` : '',
      drafted ? draftTopic(describeDraft(drafted.kind, drafted.draft)) : '',
    ].filter(Boolean).join('\n\n')
    setStaffThinking(true)
    try {
      await api.conveneStaff({
        topic,
        trigger: drafted ? 'plan_draft' : 'coach_message',
        coach_text: coachText,
        thread_id: thread.id,
        macro_id: macro ? macro.id : null,
      })
      await loadStaff(thread.id)
      if (onStaffChanged) onStaffChanged()
    } catch {
      // A quiet staff room is better than a broken conversation.
    }
    setStaffThinking(false)
  }

  const takeAction = () => {
    if (action && action.meet_id) navigate(`/meets/${action.meet_id}`)
  }

  const suggestions = suggestionsFor(macros, macro)

  return (
    <div className="flex flex-col h-full min-h-0">
      {macro && (
        <p className="text-[11px] text-pool-400 pb-2 shrink-0 truncate">
          Planning <span className="text-pool-200 font-semibold">{macro.name}</span>
          <span className="text-pool-500"> · {weekSpan(macro)}w · {(macro.mesos || []).length} blocks</span>
        </p>
      )}

      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {messages.length === 0 && (
          <div className="bg-pool-800 rounded-xl p-4 space-y-2">
            <p className="text-sm text-pool-200 font-medium">Start with the shape of the year.</p>
            <p className="text-xs text-pool-400 leading-relaxed">
              Divide it into macrocycles around the meets that matter. Then pick one and plan what
              goes inside it, and who is aiming at what. The picture builds as you talk.
            </p>
          </div>
        )}

        {mergeConversation(messages, staffNotes).map(item => item.type === 'staff' ? (
          <StaffVoices
            key={`staff-${item.thread.note.id}`}
            notes={[item.thread.note, ...item.thread.replies]}
            onChanged={() => { loadStaff(thread.id); if (onStaffChanged) onStaffChanged() }}
            onActed={onPlanChanged}
          />
        ) : (
          <div key={item.message.id} className={item.message.role === 'user' ? 'flex justify-end' : ''}>
            <div className={`rounded-2xl px-3.5 py-2.5 max-w-[92%] text-sm leading-relaxed whitespace-pre-wrap ${
              item.message.role === 'user' ? 'bg-accent-700 text-white' : 'bg-pool-800 text-pool-200'
            }`}>
              {item.message.message}
            </div>
          </div>
        ))}

        {staffThinking && <StaffThinking />}

        {sending && (
          <div className="bg-pool-800 rounded-2xl px-3.5 py-2.5 text-sm text-pool-500 w-fit">Thinking…</div>
        )}

        {action && !sending && (
          <button
            onClick={takeAction}
            className="w-full bg-accent-900/40 border border-accent-700/60 rounded-xl px-3 py-2.5 text-left"
          >
            <p className="text-xs font-semibold text-accent-200">{action.label || 'Open'}</p>
          </button>
        )}

        <div ref={endRef} />
      </div>

      <div className="pt-2 shrink-0 space-y-2">
        {suggestions.length > 0 && !sending && (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map(sug => (
              <button
                key={sug.label}
                onClick={() => send(sug.text)}
                disabled={!thread}
                className="text-[11px] bg-pool-800 border border-pool-600 text-pool-300 rounded-full px-3 py-1 disabled:opacity-40"
              >
                {sug.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
            }}
            rows={1}
            placeholder="Talk through the season…"
            className="flex-1 bg-pool-700 border border-pool-600 rounded-xl px-3 py-2.5 text-sm text-pool-100 placeholder-pool-500 focus:border-accent-500 focus:outline-none resize-none max-h-32"
          />
          <button
            onClick={() => send()}
            disabled={sending || !input.trim() || !thread}
            className="bg-accent-600 disabled:opacity-40 rounded-xl px-4 py-2.5 text-sm font-semibold text-white shrink-0"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

function DraftCard({ kind, draft, macros, macroId, onSaved, onDismiss }) {
  const [saving, setSaving] = useState(false)
  const view = describeDraft(kind, draft)

  const save = async () => {
    setSaving(true)
    try {
      const result = await saveDraft(kind, draft, { api, macros, macroId })
      onSaved(result)
    } catch (e) {
      alert('Could not save this: ' + e.message)
    }
    setSaving(false)
  }

  return (
    <section className="bg-accent-900/30 border border-accent-700/60 rounded-2xl p-4 space-y-3">
      <div>
        <p className="text-xs uppercase tracking-wide font-semibold text-accent-300">{view.heading}</p>
        {view.title && <p className="text-sm font-semibold text-pool-100 mt-1">{view.title}</p>}
        {view.note && <p className="text-xs text-pool-400 mt-1 leading-relaxed">{view.note}</p>}
      </div>

      <div className="space-y-2">
        {view.items.map(item => (
          <div key={item.key} className="bg-pool-900/40 rounded-xl p-3 space-y-1">
            <p className="text-sm font-semibold text-pool-100">{item.title}</p>
            {item.detail && <p className="text-xs text-pool-300">{item.detail}</p>}
            {item.body && <p className="text-xs text-pool-400 leading-relaxed">{item.body}</p>}
            {item.chips && item.chips.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {item.chips.map(name => (
                  <span key={name} className="text-[10px] bg-pool-700 text-pool-300 rounded-full px-2 py-0.5">{name}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {view.warnings.map((w, i) => <p key={`w-${i}`} className="text-xs text-yellow-300">{w}</p>)}
      {view.questions.map((q, i) => <p key={`q-${i}`} className="text-xs text-yellow-300">{q}</p>)}

      <div className="flex gap-2">
        <button onClick={onDismiss} className="px-4 py-2.5 text-xs bg-pool-700 rounded-xl">Dismiss</button>
        <button
          onClick={save}
          disabled={saving || view.items.length === 0}
          className="flex-1 py-2.5 text-xs font-semibold bg-accent-600 rounded-xl disabled:opacity-40"
        >
          {saving ? 'Saving…' : view.saveLabel}
        </button>
      </div>
    </section>
  )
}

export default function PlanningWorkspace() {
  const [macros, setMacros] = useState([])
  const [macroId, setMacroId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('plan')      // phone only: 'chat' | 'plan'
  const [refreshKey, setRefreshKey] = useState(0)
  const [pending, setPending] = useState(null) // { kind, draft } awaiting approval
  const [staffKey, setStaffKey] = useState(0)
  const wide = useIsWide()

  const loadMacros = async () => {
    try {
      const rows = await api.getMacros()
      const list = Array.isArray(rows) ? rows : []
      setMacros(list)
      setMacroId(prev => (prev && list.some(m => m.id === prev))
        ? prev
        : ((list.find(m => m.is_current) || list[0])?.id ?? null))
    } catch {
      setMacros([])
    }
    setLoading(false)
  }

  useEffect(() => {
    loadMacros()
    // A draft made on the main AI chat lands here to be reviewed.
    const stashed = takeStashedDraft()
    if (stashed) setPending(stashed)
  }, [])

  const planChanged = () => {
    setRefreshKey(k => k + 1)
    loadMacros()
  }

  const macro = macros.find(m => m.id === macroId) || null

  const visual = (
    <div className="space-y-4">
      {pending && (
        <DraftCard
          kind={pending.kind}
          draft={pending.draft}
          macros={macros}
          macroId={macroId}
          onSaved={(result) => {
            setPending(null)
            if (result && result.macroId) setMacroId(result.macroId)
            planChanged()
          }}
          onDismiss={() => setPending(null)}
        />
      )}

      {macros.length > 0 ? (
        <SeasonTimeline
          key={`tl-${refreshKey}-${staffKey}`}
          macros={macros}
          selectedMacroId={macroId}
          onSelectMacro={setMacroId}
        />
      ) : !loading && (
        <div className="bg-pool-800 rounded-2xl p-5 text-center space-y-2">
          <p className="text-sm text-pool-300 font-medium">Nothing planned yet</p>
          <p className="text-xs text-pool-500 leading-relaxed">
            Ask the assistant to divide the year into macrocycles. They appear here as empty bands,
            and fill in as you plan each one.
          </p>
        </div>
      )}

      <StaffNotesPanel macroId={macroId} refreshKey={staffKey} onActed={planChanged}
        title="Staff notes on this macrocycle" />

      <PathwayBoard key={`pb-${refreshKey}`} macroId={macroId} />

      <Link to="/season" className="block text-center text-xs text-accent-400 underline pb-4">
        Open the full season plan →
      </Link>
    </div>
  )

  const chat = (
    <ChatPanel
      macro={macro}
      macros={macros}
      onDraft={(drafted) => { setPending(drafted); setTab('plan') }}
      onPlanChanged={planChanged}
      onStaffChanged={() => setStaffKey(k => k + 1)}
    />
  )

  return (
    <div className="flex flex-col h-screen">
      <div className="bg-pool-800 px-4 pt-4 pb-3 shrink-0 border-b border-pool-700">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-lg font-bold">Planning</h1>
            <p className="text-xs text-pool-500 mt-0.5 truncate">Divide the year, then plan each macrocycle</p>
          </div>
          {macros.length > 1 && (
            <select
              value={macroId || ''}
              onChange={e => setMacroId(Number(e.target.value) || null)}
              className="bg-pool-700 border border-pool-600 rounded-lg px-2 py-1 text-xs text-pool-200 focus:outline-none max-w-[45%] shrink-0"
            >
              {macros.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
        </div>

        {/* Phone: one at a time. Wide: both at once, so this is hidden. */}
        <div className="flex gap-1 mt-3 lg:hidden">
          {['plan', 'chat'].map(key => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex-1 py-1.5 text-xs font-semibold rounded-lg ${
                tab === key ? 'bg-pool-700 text-pool-100' : 'text-pool-500'
              }`}
            >
              {key === 'plan' ? 'Plan' : 'Discuss'}
            </button>
          ))}
        </div>
      </div>

      {wide ? (
        /* Wide: conversation beside the picture it produces */
        <div className="flex-1 min-h-0 flex">
          <div className="w-[38%] min-w-[320px] max-w-[520px] border-r border-pool-700 p-4 flex flex-col min-h-0">
            {chat}
          </div>
          <div className="flex-1 overflow-y-auto p-4">{visual}</div>
        </div>
      ) : (
        /* Phone: whichever tab is showing */
        <div className="flex-1 min-h-0">
          {tab === 'chat' ? (
            <div className="h-full p-4 flex flex-col min-h-0">{chat}</div>
          ) : (
            <div className="h-full overflow-y-auto p-4">{visual}</div>
          )}
        </div>
      )}
    </div>
  )
}
