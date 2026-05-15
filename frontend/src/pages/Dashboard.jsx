import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import useLongPress from '../hooks/useLongPress'

function sessionAmPm(s) {
  const timeStr = s.time || s.start_time
  if (timeStr) return parseInt(timeStr.slice(0, 2), 10) < 12 ? 'AM' : 'PM'
  const label = (s.label || '').toLowerCase()
  if (label.includes('morning') || label.includes(' am')) return 'AM'
  if (label.includes('evening') || label.includes('afternoon') || label.includes(' pm')) return 'PM'
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
      <div className="relative bg-pool-800 rounded-t-2xl p-4 space-y-2 pb-8" onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 bg-pool-600 rounded-full mx-auto mb-4" />
        <p className="text-xs text-pool-400 text-center mb-3">{session._displayTitle}</p>
        <button onClick={() => navigate(primaryAction.path)} className="w-full bg-accent-600 rounded-xl py-3 font-semibold text-sm">{primaryAction.label}</button>
        <button onClick={() => navigate(`/sessions/${session.session_id}`)} className="w-full bg-pool-700 rounded-xl py-3 font-semibold text-sm">View / Edit Session</button>
        {!confirmDelete ? (
          <button onClick={() => setConfirmDelete(true)} className="w-full bg-pool-800 border border-red-900 rounded-xl py-3 font-semibold text-sm text-red-400">Delete Session</button>
        ) : (
          <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-3 space-y-2">
            <p className="text-xs text-red-300 text-center">Delete this session and all register data?</p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmDelete(false)} className="flex-1 bg-pool-700 rounded-lg py-2 text-sm font-semibold">Cancel</button>
              <button onClick={doDelete} disabled={deleting} className="flex-1 bg-red-900 disabled:opacity-40 rounded-lg py-2 text-sm font-semibold text-red-100">{deleting ? 'Deleting...' : 'Confirm Delete'}</button>
            </div>
          </div>
        )}
        <button onClick={onClose} className="w-full py-3 text-sm text-pool-400">Cancel</button>
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
  const daysAgo = isPending ? Math.floor((new Date() - sessionDate) / (1000 * 60 * 60 * 24)) : null
  const subtitle = s.label && s.label !== 'Session' ? s.label : (s.title || null)
  const displayTitle = `${weekday}${amPm ? ` ${amPm}` : ''}`
  const handlers = useLongPress(
    () => onAction({ ...s, _displayTitle: displayTitle }),
    () => navigate(isPending ? `/sessions/${s.session_id}/register` : `/sessions/${s.session_id}`)
  )

  if (isPending) {
    return (
      <div {...handlers} className="flex items-center justify-between bg-pool-700 border border-accent-600/40 rounded-xl p-3.5 cursor-pointer select-none active:opacity-70 transition-opacity">
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

  const dayName = sessionDate.toLocaleDateString('en-GB', { weekday: 'short' })
  const dayNum = sessionDate.getDate()
  const groupCount = s.planned_content ? Object.keys(s.planned_content).length : 0
  const upcomingTitle = s.title || subtitle || `${weekday}${amPm ? ` ${amPm}` : ''}`

  return (
    <div {...handlers} className="flex items-center justify-between bg-pool-700 border border-pool-600 rounded-xl p-3.5 cursor-pointer select-none active:opacity-70 transition-opacity">
      <div className="flex-1">
        <p className="font-semibold text-sm text-pool-200">{upcomingTitle}</p>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-xs font-medium text-accent-400 bg-accent-600/15 px-2 py-0.5 rounded-md">{dayName} {dayNum}</span>
          {groupCount > 0 && <span className="text-xs text-pool-400">{groupCount} group{groupCount !== 1 ? 's' : ''}</span>}
        </div>
      </div>
      <span className="text-pool-400 text-lg ml-3">›</span>
    </div>
  )
}

// Attendance bar — 5 segments, filled proportionally
function AttendanceBar({ attended, expected }) {
  const ratio = expected > 0 ? attended / expected : 0
  const filled = Math.round(ratio * 5)
  const colour = ratio >= 0.8 ? 'bg-emerald-500' : ratio >= 0.5 ? 'bg-amber-500' : 'bg-red-500/70'
  return (
    <div className="flex gap-0.5" title={`${attended}/${expected} sessions`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className={`w-1.5 h-3 rounded-sm ${i < filled ? colour : 'bg-pool-700'}`} />
      ))}
    </div>
  )
}

function TargetChip({ target }) {
  const { weeks_out, days_out, gap_seconds } = target
  const urgent = weeks_out <= 2
  const gapStr = gap_seconds !== null && gap_seconds !== undefined
    ? (gap_seconds > 0 ? `${gap_seconds.toFixed(1)}s off` : `on target`)
    : null

  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md whitespace-nowrap ${
      urgent
        ? 'bg-red-900/50 text-red-300 border border-red-800/50'
        : 'bg-pool-700 text-pool-400 border border-pool-600'
    }`}>
      {weeks_out <= 1 ? `${days_out}d` : `${weeks_out}w`}{gapStr ? ` · ${gapStr}` : ''}
    </span>
  )
}

function SwimmerPulseRow({ swimmer }) {
  const { id, name, sessions_attended, sessions_expected, approaching_target, last_observation, has_recent_skill_flag } = swimmer
  const noData = sessions_attended === 0 && !last_observation && !approaching_target

  return (
    <Link to={`/swimmers/${id}`} className="block active:opacity-70 transition-opacity">
      <div className="py-2.5 border-b border-pool-800 last:border-0">
        <div className="flex items-center gap-2.5">
          {/* Name */}
          <span className="text-sm font-medium text-pool-200 w-28 shrink-0 truncate">{name}</span>

          {/* Attendance */}
          <AttendanceBar attended={sessions_attended} expected={sessions_expected} />

          {/* Spacer */}
          <div className="flex-1" />

          {/* Skill flag */}
          {has_recent_skill_flag && (
            <span className="w-1.5 h-1.5 rounded-full bg-accent-500 shrink-0" title="Recent AI review" />
          )}

          {/* Target chip */}
          {approaching_target && <TargetChip target={approaching_target} />}
        </div>

        {/* Observation snippet */}
        {last_observation && !noData && (
          <p className="text-[11px] text-pool-500 mt-1 ml-0 truncate leading-snug">
            <span className="text-pool-600">{last_observation.days_ago === 0 ? 'today' : last_observation.days_ago === 1 ? 'yesterday' : `${last_observation.days_ago}d ago`} · </span>
            {last_observation.snippet}
          </p>
        )}
        {noData && (
          <p className="text-[11px] text-pool-700 mt-1">No recent data</p>
        )}
      </div>
    </Link>
  )
}

function SquadPulse({ pulse }) {
  const [expanded, setExpanded] = useState(false)
  const PREVIEW = 6
  const visible = expanded ? pulse : pulse.slice(0, PREVIEW)
  const hasMore = pulse.length > PREVIEW

  return (
    <section>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-4 bg-teal-600 rounded-full" />
          <h2 className="font-semibold text-sm">Squad Pulse</h2>
        </div>
        <Link to="/swimmers" className="text-xs text-pool-500 hover:text-pool-300">Full squad →</Link>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 mb-2 px-0.5">
        <span className="text-[10px] text-pool-600">Attendance (4wk)</span>
        <div className="flex gap-1 items-center">
          <div className="w-1.5 h-2.5 rounded-sm bg-emerald-500" />
          <span className="text-[10px] text-pool-600">≥80%</span>
        </div>
        <div className="flex gap-1 items-center">
          <div className="w-1.5 h-2.5 rounded-sm bg-amber-500" />
          <span className="text-[10px] text-pool-600">50–79%</span>
        </div>
        <div className="flex gap-1 items-center">
          <div className="w-1.5 h-2.5 rounded-sm bg-red-500/70" />
          <span className="text-[10px] text-pool-600">&lt;50%</span>
        </div>
      </div>

      <div className="bg-pool-800 border border-pool-700 rounded-2xl px-4 py-1">
        {visible.map(sw => (
          <SwimmerPulseRow key={sw.id} swimmer={sw} />
        ))}
      </div>

      {hasMore && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="w-full mt-1.5 text-xs text-pool-500 hover:text-pool-300 py-1.5 transition-colors"
        >
          {expanded ? '↑ Show less' : `↓ Show ${pulse.length - PREVIEW} more`}
        </button>
      )}
    </section>
  )
}

function GroupTargetCard({ target }) {
  const { group, meet_name, days_out, meet_id } = target
  const weeks = Math.ceil(days_out / 7)
  const urgent = days_out <= 14
  const soon = days_out <= 42

  const bgClass = urgent
    ? 'bg-red-900/25 border-red-700/40'
    : soon
    ? 'bg-amber-900/20 border-amber-700/35'
    : 'bg-teal-900/20 border-teal-700/30'

  const accentClass = urgent ? 'text-red-300' : soon ? 'text-amber-300' : 'text-teal-300'
  const labelClass = urgent ? 'text-red-400/70' : soon ? 'text-amber-400/70' : 'text-teal-400/70'

  // Progress bar: 0% = 12+ weeks out, 100% = today
  const MAX_DAYS = 84
  const progress = Math.min(100, Math.max(4, Math.round((1 - days_out / MAX_DAYS) * 100)))
  const barClass = urgent ? 'bg-red-500' : soon ? 'bg-amber-500' : 'bg-teal-500'

  return (
    <Link to={`/meets/${meet_id}`} className={`block border rounded-2xl px-4 py-3.5 transition-opacity active:opacity-75 ${bgClass}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className={`text-[10px] font-semibold uppercase tracking-wider ${labelClass}`}>{group}</p>
          <p className="font-semibold text-sm text-pool-100 mt-0.5 truncate">{meet_name}</p>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-2xl font-bold leading-none tabular-nums ${accentClass}`}>{days_out}</p>
          <p className={`text-[10px] mt-0.5 ${labelClass}`}>{days_out === 1 ? 'day' : days_out < 14 ? 'days' : `days · ${weeks}w`}</p>
        </div>
      </div>
      <div className="mt-2.5 h-1 rounded-full bg-pool-800/60">
        <div className={`h-full rounded-full ${barClass}`} style={{ width: `${progress}%` }} />
      </div>
    </Link>
  )
}

export default function Dashboard() {
  const [calendar, setCalendar] = useState([])
  const [pulse, setPulse] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeSheet, setActiveSheet] = useState(null)
  const [coachingNotes, setCoachingNotes] = useState([])
  const [coachingProfile, setCoachingProfile] = useState(null)
  const [meetCountdowns, setMeetCountdowns] = useState({ group_targets: [], upcoming_meets: [] })

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.getCalendar().catch(() => []),
      api.getCoachingNotes().catch(() => []),
      api.getAIContextStatus().catch(() => null),
      api.getSquadPulse().catch(() => []),
      api.getMeetCountdowns().catch(() => ({ group_targets: [], upcoming_meets: [] })),
    ]).then(([cal, notes, ctx, pulseData, countdowns]) => {
      setCalendar(cal)
      setCoachingNotes(notes)
      setCoachingProfile(ctx)
      setPulse(pulseData)
      setMeetCountdowns(countdowns)
      setLoading(false)
    })
  }, [])

  const dismissNote = async (id) => {
    await api.updateCoachingNote(id, { active: false })
    setCoachingNotes(prev => prev.filter(n => n.id !== id))
  }

  const today = new Date()
  const todayStr = today.toISOString().split('T')[0]

  const allItems = calendar.flatMap(day =>
    (day.items || []).map(item => ({ ...item, date: day.date }))
  )
  const upcomingSessions = allItems.filter(s =>
    s.date >= todayStr && (s.status === 'planned' || !s.status) && s.session_id
  ).slice(0, 3)

  const pendingRegister = allItems.filter(s =>
    s.date < todayStr && s.status !== 'cancelled' && !s.registered && s.session_id
  ).slice(0, 3)

  const handleDeleted = (sessionId) => {
    setCalendar(prev => prev.map(day => ({
      ...day,
      items: (day.items || []).filter(item => item.session_id !== sessionId),
    })))
  }

  // Swimmers needing attention from pulse (approaching target in ≤2 weeks or very low attendance)
  const flaggedSwimmers = pulse.filter(sw =>
    (sw.approaching_target && sw.approaching_target.weeks_out <= 2) ||
    (sw.sessions_attended / sw.sessions_expected < 0.4 && sw.sessions_expected >= 4)
  )

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

      {/* Group target meet countdowns */}
      {meetCountdowns.group_targets.length > 0 && (
        <section className="space-y-2">
          {meetCountdowns.group_targets.map(t => (
            <GroupTargetCard key={`${t.group}-${t.meet_id}`} target={t} />
          ))}
        </section>
      )}

      {/* Upcoming meets (quieter) */}
      {meetCountdowns.upcoming_meets.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs font-semibold text-pool-500 uppercase tracking-wide">Meets coming up</p>
            <Link to="/meets" className="text-xs text-pool-500 hover:text-pool-300">All →</Link>
          </div>
          <div className="bg-pool-800/60 border border-pool-700/50 rounded-xl divide-y divide-pool-700/40">
            {meetCountdowns.upcoming_meets.map(m => (
              <Link key={m.meet_id} to={`/meets/${m.meet_id}`} className="flex items-center justify-between px-3.5 py-2.5 active:opacity-70 transition-opacity">
                <span className="text-sm text-pool-300">{m.name}</span>
                <span className="text-xs text-pool-500 tabular-nums">
                  {m.days_out === 0 ? 'today' : m.days_out === 1 ? 'tomorrow' : `${m.days_out}d`}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

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
            <Link to="/plan" className="text-xs text-pool-500 hover:text-pool-300">Plan →</Link>
          </div>
          <div className="space-y-2">
            {upcomingSessions.map(s => (
              <SessionCard key={s.session_id || s.date} s={s} type="upcoming"
                onAction={(session) => setActiveSheet({ session, type: 'upcoming' })} />
            ))}
          </div>
        </section>
      )}

      {/* Attention flags from pulse — imminent targets or very low attendance */}
      {flaggedSwimmers.length > 0 && (
        <div className="bg-amber-900/15 border border-amber-800/30 rounded-2xl px-4 py-3 space-y-1.5">
          <p className="text-xs font-semibold text-amber-400 uppercase tracking-wide">Needs your eye</p>
          {flaggedSwimmers.map(sw => (
            <Link key={sw.id} to={`/swimmers/${sw.id}`} className="flex items-center justify-between group">
              <span className="text-sm text-pool-200 group-hover:text-accent-400 transition-colors">{sw.name}</span>
              <span className="text-xs text-pool-400">
                {sw.approaching_target?.weeks_out <= 2
                  ? `Target in ${sw.approaching_target.days_out}d`
                  : `${sw.sessions_attended}/${sw.sessions_expected} sessions`}
              </span>
            </Link>
          ))}
        </div>
      )}

      {/* Squad Pulse */}
      {!loading && pulse.length > 0 && <SquadPulse pulse={pulse} />}

      {/* Squad flags (injury/sabbatical) */}
      {(() => {
        const issues = pulse.filter ? [] : [] // handled via swimmers endpoint if needed
        return null
      })()}

      {/* Coaching Profile card */}
      {(() => {
        const daysOld = coachingProfile?.created_at
          ? Math.floor((new Date() - new Date(coachingProfile.created_at)) / (1000 * 60 * 60 * 24))
          : null
        const stale = daysOld !== null && daysOld > 28
        return (
          <Link to="/context" className={`block border rounded-2xl px-4 py-3.5 transition-colors ${
            stale
              ? 'bg-amber-900/30 border-amber-700/50 hover:bg-amber-900/40'
              : coachingProfile?.active
              ? 'bg-pool-800 border-pool-700 hover:bg-pool-700'
              : 'bg-pool-800/60 border-dashed border-pool-600 hover:bg-pool-800'
          }`}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-pool-200">Coaching Profile</p>
                <p className="text-xs text-pool-500 mt-0.5">
                  {!coachingProfile?.active
                    ? 'Not set up yet — tap to build'
                    : stale
                    ? `Last updated ${daysOld}d ago — worth refreshing`
                    : `${coachingProfile.title} · ${daysOld}d ago`}
                </p>
              </div>
              <span className={`text-lg ${stale ? 'text-amber-400' : 'text-pool-500'}`}>
                {!coachingProfile?.active ? '+' : stale ? '↻' : '›'}
              </span>
            </div>
          </Link>
        )
      })()}

      {/* Utility links */}
      <div className="grid grid-cols-2 gap-2 pb-2">
        <Link to="/import" className="bg-pool-800 hover:bg-pool-700 border border-pool-700 rounded-xl py-3 text-center text-xs text-pool-400 font-medium transition-colors">
          Import
        </Link>
        <Link to="/schedule" className="bg-pool-800 hover:bg-pool-700 border border-pool-700 rounded-xl py-3 text-center text-xs text-pool-400 font-medium transition-colors">
          Schedule
        </Link>
      </div>

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
