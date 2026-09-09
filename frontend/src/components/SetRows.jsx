import { useMemo } from 'react'
import { setRows } from '../sessionSets'
import { DEFAULT_PRESENTATION, presentationZones } from '../sessionPresentation'


// Easy through maximal, for shading a numeric effort that carries no zone name.
const EFFORT_RAMP = ['#16a34a', '#2563eb', '#d97706', '#dc2626']

function effortColour(effort) {
  if (effort.colour) return effort.colour
  if (!effort.scale || effort.value === null) return '#64748b'
  const ratio = Math.min(1, effort.value / effort.scale)
  return EFFORT_RAMP[Math.min(EFFORT_RAMP.length - 1, Math.floor(ratio * EFFORT_RAMP.length))]
}

function Effort({ effort }) {
  if (!effort) return <span />
  const colour = effortColour(effort)
  return (
    <span
      className="justify-self-end rounded px-1.5 text-[11px] font-bold whitespace-nowrap"
      style={{ color: colour, background: `${colour}22` }}
    >
      {effort.label}
    </span>
  )
}

function Interval({ interval }) {
  if (!interval) return <span />
  if (interval.kind === 'rest') {
    return (
      <span className="justify-self-end tabular-nums text-xs font-semibold text-pool-400 whitespace-nowrap">
        <span className="text-[10px] uppercase tracking-wide text-pool-500">rest </span>{interval.value}
      </span>
    )
  }
  return (
    <span className="justify-self-end tabular-nums text-sm font-bold text-pool-200 underline decoration-pool-500 underline-offset-2 whitespace-nowrap">
      @ {interval.value}
    </span>
  )
}

/**
 * A group's sets as the coach reads them: reps × distance on the left, what to
 * swim in the middle, and effort then the clock on the right. Effort sits in
 * its own column rather than inside the wording, so a row's load is legible on
 * its own — the same shape the printed sheet uses.
 */
export default function SetRows({ sets, settings = DEFAULT_PRESENTATION, className = '' }) {
  const rows = useMemo(() => setRows(sets, presentationZones(settings)), [sets, settings])
  if (!rows.length) return null

  return (
    <div className={`px-3 py-2 ${className}`}>
      <div className="grid grid-cols-[minmax(3.6rem,auto)_minmax(0,1fr)_auto_auto] gap-x-2 pb-1 border-b border-pool-600 text-[10px] uppercase tracking-wide text-pool-500">
        <span>Reps × dist</span><span>Set</span><span className="justify-self-end">Effort</span><span className="justify-self-end">Clock</span>
      </div>
      <ul>
        {rows.map((row, index) => {
          const nested = row.depth ? 'pl-2 border-l-2 border-pool-600' : ''
          if (row.kind === 'heading') {
            return (
              <li key={index} className={`pt-2 pb-1 text-[11px] font-bold uppercase tracking-wide text-pool-400 ${nested}`}>
                {row.description}
              </li>
            )
          }
          if (row.kind === 'repeat') {
            return (
              <li key={index} className={`py-1 text-xs text-pool-300 ${nested}`}>
                <b className="text-pool-200">{row.dose}</b> rounds of
              </li>
            )
          }
          return (
            <li
              key={index}
              className={`grid grid-cols-[minmax(3.6rem,auto)_minmax(0,1fr)_auto_auto] gap-x-2 items-baseline py-1 border-b border-pool-700/60 last:border-0 ${nested}`}
            >
              <b className="tabular-nums text-sm text-pool-100 whitespace-nowrap">{row.kind === 'set' ? row.dose : ''}</b>
              <span className="min-w-0 break-words text-sm text-pool-200">
                {row.label && <b className="text-pool-400">{row.label} </b>}
                {row.description}
              </span>
              <Effort effort={row.effort} />
              <Interval interval={row.interval} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
