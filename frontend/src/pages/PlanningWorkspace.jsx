import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import ExportPlanButton from '../components/ExportPlanButton'
import SeasonTimeline from '../components/SeasonTimeline'
import PathwayBoard from '../components/PathwayBoard'
import { describeDraft, draftFromResult, saveDraft, takeStashedDraft } from '../planDrafts'
import StaffVoices, { StaffThinking } from '../components/StaffVoices'
import StaffNotesPanel from '../components/StaffNotesPanel'
import SeasonStarter, { NextStepCard } from '../components/SeasonStarter'
import { draftTopic, mergeConversation } from '../staffRoom'

// The planning conversation and the picture it produces, side by side.
//
// The year comes first: divide it into macrocycles, then pick one and plan what
// goes inside it. The macrocycle in focus is passed with every message, so the
// assistant plans that one rather than guessing from today's date.

// Only one layout is mounted. Rendering both and hiding one with CSS would run
// two chat panels, each trying to open the planning thread at once.
//
// Wide means the page itself has room, not the browser window: the app is laid
// out at phone width even on a laptop, and judging by the window put two
// squeezed panels side by side with no way to switch between them.
const WIDE_PX = 900

function useIsWide(ref) {
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const check = () => setWide(el.clientWidth >= WIDE_PX)
    check()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return wide
}

// The page fills the space between the app's top bar (3rem) and bottom menu
// (5rem plus the phone's safe area), so the chat box is never underneath it.
const PAGE_HEIGHT = 'calc(100dvh - 8rem - env(safe-area-inset-bottom, 0px))'

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

function ChatPanel({ macro, macros, onDraft, onPlanChanged, onStaffChanged, queued, onQueuedTaken, onBusy, visible = true }) {
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
  }, [messages, sending, staffNotes, staffThinking, visible])

  useEffect(() => { if (onBusy) onBusy(sending) }, [sending])

  // A request started from the plan side (the season set-up, "Plan next week")
  // is sent here, so it lands in the one conversation like anything typed.
  useEffect(() => {
    if (queued && thread && !sending) {
      onQueuedTaken()
      send(queued.text)
    }
  }, [queued, thread, sending])

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
            <p className="text-sm text-pool-200 font-medium">Talk the season through here.</p>
            <p className="text-xs text-pool-400 leading-relaxed">
              {macros.length === 0
                ? 'Tell me when your season starts and ends and which meets matter most, and I will split it into macrocycles. Or use the set-up on the Plan tab, which fills this in from your meet calendar.'
                : 'Ask for the next step, change anything in the plan, or ask who is aiming at which meet. Anything I propose appears on the Plan tab for you to approve.'}
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
  const rootRef = useRef(null)
  const [macros, setMacros] = useState([])
  const [macroId, setMacroId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('plan')      // phone only: 'chat' | 'plan'
  const [refreshKey, setRefreshKey] = useState(0)
  const [pending, setPending] = useState(null) // { kind, draft } awaiting approval
  const [staffKey, setStaffKey] = useState(0)
  const [queued, setQueued] = useState(null)   // a request from the plan side, waiting for the chat
  const [chatBusy, setChatBusy] = useState(false)
  const wide = useIsWide(rootRef)

  // Ask the assistant from the plan side. On a phone, show the conversation so
  // the coach sees the reply arrive; the proposal then comes back to Plan.
  const ask = (text) => {
    setQueued({ text, at: Date.now() })
    if (!wide) setTab('chat')
  }

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

      {macros.length > 0 && !pending && (
        <NextStepCard macros={macros} macro={macro} onAsk={ask} busy={chatBusy || Boolean(queued)} />
      )}

      {macros.length > 0 ? (
        <SeasonTimeline
          key={`tl-${refreshKey}-${staffKey}`}
          macros={macros}
          selectedMacroId={macroId}
          onSelectMacro={setMacroId}
        />
      ) : !loading && !pending && (
        <SeasonStarter onAsk={ask} busy={chatBusy || Boolean(queued)} />
      )}

      {macros.length > 0 && (
        <>
          <StaffNotesPanel macroId={macroId} refreshKey={staffKey} onActed={planChanged}
            title="Staff notes on this macrocycle" />

          <PathwayBoard key={`pb-${refreshKey}`} macroId={macroId} />

          <Link to="/season" className="block text-center text-xs text-accent-400 underline pb-4">
            Open the full season plan →
          </Link>
        </>
      )}
    </div>
  )

  const chat = (
    <ChatPanel
      macro={macro}
      macros={macros}
      onDraft={(drafted) => { setPending(drafted); setTab('plan') }}
      onPlanChanged={planChanged}
      onStaffChanged={() => setStaffKey(k => k + 1)}
      queued={queued}
      onQueuedTaken={() => setQueued(null)}
      onBusy={setChatBusy}
      visible={wide || tab === 'chat'}
    />
  )

  return (
    <div ref={rootRef} className="flex flex-col" style={{ height: PAGE_HEIGHT }}>
      <div className="bg-pool-800 px-4 pt-4 pb-3 shrink-0 border-b border-pool-700">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-lg font-bold">Planning</h1>
            <p className="text-xs text-pool-500 mt-0.5 truncate">Outline the year, then plan each part</p>
          </div>
          <div className="flex items-center gap-2 max-w-[60%]">
          {macros.length > 0 && <ExportPlanButton />}
          {macros.length > 1 && (
            <select
              value={macroId || ''}
              onChange={e => setMacroId(Number(e.target.value) || null)}
              className="bg-pool-700 border border-pool-600 rounded-lg px-2 py-1 text-xs text-pool-200 focus:outline-none min-w-0"
            >
              {macros.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
          </div>
        </div>

        {/* Narrow: one at a time. Wide: both at once, so no tabs. */}
        {!wide && (
          <div className="flex gap-1 mt-3">
            {['plan', 'chat'].map(key => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg ${
                  tab === key ? 'bg-pool-700 text-pool-100' : 'text-pool-500'
                }`}
              >
                {key === 'plan' ? 'Plan' : 'Discuss'}
                {key === 'chat' && tab !== 'chat' && chatBusy && ' …'}
              </button>
            ))}
          </div>
        )}
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
        /* Phone: whichever tab is showing. The conversation stays mounted
           while the plan is on screen, so a reply still arriving is not lost
           and switching back does not reload the thread. */
        <div className="flex-1 min-h-0">
          <div className={`h-full px-4 pt-3 pb-3 flex-col min-h-0 ${tab === 'chat' ? 'flex' : 'hidden'}`}>{chat}</div>
          {tab !== 'chat' && <div className="h-full overflow-y-auto p-4">{visual}</div>}
        </div>
      )}
    </div>
  )
}
