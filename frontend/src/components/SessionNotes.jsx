import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { dropQueuedSessionNote, queuedSessionNotes, subscribeToOfflineQueue } from '../offlineQueue'
import { mergeNotes, newClientId, noteClock, noteSetOptions, setRefFor, setValueFor, swimmersNamed } from '../sessionNotes'

const SpeechRecognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null

// The mic: what's said is added to the note.
function useDictation(onText) {
  const [listening, setListening] = useState(false)
  const rec = useRef(null)
  const heard = useRef(onText)
  heard.current = onText
  useEffect(() => () => { try { rec.current?.stop() } catch { /* already stopped */ } }, [])
  const toggle = () => {
    if (!SpeechRecognition) return
    if (listening) { rec.current?.stop(); setListening(false); return }
    const r = new SpeechRecognition()
    r.continuous = false
    r.interimResults = false
    r.lang = 'en-GB'
    r.onresult = e => heard.current(e.results[0][0].transcript)
    r.onend = () => setListening(false)
    r.onerror = () => setListening(false)
    r.start()
    rec.current = r
    setListening(true)
  }
  return { supported: Boolean(SpeechRecognition), listening, toggle }
}

function SetPicker({ groups, value, onChange }) {
  if (!groups.length) return null
  return (
    <label className="block text-[11px] text-pool-400">
      About a set?
      <select value={value} onChange={e => onChange(e.target.value)}
        className="mt-1 block w-full bg-pool-700 border border-pool-600 rounded-lg px-2.5 py-2 text-sm text-pool-100">
        <option value="">No, the session in general</option>
        {groups.map(g => (
          <optgroup key={g.block_id} label={g.groups.length ? `${g.block} (${g.groups.join(', ')})` : g.block}>
            {g.options.map(o => (
              <option key={o.value} value={o.value}>
                {o.depth > 1 ? `${'  '.repeat(o.depth - 1)}↳ ${o.label}` : o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}

/* Writing one note: typed or said, optionally about swimmers (a name said or typed
   is tagged by itself) and a set. Saves on the phone when there's no signal. */
export function NoteComposer({ sessionId, swimmers = [], setGroups = [], presetSet = null, onSaved, onCancel, autoFocus = false }) {
  const [text, setText] = useState('')
  const [picked, setPicked] = useState(() => new Set())
  const [unpicked, setUnpicked] = useState(() => new Set())
  const [setValue, setSetValue] = useState(() => setValueFor(presetSet))
  const [everyone, setEveryone] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const box = useRef(null)
  const mic = useDictation(said => setText(t => (t.trim() ? `${t.trim()} ${said}` : said)))

  useEffect(() => { setSetValue(setValueFor(presetSet)) }, [presetSet])
  useEffect(() => { if (autoFocus) box.current?.focus() }, [autoFocus])

  const named = useMemo(() => swimmersNamed(text, swimmers), [text, swimmers])
  const chosen = useMemo(() => {
    const ids = new Set([...picked, ...named])
    unpicked.forEach(id => ids.delete(id))
    return ids
  }, [picked, named, unpicked])

  const toggle = id => {
    const on = chosen.has(id)
    setPicked(prev => { const next = new Set(prev); if (on) next.delete(id); else next.add(id); return next })
    setUnpicked(prev => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next })
  }

  const here = swimmers.filter(s => s.here)
  const shown = everyone || !here.length ? swimmers : swimmers.filter(s => s.here || chosen.has(s.id))
  const hidden = swimmers.length - shown.length

  const save = async () => {
    const clean = text.trim()
    if (!clean || saving) return
    const note = {
      client_id: newClientId(),
      text: clean,
      swimmer_ids: swimmers.filter(s => chosen.has(s.id)).map(s => s.id),
      set_ref: setRefFor(setGroups, setValue),
      noted_at: new Date().toISOString(),
    }
    setSaving(true)
    setError('')
    try {
      const res = await api.addSessionNote(sessionId, note)
      const names = swimmers.filter(s => chosen.has(s.id)).map(s => s.name)
      onSaved?.(res?.queued ? { ...note, id: `pending-${note.client_id}`, pending: true, swimmer_names: names } : res)
      setText(''); setPicked(new Set()); setUnpicked(new Set()); setSetValue(setValueFor(presetSet))
    } catch (e) {
      setError(e.message || 'The note was not saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="flex gap-2 items-start">
        <textarea ref={box} value={text} onChange={e => setText(e.target.value)} rows={2}
          placeholder={mic.supported ? 'What did you see? Type, or tap the mic and say it' : 'What did you see?'}
          className="flex-1 bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm text-pool-100 placeholder-pool-500 focus:border-accent-500 focus:outline-none resize-none" />
        {mic.supported && (
          <button type="button" onClick={mic.toggle} aria-label={mic.listening ? 'Stop listening' : 'Say the note'}
            className={`rounded-full w-11 h-11 text-lg shrink-0 ${mic.listening ? 'bg-red-500 text-white animate-pulse' : 'bg-pool-700 text-pool-300'}`}>
            🎤
          </button>
        )}
      </div>

      {swimmers.length > 0 && (
        <div>
          <p className="text-[11px] text-pool-400 mb-1.5">About anyone? <span className="text-pool-500">Names you say or type are picked for you.</span></p>
          <div className="flex flex-wrap gap-1.5">
            {shown.map(s => (
              <button key={s.id} type="button" onClick={() => toggle(s.id)} aria-pressed={chosen.has(s.id)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium border ${chosen.has(s.id) ? 'bg-accent-600 border-accent-500 text-white' : 'bg-pool-800 border-pool-600 text-pool-300'}`}>
                {s.name.split(' ')[0]}{swimmers.filter(x => x.name.split(' ')[0] === s.name.split(' ')[0]).length > 1 ? ` ${(s.name.split(' ')[1] || '').slice(0, 1)}` : ''}
              </button>
            ))}
            {hidden > 0 && (
              <button type="button" onClick={() => setEveryone(true)} className="rounded-full px-2.5 py-1 text-xs text-accent-400">
                + {hidden} not here
              </button>
            )}
          </div>
        </div>
      )}

      <SetPicker groups={setGroups} value={setValue} onChange={setSetValue} />

      {error && <p className="text-xs text-red-300">{error}</p>}
      <div className="flex gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="flex-1 bg-pool-700 rounded-lg py-2.5 text-sm font-semibold text-pool-300">Cancel</button>
        )}
        <button type="button" onClick={save} disabled={!text.trim() || saving}
          className="flex-1 bg-accent-600 disabled:opacity-40 rounded-lg py-2.5 text-sm font-semibold text-white">
          {saving ? 'Saving…' : 'Save note'}
        </button>
      </div>
    </div>
  )
}

function NoteRow({ note, sessionId, onChanged, onDeleted }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.text)
  const [busy, setBusy] = useState(false)
  const about = [...(note.swimmer_names || [])]
  const setLabel = note.set_ref?.label

  const saveEdit = async () => {
    if (!draft.trim()) return
    setBusy(true)
    try { onChanged(await api.editSessionNote(sessionId, note.id, { text: draft.trim() })); setEditing(false) }
    catch (e) { window.alert(e.message || 'Could not save the change.') }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (!window.confirm('Delete this note?')) return
    if (note.pending) { dropQueuedSessionNote(note.client_id); onDeleted(note); return }
    setBusy(true)
    try { await api.deleteSessionNote(sessionId, note.id); onDeleted(note) }
    catch (e) { window.alert(e.message || 'Could not delete the note.'); setBusy(false) }
  }

  return (
    <li className="py-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-pool-500 tabular-nums">{noteClock(note.noted_at)}</span>
        {about.map(name => <span key={name} className="text-[11px] font-semibold text-accent-300">{name}</span>)}
        {setLabel && <span className="text-[11px] text-teal-300 bg-teal-900/30 rounded px-1.5 py-0.5 truncate max-w-full">{setLabel}</span>}
      </div>
      {editing ? (
        <div className="mt-1.5 space-y-1.5">
          <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={2}
            className="w-full bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm text-pool-100 resize-none" />
          <div className="flex gap-3 text-xs">
            <button type="button" onClick={saveEdit} disabled={busy || !draft.trim()} className="font-semibold text-accent-400 disabled:opacity-40">Save</button>
            <button type="button" onClick={() => { setEditing(false); setDraft(note.text) }} className="text-pool-400">Cancel</button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-pool-100 mt-1 whitespace-pre-line">{note.text}</p>
      )}
      {note.pending && <p className="text-[11px] text-amber-300 mt-1">On this phone · sends when there's signal</p>}
      {!editing && (
        <div className="flex gap-3 mt-1 text-[11px]">
          {!note.pending && <button type="button" onClick={() => setEditing(true)} className="text-pool-500 hover:text-pool-300">Edit</button>}
          <button type="button" onClick={remove} disabled={busy} className="text-pool-500 hover:text-red-300">Delete</button>
        </div>
      )}
    </li>
  )
}

/* The session's notes: write one, and everything noted so far (newest first).
   swimmers: [{ id, name, here }]. builderSession: the written session, for the sets. */
export default function SessionNotesPanel({ sessionId, swimmers, builderSession, onCount }) {
  const [notes, setNotes] = useState([])
  const [loaded, setLoaded] = useState(false)
  const setGroups = useMemo(() => noteSetOptions(builderSession), [builderSession])
  const latest = useRef(notes)
  latest.current = notes

  const load = useCallback(async () => {
    const saved = await api.getSessionNotes(sessionId).catch(() => null)
    setNotes(prev => mergeNotes(saved ?? prev.filter(n => !n.pending), queuedSessionNotes(sessionId)))
    setLoaded(true)
  }, [sessionId])

  useEffect(() => { load() }, [load])
  // A note saved with no signal shows as waiting; once it has synced, show the saved copy.
  useEffect(() => subscribeToOfflineQueue(() => {
    const waiting = new Set(queuedSessionNotes(sessionId).map(n => n.client_id))
    if (latest.current.some(n => n.pending && !waiting.has(n.client_id))) load()
  }), [sessionId, load])
  useEffect(() => { onCount?.(notes.length) }, [notes.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const names = id => swimmers.find(s => s.id === id)?.name
  const withNames = n => (n.swimmer_names?.length || !n.swimmer_ids?.length ? n : { ...n, swimmer_names: n.swimmer_ids.map(names).filter(Boolean) })

  return (
    <section className="bg-pool-800 border border-pool-700 rounded-2xl p-4 space-y-3">
      <div>
        <p className="text-xs font-semibold text-accent-300 uppercase tracking-wider">Notes during the session</p>
        <p className="text-[11px] text-pool-500 mt-0.5">They go into the debrief afterwards, not straight onto anyone's record.</p>
      </div>
      <NoteComposer sessionId={sessionId} swimmers={swimmers} setGroups={setGroups}
        onSaved={note => setNotes(prev => mergeNotes([note, ...prev.filter(n => !n.pending && n.id !== note.id)], queuedSessionNotes(sessionId)))} />
      {loaded && notes.length > 0 && (
        <ul className="divide-y divide-pool-700/70 border-t border-pool-700/70">
          {notes.map(n => (
            <NoteRow key={n.id} note={withNames(n)} sessionId={sessionId}
              onChanged={saved => setNotes(prev => prev.map(x => (x.id === saved.id ? saved : x)))}
              onDeleted={gone => setNotes(prev => prev.filter(x => x.id !== gone.id))} />
          ))}
        </ul>
      )}
    </section>
  )
}
