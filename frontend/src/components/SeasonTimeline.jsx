import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import {
  bandRuns, loadSegments, smoothPath, pointFor, buildSeries,
  weekLabel, phaseBar, currentWeekIndex,
} from '../seasonTimeline'

const COL = 44          // column width on the wide layout
const PLOT_H = 170
const PLOT_PAD = 10
const GRID = [100, 75, 50, 25, 0]

function phaseTint(type) {
  return { fill: phaseBar(type), opacity: 0.1 }
}

function LoadEditor({ week, macroId, onSaved, onClose }) {
  const [value, setValue] = useState(week.load?.overall ?? 50)
  const [note, setNote] = useState(week.load?.note || '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setValue(week.load?.overall ?? 50)
    setNote(week.load?.note || '')
  }, [week.week_start, week.load?.overall, week.load?.note])

  const save = async () => {
    if (!macroId) return
    setSaving(true)
    try {
      await api.putSeasonLoadWeek({
        macro_id: macroId,
        weeks: [{ week_start: week.week_start, overall: Number(value), note: note || null }],
      })
      onSaved()
    } catch (e) {
      alert('Could not save this week: ' + e.message)
    }
    setSaving(false)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setValue(v => Math.max(0, Number(v) - 5))}
          className="w-10 h-10 rounded-xl bg-pool-700 text-lg font-semibold shrink-0"
          aria-label="Decrease load"
        >−</button>
        <div className="flex-1">
          <input
            type="range" min="0" max="100" step="5"
            value={value}
            onChange={e => setValue(e.target.value)}
            className="w-full accent-accent-500"
          />
        </div>
        <button
          onClick={() => setValue(v => Math.min(100, Number(v) + 5))}
          className="w-10 h-10 rounded-xl bg-pool-700 text-lg font-semibold shrink-0"
          aria-label="Increase load"
        >+</button>
        <span className="w-12 text-right text-xl font-bold tabular-nums text-pool-100">{value}</span>
      </div>

      <input
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="Week note — e.g. rest week, not taper"
        className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2 text-sm text-pool-100 placeholder-pool-500 focus:border-accent-500 focus:outline-none"
      />

      {week.load?.ai_value !== null && week.load?.ai_value !== undefined && (
        <p className="text-xs text-pool-500">
          Assistant proposed {week.load.ai_value}. Changing it here is flagged for it to pick up.
        </p>
      )}

      <div className="flex gap-2">
        <button onClick={onClose} className="px-4 py-2.5 text-sm bg-pool-700 rounded-xl">Close</button>
        <button
          onClick={save}
          disabled={saving || !macroId}
          className="flex-1 py-2.5 text-sm font-semibold bg-accent-600 rounded-xl disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save week'}
        </button>
      </div>
    </div>
  )
}

function WeekDetail({ week, macroId, onSaved, onClose }) {
  const [editing, setEditing] = useState(false)

  useEffect(() => { setEditing(false) }, [week.week_start])

  return (
    <div className="bg-pool-800 border border-pool-600 rounded-2xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-pool-100">
            {weekLabel(week.week_start)} – {weekLabel(week.week_end)}
          </p>
          <p className="text-xs text-pool-400 mt-0.5">
            {week.cycle_code && <span className="text-teal-300 font-semibold mr-2">{week.cycle_code}</span>}
            {week.block_name || 'No phase'}
            {week.phase_type && <span className="capitalize text-pool-500 ml-2">{week.phase_type}</span>}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-2xl font-bold tabular-nums text-pool-100">
            {week.load?.overall ?? '—'}
          </p>
          <p className="text-[10px] uppercase tracking-wide text-pool-500">
            {week.load?.source === 'ai' ? 'Proposed' : week.load ? 'Agreed' : 'Not set'}
          </p>
        </div>
      </div>

      {week.load?.coach_overrode && (
        <p className="text-xs text-yellow-400">
          You moved this from the assistant&rsquo;s {week.load.ai_value}.
        </p>
      )}

      {(week.sessions?.planned || week.sessions?.cancelled) ? (
        <p className="text-xs text-pool-400">
          {week.sessions.planned} session{week.sessions.planned === 1 ? '' : 's'} on the plan
          {week.sessions.cancelled > 0 && (
            <span className="text-red-400"> · {week.sessions.cancelled} cancelled</span>
          )}
        </p>
      ) : null}

      {week.meets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {week.meets.map(m => (
            <span key={m.id} className="text-[11px] bg-red-900/40 text-red-200 border border-red-700/50 rounded-full px-2.5 py-0.5">
              {m.name}
            </span>
          ))}
        </div>
      )}

      {week.load?.note && !editing && (
        <p className="text-xs text-pool-300 leading-relaxed bg-pool-900/50 rounded-lg px-3 py-2">
          {week.load.note}
        </p>
      )}

      {editing ? (
        <LoadEditor week={week} macroId={macroId} onSaved={onSaved} onClose={() => setEditing(false)} />
      ) : (
        <div className="flex gap-2">
          <button onClick={onClose} className="px-4 py-2 text-xs bg-pool-700 rounded-xl">Close</button>
          <button
            onClick={() => setEditing(true)}
            disabled={!macroId}
            className="flex-1 py-2 text-xs font-semibold bg-pool-700 rounded-xl disabled:opacity-40"
          >
            {week.load ? 'Adjust this week' : 'Set this week'}
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Wide layout — weeks as columns, faithful to the planning spreadsheet
// ---------------------------------------------------------------------------

function ColumnView({ timeline, series, selected, onSelect }) {
  const weeks = timeline.weeks
  const width = weeks.length * COL
  const scrollRef = useRef(null)
  const todayIndex = currentWeekIndex(weeks)

  const macroBands = useMemo(() => bandRuns(weeks, w => w.macro_id), [weeks])
  const mesoBands = useMemo(() => bandRuns(weeks, w => w.block_id), [weeks])

  useEffect(() => {
    if (todayIndex < 0 || !scrollRef.current) return
    scrollRef.current.scrollLeft = Math.max(0, todayIndex * COL - 240)
  }, [todayIndex])

  return (
    <div ref={scrollRef} className="overflow-x-auto overflow-y-hidden">
      <div style={{ width }} className="min-w-full">

        {/* Week begins */}
        <div className="flex border-b border-pool-700">
          {weeks.map((w, i) => (
            <button
              key={w.week_start}
              onClick={() => onSelect(i)}
              style={{ width: COL }}
              className={`shrink-0 py-1 text-[9px] tabular-nums border-r border-pool-800 ${
                w.is_current ? 'text-accent-300 font-semibold' : 'text-pool-500'
              } ${selected === i ? 'bg-pool-700' : ''}`}
            >
              {weekLabel(w.week_start)}
            </button>
          ))}
        </div>

        {/* Macro / meso / micro bands */}
        <BandRow bands={macroBands} label="Macro" colourFor={() => '#1e88e5'}
          textFor={b => (b.weeks[0].macro_seq ? `${b.weeks[0].macro_seq} · ${b.weeks[0].macro_name}` : '')} />
        <BandRow bands={mesoBands} label="Meso" colourFor={b => phaseBar(b.weeks[0].phase_type)}
          textFor={b => (b.weeks[0].block_seq ? `${b.weeks[0].block_seq} · ${b.weeks[0].block_name}` : '')} />

        <div className="flex border-b border-pool-700">
          {weeks.map(w => (
            <div key={w.week_start} style={{ width: COL }}
              className="shrink-0 text-center py-0.5 text-[10px] tabular-nums text-pool-400 border-r border-pool-800">
              {w.micro_index || ''}
            </div>
          ))}
        </div>

        {weeks.some(w => w.sessions?.cancelled) && (
          <div className="flex border-b border-pool-700">
            {weeks.map(w => (
              <div key={w.week_start} style={{ width: COL }}
                className="shrink-0 text-center py-0.5 text-[10px] tabular-nums border-r border-pool-800"
                title={w.sessions?.cancelled ? `${w.sessions.cancelled} cancelled` : ''}>
                {w.sessions?.cancelled
                  ? <span className="text-red-400">✕{w.sessions.cancelled}</span>
                  : <span className="text-pool-700">·</span>}
              </div>
            ))}
          </div>
        )}

        {/* Meets, rotated so a full name fits a narrow column */}
        <div className="flex border-b border-pool-700" style={{ height: 96 }}>
          {weeks.map(w => (
            <div key={w.week_start} style={{ width: COL }}
              className={`shrink-0 border-r border-pool-800 flex items-end justify-center ${
                w.meets.length ? 'bg-red-950/40' : ''
              }`}>
              {w.meets.length > 0 && (
                <span
                  className="text-[10px] text-red-200 whitespace-nowrap overflow-hidden pb-1"
                  style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', maxHeight: 92 }}
                  title={w.meets.map(m => m.name).join(', ')}
                >
                  {w.meets.map(m => m.name).join(' / ')}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* The curve */}
        <svg width={width} height={PLOT_H} className="block" role="img"
          aria-label="Planned weekly load across the season">
          {mesoBands.filter(b => b.key).map(b => {
            const tint = phaseTint(b.weeks[0].phase_type)
            return (
              <rect key={`tint-${b.start}`} x={b.start * COL} y={0}
                width={b.span * COL} height={PLOT_H}
                fill={tint.fill} opacity={tint.opacity} />
            )
          })}

          {GRID.map(value => {
            const { y } = pointFor({ index: 0, value }, { columnWidth: COL, height: PLOT_H, padding: PLOT_PAD })
            return (
              <g key={value}>
                <line x1={0} x2={width} y1={y} y2={y}
                  stroke="#2c2c2c" strokeWidth={1}
                  strokeDasharray={value === 0 || value === 100 ? undefined : '3 4'} />
                <text x={2} y={y - 2} fontSize={8} fill="#7f858c">{value}</text>
              </g>
            )
          })}

          {mesoBands.filter((b, i) => i > 0).map(b => (
            <line key={`div-${b.start}`} x1={b.start * COL} x2={b.start * COL}
              y1={0} y2={PLOT_H} stroke="#444444" strokeWidth={1} />
          ))}

          {todayIndex >= 0 && (
            <line x1={todayIndex * COL + COL / 2} x2={todayIndex * COL + COL / 2}
              y1={0} y2={PLOT_H} stroke="#64b5f6" strokeWidth={1.5} strokeDasharray="4 3" />
          )}

          {series.map(s => {
            const segments = loadSegments(weeks, s.valueFn)
            const geom = { columnWidth: COL, height: PLOT_H, padding: PLOT_PAD }
            return (
              <g key={s.id}>
                {segments.map((segment, si) => (
                  <path key={si} d={smoothPath(segment.map(p => pointFor(p, geom)))}
                    fill="none" stroke={s.colour} strokeWidth={2}
                    strokeLinecap="round" strokeLinejoin="round" />
                ))}
                {segments.flat().map(p => {
                  const { x, y } = pointFor(p, geom)
                  const overrode = s.id === 'overall' && p.week.load?.coach_overrode
                  return (
                    <circle key={`${s.id}-${p.index}`} cx={x} cy={y} r={selected === p.index ? 5 : 4}
                      fill={s.colour} stroke={overrode ? '#eab308' : '#121212'} strokeWidth={2} />
                  )
                })}
              </g>
            )
          })}

          {weeks.map((w, i) => (
            <rect key={`hit-${w.week_start}`} x={i * COL} y={0} width={COL} height={PLOT_H}
              fill={selected === i ? '#ffffff' : 'transparent'} opacity={selected === i ? 0.06 : 0}
              className="cursor-pointer" onClick={() => onSelect(i)} />
          ))}
        </svg>

        {/* The numbers row — the artefact the coach actually works in */}
        <div className="flex border-t border-pool-700">
          {weeks.map((w, i) => (
            <button
              key={w.week_start}
              onClick={() => onSelect(i)}
              style={{ width: COL }}
              className={`shrink-0 py-1 text-[11px] tabular-nums border-r border-pool-800 ${
                w.load?.coach_overrode ? 'text-yellow-400 font-semibold'
                  : w.load?.source === 'ai' ? 'text-pool-400 italic'
                  : 'text-pool-200'
              } ${selected === i ? 'bg-pool-700' : ''}`}
            >
              {w.load?.overall ?? '·'}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function BandRow({ bands, label, colourFor, textFor }) {
  return (
    <div className="flex border-b border-pool-700" title={label}>
      {bands.map(band => {
        const text = textFor(band)
        return (
          <div
            key={`${label}-${band.start}`}
            style={{ width: band.span * COL, backgroundColor: band.key ? `${colourFor(band)}33` : undefined }}
            className="shrink-0 px-1 py-1 text-[10px] font-semibold text-pool-200 truncate border-r border-pool-800"
          >
            {text}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Narrow layout — weeks as rows, grouped by meso
// ---------------------------------------------------------------------------

function RowView({ timeline, series, selected, onSelect }) {
  const weeks = timeline.weeks
  const mesoBands = useMemo(() => bandRuns(weeks, w => w.block_id), [weeks])
  const primary = series[0]

  return (
    <div className="space-y-3">
      {mesoBands.map(band => (
        <div key={`row-band-${band.start}`}>
          <div
            className="flex items-center gap-2 px-2 py-1.5 rounded-lg mb-1"
            style={{ backgroundColor: band.key ? `${phaseBar(band.weeks[0].phase_type)}26` : '#1e1e1e' }}
          >
            <span className="text-xs font-semibold text-pool-200 truncate">
              {band.key
                ? `${band.weeks[0].macro_seq}.${band.weeks[0].block_seq} · ${band.weeks[0].block_name}`
                : 'Unassigned weeks'}
            </span>
            {band.weeks[0].phase_type && (
              <span className="text-[10px] capitalize text-pool-400 shrink-0">{band.weeks[0].phase_type}</span>
            )}
            <span className="text-[10px] text-pool-500 ml-auto shrink-0">{band.span}w</span>
          </div>

          <div className="space-y-0.5">
            {band.weeks.map(week => {
              const index = weeks.indexOf(week)
              const value = primary ? primary.valueFn(week) : null
              return (
                <button
                  key={week.week_start}
                  onClick={() => onSelect(index)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left ${
                    selected === index ? 'bg-pool-700' : week.is_current ? 'bg-accent-900/30' : ''
                  }`}
                >
                  <span className={`text-[11px] tabular-nums w-14 shrink-0 ${
                    week.is_current ? 'text-accent-300 font-semibold' : 'text-pool-400'
                  }`}>
                    {weekLabel(week.week_start)}
                  </span>
                  <span className="text-[10px] text-pool-500 w-4 shrink-0 tabular-nums">
                    {week.micro_index || ''}
                  </span>

                  <span className="flex-1 h-4 bg-pool-800 rounded-sm overflow-hidden relative min-w-0">
                    {value !== null && value !== undefined && (
                      <span
                        className="absolute inset-y-0 left-0 rounded-sm"
                        style={{
                          width: `${Math.max(2, value)}%`,
                          backgroundColor: primary.colour,
                          opacity: week.load?.source === 'ai' ? 0.55 : 1,
                        }}
                      />
                    )}
                  </span>

                  <span className={`text-[11px] tabular-nums w-7 text-right shrink-0 ${
                    week.load?.coach_overrode ? 'text-yellow-400 font-semibold' : 'text-pool-300'
                  }`}>
                    {value ?? '·'}
                  </span>
                </button>
              )
            })}
          </div>

          {band.weeks.some(w => w.meets.length || w.load?.note || w.sessions?.cancelled) && (
            <div className="mt-1 space-y-1 px-2">
              {band.weeks.filter(w => w.meets.length).map(w => (
                <p key={`m-${w.week_start}`} className="text-[10px] text-red-200">
                  {weekLabel(w.week_start)} · {w.meets.map(m => m.name).join(', ')}
                </p>
              ))}
              {band.weeks.filter(w => w.sessions?.cancelled).map(w => (
                <p key={`c-${w.week_start}`} className="text-[10px] text-red-400">
                  {weekLabel(w.week_start)} · {w.sessions.cancelled} session{w.sessions.cancelled > 1 ? 's' : ''} cancelled
                </p>
              ))}
              {band.weeks.filter(w => w.load?.note).map(w => (
                <p key={`n-${w.week_start}`} className="text-[10px] text-pool-400 italic">
                  {weekLabel(w.week_start)} · {w.load.note}
                </p>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function SeasonTimeline({ macros = [] }) {
  const [timeline, setTimeline] = useState(null)
  const [loading, setLoading] = useState(true)
  const [macroId, setMacroId] = useState(null)
  const [selected, setSelected] = useState(null)

  const load = useMemo(() => async (id) => {
    setLoading(true)
    try {
      const data = await api.getSeasonTimeline(id ? { macro_id: id } : {})
      setTimeline(data)
    } catch {
      setTimeline(null)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    const current = macros.find(m => m.is_current) || macros[0]
    const id = current ? current.id : null
    setMacroId(id)
    load(id)
  }, [macros, load])

  const series = useMemo(() => (timeline ? buildSeries(timeline) : []), [timeline])

  if (loading) {
    return <div className="bg-pool-800 rounded-2xl p-6 text-center text-sm text-pool-500">Loading timeline…</div>
  }
  if (!timeline || !timeline.weeks.length) return null

  const selectedWeek = selected !== null ? timeline.weeks[selected] : null

  return (
    <section className="bg-pool-800 rounded-2xl p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-pool-200">Season timeline</h2>
          <p className="text-[11px] text-pool-500 truncate">
            {weekLabel(timeline.date_from)} – {weekLabel(timeline.date_to)} · {timeline.weeks.length} weeks
          </p>
        </div>
        {macros.length > 1 && (
          <select
            value={macroId || ''}
            onChange={e => { const id = Number(e.target.value) || null; setMacroId(id); setSelected(null); load(id) }}
            className="bg-pool-700 border border-pool-600 rounded-lg px-2 py-1 text-xs text-pool-200 focus:outline-none max-w-[45%]"
          >
            <option value="">All macros</option>
            {macros.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
      </div>

      {/* Identity is never colour alone: a legend whenever more than one line runs */}
      {series.length > 1 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {series.map(s => (
            <span key={s.id} className="flex items-center gap-1.5 text-[11px] text-pool-400">
              <span className="w-3 h-0.5 rounded-full" style={{ backgroundColor: s.colour }} />
              {s.name}
            </span>
          ))}
        </div>
      )}

      <div className="hidden md:block">
        <ColumnView timeline={timeline} series={series} selected={selected} onSelect={setSelected} />
      </div>
      <div className="md:hidden">
        <RowView timeline={timeline} series={series} selected={selected} onSelect={setSelected} />
      </div>

      {selectedWeek && (
        <WeekDetail
          week={selectedWeek}
          macroId={selectedWeek.macro_id || macroId}
          onSaved={() => load(macroId)}
          onClose={() => setSelected(null)}
        />
      )}

      {!timeline.weeks.some(w => w.load) && (
        <p className="text-[11px] text-pool-500 leading-relaxed">
          No weekly load agreed yet. Talk it through in the AI chat, or tap a week to set a figure by hand.
        </p>
      )}
    </section>
  )
}
