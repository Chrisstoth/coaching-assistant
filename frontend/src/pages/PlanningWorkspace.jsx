import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import SeasonTimeline from '../components/SeasonTimeline'
import PathwayBoard from '../components/PathwayBoard'

// The planning conversation and the picture it produces, side by side. The
// chat is the same season-plan thread the AI page uses, so nothing said here
// is lost to a separate history.

function ChatPanel({ macroId, onPlanChanged, onPathwayDraft }) {
  const navigate = useNavigate()
  const [thread, setThread] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [action, setAction] = useState(null)
  const endRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    api.getOrCreateSeasonPlanThread(macroId)
      .then(async (t) => {
        if (cancelled) return
        setThread(t)
        const msgs = await api.getAIChatMessages(t.id).catch(() => [])
        if (!cancelled) setMessages(Array.isArray(msgs) ? msgs : [])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [macroId])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, sending])

  const send = async () => {
    const text = input.trim()
    if (!text || sending || !thread) return
    setInput('')
    setAction(null)
    setMessages(prev => [...prev, { id: `local-${Date.now()}`, role: 'user', message: text }])
    setSending(true)
    try {
      const res = await api.sendAIChatMessage(text, thread.id)
      const fresh = await api.getAIChatMessages(thread.id).catch(() => null)
      if (Array.isArray(fresh)) setMessages(fresh)
      else if (res.reply) {
        setMessages(prev => [...prev, { id: `reply-${Date.now()}`, role: 'assistant', message: res.reply }])
      }
      if (res.suggested_action?.plan_type === 'pathway' && res.suggested_action.pathway_draft) {
        // Pathways are edited right here, so the draft stays on this page
        // rather than being handed off to the season plan for approval.
        onPathwayDraft(res.suggested_action.pathway_draft)
      } else if (res.suggested_action) {
        setAction(res.suggested_action)
      }
      onPlanChanged()
    } catch (e) {
      setMessages(prev => [...prev, {
        id: `err-${Date.now()}`, role: 'assistant',
        message: `Something went wrong sending that: ${e.message}`,
      }])
    }
    setSending(false)
  }

  const takeAction = () => {
    if (!action) return
    if (action.plan_type) {
      sessionStorage.setItem('dx_plan_handoff', JSON.stringify(action))
      navigate('/season')
      return
    }
    if (action.meet_id) navigate(`/meets/${action.meet_id}`)
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {messages.length === 0 && (
          <div className="bg-pool-800 rounded-xl p-4 space-y-2">
            <p className="text-sm text-pool-200 font-medium">Start with the shape of the season.</p>
            <p className="text-xs text-pool-400 leading-relaxed">
              Which squad, when it runs, and the meets that matter. Then who is aiming at what —
              and where they go instead if the time does not come. The picture builds as you talk.
            </p>
          </div>
        )}

        {messages.map(m => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
            <div className={`rounded-2xl px-3.5 py-2.5 max-w-[92%] text-sm leading-relaxed whitespace-pre-wrap ${
              m.role === 'user'
                ? 'bg-accent-700 text-white'
                : 'bg-pool-800 text-pool-200'
            }`}>
              {m.message}
            </div>
          </div>
        ))}

        {sending && (
          <div className="bg-pool-800 rounded-2xl px-3.5 py-2.5 text-sm text-pool-500 w-fit">Thinking…</div>
        )}

        {action && !sending && (
          <button
            onClick={takeAction}
            className="w-full bg-accent-900/40 border border-accent-700/60 rounded-xl px-3 py-2.5 text-left"
          >
            <p className="text-xs font-semibold text-accent-200">{action.label || 'Review this plan'}</p>
            <p className="text-[11px] text-pool-400 mt-0.5">Tap to open it for approval</p>
          </button>
        )}

        <div ref={endRef} />
      </div>

      <div className="pt-2 shrink-0">
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
            onClick={send}
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

function PathwayDraftCard({ draft, macroId, onSaved, onDismiss }) {
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const targetMacro = draft.macro_id || macroId
    if (!targetMacro) {
      alert('There is no macrocycle to attach these pathways to yet.')
      return
    }
    setSaving(true)
    try {
      for (const pathway of draft.pathways || []) {
        const created = await api.createPlanningPathway({
          macro_id: targetMacro,
          name: pathway.name,
          objective: pathway.objective || null,
          primary_meet_id: pathway.primary_meet_id || null,
          fallback_meet_id: pathway.fallback_meet_id || null,
        })
        const members = (pathway.swimmers || []).map(s => ({
          swimmer_id: s.swimmer_id,
          qualification_status: s.qualification_status || 'unknown',
          notes: s.reason || null,
        }))
        if (members.length) await api.setPlanningPathwayMembers(created.id, members)
      }
      onSaved()
    } catch (e) {
      alert('Could not save the pathways: ' + e.message)
    }
    setSaving(false)
  }

  return (
    <section className="bg-accent-900/30 border border-accent-700/60 rounded-2xl p-4 space-y-3">
      <p className="text-xs uppercase tracking-wide font-semibold text-accent-300">
        Proposed pathways
      </p>

      <div className="space-y-2">
        {(draft.pathways || []).map((pathway, i) => (
          <div key={i} className="bg-pool-900/40 rounded-xl p-3 space-y-1">
            <p className="text-sm font-semibold text-pool-100">{pathway.name}</p>
            <p className="text-xs text-pool-300">
              → {pathway.primary_meet || 'no target meet'}
              {pathway.fallback_meet && (
                <span className="text-pool-400"> · else {pathway.fallback_meet}</span>
              )}
            </p>
            {pathway.objective && (
              <p className="text-xs text-pool-400 leading-relaxed">{pathway.objective}</p>
            )}
            {(pathway.swimmers || []).length > 0 && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {pathway.swimmers.map(s => (
                  <span key={s.swimmer_id}
                    className="text-[10px] bg-pool-700 text-pool-300 rounded-full px-2 py-0.5">
                    {s.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {(draft.questions || []).length > 0 && (
        <div className="space-y-1">
          {draft.questions.map((q, i) => (
            <p key={i} className="text-xs text-yellow-300">{q}</p>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={onDismiss} className="px-4 py-2.5 text-xs bg-pool-700 rounded-xl">Dismiss</button>
        <button
          onClick={save}
          disabled={saving}
          className="flex-1 py-2.5 text-xs font-semibold bg-accent-600 rounded-xl disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save these pathways'}
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
  const [pathwayDraft, setPathwayDraft] = useState(null)

  const loadMacros = async () => {
    try {
      const rows = await api.getMacros()
      const list = Array.isArray(rows) ? rows : []
      setMacros(list)
      setMacroId(prev => prev ?? (list.find(m => m.is_current) || list[0])?.id ?? null)
    } catch {
      setMacros([])
    }
    setLoading(false)
  }

  useEffect(() => { loadMacros() }, [])

  const planChanged = () => {
    setRefreshKey(k => k + 1)
    loadMacros()
  }

  const visual = (
    <div className="space-y-4">
      {pathwayDraft && (
        <PathwayDraftCard
          draft={pathwayDraft}
          macroId={macroId}
          onSaved={() => { setPathwayDraft(null); planChanged() }}
          onDismiss={() => setPathwayDraft(null)}
        />
      )}
      {macros.length > 0 ? (
        <SeasonTimeline key={`tl-${refreshKey}`} macros={macros} />
      ) : !loading && (
        <div className="bg-pool-800 rounded-2xl p-5 text-center space-y-2">
          <p className="text-sm text-pool-300 font-medium">Nothing planned yet</p>
          <p className="text-xs text-pool-500 leading-relaxed">
            Describe the season in the chat and the timeline appears here as it takes shape.
          </p>
        </div>
      )}
      <PathwayBoard key={`pb-${refreshKey}`} macroId={macroId} />
      <Link to="/season" className="block text-center text-xs text-accent-400 underline pb-4">
        Open the full season plan →
      </Link>
    </div>
  )

  return (
    <div className="flex flex-col h-screen">
      <div className="bg-pool-800 px-4 pt-4 pb-3 shrink-0 border-b border-pool-700">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-lg font-bold">Planning</h1>
            <p className="text-xs text-pool-500 mt-0.5 truncate">Talk it through and watch the season take shape</p>
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
              className={`flex-1 py-1.5 text-xs font-semibold rounded-lg capitalize ${
                tab === key ? 'bg-pool-700 text-pool-100' : 'text-pool-500'
              }`}
            >
              {key === 'plan' ? 'Plan' : 'Discuss'}
            </button>
          ))}
        </div>
      </div>

      {/* Wide: conversation beside the picture it produces */}
      <div className="flex-1 min-h-0 hidden lg:flex">
        <div className="w-[38%] min-w-[320px] max-w-[520px] border-r border-pool-700 p-4 flex flex-col min-h-0">
          <ChatPanel macroId={macroId} onPlanChanged={planChanged}
            onPathwayDraft={(d) => { setPathwayDraft(d); setTab('plan') }} />
        </div>
        <div className="flex-1 overflow-y-auto p-4">{visual}</div>
      </div>

      {/* Phone: whichever tab is showing */}
      <div className="flex-1 min-h-0 lg:hidden">
        {tab === 'chat' ? (
          <div className="h-full p-4 flex flex-col min-h-0">
            <ChatPanel macroId={macroId} onPlanChanged={planChanged}
            onPathwayDraft={(d) => { setPathwayDraft(d); setTab('plan') }} />
          </div>
        ) : (
          <div className="h-full overflow-y-auto p-4">{visual}</div>
        )}
      </div>
    </div>
  )
}
