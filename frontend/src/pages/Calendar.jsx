import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import useLongPress from '../hooks/useLongPress'

function toIso(d) {
  return d.toISOString().slice(0, 10)
}

function getMonday(d = new Date()) {
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const mon = new Date(d)
  mon.setDate(d.getDate() + diff)
  mon.setHours(0, 0, 0, 0)
  return mon
}

function fmtWeekRange(monday) {
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  const opts = { day: 'numeric', month: 'short' }
  return `${monday.toLocaleDateString('en-GB', opts)} – ${sunday.toLocaleDateString('en-GB', { ...opts, year: 'numeric' })}`
}

const STATUS_STYLES = {
  completed: 'bg-emerald-900/40 border-emerald-700',
  active:    'bg-blue-900/40 border-blue-700',
  cancelled: 'bg-pool-900/60 border-pool-700 opacity-60',
  dismissed: 'bg-pool-900/40 border-pool-700 opacity-60',
  planned:   'bg-pool-800 border-pool-700',
  unlogged:  'bg-amber-900/30 border-amber-700',
}

const STATUS_CHIP = {
  completed: { label: 'Done',        cls: 'bg-emerald-800 text-emerald-200' },
  active:    { label: 'In progress', cls: 'bg-blue-800 text-blue-200' },
  cancelled: { label: 'Cancelled',   cls: 'bg-pool-700 text-pool-400' },
  dismissed: { label: 'Hidden',      cls: 'bg-pool-700 text-pool-500' },
  planned:   { label: 'Planned',     cls: 'bg-pool-700 text-pool-300' },
  unlogged:  { label: 'Not logged',  cls: 'bg-amber-800 text-amber-200' },
}

const CANCEL_REASONS = ['Pool unavailable', 'Public holiday', 'Coach unavailable', 'Low attendance', 'Weather', 'Other']
const POOL_CONFIG_LABELS = { full_pool: 'Full pool', deep_end: 'Deep end', shallow_end: 'Shallow end' }


// ── Action sheet ─────────────────────────────────────────────────────────────

function SessionActionSheet({ item, dayDate, onClose, onDeleted, onStart, onCancel }) {
  const navigate = useNavigate()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const isPast   = dayDate < toIso(new Date())
  const isFuture = dayDate > toIso(new Date())

  const doDelete = async () => {
    if (!item.session_id) { onClose(); return }
    setDeleting(true)
    try {
      await api.deleteSession(item.session_id)
      onDeleted(item.session_id)
      onClose()
    } catch (e) {
      alert(`Error: ${e.message}`)
      setDeleting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-pool-800 rounded-t-2xl p-4 space-y-2 pb-8 max-w-lg mx-auto w-full"
        onClick={e => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-pool-600 rounded-full mx-auto mb-4" />
        <p className="text-xs text-pool-400 text-center mb-3">
          {item.label} · {dayDate}
        </p>

        {/* Primary actions based on status */}
        {(item.status === 'completed' || item.status === 'unlogged') && item.session_id && (
          <button
            onClick={() => navigate(`/sessions/${item.session_id}/register`)}
            className="w-full bg-accent-600 rounded-xl py-3 font-semibold text-sm"
          >
            Open Register
          </button>
        )}

        {item.status === 'active' && item.session_id && (
          <button
            onClick={() => navigate(`/sessions/${item.session_id}`)}
            className="w-full bg-accent-600 rounded-xl py-3 font-semibold text-sm"
          >
            Continue Session
          </button>
        )}

        {(item.status === 'planned' || item.status === 'unlogged') && item.slot_id && (
          <button
            onClick={() => { onClose(); onStart() }}
            className="w-full bg-accent-600 rounded-xl py-3 font-semibold text-sm"
          >
            {isFuture ? 'Start Early' : isPast ? 'Log Session' : 'Start Session'}
          </button>
        )}

        {item.session_id && (
          <button
            onClick={() => navigate(`/sessions/${item.session_id}`)}
            className="w-full bg-pool-700 rounded-xl py-3 font-semibold text-sm"
          >
            View / Edit Session
          </button>
        )}

        <button
          onClick={() => {
            const dayLabel = new Date(dayDate).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
            const slotInfo = item.label ? ` (${item.label})` : ''
            navigate('/ai', { state: { initialMessage: `Plan a session for ${dayLabel}${slotInfo}` } })
          }}
          className="w-full bg-pool-700 border border-pool-600 rounded-xl py-3 font-semibold text-sm text-accent-300"
        >
          Plan with AI
        </button>

        {item.status !== 'cancelled' && item.slot_id && (
          <button
            onClick={() => { onClose(); onCancel() }}
            className="w-full bg-pool-700 border border-pool-600 rounded-xl py-3 font-semibold text-sm text-pool-300"
          >
            Cancel Session
          </button>
        )}

        {item.session_id && !confirmDelete && (
          <button
            onClick={() => setConfirmDelete(true)}
            className="w-full bg-pool-800 border border-red-900 rounded-xl py-3 font-semibold text-sm text-red-400"
          >
            Delete Session
          </button>
        )}

        {confirmDelete && (
          <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-3 space-y-2">
            <p className="text-xs text-red-300 text-center">Delete this session and all register data?</p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                className="flex-1 bg-pool-700 rounded-lg py-2 text-sm font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={doDelete}
                disabled={deleting}
                className="flex-1 bg-red-900 disabled:opacity-40 rounded-lg py-2 text-sm font-semibold text-red-100"
              >
                {deleting ? 'Deleting…' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        )}

        <button onClick={onClose} className="w-full py-3 text-sm text-pool-400">
          Cancel
        </button>
      </div>
    </div>
  )
}


// ── Session card ──────────────────────────────────────────────────────────────

function SessionCard({ item, dayDate, starting, onStart, onCancel, onOpen, onLongPress }) {
  const style = STATUS_STYLES[item.status] || STATUS_STYLES.planned
  const chip  = STATUS_CHIP[item.status]  || STATUS_CHIP.planned
  const isPast   = dayDate < toIso(new Date())
  const isFuture = dayDate > toIso(new Date())

  const poolConfigLabel = item.pool_config
    ? `${POOL_CONFIG_LABELS[item.pool_config] || item.pool_config}${item.alternate_ends ? ' (alternating)' : ''}`
    : null

  const poolMeta = [
    item.course,
    item.lanes && `${item.lanes} lanes`,
    item.has_blocks && 'Blocks',
    poolConfigLabel,
  ].filter(Boolean).join(' · ')

  const longPressHandlers = useLongPress(
    onLongPress,
    () => {},  // tap on the card itself does nothing — buttons handle navigation
  )

  return (
    <div
      {...longPressHandlers}
      className={`rounded-xl border p-4 space-y-2 ${style} select-none`}
    >
      {/* Top row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-sm truncate">{item.label}</p>
          <p className="text-pool-400 text-xs mt-0.5">
            {item.time}{item.end_time ? `–${item.end_time}` : ''}
          </p>
          {poolMeta && <p className="text-pool-500 text-xs mt-0.5">{poolMeta}</p>}
        </div>
        <span className={`shrink-0 text-xs rounded-full px-2.5 py-1 font-medium ${chip.cls}`}>
          {chip.label}
        </span>
      </div>

      {item.title && item.status !== 'cancelled' && (
        <p className="text-pool-300 text-xs">{item.title}</p>
      )}
      {item.status === 'cancelled' && item.cancel_reason && (
        <p className="text-pool-500 text-xs italic">{item.cancel_reason}</p>
      )}
      {item.entry_count != null && (
        <p className="text-pool-400 text-xs">{item.entry_count} attended</p>
      )}

      {/* Action buttons */}
      <div className="flex gap-3 pt-1">
        {item.status === 'completed' && (
          <button onClick={onOpen} className="text-xs text-accent-400 font-medium">
            View session →
          </button>
        )}
        {item.status === 'active' && (
          <button onClick={onOpen} className="text-xs text-accent-400 font-medium">
            Continue →
          </button>
        )}
        {(item.status === 'planned' || item.status === 'unlogged') && item.slot_id && (
          <>
            <button
              onClick={onStart}
              disabled={starting}
              className="text-xs bg-accent-600 disabled:opacity-40 rounded-lg px-3 py-1.5 font-medium"
            >
              {starting ? '…' : isFuture ? 'Start early' : isPast ? 'Log session' : 'Start'}
            </button>
            <button onClick={onCancel} className="text-xs text-red-400 font-medium">
              Cancel
            </button>
          </>
        )}
        {item.status === 'planned' && !item.slot_id && (
          <button onClick={onOpen} className="text-xs text-accent-400 font-medium">
            Open →
          </button>
        )}
      </div>
    </div>
  )
}


// ── Page ─────────────────────────────────────────────────────────────────────

export default function Calendar() {
  const navigate = useNavigate()
  const [monday, setMonday] = useState(getMonday())
  const [days, setDays] = useState([])
  const [loading, setLoading] = useState(false)
  const [cancelTarget, setCancelTarget] = useState(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelCustom, setCancelCustom] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [starting, setStarting] = useState(null)
  const [activeSheet, setActiveSheet] = useState(null) // { item, dayDate }

  const load = useCallback(async (mon) => {
    setLoading(true)
    try {
      const data = await api.getCalendar(toIso(mon))
      setDays(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(monday) }, [monday, load])

  const prevWeek = () => setMonday(d => { const n = new Date(d); n.setDate(d.getDate() - 7); return n })
  const nextWeek = () => setMonday(d => { const n = new Date(d); n.setDate(d.getDate() + 7); return n })
  const goToday  = () => setMonday(getMonday())

  const isCurrentWeek = toIso(monday) === toIso(getMonday())
  const todayIso = toIso(new Date())

  const handleStart = async (item) => {
    setStarting(item.slot_id)
    try {
      const session = await api.startCalendarSession({ pool_slot_id: item.slot_id, date: item.date || todayIso })
      navigate(`/sessions/${session.id}`)
    } finally {
      setStarting(null)
    }
  }

  const openCancel = (item, dayDate) => {
    setCancelTarget({ slotId: item.slot_id, sessionId: item.session_id, date: dayDate, label: item.label })
    setCancelReason('')
    setCancelCustom('')
  }

  const submitCancel = async () => {
    const reason = cancelReason === 'Other' ? cancelCustom : cancelReason
    if (!reason) return
    setCancelling(true)
    try {
      await api.cancelCalendarSession({
        date: cancelTarget.date,
        reason,
        pool_slot_id: cancelTarget.slotId,
        session_id: cancelTarget.sessionId,
      })
      setCancelTarget(null)
      load(monday)
    } finally {
      setCancelling(false)
    }
  }

  const handleDeleted = (sessionId) => {
    setDays(prev => prev.map(day => ({
      ...day,
      items: day.items.filter(item => item.session_id !== sessionId),
    })))
  }

  const activeDays = days.filter(d => d.items.length > 0)

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between pt-2">
        <h1 className="text-xl font-bold">Calendar</h1>
        {!isCurrentWeek && (
          <button onClick={goToday} className="text-xs text-accent-400 font-semibold">
            Today
          </button>
        )}
      </div>

      {/* Week navigation */}
      <div className="flex items-center justify-between bg-pool-800 rounded-xl px-4 py-3">
        <button onClick={prevWeek} className="text-pool-300 text-lg px-2">‹</button>
        <span className="text-sm font-medium text-pool-200">{fmtWeekRange(monday)}</span>
        <button onClick={nextWeek} className="text-pool-300 text-lg px-2">›</button>
      </div>

      {loading && <p className="text-center text-pool-400 text-sm py-8">Loading…</p>}

      {!loading && activeDays.length === 0 && (
        <div className="text-center py-12 space-y-1">
          <p className="text-pool-400">No sessions this week.</p>
          <p className="text-pool-500 text-sm">Add pool slots in Schedule to see them here.</p>
        </div>
      )}

      {/* Days */}
      {!loading && activeDays.map((day) => {
        const isToday = day.date === todayIso
        return (
          <div key={day.date}>
            <h2 className={`text-xs font-semibold uppercase tracking-wide mb-2 ${isToday ? 'text-accent-400' : 'text-pool-400'}`}>
              {day.day_name}{isToday ? ' · Today' : ''}
            </h2>
            <div className="space-y-2">
              {day.items.map((item, idx) => (
                <SessionCard
                  key={`${item.slot_id ?? 'manual'}-${item.session_id ?? idx}`}
                  item={item}
                  dayDate={day.date}
                  starting={starting === item.slot_id}
                  onStart={() => handleStart({ ...item, date: day.date })}
                  onCancel={() => openCancel(item, day.date)}
                  onOpen={() => item.session_id && navigate(`/sessions/${item.session_id}`)}
                  onLongPress={() => setActiveSheet({ item, dayDate: day.date })}
                />
              ))}
            </div>
          </div>
        )
      })}

      {/* Cancel modal */}
      {cancelTarget && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end">
          <div className="w-full max-w-lg mx-auto bg-pool-800 rounded-t-2xl p-5 space-y-4">
            <div className="flex justify-between items-start">
              <div>
                <p className="font-semibold">Cancel session</p>
                <p className="text-pool-400 text-sm mt-0.5">{cancelTarget.label} · {cancelTarget.date}</p>
              </div>
              <button onClick={() => setCancelTarget(null)} className="text-pool-400 text-xl">×</button>
            </div>
            <p className="text-sm text-pool-300">Why is this session cancelled?</p>
            <div className="flex flex-wrap gap-2">
              {CANCEL_REASONS.map(r => (
                <button
                  key={r}
                  onClick={() => setCancelReason(r)}
                  className={`text-sm rounded-full px-3 py-1.5 border ${cancelReason === r ? 'bg-accent-600 border-accent-500 text-white' : 'bg-pool-700 border-pool-600 text-pool-200'}`}
                >
                  {r}
                </button>
              ))}
            </div>
            {cancelReason === 'Other' && (
              <input
                placeholder="Describe reason…"
                value={cancelCustom}
                onChange={e => setCancelCustom(e.target.value)}
                className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
              />
            )}
            <button
              onClick={submitCancel}
              disabled={cancelling || !cancelReason || (cancelReason === 'Other' && !cancelCustom)}
              className="w-full bg-red-700 disabled:opacity-40 rounded-xl py-3 text-sm font-semibold"
            >
              {cancelling ? 'Cancelling…' : 'Confirm cancellation'}
            </button>
          </div>
        </div>
      )}

      {/* Long-press action sheet */}
      {activeSheet && (
        <SessionActionSheet
          item={activeSheet.item}
          dayDate={activeSheet.dayDate}
          onClose={() => setActiveSheet(null)}
          onDeleted={handleDeleted}
          onStart={() => handleStart({ ...activeSheet.item, date: activeSheet.dayDate })}
          onCancel={() => openCancel(activeSheet.item, activeSheet.dayDate)}
        />
      )}
    </div>
  )
}
