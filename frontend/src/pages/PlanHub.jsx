import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'

const ENERGY_COLOURS = {
  aerobic: 'text-blue-400',
  threshold: 'text-yellow-400',
  speed: 'text-red-400',
  recovery: 'text-green-400',
}

const COHORT_COLOURS = {
  teal:   { bg: 'bg-teal-900/40 border-teal-700/50',   text: 'text-teal-200',   dot: 'bg-teal-400' },
  orange: { bg: 'bg-orange-900/40 border-orange-700/50', text: 'text-orange-200', dot: 'bg-orange-400' },
  blue:   { bg: 'bg-blue-900/40 border-blue-700/50',   text: 'text-blue-200',   dot: 'bg-blue-400' },
  purple: { bg: 'bg-purple-900/40 border-purple-700/50', text: 'text-purple-200', dot: 'bg-purple-400' },
  green:  { bg: 'bg-green-900/40 border-green-700/50', text: 'text-green-200',  dot: 'bg-green-400' },
  red:    { bg: 'bg-red-900/40 border-red-700/50',     text: 'text-red-200',    dot: 'bg-red-400' },
}

const COLOUR_OPTIONS = ['teal', 'orange', 'blue', 'purple', 'green', 'red']

function CalendarIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
    </svg>
  )
}

function ListIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
    </svg>
  )
}

function WriteIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931ZM19.5 7.125 16.875 4.5M18 13.5V19.125A1.875 1.875 0 0 1 16.125 21H4.875A1.875 1.875 0 0 1 3 19.125V7.875A1.875 1.875 0 0 1 4.875 6H10.5" />
    </svg>
  )
}

function SeasonIcon() {
  return (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
    </svg>
  )
}

function SessionRow({ session }) {
  const eColor = ENERGY_COLOURS[session.energy_system_focus] || 'text-pool-400'
  return (
    <Link
      to={`/sessions/${session.id}`}
      className="flex items-center justify-between py-3 border-b border-pool-700/50 last:border-0"
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-pool-100 truncate">{session.title || 'Session'}</p>
        <p className="text-xs text-pool-400 mt-0.5">
          {session.date}
          {session.squad && <span className="ml-2 text-pool-500">{session.squad}</span>}
        </p>
      </div>
      <div className="flex items-center gap-2 ml-3 shrink-0">
        {session.energy_system_focus && (
          <span className={`text-xs font-medium ${eColor}`}>
            {session.energy_system_focus}
          </span>
        )}
        <svg className="w-4 h-4 text-pool-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>
      </div>
    </Link>
  )
}

export default function PlanHub() {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState([])
  const [loadingSessions, setLoadingSessions] = useState(true)
  const [openingPlan, setOpeningPlan] = useState(false)
  const [cohorts, setCohorts] = useState([])
  const [showCohortForm, setShowCohortForm] = useState(false)
  const [newCohort, setNewCohort] = useState({ name: '', colour: 'teal', goals: '' })
  const [savingCohort, setSavingCohort] = useState(false)
  const [editingCohort, setEditingCohort] = useState(null) // cohort being edited
  const [openingAthlete, setOpeningAthlete] = useState(null)

  useEffect(() => {
    api.getSessions({ limit: 8 })
      .then(data => setSessions(Array.isArray(data) ? data.slice(0, 8) : []))
      .catch(() => setSessions([]))
      .finally(() => setLoadingSessions(false))
    api.getCohorts().then(setCohorts).catch(() => {})
  }, [])

  const createCohort = async () => {
    if (!newCohort.name.trim()) return
    setSavingCohort(true)
    try {
      const c = await api.createCohort(newCohort)
      setCohorts(prev => [...prev, c])
      setNewCohort({ name: '', colour: 'teal', goals: '' })
      setShowCohortForm(false)
    } catch {}
    setSavingCohort(false)
  }

  const saveCohortEdit = async () => {
    if (!editingCohort) return
    setSavingCohort(true)
    try {
      const updated = await api.updateCohort(editingCohort.id, {
        name: editingCohort.name,
        colour: editingCohort.colour,
        goals: editingCohort.goals,
      })
      setCohorts(prev => prev.map(c => c.id === updated.id ? updated : c))
      setEditingCohort(null)
    } catch {}
    setSavingCohort(false)
  }

  const deleteCohort = async (id) => {
    if (!window.confirm('Delete this cohort? Swimmers will be unassigned.')) return
    await api.deleteCohort(id)
    setCohorts(prev => prev.filter(c => c.id !== id))
  }

  const openAthletePlan = async (cohort) => {
    setOpeningAthlete(cohort.id)
    try {
      const thread = await api.getOrCreateAthletePlanThread()
      navigate('/ai', { state: { threadId: thread.id, cohortContext: cohort.name } })
    } catch {
      navigate('/ai')
    }
    setOpeningAthlete(null)
  }

  const openSeasonPlan = async () => {
    setOpeningPlan(true)
    try {
      const thread = await api.getOrCreateSeasonPlanThread()
      navigate('/ai', { state: { threadId: thread.id } })
    } catch {
      navigate('/ai')
    }
    setOpeningPlan(false)
  }

  return (
    <div className="px-4 pt-4 pb-6 space-y-5">

      {/* Season Planning */}
      <button
        onClick={openSeasonPlan}
        disabled={openingPlan}
        className="w-full text-left bg-teal-900/40 border border-teal-700/50 rounded-2xl p-4 active:bg-teal-900/60 transition-colors"
      >
        <div className="flex items-start gap-3">
          <span className="p-2 bg-teal-800/50 rounded-xl text-teal-300 shrink-0">
            <SeasonIcon />
          </span>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-teal-200">Season Planning</p>
            <p className="text-sm text-teal-400/80 mt-0.5">
              Macro → meso → micro planning with AI. Build your full season progressively.
            </p>
          </div>
          {openingPlan ? (
            <svg className="w-5 h-5 text-teal-400 animate-spin shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-5 h-5 text-teal-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
          )}
        </div>
      </button>

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-3">
        <Link
          to="/calendar"
          className="bg-pool-800 rounded-2xl p-4 flex flex-col gap-2 active:bg-pool-700 transition-colors"
        >
          <span className="p-2 bg-pool-700 rounded-xl text-accent-400 self-start">
            <CalendarIcon />
          </span>
          <div>
            <p className="font-medium text-sm text-pool-100">Calendar</p>
            <p className="text-xs text-pool-400 mt-0.5">View the weekly timetable</p>
          </div>
        </Link>

        <Link
          to="/session-planner"
          className="bg-pool-800 rounded-2xl p-4 flex flex-col gap-2 active:bg-pool-700 transition-colors"
        >
          <span className="p-2 bg-pool-700 rounded-xl text-accent-400 self-start">
            <WriteIcon />
          </span>
          <div>
            <p className="font-medium text-sm text-pool-100">Write Session</p>
            <p className="text-xs text-pool-400 mt-0.5">Write, preview and save</p>
          </div>
        </Link>
      </div>

      <Link
        to="/sessions"
        className="flex items-center gap-3 bg-pool-800 rounded-xl px-4 py-3 active:bg-pool-700 transition-colors"
      >
        <span className="p-2 bg-pool-700 rounded-lg text-pool-300"><ListIcon /></span>
        <div className="flex-1">
          <p className="text-sm font-medium text-pool-200">Session Log</p>
          <p className="text-xs text-pool-500">Browse previous and saved sessions</p>
        </div>
        <svg className="w-4 h-4 text-pool-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>
      </Link>

      {/* Season overview link */}
      <Link
        to="/season"
        className="flex items-center justify-between bg-pool-800 rounded-xl px-4 py-3 active:bg-pool-700 transition-colors"
      >
        <span className="text-sm font-medium text-pool-200">Season overview & macros</span>
        <svg className="w-4 h-4 text-pool-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>
      </Link>

      {/* Planning Cohorts */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-pool-300 uppercase tracking-wide">Development Cohorts</h2>
          <button
            onClick={() => { setShowCohortForm(p => !p); setEditingCohort(null) }}
            className="text-xs text-accent-400 hover:text-accent-300"
          >
            {showCohortForm ? 'Cancel' : '+ New'}
          </button>
        </div>

        {showCohortForm && (
          <div className="bg-pool-800 rounded-xl p-4 space-y-3 mb-3 border border-pool-600">
            <input
              value={newCohort.name}
              onChange={e => setNewCohort(p => ({ ...p, name: e.target.value }))}
              placeholder="Cohort name (e.g. Sprint Development)"
              className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2.5 text-sm text-pool-100 placeholder-pool-500 focus:border-accent-500 focus:outline-none"
            />
            <textarea
              value={newCohort.goals}
              onChange={e => setNewCohort(p => ({ ...p, goals: e.target.value }))}
              placeholder="Development goals (e.g. Build aerobic base, qualify for nationals in 100/200 sprint events)"
              rows={2}
              className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2.5 text-sm text-pool-100 placeholder-pool-500 focus:border-accent-500 focus:outline-none resize-none"
            />
            <div className="flex items-center gap-2">
              <span className="text-xs text-pool-500">Colour:</span>
              {COLOUR_OPTIONS.map(col => (
                <button
                  key={col}
                  onClick={() => setNewCohort(p => ({ ...p, colour: col }))}
                  className={`w-5 h-5 rounded-full ${COHORT_COLOURS[col]?.dot || 'bg-teal-400'} transition-transform ${newCohort.colour === col ? 'scale-125 ring-2 ring-white/40' : ''}`}
                />
              ))}
            </div>
            <button
              onClick={createCohort}
              disabled={savingCohort || !newCohort.name.trim()}
              className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-2.5 text-sm font-semibold text-white"
            >
              {savingCohort ? 'Creating…' : 'Create cohort'}
            </button>
          </div>
        )}

        {cohorts.length === 0 && !showCohortForm && (
          <div className="bg-pool-800 rounded-xl px-4 py-5 text-center">
            <p className="text-pool-400 text-sm">No cohorts yet.</p>
            <p className="text-pool-500 text-xs mt-1">Group swimmers by shared development goals — sprint group, distance group, competition track etc.</p>
          </div>
        )}

        <div className="space-y-2">
          {cohorts.map(c => {
            const col = COHORT_COLOURS[c.colour] || COHORT_COLOURS.teal
            if (editingCohort?.id === c.id) {
              return (
                <div key={c.id} className={`border rounded-xl p-4 space-y-3 ${col.bg}`}>
                  <input
                    value={editingCohort.name}
                    onChange={e => setEditingCohort(p => ({ ...p, name: e.target.value }))}
                    className="w-full bg-pool-800 border border-pool-600 rounded-xl px-3 py-2 text-sm text-pool-100 focus:outline-none"
                  />
                  <textarea
                    value={editingCohort.goals || ''}
                    onChange={e => setEditingCohort(p => ({ ...p, goals: e.target.value }))}
                    rows={2}
                    className="w-full bg-pool-800 border border-pool-600 rounded-xl px-3 py-2 text-sm text-pool-100 resize-none focus:outline-none"
                  />
                  <div className="flex items-center gap-2">
                    {COLOUR_OPTIONS.map(col2 => (
                      <button
                        key={col2}
                        onClick={() => setEditingCohort(p => ({ ...p, colour: col2 }))}
                        className={`w-5 h-5 rounded-full ${COHORT_COLOURS[col2]?.dot || 'bg-teal-400'} ${editingCohort.colour === col2 ? 'scale-125 ring-2 ring-white/40' : ''}`}
                      />
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setEditingCohort(null)} className="flex-1 bg-pool-700 rounded-xl py-2 text-sm">Cancel</button>
                    <button onClick={saveCohortEdit} disabled={savingCohort} className="flex-1 bg-accent-600 disabled:opacity-40 rounded-xl py-2 text-sm font-semibold text-white">Save</button>
                  </div>
                </div>
              )
            }
            return (
              <div key={c.id} className={`border rounded-xl p-4 space-y-2.5 ${col.bg}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${col.dot}`} />
                    <p className={`font-semibold text-sm ${col.text}`}>{c.name}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setEditingCohort({ ...c })}
                      className="text-xs text-pool-500 hover:text-pool-300"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteCohort(c.id)}
                      className="text-xs text-pool-600 hover:text-red-400"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {c.goals && (
                  <p className="text-xs text-pool-300 leading-relaxed">{c.goals}</p>
                )}

                {c.target_meets?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {c.target_meets.map(m => (
                      <span key={m.id} className="text-[10px] bg-pool-700/60 text-pool-400 rounded-full px-2 py-0.5">
                        {m.name}{m.date ? ` · ${m.date}` : ''}
                      </span>
                    ))}
                  </div>
                )}

                {c.swimmers?.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {c.swimmers.map(s => (
                      <span key={s.id} className="text-[10px] bg-pool-700/60 text-pool-300 rounded-full px-2.5 py-0.5">
                        {s.name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-pool-500 italic">No swimmers assigned — tap + cohort on the Squad page.</p>
                )}

                <button
                  onClick={() => openAthletePlan(c)}
                  disabled={openingAthlete === c.id}
                  className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-pool-700/50 hover:bg-pool-700 transition-colors text-xs font-medium text-pool-300"
                >
                  {openingAthlete === c.id ? (
                    <span>Opening…</span>
                  ) : (
                    <>
                      <span>Plan with AI</span>
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                      </svg>
                    </>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      </div>

      {/* Recent sessions */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-pool-300 uppercase tracking-wide">Recent Sessions</h2>
          <Link to="/sessions" className="text-xs text-accent-400">See all</Link>
        </div>

        <div className="bg-pool-800 rounded-2xl px-4">
          {loadingSessions ? (
            <div className="py-8 text-center text-pool-500 text-sm">Loading…</div>
          ) : sessions.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-pool-400 text-sm">No sessions yet</p>
              <Link to="/session-planner" className="text-accent-400 text-sm mt-1 inline-block">Write your first session</Link>
            </div>
          ) : (
            sessions.map(s => <SessionRow key={s.id} session={s} />)
          )}
        </div>
      </div>

    </div>
  )
}
