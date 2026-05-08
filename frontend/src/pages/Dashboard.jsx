import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import useLongPress from '../hooks/useLongPress'

function sessionAmPm(s) {
  // Try explicit time field first
  const timeStr = s.time || s.start_time
  if (timeStr) return parseInt(timeStr.slice(0, 2), 10) < 12 ? 'AM' : 'PM'
  // Try keyword in label
  const label = (s.label || '').toLowerCase()
  if (label.includes('morning') || label.includes(' am')) return 'AM'
  if (label.includes('evening') || label.includes('afternoon') || label.includes(' pm')) return 'PM'
  // Extract time from label like "Monday 06:00" or "06:00–07:30"
  const match = (s.label || '').match(/(\d{1,2}):(\d{2})/)
  if (match) return parseInt(match[1], 10) < 12 ? 'AM' : 'PM'
  return null
}

function SessionActionSheet({ session, type, onClose, onDeleted }) {
  const navigate = useNavigate()
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const doDelete = async () => {
    setDeleting(true)
    try {
      await api.deleteSession(session.session_id)
      onDeleted(session.session_id)
      onClose()
    } catch (e) {
      alert(`Error: ${e.message}`)
      setDeleting(false)
    }
  }

  const primaryAction = type === 'pending'
    ? { label: 'Open Register', path: `/sessions/${session.session_id}/register` }
    : { label: 'View Session', path: `/sessions/${session.session_id}` }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-pool-800 rounded-t-2xl p-4 space-y-2 pb-8"
        onClick={e => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="w-10 h-1 bg-pool-600 rounded-full mx-auto mb-4" />

        {/* Session label */}
        <p className="text-xs text-pool-400 text-center mb-3">{session._displayTitle}</p>

        <button
          onClick={() => navigate(primaryAction.path)}
          className="w-full bg-accent-600 rounded-xl py-3 font-semibold text-sm"
        >
          {primaryAction.label}
        </button>

        <button
          onClick={() => navigate(`/sessions/${session.session_id}`)}
          className="w-full bg-pool-700 rounded-xl py-3 font-semibold text-sm"
        >
          View / Edit Session
        </button>

        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="w-full bg-pool-800 border border-red-900 rounded-xl py-3 font-semibold text-sm text-red-400"
          >
            Delete Session
          </button>
        ) : (
          <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-3 space-y-2">
            <p className="text-xs text-red-300 text-center">Delete this session and all register data?</p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                className="flex-1 bg-pool-700 rounded-lg py-2 text-sm font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={doDelete}
                disabled={deleting}
                className="flex-1 bg-red-900 disabled:opacity-40 rounded-lg py-2 text-sm font-semibold text-red-100"
              >
                {deleting ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        )}

        <button
          onClick={onClose}
          className="w-full py-3 text-sm text-pool-400"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function SessionCard({ s, type, onAction }) {
  const navigate = useNavigate()
  const sessionDate = new Date(s.date + 'T12:00:00')
  const weekday = sessionDate.toLocaleDateString('en-GB', { weekday: 'long' })
  const dateLabel = sessionDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const amPm = sessionAmPm(s)

  const isPending = type === 'pending'
  const daysAgo = isPending
    ? Math.floor((new Date() - sessionDate) / (1000 * 60 * 60 * 24))
    : null

  const subtitle = s.label && s.label !== 'Session' ? s.label : (s.title || null)
  const displayTitle = `${weekday}${amPm ? ` ${amPm}` : ''}`

  const handlers = useLongPress(
    () => onAction({ ...s, _displayTitle: displayTitle }),
    () => navigate(isPending ? `/sessions/${s.session_id}/register` : `/sessions/${s.session_id}`)
  )

  if (isPending) {
    return (
      <div
        {...handlers}
        className="flex items-center justify-between bg-pool-700 border border-accent-600/40 rounded-xl p-3.5 cursor-pointer select-none active:opacity-70 transition-opacity"
      >
        <div>
          <p className="font-semibold text-sm text-pool-200">{displayTitle}</p>
          <p className="text-pool-400 text-xs mt-0.5">
            {dateLabel} · {daysAgo === 1 ? 'yesterday' : daysAgo === 0 ? 'today' : `${daysAgo}d ago`}
            {subtitle ? ` · ${subtitle}` : ''}
          </p>
        </div>
        <span className="text-accent-500 text-sm font-semibold">Log →</span>
      </div>
    )
  }

  // Upcoming
  const dayName = sessionDate.toLocaleDateString('en-GB', { weekday: 'short' })
  const dayNum = sessionDate.getDate()
  const groupCount = s.planned_content ? Object.keys(s.planned_content).length : 0
  const upcomingTitle = s.title || subtitle || `${weekday}${amPm ? ` ${amPm}` : ''}`

  return (
    <div
      {...handlers}
      className="flex items-center justify-between bg-pool-700 border border-pool-600 rounded-xl p-3.5 cursor-pointer select-none active:opacity-70 transition-opacity"
    >
      <div className="flex-1">
        <p className="font-semibold text-sm text-pool-200">{upcomingTitle}</p>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-xs font-medium text-accent-400 bg-accent-600/15 px-2 py-0.5 rounded-md">
            {dayName} {dayNum}
          </span>
          {groupCount > 0 && (
            <span className="text-xs text-pool-400">
              {groupCount} group{groupCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
      <span className="text-pool-400 text-lg ml-3">›</span>
    </div>
  )
}

export default function Dashboard() {
  const [calendar, setCalendar] = useState([])
  const [swimmers, setSwimmers] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeSheet, setActiveSheet] = useState(null) // { session, type }
  const [coachingNotes, setCoachingNotes] = useState([])

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.getCalendar().catch(() => []),
      api.getSwimmers({ active_only: true }).catch(() => []),
      api.getCoachingNotes().catch(() => []),
    ]).then(([cal, swim, notes]) => {
      setCalendar(cal)
      setSwimmers(swim)
      setCoachingNotes(notes)
      setLoading(false)
    })
  }, [])

  const dismissNote = async (id) => {
    await api.updateCoachingNote(id, { active: false })
    setCoachingNotes(prev => prev.filter(n => n.id !== id))
  }

  const today = new Date()
  const todayStr = today.toISOString().split('T')[0]

  // Calendar returns [{date, day_name, items: [...]}] — flatten to items
  const allItems = calendar.flatMap(day =>
    (day.items || []).map(item => ({ ...item, date: day.date }))
  )

  const upcomingSessions = allItems.filter(s =>
    s.date >= todayStr && (s.status === 'planned' || !s.status) && s.session_id
  ).slice(0, 3)

  const pendingRegister = allItems.filter(s =>
    s.date < todayStr && s.status !== 'cancelled' && !s.registered && s.session_id
  ).slice(0, 3)

  const swimmerIssues = swimmers.filter(s => s.status !== 'active')

  const handleDeleted = (sessionId) => {
    setCalendar(prev => prev.map(day => ({
      ...day,
      items: (day.items || []).filter(item => item.session_id !== sessionId),
    })))
  }

  const hasAnything = pendingRegister.length > 0 || upcomingSessions.length > 0 || coachingNotes.length > 0

  return (
    <div className="p-4 space-y-5">

      {/* Date + greeting */}
      <div className="pt-1">
        <p className="text-pool-400 text-sm">
          {today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
        <h1 className="text-xl font-bold tracking-tight mt-0.5">
          {today.getHours() < 12 ? 'Morning' : today.getHours() < 17 ? 'Afternoon' : 'Evening'}
        </h1>
      </div>

      {/* Active coaching notes */}
      {coachingNotes.length > 0 && (
        <div className="space-y-2">
          {coachingNotes.map(note => (
            <div key={note.id} className="bg-amber-900/20 border border-amber-700/40 rounded-2xl px-4 py-3 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0 mt-0.5" />
                  <p className="text-sm font-semibold text-amber-200">{note.title}</p>
                </div>
                <button onClick={() => dismissNote(note.id)} className="text-pool-500 hover:text-pool-300 text-lg leading-none shrink-0">×</button>
              </div>
              <p className="text-xs text-pool-400 pl-3.5">
                {note.date_from} → {note.date_to}
                {note.swimmer_names?.length > 0 && ` · ${note.swimmer_names.join(', ')}`}
              </p>
              <p className="text-xs text-pool-300 pl-3.5 whitespace-pre-line leading-relaxed">{note.body}</p>
            </div>
          ))}
        </div>
      )}

      {/* Pending registers — highest priority */}
      {pendingRegister.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-2.5">
            <div className="w-1.5 h-4 bg-accent-500 rounded-full" />
            <h2 className="font-semibold text-sm">Needs attention</h2>
          </div>
          <div className="space-y-2">
            {pendingRegister.map(s => (
              <SessionCard key={s.session_id || s.date} s={s} type="pending"
                onAction={(session) => setActiveSheet({ session, type: 'pending' })} />
            ))}
          </div>
        </section>
      )}

      {/* Upcoming sessions */}
      {upcomingSessions.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-4 bg-pool-600 rounded-full" />
              <h2 className="font-semibold text-sm">Coming up</h2>
            </div>
            <Link to="/calendar" className="text-xs text-pool-500 hover:text-pool-300">Calendar →</Link>
          </div>
          <div className="space-y-2">
            {upcomingSessions.map(s => (
              <SessionCard key={s.session_id || s.date} s={s} type="upcoming"
                onAction={(session) => setActiveSheet({ session, type: 'upcoming' })} />
            ))}
          </div>
        </section>
      )}

      {/* AI quick-start — shown when nothing urgent is happening */}
      {!hasAnything && !loading && (
        <Link to="/ai"
          className="block bg-gradient-to-br from-accent-900/60 to-pool-800 border border-accent-700/40 rounded-2xl p-5 space-y-2 hover:border-accent-600/60 transition-colors">
          <div className="flex items-center gap-2">
            <span className="text-accent-400 text-lg">✦</span>
            <p className="font-semibold text-sm text-accent-200">Ask your AI coach</p>
          </div>
          <p className="text-xs text-pool-400 leading-relaxed">
            Plan a session, build a swimmer profile, discuss competition prep — your AI coach knows the squad.
          </p>
        </Link>
      )}

      {/* Squad flags */}
      {swimmerIssues.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-4 bg-yellow-600 rounded-full" />
              <h2 className="font-semibold text-sm">Squad flags</h2>
            </div>
            <Link to="/swimmers" className="text-xs text-pool-500 hover:text-pool-300">View all →</Link>
          </div>
          <div className="bg-pool-800 border border-pool-700 rounded-2xl p-3 space-y-2">
            {swimmerIssues.map(s => (
              <div key={s.id} className="flex items-center justify-between text-xs">
                <Link to={`/swimmers/${s.id}`} className="text-pool-200 hover:text-accent-400 font-medium">{s.name}</Link>
                <span className={`px-2 py-0.5 rounded-full font-semibold text-xs ${
                  s.status === 'sabbatical' ? 'bg-yellow-900/50 text-yellow-400 border border-yellow-800' : 'bg-red-900/40 text-red-400 border border-red-800'
                }`}>
                  {s.status === 'sabbatical' ? 'Sabbatical' : 'Injury'}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Utility links */}
      <div className="grid grid-cols-3 gap-2 pt-1">
        <Link to="/import" className="bg-pool-800 hover:bg-pool-700 border border-pool-700 rounded-xl py-3 text-center text-xs text-pool-400 font-medium transition-colors">
          Import
        </Link>
        <Link to="/schedule" className="bg-pool-800 hover:bg-pool-700 border border-pool-700 rounded-xl py-3 text-center text-xs text-pool-400 font-medium transition-colors">
          Schedule
        </Link>
        <Link to="/context" className="bg-pool-800 hover:bg-pool-700 border border-pool-700 rounded-xl py-3 text-center text-xs text-pool-400 font-medium transition-colors">
          AI Context
        </Link>
      </div>

      {/* Action sheet */}
      {activeSheet && (
        <SessionActionSheet
          session={activeSheet.session}
          type={activeSheet.type}
          onClose={() => setActiveSheet(null)}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}
