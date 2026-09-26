import { useState } from 'react'
import { api } from '../api'
import { decisionSummary, staffStyle, threadNotes } from '../staffRoom'

// The coaching staff speaking. Each note is a named voice - the physiologist,
// the analyst - with what they raised, any question for the coach, and a reply
// box so the coach can answer that specialist directly.

// What a specialist proposes to change, shown in full before anything happens.
// Approving it runs the change and hands the consequence to a colleague.
function ActionPreview({ note, onChanged, onActed }) {
  const [busy, setBusy] = useState(false)
  const action = note.proposed_action
  if (!action) return null

  const approve = async () => {
    setBusy(true)
    try {
      await api.applyStaffAction(note.id)
      if (onActed) onActed()
      onChanged()
    } catch (e) {
      alert('Could not do that: ' + e.message)
    }
    setBusy(false)
  }

  const decline = async () => {
    setBusy(true)
    try {
      await api.declineStaffAction(note.id)
      onChanged()
    } catch (e) {
      alert('Could not update: ' + e.message)
    }
    setBusy(false)
  }

  const status = note.action_status
  return (
    <div className={`rounded-xl px-3 py-2 space-y-1.5 border ${
      status === 'applied' ? 'border-green-700/60 bg-green-950/30'
        : status === 'failed' ? 'border-red-700/60 bg-red-950/30'
        : status === 'declined' ? 'border-pool-700 bg-pool-900/40 opacity-70'
        : 'border-accent-700/60 bg-accent-900/25'
    }`}>
      <ul className="space-y-0.5">
        {(action.summary || []).map((line, i) => (
          <li key={i} className={`text-xs leading-relaxed ${i === 0 ? 'text-pool-100 font-medium' : 'text-pool-300'}`}>
            {line}
          </li>
        ))}
      </ul>

      {status === 'proposed' && (
        <div className="flex gap-2 pt-0.5">
          <button onClick={approve} disabled={busy}
            className="flex-1 py-2 text-xs font-semibold bg-accent-600 rounded-lg disabled:opacity-40">
            {busy ? 'Working…' : action.label || 'Do it'}
          </button>
          <button onClick={decline} disabled={busy}
            className="px-3 py-2 text-xs bg-pool-700 rounded-lg disabled:opacity-40">
            Not now
          </button>
        </div>
      )}
      {status === 'applied' && <p className="text-xs text-green-300">Done - {note.action_result}</p>}
      {status === 'failed' && <p className="text-xs text-red-300">Couldn't do it: {note.action_result}</p>}
      {status === 'declined' && <p className="text-xs text-pool-500">You said not now.</p>}
    </div>
  )
}

// Two of the staff pull in different directions. Nobody settles it but the
// coach: each side is laid out with its reason, and the call made here becomes
// the plan of action the staff work to.
function DecisionCard({ note, replies, onChanged, onActed, onWorkIn }) {
  const style = staffStyle('chair')
  const [own, setOwn] = useState('')
  const [writing, setWriting] = useState(false)
  const [busy, setBusy] = useState(false)
  const open = note.status === 'open'

  const decide = async (choice) => {
    if (!choice && !own.trim()) return
    setBusy(true)
    try {
      await api.decideStaffNote(note.id, { choice, text: choice ? null : own.trim() })
      setOwn('')
      setWriting(false)
      if (onActed) onActed()
      onChanged()
    } catch (e) {
      alert('Could not record that: ' + e.message)
    }
    setBusy(false)
  }

  return (
    <div className={`rounded-2xl border-2 px-3.5 py-3 space-y-2 bg-pool-800 ${note.status === 'dismissed' ? 'opacity-60' : ''}`}
      style={{ borderColor: `${style.colour}99` }}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 text-black"
          style={{ backgroundColor: style.colour }}>
          Your call
        </span>
        <span className="text-[11px] text-pool-400">The staff disagree</span>
      </div>
      <p className="text-sm font-medium text-pool-100 leading-relaxed">{note.message}</p>

      <div className="space-y-1.5">
        {(note.options || []).map(option => {
          const side = staffStyle(option.role)
          return (
            <div key={option.role} className="rounded-xl bg-pool-900/60 px-3 py-2 border-l-4"
              style={{ borderColor: side.colour }}>
              <p className="text-[11px] font-semibold" style={{ color: side.colour }}>{option.title || side.title}</p>
              <p className="text-sm text-pool-100 leading-relaxed">{option.position}</p>
              {option.because && <p className="text-xs text-pool-400 leading-relaxed">Because {option.because}</p>}
              {open && (
                <button onClick={() => decide(option.role)} disabled={busy}
                  className="mt-1.5 w-full py-2 text-xs font-semibold rounded-lg bg-pool-700 border border-pool-600 disabled:opacity-40">
                  {busy ? 'Recording…' : `Go with the ${(option.title || side.title).toLowerCase()}`}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {open && (
        writing ? (
          <div className="flex gap-2 items-end">
            <textarea value={own} onChange={e => setOwn(e.target.value)} rows={2} autoFocus
              placeholder="What do you want to do instead?"
              className="flex-1 bg-pool-700 border border-pool-600 rounded-xl px-3 py-2 text-sm text-pool-100 placeholder-pool-500 focus:border-accent-500 focus:outline-none resize-none" />
            <button onClick={() => decide(null)} disabled={busy || !own.trim()}
              className="bg-accent-600 disabled:opacity-40 rounded-xl px-3 py-2 text-xs font-semibold text-white shrink-0">
              {busy ? '…' : 'Decide'}
            </button>
          </div>
        ) : (
          <button onClick={() => setWriting(true)} className="text-xs text-accent-400">Something else…</button>
        )
      )}

      {note.decision && (
        <p className="text-sm text-green-300 leading-relaxed">{decisionSummary(note)}</p>
      )}
      {note.decision && onWorkIn && (
        <button onClick={() => onWorkIn(note)} className="text-xs text-accent-400">Work this in</button>
      )}

      {replies.map(child => (
        <div key={child.id} className="pl-3 border-l-2" style={{ borderColor: `${staffStyle(child.role).colour}88` }}>
          <p className="text-[11px] font-semibold text-pool-300">{child.title}</p>
          <p className="text-sm text-pool-200 leading-relaxed">{child.message}</p>
          {child.question && <p className="text-sm text-accent-300">{child.question}</p>}
          <div className="mt-1"><ActionPreview note={child} onChanged={onChanged} onActed={onActed} /></div>
        </div>
      ))}
    </div>
  )
}

function VoiceCard({ note, replies, onChanged, onActed, onWorkIn, compact }) {
  const style = staffStyle(note.role)
  const [replying, setReplying] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      await api.replyToStaffNote(note.id, text.trim())
      setText('')
      setReplying(false)
      onChanged()
    } catch (e) {
      alert('Could not send that: ' + e.message)
    }
    setBusy(false)
  }

  const setStatus = async (status) => {
    try {
      await api.updateStaffNote(note.id, status)
      onChanged()
    } catch (e) {
      alert('Could not update: ' + e.message)
    }
  }

  const closed = note.status !== 'open'

  return (
    <div className={`rounded-2xl border px-3.5 py-2.5 space-y-1.5 bg-pool-800 ${closed ? 'opacity-60' : ''}`}
      style={{ borderColor: `${style.colour}66` }}>
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
          style={{ backgroundColor: style.colour }} aria-hidden="true">
          {style.initials}
        </span>
        <span className="text-xs font-semibold text-pool-100">{note.title}</span>
        {note.addressed_to && note.addressed_to !== 'coach' && (
          <span className="text-[10px] text-pool-500">answering {staffStyle(note.addressed_to).title}</span>
        )}
        {note.kind === 'concern' && (
          <span className="text-[10px] font-semibold text-yellow-300 ml-auto">Concern</span>
        )}
        {closed && <span className="text-[10px] text-pool-500 ml-auto capitalize">{note.status}</span>}
      </div>

      <p className="text-sm text-pool-200 leading-relaxed">{note.message}</p>
      {note.question && (
        <p className="text-sm text-accent-300 leading-relaxed">{note.question}</p>
      )}

      <ActionPreview note={note} onChanged={onChanged} onActed={onActed} />

      {note.coach_reply && (
        <p className="text-xs text-pool-400 border-l-2 border-pool-600 pl-2">You: {note.coach_reply}</p>
      )}

      {replies.map(child => (
        <div key={child.id} className="pl-3 border-l-2" style={{ borderColor: `${staffStyle(child.role).colour}88` }}>
          <p className="text-[11px] font-semibold text-pool-300">{child.title}</p>
          <p className="text-sm text-pool-200 leading-relaxed">{child.message}</p>
          {child.question && <p className="text-sm text-accent-300">{child.question}</p>}
          <div className="mt-1"><ActionPreview note={child} onChanged={onChanged} onActed={onActed} /></div>
        </div>
      ))}

      {!closed && !compact && (
        replying ? (
          <div className="flex gap-2 items-end pt-1">
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
              rows={1}
              autoFocus
              placeholder={`Reply to the ${note.title.toLowerCase()}…`}
              className="flex-1 bg-pool-700 border border-pool-600 rounded-xl px-3 py-2 text-sm text-pool-100 placeholder-pool-500 focus:border-accent-500 focus:outline-none resize-none"
            />
            <button onClick={send} disabled={busy || !text.trim()}
              className="bg-accent-600 disabled:opacity-40 rounded-xl px-3 py-2 text-xs font-semibold text-white shrink-0">
              {busy ? '…' : 'Send'}
            </button>
          </div>
        ) : (
          <div className="flex gap-4 pt-0.5">
            {onWorkIn && (
              <button onClick={async () => { await onWorkIn(note); setStatus('resolved') }}
                className="text-xs font-semibold text-accent-300">Work this in</button>
            )}
            <button onClick={() => setReplying(true)} className="text-xs text-accent-400">Reply</button>
            <button onClick={() => setStatus('resolved')} className="text-xs text-pool-400">Done</button>
            <button onClick={() => setStatus('dismissed')} className="text-xs text-pool-600">Dismiss</button>
          </div>
        )
      )}
    </div>
  )
}

// Renders top-level notes with their replies nested beneath them.
// ``onWorkIn`` (optional) lets a page fold a staff point straight into the
// draft it is building - the session planner uses it.
export default function StaffVoices({ notes, onChanged, onActed, onWorkIn, compact = false }) {
  const threads = threadNotes(notes || [])
  if (!threads.length) return null
  return (
    <div className="space-y-2">
      {threads.map(({ note, replies }) => (
        note.kind === 'decision' ? (
          <DecisionCard key={note.id} note={note} replies={replies} onChanged={onChanged}
            onActed={onActed} onWorkIn={onWorkIn} />
        ) : (
          <VoiceCard key={note.id} note={note} replies={replies} onChanged={onChanged}
            onActed={onActed} onWorkIn={onWorkIn} compact={compact} />
        )
      ))}
    </div>
  )
}

export function StaffThinking() {
  return (
    <div className="flex items-center gap-2 text-xs text-pool-500 px-1">
      <span className="flex gap-0.5" aria-hidden="true">
        <span className="w-1.5 h-1.5 rounded-full bg-pool-500 animate-pulse" />
        <span className="w-1.5 h-1.5 rounded-full bg-pool-500 animate-pulse [animation-delay:150ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-pool-500 animate-pulse [animation-delay:300ms]" />
      </span>
      The staff are talking it over…
    </div>
  )
}
