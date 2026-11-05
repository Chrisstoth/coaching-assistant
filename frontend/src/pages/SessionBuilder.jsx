import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { mountBuilder } from '../notation/builderUi'
import '../notation/builder.css'

const toIso = d => d.toISOString().slice(0, 10)
const mondayOf = iso => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return toIso(d) }

// Who a session was for, in a few words.
function audienceText(payload) {
  const a = payload.audience
  if (a && a.label) return a.label
  if (a && a.kind === 'camp') return 'Camp'
  return payload.squad ? `${payload.squad} squad` : 'Whole squad'
}

/* Who the session was for: the whole squad, one of the plan's groups, a camp, or one
   swimmer (e.g. their own sessions on a national or para camp). The staff only count a
   session for the swimmers it was for; the register confirms who actually swam it. */
function AudiencePicker({ payload, onSaved, onClose }) {
  const a = payload.audience || { kind: 'squad' }
  const [kind, setKind] = useState(a.kind || 'squad')
  const [label, setLabel] = useState(a.label || '')
  const [groupId, setGroupId] = useState((a.training_group_ids || [])[0] || '')
  const [swimmerId, setSwimmerId] = useState((a.swimmer_ids || [])[0] || '')
  const [groups, setGroups] = useState([])
  const [swimmers, setSwimmers] = useState([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.getPlanGroups(payload.session.date, payload.squad).then(setGroups).catch(() => setGroups([]))
    api.getSwimmers().then(list => setSwimmers((list || []).filter(s => s.status !== 'left'))).catch(() => setSwimmers([]))
  }, [payload.session.date, payload.squad])

  const save = async () => {
    setBusy(true)
    const group = groups.find(g => String(g.training_group_id) === String(groupId))
    const swimmer = swimmers.find(s => String(s.id) === String(swimmerId))
    const body = { kind, label: null, training_group_ids: [], swimmer_ids: [] }
    if (kind === 'group' && group) Object.assign(body, { label: group.name, training_group_ids: [group.training_group_id], swimmer_ids: group.swimmer_ids })
    if (kind === 'camp') Object.assign(body, { label: label.trim() || 'Camp' })
    if (kind === 'swimmer' && swimmer) Object.assign(body, { label: label.trim() || swimmer.name, swimmer_ids: [swimmer.id] })
    try { const res = await api.setBuilderAudience(payload.id, body); onSaved(res.audience) } finally { setBusy(false) }
  }

  const field = 'w-full bg-pool-700 border border-pool-600 rounded-lg px-2 py-1.5 text-xs text-pool-100'
  return (
    <div className="px-4 py-3 bg-pool-800 border-b border-pool-700 space-y-2 text-xs">
      <div className="flex gap-1.5 flex-wrap">
        {[['squad', 'Whole squad'], ['group', 'A group'], ['camp', 'A camp'], ['swimmer', 'One swimmer']].map(([k, t]) => (
          <button key={k} onClick={() => setKind(k)}
            className={`rounded-lg px-3 py-1.5 font-semibold ${kind === k ? 'bg-accent-600 text-white' : 'bg-pool-700 text-pool-300'}`}>{t}</button>
        ))}
      </div>
      {kind === 'group' && (
        <select className={field} value={groupId} onChange={e => setGroupId(e.target.value)}>
          <option value="">Choose a group…</option>
          {groups.map(g => <option key={g.training_group_id} value={g.training_group_id}>{g.name} ({g.swimmer_ids.length})</option>)}
        </select>
      )}
      {kind === 'swimmer' && (
        <select className={field} value={swimmerId} onChange={e => setSwimmerId(e.target.value)}>
          <option value="">Choose a swimmer…</option>
          {swimmers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
      {(kind === 'camp' || kind === 'swimmer') && (
        <input className={field} value={label} onChange={e => setLabel(e.target.value)}
          placeholder={kind === 'camp' ? 'Camp name, e.g. Lanzarote camp' : 'Optional, e.g. Manchester para camp'} />
      )}
      <div className="flex gap-2 justify-end">
        <button onClick={onClose} className="px-3 py-1.5 text-pool-400">Cancel</button>
        <button onClick={save} disabled={busy || (kind === 'group' && !groupId) || (kind === 'swimmer' && !swimmerId)}
          className="px-3 py-1.5 rounded-lg bg-accent-600 text-white font-semibold disabled:opacity-40">Save</button>
      </div>
    </div>
  )
}

/* Choosing the slot for a new session: a date, then one of that day's timetable sessions. */
function NewSession() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [date, setDate] = useState(params.get('date') || toIso(new Date()))
  const [slots, setSlots] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    setSlots(null)
    api.getCalendar(mondayOf(date))
      .then(days => { if (live) setSlots(((days || []).find(d => d.date === date) || { items: [] }).items.filter(i => i.slot_id)) })
      .catch(() => { if (live) setSlots([]) })
    return () => { live = false }
  }, [date])

  const start = async (slot) => {
    setBusy(true); setError('')
    try {
      const res = await api.newBuilderSession({ date, pool_slot_id: slot ? slot.slot_id : null })
      navigate(`/builder/${res.id}`, { replace: true })
    } catch (e) {
      setError(e.message || 'Could not start the session.')
      setBusy(false)
    }
  }

  return (
    <div className="p-4 space-y-4 max-w-xl mx-auto">
      <div className="flex items-center gap-3">
        <Link to="/plan" className="text-pool-400 text-2xl" aria-label="Back">‹</Link>
        <h1 className="text-lg font-semibold">Write a session</h1>
      </div>
      <label className="block text-xs text-pool-400">Date
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          className="mt-1 block w-full bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-pool-100" />
      </label>
      <div className="space-y-2">
        <p className="text-xs text-pool-400">Which session?</p>
        {slots === null && <p className="text-sm text-pool-400">Loading the timetable…</p>}
        {slots && slots.map(s => (
          <button key={`${s.slot_id}-${s.session_id ?? 'new'}`} disabled={busy} onClick={() => start(s)}
            className="w-full text-left bg-pool-800 hover:bg-pool-750 rounded-xl px-4 py-3 disabled:opacity-50">
            <span className="block text-sm font-medium text-pool-100">{s.label || 'Session'}</span>
            <span className="block text-xs text-pool-400">{s.time}{s.end_time ? `–${s.end_time}` : ''}{s.session_id ? ' · already started, opens it' : ''}</span>
          </button>
        ))}
        {slots && !slots.length && <p className="text-sm text-pool-400">No timetable sessions on this day.</p>}
        <button disabled={busy} onClick={() => start(null)}
          className="w-full text-left border border-dashed border-pool-600 rounded-xl px-4 py-3 text-sm text-pool-300 disabled:opacity-50">
          A session outside the timetable (a camp, an extra session…)
        </button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <p className="text-xs text-pool-500">
        Want the staff to draft it with you? <Link to="/session-planner/staff" className="text-accent-400">Write it with the staff</Link>
        {' '}(the older planner, until the staff can comment inside the builder).
      </p>
    </div>
  )
}

/* The Session Builder itself, mounted from the builder's own screen code. */
function Builder({ id }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const host = useRef(null)
  const [payload, setPayload] = useState(null)
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    let live = true
    setPayload(null); setError('')
    api.getBuilderSession(id).then(p => { if (live) setPayload(p) }).catch(e => { if (live) setError(e.message || 'Could not open the session.') })
    return () => { live = false }
  }, [id])

  useEffect(() => {
    if (!payload || !host.current) return
    const club = payload.club || {}
    const squad = payload.squad || ''
    const builder = mountBuilder(host.current, {
      id: payload.id,
      session: payload.session,
      effSys: payload.effort_scale,
      view: params.get('view') === 'pool' ? 'pool' : 'edit',
      brand: club.name || 'Session Builder',
      logo: club.logo || null,
      pdfHeader: `${squad ? squad + ' · ' : ''}Session plan`,
      pdfFooter: `${club.name ? club.name + ' ' : ''}Session Builder`,
      save: s => api.saveBuilderSession(payload.id, s),
      copyNextWeek: async () => {
        try {
          const next = await api.copyBuilderSessionToNextWeek(payload.id)
          navigate(`/builder/${next.id}`)
        } catch (e) { window.alert(e.message || 'Could not copy the session.') }
      },
    })
    return () => builder.destroy()
    // Mount once per session: later payload changes (e.g. who it's for) must not
    // rebuild the builder from the copy loaded when the page opened.
  }, [payload?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="p-4 text-sm text-red-400">{error} <Link className="underline" to="/sessions">Back to sessions</Link></div>
  return (
    <div className="min-h-full">
      {payload && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-pool-900 border-b border-pool-800 text-xs">
          <div className="flex items-center gap-3 min-w-0">
            <Link to={`/sessions/${payload.id}`} className="text-pool-400 text-xl leading-none" aria-label="Back to the session">‹</Link>
            <span className="truncate text-pool-300">
              For <button onClick={() => setPicking(p => !p)} className="font-bold text-pool-100 underline decoration-dotted underline-offset-2">{audienceText(payload)}</button>
              {payload.cycle_code ? ` · Week ${payload.cycle_code}` : ''}
              {payload.pool_slot ? ` · ${payload.pool_slot.label || payload.pool_slot.time}` : ''}
            </span>
          </div>
          <Link to={`/sessions/${payload.id}/register`} className="shrink-0 text-accent-400 font-semibold">Register</Link>
        </div>
      )}
      {payload && picking && (
        <AudiencePicker payload={payload} onClose={() => setPicking(false)}
          onSaved={audience => { setPicking(false); setPayload(p => ({ ...p, audience })) }} />
      )}
      {!payload && <p className="p-4 text-sm text-pool-400">Opening the session…</p>}
      <div ref={host} />
    </div>
  )
}

export default function SessionBuilder() {
  const { id } = useParams()
  return id === 'new' || !id ? <NewSession /> : <Builder id={id} />
}
