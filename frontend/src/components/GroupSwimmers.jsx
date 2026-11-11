import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'

/* Who swims each of a session's groups (Girls, Boys, Group 1…), set from the
   Session Builder. Before the session it is the plan; once the register is taken
   it is who swam what, so saving also puts each swimmer who came in their group
   on the register. Attendance itself is only ever changed on the register. */

// Where each swimmer is now: the register's group for those who came (once it has
// been split), otherwise the group the session lists them in.
function startingPlaces(groups, data) {
  const out = {}
  for (const g of groups) for (const sid of g.swimmer_ids || []) if (!(sid in out)) out[sid] = g.id
  const came = data.swimmers.filter(s => s.attended)
  // A register taken before the session had groups puts everyone in group 1.
  const split = came.some(s => s.group_done >= 2 && s.group_done <= groups.length)
  if (split) for (const s of came) if (s.group_done >= 1 && s.group_done <= groups.length) out[s.id] = groups[s.group_done - 1].id
  return out
}

export default function GroupSwimmers({ builder, sessionId, focusGroup, onClose, onSaved }) {
  const [groups] = useState(() => builder.groups())
  const [data, setData] = useState(null)
  const [place, setPlace] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    api.getBuilderSwimmers(sessionId)
      .then(d => { if (live) { setData(d); setPlace(startingPlaces(groups, d)) } })
      .catch(e => { if (live) setError(e.message || 'Could not load the swimmers.') })
    return () => { live = false }
  }, [sessionId, groups])

  const [cameList, otherList] = useMemo(() => {
    if (!data) return [[], []]
    if (!data.register_taken) return [data.swimmers, []]
    return [data.swimmers.filter(s => s.attended), data.swimmers.filter(s => !s.attended)]
  }, [data])

  const count = gid => Object.values(place).filter(x => x === gid).length
  const unplaced = cameList.filter(s => !place[s.id]).length
  const put = (sid, gid) => setPlace(p => ({ ...p, [sid]: p[sid] === gid ? null : gid }))
  const fill = (gid, planName) => {
    const pg = (data?.plan_groups || []).find(p => p.name === planName)
    if (!pg) return
    setPlace(p => {
      const next = { ...p }
      for (const sid of pg.swimmer_ids) next[sid] = gid
      return next
    })
  }

  const save = async () => {
    setBusy(true); setError('')
    try {
      const session = builder.getSession()
      const order = (data?.swimmers || []).map(s => s.id)
      for (const g of session.groups || []) g.swimmer_ids = order.filter(sid => place[sid] === g.id)
      const res = await api.saveBuilderGroupSwimmers(sessionId, session)
      builder.setGroupSwimmers(res.builder_groups)
      onSaved(res)
    } catch (e) {
      setError(e.message || 'Could not save who swims each group.')
    } finally { setBusy(false) }
  }

  const row = s => (
    <div key={s.id} className="py-2">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-sm text-pool-100 truncate">{s.name}</span>
        {s.training_group && <span className="text-[10px] text-pool-500 shrink-0">{s.training_group}</span>}
      </div>
      <div className="flex gap-1.5 mt-1">
        {groups.map(g => (
          <button key={g.id} type="button" onClick={() => put(s.id, g.id)} aria-pressed={place[s.id] === g.id}
            className={`flex-1 min-w-0 min-h-9 rounded-lg px-2 text-xs font-semibold flex items-center justify-center gap-1.5 ${place[s.id] === g.id ? 'bg-accent-600 text-white' : 'bg-pool-700 text-pool-400'}`}>
            <i className="w-2 h-2 rounded-full shrink-0" style={{ background: g.color }} />
            <span className="truncate">{g.name}</span>
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <div className="builder-gut py-3 bg-pool-800 border-b border-pool-700 space-y-3 text-xs">
      <div>
        <p className="text-sm font-semibold text-pool-100">Who swims each group</p>
        <p className="text-pool-400 mt-0.5">
          {data?.register_taken
            ? 'The register is taken, so this is who swam what. Saving moves each swimmer who came into their group on the register too.'
            : 'Tap a group for each swimmer. The register starts from this, and you can still move anyone on the day.'}
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {groups.map(g => (
          <span key={g.id} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${g.id === focusGroup ? 'border-accent-500' : 'border-pool-600'}`}>
            <i className="w-2 h-2 rounded-full" style={{ background: g.color }} />
            <span className="font-semibold text-pool-100">{g.name}</span>
            <span className="text-pool-400">{count(g.id)}</span>
          </span>
        ))}
        {data && unplaced > 0 && (
          <span className="inline-flex items-center rounded-full bg-amber-900/30 text-amber-300 px-2.5 py-1">
            {unplaced} {data.register_taken ? 'who came' : ''} not in a group
          </span>
        )}
      </div>

      {data?.plan_groups?.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-pool-400">Fill a group from the plan's training groups:</p>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(groups.length, 3)}, minmax(0, 1fr))` }}>
            {groups.map(g => (
              <select key={g.id} value="" onChange={e => fill(g.id, e.target.value)}
                aria-label={`Fill ${g.name} from a training group`}
                className="w-full min-w-0 bg-pool-700 border border-pool-600 rounded-lg px-2 py-1.5 text-pool-100">
                <option value="">{g.name} ←</option>
                {data.plan_groups.map(p => <option key={p.name} value={p.name}>{p.name} ({p.swimmer_ids.length})</option>)}
              </select>
            ))}
          </div>
        </div>
      )}

      {!data && !error && <p className="text-pool-400">Loading the squad…</p>}
      {data && (
        <div>
          {data.register_taken && <p className="text-[11px] uppercase tracking-wide font-semibold text-pool-500">Came to this session · {cameList.length}</p>}
          <div className="divide-y divide-pool-700">{cameList.map(row)}</div>
          {data.register_taken && cameList.length === 0 && <p className="text-pool-400 py-2">Nobody is marked in on the register yet.</p>}
          {otherList.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-pool-400">Not at this session · {otherList.length}</summary>
              <div className="divide-y divide-pool-700">{otherList.map(row)}</div>
            </details>
          )}
        </div>
      )}

      {error && <p className="text-red-400">{error}</p>}
      <div className="flex gap-2 justify-end sticky bottom-0 bg-pool-800 py-1">
        <button type="button" onClick={onClose} className="px-3 py-2 text-pool-400">Cancel</button>
        <button type="button" onClick={save} disabled={busy || !data}
          className="px-4 py-2 rounded-lg bg-accent-600 text-white font-semibold disabled:opacity-40">{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  )
}
