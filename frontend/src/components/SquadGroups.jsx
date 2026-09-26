import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import StaffVoices, { StaffThinking } from './StaffVoices'
import {
  GROUP_REVIEW_TOPIC, dayLabel, everyone, looksLikeSetNumber, movePayload, moveSummary, nextMoveLabel, pathwayTag,
  reorder, todayIso,
} from '../squadGroups'

// Training groups on the Swimmers page. Who is in which group belongs to the
// squad; the season plan says what each group works on. Moves are dated so
// the weeks before a move keep the old group.

const inputClass = 'w-full bg-pool-900 rounded-lg px-3 py-2 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none'

function SwimmerRow({ swimmer, selecting, selected, onTap, flagMissingPathway }) {
  const next = nextMoveLabel(swimmer)
  return (
    <button onClick={onTap}
      className={`w-full flex items-center gap-2 text-left rounded-lg px-2 py-1.5 transition-colors ${
        selected ? 'bg-accent-600/20' : 'hover:bg-pool-700/60'}`}>
      {selecting && (
        <span className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center text-[9px] ${
          selected ? 'border-accent-500 bg-accent-600 text-white' : 'border-pool-600'}`}>
          {selected ? '✓' : ''}
        </span>
      )}
      <span className="flex-1 min-w-0">
        <span className="block text-sm text-pool-100 truncate">{swimmer.name}</span>
        {swimmer.pathway ? (
          <span className="block text-[10px] text-teal-400 truncate" title="Pathway - what they are aiming at">
            {pathwayTag(swimmer.pathway)}
          </span>
        ) : flagMissingPathway && swimmer.status === 'active' && (
          <span className="block text-[10px] text-amber-300">No pathway yet</span>
        )}
      </span>
      {swimmer.status && swimmer.status !== 'active' && (
        <span className="text-[10px] text-amber-300 capitalize shrink-0">{swimmer.status}</span>
      )}
      {next ? <span className="text-[10px] text-accent-300 shrink-0">{next}</span>
        : swimmer.since && <span className="text-[10px] text-pool-500 shrink-0">since {dayLabel(swimmer.since)}</span>}
    </button>
  )
}

function GroupForm({ initial, onSave, onCancel, onClose, onUp, onDown }) {
  const [name, setName] = useState(initial?.name || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [confirmClose, setConfirmClose] = useState(false)
  return (
    <div className="space-y-2">
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Group name, e.g. Girls or Senior"
        className={inputClass} maxLength={60} autoFocus />
      {looksLikeSetNumber(name) && (
        <p className="text-[11px] text-amber-300">
          The register numbers each session's sets Group 1, Group 2… A name keeps the two apart.
        </p>
      )}
      <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
        placeholder="Who it is for, e.g. older swimmers, five sessions a week" className={inputClass} />
      <div className="flex flex-wrap gap-2 items-center">
        <button onClick={() => onSave({ name, description })} disabled={!name.trim()}
          className="bg-accent-600 disabled:opacity-40 text-white rounded-lg px-3 py-1.5 text-xs font-semibold">
          Save
        </button>
        <button onClick={onCancel} className="text-xs text-pool-400 px-2">Cancel</button>
        {onUp && <button onClick={onUp} className="text-xs text-pool-400 px-1" aria-label="Move group up">↑</button>}
        {onDown && <button onClick={onDown} className="text-xs text-pool-400 px-1" aria-label="Move group down">↓</button>}
        {onClose && (
          <button onClick={() => (confirmClose ? onClose() : setConfirmClose(true))}
            className="ml-auto text-xs text-red-300">
            {confirmClose ? 'Tap again to stop using it' : 'Stop using this group'}
          </button>
        )}
      </div>
      {onClose && confirmClose && (
        <p className="text-[11px] text-pool-400">
          Its swimmers leave it from today and show as not in a group. Past weeks keep who was in it.
        </p>
      )}
    </div>
  )
}

function MoveSheet({ data, ids, today, onDone, onCancel }) {
  const people = everyone(data).filter(s => ids.includes(s.id))
  const from = data.groups.find(g => people.length && people.every(p => g.swimmers.some(s => s.id === p.id)))
  const [target, setTarget] = useState(undefined)     // undefined: nothing picked; null: no group
  const [dateFrom, setDateFrom] = useState(today)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const toGroup = data.groups.find(g => g.id === target)

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await api.moveToGroup(movePayload(ids, target, dateFrom, note))
      onDone()
    } catch (e) {
      setError(e.message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={onCancel}>
      <div className="w-full max-w-lg bg-pool-900 rounded-t-2xl p-4 space-y-3 pb-8 max-h-[85dvh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-pool-100">
            Move {people.length === 1 ? people[0].name : `${people.length} swimmers`}
          </p>
          <button onClick={onCancel} className="text-pool-500 text-lg" aria-label="Close">✕</button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {data.groups.map(g => (
            <button key={g.id} onClick={() => setTarget(g.id)} disabled={from?.id === g.id}
              className={`text-left px-3 py-2 rounded-xl border text-sm transition-colors disabled:opacity-40 ${
                target === g.id ? 'border-accent-500 bg-accent-600/20 text-pool-100' : 'border-pool-700 text-pool-300'}`}>
              {g.name}
              <span className="block text-[10px] text-pool-500">
                {from?.id === g.id ? 'In it now' : `${g.swimmers.length} swimmers`}
              </span>
            </button>
          ))}
          {from && (
            <button onClick={() => setTarget(null)}
              className={`text-left px-3 py-2 rounded-xl border text-sm ${
                target === null ? 'border-accent-500 bg-accent-600/20 text-pool-100' : 'border-pool-700 text-pool-400'}`}>
              No group
            </button>
          )}
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-pool-400">From</span>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={inputClass} />
        </label>
        <input value={note} onChange={e => setNote(e.target.value)} maxLength={300}
          placeholder="Why (optional), e.g. ready for more volume" className={inputClass} />
        {target !== undefined && (
          <p className="text-xs text-pool-300">
            {moveSummary({ names: people.map(p => p.name), fromName: from?.name, toName: toGroup?.name,
              dateFrom, today })}
          </p>
        )}
        {error && <p className="text-xs text-red-300">{error}</p>}
        <button onClick={save} disabled={target === undefined || saving || !dateFrom}
          className="w-full bg-accent-600 disabled:opacity-40 text-white rounded-xl py-2.5 text-sm font-semibold">
          {saving ? 'Saving…' : 'Save the move'}
        </button>
      </div>
    </div>
  )
}

export default function SquadGroups() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)        // a group id, or 'new'
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [moving, setMoving] = useState(null)          // swimmer ids
  const [staffNotes, setStaffNotes] = useState([])
  const [staffBusy, setStaffBusy] = useState(false)
  const staffIds = useRef([])
  const today = todayIso()

  const load = () => api.getGroups().then(setData).catch(e => setError(e.message))
  useEffect(() => { load() }, [])

  const loadStaff = async () => {
    if (!staffIds.current.length) return
    const rows = await api.getStaffNotes({ ids: staffIds.current.join(','), limit: 100 }).catch(() => null)
    if (!Array.isArray(rows)) return
    staffIds.current = [...new Set([...staffIds.current, ...rows.map(r => r.id)])]
    setStaffNotes(rows)
  }

  const askStaff = async () => {
    setStaffBusy(true)
    try {
      const out = await api.conveneStaff({ topic: GROUP_REVIEW_TOPIC, roles: ['manager'], trigger: 'coach_message' })
      staffIds.current = (out?.notes || []).map(n => n.id)
      setStaffNotes(out?.notes || [])
      await loadStaff()
    } catch {
      // A quiet staff room is better than a broken page.
    }
    setStaffBusy(false)
  }

  const save = async (group, form) => {
    setError('')
    try {
      if (group) await api.updateGroup(group.id, form)
      else await api.createGroup(form)
      setEditing(null)
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  const close = async (group) => {
    await api.closeGroup(group.id).catch(e => setError(e.message))
    setEditing(null)
    load()
  }

  const shift = async (index, step) => {
    await api.orderGroups(reorder(data.groups, index, step)).catch(e => setError(e.message))
    load()
  }

  const tap = (swimmer) => {
    if (!selecting) return setMoving([swimmer.id])
    setSelected(prev => {
      const next = new Set(prev)
      next.has(swimmer.id) ? next.delete(swimmer.id) : next.add(swimmer.id)
      return next
    })
  }

  const doneMoving = () => {
    setMoving(null)
    setSelected(new Set())
    setSelecting(false)
    load()
  }

  if (error && !data) return <p className="text-sm text-red-300">Could not load the groups: {error}</p>
  if (!data) return <p className="text-sm text-pool-400">Loading…</p>

  const rows = (swimmers) => swimmers.map(s => (
    <SwimmerRow key={s.id} swimmer={s} selecting={selecting} selected={selected.has(s.id)} onTap={() => tap(s)}
      flagMissingPathway={data.pathways_in_use} />
  ))

  return (
    <div className="space-y-3 pb-24">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-pool-400 leading-relaxed">
          Who trains together. Tap a swimmer to move them; a move has a date, so the weeks before it
          keep their old group. What each swimmer is aiming at is their pathway (in teal) - it can differ
          within a group, and is set on <Link to="/planning" className="text-accent-400">Planning</Link>.
        </p>
        {data.groups.length > 0 && (
          <button onClick={() => { setSelecting(v => !v); setSelected(new Set()) }}
            className="text-xs text-pool-400 border border-pool-700 rounded-full px-3 py-1 shrink-0">
            {selecting ? 'Cancel' : 'Select'}
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-300">{error}</p>}

      {data.groups.length === 0 && editing !== 'new' && (
        <div className="bg-pool-800 rounded-xl p-4 space-y-2">
          <p className="text-sm text-pool-200">No training groups yet.</p>
          <p className="text-xs text-pool-400">
            Add your groups, then tap swimmers to put them in one. Attendance, the season grid, session
            writing and the staff all use them.
          </p>
        </div>
      )}

      {data.groups.map((group, i) => (
        <section key={group.id} className="bg-pool-800 rounded-xl p-3 space-y-1.5">
          {editing === group.id ? (
            <GroupForm initial={group} onSave={form => save(group, form)} onCancel={() => setEditing(null)}
              onClose={() => close(group)}
              onUp={i > 0 ? () => shift(i, -1) : null}
              onDown={i < data.groups.length - 1 ? () => shift(i, 1) : null} />
          ) : (
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-pool-100">
                  {group.name} <span className="text-pool-500 font-normal">({group.swimmers.length})</span>
                </h2>
                {group.description && <p className="text-xs text-pool-400">{group.description}</p>}
              </div>
              <button onClick={() => setEditing(group.id)} className="text-xs text-accent-400 shrink-0">Edit</button>
            </div>
          )}
          {group.swimmers.length ? rows(group.swimmers)
            : <p className="text-xs text-pool-500 px-2">Nobody in this group yet.</p>}
        </section>
      ))}

      {editing === 'new' ? (
        <section className="bg-pool-800 rounded-xl p-3">
          <GroupForm onSave={form => save(null, form)} onCancel={() => setEditing(null)} />
        </section>
      ) : (
        <button onClick={() => setEditing('new')}
          className="w-full border border-dashed border-pool-600 rounded-xl py-2.5 text-sm text-pool-300">
          + New group
        </button>
      )}

      {data.ungrouped.length > 0 && (
        <section className="bg-pool-800/60 border border-pool-700 rounded-xl p-3 space-y-1.5">
          <h2 className="text-sm font-semibold text-pool-300">
            Not in a group <span className="text-pool-500 font-normal">({data.ungrouped.length})</span>
          </h2>
          {rows(data.ungrouped)}
        </section>
      )}

      {data.groups.length > 0 && (
        <section className="space-y-2 pt-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-pool-400">
              The Swimmer Manager can check whether everyone still fits their group. Any move comes to you to approve.
            </p>
            <button onClick={askStaff} disabled={staffBusy}
              className="text-xs text-accent-300 border border-accent-700/60 rounded-full px-3 py-1 shrink-0 disabled:opacity-40">
              Ask the staff
            </button>
          </div>
          {staffBusy && <StaffThinking />}
          <StaffVoices notes={staffNotes} onChanged={loadStaff} onActed={() => { load(); loadStaff() }} />
        </section>
      )}

      {selecting && selected.size > 0 && (
        <div className="fixed bottom-20 left-0 right-0 px-4 z-40">
          <button onClick={() => setMoving([...selected])}
            className="w-full max-w-lg mx-auto block bg-accent-600 rounded-xl py-3 font-semibold text-sm text-white shadow-lg">
            Move {selected.size} swimmer{selected.size === 1 ? '' : 's'}…
          </button>
        </div>
      )}

      {moving && <MoveSheet data={data} ids={moving} today={today} onDone={doneMoving} onCancel={() => setMoving(null)} />}
    </div>
  )
}
