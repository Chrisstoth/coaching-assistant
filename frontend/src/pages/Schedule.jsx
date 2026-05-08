import { useEffect, useState } from 'react'
import { api } from '../api'
import useLongPress from '../hooks/useLongPress'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const POOL_CONFIGS = [
  { value: 'full_pool',    label: 'Full pool' },
  { value: 'deep_end',    label: 'Deep end only' },
  { value: 'shallow_end', label: 'Shallow end only' },
]
const BLANK_FORM = { day_of_week: 0, time: '06:00', end_time: '', label: '', course: 'SCM', lanes: '', has_blocks: false, pool_config: 'full_pool', alternate_ends: false }


// ── Shared slot form fields ───────────────────────────────────────────────────

function SlotForm({ form, setForm }) {
  return (
    <div className="space-y-3">
      <select
        value={form.day_of_week}
        onChange={e => setForm({ ...form, day_of_week: parseInt(e.target.value) })}
        className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
      >
        {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
      </select>

      <div className="flex gap-2 items-center">
        <input
          type="time" value={form.time}
          onChange={e => setForm({ ...form, time: e.target.value })}
          className="flex-1 bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
        />
        <span className="text-pool-500 text-sm">to</span>
        <input
          type="time" value={form.end_time}
          onChange={e => setForm({ ...form, end_time: e.target.value })}
          className="flex-1 bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
        />
      </div>

      <div className="flex rounded-xl overflow-hidden border border-pool-600 text-sm font-semibold">
        {['SCM', 'LCM'].map(c => (
          <button
            key={c}
            onClick={() => setForm({ ...form, course: c })}
            className={`flex-1 py-2.5 transition-colors ${form.course === c ? 'bg-accent-600 text-white' : 'bg-pool-700 text-pool-400'}`}
          >
            {c === 'SCM' ? 'SC (25m)' : 'LC (50m)'}
          </button>
        ))}
      </div>

      <input
        placeholder="Label (auto-generated if blank)"
        value={form.label}
        onChange={e => setForm({ ...form, label: e.target.value })}
        className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
      />

      <div className="border-t border-pool-600 pt-3 space-y-3">
        <p className="text-xs text-pool-400 font-medium uppercase tracking-wide">Pool conditions</p>
        <div className="flex gap-2 items-center">
          <input
            type="number" min="1" max="20" placeholder="Lanes"
            value={form.lanes}
            onChange={e => setForm({ ...form, lanes: e.target.value })}
            className="w-24 bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
          />
          <span className="text-pool-400 text-sm flex-1">lanes</span>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox" checked={form.has_blocks}
              onChange={e => setForm({ ...form, has_blocks: e.target.checked })}
              className="w-4 h-4 rounded accent-accent-500"
            />
            <span>Blocks</span>
          </label>
        </div>
        <select
          value={form.pool_config}
          onChange={e => setForm({ ...form, pool_config: e.target.value, alternate_ends: false })}
          className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
        >
          {POOL_CONFIGS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        {(form.pool_config === 'deep_end' || form.pool_config === 'shallow_end') && (
          <label className="flex items-center justify-between cursor-pointer py-1">
            <div>
              <p className="text-sm">Alternate ends each week</p>
              <p className="text-xs text-pool-500">Flips between deep and shallow weekly</p>
            </div>
            <input
              type="checkbox" checked={form.alternate_ends}
              onChange={e => setForm({ ...form, alternate_ends: e.target.checked })}
              className="w-5 h-5 rounded accent-accent-500"
            />
          </label>
        )}
      </div>
    </div>
  )
}


// ── Edit bottom sheet ─────────────────────────────────────────────────────────

function EditSheet({ slot, swimmers, onClose, onSaved, onDeleted }) {
  const [form, setForm] = useState({
    day_of_week: slot.day_of_week,
    time: slot.time || '06:00',
    end_time: slot.end_time || '',
    label: slot.label || '',
    course: slot.course || 'SCM',
    lanes: slot.lanes != null ? String(slot.lanes) : '',
    has_blocks: slot.has_blocks || false,
    pool_config: slot.pool_config || 'full_pool',
    alternate_ends: slot.alternate_ends || false,
  })
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      const updated = await api.updateSlot(slot.id, {
        ...form,
        day_of_week: parseInt(form.day_of_week),
        lanes: form.lanes ? parseInt(form.lanes) : null,
      })
      onSaved(updated)
      onClose()
    } catch (e) {
      alert(`Error: ${e.message}`)
    }
    setSaving(false)
  }

  const doDelete = async () => {
    setDeleting(true)
    try {
      await api.deleteSlot(slot.id)
      onDeleted(slot.id)
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
        className="relative bg-pool-900 rounded-t-2xl max-h-[90vh] overflow-y-auto pb-8"
        onClick={e => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="sticky top-0 bg-pool-900 pt-3 pb-2 px-4 border-b border-pool-700 z-10">
          <div className="w-10 h-1 bg-pool-600 rounded-full mx-auto mb-3" />
          <div className="flex justify-between items-center">
            <p className="font-semibold text-sm">{slot.label}</p>
            <button onClick={onClose} className="text-pool-400 text-xl leading-none">×</button>
          </div>
          {swimmers?.length > 0 && (
            <p className="text-xs text-pool-500 mt-0.5">{swimmers.length} swimmer{swimmers.length !== 1 ? 's' : ''} assigned</p>
          )}
        </div>

        <div className="p-4 space-y-4">
          <SlotForm form={form} setForm={setForm} />

          {/* Swimmers list (read-only here — edit on swimmer profiles) */}
          {swimmers?.length > 0 && (
            <div className="border-t border-pool-700 pt-3 space-y-2">
              <p className="text-xs text-pool-400 font-medium uppercase tracking-wide">Assigned swimmers</p>
              <div className="flex flex-wrap gap-1.5">
                {swimmers.map(s => (
                  <span key={s.id} className="text-xs bg-pool-700 rounded-full px-3 py-1 text-pool-200">{s.name}</span>
                ))}
              </div>
              <p className="text-xs text-pool-500">Edit attendance on each swimmer's profile → Attendance tab.</p>
            </div>
          )}

          <button
            onClick={save}
            disabled={saving}
            className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-3 text-sm font-semibold"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>

          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="w-full bg-pool-800 border border-red-900 rounded-xl py-3 text-sm font-semibold text-red-400"
            >
              Delete Slot
            </button>
          ) : (
            <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-3 space-y-2">
              <p className="text-xs text-red-300 text-center">Remove this slot from the timetable?</p>
              <div className="flex gap-2">
                <button onClick={() => setConfirmDelete(false)} className="flex-1 bg-pool-700 rounded-lg py-2 text-sm font-semibold">
                  Cancel
                </button>
                <button
                  onClick={doDelete}
                  disabled={deleting}
                  className="flex-1 bg-red-900 disabled:opacity-40 rounded-lg py-2 text-sm font-semibold text-red-100"
                >
                  {deleting ? 'Removing…' : 'Confirm'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


// ── Slot card ─────────────────────────────────────────────────────────────────

function SlotCard({ slot, onLongPress, onTap }) {
  const handlers = useLongPress(onLongPress, onTap)
  return (
    <div
      {...handlers}
      className="bg-pool-800 rounded-xl p-4 cursor-pointer select-none active:opacity-70 transition-opacity"
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="font-medium text-sm">{slot.label}</p>
          <p className="text-pool-400 text-xs mt-0.5">
            {slot.time}{slot.end_time ? `–${slot.end_time}` : ''}
          </p>
          {(slot.course || slot.lanes || slot.has_blocks || slot.pool_config) && (
            <p className="text-pool-500 text-xs mt-0.5">
              {[
                slot.course,
                slot.lanes && `${slot.lanes} lanes`,
                slot.has_blocks && 'Blocks',
                slot.alternate_ends
                  ? 'Deep ↔ Shallow (alternating)'
                  : slot.pool_config && { full_pool: 'Full pool', deep_end: 'Deep end', shallow_end: 'Shallow end' }[slot.pool_config],
              ].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        <span className="text-pool-600 text-xs mt-0.5">hold to edit</span>
      </div>
    </div>
  )
}


// ── Page ─────────────────────────────────────────────────────────────────────

export default function Schedule() {
  const [slots, setSlots] = useState([])
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState(BLANK_FORM)
  const [saving, setSaving] = useState(false)
  const [editSheet, setEditSheet] = useState(null) // { slot, swimmers }
  const [slotSwimmers, setSlotSwimmers] = useState({})

  useEffect(() => {
    api.getSlots().then(setSlots)
  }, [])

  const addSlot = async () => {
    setSaving(true)
    const s = await api.createSlot({
      ...form,
      day_of_week: parseInt(form.day_of_week),
      lanes: form.lanes ? parseInt(form.lanes) : null,
      label: form.label || `${DAYS[form.day_of_week]} ${form.time}`,
    })
    setSlots(prev => [...prev, s].sort((a, b) => a.day_of_week - b.day_of_week || a.time.localeCompare(b.time)))
    setShowAdd(false)
    setForm(BLANK_FORM)
    setSaving(false)
  }

  const openEdit = async (slot) => {
    let swimmers = slotSwimmers[slot.id]
    if (!swimmers) {
      swimmers = await api.getSlotSwimmers(slot.id)
      setSlotSwimmers(prev => ({ ...prev, [slot.id]: swimmers }))
    }
    setEditSheet({ slot, swimmers })
  }

  const handleSaved = (updated) => {
    setSlots(prev =>
      prev.map(s => s.id === updated.id ? updated : s)
          .sort((a, b) => a.day_of_week - b.day_of_week || a.time.localeCompare(b.time))
    )
  }

  const handleDeleted = (slotId) => {
    setSlots(prev => prev.filter(s => s.id !== slotId))
  }

  const byDay = DAYS.map((day, i) => ({
    day,
    slots: slots.filter(s => s.day_of_week === i),
  })).filter(d => d.slots.length > 0)

  return (
    <div className="p-4 space-y-4">
      <div className="flex justify-between items-center pt-2">
        <div>
          <h1 className="text-xl font-bold">Pool Schedule</h1>
          <p className="text-xs text-pool-500 mt-0.5">Hold a slot to edit it</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="bg-accent-600 text-white rounded-full px-4 py-1.5 text-sm font-semibold"
        >
          {showAdd ? 'Cancel' : '+ Add slot'}
        </button>
      </div>

      {/* Add slot form */}
      {showAdd && (
        <div className="bg-pool-800 rounded-xl p-4 space-y-3">
          <SlotForm form={form} setForm={setForm} />
          <button
            onClick={addSlot}
            disabled={saving}
            className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-2.5 text-sm font-semibold"
          >
            {saving ? 'Adding…' : 'Add Session Slot'}
          </button>
        </div>
      )}

      {byDay.length === 0 ? (
        <div className="text-center py-12 space-y-2">
          <p className="text-pool-400">No sessions in the timetable yet.</p>
          <p className="text-pool-400 text-sm">Add your regular pool slots above, then set which swimmers attend each one.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {byDay.map(({ day, slots: daySlots }) => (
            <div key={day}>
              <h2 className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-2">{day}</h2>
              <div className="space-y-2">
                {daySlots.map(slot => (
                  <SlotCard
                    key={slot.id}
                    slot={slot}
                    onLongPress={() => openEdit(slot)}
                    onTap={() => openEdit(slot)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {editSheet && (
        <EditSheet
          slot={editSheet.slot}
          swimmers={editSheet.swimmers}
          onClose={() => setEditSheet(null)}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}
