import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'

const SECTIONS = [
  {
    heading: 'Session Setup',
    items: [
      {
        to: '/schedule',
        label: 'Pool Schedule',
        description: 'Set your regular pool slots — days, times, course, lanes. These drive the calendar and session planner.',
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
          </svg>
        ),
      },
      {
        to: '/context',
        label: 'Coaching Context',
        description: 'Keep the durable parts of how you coach—your philosophy, communication and preferred language.',
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
          </svg>
        ),
      },
      {
        to: '/settings/session-presentation',
        label: 'Session Print & Terminology',
        description: 'Add your club logo, choose your intensity language, and map it to LaneWatch training zones.',
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096.38 4.171m.34-4.075V10.5A2.25 2.25 0 0 0 15.75 8.25h-7.5A2.25 2.25 0 0 0 6 10.5v3.425m12 0h.75A2.25 2.25 0 0 0 21 11.675v-1.5A2.25 2.25 0 0 0 18.75 7.925H18m-12 6H5.25A2.25 2.25 0 0 1 3 11.675v-1.5a2.25 2.25 0 0 1 2.25-2.25H6m9-1.5V3.75A.75.75 0 0 0 14.25 3h-4.5a.75.75 0 0 0-.75.75v2.675" />
          </svg>
        ),
      },
    ],
  },
  {
    heading: 'Data',
    items: [
      {
        to: '/import',
        label: 'Import Data',
        description: 'Import swimrankings CSVs, session Excel files, or a squad roster.',
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
        ),
      },
    ],
  },
  {
    heading: 'AI',
    items: [
      {
        to: '/ai-operations',
        label: 'AI Operations',
        description: 'Track background AI work, see failures clearly, and retry work that needs attention.',
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12a8.25 8.25 0 1 0 8.25-8.25M3.75 12H1.5m2.25 0 2.5-2.5M3.75 12l2.5 2.5M12 7.5V12l3 1.5" />
          </svg>
        ),
      },
      {
        to: '/ai',
        label: 'LaneWatch AI',
        description: 'Open the persistent AI chat — ask anything about training science, your squad, or articles you\'ve read.',
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
          </svg>
        ),
      },
      {
        to: '/plan',
        label: 'Session Planner',
        description: 'Type a session in free text — get AI analysis, per-swimmer adaptations, and a printable session sheet.',
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
          </svg>
        ),
      },
    ],
  },
]

export default function Settings() {
  const [usage, setUsage] = useState(null)
  const [usageError, setUsageError] = useState('')
  const [checkInMode, setCheckInMode] = useState(null)
  const [checkInError, setCheckInError] = useState('')
  const [savingCheckInMode, setSavingCheckInMode] = useState(false)

  useEffect(() => {
    api.getAIUsage(30).then(setUsage).catch(error => setUsageError(error.message))
    api.getCoachCheckInSettings()
      .then(result => setCheckInMode(result.mode))
      .catch(error => setCheckInError(error.message))
  }, [])

  const changeCheckInMode = async (mode) => {
    if (mode === checkInMode || savingCheckInMode) return
    if (mode === 'monthly_reminder' && checkInMode === 'scheduled' && !window.confirm(
      'Turn off planning-milestone check-ins? LaneWatch will instead remind you once a month to start an ad-hoc reflection.'
    )) return
    if (mode === 'off' && !window.confirm(
      'Turn off all automatic check-in prompts? Ad-hoc check-ins will stay available in Planning, but LaneWatch will not remind you.'
    )) return

    setSavingCheckInMode(true)
    setCheckInError('')
    try {
      const result = await api.updateCoachCheckInSettings(mode)
      setCheckInMode(result.mode)
    } catch (error) {
      setCheckInError(error.message)
    }
    setSavingCheckInMode(false)
  }

  const money = (value) => {
    if (value == null) return '—'
    if (value === 0) return '$0.00'
    return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
  }

  return (
    <div className="p-4 space-y-6 pb-8">
      <header className="pt-2">
        <h1 className="text-xl font-bold tracking-tight">Settings</h1>
        <p className="text-pool-400 text-sm mt-0.5">Configure LaneWatch AI</p>
      </header>

      <section id="coach-checkins" className="space-y-2 scroll-mt-16">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-pool-500 pl-1">
          Coaching check-ins
        </h2>
        <div className="bg-pool-800 border border-pool-700 rounded-xl p-4">
          <p className="text-sm font-semibold text-pool-100">Automatic reflection prompts</p>
          <p className="text-xs text-pool-400 mt-1 leading-relaxed">
            Ad-hoc check-ins always remain available from Planning. This setting only controls what LaneWatch puts on Today.
          </p>

          <div className="mt-4 space-y-2">
            {[
              {
                value: 'scheduled',
                label: 'Planning milestones',
                description: 'Prompt at season boundaries, mid- and end-meso, post-meet and macro end.',
                badge: 'Recommended',
              },
              {
                value: 'monthly_reminder',
                label: 'Monthly reminder only',
                description: 'No milestone prompts; a gentle monthly reminder to begin an ad-hoc check-in.',
              },
              {
                value: 'off',
                label: 'No reminders',
                description: 'Nothing appears automatically. You can still start an ad-hoc check-in yourself.',
              },
            ].map(option => (
              <button
                type="button"
                key={option.value}
                onClick={() => changeCheckInMode(option.value)}
                disabled={checkInMode == null || savingCheckInMode}
                className={`w-full text-left rounded-xl border p-3 transition-colors disabled:opacity-60 ${
                  checkInMode === option.value
                    ? 'border-teal-600 bg-teal-900/30'
                    : 'border-pool-700 bg-pool-900/30 hover:border-pool-600'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-4 h-4 rounded-full border grid place-items-center ${checkInMode === option.value ? 'border-teal-400' : 'border-pool-500'}`}>
                    {checkInMode === option.value && <span className="w-2 h-2 rounded-full bg-teal-400" />}
                  </span>
                  <span className="text-sm font-medium text-pool-100">{option.label}</span>
                  {option.badge && <span className="text-[9px] uppercase tracking-wide text-teal-300 bg-teal-900/60 rounded-full px-2 py-0.5">{option.badge}</span>}
                </div>
                <p className="text-xs text-pool-500 mt-1 ml-6 leading-relaxed">{option.description}</p>
              </button>
            ))}
          </div>
          {savingCheckInMode && <p className="text-xs text-pool-500 mt-3">Saving…</p>}
          {checkInError && <p className="text-xs text-red-300 mt-3">Could not update check-ins: {checkInError}</p>}
        </div>
      </section>

      {SECTIONS.map(({ heading, items }) => (
        <section key={heading} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-pool-500 pl-1">
            {heading}
          </h2>
          <div className="space-y-2">
            {items.map(({ to, label, description, icon }) => (
              <Link
                key={to}
                to={to}
                className="flex items-start gap-4 bg-pool-800 border border-pool-700 hover:border-accent-600/50 rounded-xl p-4 transition-colors"
              >
                <div className="text-accent-400 mt-0.5 shrink-0">{icon}</div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm text-pool-100">{label}</p>
                  <p className="text-xs text-pool-400 mt-0.5 leading-relaxed">{description}</p>
                </div>
                <span className="text-pool-500 text-lg self-center ml-2">›</span>
              </Link>
            ))}
          </div>
        </section>
      ))}

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-pool-500 pl-1">
          AI cost control
        </h2>
        <div className="bg-pool-800 border border-pool-700 rounded-xl p-4 space-y-3">
          {usageError ? (
            <p className="text-xs text-red-300">Could not load usage: {usageError}</p>
          ) : !usage ? (
            <p className="text-xs text-pool-400">Loading the last 30 days…</p>
          ) : (
            <>
              {/* Month to date answers "what is this costing me"; the 30-day
                  total only answered "what has it cost". The projection is a
                  straight run-rate, not a forecast — it makes a jump obvious. */}
              <div>
                <p className="text-xs text-pool-400">This month so far</p>
                <p className="text-2xl font-bold text-pool-100">
                  {money(usage.month_to_date?.estimated_cost_usd)}
                </p>
                <p className="text-[11px] text-pool-500 mt-0.5">
                  {usage.month_to_date?.calls ?? 0} calls since {usage.month_to_date?.since}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-3 border-t border-pool-700 pt-3">
                <div>
                  <p className="text-[11px] text-pool-400">Per day</p>
                  <p className="text-sm font-semibold text-pool-100">{money(usage.daily_average_usd)}</p>
                </div>
                <div>
                  <p className="text-[11px] text-pool-400">Month at this rate</p>
                  <p className="text-sm font-semibold text-pool-100">{money(usage.projected_month_usd)}</p>
                </div>
                <div>
                  <p className="text-[11px] text-pool-400">Last 30 days</p>
                  <p className="text-sm font-semibold text-pool-100">{money(usage.totals.estimated_cost_usd)}</p>
                </div>
              </div>
              {(usage.daily || []).length > 1 && (() => {
                const recent = usage.daily.slice(-14)
                const peak = Math.max(...recent.map(d => d.estimated_cost_usd), 0.0001)
                return (
                  <div className="border-t border-pool-700 pt-3">
                    <p className="text-[11px] text-pool-400 mb-1.5">Daily spend · last 14 days</p>
                    <div className="flex items-end gap-[3px] h-10" role="img"
                         aria-label={`Daily AI spend for the last ${recent.length} days, highest ${money(peak)}`}>
                      {recent.map(day => (
                        <div
                          key={day.date}
                          title={`${day.date} · ${money(day.estimated_cost_usd)} · ${day.calls} calls`}
                          className="flex-1 bg-accent-600/70 rounded-sm min-h-[2px]"
                          style={{ height: `${Math.max(4, (day.estimated_cost_usd / peak) * 100)}%` }}
                        />
                      ))}
                    </div>
                    <div className="flex justify-between text-[10px] text-pool-500 mt-1">
                      <span>{recent[0]?.date?.slice(5)}</span>
                      <span>peak {money(peak)}</span>
                    </div>
                  </div>
                )
              })()}
              <div className="text-xs text-pool-400 leading-relaxed border-t border-pool-700 pt-3">
                <p>Season/session planning: <span className="text-pool-200">{usage.configuration.primary_model}</span> · {usage.configuration.planning_effort} effort</p>
                <p>General assistant: <span className="text-pool-200">cost-aware {usage.configuration.fast_model} / {usage.configuration.primary_model} routing</span></p>
                <p>Extraction/routing: <span className="text-pool-200">{usage.configuration.fast_model}</span></p>
                <p>Voice notes: <span className="text-pool-200">{usage.configuration.transcription_model}</span></p>
                <p>Conversation memory: <span className="text-pool-200">{usage.configuration.history_limits?.general || usage.configuration.history_messages}</span> general / <span className="text-pool-200">{usage.configuration.history_limits?.athlete_planning || usage.configuration.history_messages}</span> athlete / <span className="text-pool-200">{usage.configuration.history_limits?.season_planning || usage.configuration.history_messages}</span> season messages + rolling summary</p>
              </div>
              {usage.by_model.length > 0 && (
                <div className="space-y-1 border-t border-pool-700 pt-3">
                  {usage.by_model.map(item => (
                    <div key={`${item.provider}:${item.model}`} className="flex justify-between gap-3 text-xs">
                      <span className="text-pool-400 truncate">{item.model} · {item.calls} calls</span>
                      <span className="text-pool-200 shrink-0">{money(item.estimated_cost_usd)}</span>
                    </div>
                  ))}
                </div>
              )}
              {(usage.by_operation || []).length > 0 && (
                <div className="space-y-1 border-t border-pool-700 pt-3">
                  <p className="text-[11px] uppercase tracking-wider text-pool-500 mb-2">Cost by operation</p>
                  {usage.by_operation.slice(0, 10).map(item => (
                    <div key={item.operation} className="flex justify-between gap-3 text-xs">
                      <span className="text-pool-400 truncate">{item.operation.replaceAll('_', ' ')} · {item.calls} calls</span>
                      <span className="text-pool-200 shrink-0">{money(item.estimated_cost_usd)}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-pool-500">Estimates use recorded token counts. Provider invoices remain authoritative.</p>
            </>
          )}
        </div>
      </section>

      <section className="pt-2 border-t border-pool-700">
        <p className="text-xs text-pool-500 text-center">LANEWATCH AI · built for poolside use</p>
      </section>
    </div>
  )
}
