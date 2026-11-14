import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import HelpLink from './HelpLink'
import TargetTable from './TargetTable'
import TargetSetSessions from './TargetSetSessions'
import {
  BASE_DISTANCES, DEFAULT_DRAFT, REP_DISTANCES, STROKES, SHORT_STROKE,
  countTimes, draftFromSet, filterSwimmers, payloadFromDraft, toggleStroke,
} from '../targetSets'

const field = 'w-full bg-pool-700 rounded-lg px-2.5 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none'
const label = 'block text-[11px] font-medium text-pool-400 mb-1'

// The Squad page's Targets tab: saved target sets, and the squad's times for one.
export default function TargetTimes() {
  const [sets, setSets] = useState([])
  const [squads, setSquads] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [editing, setEditing] = useState(false)   // false | 'new' | set id
  const [draft, setDraft] = useState(DEFAULT_DRAFT)
  const [table, setTable] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const previewTimer = useRef(null)

  const selected = sets.find(s => s.id === selectedId) || null

  const load = (keepId) => api.getTargetSets().then(r => {
    setSets(r.sets)
    setSquads(r.squads)
    setLoaded(true)
    const nextId = keepId ?? r.sets[0]?.id ?? null
    setSelectedId(nextId)
    if (!r.sets.length) startNew(r.squads)
  }).catch(e => { setError(e.message); setLoaded(true) })

  useEffect(() => { load() }, [])

  // A saved set's table.
  useEffect(() => {
    if (editing || !selectedId) return
    setTable(null)
    api.getTargetSetTable(selectedId).then(setTable).catch(e => setError(e.message))
  }, [selectedId, editing])

  // Live preview while the form is open.
  useEffect(() => {
    if (!editing) return
    const { payload, error: draftError } = payloadFromDraft(draft)
    if (draftError) { setError(draftError); return }
    setError('')
    clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => {
      api.previewTargetSet(payload).then(setTable).catch(e => setError(e.message))
    }, 350)
    return () => clearTimeout(previewTimer.current)
  }, [draft, editing])

  function startNew(squadList = squads) {
    setDraft({ ...DEFAULT_DRAFT, squad: squadList.length === 1 ? squadList[0] : '' })
    setEditing('new')
    setConfirmDelete(false)
  }

  function startEdit() {
    setDraft(draftFromSet(selected))
    setEditing(selected.id)
    setConfirmDelete(false)
  }

  function cancel() {
    setEditing(false)
    setError('')
    if (!sets.length) setTable(null)
  }

  async function save() {
    const { payload, error: draftError } = payloadFromDraft(draft)
    if (draftError) { setError(draftError); return }
    setBusy(true)
    try {
      const saved = editing === 'new'
        ? await api.createTargetSet(payload)
        : await api.updateTargetSet(editing, payload)
      setEditing(false)
      await load(saved.id)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await api.deleteTargetSet(selected.id)
      setConfirmDelete(false)
      setSelectedId(null)
      await load(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const set = (key, value) => setDraft(d => ({ ...d, [key]: value }))
  const shown = filterSwimmers(table?.swimmers, search)

  if (!loaded) return <p className="text-sm text-pool-500 text-center py-8">Loading target sets…</p>

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <p className="text-xs text-pool-400 leading-relaxed flex-1">
          Training target times worked out from each swimmer's race PBs, e.g. their 100 PB ÷ 4 for each 25, then +0.5 and +1.0.
          They update by themselves when a new PB is imported.
        </p>
        <HelpLink topic="targets" />
      </div>

      {/* Saved sets */}
      {!editing && (
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          {sets.map(s => (
            <button key={s.id} onClick={() => setSelectedId(s.id)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium border transition-colors ${
                s.id === selectedId ? 'bg-accent-600 border-accent-600 text-white' : 'border-pool-600 text-pool-300'}`}>
              {s.name}
            </button>
          ))}
          <button onClick={() => startNew()} className="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold border border-dashed border-accent-500 text-accent-400">
            + New target set
          </button>
        </div>
      )}

      {/* The recipe */}
      {editing && (
        <section className="bg-pool-800 border border-pool-700 rounded-xl p-3 space-y-3">
          <p className="text-sm font-semibold">{editing === 'new' ? 'New target set' : 'Edit target set'}</p>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className={label}>Start from their</span>
              <select value={draft.base_distance ?? ''} onChange={e => set('base_distance', e.target.value ? Number(e.target.value) : null)} className={field}>
                {BASE_DISTANCES.map(d => <option key={d} value={d}>{d} PB</option>)}
                <option value="">Target event's own PB</option>
              </select>
            </div>
            <div>
              <span className={label}>Target time for each</span>
              <select value={draft.rep_distance} onChange={e => set('rep_distance', Number(e.target.value))} className={field}>
                {REP_DISTANCES.map(d => <option key={d} value={d}>{d}m</option>)}
              </select>
            </div>
          </div>

          <div>
            <span className={label}>Times to show (seconds added to PB pace)</span>
            <input value={draft.offsetsText} onChange={e => set('offsetsText', e.target.value)} className={field}
              inputMode="decimal" placeholder="0, 0.5, 1.0" />
            <p className="text-[11px] text-pool-500 mt-1">0 is PB pace. Separate with commas: "0, 0.5, 1.0" gives three times.</p>
          </div>

          <div>
            <span className={label}>Strokes</span>
            <div className="flex flex-wrap gap-1.5">
              <button onClick={() => set('strokes', null)}
                className={`rounded-full px-2.5 py-1 text-xs border ${!draft.strokes ? 'bg-accent-600 border-accent-600 text-white' : 'border-pool-600 text-pool-300'}`}>
                Their target events
              </button>
              {STROKES.map(s => (
                <button key={s} onClick={() => set('strokes', toggleStroke(draft.strokes, s))}
                  className={`rounded-full px-2.5 py-1 text-xs border ${draft.strokes?.includes(s) ? 'bg-accent-600 border-accent-600 text-white' : 'border-pool-600 text-pool-300'}`}>
                  {SHORT_STROKE[s]}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-pool-500 mt-1">
              {draft.strokes
                ? draft.base_distance ? `Every swimmer gets ${draft.strokes.map(s => SHORT_STROKE[s]).join(', ')}.` : 'Only their target events in these strokes.'
                : "Each swimmer's own target events, from their profile."}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <span className={label}>PBs from</span>
              <select value={draft.course} onChange={e => set('course', e.target.value)} className={field}>
                <option value="SCM">25m pool</option>
                <option value="LCM">50m pool</option>
              </select>
            </div>
            <div>
              <span className={label}>Show to</span>
              <select value={draft.decimals} onChange={e => set('decimals', Number(e.target.value))} className={field}>
                <option value={1}>0.1 s</option>
                <option value={2}>0.01 s</option>
              </select>
            </div>
            <div>
              <span className={label}>Swimmers</span>
              <select value={draft.squad} onChange={e => set('squad', e.target.value)} className={field}>
                <option value="">Everyone</option>
                {squads.map(sq => <option key={sq} value={sq}>{sq}</option>)}
              </select>
            </div>
          </div>

          <div>
            <span className={label}>Name (optional)</span>
            <input value={draft.name} onChange={e => set('name', e.target.value)} className={field}
              placeholder={`${draft.base_distance ? draft.base_distance + ' PB' : 'Event PB'} pace for ${draft.rep_distance}s`} />
          </div>

          <div className="flex gap-2 pt-1">
            <button onClick={save} disabled={busy}
              className="flex-1 bg-accent-600 text-white rounded-lg py-2 text-sm font-semibold disabled:opacity-50">
              {busy ? 'Saving…' : 'Save target set'}
            </button>
            {(sets.length > 0 || editing !== 'new') && (
              <button onClick={cancel} className="px-4 rounded-lg border border-pool-600 text-sm text-pool-300">Cancel</button>
            )}
          </div>
        </section>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* The times */}
      {table && (
        <section className="bg-pool-800 border border-pool-700 rounded-xl p-3 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              {!editing && selected && <p className="text-sm font-semibold">{selected.name}</p>}
              {editing && <p className="text-[11px] uppercase tracking-wide text-accent-400 font-semibold">Preview</p>}
              <p className="text-xs text-pool-400">{table.set?.summary}</p>
              <p className="text-[11px] text-pool-500 mt-0.5">
                {table.squad || 'All squads'} · {table.swimmers.length} swimmer{table.swimmers.length === 1 ? '' : 's'} · {countTimes(table.swimmers)} event{countTimes(table.swimmers) === 1 ? '' : 's'} with a PB
              </p>
            </div>
            {!editing && selected && (
              <div className="flex gap-1.5 shrink-0">
                <Link to={`/targets/${selected.id}/print`} className="text-xs px-2.5 py-1.5 rounded-lg border border-pool-600 text-pool-300">Print</Link>
                <button onClick={startEdit} className="text-xs px-2.5 py-1.5 rounded-lg border border-pool-600 text-pool-300">Edit</button>
              </div>
            )}
          </div>

          {table.swimmers.length > 6 && (
            <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a swimmer…"
              className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none" />
          )}

          {table.swimmers.length === 0
            ? <p className="text-xs text-pool-500">No active swimmers in {table.squad || 'the squad'}.</p>
            : <TargetTable columns={table.columns} swimmers={shown} />}

          {!editing && selected && <TargetSetSessions setId={selected.id} />}

          {!editing && selected && (
            confirmDelete ? (
              <div className="flex items-center justify-end gap-3 text-xs">
                <span className="text-pool-400">Delete "{selected.name}"? Race times and PBs aren't affected.</span>
                <button onClick={remove} disabled={busy} className="text-red-400 font-semibold">Delete</button>
                <button onClick={() => setConfirmDelete(false)} className="text-pool-400">Keep</button>
              </div>
            ) : (
              <div className="text-right">
                <button onClick={() => setConfirmDelete(true)} className="text-[11px] text-pool-500 hover:text-red-400">Delete this target set</button>
              </div>
            )
          )}
        </section>
      )}
    </div>
  )
}
