import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useSessionPresentation } from '../components/SessionPresentationProvider'

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
  const { energy } = useSessionPresentation()
  const energyDisplay = energy(session.energy_system_focus)
  const eColor = ENERGY_COLOURS[session.energy_system_focus] || 'text-pool-400'
  return (
    <Link
      to={`/sessions/${session.id}`}
      className="flex items-center justify-between py-3 border-b border-pool-700/50 last:border-0"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-pool-100 truncate">{session.title || 'Session'}</p>
          {session.cycle_code && <span className="text-[10px] font-semibold text-teal-300">{session.cycle_code}</span>}
        </div>
        <p className="text-xs text-pool-400 mt-0.5">
          {session.date}
          {session.squad && <span className="ml-2 text-pool-500">{session.squad}</span>}
        </p>
      </div>
      <div className="flex items-center gap-2 ml-3 shrink-0">
        {session.energy_system_focus && (
          <span className={`text-xs font-medium ${eColor}`}>
            {energyDisplay.label}
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
  const [sessions, setSessions] = useState([])
  const [loadingSessions, setLoadingSessions] = useState(true)

  useEffect(() => {
    api.getSessions({ limit: 8 })
      .then(data => setSessions(Array.isArray(data) ? data.slice(0, 8) : []))
      .catch(() => setSessions([]))
      .finally(() => setLoadingSessions(false))
  }, [])

  return (
    <div className="px-4 pt-4 pb-6 space-y-5">

      {/* Season Planning */}
      <Link
        to="/planning"
        className="block w-full text-left bg-teal-900/40 border border-teal-700/50 rounded-2xl p-4 active:bg-teal-900/60 transition-colors"
      >
        <div className="flex items-start gap-3">
          <span className="p-2 bg-teal-800/50 rounded-xl text-teal-300 shrink-0">
            <SeasonIcon />
          </span>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-teal-200">Plan your season</p>
            <p className="text-sm text-teal-400/80 mt-0.5">
              Outline the year around your meets, then plan each block and week, with the timeline building as you go.
            </p>
          </div>
          <svg className="w-5 h-5 text-teal-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
        </div>
      </Link>

      <Link
        to="/coach-checkins"
        className="flex items-start gap-3 rounded-2xl border border-pool-700 bg-pool-800 p-4 active:bg-pool-700 transition-colors"
      >
        <span className="p-2 bg-pool-700 rounded-xl text-teal-300 shrink-0">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6V6a6 6 0 0 0-12 0v6.75a6 6 0 0 0 6 6Zm0 0v3m-3 0h6" />
          </svg>
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-pool-100">Coach check-in</p>
          <p className="text-sm text-pool-400 mt-0.5">Talk through a thought, worry or change in your coaching—whenever it is useful.</p>
        </div>
        <svg className="w-5 h-5 text-pool-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>
      </Link>

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

      {/* Groups: who trains together. Pathways - what each swimmer aims at - live in season planning. */}
      <Link to="/swimmers?view=groups"
        className="flex items-center gap-3 bg-pool-800 rounded-xl px-4 py-3 active:bg-pool-700 transition-colors">
        <div className="flex-1">
          <p className="text-sm font-medium text-pool-200">Training groups</p>
          <p className="text-xs text-pool-500">
            Who trains together. What each swimmer is aiming at is their pathway, set when you plan the season.
          </p>
        </div>
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
