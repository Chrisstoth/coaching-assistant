import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'

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

const EMPHASIS_KEYS = ['aerobic', 'threshold', 'speed', 'race_pace', 'endurance']
const EMPHASIS_COLOURS = {
  aerobic: 'bg-blue-500', threshold: 'bg-yellow-500', speed: 'bg-red-500',
  race_pace: 'bg-purple-500', endurance: 'bg-green-500',
}

const PHASE_TYPES = ['base','build','peak','taper','competition','recovery','transition']

function fmt(d) {
  if (!d) return ''
  const dt = new Date(d + 'T00:00:00')
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function EmphasisBars({ emphasis }) {
  if (!emphasis) return null
  const keys = EMPHASIS_KEYS.filter(k => emphasis[k] > 0)
  if (!keys.length) return null
  return (
    <div className="space-y-1.5 mt-2">
      {keys.map(k => (
        <div key={k} className="flex items-center gap-2">
          <span className="text-xs text-pool-400 w-20 shrink-0 capitalize">{k.replace('_', ' ')}</span>
          <div className="flex-1 bg-pool-900 rounded-full h-1.5">
            <div className={`h-1.5 rounded-full ${EMPHASIS_COLOURS[k] || 'bg-pool-500'}`} style={{ width: `${emphasis[k]}%` }} />
          </div>
          <span className="text-xs text-pool-400 w-8 text-right">{emphasis[k]}%</span>
        </div>
      ))}
    </div>
  )
}

function BlockForm({ initial, onSave, onCancel }) {
  const today = new Date().toISOString().split('T')[0]
  const [form, setForm] = useState(initial || {
    name: '', phase_type: 'build',
    date_from: today, date_to: today,
    emphasis: { aerobic: 60, threshold: 25, speed: 10, race_pace: 5, endurance: 0 },
    notes: '',
  })
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const setEmp = (k, v) => setForm(p => ({ ...p, emphasis: { ...p.emphasis, [k]: Number(v) } }))
  const total = EMPHASIS_KEYS.reduce((s, k) => s + (Number(form.emphasis?.[k]) || 0), 0)

  return (
    <div className="bg-pool-800 border border-pool-600 rounded-2xl p-4 space-y-3">
      <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="Block name (e.g. Base Aerobic)"
        className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none" />
      <select value={form.phase_type} onChange={e => set('phase_type', e.target.value)}
        className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none capitalize">
        {PHASE_TYPES.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
      </select>
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
      <div>
        <div className="flex justify-between items-center mb-2">
          <span className="text-xs text-pool-400">Training emphasis</span>
          <span className={`text-xs font-semibold ${total === 100 ? 'text-green-400' : 'text-yellow-400'}`}>{total}%</span>
        </div>
        {EMPHASIS_KEYS.map(k => (
          <div key={k} className="flex items-center gap-2 mb-1.5">
            <span className="text-xs text-pool-400 w-20 shrink-0 capitalize">{k.replace('_', ' ')}</span>
            <input type="range" min="0" max="100" step="5" value={form.emphasis?.[k] || 0} onChange={e => setEmp(k, e.target.value)}
              className="flex-1 accent-accent-500" />
            <span className="text-xs text-pool-300 w-8 text-right">{form.emphasis?.[k] || 0}%</span>
          </div>
        ))}
      </div>
      <textarea value={form.notes || ''} onChange={e => set('notes', e.target.value)} placeholder="Notes (optional)"
        rows={2} className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none resize-none" />
      <div className="flex gap-2 pt-1">
        <button onClick={onCancel} className="flex-1 py-2.5 text-sm text-pool-400 bg-pool-700 rounded-xl">Cancel</button>
        <button
          disabled={saving || !form.name || total !== 100}
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

export default function SeasonPlan() {
  const [blocks, setBlocks] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingBlock, setEditingBlock] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [expandedId, setExpandedId] = useState(null)

  useEffect(() => {
    Promise.all([api.getSeasonBlocks(), api.getSeasonSummary()]).then(([b, s]) => {
      setBlocks(b)
      setSummary(s)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const reload = () => Promise.all([api.getSeasonBlocks(), api.getSeasonSummary()]).then(([b, s]) => { setBlocks(b); setSummary(s) })

  const saveBlock = async (form) => {
    if (editingBlock) {
      await api.updateSeasonBlock(editingBlock.id, form)
    } else {
      await api.createSeasonBlock(form)
    }
    setShowForm(false)
    setEditingBlock(null)
    reload()
  }

  // Interleave meets between blocks for display
  const buildTimeline = () => {
    if (!summary) return blocks.map(b => ({ type: 'block', data: b }))
    const items = []
    const meets = [...(summary.upcoming_meets || [])]
    for (const block of blocks) {
      // meets that start within this block
      const blockMeets = meets.filter(m => m.date >= block.date_from && m.date <= block.date_to)
      items.push({ type: 'block', data: block, meets: blockMeets })
    }
    // Orphan meets not in any block
    const blockedDates = new Set(blocks.flatMap(b => {
      const out = []
      let d = new Date(b.date_from)
      const end = new Date(b.date_to)
      while (d <= end) { out.push(d.toISOString().split('T')[0]); d.setDate(d.getDate() + 1) }
      return out
    }))
    const orphanMeets = meets.filter(m => !blockedDates.has(m.date))
    if (orphanMeets.length) items.push({ type: 'orphan_meets', meets: orphanMeets })
    return items
  }

  if (loading) return <div className="p-4 text-pool-400">Loading…</div>

  const timeline = buildTimeline()
  const currentBlock = blocks.find(b => b.is_current)

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="bg-pool-800 px-4 pt-4 pb-3 shrink-0 border-b border-pool-700">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-lg font-bold">Season Plan</h1>
          <button onClick={() => { setEditingBlock(null); setShowForm(true) }}
            className="bg-accent-600 rounded-xl px-3 py-1.5 text-xs font-semibold">+ Block</button>
        </div>
        {currentBlock && (
          <p className="text-xs text-pool-400">
            Currently: <span className={`font-semibold ${phaseC(currentBlock.phase_type).text}`}>{currentBlock.name}</span>
            {currentBlock.week_in && <span> · Week {currentBlock.week_in} of {currentBlock.total_weeks}</span>}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* Add block form */}
        {showForm && !editingBlock && (
          <BlockForm onSave={saveBlock} onCancel={() => setShowForm(false)} />
        )}

        {/* Gap analysis banner */}
        {summary?.gap_analysis?.length > 0 && (
          <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-xl px-4 py-3 space-y-1">
            <p className="text-xs font-semibold text-yellow-300">Block alignment</p>
            {summary.gap_analysis.map((g, i) => (
              <p key={i} className="text-xs text-yellow-200">
                {g.diff < 0 ? '↓' : '↑'} <span className="capitalize">{g.focus.replace('_',' ')}</span>: {g.actual}% actual vs {g.planned}% planned
              </p>
            ))}
          </div>
        )}

        {/* Active coaching intents */}
        {summary?.active_intents?.length > 0 && (
          <section className="bg-pool-800 rounded-xl p-4 space-y-2">
            <p className="text-xs text-pool-400 font-semibold uppercase tracking-wide">Active swimmer intents this block</p>
            {summary.active_intents.map((i, idx) => (
              <div key={idx} className="flex gap-2">
                <span className="text-xs font-semibold text-teal-300 shrink-0">{i.swimmer_name}</span>
                <span className="text-xs text-pool-300 leading-relaxed">{i.content}</span>
              </div>
            ))}
          </section>
        )}

        {/* Empty state */}
        {blocks.length === 0 && !showForm && (
          <div className="text-center py-12 space-y-3">
            <p className="text-pool-400 text-sm">No blocks yet.</p>
            <p className="text-pool-500 text-xs leading-relaxed max-w-xs mx-auto">
              Add training blocks to map out your season. Meets from your calendar will pin automatically.
            </p>
            <button onClick={() => setShowForm(true)} className="bg-accent-600 rounded-xl px-4 py-2.5 text-sm font-semibold">
              Add first block
            </button>
          </div>
        )}

        {/* Timeline */}
        {timeline.map((item, idx) => {
          if (item.type === 'orphan_meets') {
            return (
              <div key="orphan" className="space-y-2">
                <p className="text-xs text-pool-500 px-1">Upcoming meets (not in a block)</p>
                {item.meets.map(m => <MeetPin key={m.id} meet={m} />)}
              </div>
            )
          }
          const block = item.data
          const c = phaseC(block.phase_type)
          const isExpanded = expandedId === block.id
          const isEditing = editingBlock?.id === block.id

          return (
            <div key={block.id}>
              {isEditing ? (
                <BlockForm initial={editingBlock} onSave={saveBlock} onCancel={() => setEditingBlock(null)} />
              ) : (
                <div className={`border rounded-2xl overflow-hidden ${c.bg} ${c.border} ${block.is_current ? 'ring-2 ring-accent-500/50' : ''}`}>
                  {/* Block header */}
                  <button className="w-full px-4 py-3 text-left" onClick={() => setExpandedId(isExpanded ? null : block.id)}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {block.is_current && (
                            <span className="text-xs bg-accent-600 text-white rounded-full px-2 py-0.5 font-semibold shrink-0">NOW</span>
                          )}
                          {block.is_past && (
                            <span className="text-xs text-pool-600 shrink-0">Past</span>
                          )}
                          <span className={`text-sm font-semibold ${c.text}`}>{block.name}</span>
                          {block.phase_type && (
                            <span className="text-xs text-pool-500 capitalize">{block.phase_type}</span>
                          )}
                        </div>
                        <p className="text-xs text-pool-400 mt-0.5">
                          {fmt(block.date_from)} – {fmt(block.date_to)}
                          {block.week_in && <span> · Week {block.week_in}/{block.total_weeks}</span>}
                        </p>
                      </div>
                      <span className="text-pool-500 text-sm shrink-0">{isExpanded ? '▲' : '▼'}</span>
                    </div>

                    {/* Emphasis summary (always visible) */}
                    {block.emphasis && !isExpanded && (
                      <div className="flex gap-1 mt-2 flex-wrap">
                        {EMPHASIS_KEYS.filter(k => block.emphasis[k] >= 10).map(k => (
                          <span key={k} className="text-xs text-pool-400">
                            <span className={`inline-block w-2 h-2 rounded-full mr-1 ${EMPHASIS_COLOURS[k]}`} />
                            {k.replace('_',' ')} {block.emphasis[k]}%
                          </span>
                        ))}
                      </div>
                    )}
                  </button>

                  {/* Expanded content */}
                  {isExpanded && (
                    <div className="px-4 pb-4 space-y-3 border-t border-white/10">
                      <EmphasisBars emphasis={block.emphasis} />

                      {/* Actual vs planned if current block */}
                      {block.is_current && summary?.actual_distribution && Object.keys(summary.actual_distribution).length > 0 && (
                        <div className="bg-pool-900/40 rounded-xl p-3 space-y-1.5">
                          <p className="text-xs text-pool-400 font-semibold">Actual vs planned ({summary.sessions_analysed} sessions)</p>
                          {EMPHASIS_KEYS.filter(k => (block.emphasis?.[k] || 0) + (summary.actual_distribution[k] || 0) > 0).map(k => {
                            const planned = block.emphasis?.[k] || 0
                            const actualCount = summary.actual_distribution[k] || 0
                            const total = Object.values(summary.actual_distribution).reduce((a,b)=>a+b,0)
                            const actualPct = total ? Math.round(actualCount/total*100) : 0
                            const diff = actualPct - planned
                            return (
                              <div key={k} className="flex items-center gap-2">
                                <span className="text-xs text-pool-400 w-20 shrink-0 capitalize">{k.replace('_',' ')}</span>
                                <span className="text-xs text-pool-500 w-8">{planned}%</span>
                                <span className={`text-xs font-semibold w-8 ${diff > 5 ? 'text-orange-400' : diff < -5 ? 'text-blue-400' : 'text-green-400'}`}>{actualPct}%</span>
                                {Math.abs(diff) >= 10 && (
                                  <span className={`text-xs ${diff > 0 ? 'text-orange-400' : 'text-blue-400'}`}>
                                    {diff > 0 ? `+${diff}` : diff}%
                                  </span>
                                )}
                              </div>
                            )
                          })}
                          <p className="text-xs text-pool-600 mt-1">planned → actual</p>
                        </div>
                      )}

                      {block.notes && (
                        <p className="text-xs text-pool-300 leading-relaxed">{block.notes}</p>
                      )}

                      {/* Meets in this block */}
                      {item.meets?.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-xs text-pool-500 font-semibold uppercase tracking-wide">Meets in this block</p>
                          {item.meets.map(m => <MeetPin key={m.id} meet={m} />)}
                        </div>
                      )}

                      {/* Actions */}
                      <div className="flex gap-2 pt-1">
                        <button onClick={() => setEditingBlock(block)} className="flex-1 py-2 text-xs text-pool-400 bg-pool-700/60 rounded-lg">Edit</button>
                        <button
                          onClick={() => setConfirmDelete(block)}
                          className="px-4 py-2 text-xs text-red-400 bg-pool-700/60 rounded-lg"
                        >Delete</button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Meets between blocks (compact, shown even when collapsed) */}
              {item.meets?.length > 0 && !isExpanded && (
                <div className="ml-4 mt-1 space-y-1">
                  {item.meets.map(m => <MeetPin key={m.id} meet={m} compact />)}
                </div>
              )}
            </div>
          )
        })}

        {/* Meets nav link */}
        <div className="pt-2 pb-20">
          <Link to="/meets" className="block text-center text-xs text-accent-400 underline">View all meets →</Link>
        </div>
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-end p-4">
          <div className="bg-pool-800 border border-pool-600 rounded-2xl w-full p-5 space-y-4">
            <p className="text-sm font-semibold">Delete "{confirmDelete.name}"?</p>
            <p className="text-xs text-pool-400">This can't be undone.</p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmDelete(null)} className="flex-1 py-2.5 text-sm bg-pool-700 rounded-xl">Cancel</button>
              <button onClick={async () => {
                await api.deleteSeasonBlock(confirmDelete.id)
                setConfirmDelete(null)
                reload()
              }} className="flex-1 py-2.5 text-sm font-semibold bg-red-700 rounded-xl">Delete</button>
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
