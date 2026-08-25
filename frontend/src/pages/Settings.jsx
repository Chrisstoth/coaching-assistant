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
        description: 'Tell the AI about your coaching philosophy, squad goals, and current training block. Used in every AI call.',
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
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

  useEffect(() => {
    api.getAIUsage(30).then(setUsage).catch(error => setUsageError(error.message))
  }, [])

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
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-pool-400">Estimated API cost · 30 days</p>
                  <p className="text-xl font-bold text-pool-100">{money(usage.totals.estimated_cost_usd)}</p>
                </div>
                <div>
                  <p className="text-xs text-pool-400">Tracked calls</p>
                  <p className="text-xl font-bold text-pool-100">{usage.totals.calls}</p>
                </div>
              </div>
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
