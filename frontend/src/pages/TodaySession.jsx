import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { calendarSessions, localDateKey, matchingWeeklySessions, proximateSessions, weeklySessionQueue } from '../sessionProximity'
import SessionCancellationDialog from '../components/SessionCancellationDialog'
import { useSessionPresentation } from '../components/SessionPresentationProvider'

function timeLabel(item) {
  const start = item?.start_time || item?.time
  if (!start) return null
  return `${start}${item.end_time ? `–${item.end_time}` : ''}`
}

function planGroups(session) {
  if (session?.groups?.length) return session.groups
  return Object.entries(session?.planned_content || {}).map(([key, value], index) => ({
    group_number: value?.group_number || String(key).replace(/\D/g, '') || index + 1,
    ...value,
  }))
}

function WeeklyPlanCard({ plan }) {
  const { energy } = useSessionPresentation()
  const focus = plan.session_type || plan.energy_focus || plan.focus
  const focusLabel = energy(focus).label
  const planStatus = plan._microcycle?.status
  return (
    <div className="bg-teal-900/20 border border-teal-700/40 rounded-xl p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-teal-300 uppercase tracking-wide">Weekly plan{plan.cycle_code ? ` · ${plan.cycle_code}` : ''}</p>
        <span className="text-[11px] text-teal-200 capitalize">
          {[focusLabel, planStatus === 'draft' ? 'draft' : null].filter(Boolean).join(' · ')}
        </span>
      </div>
      {plan.key_emphasis && <p className="text-sm text-pool-200 mt-1.5">{plan.key_emphasis}</p>}
      {plan.session_goal && <p className="text-xs text-pool-400 mt-1">{plan.session_goal}</p>}
      {plan.notes && <p className="text-xs text-pool-400 mt-1 whitespace-pre-line">{plan.notes}</p>}
    </div>
  )
}

function GroupCard({ group }) {
  const volume = Object.values(group.volume_breakdown || {}).reduce((sum, value) => sum + (Number(value) || 0), 0)
  return (
    <div className="bg-pool-800 border border-pool-700 rounded-xl p-3.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-accent-300">Group {group.group_number}</p>
        {volume > 0 && <span className="text-[11px] text-pool-500">{volume.toLocaleString()}m</span>}
      </div>
      {group.description && <p className="text-sm text-pool-200 mt-1.5 whitespace-pre-wrap">{group.description}</p>}
      {group.sets?.raw && group.sets.raw !== group.description && (
        <p className="text-xs text-pool-400 mt-2 whitespace-pre-wrap font-mono">{group.sets.raw}</p>
      )}
      {group.sub_groups?.length > 0 && (
        <div className="mt-2.5 space-y-1.5 border-t border-pool-700 pt-2.5">
          {group.sub_groups.map(sub => (
            <div key={sub.id || sub.label} className="text-xs">
              <span className="font-semibold text-pool-300">{sub.label}</span>
              {sub.aim && <span className="text-pool-400"> · {sub.aim}</span>}
              {sub.sets?.raw && <p className="text-pool-500 mt-0.5 whitespace-pre-wrap">{sub.sets.raw}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SessionWatchpoint({ note, names }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="py-2.5">
      <button type="button" onClick={() => setOpen(value => !value)} className="w-full flex items-start justify-between gap-3 text-left" aria-expanded={open}>
        <div>
          <p className="text-xs font-semibold text-amber-200">{names || 'Squad'} · {note.title}</p>
          <p className="text-[10px] text-pool-500 mt-0.5">Coaching watchpoint · tap to {open ? 'hide' : 'review'}</p>
        </div>
        <span className={`text-pool-500 transition-transform ${open ? 'rotate-180' : ''}`}>⌄</span>
      </button>
      {open && <p className="text-xs text-pool-300 mt-2 whitespace-pre-line leading-relaxed">{note.body}</p>}
    </div>
  )
}

export default function TodaySession() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [calendar, setCalendar] = useState([])
  const [session, setSession] = useState(null)
  const [register, setRegister] = useState([])
  const [notes, setNotes] = useState([])
  const [microcycles, setMicrocycles] = useState([])
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [showRoster, setShowRoster] = useState(false)
  const [showCancellation, setShowCancellation] = useState(false)
  const [error, setError] = useState('')
  const today = localDateKey()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [cal, coachingNotes, weeks] = await Promise.all([
        api.getCalendar(),
        api.getCoachingNotes().catch(() => []),
        api.getMicrocycles().catch(() => []),
      ])
      setCalendar(cal)
      setNotes(coachingNotes)
      setMicrocycles(weeks)

      const nearby = proximateSessions(cal)
      const available = calendarSessions(cal).filter(item => !['cancelled', 'dismissed'].includes(item.status))
      const requestedSession = Number(searchParams.get('session'))
      const requestedSlot = Number(searchParams.get('slot'))
      const chosen = available.find(item => requestedSession && item.session_id === requestedSession)
        || available.find(item => requestedSlot && item.slot_id === requestedSlot)
        || nearby[0]
        || weeklySessionQueue(cal)[0]

      if (!chosen?.session_id) {
        setSession(chosen || null)
        setRegister([])
        return
      }

      const [detail, registerRows] = await Promise.all([
        api.getSession(chosen.session_id),
        api.getRegister(chosen.session_id),
      ])
      setSession({ ...chosen, ...detail, session_id: detail.id })
      setRegister(registerRows)
    } catch (err) {
      setError(err.message || 'Could not load today’s session')
    } finally {
      setLoading(false)
    }
  }, [searchParams, today])

  useEffect(() => { load() }, [load])

  const nearby = useMemo(() => weeklySessionQueue(calendar), [calendar])
  const weeklyPlans = useMemo(
    () => session ? matchingWeeklySessions(microcycles, session, session.date || today) : [],
    [microcycles, session, today]
  )
  const groups = planGroups(session)
  const sessionDate = session?.date || today
  const datedNotes = notes.filter(note => note.date_from <= sessionDate && note.date_to >= sessionDate)
  const individualMods = Object.entries(session?.individual_mods || {})
  const registerMap = new Map(register.map(row => [row.swimmer_id, row]))
  const recordedRows = register.filter(row => row.attended !== null)
  const presentCount = recordedRows.filter(row => row.attended).length
  const roster = register
  const unavailable = register.filter(row => row.exception_reason)
  const swimmerName = id => registerMap.get(id)?.swimmer_name

  const startScheduledSession = async () => {
    if (!session?.slot_id) return
    setStarting(true)
    setError('')
    try {
      const created = await api.startCalendarSession({ pool_slot_id: session.slot_id, date: session.date || today })
      navigate(`/sessions/${created.id}/register`)
    } catch (err) {
      setError(err.message || 'Could not start the session')
      setStarting(false)
    }
  }

  const dismissSession = async () => {
    if (!window.confirm(`Remove ${session.title || session.label || 'this session'} from the home session desk?`)) return
    try {
      await api.dismissCalendarSession({
        date: session.date || today,
        pool_slot_id: session.slot_id || session.pool_slot_id || null,
        session_id: session.session_id || null,
      })
      navigate('/')
    } catch (err) {
      setError(err.message || 'Could not dismiss the session')
    }
  }

  if (loading) return <div className="p-4 text-pool-400">Loading today’s session…</div>

  if (!session) {
    return (
      <div className="p-4 space-y-4">
        <div className="flex items-center gap-3 pt-2">
          <button onClick={() => navigate('/')} className="text-pool-400 text-2xl" aria-label="Back home">‹</button>
          <h1 className="text-lg font-bold">Session desk</h1>
        </div>
        <div className="bg-pool-800 border border-pool-700 rounded-2xl p-5 text-center">
          <p className="font-semibold text-pool-200">{error ? 'Could not load sessions' : 'No outstanding session'}</p>
          <p className={`text-sm mt-1 ${error ? 'text-red-300' : 'text-pool-500'}`}>
            {error || 'There are no outstanding sessions left in this week.'}
          </p>
          <Link to="/calendar" className="inline-block mt-4 text-sm font-semibold text-accent-400">Open calendar →</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-3 pt-2">
        <button onClick={() => navigate('/')} className="text-pool-400 text-2xl" aria-label="Back home">‹</button>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-accent-400 uppercase tracking-wider">Session desk</p>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold truncate">{session.title || session.label || 'Session'}</h1>
            {session.cycle_code && <span className="text-[10px] font-semibold text-teal-300 bg-teal-900/35 rounded px-1.5 py-0.5 shrink-0">{session.cycle_code}</span>}
          </div>
          <p className="text-xs text-pool-400 mt-0.5">
            {[session.date, timeLabel(session), session.squad, session.course].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Link to={`/import?tab=excel&date=${session.date || today}&slot=${session.slot_id || session.pool_slot_id || ''}&session=${session.session_id || ''}`}
          className="bg-pool-800 border border-pool-700 rounded-xl py-2.5 text-center text-xs font-semibold text-pool-200">
          Import plan
        </Link>
        <button onClick={() => setShowCancellation(true)} className="bg-red-900/25 border border-red-800/60 rounded-xl py-2.5 text-xs font-semibold text-red-300">
          Cancel session
        </button>
        <button onClick={dismissSession} className="bg-pool-800 border border-pool-700 rounded-xl py-2.5 text-xs font-semibold text-pool-400">
          Dismiss
        </button>
      </div>

      {nearby.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {nearby.map(item => {
            const active = (item.session_id && item.session_id === session.session_id) || (!item.session_id && item.slot_id === session.slot_id)
            return (
              <button key={`${item.session_id || 'slot'}-${item.slot_id || item.label}`}
                onClick={() => setSearchParams(item.session_id ? { session: item.session_id } : { slot: item.slot_id })}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${active ? 'bg-accent-600 text-white' : 'bg-pool-800 text-pool-400 border border-pool-700'}`}>
                {item.label || item.title} {item.time || ''}
              </button>
            )
          })}
        </div>
      )}

      {error && <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-3 text-sm text-red-300">{error}</div>}

      {!session.session_id ? (
        <section className="bg-accent-900/25 border border-accent-700/50 rounded-2xl p-4">
          <p className="font-semibold text-pool-100">Register ready</p>
          <p className="text-xs text-pool-400 mt-1">The session record will be created automatically when you open the register.</p>
          <button onClick={startScheduledSession} disabled={starting}
            className="w-full mt-3 bg-accent-600 disabled:opacity-50 rounded-xl py-3 text-sm font-semibold">
            {starting ? 'Opening…' : 'Take register'}
          </button>
        </section>
      ) : (
        <section className="bg-accent-900/25 border border-accent-700/50 rounded-2xl p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-accent-300 uppercase tracking-wide">Register</p>
              <p className="text-sm text-pool-200 mt-1">
                {recordedRows.length > 0
                  ? `${presentCount} present · ${recordedRows.length} marked`
                  : `${roster.length} active swimmers · not started`}
              </p>
            </div>
            <Link to={`/sessions/${session.session_id}/register`} className="bg-accent-600 rounded-xl px-4 py-2.5 text-sm font-semibold">
              Open register
            </Link>
          </div>
          {roster.length > 0 && (
            <div className="mt-3 border-t border-accent-800/40 pt-2.5">
              {(showRoster ? roster : roster.slice(0, 5)).map(row => (
                <div key={row.id || row.swimmer_id} className="flex items-center gap-2 py-1.5 text-xs">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${row.attended === true ? 'bg-emerald-400' : row.attended === false ? 'bg-pool-600' : 'border border-pool-500'}`} />
                  <span className="text-pool-300 flex-1 truncate">{row.name || row.swimmer_name}</span>
                  {row.exception_reason && <span className="text-amber-400">Away</span>}
                  {row.usual_for_slot && <span className="text-pool-500">Usual</span>}
                  {row.group_planned && <span className="text-pool-500">G{row.group_planned}{row.sub_group_planned || ''}</span>}
                </div>
              ))}
              {roster.length > 5 && (
                <button onClick={() => setShowRoster(value => !value)} className="text-xs text-accent-400 mt-1">
                  {showRoster ? 'Show less' : `Show all ${roster.length}`}
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {(session.coach_intent || session.coach_notes || weeklyPlans.length > 0 || groups.length > 0) && (
        <section className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">What they’re doing</h2>
            {session.session_id && <Link to={`/sessions/${session.session_id}`} className="text-xs text-pool-500">Full session →</Link>}
          </div>
          {session.coach_intent && (
            <div className="bg-pool-800 border border-pool-700 rounded-xl p-3.5">
              <p className="text-[11px] text-pool-500 uppercase tracking-wide font-semibold">Coach intent</p>
              <p className="text-sm text-pool-200 mt-1">{session.coach_intent}</p>
            </div>
          )}
          {session.coach_notes && (
            <div className="bg-pool-800 border border-pool-700 rounded-xl p-3.5">
              <p className="text-[11px] text-pool-500 uppercase tracking-wide font-semibold">Deck notes</p>
              <p className="text-sm text-pool-200 mt-1 whitespace-pre-line">{session.coach_notes}</p>
            </div>
          )}
          {weeklyPlans.map((plan, index) => <WeeklyPlanCard key={`${plan.date || plan.day}-${index}`} plan={plan} />)}
          {groups.map(group => <GroupCard key={group.id || group.group_number} group={group} />)}
        </section>
      )}

      {(individualMods.length > 0 || datedNotes.length > 0 || unavailable.length > 0) && (
        <section className="space-y-2.5">
          <h2 className="text-sm font-semibold">Session watchpoints & individual notes</h2>
          <div className="bg-amber-900/20 border border-amber-700/40 rounded-2xl divide-y divide-amber-800/30 px-4">
            {individualMods.map(([name, body]) => (
              <div key={`mod-${name}`} className="py-3">
                <p className="text-xs font-semibold text-amber-200">{name}</p>
                <p className="text-xs text-pool-300 mt-1 whitespace-pre-line">{body}</p>
              </div>
            ))}
            {datedNotes.map(note => {
              const names = (note.swimmer_names?.length
                    ? note.swimmer_names
                    : (note.swimmer_ids || []).map(swimmerName).filter(Boolean)
                  ).join(', ')
              return <SessionWatchpoint key={`note-${note.id}`} note={note} names={names} />
            })}
            {unavailable.map(row => (
              <div key={`away-${row.swimmer_id}`} className="py-3">
                <p className="text-xs font-semibold text-amber-200">{row.swimmer_name} · {row.availability?.label || row.exception_reason.replaceAll('_', ' ')}</p>
                {row.availability?.detail && <p className="text-xs text-pool-300 mt-1">{row.availability.detail}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {!session.coach_intent && !session.coach_notes && weeklyPlans.length === 0 && groups.length === 0 && (
        <section className="bg-pool-800/60 border border-dashed border-pool-600 rounded-2xl p-4 text-center">
          <p className="text-sm font-semibold text-pool-300">No session plan attached yet</p>
          <p className="text-xs text-pool-500 mt-1">The register is ready; add the set when you have it.</p>
          {session.session_id && <Link to={`/sessions/${session.session_id}`} className="inline-block text-xs text-accent-400 font-semibold mt-3">Add session detail →</Link>}
        </section>
      )}

      <SessionCancellationDialog
        session={showCancellation ? session : null}
        onClose={() => setShowCancellation(false)}
        onCancelled={() => navigate('/')}
      />
    </div>
  )
}
