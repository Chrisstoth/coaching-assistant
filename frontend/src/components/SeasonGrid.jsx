import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { bandRuns, phaseBar, weekLabel } from '../seasonTimeline'
import { MARK_TONES, attendanceShare, cellDetail, cellMarks, initialOpenGroups } from '../seasonGrid'

// The squad on one screen: weeks across, then the squad, its groups, and each
// group's swimmers. Open a group to see its swimmers; a swimmer's row only
// shows what is different for them. Tap a cell for the detail.

const NAME_COL = '7.5rem'
const WEEK_COL = '2.25rem'

function Row({ weeks, label, children, className = '' }) {
  return (
    <div className={`grid items-stretch ${className}`}
      style={{ gridTemplateColumns: `${NAME_COL} repeat(${weeks.length}, ${WEEK_COL})` }}>
      <div className="sticky left-0 z-10 bg-pool-900 pr-2 flex items-center min-w-0">{label}</div>
      {children}
    </div>
  )
}

export default function SeasonGrid({ macroId }) {
  const [grid, setGrid] = useState(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState({})
  const [picked, setPicked] = useState(null)   // { swimmer, index }

  useEffect(() => {
    if (!macroId) return
    setGrid(null)
    setPicked(null)
    api.getSeasonGrid(macroId)
      .then(data => { setGrid(data); setOpen(initialOpenGroups(data.groups)) })
      .catch(e => setError(e.message))
  }, [macroId])

  if (!macroId) return null
  if (error) return <p className="text-xs text-red-300">Could not load the squad grid: {error}</p>
  if (!grid) return <p className="text-xs text-pool-500">Loading the squad…</p>

  const weeks = grid.weeks
  const current = weeks.findIndex(w => w.is_current)
  const colFor = i => ({ gridColumn: `${i + 2}` })
  const shade = i => (i === current ? 'bg-accent-900/30' : '')
  const swimmerCount = grid.groups.reduce((n, g) => n + g.swimmers.length, 0)

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-pool-300 uppercase tracking-wide">Squad, groups and swimmers</h2>
        <span className="text-[11px] text-pool-500">{swimmerCount} swimmers</span>
      </div>

      <div className="overflow-x-auto -mx-4 px-4 pb-1">
        <div className="w-max space-y-px text-[11px]">
          <Row weeks={weeks} label={<span className="text-pool-500">Week of</span>}>
            {weeks.map((w, i) => (
              <div key={w.week_start} style={colFor(i)}
                className={`text-center py-1 ${i === current ? 'text-accent-300 font-semibold' : 'text-pool-500'}`}>
                {weekLabel(w.week_start).split(' ')[0]}
                <span className="block text-[9px]">{weekLabel(w.week_start).split(' ')[1]}</span>
              </div>
            ))}
          </Row>

          <Row weeks={weeks} label={<span className="text-pool-400">Blocks</span>}>
            {bandRuns(weeks, w => w.block_id, w => w.block_name).map(run => (
              <div key={`${run.key}-${run.start}`} title={run.label || 'No block'}
                style={{ gridColumn: `${run.start + 2} / span ${run.span}`,
                  backgroundColor: run.key ? `${phaseBar(run.weeks[0].phase)}55` : 'transparent' }}
                className="rounded-sm px-1 py-1 truncate text-pool-100">
                {run.key ? run.label : ''}
              </div>
            ))}
          </Row>

          <Row weeks={weeks} label={<span className="text-pool-400">Meets</span>}>
            {weeks.map((w, i) => (
              <div key={w.week_start} style={colFor(i)} title={w.meets.map(m => m.name).join(', ')}
                className={`text-center py-1 text-red-300 ${shade(i)}`}>
                {w.meets.length ? '◆' : ''}
              </div>
            ))}
          </Row>

          <Row weeks={weeks} className="border-b border-pool-700 pb-1"
            label={<span className="text-pool-200 font-semibold">Squad load</span>}>
            {weeks.map((w, i) => (
              <div key={w.week_start} style={colFor(i)} title={w.load != null ? `Planned load ${w.load}${w.load_note ? ` - ${w.load_note}` : ''}` : 'No load set'}
                className={`h-8 flex items-end justify-center ${shade(i)}`}>
                {w.load != null && (
                  <div className="w-4 rounded-t-sm bg-accent-500/70" style={{ height: `${Math.max(6, w.load)}%` }} />
                )}
              </div>
            ))}
          </Row>

          {grid.groups.map(group => (
            <div key={group.name} className="space-y-px pt-1">
              <Row weeks={weeks} label={(
                <button onClick={() => setOpen(prev => ({ ...prev, [group.name]: !prev[group.name] }))}
                  aria-expanded={Boolean(open[group.name])}
                  className="text-left text-pool-100 font-semibold truncate w-full py-1">
                  {open[group.name] ? '▾' : '▸'} {group.name} <span className="text-pool-500 font-normal">({group.swimmers.length})</span>
                </button>
              )}>
                {weeks.map((w, i) => {
                  const count = group.rollup[String(i)]
                  return (
                    <div key={w.week_start} style={colFor(i)} className={`flex items-center justify-center ${shade(i)}`}
                      title={count ? `${count} swimmer${count === 1 ? '' : 's'} with something to look at` : ''}>
                      {count ? (
                        <span className="min-w-[1.1rem] h-[1.1rem] rounded-full bg-amber-500/80 text-black text-[10px] font-bold flex items-center justify-center">
                          {count}
                        </span>
                      ) : null}
                    </div>
                  )
                })}
              </Row>

              {open[group.name] && group.intents.length > 0 && (
                <p className="sticky left-0 text-[11px] text-pool-400 pl-3 py-0.5 w-[20rem]">
                  Aim: {group.intents.map(t => t.text).join(' → ')}
                </p>
              )}

              {open[group.name] && group.swimmers.map(swimmer => (
                <Row key={swimmer.id} weeks={weeks} label={(
                  <span className="pl-3 truncate text-pool-300" title={swimmer.name}>
                    {swimmer.name}
                    {swimmer.para_class && <span className="text-pool-500"> {swimmer.para_class.split(/[\s/]/)[0]}</span>}
                    {swimmer.pathway && (
                      <span className="block text-[9px] text-teal-400 truncate">{swimmer.pathway.name}</span>
                    )}
                  </span>
                )}>
                  {weeks.map((w, i) => {
                    const cell = swimmer.cells[String(i)]
                    const marks = cellMarks(cell)
                    const share = attendanceShare(cell)
                    const isPicked = picked && picked.swimmer.id === swimmer.id && picked.index === i
                    return (
                      <button key={w.week_start} style={colFor(i)}
                        onClick={() => setPicked(isPicked ? null : { swimmer, index: i })}
                        aria-label={`${swimmer.name}, week of ${weekLabel(w.week_start)}: ${cellDetail(cell).join('; ') || 'on plan'}`}
                        className={`h-7 flex items-center justify-center gap-px rounded-sm ${shade(i)} ${isPicked ? 'ring-1 ring-accent-400' : ''}`}>
                        {share !== null && !marks.length && (
                          <span className="w-3 h-3 rounded-sm bg-teal-500" style={{ opacity: 0.2 + share * 0.7 }} />
                        )}
                        {marks.slice(0, 2).map((mark, k) => (
                          <span key={k} className={`leading-none ${MARK_TONES[mark.tone]}`}>{mark.symbol}</span>
                        ))}
                      </button>
                    )
                  })}
                </Row>
              ))}
            </div>
          ))}
        </div>
      </div>

      {picked && (
        <div className="bg-pool-800 border border-pool-700 rounded-xl p-3 space-y-1">
          <p className="text-sm font-semibold text-pool-100">
            {picked.swimmer.name} · week of {weekLabel(weeks[picked.index].week_start)}
          </p>
          {cellDetail(picked.swimmer.cells[String(picked.index)]).length ? (
            cellDetail(picked.swimmer.cells[String(picked.index)]).map((line, i) => (
              <p key={i} className="text-xs text-pool-300">{line}</p>
            ))
          ) : (
            <p className="text-xs text-pool-400">On the group plan this week.</p>
          )}
          <Link to={`/swimmers/${picked.swimmer.id}`} className="text-xs text-accent-400">
            Open {picked.swimmer.name.split(' ')[0]}'s page and plan ›
          </Link>
        </div>
      )}

      <p className="text-[10px] text-pool-500 leading-relaxed">
        <span className="text-green-400">●</span> entered · <span className="text-accent-300">◐</span> planned ·{' '}
        ○ on their pathway · <span className="text-amber-300">⚑</span> needs a look ·{' '}
        <span className="text-red-400">✚</span> ill or injured · ✕ away ·{' '}
        <span className="inline-block w-2 h-2 rounded-sm bg-teal-500 align-middle" /> trained (darker = more of the week).
        A blank week means on the group plan.
      </p>
    </section>
  )
}
