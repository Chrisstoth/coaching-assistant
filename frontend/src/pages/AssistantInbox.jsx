import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'

const FILTERS = [
  { id: 'attention', label: 'Attention' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'history', label: 'History' },
]

function formatDate(value, includeTime = false) {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString('en-GB', includeTime
    ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short' })
}

function contextLine(item) {
  return [item.swimmer_name, item.pathway_name, item.macro_name].filter(Boolean).join(' · ')
}

function RecommendationCard({ item, busy, onDiscuss, onStart, onUpdate, onSnooze, onSaveNote }) {
  const [showNote, setShowNote] = useState(false)
  const [note, setNote] = useState(item.coach_note || '')
  const isClosed = ['resolved', 'dismissed'].includes(item.status)
  const isProgress = ['in_progress', 'accepted'].includes(item.status)
  const severityClass = item.severity === 'critical'
    ? 'border-red-700/60 bg-red-950/25'
    : item.severity === 'warning'
      ? 'border-amber-700/50 bg-amber-950/20'
      : 'border-pool-700 bg-pool-800'
  const dotClass = item.severity === 'critical'
    ? 'bg-red-400'
    : item.severity === 'warning' ? 'bg-amber-400' : 'bg-teal-400'

  return (
    <article className={`rounded-2xl border p-4 space-y-3 ${severityClass}`}>
      <div className="flex items-start gap-3">
        <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${dotClass}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-sm font-semibold text-pool-100 leading-snug">{item.title}</h2>
            <span className="text-[10px] uppercase tracking-wide text-pool-500 whitespace-nowrap">
              {item.status.replace('_', ' ')}
            </span>
          </div>
          {contextLine(item) && <p className="text-[11px] text-accent-400 mt-0.5">{contextLine(item)}</p>}
        </div>
      </div>

      <p className="text-xs text-pool-300 leading-relaxed">{item.detail}</p>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-pool-500">
        <span>Detected {formatDate(item.created_at)}</span>
        {item.follow_up_at && <span>Follow up {formatDate(item.follow_up_at, true)}</span>}
        {item.occurrence_count > 1 && <span>Seen {item.occurrence_count} times</span>}
      </div>

      {item.coach_note && !showNote && (
        <button onClick={() => setShowNote(true)} className="w-full text-left bg-pool-900/50 rounded-xl px-3 py-2 text-xs text-pool-300">
          <span className="text-pool-500">Your note: </span>{item.coach_note}
        </button>
      )}

      {showNote && (
        <div className="space-y-2">
          <textarea
            value={note}
            onChange={event => setNote(event.target.value)}
            rows={2}
            placeholder="Record your decision or what to check next…"
            className="w-full bg-pool-900 border border-pool-600 rounded-xl px-3 py-2 text-xs resize-none focus:outline-none focus:border-accent-500"
          />
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowNote(false)} className="text-xs text-pool-500 px-2 py-1">Cancel</button>
            <button
              onClick={() => onSaveNote(item.id, note).then(() => setShowNote(false))}
              disabled={busy}
              className="text-xs text-teal-300 bg-teal-900/40 rounded-lg px-3 py-1.5 disabled:opacity-40"
            >Save note</button>
          </div>
        </div>
      )}

      {!isClosed ? (
        <div className="flex flex-wrap gap-2 pt-0.5">
          <button onClick={() => onDiscuss(item)} disabled={busy} className="bg-accent-600 rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-40">
            Discuss
          </button>
          <button onClick={() => onStart(item)} disabled={busy} className="bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-40">
            {isProgress ? 'Open task' : 'Start action'}
          </button>
          <button onClick={() => onSnooze(item.id)} disabled={busy} className="bg-pool-800 border border-pool-700 rounded-lg px-3 py-2 text-xs text-pool-300 disabled:opacity-40">
            Snooze
          </button>
          {isProgress && (
            <button onClick={() => onUpdate(item.id, { status: 'resolved' })} disabled={busy} className="text-xs text-teal-300 px-2 py-2 disabled:opacity-40">
              Resolve
            </button>
          )}
          <button onClick={() => setShowNote(value => !value)} disabled={busy} className="text-xs text-pool-400 px-2 py-2 disabled:opacity-40">
            {item.coach_note ? 'Edit note' : 'Add note'}
          </button>
          <button onClick={() => onUpdate(item.id, { status: 'dismissed' })} disabled={busy} className="text-xs text-pool-500 px-2 py-2 disabled:opacity-40">
            Dismiss
          </button>
        </div>
      ) : (
        <button onClick={() => onUpdate(item.id, { status: 'open' })} disabled={busy} className="text-xs text-accent-400 disabled:opacity-40">
          Reopen
        </button>
      )}
    </article>
  )
}

export default function AssistantInbox() {
  const navigate = useNavigate()
  const [data, setData] = useState({ items: [], counts: {} })
  const [filter, setFilter] = useState('attention')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [snoozeId, setSnoozeId] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async (refresh = true) => {
    setError(null)
    try {
      const result = await api.getAssistantInbox({
        include_snoozed: true,
        include_closed: true,
        refresh,
      })
      setData(result)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(true) }, [load])

  const filtered = useMemo(() => data.items.filter(item => {
    if (filter === 'attention') return item.status === 'open'
    if (filter === 'in_progress') return ['in_progress', 'accepted'].includes(item.status)
    if (filter === 'snoozed') return item.status === 'snoozed'
    return ['resolved', 'dismissed'].includes(item.status)
  }), [data.items, filter])

  const update = async (id, body) => {
    setBusyId(id)
    try {
      await api.updatePlanningRecommendation(id, body)
      await load(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const discuss = async item => {
    setBusyId(item.id)
    try {
      const result = await api.discussPlanningRecommendation(item.id)
      navigate('/ai', { state: { threadId: result.thread_id } })
    } catch (err) {
      setError(err.message)
      setBusyId(null)
    }
  }

  const start = async item => {
    setBusyId(item.id)
    try {
      const result = await api.startPlanningRecommendation(item.id)
      navigate(result.destination || item.action_destination || '/season')
    } catch (err) {
      setError(err.message)
      setBusyId(null)
    }
  }

  const snooze = async days => {
    const followUp = new Date()
    followUp.setDate(followUp.getDate() + days)
    await update(snoozeId, { status: 'snoozed', follow_up_at: followUp.toISOString() })
    setSnoozeId(null)
  }

  return (
    <div className="p-4 space-y-4">
      <header className="pt-1 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-accent-400 font-semibold uppercase tracking-wide">Assistant coach</p>
          <h1 className="text-xl font-bold mt-0.5">Inbox</h1>
          <p className="text-xs text-pool-500 mt-1">Persistent planning checks, decisions and follow-ups.</p>
        </div>
        <button
          onClick={() => { setLoading(true); load(true) }}
          disabled={loading}
          className="bg-pool-800 border border-pool-700 rounded-xl px-3 py-2 text-xs text-pool-300 disabled:opacity-40"
        >{loading ? 'Checking…' : 'Check now'}</button>
      </header>

      <div className="grid grid-cols-3 gap-2">
        <div className="bg-pool-800 border border-pool-700 rounded-xl px-3 py-2.5">
          <p className="text-lg font-bold text-amber-300">{data.counts?.open || 0}</p>
          <p className="text-[10px] text-pool-500 uppercase tracking-wide">Open</p>
        </div>
        <div className="bg-pool-800 border border-pool-700 rounded-xl px-3 py-2.5">
          <p className="text-lg font-bold text-teal-300">{data.counts?.in_progress || 0}</p>
          <p className="text-[10px] text-pool-500 uppercase tracking-wide">In progress</p>
        </div>
        <div className="bg-pool-800 border border-pool-700 rounded-xl px-3 py-2.5">
          <p className="text-lg font-bold text-pool-300">{data.counts?.snoozed || 0}</p>
          <p className="text-[10px] text-pool-500 uppercase tracking-wide">Snoozed</p>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto pb-1">
        {FILTERS.map(option => (
          <button
            key={option.id}
            onClick={() => setFilter(option.id)}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-xs transition-colors ${
              filter === option.id ? 'bg-accent-600 text-white' : 'bg-pool-800 text-pool-400 border border-pool-700'
            }`}
          >{option.label}</button>
        ))}
      </div>

      {error && <div className="bg-red-950/30 border border-red-800/50 rounded-xl px-3 py-2 text-xs text-red-300">{error}</div>}

      {!loading && filtered.length === 0 && (
        <div className="bg-pool-800/60 border border-dashed border-pool-700 rounded-2xl px-5 py-8 text-center">
          <p className="text-sm font-semibold text-pool-300">
            {filter === 'attention' ? 'Nothing needs a decision right now' : `No ${FILTERS.find(row => row.id === filter)?.label.toLowerCase()} items`}
          </p>
          <p className="text-xs text-pool-500 mt-1">The local planning checks run whenever this inbox is opened.</p>
        </div>
      )}

      <div className="space-y-3">
        {filtered.map(item => (
          <RecommendationCard
            key={item.id}
            item={item}
            busy={busyId === item.id}
            onDiscuss={discuss}
            onStart={start}
            onUpdate={update}
            onSnooze={setSnoozeId}
            onSaveNote={(id, note) => update(id, { coach_note: note })}
          />
        ))}
      </div>

      <p className="text-[10px] text-pool-600 text-center pb-2">
        Checks use stored data and local rules. AI is only called after you continue a discussion.
      </p>

      {snoozeId && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={() => setSnoozeId(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative bg-pool-800 rounded-t-2xl p-4 pb-8 space-y-2" onClick={event => event.stopPropagation()}>
            <div className="w-10 h-1 bg-pool-600 rounded-full mx-auto mb-4" />
            <p className="text-sm font-semibold text-center mb-3">When should I remind you?</p>
            <button onClick={() => snooze(1)} className="w-full bg-pool-700 rounded-xl py-3 text-sm">Tomorrow</button>
            <button onClick={() => snooze(7)} className="w-full bg-pool-700 rounded-xl py-3 text-sm">In one week</button>
            <button onClick={() => snooze(30)} className="w-full bg-pool-700 rounded-xl py-3 text-sm">In one month</button>
            <button onClick={() => setSnoozeId(null)} className="w-full py-3 text-sm text-pool-400">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
