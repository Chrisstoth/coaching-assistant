import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import useWhisperVoice, { primeMicrophone } from '../hooks/useWhisperVoice'
import { dropQueuedSessionNote, queuedSessionNotes, subscribeToOfflineQueue } from '../offlineQueue'
import { mergeNotes, newClientId, noteClock, noteSetOptions, setRefFor, setValueFor } from '../sessionNotes'

const SpeechRecognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null

// What a note is, as the server works it out from the words (or the coach sets it).
export const NOTE_KINDS = [
  ['technique', 'Technique'], ['effort', 'Effort'], ['behaviour', 'Behaviour'],
  ['injury', 'Injury'], ['illness', 'Ill'], ['attendance', 'Attendance'], ['general', 'General'],
]
const KIND_LABEL = Object.fromEntries(NOTE_KINDS)
const KIND_STYLE = {
  injury: 'text-red-200 bg-red-900/40 border-red-700/50',
  illness: 'text-amber-200 bg-amber-900/35 border-amber-700/50',
}

function KindChip({ kind }) {
  if (!kind || kind === 'general') return null
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wider rounded border px-1.5 py-0.5 ${KIND_STYLE[kind] || 'text-pool-300 bg-pool-700/60 border-pool-600'}`}>
      {KIND_LABEL[kind] || kind}
    </span>
  )
}

// The phone has signal (notes said with no signal are typed instead: speech goes to the server).
function useOnline() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false))
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  return online
}

// The browser's own dictation, for phones that have it when the server can't be reached.
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
      Which set?
      <select value={value} onChange={e => onChange(e.target.value)}
        className="mt-1 block w-full bg-pool-700 border border-pool-600 rounded-lg px-2.5 py-2 text-sm text-pool-100">
        <option value="">None, the session in general</option>
        {groups.map(g => (
          <optgroup key={g.block_id} label={g.groups.length ? `${g.block} (${g.groups.join(', ')})` : g.block}>
            {g.options.map(o => (
              <option key={o.value} value={o.value}>
                {o.depth > 1 ? `${'  '.repeat(o.depth - 1)}↳ ${o.label}` : o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}

function SwimmerChips({ swimmers, chosen, onToggle }) {
  const [everyone, setEveryone] = useState(false)
  if (!swimmers.length) return null
  const here = swimmers.filter(s => s.here)
  const shown = everyone || !here.length ? swimmers : swimmers.filter(s => s.here || chosen.has(s.id))
  const hidden = swimmers.length - shown.length
  const short = s => {
    const [first, last = ''] = s.name.split(' ')
    return swimmers.filter(x => x.name.split(' ')[0] === first).length > 1 ? `${first} ${last.slice(0, 1)}` : first
  }
  return (
    <div>
      <p className="text-[11px] text-pool-400 mb-1.5">About</p>
      <div className="flex flex-wrap gap-1.5">
        {shown.map(s => (
          <button key={s.id} type="button" onClick={() => onToggle(s.id)} aria-pressed={chosen.has(s.id)}
            className={`rounded px-2.5 py-1 text-xs font-medium border ${chosen.has(s.id) ? 'bg-accent-600 border-accent-500 text-white' : 'bg-pool-800 border-pool-600 text-pool-300'}`}>
            {short(s)}
          </button>
        ))}
        {hidden > 0 && (
          <button type="button" onClick={() => setEveryone(true)} className="rounded px-2.5 py-1 text-xs text-accent-400">
            + {hidden} not here
          </button>
        )}
      </div>
    </div>
  )
}

// The session's sets, for the server to pick the one a note is about.
const setsFor = groups => (groups || []).flatMap(g => g.options.map(o => ({
  value: o.value, block_id: o.block_id, line_id: o.line_id, label: String(o.ref || o.label).slice(0, 300),
})))

/* Making a note: say it (or type it) and that's all. The server works out who it's
   about, which set and what kind of note it is; a wrong guess is fixed with Edit.
   A set tapped poolside (presetSet) stays the set. Saved on the phone with no signal,
   and worked out when it sends. */
export function NoteComposer({ sessionId, swimmers = [], setGroups = [], presetSet = null, onSaved, onCancel, autoFocus = false }) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [check, setCheck] = useState(false)
  const box = useRef(null)
  const online = useOnline()
  const sets = useMemo(() => setsFor(setGroups), [setGroups])

  useEffect(() => { if (autoFocus) box.current?.focus() }, [autoFocus])

  const save = async (words) => {
    const clean = String(words || '').trim()
    if (!clean || saving) return
    const note = {
      client_id: newClientId(),
      text: clean,
      swimmer_ids: [],
      set_ref: presetSet || null,
      noted_at: new Date().toISOString(),
      understand: true,
      sets: presetSet ? [] : sets,
    }
    setSaving(true)
    setError('')
    try {
      const res = await api.addSessionNote(sessionId, note)
      onSaved?.(res?.queued ? { ...note, id: `pending-${note.client_id}`, pending: true, swimmer_names: [] } : res)
      setText('')
      setCheck(false)
    } catch (e) {
      setText(clean)
      setError(e.message || 'The note was not saved.')
    } finally {
      setSaving(false)
    }
  }

  // Said: saved straight away. If it stopped because it thought nobody spoke,
  // the words go in the box to check first.
  const voice = useWhisperVoice(
    (said, { unsure } = {}) => {
      if (unsure) { setText(said); setCheck(true); return }
      save(said)
    },
    { prompt: swimmers.map(s => s.name).join(', ') },
  )
  const dictation = useDictation(said => setText(t => (t.trim() ? `${t.trim()} ${said}` : said)))
  const canTalk = voice.supported && online

  const talk = () => {
    if (voice.recording) { voice.stop(); return }
    primeMicrophone()
    voice.clearError()
    voice.start({ autoStop: true })
  }

  const busy = voice.recording || voice.transcribing || saving
  const label = voice.recording ? 'Listening… tap when done'
    : voice.transcribing ? 'Writing it down…'
      : saving ? 'Saving…'
        : 'Say a note'

  return (
    <div className="space-y-2.5">
      {canTalk ? (
        <>
          <button type="button" onClick={talk} disabled={voice.transcribing || saving}
            className={`w-full flex items-center justify-center gap-2.5 rounded-xl py-4 text-base font-semibold text-white disabled:opacity-70 ${voice.recording ? 'bg-red-600 animate-pulse' : 'bg-accent-600 active:bg-accent-700'}`}>
            <span aria-hidden="true">🎤</span>{label}
          </button>
          {!busy && !text && (
            <p className="text-[11px] text-pool-500 text-center">
              Just say it: "Amy, slow turns on the main set". It works out who and which set.
            </p>
          )}
        </>
      ) : !online && (
        <p className="text-[11px] text-amber-300">
          No signal: type it (or use the mic on your keyboard). It works out who it&apos;s about when it sends.
        </p>
      )}

      <div className="flex gap-2 items-end">
        <textarea ref={box} value={text} onChange={e => { setText(e.target.value); setCheck(false) }} rows={check || text.length > 60 ? 3 : 1}
          placeholder={canTalk ? 'Or type it' : 'What did you see?'}
          className="flex-1 bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm text-pool-100 placeholder-pool-500 focus:border-accent-500 focus:outline-none resize-none" />
        {!canTalk && dictation.supported && (
          <button type="button" onClick={dictation.toggle} aria-label={dictation.listening ? 'Stop listening' : 'Say the note'}
            className={`rounded-full w-10 h-10 text-lg shrink-0 ${dictation.listening ? 'bg-red-500 text-white animate-pulse' : 'bg-pool-700 text-pool-300'}`}>
            🎤
          </button>
        )}
        {text.trim() && (
          <button type="button" onClick={() => save(text)} disabled={saving}
            className="shrink-0 bg-accent-600 disabled:opacity-40 rounded-lg px-4 py-2 text-sm font-semibold text-white">
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
      {check && <p className="text-[11px] text-amber-300">Check it's right, then Save.</p>}

      {(error || voice.error) && <p className="text-xs text-red-300">{error || voice.error}</p>}
      {onCancel && (
        <button type="button" onClick={() => { voice.cancel(); onCancel() }} className="w-full bg-pool-700 rounded-lg py-2.5 text-sm font-semibold text-pool-300">Cancel</button>
      )}
    </div>
  )
}

function NoteRow({ note, sessionId, swimmers, setGroups, onChanged, onDeleted }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.text)
  const [who, setWho] = useState(() => new Set(note.swimmer_ids || []))
  const [setValue, setSetValue] = useState(() => setValueFor(note.set_ref))
  const [kind, setKind] = useState(note.kind || '')
  const [busy, setBusy] = useState(false)
  const about = [...(note.swimmer_names || [])]
  const setLabel = note.set_ref?.label

  const startEdit = () => {
    setDraft(note.text); setWho(new Set(note.swimmer_ids || [])); setSetValue(setValueFor(note.set_ref)); setKind(note.kind || '')
    setEditing(true)
  }
  const toggleWho = id => setWho(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })

  const saveEdit = async () => {
    if (!draft.trim()) return
    setBusy(true)
    const ref = setRefFor(setGroups, setValue)
    const keepSet = setValue === setValueFor(note.set_ref)
    try {
      onChanged(await api.editSessionNote(sessionId, note.id, {
        text: draft.trim(),
        swimmer_ids: [...who],
        ...(keepSet ? {} : ref ? { set_ref: ref } : { clear_set: true }),
        kind: kind || 'general',
      }))
      setEditing(false)
    } catch (e) { window.alert(e.message || 'Could not save the change.') }
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
        <KindChip kind={note.kind} />
        {setLabel && <span className="text-[11px] text-teal-300 bg-teal-900/30 rounded px-1.5 py-0.5 truncate max-w-full">{setLabel}</span>}
      </div>
      {editing ? (
        <div className="mt-2 space-y-2.5">
          <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={2}
            className="w-full bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm text-pool-100 resize-none" />
          <SwimmerChips swimmers={swimmers} chosen={who} onToggle={toggleWho} />
          <SetPicker groups={setGroups} value={setValue} onChange={setSetValue} />
          <label className="block text-[11px] text-pool-400">
            What is it?
            <select value={kind || 'general'} onChange={e => setKind(e.target.value)}
              className="mt-1 block w-full bg-pool-700 border border-pool-600 rounded-lg px-2.5 py-2 text-sm text-pool-100">
              {NOTE_KINDS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </label>
          <div className="flex gap-3 text-xs">
            <button type="button" onClick={saveEdit} disabled={busy || !draft.trim()} className="font-semibold text-accent-400 disabled:opacity-40">Save</button>
            <button type="button" onClick={() => setEditing(false)} className="text-pool-400">Cancel</button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-pool-100 mt-1 whitespace-pre-line">{note.text}</p>
      )}
      {note.pending && <p className="text-[11px] text-amber-300 mt-1">On this phone · sends when there's signal, then it works out who it's about</p>}
      {!editing && (
        <div className="flex gap-3 mt-1 text-[11px]">
          {!note.pending && <button type="button" onClick={startEdit} className="text-pool-500 hover:text-pool-300">Edit</button>}
          <button type="button" onClick={remove} disabled={busy} className="text-pool-500 hover:text-red-300">Delete</button>
        </div>
      )}
    </li>
  )
}

/* The session's notes: say one, and everything noted so far (newest first).
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
            <NoteRow key={n.id} note={withNames(n)} sessionId={sessionId} swimmers={swimmers} setGroups={setGroups}
              onChanged={saved => setNotes(prev => prev.map(x => (x.id === saved.id ? saved : x)))}
              onDeleted={gone => setNotes(prev => prev.filter(x => x.id !== gone.id))} />
          ))}
        </ul>
      )}
    </section>
  )
}
