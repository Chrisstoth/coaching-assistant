import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'

const ENERGY_COLOURS = {
  aerobic: 'text-blue-400',
  threshold: 'text-yellow-400',
  speed: 'text-red-400',
  recovery: 'text-green-400',
}

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

  useEffect(() => {
    api.getSessions({ limit: 8 })
      .then(data => setSessions(Array.isArray(data) ? data.slice(0, 8) : []))
      .catch(() => setSessions([]))
      .finally(() => setLoadingSessions(false))
  }, [])

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
            <p className="font-medium text-sm text-pool-100">Write Sessions</p>
            <p className="text-xs text-pool-400 mt-0.5">Schedule & build sessions</p>
          </div>
        </Link>

        <Link
          to="/sessions"
          className="bg-pool-800 rounded-2xl p-4 flex flex-col gap-2 active:bg-pool-700 transition-colors"
        >
          <span className="p-2 bg-pool-700 rounded-xl text-pool-300 self-start">
            <ListIcon />
          </span>
          <div>
            <p className="font-medium text-sm text-pool-100">Session Log</p>
            <p className="text-xs text-pool-400 mt-0.5">Browse all sessions</p>
          </div>
        </Link>
      </div>

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
              <Link to="/calendar" className="text-accent-400 text-sm mt-1 inline-block">Write your first session</Link>
            </div>
          ) : (
            sessions.map(s => <SessionRow key={s.id} session={s} />)
          )}
        </div>
      </div>

    </div>
  )
}
