import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'

const VOLUME_LABELS = {
  aerobic: 'Aer', threshold: 'Thr', vo2: 'VO2', race_pace: 'RP',
  lact_tol: 'LT', short_race_pace: 'SRP', kicking: 'Kck', sprint: 'Spr',
}
const VOLUME_COLOURS = {
  aerobic: 'bg-blue-500', threshold: 'bg-yellow-500', vo2: 'bg-orange-500',
  race_pace: 'bg-purple-500', lact_tol: 'bg-red-500', short_race_pace: 'bg-pink-500',
  kicking: 'bg-teal-500', sprint: 'bg-green-500',
}

const PHASE_COLOURS = {
  base:        { bg: 'bg-blue-900/40',   border: 'border-blue-700/60',   text: 'text-blue-300',   bar: 'bg-blue-500'   },
  build:       { bg: 'bg-green-900/40',  border: 'border-green-700/60',  text: 'text-green-300',  bar: 'bg-green-500'  },
  peak:        { bg: 'bg-orange-900/40', border: 'border-orange-700/60', text: 'text-orange-300', bar: 'bg-orange-500' },
  taper:       { bg: 'bg-yellow-900/40', border: 'border-yellow-700/60', text: 'text-yellow-300', bar: 'bg-yellow-500' },
  competition: { bg: 'bg-red-900/40',    border: 'border-red-700/60',    text: 'text-red-300',    bar: 'bg-red-500'    },
  recovery:    { bg: 'bg-teal-900/40',   border: 'border-teal-700/60',   text: 'text-teal-300',   bar: 'bg-teal-500'   },
  transition:  { bg: 'bg-pool-800',      border: 'border-pool-600',      text: 'text-pool-300',   bar: 'bg-pool-500'   },
}
const phaseC = (t) => PHASE_COLOURS[t] || PHASE_COLOURS.transition

const PHASE_TYPES = ['base','build','peak','taper','competition','recovery','transition']

function fmt(d) {
  if (!d) return ''
  const dt = new Date(d + 'T00:00:00')
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}


function BlockForm({ initial, onSave, onCancel }) {
  const today = new Date().toISOString().split('T')[0]
  const [form, setForm] = useState(initial || {
    name: '', squad: '', phase_type: 'build',
    date_from: today, date_to: today,
    group_intents: { G1: '', G2: '', G3: '' },
    notes: '',
  })
  const [saving, setSaving] = useState(false)
  const [showIntents, setShowIntents] = useState(!!(initial?.group_intents))
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const setIntent = (g, v) => setForm(p => ({ ...p, group_intents: { ...p.group_intents, [g]: v } }))

  return (
    <div className="bg-pool-800 border border-pool-600 rounded-2xl p-4 space-y-3">
      <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="Block name (e.g. Aerobic Base)"
        className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none" />
      <div className="grid grid-cols-2 gap-2">
        <select value={form.phase_type} onChange={e => set('phase_type', e.target.value)}
          className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none capitalize">
          {PHASE_TYPES.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
        </select>
        <input value={form.squad || ''} onChange={e => set('squad', e.target.value)} placeholder="Squad (e.g. Silver 1)"
          className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-pool-400 block mb-1">Start</label>
          <input type="date" value={form.date_from} onChange={e => set('date_from', e.target.value)}
            className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none" />
        </div>
        <div>
          <label className="text-xs text-pool-400 block mb-1">End</label>
          <input type="date" value={form.date_to} onChange={e => set('date_to', e.target.value)}
            className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none" />
        </div>
      </div>

      {/* Group intents */}
      <button onClick={() => setShowIntents(v => !v)} className="w-full flex items-center justify-between text-xs text-pool-400 py-1">
        <span>Group intents (optional)</span>
        <span>{showIntents ? '▲' : '▼'}</span>
      </button>
      {showIntents && (
        <div className="space-y-2">
          {['G1', 'G2', 'G3'].map(g => (
            <div key={g}>
              <label className="text-xs text-pool-500 block mb-1">{g}</label>
              <textarea value={form.group_intents?.[g] || ''} onChange={e => setIntent(g, e.target.value)}
                placeholder={`What's the intent for Group ${g.slice(1)} this block?`}
                rows={2} className="w-full bg-pool-700 rounded-lg px-3 py-2 text-xs border border-pool-600 focus:border-accent-500 focus:outline-none resize-none" />
            </div>
          ))}
        </div>
      )}

      <textarea value={form.notes || ''} onChange={e => set('notes', e.target.value)} placeholder="Notes (optional)"
        rows={2} className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none resize-none" />
      <div className="flex gap-2 pt-1">
        <button onClick={onCancel} className="flex-1 py-2.5 text-sm text-pool-400 bg-pool-700 rounded-xl">Cancel</button>
        <button
          disabled={saving || !form.name}
          onClick={async () => {
            setSaving(true)
            await onSave(form)
            setSaving(false)
          }}
          className="flex-1 py-2.5 text-sm font-semibold bg-accent-600 rounded-xl disabled:opacity-40"
        >{saving ? 'Saving…' : 'Save block'}</button>
      </div>
    </div>
  )
}

function trendArrow(weeks) {
  const totals = weeks.map(w => w.total).filter(t => t > 0)
  if (totals.length < 2) return null
  const last = totals[totals.length - 1]
  const prev = totals[totals.length - 2]
  const pct = prev > 0 ? Math.round(((last - prev) / prev) * 100) : null
  if (pct === null) return null
  if (pct >= 5) return { icon: '↑', colour: 'text-green-400', pct }
  if (pct <= -5) return { icon: '↓', colour: 'text-red-400', pct }
  return { icon: '→', colour: 'text-pool-400', pct }
}

function BlockProgression({ blockId }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [expandedSwimmer, setExpandedSwimmer] = useState(null)
  const [analysing, setAnalysing] = useState(false)
  const [analysis, setAnalysis] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await api.getBlockProgress(blockId)
      setData(d)
    } catch {}
    setLoading(false)
  }, [blockId])

  useEffect(() => { load() }, [load])

  const runAnalysis = async () => {
    setAnalysing(true)
    try {
      const r = await api.analyseBlock(blockId)
      setAnalysis(r.analysis)
    } catch (e) {
      setAnalysis(`Error: ${e.message}`)
    }
    setAnalysing(false)
  }

  if (loading) return <p className="text-xs text-pool-500 py-2">Loading progression…</p>

  if (!data || data.swimmers.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-pool-500">No session load data yet for this block.</p>
        <p className="text-xs text-pool-600">Submit registers for sessions within the block date range to see progression.</p>
      </div>
    )
  }

  const { weeks, swimmers, group_intents } = data

  return (
    <div className="space-y-3">
      {/* Group intents */}
      {group_intents && Object.values(group_intents).some(v => v) && (
        <div className="space-y-1.5">
          {Object.entries(group_intents).map(([g, intent]) =>
            intent ? (
              <div key={g} className="bg-pool-900/40 rounded-lg px-3 py-2">
                <span className="text-xs font-semibold text-accent-400 mr-2">{g}</span>
                <span className="text-xs text-pool-300">{intent}</span>
              </div>
            ) : null
          )}
        </div>
      )}

      {/* Swimmer rows */}
      <div className="divide-y divide-pool-700/50">
        {swimmers.map(swimmer => {
          const trend = trendArrow(swimmer.weeks)
          const lastActive = [...swimmer.weeks].reverse().find(w => w.total > 0)
          const isOpen = expandedSwimmer === swimmer.id

          return (
            <div key={swimmer.id}>
              <button
                onClick={() => setExpandedSwimmer(isOpen ? null : swimmer.id)}
                className="w-full flex items-center justify-between py-2.5 text-left"
              >
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-pool-200">{swimmer.name}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {lastActive && (
                    <span className="text-xs text-pool-400">{lastActive.total.toLocaleString()}m</span>
                  )}
                  {trend && (
                    <span className={`text-xs font-semibold ${trend.colour}`}>
                      {trend.icon} {Math.abs(trend.pct)}%
                    </span>
                  )}
                  <span className="text-pool-600 text-xs">{isOpen ? '▲' : '▼'}</span>
                </div>
              </button>

              {isOpen && (
                <div className="pb-3 space-y-2 overflow-x-auto">
                  <div className="flex gap-2 min-w-max">
                    {swimmer.weeks.map(wd => (
                      <div key={wd.week} className="bg-pool-900/50 rounded-lg p-2 min-w-[72px]">
                        <p className="text-xs text-pool-500 mb-1">{wd.week.replace(/\d{4}-W/, 'W')}</p>
                        {wd.total > 0 ? (
                          <>
                            <p className="text-xs font-semibold text-pool-200 mb-1">{wd.total.toLocaleString()}m</p>
                            {Object.entries(wd.volumes).map(([k, v]) =>
                              v > 0 ? (
                                <div key={k} className="flex items-center gap-1 mb-0.5">
                                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${VOLUME_COLOURS[k] || 'bg-pool-500'}`} />
                                  <span className="text-xs text-pool-400">{VOLUME_LABELS[k] || k} {v.toLocaleString()}</span>
                                </div>
                              ) : null
                            )}
                          </>
                        ) : (
                          <p className="text-xs text-pool-700">—</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* AI Analysis */}
      <div className="pt-1">
        {analysis ? (
          <div className="bg-pool-900/50 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-accent-400">AI Coaching Analysis</p>
              <button onClick={() => setAnalysis(null)} className="text-xs text-pool-500">Clear</button>
            </div>
            <div className="text-xs text-pool-300 leading-relaxed space-y-1">
              {analysis.split('\n').map((line, i) => {
                if (line.startsWith('**') && line.endsWith('**')) {
                  return <p key={i} className="font-semibold text-white mt-3 first:mt-0">{line.replace(/\*\*/g, '')}</p>
                }
                return line.trim() ? <p key={i}>{line}</p> : null
              })}
            </div>
          </div>
        ) : (
          <button
            onClick={runAnalysis}
            disabled={analysing}
            className="w-full py-2.5 text-sm font-semibold bg-accent-600/80 rounded-xl disabled:opacity-40"
          >
            {analysing ? 'Analysing…' : 'AI Block Analysis'}
          </button>
        )}
      </div>
    </div>
  )
}


// Graphical timeline bar showing mesos as proportional coloured segments
function MacroTimeline({ macro }) {
  const total = new Date(macro.date_to) - new Date(macro.date_from)
  return (
    <div className="flex rounded-full overflow-hidden h-2 mt-2 bg-pool-700">
      {macro.mesos.map((meso, i) => {
        const c = phaseC(meso.phase_type)
        const width = ((new Date(meso.date_to) - new Date(meso.date_from)) / total) * 100
        return (
          <div
            key={meso.id}
            title={meso.name}
            className={`${c.bar} h-full`}
            style={{ width: `${width}%` }}
          />
        )
      })}
    </div>
  )
}

function mondayForBlock(meso, existing) {
  const today = new Date()
  const start = new Date(`${meso.date_from}T00:00:00`)
  const end = new Date(`${meso.date_to}T00:00:00`)
  let target = today >= start && today <= end ? today : start
  const day = target.getDay()
  target = new Date(target)
  target.setDate(target.getDate() - ((day + 6) % 7))
  const used = new Set(existing.map(m => m.week_start))
  while (used.has(target.toISOString().slice(0, 10))) target.setDate(target.getDate() + 7)
  return target.toISOString().slice(0, 10)
}

function MicrocycleBoard({ meso, microcycles, onReload, printMode = false }) {
  const [planning, setPlanning] = useState(false)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)

  const planWeek = async () => {
    setPlanning(true)
    try {
      const weekStart = mondayForBlock(meso, microcycles)
      const result = await api.planMicroSkill({
        week_start: weekStart,
        request: `Plan the week beginning ${weekStart} inside ${meso.name}. The coach will review before it is saved.`,
      })
      if (result.draft) setDraft(result.draft)
      else alert(result.reply || 'The planner needs a little more information first. Use the season planning chat to answer it.')
    } catch (e) { alert('Weekly planning failed: ' + e.message) }
    setPlanning(false)
  }

  const saveDraft = async () => {
    if (!draft) return
    setSaving(true)
    try {
      await api.createMicrocycle({
        macro_id: meso.macro_id,
        block_id: meso.id,
        squad: meso.squad,
        week_start: draft.week_of,
        label: draft.week_label || 'Weekly plan',
        meso_position_note: draft.meso_position_note,
        progression_note: draft.progression_note,
        recovery_placement: draft.recovery_placement,
        next_week_direction: draft.next_week_direction,
        coach_flags: draft.coach_flags || [],
        sessions: draft.sessions || [],
        status: 'draft',
      })
      setDraft(null)
      onReload()
    } catch (e) { alert('Could not save weekly plan: ' + e.message) }
    setSaving(false)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-pool-500 font-semibold uppercase tracking-wide">Weekly microcycles</p>
        <button onClick={planWeek} disabled={planning} className="text-xs text-accent-400 disabled:opacity-40">
          {planning ? 'Planning…' : '+ AI plan week'}
        </button>
      </div>
      {microcycles.length === 0 && <p className="text-xs text-pool-600">No saved weeks in this phase yet.</p>}
      {microcycles.map(micro => (
        <details key={micro.id} open={printMode || undefined} className="bg-pool-900/45 rounded-lg p-2.5">
          <summary className="cursor-pointer list-none flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-pool-200">{micro.label}</span>
            <span className="text-xs text-pool-500">{fmt(micro.week_start)} · {micro.sessions.length} sessions</span>
          </summary>
          <div className="mt-2 space-y-2">
            {micro.progression_note && <p className="text-xs text-pool-400">{micro.progression_note}</p>}
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {micro.sessions.map((session, index) => (
                <div key={index} className="bg-pool-800 rounded-lg p-2 border border-pool-700/60">
                  <p className="text-xs font-semibold text-pool-200">{session.day || fmt(session.date)}</p>
                  <p className="text-xs text-accent-400 capitalize">{session.session_type || session.energy_focus}</p>
                  <p className="text-xs text-pool-400 mt-1">{session.key_emphasis}</p>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between no-print">
              <button onClick={() => api.updateMicrocycle(micro.id, { status: micro.status === 'confirmed' ? 'draft' : 'confirmed' }).then(onReload)}
                className="text-xs text-teal-400">{micro.status === 'confirmed' ? 'Confirmed ✓' : 'Confirm week'}</button>
              <button onClick={async () => {
                if (!window.confirm(`Delete ${micro.label}?`)) return
                await api.deleteMicrocycle(micro.id)
                onReload()
              }} className="text-xs text-red-400">Delete</button>
            </div>
          </div>
        </details>
      ))}
      {draft && (
        <div className="bg-accent-900/25 border border-accent-700/50 rounded-xl p-3 space-y-2">
          <p className="text-xs uppercase tracking-wide font-semibold text-accent-300">AI weekly draft</p>
          <p className="text-sm font-semibold">{draft.week_label}</p>
          <p className="text-xs text-pool-400">{draft.meso_position_note}</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {(draft.sessions || []).map((session, index) => (
              <div key={index} className="bg-pool-900/50 rounded-lg p-2">
                <p className="text-xs font-semibold">{session.day} · {session.slot_label}</p>
                <p className="text-xs text-accent-400 capitalize">{session.session_type}</p>
                <p className="text-xs text-pool-400">{session.key_emphasis}</p>
              </div>
            ))}
          </div>
          <div className="flex gap-2 no-print">
            <button onClick={saveDraft} disabled={saving} className="flex-1 py-2 text-xs font-semibold bg-accent-600 rounded-lg disabled:opacity-40">
              {saving ? 'Saving…' : 'Save weekly plan'}
            </button>
            <button onClick={() => setDraft(null)} className="px-3 py-2 text-xs bg-pool-700 rounded-lg">Dismiss</button>
          </div>
        </div>
      )}
    </div>
  )
}

function MesoCard({ meso, upcomingMeets, microcycles = [], onEdit, onDelete, printMode = false }) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const c = phaseC(meso.phase_type)
  const meets = (upcomingMeets || []).filter(m => m.date >= meso.date_from && m.date <= meso.date_to)

  useEffect(() => { if (printMode) setExpanded(true) }, [printMode])

  const save = async (form) => {
    await api.updateSeasonBlock(meso.id, form)
    setEditing(false)
    onEdit()
  }

  if (editing) return <BlockForm initial={meso} onSave={save} onCancel={() => setEditing(false)} />

  return (
    <div className={`border rounded-xl overflow-hidden ${c.bg} ${c.border} ${meso.is_current ? 'ring-1 ring-accent-500/60' : ''}`}>
      <button className="w-full px-3 py-2.5 text-left" onClick={() => setExpanded(v => !v)}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {meso.is_current && <span className="text-xs bg-accent-600 text-white rounded-full px-1.5 py-0.5 font-semibold">NOW</span>}
              <span className={`text-sm font-semibold ${c.text}`}>{meso.name}</span>
              <span className="text-xs text-pool-500 capitalize">{meso.phase_type}</span>
            </div>
            <p className="text-xs text-pool-400">{fmt(meso.date_from)} – {fmt(meso.date_to)} · {meso.total_weeks}w</p>
          </div>
          <span className="text-pool-500 text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-white/10 pt-2">
          {/* Group intents */}
          {meso.group_intents && Object.entries(meso.group_intents).some(([, v]) => v) && (
            <div className="space-y-1">
              {Object.entries(meso.group_intents).map(([g, intent]) =>
                intent ? (
                  <div key={g} className="flex gap-2">
                    <span className="text-xs font-semibold text-accent-400 shrink-0">{g}</span>
                    <span className="text-xs text-pool-300 leading-relaxed">{intent}</span>
                  </div>
                ) : null
              )}
            </div>
          )}

          {meso.notes && <p className="text-xs text-pool-400 leading-relaxed">{meso.notes}</p>}

          {/* Meets */}
          {meets.length > 0 && (
            <div className="space-y-1">
              {meets.map(m => <MeetPin key={m.id} meet={m} compact />)}
            </div>
          )}

          <MicrocycleBoard meso={meso} microcycles={microcycles} onReload={onEdit} printMode={printMode} />

          {/* Load progression */}
          <div>
            <p className="text-xs text-pool-500 font-semibold uppercase tracking-wide mb-2">Load Progression</p>
            <BlockProgression blockId={meso.id} />
          </div>

          <div className="flex gap-2 pt-1">
            <button onClick={() => setEditing(true)} className="flex-1 py-1.5 text-xs text-pool-400 bg-pool-700/60 rounded-lg">Edit</button>
            <button onClick={() => onDelete(meso)} className="px-3 py-1.5 text-xs text-red-400 bg-pool-700/60 rounded-lg">Delete</button>
          </div>
        </div>
      )}
    </div>
  )
}

function MacroCard({ macro, upcomingMeets, microcycles, onReload, onDelete, printMode = false }) {
  const [expanded, setExpanded] = useState(macro.is_current)
  const [addingMeso, setAddingMeso] = useState(false)
  const [planningMeso, setPlanningMeso] = useState(false)
  const [mesoDraft, setMesoDraft] = useState(null)
  const [creatingFromDraft, setCreatingFromDraft] = useState(false)

  useEffect(() => { if (printMode) setExpanded(true) }, [printMode])

  const saveMeso = async (form) => {
    await api.createSeasonBlock({ ...form, macro_id: macro.id })
    setAddingMeso(false)
    onReload()
  }

  const planNextPhase = async () => {
    setPlanningMeso(true)
    try {
      const r = await api.planMesoSkill({ macro_id: macro.id, request: 'What should the next training phase be?' })
      setMesoDraft(r.draft)
    } catch (e) {
      alert('Phase planning failed: ' + e.message)
    }
    setPlanningMeso(false)
  }

  const createFromDraft = async () => {
    if (!mesoDraft) return
    setCreatingFromDraft(true)
    try {
      await api.createSeasonBlock({ ...mesoDraft, macro_id: macro.id })
      setMesoDraft(null)
      onReload()
    } catch (e) {
      alert('Failed to create block: ' + e.message)
    }
    setCreatingFromDraft(false)
  }

  const totalWeeks = Math.round((new Date(macro.date_to) - new Date(macro.date_from)) / (7 * 86400000))

  return (
    <div className={`bg-pool-800 border rounded-2xl overflow-hidden ${macro.is_current ? 'border-accent-600/50' : 'border-pool-600'}`}>
      {/* Macro header */}
      <button className="w-full px-4 py-3 text-left" onClick={() => setExpanded(v => !v)}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {macro.is_current && <span className="text-xs bg-accent-600 text-white rounded-full px-2 py-0.5 font-semibold">NOW</span>}
              {macro.is_past && <span className="text-xs text-pool-600">Past</span>}
              <span className="text-sm font-bold text-pool-100">{macro.name}</span>
              {macro.squad && <span className="text-xs text-pool-500">{macro.squad}</span>}
            </div>
            <p className="text-xs text-pool-400 mt-0.5">{fmt(macro.date_from)} – {fmt(macro.date_to)} · {totalWeeks}w · {macro.mesos.length} mesos</p>
          </div>
          <span className="text-pool-500 text-sm shrink-0">{expanded ? '▲' : '▼'}</span>
        </div>
        {/* Timeline bar (always visible) */}
        {macro.mesos.length > 0 && <MacroTimeline macro={macro} />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-pool-700/60 pt-3">
          {/* Narrative */}
          {macro.narrative && (
            <p className="text-xs text-pool-300 leading-relaxed">{macro.narrative}</p>
          )}

          {/* Group definitions */}
          {macro.group_definitions && Object.keys(macro.group_definitions).length > 0 && (
            <div className="bg-pool-900/40 rounded-xl p-3 space-y-1.5">
              <p className="text-xs text-pool-500 font-semibold uppercase tracking-wide mb-1">Groups</p>
              {Object.entries(macro.group_definitions).map(([g, def]) => (
                <div key={g} className="flex gap-2">
                  <span className="text-xs font-semibold text-accent-400 shrink-0 w-6">{g}</span>
                  <div className="flex-1 min-w-0">
                    {def.description && <span className="text-xs text-pool-300">{def.description} · </span>}
                    <span className="text-xs text-pool-500">{(def.swimmer_names || []).join(', ') || `${(def.swimmer_ids || []).length} swimmers`}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Mesos */}
          {macro.mesos.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-pool-500 font-semibold uppercase tracking-wide">Phases</p>
              {macro.mesos.map(meso => (
                <MesoCard
                  key={meso.id}
                  meso={meso}
                  upcomingMeets={upcomingMeets}
                  microcycles={microcycles.filter(m => m.block_id === meso.id)}
                  onEdit={onReload}
                  onDelete={onDelete}
                  printMode={printMode}
                />
              ))}
            </div>
          )}

          {/* Meso draft from AI planning */}
          {mesoDraft && (
            <div className="bg-accent-900/30 border border-accent-700/50 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-accent-300 uppercase tracking-wide">AI Phase Recommendation</p>
                <button onClick={() => setMesoDraft(null)} className="text-xs text-pool-500 hover:text-pool-300">Dismiss</button>
              </div>
              <p className="text-sm font-semibold text-pool-100">{mesoDraft.name}</p>
              <p className="text-xs text-pool-400 capitalize">{mesoDraft.phase_type} · {mesoDraft.duration_weeks}w · {mesoDraft.date_from} to {mesoDraft.date_to}</p>
              {mesoDraft.group_intents && (
                <div className="space-y-1 pt-1">
                  {Object.entries(mesoDraft.group_intents).map(([g, intent]) => intent ? (
                    <div key={g} className="flex gap-2">
                      <span className="text-xs font-semibold text-accent-400 shrink-0 w-6">{g}</span>
                      <span className="text-xs text-pool-300 leading-relaxed">{intent}</span>
                    </div>
                  ) : null)}
                </div>
              )}
              {mesoDraft.notes && <p className="text-xs text-pool-400 italic">{mesoDraft.notes}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={createFromDraft}
                  disabled={creatingFromDraft}
                  className="flex-1 py-2 text-xs font-semibold bg-accent-600 rounded-lg disabled:opacity-40"
                >
                  {creatingFromDraft ? 'Creating…' : 'Create this block'}
                </button>
                <button
                  onClick={() => { setMesoDraft(null); setAddingMeso(true) }}
                  className="px-3 py-2 text-xs text-pool-400 bg-pool-700/60 rounded-lg"
                >
                  Edit first
                </button>
              </div>
            </div>
          )}

          {/* Add meso */}
          {addingMeso ? (
            <BlockForm onSave={saveMeso} onCancel={() => setAddingMeso(false)} />
          ) : (
            <div className="flex gap-2">
              <button onClick={() => setAddingMeso(true)}
                className="flex-1 py-2 text-xs text-pool-400 border border-pool-600 border-dashed rounded-xl">
                + Add phase
              </button>
              <button
                onClick={planNextPhase}
                disabled={planningMeso}
                className="px-3 py-2 text-xs text-accent-400 border border-accent-700/50 rounded-xl disabled:opacity-40 whitespace-nowrap"
              >
                {planningMeso ? 'Planning…' : 'AI Plan'}
              </button>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button onClick={() => onDelete(macro, 'macro')} className="px-3 py-1.5 text-xs text-red-400 bg-pool-700/60 rounded-lg ml-auto">Delete macro</button>
          </div>
        </div>
      )}
    </div>
  )
}

function PlanningAgentPanel({ macros }) {
  const [macroId, setMacroId] = useState('')
  const [status, setStatus] = useState({ pathways: [], recommendations: [], context: { rows: [] } })
  const [meets, setMeets] = useState([])
  const [swimmers, setSwimmers] = useState([])
  const [qualificationSets, setQualificationSets] = useState([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [memberIds, setMemberIds] = useState([])
  const [form, setForm] = useState({ name: '', objective: '', primary_meet_id: '', qualifier_meet_id: '', fallback_meet_id: '', qualification_standard_set_id: '' })

  useEffect(() => {
    if (!macroId && macros.length) setMacroId(String(macros.find(m => m.is_current)?.id || macros[0].id))
  }, [macros, macroId])

  const load = useCallback(async () => {
    if (!macroId) return
    const [agentStatus, meetRows, swimmerRows, standardSets] = await Promise.all([
      api.getPlanningAgentStatus(Number(macroId)), api.getMeets(), api.getSwimmers({ status: 'active' }), api.getQualificationSets(),
    ])
    setStatus(agentStatus)
    setMeets(meetRows)
    setSwimmers(swimmerRows)
    setQualificationSets(standardSets.filter(row => row.status === 'confirmed'))
  }, [macroId])

  useEffect(() => { if (open) load().catch(() => {}) }, [open, load])

  const refresh = async () => {
    setBusy(true)
    try {
      await api.refreshPlanningAgent(Number(macroId))
      await load()
    } catch (e) { alert('Planning refresh failed: ' + e.message) }
    setBusy(false)
  }

  const createPathway = async () => {
    if (!form.name || !macroId) return
    setBusy(true)
    try {
      const pathway = await api.createPlanningPathway({
        macro_id: Number(macroId), name: form.name, objective: form.objective || null,
        primary_meet_id: form.primary_meet_id ? Number(form.primary_meet_id) : null,
        fallback_meet_id: form.fallback_meet_id ? Number(form.fallback_meet_id) : null,
        qualifier_meet_ids: form.qualifier_meet_id ? [Number(form.qualifier_meet_id)] : [],
        qualification_standard_set_id: form.qualification_standard_set_id ? Number(form.qualification_standard_set_id) : null,
      })
      await api.setPlanningPathwayMembers(pathway.id, memberIds.map(swimmer_id => ({ swimmer_id, qualification_status: 'unknown' })))
      await api.refreshPlanningAgent(Number(macroId))
      setAdding(false)
      setMemberIds([])
      setForm({ name: '', objective: '', primary_meet_id: '', qualifier_meet_id: '', fallback_meet_id: '', qualification_standard_set_id: '' })
      await load()
    } catch (e) { alert('Could not create pathway: ' + e.message) }
    setBusy(false)
  }

  const openRecs = status.recommendations.filter(r => r.status === 'open')
  const states = status.context?.rows || []

  const updateQualification = async (pathway, membershipId, qualification_status) => {
    setBusy(true)
    try {
      await api.setPlanningPathwayMembers(pathway.id, pathway.members.map(member => ({
        swimmer_id: member.swimmer_id,
        qualification_status: member.id === membershipId ? qualification_status : member.qualification_status,
        date_from: member.date_from, date_to: member.date_to, notes: member.notes, active: member.active,
      })))
      await api.refreshPlanningAgent(Number(macroId))
      await load()
    } catch (e) { alert('Could not update qualification: ' + e.message) }
    setBusy(false)
  }

  return (
    <section className="bg-pool-800 border border-pool-600 rounded-2xl overflow-hidden no-print">
      <button onClick={() => setOpen(v => !v)} className="w-full p-4 flex items-center justify-between text-left">
        <div>
          <p className="text-sm font-semibold">Planning intelligence</p>
          <p className="text-xs text-pool-400 mt-0.5">Saved target pathways, phase timing and coach-review warnings</p>
        </div>
        <span className="text-xs text-pool-400">{open ? 'Close' : `${openRecs.length} open flags`}</span>
      </button>
      {open && (
        <div className="p-4 pt-0 space-y-4 border-t border-pool-700">
          <div className="flex gap-2 pt-3">
            <select value={macroId} onChange={e => setMacroId(e.target.value)} className="flex-1 bg-pool-700 rounded-lg px-3 py-2 text-xs border border-pool-600">
              {macros.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <button onClick={refresh} disabled={busy || !macroId} className="px-3 py-2 text-xs font-semibold bg-accent-600 rounded-lg disabled:opacity-40">
              {busy ? 'Updating…' : 'Refresh state'}
            </button>
          </div>

          {status.pathways.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {status.pathways.map(pathway => {
                const pathStates = states.filter(s => s.pathway === pathway.name)
                const phases = [...new Set(pathStates.map(s => s.phase))]
                const targets = [...new Set(pathStates.map(s => s.target_meet).filter(Boolean))]
                return (
                  <div key={pathway.id} className="bg-pool-900/50 rounded-xl p-3 border border-pool-700/60">
                    <div className="flex justify-between gap-2">
                      <p className="text-sm font-semibold">{pathway.name}</p>
                      <span className="text-xs text-pool-500">{pathway.members.length} swimmers</span>
                    </div>
                    <p className="text-xs text-pool-400 mt-1">{pathway.objective || targets.join(', ') || 'Target not assigned'}</p>
                    {pathway.qualification_standard_set && <p className="text-xs text-teal-400 mt-1">Standards: {pathway.qualification_standard_set}</p>}
                    {phases.length > 0 && <p className="text-xs text-accent-400 mt-2 capitalize">Current: {phases.join(' / ')}</p>}
                    {pathway.members.length ? (
                      <div className="mt-2 space-y-1">
                        {pathway.members.map(member => (
                          <div key={member.id} className="flex items-center gap-2">
                            <span className="text-xs text-pool-400 truncate flex-1">{member.swimmer}</span>
                            <select value={member.qualification_status || 'unknown'} disabled={busy}
                              onChange={e => updateQualification(pathway, member.id, e.target.value)}
                              className="bg-pool-800 rounded px-1.5 py-1 text-xs border border-pool-700">
                              <option value="unknown">Unknown</option>
                              <option value="chasing">Chasing</option>
                              <option value="qualified">Qualified</option>
                              <option value="not_qualified">Not qualified</option>
                              <option value="not_required">Not required</option>
                            </select>
                          </div>
                        ))}
                      </div>
                    ) : <p className="text-xs text-pool-500 mt-1">No swimmers assigned</p>}
                  </div>
                )
              })}
            </div>
          )}

          {openRecs.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide font-semibold text-pool-400">Needs coach review</p>
              {openRecs.slice(0, 8).map(rec => (
                <div key={rec.id} className="bg-yellow-950/25 border border-yellow-800/40 rounded-xl p-3">
                  <p className="text-xs font-semibold text-yellow-300">{rec.title}</p>
                  <p className="text-xs text-pool-300 mt-1">{rec.detail}</p>
                  <div className="flex gap-3 mt-2">
                    <button onClick={() => api.updatePlanningRecommendation(rec.id, 'accepted').then(load)} className="text-xs text-teal-400">Acknowledge</button>
                    <button onClick={() => api.updatePlanningRecommendation(rec.id, 'dismissed').then(load)} className="text-xs text-pool-500">Dismiss</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {adding ? (
            <div className="bg-pool-900/45 rounded-xl p-3 space-y-2">
              <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Pathway name, e.g. Regional qualifiers"
                className="w-full bg-pool-700 rounded-lg px-3 py-2 text-xs border border-pool-600" />
              <input value={form.objective} onChange={e => setForm(p => ({ ...p, objective: e.target.value }))} placeholder="Objective"
                className="w-full bg-pool-700 rounded-lg px-3 py-2 text-xs border border-pool-600" />
              <div className="grid gap-2 sm:grid-cols-3">
                <select value={form.primary_meet_id} onChange={e => setForm(p => ({ ...p, primary_meet_id: e.target.value }))} className="bg-pool-700 rounded-lg px-2 py-2 text-xs border border-pool-600">
                  <option value="">Primary meet</option>{meets.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <select value={form.qualifier_meet_id} onChange={e => setForm(p => ({ ...p, qualifier_meet_id: e.target.value }))} className="bg-pool-700 rounded-lg px-2 py-2 text-xs border border-pool-600">
                  <option value="">Qualifying meet</option>{meets.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <select value={form.fallback_meet_id} onChange={e => setForm(p => ({ ...p, fallback_meet_id: e.target.value }))} className="bg-pool-700 rounded-lg px-2 py-2 text-xs border border-pool-600">
                  <option value="">Fallback meet</option>{meets.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <select value={form.qualification_standard_set_id} onChange={e => setForm(p => ({ ...p, qualification_standard_set_id: e.target.value }))} className="w-full bg-pool-700 rounded-lg px-2 py-2 text-xs border border-pool-600">
                <option value="">Qualification standards (manual status)</option>
                {qualificationSets.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
              <div className="max-h-40 overflow-y-auto grid grid-cols-2 gap-1 bg-pool-800 rounded-lg p-2">
                {swimmers.map(sw => <label key={sw.id} className="flex gap-2 items-center text-xs text-pool-300 py-1">
                  <input type="checkbox" checked={memberIds.includes(sw.id)} onChange={() => setMemberIds(ids => ids.includes(sw.id) ? ids.filter(id => id !== sw.id) : [...ids, sw.id])} />
                  <span className="truncate">{sw.name}</span>
                </label>)}
              </div>
              <div className="flex gap-2">
                <button onClick={createPathway} disabled={busy || !form.name} className="flex-1 py-2 text-xs font-semibold bg-accent-600 rounded-lg disabled:opacity-40">Save pathway</button>
                <button onClick={() => setAdding(false)} className="px-3 py-2 text-xs bg-pool-700 rounded-lg">Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="w-full py-2 text-xs text-accent-400 border border-accent-800/60 border-dashed rounded-xl">+ Add target pathway</button>
          )}
        </div>
      )}
    </section>
  )
}

export default function SeasonPlan() {
  const [macros, setMacros] = useState([])
  const [orphanBlocks, setOrphanBlocks] = useState([])
  const [summary, setSummary] = useState(null)
  const [microcycles, setMicrocycles] = useState([])
  const [loading, setLoading] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [planHandoff, setPlanHandoff] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('dx_plan_handoff') || 'null') } catch { return null }
  })
  const [savingHandoff, setSavingHandoff] = useState(false)
  const [printMode, setPrintMode] = useState(false)

  const reload = useCallback(async () => {
    const [macroData, blocks, s, micros] = await Promise.all([
      api.getMacros(),
      api.getSeasonBlocks(),
      api.getSeasonSummary(),
      api.getMicrocycles(),
    ])
    setMacros(macroData)
    setOrphanBlocks(blocks.filter(b => !b.macro_id))
    setSummary(s)
    setMicrocycles(micros)
    setLoading(false)
  }, [])

  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    const finishPrint = () => setPrintMode(false)
    window.addEventListener('afterprint', finishPrint)
    return () => window.removeEventListener('afterprint', finishPrint)
  }, [])

  const printPlan = () => {
    setPrintMode(true)
    window.setTimeout(() => window.print(), 150)
  }

  const handleDelete = async (item, type = 'meso') => {
    setConfirmDelete({ item, type })
  }

  const confirmDeleteAction = async () => {
    const { item, type } = confirmDelete
    if (type === 'macro') await api.deleteMacro(item.id)
    else await api.deleteSeasonBlock(item.id)
    setConfirmDelete(null)
    reload()
  }

  const dismissHandoff = () => {
    sessionStorage.removeItem('dx_plan_handoff')
    setPlanHandoff(null)
  }

  const saveHandoff = async () => {
    setSavingHandoff(true)
    try {
      if (planHandoff.plan_type === 'macro') {
        const d = planHandoff.macro_draft
        await api.createMacro({
          name: d.name, squad: d.squad || null, date_from: d.date_from, date_to: d.date_to,
          narrative: d.narrative, group_definitions: d.group_definitions || {},
          mesos: (d.phases || []).map(p => ({
            name: p.name, phase_type: p.phase_type, date_from: p.date_from, date_to: p.date_to,
            group_intents: p.group_intents || {}, notes: p.focus || null,
          })),
        })
      } else if (planHandoff.plan_type === 'meso') {
        const d = planHandoff.meso_draft
        const macro = macros.find(m => d.date_from >= m.date_from && d.date_to <= m.date_to) || macros.find(m => m.is_current) || macros[0]
        await api.createSeasonBlock({ ...d, macro_id: macro?.id || null })
      } else if (planHandoff.plan_type === 'micro') {
        const d = planHandoff.micro_draft
        const block = macros.flatMap(m => m.mesos).find(b => d.week_of >= b.date_from && d.week_of <= b.date_to)
        await api.createMicrocycle({
          macro_id: block?.macro_id || null, block_id: block?.id || null, squad: block?.squad || null,
          week_start: d.week_of, label: d.week_label || 'Weekly plan',
          meso_position_note: d.meso_position_note, progression_note: d.progression_note,
          recovery_placement: d.recovery_placement, next_week_direction: d.next_week_direction,
          coach_flags: d.coach_flags || [], sessions: d.sessions || [],
        })
      }
      dismissHandoff()
      await reload()
    } catch (e) { alert('Could not save plan: ' + e.message) }
    setSavingHandoff(false)
  }

  const upcomingMeets = summary?.upcoming_meets || []
  const orphanMeets = upcomingMeets.filter(m => {
    const allMesos = macros.flatMap(mac => mac.mesos)
    return !allMesos.some(meso => m.date >= meso.date_from && m.date <= meso.date_to)
  })

  if (loading) return <div className="p-4 text-pool-400">Loading…</div>

  return (
    <div className="flex flex-col h-screen season-plan-print">
      <div className="bg-pool-800 px-4 pt-4 pb-3 shrink-0 border-b border-pool-700">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold">Season Plan</h1>
            <p className="text-xs text-pool-500 mt-0.5">Describe your season to the AI chat — it will build the blueprint</p>
          </div>
          <div className="flex gap-2 no-print">
            <button onClick={printPlan} className="bg-pool-700 rounded-xl px-3 py-1.5 text-xs font-semibold">Print plan</button>
            <Link to="/ai" className="bg-accent-600 rounded-xl px-3 py-1.5 text-xs font-semibold">Plan in AI</Link>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {macros.length > 0 && <PlanningAgentPanel macros={macros} />}

        {planHandoff && (
          <section className="bg-accent-900/30 border border-accent-700/60 rounded-2xl p-4 space-y-3 no-print">
            <div>
              <p className="text-xs uppercase tracking-wide font-semibold text-accent-300">AI plan ready to review</p>
              <p className="text-sm font-semibold mt-1">
                {planHandoff.macro_draft?.name || planHandoff.meso_draft?.name || planHandoff.micro_draft?.week_label}
              </p>
              <p className="text-xs text-pool-400 mt-1">
                {planHandoff.plan_type === 'macro'
                  ? `${planHandoff.macro_draft?.phases?.length || 0} phases · ${planHandoff.macro_draft?.date_from} to ${planHandoff.macro_draft?.date_to}`
                  : planHandoff.plan_type === 'meso'
                  ? `${planHandoff.meso_draft?.phase_type} · ${planHandoff.meso_draft?.date_from} to ${planHandoff.meso_draft?.date_to}`
                  : `${planHandoff.micro_draft?.sessions?.length || 0} sessions · week of ${planHandoff.micro_draft?.week_of}`}
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={saveHandoff} disabled={savingHandoff} className="flex-1 py-2.5 text-xs font-semibold bg-accent-600 rounded-xl disabled:opacity-40">
                {savingHandoff ? 'Saving…' : `Save ${planHandoff.plan_type} plan`}
              </button>
              <button onClick={dismissHandoff} className="px-4 py-2.5 text-xs bg-pool-700 rounded-xl">Dismiss</button>
            </div>
          </section>
        )}

        {/* Empty state */}
        {macros.length === 0 && orphanBlocks.length === 0 && (
          <div className="text-center py-12 space-y-3">
            <p className="text-pool-300 text-sm font-medium">No season plan yet</p>
            <p className="text-pool-500 text-xs leading-relaxed max-w-xs mx-auto">
              Go to the AI chat and describe your season — squads, phases, key meets, group structure. The AI will create the blueprint for you.
            </p>
            <Link to="/ai" className="inline-block bg-accent-600 rounded-xl px-4 py-2.5 text-sm font-semibold">Open AI Chat →</Link>
          </div>
        )}

        {/* Macros */}
        {macros.map(macro => (
          <MacroCard
            key={macro.id}
            macro={macro}
            upcomingMeets={upcomingMeets}
            microcycles={microcycles}
            onReload={reload}
            onDelete={handleDelete}
            printMode={printMode}
          />
        ))}

        {/* Orphan mesos (blocks not inside a macro) */}
        {orphanBlocks.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-pool-500 px-1">Standalone blocks</p>
            {orphanBlocks.map(block => (
              <MesoCard
                key={block.id}
                meso={block}
                upcomingMeets={upcomingMeets}
                microcycles={microcycles.filter(m => m.block_id === block.id)}
                onEdit={reload}
                onDelete={(b) => handleDelete(b, 'meso')}
                printMode={printMode}
              />
            ))}
          </div>
        )}

        {/* Orphan meets */}
        {orphanMeets.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-pool-500 px-1">Upcoming meets</p>
            {orphanMeets.map(m => <MeetPin key={m.id} meet={m} />)}
          </div>
        )}

        {/* Active intents */}
        {summary?.active_intents?.length > 0 && (
          <section className="bg-pool-800 rounded-xl p-4 space-y-2">
            <p className="text-xs text-pool-400 font-semibold uppercase tracking-wide">Active swimmer intents</p>
            {summary.active_intents.map((i, idx) => (
              <div key={idx} className="flex gap-2">
                <span className="text-xs font-semibold text-teal-300 shrink-0">{i.swimmer_name}</span>
                <span className="text-xs text-pool-300 leading-relaxed">{i.content}</span>
              </div>
            ))}
          </section>
        )}

        <div className="pt-2 pb-20">
          <Link to="/meets" className="block text-center text-xs text-accent-400 underline">View all meets →</Link>
        </div>
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-end p-4">
          <div className="bg-pool-800 border border-pool-600 rounded-2xl w-full p-5 space-y-4">
            <p className="text-sm font-semibold">Delete "{confirmDelete.item.name}"?</p>
            {confirmDelete.type === 'macro' && (
              <p className="text-xs text-yellow-400">This will also delete all phases inside it.</p>
            )}
            <p className="text-xs text-pool-400">This can't be undone.</p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmDelete(null)} className="flex-1 py-2.5 text-sm bg-pool-700 rounded-xl">Cancel</button>
              <button onClick={confirmDeleteAction} className="flex-1 py-2.5 text-sm font-semibold bg-red-700 rounded-xl">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MeetPin({ meet, compact }) {
  const daysAway = Math.ceil((new Date(meet.date + 'T00:00:00') - new Date()) / (1000*60*60*24))
  const urgency = daysAway <= 7 ? 'text-red-400' : daysAway <= 21 ? 'text-orange-400' : 'text-pool-400'
  if (compact) {
    return (
      <div className="flex items-center gap-2 py-0.5">
        <span className="w-1.5 h-1.5 rounded-full bg-accent-500 shrink-0" />
        <span className="text-xs text-pool-300">{meet.name}</span>
        <span className={`text-xs ${urgency} ml-auto`}>{new Date(meet.date + 'T00:00:00').toLocaleDateString('en-GB', {day:'numeric',month:'short'})}</span>
      </div>
    )
  }
  return (
    <Link to={`/meets/${meet.id}`} className="flex items-center gap-3 bg-pool-900/40 rounded-xl px-3 py-2.5">
      <div className="w-2 h-2 rounded-full bg-accent-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{meet.name}</p>
        <p className="text-xs text-pool-400">
          {new Date(meet.date + 'T00:00:00').toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'})}
          {meet.course && ` · ${meet.course}`}
        </p>
      </div>
      {meet.timetable_session_count > 0 && (
        <span className="text-xs text-accent-300 shrink-0">{meet.timetable_session_count} sessions</span>
      )}
      {meet.a_count > 0 && (
        <span className="text-xs bg-red-900/60 border border-red-700/50 text-red-300 rounded-full px-2 py-0.5 shrink-0">
          {meet.a_count}A
        </span>
      )}
      {meet.target_count > 0 && meet.a_count === 0 && (
        <span className="text-xs text-pool-500 shrink-0">{meet.target_count} swimmers</span>
      )}
    </Link>
  )
}
