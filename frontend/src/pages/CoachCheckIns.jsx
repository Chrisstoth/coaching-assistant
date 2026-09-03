import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'

const KIND_LABELS = {
  adhoc: 'Ad-hoc',
  monthly: 'Monthly reflection',
  season_start: 'Season start',
  meso_midpoint: 'Mid-meso',
  meso_end: 'End of meso',
  post_meet: 'Post-meet',
  macro_end: 'End of macro',
  season_end: 'Season review',
}

function dateLabel(value) {
  if (!value) return ''
  return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function CoachCheckIns() {
  const navigate = useNavigate()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    api.getCoachCheckIns()
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }, [])

  const startAdhoc = async () => {
    setStarting(true)
    try {
      const row = await api.startCoachCheckIn({
        checkin_type: 'adhoc',
        title: 'Ad-hoc coaching check-in',
      })
      navigate(`/coach-checkins/${row.id}`)
    } catch (error) {
      alert(`Could not start check-in: ${error.message}`)
      setStarting(false)
    }
  }

  return (
    <div className="p-4 space-y-5 pb-8">
      <header className="pt-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-teal-400">Coach reflection</p>
        <h1 className="text-xl font-bold tracking-tight mt-1">Coaching check-ins</h1>
        <p className="text-sm text-pool-400 mt-1 leading-relaxed">
          A private thinking space for what is working, what is worrying you, and how your coaching is evolving.
        </p>
      </header>

      <button
        onClick={startAdhoc}
        disabled={starting}
        className="w-full text-left rounded-2xl border border-teal-600/60 bg-teal-900/40 p-4 active:bg-teal-900/60 disabled:opacity-60 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="w-11 h-11 rounded-xl bg-teal-800/60 text-teal-300 grid place-items-center shrink-0">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6V6a6 6 0 0 0-12 0v6.75a6 6 0 0 0 6 6Zm0 0v3m-3 0h6" />
            </svg>
          </span>
          <div className="flex-1">
            <p className="font-semibold text-teal-100">{starting ? 'Starting…' : 'Start an ad-hoc check-in'}</p>
            <p className="text-xs text-teal-300/75 mt-0.5">Talk it through now—no planning milestone needed.</p>
          </div>
          <span className="text-teal-400 text-xl">›</span>
        </div>
      </button>

      <div className="flex items-start justify-between gap-4 rounded-xl bg-pool-800/60 border border-pool-700/60 p-3.5">
        <div>
          <p className="text-sm font-medium text-pool-200">Automatic prompts</p>
          <p className="text-xs text-pool-500 mt-0.5">Milestone check-ins appear on Today. You can switch to monthly reminders or turn them off.</p>
        </div>
        <Link to="/settings#coach-checkins" className="text-xs font-medium text-accent-400 shrink-0 pt-0.5">Settings</Link>
      </div>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-pool-500 mb-2 pl-1">Previous check-ins</h2>
        {loading ? (
          <div className="rounded-xl bg-pool-800 p-4 text-sm text-pool-400">Loading…</div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-pool-700 p-5 text-center">
            <p className="text-sm text-pool-300">No check-ins yet</p>
            <p className="text-xs text-pool-500 mt-1">Your completed reflections and summaries will live here.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map(item => (
              <Link
                key={item.id}
                to={`/coach-checkins/${item.id}`}
                className="block rounded-xl bg-pool-800 border border-pool-700/70 p-3.5 active:bg-pool-700 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-pool-100 truncate">{item.title}</p>
                    <p className="text-xs text-pool-500 mt-1">
                      {KIND_LABELS[item.checkin_type] || item.checkin_type} · {dateLabel(item.completed_at || item.created_at)}
                    </p>
                  </div>
                  <span className={`text-[10px] uppercase tracking-wide rounded-full px-2 py-1 shrink-0 ${
                    item.status === 'completed' ? 'bg-teal-900/60 text-teal-300' :
                      item.status === 'skipped' ? 'bg-pool-700 text-pool-500' : 'bg-amber-900/40 text-amber-300'
                  }`}>
                    {item.status === 'in_progress' ? 'Continue' : item.status}
                  </span>
                </div>
                {item.summary && <p className="text-xs text-pool-400 mt-2 line-clamp-2 leading-relaxed">{item.summary}</p>}
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
