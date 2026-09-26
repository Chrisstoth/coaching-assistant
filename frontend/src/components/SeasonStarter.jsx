import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import {
  STEPS, defaultSeasonWindow, nextStep, outlineRequest, planningStage, seasonMeets, weeklySchedule,
} from '../planningStart'

// Where the coach is in planning: outline the year, plan each macrocycle,
// plan the weeks. Shown at the top of the plan so there is always a next step.
export function PlanningSteps({ stage }) {
  const current = STEPS.findIndex(s => s.key === stage)
  return (
    <ol className="grid grid-cols-3 gap-1.5">
      {STEPS.map((step, i) => {
        const done = i < current
        const here = i === current
        return (
          <li key={step.key} className={`rounded-xl px-2.5 py-2 border ${
            here ? 'border-accent-500 bg-accent-900/30' : done ? 'border-green-800/60 bg-green-950/20' : 'border-pool-700 bg-pool-800'
          }`}>
            <p className={`text-[10px] font-bold ${here ? 'text-accent-300' : done ? 'text-green-400' : 'text-pool-500'}`}>
              {done ? '✓ ' : ''}Step {i + 1}
            </p>
            <p className={`text-[11px] leading-snug ${here ? 'text-pool-100 font-semibold' : 'text-pool-400'}`}>{step.title}</p>
          </li>
        )
      })}
    </ol>
  )
}

// The next thing to do once the year has an outline.
export function NextStepCard({ macros, macro, onAsk, busy }) {
  const stage = planningStage(macros, macro)
  const step = nextStep(stage, macro)
  return (
    <section className="space-y-2">
      <PlanningSteps stage={stage} />
      {step && (
        <div className="bg-pool-800 border border-pool-700 rounded-2xl p-4 space-y-2">
          <p className="text-sm font-semibold text-pool-100">Next: {step.title}</p>
          <p className="text-xs text-pool-400 leading-relaxed">{step.detail}</p>
          <button onClick={() => onAsk(step.text)} disabled={busy}
            className="w-full py-2.5 text-sm font-semibold bg-accent-600 rounded-xl disabled:opacity-40">
            {step.label}
          </button>
        </div>
      )}
    </section>
  )
}

// Step one, from nothing: set the season's dates, tick the meets to build
// towards, and ask for an outline. Everything it needs is already in the app.
export default function SeasonStarter({ onAsk, busy }) {
  const [meets, setMeets] = useState(null)
  const [slots, setSlots] = useState([])
  const [swimmers, setSwimmers] = useState([])
  const [window_, setWindow] = useState(null)
  const [squad, setSquad] = useState('')
  const [ticked, setTicked] = useState({})

  useEffect(() => {
    Promise.all([
      api.getMeets().catch(() => []),
      api.getSlots().catch(() => []),
      api.getSwimmers().catch(() => []),
    ]).then(([meetRows, slotRows, swimmerRows]) => {
      const list = Array.isArray(meetRows) ? meetRows : []
      setMeets(list)
      setSlots(Array.isArray(slotRows) ? slotRows : [])
      setSwimmers(Array.isArray(swimmerRows) ? swimmerRows.filter(s => s.active !== false) : [])
      const win = defaultSeasonWindow(new Date(), list)
      setWindow(win)
      setTicked(Object.fromEntries(seasonMeets(list, win.from, win.to).map(m => [m.id, m.suggested])))
    })
  }, [])

  const squads = useMemo(() => [...new Set(swimmers.map(s => s.squad).filter(Boolean))].sort(), [swimmers])
  const inSeason = useMemo(() => (window_ ? seasonMeets(meets || [], window_.from, window_.to) : []), [meets, window_])
  const schedule = weeklySchedule(slots, squad || null)
  const squadSize = squad ? swimmers.filter(s => s.squad === squad).length : swimmers.length

  if (!meets || !window_) {
    return <div className="bg-pool-800 rounded-2xl p-4 text-xs text-pool-500">Getting your meets and timetable…</div>
  }

  const targets = inSeason.filter(m => ticked[m.id])
  const start = () => onAsk(outlineRequest({
    from: window_.from, to: window_.to, squad: squad || null, targets, schedule,
  }))

  return (
    <section className="space-y-3">
      <PlanningSteps stage="outline" />

      <div className="bg-pool-800 border border-pool-700 rounded-2xl p-4 space-y-4">
        <div>
          <p className="text-sm font-semibold text-pool-100">Start with the shape of the year</p>
          <p className="text-xs text-pool-400 mt-1 leading-relaxed">
            Set the season's dates and tick the meets that matter. The assistant splits the year into
            macrocycles around them. You check its outline before anything is saved.
          </p>
        </div>

        <div className="space-y-1.5">
          <p className="text-[11px] uppercase tracking-wide text-pool-500">1. When does the season run?</p>
          <div className="flex items-center gap-2">
            <input type="date" value={window_.from} onChange={e => setWindow(w => ({ ...w, from: e.target.value }))}
              className="flex-1 min-w-0 bg-pool-700 border border-pool-600 rounded-lg px-2 py-2 text-sm text-pool-100" />
            <span className="text-xs text-pool-500">to</span>
            <input type="date" value={window_.to} onChange={e => setWindow(w => ({ ...w, to: e.target.value }))}
              className="flex-1 min-w-0 bg-pool-700 border border-pool-600 rounded-lg px-2 py-2 text-sm text-pool-100" />
          </div>
        </div>

        {squads.length > 1 && (
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wide text-pool-500">Which squad?</p>
            <select value={squad} onChange={e => setSquad(e.target.value)}
              className="w-full bg-pool-700 border border-pool-600 rounded-lg px-2 py-2 text-sm text-pool-100">
              <option value="">Whole squad</option>
              {squads.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}

        <div className="space-y-1.5">
          <p className="text-[11px] uppercase tracking-wide text-pool-500">2. Which meets are you building towards?</p>
          {inSeason.length === 0 ? (
            <p className="text-xs text-pool-400 leading-relaxed">
              No meets in the calendar between these dates.{' '}
              <Link to="/meets" className="text-accent-400 underline">Add your meets</Link> first, or carry on and
              the assistant will ask about them.
            </p>
          ) : (
            <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
              {inSeason.map(meet => (
                <label key={meet.id} className={`flex items-start gap-2.5 rounded-xl px-3 py-2 border ${
                  ticked[meet.id] ? 'border-accent-600 bg-accent-900/20' : 'border-pool-700 bg-pool-900/30'
                }`}>
                  <input type="checkbox" className="mt-0.5" checked={Boolean(ticked[meet.id])}
                    onChange={e => setTicked(prev => ({ ...prev, [meet.id]: e.target.checked }))} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-pool-100 truncate">{meet.name}</span>
                    <span className="block text-[11px] text-pool-500">
                      {new Date(`${meet.date}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      {meet.level ? ` · ${meet.level}` : ''}{meet.course ? ` · ${meet.course}` : ''}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {inSeason.length > 0 && (
            <p className="text-[11px] text-pool-500">
              Championship-level meets are ticked for you. Unticked meets still count as stepping stones.
            </p>
          )}
        </div>

        <div className="rounded-xl bg-pool-900/40 px-3 py-2.5 space-y-1">
          <p className="text-[11px] uppercase tracking-wide text-pool-500">The assistant will also use</p>
          <p className="text-xs text-pool-300">
            {schedule.count
              ? <>Your timetable: {schedule.count} sessions a week <span className="text-pool-500">({schedule.label})</span></>
              : <>No weekly timetable yet. <Link to="/schedule" className="text-accent-400 underline">Set it up</Link></>}
          </p>
          <p className="text-xs text-pool-300">
            {squadSize ? `${squadSize} swimmers${squad ? ` in ${squad}` : ''}` : 'No swimmers added yet'}
          </p>
        </div>

        <button onClick={start} disabled={busy}
          className="w-full py-3 text-sm font-semibold bg-accent-600 rounded-xl disabled:opacity-40">
          {busy ? 'Working on it…' : targets.length
            ? `Build my season outline (${targets.length} target meet${targets.length === 1 ? '' : 's'})`
            : 'Build my season outline'}
        </button>
        <p className="text-[11px] text-pool-500 text-center">
          Rather explain it yourself? Use the Discuss tab and describe your season in your own words.
        </p>
      </div>
    </section>
  )
}
