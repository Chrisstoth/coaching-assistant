import { useEffect, useState } from 'react'
import { api } from '../api'
import StaffVoices from './StaffVoices'
import { threadNotes } from '../staffRoom'
import { weekLabel } from '../seasonTimeline'

// The staff's open points, pinned to what they are about. Reusable anywhere a
// page can say what it is looking at: a macrocycle, a swimmer, a week.

function pinLabel(note, swimmerNames) {
  const bits = []
  if (note.week_start) bits.push(`Week of ${weekLabel(note.week_start)}`)
  const names = (note.swimmer_ids || []).map(id => swimmerNames[id]).filter(Boolean)
  if (names.length) bits.push(names.join(', '))
  return bits.join(' · ')
}

export default function StaffNotesPanel({ macroId, swimmerId, meetId, refreshKey = 0, onActed, title = 'Staff notes' }) {
  const [notes, setNotes] = useState([])
  const [names, setNames] = useState({})
  const [showClosed, setShowClosed] = useState(false)

  const load = async () => {
    const rows = await api.getStaffNotes({
      macro_id: macroId || null,
      swimmer_id: swimmerId || null,
      meet_id: meetId || null,
      status: showClosed ? null : 'open',
      limit: 60,
    }).catch(() => null)
    if (Array.isArray(rows)) setNotes(rows)
  }

  useEffect(() => { load() }, [macroId, swimmerId, meetId, refreshKey, showClosed])

  useEffect(() => {
    api.getSwimmers().then(rows => {
      if (Array.isArray(rows)) setNames(Object.fromEntries(rows.map(s => [s.id, s.name])))
    }).catch(() => {})
  }, [])

  if (!macroId && !swimmerId && !meetId) return null
  const threads = threadNotes(notes)

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-pool-300 uppercase tracking-wide">{title}</h2>
        <button onClick={() => setShowClosed(v => !v)} className="text-xs text-pool-500">
          {showClosed ? 'Open only' : 'Show all'}
        </button>
      </div>

      {threads.length === 0 ? (
        <p className="text-xs text-pool-500 bg-pool-800 rounded-xl px-4 py-3 leading-relaxed">
          Nothing raised. The staff speak up when something in the plan catches their eye.
        </p>
      ) : (
        <div className="space-y-3">
          {threads.map(({ note, replies }) => {
            const pin = pinLabel(note, names)
            return (
              <div key={note.id} className="space-y-1">
                {pin && <p className="text-[10px] uppercase tracking-wide text-pool-500 px-1">{pin}</p>}
                <StaffVoices notes={[note, ...replies]} onChanged={load} onActed={onActed} />
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
