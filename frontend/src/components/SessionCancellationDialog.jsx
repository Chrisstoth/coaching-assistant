import { useEffect, useState } from 'react'
import { api } from '../api'

const REASONS = [
  'Cancelled / session not held',
  'Public holiday',
  'Holiday / scheduled break',
  'Pool closure',
  'Coach unavailable',
  'Other',
]

function displayDate(value) {
  if (!value) return ''
  return new Date(`${value}T12:00:00`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  })
}

export default function SessionCancellationDialog({ session, onClose, onCancelled }) {
  const [choice, setChoice] = useState('')
  const [otherReason, setOtherReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const suggested = session?.suggested_reason
    setChoice(REASONS.includes(suggested) ? suggested : '')
    setOtherReason(suggested && !REASONS.includes(suggested) ? suggested : '')
    setSaving(false)
    setError('')
  }, [session])

  if (!session) return null

  const reason = choice === 'Other' ? otherReason.trim() : choice
  const title = session.title || session.label || 'this session'
  const time = session.time || session.start_time

  const confirm = async () => {
    if (!reason) {
      setError('Choose a reason so the cancellation is recorded correctly.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await api.cancelCalendarSession({
        date: session.date,
        pool_slot_id: session.slot_id || session.pool_slot_id || null,
        session_id: session.session_id || null,
        reason,
      })
      onCancelled?.(result, reason)
    } catch (err) {
      setError(err.message || 'Could not cancel the session')
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] bg-pool-950/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-3"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-session-title"
    >
      <div className="w-full max-w-md max-h-[calc(100dvh-1.5rem)] overflow-y-auto bg-pool-800 border border-red-800/60 rounded-2xl p-4 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-red-900/40 border border-red-700/50 text-red-300 flex items-center justify-center font-bold shrink-0">!</div>
          <div>
            <h2 id="cancel-session-title" className="font-semibold text-pool-100">Remove this session occurrence?</h2>
            <p className="text-sm text-pool-300 mt-1">
              {title} · {displayDate(session.date)}{time ? ` · ${time}` : ''}
            </p>
          </div>
        </div>

        <p className="text-xs text-pool-400 mt-3">
          This records this one session as cancelled and removes it from the home session desk. The recurring timetable slot will stay in place.
        </p>

        <fieldset className="mt-4 space-y-2">
          <legend className="text-xs font-semibold text-pool-300 mb-2">Why was it cancelled?</legend>
          <div className="grid grid-cols-2 gap-2">
            {REASONS.map(item => (
              <button
                type="button"
                key={item}
                onClick={() => { setChoice(item); setError('') }}
                className={`rounded-lg border px-2.5 py-2 text-xs text-left transition-colors ${choice === item ? 'bg-red-900/35 border-red-600 text-red-100' : 'bg-pool-700 border-pool-600 text-pool-300'}`}
              >
                {item}
              </button>
            ))}
          </div>
        </fieldset>

        {choice === 'Other' && (
          <input
            autoFocus
            value={otherReason}
            onChange={event => { setOtherReason(event.target.value); setError('') }}
            placeholder="Cancellation reason"
            className="w-full mt-2 bg-pool-700 border border-pool-600 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-red-500"
          />
        )}

        {error && <p className="text-xs text-red-300 mt-2">{error}</p>}

        <div className="grid grid-cols-2 gap-2 mt-4">
          <button type="button" onClick={onClose} disabled={saving} className="bg-pool-700 border border-pool-600 rounded-xl py-2.5 text-sm font-semibold text-pool-200 disabled:opacity-50">
            Keep session
          </button>
          <button type="button" onClick={confirm} disabled={saving} className="bg-red-700 hover:bg-red-600 rounded-xl py-2.5 text-sm font-semibold text-white disabled:opacity-50">
            {saving ? 'Recording…' : 'Confirm cancellation'}
          </button>
        </div>
      </div>
    </div>
  )
}
