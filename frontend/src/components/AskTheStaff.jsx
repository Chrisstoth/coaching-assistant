import { useState } from 'react'
import { api } from '../api'
import StaffNotesPanel from './StaffNotesPanel'
import { StaffThinking } from './StaffVoices'
import { STAFF_ORDER, staffStyle } from '../staffRoom'

// Put a question to the coaching staff about whatever this page is showing.
//
// Drop it onto any page that can say what it concerns - a swimmer, a session,
// a meet. Pick who should answer, or leave it to whoever has something to say.

export default function AskTheStaff({ subject, subjectLabel, placeholder, trigger = 'coach_question', roles: defaultRoles = [], onActed }) {
  const [text, setText] = useState('')
  const [roles, setRoles] = useState(defaultRoles)
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [quiet, setQuiet] = useState(false)

  const toggle = (role) => setRoles(prev => (
    prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]
  ))

  const ask = async () => {
    const question = text.trim()
    if (!question || busy) return
    setBusy(true)
    setQuiet(false)
    try {
      const result = await api.conveneStaff({
        topic: subjectLabel ? `About ${subjectLabel}: ${question}` : question,
        coach_text: question,
        trigger,
        roles,
        ...subject,
      })
      if (!result.notes || result.notes.length === 0) setQuiet(true)
      setText('')
      setRefreshKey(k => k + 1)
    } catch (e) {
      alert('The staff could not meet just now: ' + e.message)
    }
    setBusy(false)
  }

  return (
    <div className="space-y-4">
      <section className="bg-pool-800 rounded-2xl p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold text-pool-100">Ask the staff</p>
          <p className="text-xs text-pool-400 mt-0.5 leading-relaxed">
            Choose who you want to hear from, or leave it open and whoever has something to say will answer.
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {STAFF_ORDER.map(role => {
            const style = staffStyle(role)
            const on = roles.includes(role)
            return (
              <button
                key={role}
                onClick={() => toggle(role)}
                aria-pressed={on}
                className={`text-[11px] rounded-full px-2.5 py-1 border ${on ? 'text-white' : 'text-pool-300 bg-pool-700 border-pool-600'}`}
                style={on ? { backgroundColor: style.colour, borderColor: style.colour } : undefined}
              >
                {style.title}
              </button>
            )
          })}
        </div>

        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask() } }}
          rows={2}
          placeholder={placeholder || 'What do you want the staff to look at?'}
          className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2.5 text-sm text-pool-100 placeholder-pool-500 focus:border-accent-500 focus:outline-none resize-none"
        />
        <button
          onClick={ask}
          disabled={busy || !text.trim()}
          className="w-full py-2.5 text-sm font-semibold bg-accent-600 rounded-xl disabled:opacity-40"
        >
          {busy ? 'Asking…' : roles.length ? `Ask the ${roles.map(r => staffStyle(r).title).join(' & ')}` : 'Ask the staff'}
        </button>

        {busy && <StaffThinking />}
        {quiet && !busy && (
          <p className="text-xs text-pool-500">Nobody had anything to add on that.</p>
        )}
      </section>

      <StaffNotesPanel
        swimmerId={subject.swimmer_ids && subject.swimmer_ids.length === 1 ? subject.swimmer_ids[0] : null}
        macroId={subject.macro_id || null}
        meetId={subject.meet_id || null}
        refreshKey={refreshKey}
        onActed={onActed}
        title="What the staff have raised"
      />
    </div>
  )
}
