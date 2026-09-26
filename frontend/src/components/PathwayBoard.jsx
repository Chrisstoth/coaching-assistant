import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { SERIES_COLOURS, seriesColour, weekLabel } from '../seasonTimeline'
import { memberEnded, memberLabel, membersPayload, withoutPathway } from '../pathwayMembers'
import { todayIso } from '../squadGroups'

const QUAL_STYLE = {
  qualified: { dot: 'bg-green-500', text: 'text-green-300', label: 'Qualified' },
  close: { dot: 'bg-yellow-500', text: 'text-yellow-300', label: 'Close' },
  not_qualified: { dot: 'bg-red-500', text: 'text-red-300', label: 'Not qualified' },
  unknown: { dot: 'bg-pool-500', text: 'text-pool-400', label: 'Unknown' },
}

function qualStyle(status) {
  return QUAL_STYLE[status] || QUAL_STYLE.unknown
}

function MeetSelect({ value, meets, onChange, placeholder }) {
  return (
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}
      className="w-full bg-pool-700 border border-pool-600 rounded-lg px-2 py-1.5 text-xs text-pool-200 focus:border-accent-500 focus:outline-none"
    >
      <option value="">{placeholder}</option>
      {meets.map(m => (
        <option key={m.id} value={m.id}>
          {m.name}{m.date ? ` · ${weekLabel(m.date)}` : ''}
        </option>
      ))}
    </select>
  )
}

function MemberPicker({ pathway, swimmers, groups, onSaved, onCancel }) {
  const [chosen, setChosen] = useState(() => new Set(pathway.members.map(m => m.swimmer_id)))
  const [joinFrom, setJoinFrom] = useState('')
  const [saving, setSaving] = useState(false)
  const known = new Set(pathway.members.map(m => m.swimmer_id))
  const adding = [...chosen].some(id => !known.has(id))

  const toggle = (id) => {
    setChosen(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      await api.setPlanningPathwayMembers(pathway.id, membersPayload(pathway.members, chosen, joinFrom))
      onSaved()
    } catch (e) {
      alert('Could not save members: ' + e.message)
    }
    setSaving(false)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-pool-400">{chosen.size} selected</p>
        <button onClick={() => setChosen(new Set())} className="text-xs text-pool-500">Clear</button>
      </div>
      {(groups || []).some(g => g.swimmers.length) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-pool-500">Add a group:</span>
          {groups.filter(g => g.swimmers.length).map(g => (
            <button key={g.id}
              onClick={() => setChosen(prev => new Set([...prev, ...g.swimmers.map(s => s.id)]))}
              className="text-[11px] rounded-full px-2.5 py-0.5 border border-accent-700/60 text-accent-300">
              + {g.name} ({g.swimmers.length})
            </button>
          ))}
        </div>
      )}
      <div className="max-h-56 overflow-y-auto flex flex-wrap gap-1.5 pr-1">
        {swimmers.map(s => (
          <button
            key={s.id}
            onClick={() => toggle(s.id)}
            className={`text-[11px] rounded-full px-2.5 py-1 border transition-colors ${
              chosen.has(s.id)
                ? 'bg-accent-600 border-accent-500 text-white'
                : 'bg-pool-700 border-pool-600 text-pool-300'
            }`}
          >
            {s.name}
          </button>
        ))}
      </div>
      {adding && (
        <label className="block space-y-1">
          <span className="text-[11px] text-pool-400">New swimmers join from</span>
          <input type="date" value={joinFrom} onChange={e => setJoinFrom(e.target.value)}
            className="w-full bg-pool-700 border border-pool-600 rounded-lg px-2 py-1.5 text-xs text-pool-200 focus:border-accent-500 focus:outline-none" />
          <span className="block text-[10px] text-pool-500 leading-relaxed">
            Leave blank for the whole macrocycle. Pick a date to branch them off from then - they leave
            their other pathway the day before, and stay in their training group.
          </span>
        </label>
      )}
      <div className="flex gap-2">
        <button onClick={onCancel} className="px-3 py-2 text-xs bg-pool-700 rounded-lg">Cancel</button>
        <button
          onClick={save}
          disabled={saving}
          className="flex-1 py-2 text-xs font-semibold bg-accent-600 rounded-lg disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save swimmers'}
        </button>
      </div>
    </div>
  )
}

function PathwayCard({ pathway, index, meets, swimmers, groups, onReload }) {
  const [expanded, setExpanded] = useState(false)
  const [picking, setPicking] = useState(false)
  const [objective, setObjective] = useState(pathway.objective || '')
  const colour = seriesColour(index)
  const today = todayIso()

  const saveObjective = async () => {
    if ((pathway.objective || '') === objective.trim()) return
    try {
      await api.updatePlanningPathway(pathway.id, { objective: objective.trim() || null })
      onReload()
    } catch (e) {
      alert('Could not save the goals: ' + e.message)
    }
  }

  const setMeet = async (field, meetId) => {
    try {
      await api.updatePlanningPathway(pathway.id, { [field]: meetId })
      onReload()
    } catch (e) {
      alert('Could not update the target: ' + e.message)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Delete the ${pathway.name} pathway?`)) return
    try {
      await api.deletePlanningPathway(pathway.id)
      onReload()
    } catch (e) {
      alert('Could not delete: ' + e.message)
    }
  }

  const counts = useMemo(() => {
    const out = {}
    pathway.members.forEach(m => {
      const key = m.qualification_status || 'unknown'
      out[key] = (out[key] || 0) + 1
    })
    return out
  }, [pathway.members])

  return (
    <div className="bg-pool-800 border border-pool-700 rounded-xl overflow-hidden">
      <button onClick={() => setExpanded(v => !v)} className="w-full px-3 py-2.5 text-left">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colour }} />
          <span className="text-sm font-semibold text-pool-100 flex-1 min-w-0 truncate">{pathway.name}</span>
          <span className="text-xs text-pool-500 shrink-0">{pathway.members.length}</span>
          <span className="text-pool-500 text-xs shrink-0">{expanded ? '▲' : '▼'}</span>
        </div>
        <p className="text-xs text-pool-400 mt-1 ml-4.5">
          {pathway.primary_meet
            ? <>→ {pathway.primary_meet}</>
            : <span className="text-pool-600">No target meet yet</span>}
          {pathway.fallback_meet && <span className="text-pool-500"> · else {pathway.fallback_meet}</span>}
        </p>
        {Object.keys(counts).length > 0 && (
          <div className="flex flex-wrap gap-2 mt-1.5 ml-4.5">
            {Object.entries(counts).map(([status, n]) => {
              const st = qualStyle(status)
              return (
                <span key={status} className={`flex items-center gap-1 text-[10px] ${st.text}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                  {n} {st.label.toLowerCase()}
                </span>
              )
            })}
          </div>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-pool-700 pt-2.5">
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wide text-pool-500 font-semibold">Working towards</label>
            <textarea value={objective} onChange={e => setObjective(e.target.value)} onBlur={saveObjective} rows={2}
              placeholder="The goals for swimmers on this pathway, e.g. qualify for Winter Nationals in the 100 and 200 back"
              className="w-full bg-pool-700 border border-pool-600 rounded-lg px-2 py-1.5 text-xs text-pool-200 focus:border-accent-500 focus:outline-none resize-none" />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wide text-pool-500 font-semibold">Target meet</label>
            <MeetSelect value={pathway.primary_meet_id} meets={meets}
              onChange={id => setMeet('primary_meet_id', id)} placeholder="No target meet" />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wide text-pool-500 font-semibold">
              If they don&rsquo;t qualify
            </label>
            <MeetSelect value={pathway.fallback_meet_id} meets={meets}
              onChange={id => setMeet('fallback_meet_id', id)} placeholder="No fallback meet" />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase tracking-wide text-pool-500 font-semibold">Swimmers</label>
              <button onClick={() => setPicking(v => !v)} className="text-xs text-accent-400">
                {picking ? 'Cancel' : 'Choose'}
              </button>
            </div>

            {picking ? (
              <MemberPicker
                pathway={pathway}
                swimmers={swimmers}
                groups={groups}
                onSaved={() => { setPicking(false); onReload() }}
                onCancel={() => setPicking(false)}
              />
            ) : pathway.members.length ? (
              <div className="flex flex-wrap gap-1.5">
                {pathway.members.map(m => {
                  const st = qualStyle(m.qualification_status)
                  return (
                    <span key={m.id}
                      className={`flex items-center gap-1.5 text-[11px] bg-pool-700 rounded-full px-2.5 py-0.5 ${
                        memberEnded(m, today) ? 'text-pool-500 line-through' : 'text-pool-200'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} title={st.label} />
                      {memberLabel(m, today)}
                    </span>
                  )
                })}
              </div>
            ) : (
              <p className="text-xs text-pool-600">Nobody on this pathway yet.</p>
            )}
          </div>

          <button onClick={remove} className="text-xs text-pool-600 hover:text-red-400">Delete pathway</button>
        </div>
      )}
    </div>
  )
}

export default function PathwayBoard({ macroId, onChanged }) {
  const [pathways, setPathways] = useState([])
  const [meets, setMeets] = useState([])
  const [swimmers, setSwimmers] = useState([])
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const reload = async () => {
    if (!macroId) { setPathways([]); setLoading(false); return }
    setLoading(true)
    try {
      setPathways(await api.getPlanningPathways(macroId))
    } catch {
      setPathways([])
    }
    setLoading(false)
    if (onChanged) onChanged()
  }

  useEffect(() => { reload() }, [macroId])

  useEffect(() => {
    api.getMeets().then(rows => setMeets(Array.isArray(rows) ? rows : [])).catch(() => {})
    api.getSwimmers().then(rows => setSwimmers(Array.isArray(rows) ? rows : [])).catch(() => {})
    api.getGroups().then(data => setGroups(data?.groups || [])).catch(() => {})
  }, [])

  const create = async () => {
    if (!name.trim() || !macroId) return
    try {
      await api.createPlanningPathway({
        macro_id: macroId,
        name: name.trim(),
        colour: ['teal', 'orange', 'blue', 'purple', 'green', 'red'][pathways.length % 6],
      })
      setName('')
      setCreating(false)
      reload()
    } catch (e) {
      alert('Could not create the pathway: ' + e.message)
    }
  }

  if (!macroId) return null

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-pool-300 uppercase tracking-wide">Pathways</h2>
        <button onClick={() => setCreating(v => !v)} className="text-xs text-accent-400">
          {creating ? 'Cancel' : '+ New'}
        </button>
      </div>

      {creating && (
        <div className="bg-pool-800 border border-pool-600 rounded-xl p-3 space-y-2">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') create() }}
            placeholder="Pathway name — e.g. Regional qualifiers"
            className="w-full bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm text-pool-100 placeholder-pool-500 focus:border-accent-500 focus:outline-none"
          />
          <button
            onClick={create}
            disabled={!name.trim()}
            className="w-full py-2 text-xs font-semibold bg-accent-600 rounded-lg disabled:opacity-40"
          >
            Create pathway
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-pool-500 py-2">Loading pathways…</p>
      ) : pathways.length === 0 ? (
        <div className="bg-pool-800 rounded-xl px-4 py-4">
          <p className="text-xs text-pool-400 leading-relaxed">
            No pathways yet. A pathway is what swimmers are aiming at - the target meet, and where they
            go instead if the time does not come. Swimmers in one training group can be on different
            pathways, and a swimmer can branch onto another one from a date.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {pathways.map((p, i) => (
            <PathwayCard key={p.id} pathway={p} index={i + 1} meets={meets}
              swimmers={swimmers} groups={groups} onReload={reload} />
          ))}
          {(() => {
            const missing = withoutPathway(swimmers, pathways, todayIso())
            if (!missing.length) return null
            return (
              <div className="bg-amber-900/20 border border-amber-700/40 rounded-xl px-3 py-2">
                <p className="text-xs text-amber-300 font-medium">Not on a pathway yet ({missing.length})</p>
                <p className="text-[11px] text-pool-400 mt-0.5">
                  Everyone aims at a meet each macrocycle. Open a pathway and Choose to add them.
                </p>
                <p className="text-[11px] text-pool-300 mt-1">{missing.map(s => s.name).join(', ')}</p>
              </div>
            )
          })()}
          {pathways.length >= SERIES_COLOURS.length && (
            <p className="text-[10px] text-pool-600">
              Beyond {SERIES_COLOURS.length} pathways the timeline stops drawing a separate line for each.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
