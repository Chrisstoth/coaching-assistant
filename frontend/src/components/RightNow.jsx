import { useEffect, useState } from 'react'
import { api } from '../api'

/* "Right now": injuries, illness and other notes that hold for the swimmers a session
   is for. Usually saved from a debrief; the coach can add, change and clear them here.
   A note stays until it's cleared, or until its end date passes. */

const KINDS = [['injury', 'Injury'], ['illness', 'Illness'], ['other', 'Other']]

const shortDate = iso => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '')

function NoteForm({ note, swimmers, onSaved, onCancel }) {
  const [swimmerId, setSwimmerId] = useState(note?.swimmer_id || '')
  const [kind, setKind] = useState(note?.kind || 'injury')
  const [title, setTitle] = useState(note?.title || '')
  const [detail, setDetail] = useState(note?.detail || '')
  const [impact, setImpact] = useState(note?.impact || '')
  const [until, setUntil] = useState(note?.until || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    setBusy(true); setError('')
    const body = { kind, title: title.trim(), detail: detail.trim() || null, impact: impact.trim() || null, until: until || null }
    try {
      onSaved(note ? await api.updateCurrentNote(note.id, body) : await api.addCurrentNote({ ...body, swimmer_id: Number(swimmerId) }))
    } catch (e) {
      setError(e.message || 'Could not save that.')
      setBusy(false)
    }
  }

  const field = 'w-full bg-pool-700 border border-pool-600 rounded px-2 py-1.5 text-xs text-pool-100'
  return (
    <div className="space-y-2 py-2">
      {!note && (
        <select className={field} value={swimmerId} onChange={e => setSwimmerId(e.target.value)}>
          <option value="">Which swimmer?</option>
          {(swimmers || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
      <div className="flex gap-1.5">
        {KINDS.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setKind(k)}
            className={`rounded px-3 py-1.5 text-xs font-semibold ${kind === k ? 'bg-accent-600 text-white' : 'bg-pool-700 text-pool-300'}`}>{label}</button>
        ))}
      </div>
      <input className={field} value={title} onChange={e => setTitle(e.target.value)}
        placeholder={kind === 'other' ? 'What it is, e.g. Mock exams' : 'What it is, e.g. Left shoulder'} />
      <textarea className={field} rows={2} value={detail} onChange={e => setDetail(e.target.value)} placeholder="What's going on (optional)" />
      <textarea className={field} rows={2} value={impact} onChange={e => setImpact(e.target.value)} placeholder="What it means in training, e.g. no fly, kick with a board" />
      <label className="flex items-center gap-2 text-[11px] text-pool-400">
        Until
        <input type="date" className={`${field} w-auto`} value={until} onChange={e => setUntil(e.target.value)} />
        {until ? <button type="button" onClick={() => setUntil('')} className="text-accent-400">until I clear it</button> : <span>(blank: until I clear it)</span>}
      </label>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs text-pool-400">Cancel</button>
        <button type="button" onClick={save} disabled={busy || !title.trim() || (!note && !swimmerId)}
          className="px-3 py-1.5 rounded bg-accent-600 text-xs text-white font-semibold disabled:opacity-40">{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  )
}

function NoteRow({ note, open, onToggle, onChanged, onCleared }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const hurt = note.kind === 'injury' || note.kind === 'illness'

  const clear = async () => {
    const why = window.prompt(`Clear ${note.swimmer_name}'s "${note.title}"? Say why if you like (e.g. back to full training).`, '')
    if (why === null) return
    setBusy(true)
    try { onCleared(await api.clearCurrentNote(note.id, why.trim())) } finally { setBusy(false) }
  }

  return (
    <li className={`border-l-2 pl-2 ${hurt ? 'border-red-500/70' : 'border-amber-500/60'}`}>
      <button type="button" onClick={onToggle} className="w-full text-left py-0.5">
        <span className="font-semibold text-pool-100">{note.swimmer_name}</span>
        <span className={hurt ? 'text-red-300' : 'text-amber-200'}> · {note.title}</span>
        {note.kind === 'illness' && <span className="text-pool-500"> (ill)</span>}
        {note.impact && <span className="text-pool-300"> — {note.impact}</span>}
      </button>
      {open && !editing && (
        <div className="pb-1.5 space-y-1 text-[11px]">
          {note.detail && <p className="text-pool-300">{note.detail}</p>}
          <p className="text-pool-500">
            Since {shortDate(note.date_from)}{note.until ? ` · until ${shortDate(note.until)}` : ' · until you clear it'}
            {note.source === 'debrief' ? ' · from a debrief' : ''}
          </p>
          <div className="flex gap-3 pt-0.5">
            <button type="button" onClick={clear} disabled={busy} className="font-semibold text-teal-300 disabled:opacity-50">Cleared / back to full</button>
            <button type="button" onClick={() => setEditing(true)} className="text-accent-400">Edit</button>
          </div>
        </div>
      )}
      {open && editing && (
        <NoteForm note={note} onCancel={() => setEditing(false)} onSaved={n => { setEditing(false); onChanged(n) }} />
      )}
    </li>
  )
}

export default function RightNow({ sessionId, poolside = false, className = '' }) {
  const [data, setData] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [adding, setAdding] = useState(false)
  const [swimmers, setSwimmers] = useState(null)
  const [flash, setFlash] = useState('')

  const load = () => api.getCurrentNotesForSession(sessionId).then(setData).catch(() => setData(d => d || { injuries: [], other: [] }))
  useEffect(() => { setData(null); load() }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  const startAdd = () => {
    setAdding(true)
    if (swimmers === null) {
      api.getSwimmers().then(list => setSwimmers((list || []).filter(s => s.status !== 'left').sort((a, b) => a.name.localeCompare(b.name))))
        .catch(() => setSwimmers([]))
    }
  }

  if (!data) return null
  const injuries = data.injuries || []
  const other = data.other || []
  const count = injuries.length + other.length
  // Poolside there's no room for an empty box: say nothing unless there's something to say.
  if (!count && poolside && !adding) return null

  const changed = () => { load() }
  const cleared = n => { setOpenId(null); setFlash(`${n.swimmer_name}: "${n.title}" cleared.`); setTimeout(() => setFlash(''), 4000); load() }

  const rows = list => (
    <ul className="space-y-1">
      {list.map(n => (
        <NoteRow key={n.id} note={n} open={openId === n.id} onToggle={() => setOpenId(openId === n.id ? null : n.id)}
          onChanged={changed} onCleared={cleared} />
      ))}
    </ul>
  )

  return (
    <section className={`${className || 'builder-gut py-2 bg-pool-900 border-b border-pool-800'} text-xs space-y-1.5`} aria-label="Right now">
      <div className="flex items-center gap-2">
        <p className="font-semibold uppercase tracking-wide text-[10px] text-pool-400">
          Right now{data.scope === 'squad' && count ? ' · squad' : ''}
        </p>
        {!count && !adding && <p className="text-pool-500">No injuries or notes on file for these swimmers.</p>}
        {!adding && <button type="button" onClick={startAdd} className="ml-auto text-accent-400 font-semibold">+ Add</button>}
      </div>
      {injuries.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-red-300/90 mb-0.5">Injured or ill</p>
          {rows(injuries)}
        </div>
      )}
      {other.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-amber-300/90 mb-0.5">Other notes</p>
          {rows(other)}
        </div>
      )}
      {flash && <p className="text-teal-300">{flash}</p>}
      {adding && (
        swimmers === null ? <p className="text-pool-400">Loading the squad…</p>
          : <NoteForm swimmers={swimmers} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); load() }} />
      )}
    </section>
  )
}
