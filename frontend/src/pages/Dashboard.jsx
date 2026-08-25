import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { isSessionNear, localDateKey, weeklySessionQueue } from '../sessionProximity'
import SessionCancellationDialog from '../components/SessionCancellationDialog'

function SessionDesk({ sessions, onRegister, onDismiss, onCancel, busyKey }) {
  if (sessions.length === 0) {
    return (
      <section className="bg-pool-800/70 border border-pool-700 rounded-2xl p-4">
        <p className="text-xs font-semibold text-accent-300 uppercase tracking-wider">Session desk</p>
        <p className="text-sm text-pool-300 mt-2">No outstanding sessions this week.</p>
        <p className="text-xs text-pool-500 mt-1">Completed, cancelled and dismissed sessions stay in the calendar.</p>
      </section>
    )
  }
  return (
    <section className="space-y-2.5">
      <div className="flex items-end justify-between px-0.5">
        <div>
          <p className="text-xs font-semibold text-accent-300 uppercase tracking-wider">Session desk</p>
          <p className="text-[11px] text-pool-500 mt-0.5">Everything still to handle this week</p>
        </div>
        <span className="text-xs text-pool-500">{sessions.length} remaining</span>
      </div>
      <div className="space-y-2.5">
        {sessions.map(session => {
          const query = session.session_id ? `session=${session.session_id}` : `slot=${session.slot_id}`
          const sessionDate = new Date(`${session.date}T12:00:00`)
          const day = sessionDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
          const current = isSessionNear(session)
          const key = `${session.date}-${session.session_id || `slot-${session.slot_id}`}`
          const groups = session.groups || []
          const mods = Object.entries(session.individual_mods || {})
          return (
            <article key={key} className={`rounded-2xl border p-3.5 ${current ? 'bg-accent-900/30 border-accent-600/50' : 'bg-pool-800 border-pool-700'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {current && <span className="w-2 h-2 rounded-full bg-accent-400" />}
                    <p className="text-sm font-semibold text-pool-100 truncate">{session.title || session.label || 'Session'}</p>
                  </div>
                  <p className="text-xs text-pool-400 mt-1">
                    {[day, session.time && `${session.time}${session.end_time ? `–${session.end_time}` : ''}`, session.squad].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => onCancel(session)}
                    className="w-7 h-7 rounded-full border border-red-800/70 bg-red-900/25 text-red-300 text-sm font-bold"
                    aria-label={`Cancel ${session.title || session.label || 'session'}`}
                    title="Record this session as cancelled"
                  >
                    !
                  </button>
                  <button onClick={() => onDismiss(session)} className="text-[11px] text-pool-500 hover:text-pool-300 py-1">Dismiss</button>
                </div>
              </div>

              {(session.coach_intent || session.coach_notes || groups.length > 0 || mods.length > 0) ? (
                <div className="mt-3 border-t border-pool-700/70 pt-2.5 space-y-2">
                  {session.coach_intent && <p className="text-xs text-pool-300 whitespace-pre-line"><span className="text-pool-500">Aim · </span>{session.coach_intent}</p>}
                  {groups.map(group => (
                    <div key={group.group_number} className="text-xs">
                      <span className="font-semibold text-accent-300">G{group.group_number}</span>
                      {group.description && <span className="text-pool-300"> · {group.description}</span>}
                      {group.sets && <p className="text-pool-500 font-mono mt-0.5 line-clamp-2 whitespace-pre-line">{group.sets}</p>}
                    </div>
                  ))}
                  {session.coach_notes && <p className="text-xs text-amber-200/90 line-clamp-2 whitespace-pre-line">{session.coach_notes}</p>}
                  {mods.length > 0 && <p className="text-xs text-amber-300">{mods.length} individual note{mods.length === 1 ? '' : 's'} attached</p>}
                </div>
              ) : (
                <p className="text-xs text-pool-500 mt-3 border-t border-pool-700/70 pt-2.5">No session plan attached yet.</p>
              )}

              <div className="grid grid-cols-3 gap-2 mt-3">
                <button onClick={() => onRegister(session)} disabled={busyKey === key}
                  className="bg-accent-600 disabled:opacity-50 rounded-lg py-2.5 text-xs font-semibold">
                  {busyKey === key ? 'Opening…' : 'Take register'}
                </button>
                <Link to={`/import?tab=excel&date=${session.date}&slot=${session.slot_id || ''}&session=${session.session_id || ''}`}
                  className="bg-pool-700 border border-pool-600 rounded-lg py-2.5 text-xs text-center font-semibold text-pool-200">
                  Import plan
                </Link>
                <Link to={`/today-session?${query}`}
                  className="bg-pool-700 border border-pool-600 rounded-lg py-2.5 text-xs text-center font-semibold text-pool-300">
                  Open dash
                </Link>
              </div>
            </article>
          )
        })}
      </div>
    </section>
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

function AttendanceStatus({ swimmer }) {
  if (swimmer.attendance_state === 'established') {
    return <AttendanceBar attended={swimmer.sessions_attended} expected={swimmer.sessions_expected} />
  }
  const label = swimmer.attendance_state === 'building_baseline'
    ? `${swimmer.sessions_recorded || 0} logged · % after 4`
    : 'Not baselined'
  return (
    <span
      title="Attendance percentage is calculated after 4 recorded sessions"
      className="text-[10px] text-teal-300 bg-teal-900/25 border border-teal-800/40 px-1.5 py-0.5 rounded-md whitespace-nowrap"
    >
      {label}
    </span>
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
  const { id, name, approaching_target, last_observation, has_recent_skill_flag } = swimmer
  const noData = swimmer.sessions_recorded === 0 && !last_observation && !approaching_target && !swimmer.current_availability

  return (
    <Link to={`/swimmers/${id}`} className="block active:opacity-70 transition-opacity">
      <div className="py-2.5 border-b border-pool-800 last:border-0">
        <div className="flex items-center gap-2.5">
          {/* Name */}
          <span className="text-sm font-medium text-pool-200 w-28 shrink-0 truncate">{name}</span>

          {/* Attendance */}
          <AttendanceStatus swimmer={swimmer} />

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
        {swimmer.current_availability && (
          <p className="text-[11px] text-amber-400 mt-1 truncate">
            {swimmer.current_availability.label}
            {swimmer.current_availability.detail ? ` — ${swimmer.current_availability.detail}` : ''}
            {` · until ${swimmer.current_availability.date_to}`}
          </p>
        )}
        {noData && swimmer.attendance_state === 'established' && (
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
        <span className="text-[10px] text-pool-600">Attendance % shown after 4 recorded sessions</span>
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

function SeasonStartCard({ onStarted }) {
  const now = new Date()
  const year = now.getFullYear()
  const seasonEndYear = now.getMonth() >= 6 ? year + 1 : year
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    name: `${seasonEndYear - 1}/${String(seasonEndYear).slice(-2)} Season`,
    squad: 'Silver 1',
    date_from: now.toISOString().slice(0, 10),
    date_to: `${seasonEndYear}-07-31`,
    narrative: '',
  })

  const submit = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const season = await api.startPlanningSeason({ ...form, is_current: true })
      await onStarted(season, 'Season started and saved.')
    } catch (err) {
      // The server may have committed successfully even if the response was
      // interrupted. Read back the durable state before showing a failure.
      try {
        const current = await api.getCurrentPlanningSeason()
        const matches = current
          && current.name === form.name
          && current.date_from === form.date_from
          && current.date_to === form.date_to
        if (matches) {
          await onStarted(current, 'Season was saved successfully. The confirmation response was interrupted.')
          return
        }
      } catch {
        // Keep the original error below, with a safe retry instruction.
      }
      setError(`${err.message || 'Could not confirm the season save'}. Refresh before trying again; it may already have saved.`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="bg-teal-900/20 border border-teal-700/40 rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-teal-300 uppercase tracking-wide">New season</p>
          <h2 className="font-semibold text-pool-100 mt-1">Start the current-season baseline</h2>
          <p className="text-xs text-pool-400 mt-1 leading-relaxed">
            This keeps every old time and coaching note, but stops last season's missing registers being treated as current concerns.
          </p>
        </div>
        {!expanded && (
          <button onClick={() => setExpanded(true)} className="shrink-0 bg-teal-700 hover:bg-teal-600 rounded-lg px-3 py-2 text-xs font-semibold">
            Start
          </button>
        )}
      </div>
      {expanded && (
        <form onSubmit={submit} className="mt-4 space-y-3 border-t border-teal-800/40 pt-4">
          <label className="block text-xs text-pool-400">
            Season name
            <input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
              className="mt-1 w-full bg-pool-900 border border-pool-600 rounded-lg px-3 py-2.5 text-sm text-pool-100" />
          </label>
          <label className="block text-xs text-pool-400">
            Squad
            <input value={form.squad} onChange={e => setForm({ ...form, squad: e.target.value })}
              className="mt-1 w-full bg-pool-900 border border-pool-600 rounded-lg px-3 py-2.5 text-sm text-pool-100" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-pool-400">
              Starts
              <input required type="date" value={form.date_from} onChange={e => setForm({ ...form, date_from: e.target.value })}
                className="mt-1 w-full bg-pool-900 border border-pool-600 rounded-lg px-2 py-2.5 text-sm text-pool-100" />
            </label>
            <label className="block text-xs text-pool-400">
              Ends
              <input required type="date" value={form.date_to} onChange={e => setForm({ ...form, date_to: e.target.value })}
                className="mt-1 w-full bg-pool-900 border border-pool-600 rounded-lg px-2 py-2.5 text-sm text-pool-100" />
            </label>
          </div>
          <label className="block text-xs text-pool-400">
            Opening intent (optional)
            <textarea rows="2" value={form.narrative} onChange={e => setForm({ ...form, narrative: e.target.value })}
              placeholder="e.g. Re-establish routines, assess current capacity, then build towards winter meets"
              className="mt-1 w-full bg-pool-900 border border-pool-600 rounded-lg px-3 py-2.5 text-sm text-pool-100 resize-none" />
          </label>
          {error && <p className="text-xs text-red-300">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => setExpanded(false)} className="flex-1 bg-pool-700 rounded-lg py-2.5 text-sm font-semibold">Cancel</button>
            <button disabled={saving} className="flex-1 bg-teal-700 disabled:opacity-50 rounded-lg py-2.5 text-sm font-semibold">
              {saving ? 'Starting...' : 'Start season'}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

function CurrentSeasonCard({ season, pulse, notice }) {
  const established = pulse.filter(sw => sw.attendance_state === 'established').length
  const building = pulse.filter(sw => sw.attendance_state === 'building_baseline').length
  return (
    <section className="bg-pool-800/60 border border-pool-700/60 rounded-xl px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-teal-300 truncate">{season.name}</p>
          <p className="text-[11px] text-pool-500 mt-0.5">Current baseline starts {season.date_from}</p>
        </div>
        <span className="text-[11px] text-pool-400 shrink-0">
          {building > 0 ? `${established}/${pulse.length} established` : `${established} established`}
        </span>
      </div>
      {building > 0 && (
        <p className="text-[11px] text-pool-500 mt-2">Keep taking registers; attendance flags begin after 4 recorded opportunities per swimmer.</p>
      )}
      {notice && (
        <p className="text-[11px] text-emerald-300 mt-2">{notice}</p>
      )}
    </section>
  )
}

function AvailabilityCard({ report }) {
  const [expanded, setExpanded] = useState(false)
  const items = report?.items || []
  if (items.length === 0) return null
  const visible = expanded ? items : items.slice(0, 5)
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-4 bg-amber-500 rounded-full" />
          <h2 className="font-semibold text-sm">Squad availability</h2>
        </div>
        <span className="text-[11px] text-pool-500">
          {report.current_count || 0} away now · {report.upcoming_count || 0} upcoming
        </span>
      </div>
      <div className="bg-pool-800 border border-pool-700 rounded-2xl divide-y divide-pool-700/60">
        {visible.map((item, index) => (
          <Link key={`${item.swimmer_id}-${item.date_from}-${item.reason}-${index}`} to={`/swimmers/${item.swimmer_id}`}
            className="flex items-center justify-between gap-3 px-4 py-3 active:bg-pool-700/50">
            <div className="min-w-0">
              <p className="text-sm font-medium text-pool-200 truncate">{item.swimmer_name}</p>
              <p className="text-xs text-pool-500 truncate">
                {item.detail || item.label} · {item.date_from === item.date_to ? item.date_from : `${item.date_from} → ${item.date_to}`}
              </p>
            </div>
            <span className={`text-[10px] px-2 py-1 rounded-md shrink-0 ${
              item.is_current ? 'bg-amber-900/50 text-amber-300' : 'bg-pool-700 text-pool-400'
            }`}>{item.is_current ? item.label : `in ${item.days_until}d`}</span>
          </Link>
        ))}
      </div>
      {items.length > 5 && (
        <button onClick={() => setExpanded(value => !value)} className="w-full text-xs text-pool-500 py-2">
          {expanded ? 'Show less' : `Show ${items.length - 5} more`}
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

function AssistantInboxPreview({ inbox }) {
  const items = (inbox?.items || []).filter(item => item.status === 'open').slice(0, 3)
  const openCount = inbox?.counts?.open || 0
  const progressCount = inbox?.counts?.in_progress || 0
  if (openCount === 0 && progressCount === 0) return null

  return (
    <section className="bg-pool-800 border border-pool-700 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-pool-700/70">
        <div>
          <p className="text-xs font-semibold text-accent-300 uppercase tracking-wide">Assistant coach</p>
          <p className="text-[11px] text-pool-500 mt-0.5">
            {openCount} need{openCount === 1 ? 's' : ''} a decision
            {progressCount > 0 ? ` · ${progressCount} in progress` : ''}
          </p>
        </div>
        <Link to="/assistant" className="text-xs text-accent-400 font-semibold">Open inbox →</Link>
      </div>
      {items.length > 0 && (
        <div className="divide-y divide-pool-700/60">
          {items.map(item => (
            <Link key={item.id} to="/assistant" className="block px-4 py-3 active:bg-pool-700/50">
              <div className="flex items-start gap-2.5">
                <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${item.severity === 'warning' ? 'bg-amber-400' : 'bg-teal-400'}`} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-pool-200">{item.title}</p>
                  <p className="text-xs text-pool-500 mt-0.5 line-clamp-2">{item.detail}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}

function CoachingWatchpoints({ notes, onDismiss }) {
  const [open, setOpen] = useState(false)
  const [openNoteId, setOpenNoteId] = useState(null)
  if (notes.length === 0) return null

  const swimmerNames = [...new Set(notes.flatMap(note => note.swimmer_names || []))]
  const scope = swimmerNames.length > 0
    ? `${swimmerNames.length} swimmer${swimmerNames.length === 1 ? '' : 's'}`
    : 'squad-wide'

  return (
    <section className="bg-amber-900/15 border border-amber-800/35 rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <div className="flex items-start gap-2.5 min-w-0">
          <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0 mt-1.5" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-200">Coaching watchpoints</p>
            <p className="text-[11px] text-pool-500 mt-0.5">
              {notes.length} active · {scope} · used in planning and on deck
            </p>
          </div>
        </div>
        <span className={`text-pool-500 text-sm transition-transform ${open ? 'rotate-180' : ''}`}>⌄</span>
      </button>

      {open && (
        <div className="border-t border-amber-800/30 divide-y divide-amber-800/25">
          {notes.map(note => {
            const noteOpen = openNoteId === note.id
            return (
              <article key={note.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <button type="button" onClick={() => setOpenNoteId(noteOpen ? null : note.id)} className="min-w-0 flex-1 text-left">
                    <p className="text-sm font-medium text-pool-200">{note.title}</p>
                    <p className="text-[11px] text-pool-500 mt-0.5">
                      {note.swimmer_names?.join(', ') || 'Squad'} · until {note.date_to}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDismiss(note.id)}
                    className="text-[11px] text-pool-500 hover:text-red-300 shrink-0 py-1"
                    title="Stop using this watchpoint"
                  >
                    Dismiss
                  </button>
                </div>
                {noteOpen && (
                  <div className="mt-2">
                    <p className="text-xs text-pool-300 whitespace-pre-line leading-relaxed">{note.body}</p>
                    <p className="text-[10px] text-pool-600 mt-2">Active {note.date_from} → {note.date_to}</p>
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [calendar, setCalendar] = useState([])
  const [pulse, setPulse] = useState([])
  const [loading, setLoading] = useState(true)
  const [coachingNotes, setCoachingNotes] = useState([])
  const [coachingProfile, setCoachingProfile] = useState(null)
  const [meetCountdowns, setMeetCountdowns] = useState({ group_targets: [], upcoming_meets: [] })
  const [assistantInbox, setAssistantInbox] = useState({ items: [], counts: {} })
  const [currentSeason, setCurrentSeason] = useState(null)
  const [availability, setAvailability] = useState({ items: [], current_count: 0, upcoming_count: 0 })
  const [seasonNotice, setSeasonNotice] = useState('')
  const [busySessionKey, setBusySessionKey] = useState('')
  const [cancelTarget, setCancelTarget] = useState(null)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.getCalendar().catch(() => []),
      api.getCoachingNotes().catch(() => []),
      api.getAIContextStatus().catch(() => null),
      api.getSquadPulse().catch(() => []),
      api.getMeetCountdowns().catch(() => ({ group_targets: [], upcoming_meets: [] })),
      api.getAssistantInbox({ limit: 3 }).catch(() => ({ items: [], counts: {} })),
      api.getCurrentPlanningSeason().catch(() => null),
      api.getSquadAvailability().catch(() => ({ items: [], current_count: 0, upcoming_count: 0 })),
    ]).then(([cal, notes, ctx, pulseData, countdowns, inbox, season, availabilityData]) => {
      setCalendar(cal)
      setCoachingNotes(notes)
      setCoachingProfile(ctx)
      setPulse(pulseData)
      setMeetCountdowns(countdowns)
      setAssistantInbox(inbox)
      setCurrentSeason(season)
      setAvailability(availabilityData)
      setLoading(false)
    })
  }, [])

  const dismissNote = async (id) => {
    await api.updateCoachingNote(id, { active: false })
    setCoachingNotes(prev => prev.filter(n => n.id !== id))
  }

  const today = new Date()
  const todayStr = localDateKey(today)
  const activeSeason = currentSeason && currentSeason.date_to >= todayStr ? currentSeason : null

  const sessionQueue = weeklySessionQueue(calendar, today)

  const handleSeasonStarted = async (season, notice = '') => {
    setCurrentSeason(season)
    setSeasonNotice(notice)
    const [pulseData, inbox] = await Promise.all([
      api.getSquadPulse().catch(() => []),
      api.getAssistantInbox({ limit: 3 }).catch(() => ({ items: [], counts: {} })),
    ])
    setPulse(pulseData)
    setAssistantInbox(inbox)
  }

  const openRegister = async (item) => {
    const key = `${item.date}-${item.session_id || `slot-${item.slot_id}`}`
    setBusySessionKey(key)
    try {
      if (item.session_id) {
        navigate(`/sessions/${item.session_id}/register`)
        return
      }
      const created = await api.startCalendarSession({ pool_slot_id: item.slot_id, date: item.date })
      navigate(`/sessions/${created.id}/register`)
    } catch (error) {
      alert(`Could not open register: ${error.message}`)
      setBusySessionKey('')
    }
  }

  const dismissSession = async (item) => {
    if (!window.confirm(`Remove ${item.title || item.label || 'this session'} from the home session desk?`)) return
    try {
      await api.dismissCalendarSession({
        date: item.date,
        pool_slot_id: item.slot_id || null,
        session_id: item.session_id || null,
      })
      setCalendar(previous => previous.map(day => ({
        ...day,
        items: (day.items || []).map(row => {
          const sameSession = item.session_id && row.session_id === item.session_id
          const sameOccurrence = !item.session_id && day.date === item.date && row.slot_id === item.slot_id
          return sameSession || sameOccurrence ? { ...row, status: 'dismissed' } : row
        }),
      })))
    } catch (error) {
      alert(`Could not dismiss session: ${error.message}`)
    }
  }

  const sessionCancelled = (result) => {
    const item = cancelTarget
    setCalendar(previous => previous.map(day => ({
      ...day,
      items: (day.items || []).map(row => {
        const sameSession = row.session_id === result.session_id
        const sameOccurrence = item?.slot_id && day.date === item.date && row.slot_id === item.slot_id
        return sameSession || sameOccurrence
          ? { ...row, session_id: result.session_id, status: 'cancelled', cancel_reason: result.cancel_reason }
          : row
      }),
    })))
    setCancelTarget(null)
  }

  // Swimmers needing attention from pulse (approaching target in ≤2 weeks or very low attendance)
  const flaggedSwimmers = pulse.filter(sw =>
    (sw.approaching_target && sw.approaching_target.weeks_out <= 2) ||
    (sw.attendance_state === 'established' && sw.sessions_expected >= 4 &&
      sw.sessions_attended / sw.sessions_expected < 0.4)
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

      {!loading && (
        <SessionDesk
          sessions={sessionQueue}
          onRegister={openRegister}
          onDismiss={dismissSession}
          onCancel={setCancelTarget}
          busyKey={busySessionKey}
        />
      )}

      {!loading && !activeSeason && <SeasonStartCard onStarted={handleSeasonStarted} />}
      {!loading && activeSeason && <CurrentSeasonCard season={activeSeason} pulse={pulse} notice={seasonNotice} />}

      {!loading && <AvailabilityCard report={availability} />}

      <AssistantInboxPreview inbox={assistantInbox} />

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

      <CoachingWatchpoints notes={coachingNotes} onDismiss={dismissNote} />

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

      <SessionCancellationDialog
        session={cancelTarget}
        onClose={() => setCancelTarget(null)}
        onCancelled={sessionCancelled}
      />

    </div>
  )
}
