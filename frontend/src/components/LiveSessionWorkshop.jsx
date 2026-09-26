import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { staffStyle } from '../staffRoom'
import {
  DECIDED_LABEL, POLL_MS, changeLabel, changedLineIds, isWorking, pendingByLine, statusLine,
} from '../sessionWorkshop'

// A session written with the staff, live. The draft arrives first, then each
// specialist's suggestions land on the lines they are about. Nothing changes
// until the coach accepts; "Use this session" hands it to the planner to save.

function Badge({ role }) {
  const style = staffStyle(role)
  return (
    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold text-white shrink-0"
      style={{ backgroundColor: style.colour }} title={style.title}>
      {style.initials}
    </span>
  )
}

function Voices({ voices }) {
  if (!voices.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {voices.map(v => (
        <span key={v.role} title={v.comment || ''}
          className={`flex items-center gap-1.5 text-[11px] rounded-full pl-0.5 pr-2.5 py-0.5 bg-pool-800 border border-pool-700 ${
            v.status === 'thinking' ? 'animate-pulse text-pool-400' : 'text-pool-300'}`}>
          <Badge role={v.role} />
          {v.status === 'thinking' ? 'Reading…'
            : v.status === 'quiet' ? 'Nothing to change'
              : v.status === 'failed' ? 'Could not look'
                : 'Has suggestions'}
        </span>
      ))}
    </div>
  )
}

function Suggestion({ s, onDecide, busy }) {
  return (
    <div className="border-l-2 pl-2.5 py-1 space-y-1" style={{ borderColor: staffStyle(s.role).colour }}>
      <div className="flex items-start gap-2">
        <Badge role={s.role} />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-pool-100">
            {s.change === 'replace' ? <><span className="text-pool-500">Change to:</span> {changeLabel(s)}</> : changeLabel(s)}
          </p>
          {s.reason && <p className="text-[11px] text-pool-400 mt-0.5">{s.reason}</p>}
        </div>
      </div>
      <div className="flex gap-2 pl-8">
        <button onClick={() => onDecide(s, true)} disabled={busy}
          className="text-xs font-semibold bg-accent-600 disabled:opacity-40 text-white rounded-lg px-3 py-1">Accept</button>
        <button onClick={() => onDecide(s, false)} disabled={busy}
          className="text-xs text-pool-400 border border-pool-700 rounded-lg px-3 py-1">Reject</button>
      </div>
    </div>
  )
}

function Line({ line, highlight, pending, onEdit, onDecide, busy }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(line.text)
  useEffect(() => { if (!editing) setValue(line.text) }, [line.text, editing])

  const save = () => {
    setEditing(false)
    if (value.trim() !== line.text) onEdit(line, value)
  }

  return (
    <div className={`rounded-lg px-2 py-1.5 transition-colors duration-700 ${highlight ? 'bg-accent-600/25' : ''}`}>
      {editing ? (
        <input value={value} onChange={e => setValue(e.target.value)} onBlur={save} autoFocus
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
          className="w-full bg-pool-700 border border-accent-600 rounded px-2 py-1 text-sm focus:outline-none" />
      ) : (
        <button onClick={() => setEditing(true)} className="w-full text-left text-sm text-pool-100"
          title="Tap to edit this line yourself">
          {line.text}
        </button>
      )}
      {pending.length > 0 && (
        <div className="mt-1.5 space-y-2">
          {pending.length > 1 && (
            <p className="text-[11px] font-semibold text-amber-300">Your call: {pending.length} suggestions for this line</p>
          )}
          {pending.map(s => <Suggestion key={s.id} s={s} onDecide={onDecide} busy={busy} />)}
        </div>
      )}
    </div>
  )
}

export default function LiveSessionWorkshop({ workshopId, onUse, onClose }) {
  const [ws, setWs] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [using, setUsing] = useState(false)
  const [highlight, setHighlight] = useState([])
  const lastDraft = useRef(null)

  const take = (next) => {
    const changed = changedLineIds(lastDraft.current, next.draft)
    lastDraft.current = next.draft
    if (changed.length) {
      setHighlight(changed)
      window.setTimeout(() => setHighlight([]), 2500)
    }
    setWs(next)
  }

  useEffect(() => {
    let stopped = false
    let timer = null
    lastDraft.current = null
    const poll = async () => {
      try {
        const next = await api.getSessionWorkshop(workshopId)
        if (stopped) return
        take(next)
        if (isWorking(next.status)) timer = window.setTimeout(poll, POLL_MS)
      } catch (e) {
        if (!stopped) setError(e.message)
      }
    }
    poll()
    return () => { stopped = true; if (timer) window.clearTimeout(timer) }
  }, [workshopId])

  const decide = async (s, accept) => {
    setBusy(true)
    setError('')
    try {
      take(await api.decideWorkshopSuggestion(workshopId, s.id, accept))
    } catch (e) {
      setError(e.message)
    }
    setBusy(false)
  }

  const edit = async (line, text) => {
    setBusy(true)
    try {
      take(await api.editWorkshopLine(workshopId, line.id, text))
    } catch (e) {
      setError(e.message)
    }
    setBusy(false)
  }

  const use = async () => {
    setUsing(true)
    setError('')
    try {
      onUse(await api.finishSessionWorkshop(workshopId))
    } catch (e) {
      setError(e.message)
      setUsing(false)
    }
  }

  const pending = pendingByLine(ws?.suggestions)
  const decided = (ws?.suggestions || []).filter(s => s.status !== 'pending')
  const draft = ws?.draft

  return (
    <div className="px-4 pt-5 pb-6 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-accent-300 font-semibold">Writing with the staff</p>
          <p className={`text-xs mt-0.5 ${ws?.status === 'failed' ? 'text-red-300' : 'text-pool-300'} ${
            isWorking(ws?.status) ? 'animate-pulse' : ''}`}>
            {statusLine(ws)}
          </p>
        </div>
        <button onClick={onClose} className="text-xs text-pool-500 shrink-0">Start again</button>
      </div>

      <Voices voices={ws?.voices || []} />

      {draft ? (
        <div className="bg-pool-800 rounded-2xl p-3 space-y-3">
          <div>
            <h2 className="font-bold text-base text-pool-100">{draft.title || 'Session'}</h2>
            {draft.coach_intent && <p className="text-xs text-pool-400 mt-0.5">{draft.coach_intent}</p>}
            {ws.plan_alignment && <p className="text-[11px] text-teal-300 mt-1">{ws.plan_alignment}</p>}
          </div>
          {draft.sections.map(section => (
            <div key={section.key} className="space-y-0.5">
              <p className="text-[10px] uppercase tracking-wide text-pool-500 font-semibold px-2">
                {section.key === 'warm_up' || section.key === 'cool_down'
                  ? section.label : `Group ${section.key} · ${section.label}`}
              </p>
              {section.lines.map(line => (
                <Line key={line.id} line={line} highlight={highlight.includes(line.id)}
                  pending={pending[line.id] || []} onEdit={edit} onDecide={decide} busy={busy} />
              ))}
            </div>
          ))}
          <p className="text-[10px] text-pool-500 px-2">Tap any line to change it yourself.</p>
        </div>
      ) : ws?.status !== 'failed' && (
        <div className="bg-pool-800 rounded-2xl p-6 text-center text-xs text-pool-400 animate-pulse">
          Drafting…
        </div>
      )}

      {(ws?.voices || []).some(v => v.comment) && (
        <div className="space-y-1.5">
          {ws.voices.filter(v => v.comment).map(v => (
            <p key={v.role} className="flex items-start gap-2 text-xs text-pool-300">
              <Badge role={v.role} /> <span className="pt-1">{v.comment}</span>
            </p>
          ))}
        </div>
      )}

      {decided.length > 0 && (
        <details className="text-xs text-pool-400">
          <summary className="cursor-pointer">Decided ({decided.length})</summary>
          <ul className="mt-1.5 space-y-1">
            {decided.map(s => (
              <li key={s.id}>
                <span className="text-pool-500">{DECIDED_LABEL[s.status] || s.status}</span> · {staffStyle(s.role).title}: {changeLabel(s)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {error && <p className="text-xs text-red-300">{error}</p>}

      {draft && (
        <button onClick={use} disabled={using}
          className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-3 text-sm font-semibold text-white">
          {using ? 'Working out the training dose…'
            : isWorking(ws.status) ? 'Use this session now (staff still looking)' : 'Use this session'}
        </button>
      )}
    </div>
  )
}
