import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'

const LEVEL_LABELS = { club: 'Club', regional: 'Regional', national: 'National', international: 'International' }
const LEVEL_COLORS = {
  club:          'bg-pool-700 text-pool-300',
  regional:      'bg-blue-900 text-blue-200',
  national:      'bg-purple-900 text-purple-200',
  international: 'bg-amber-900 text-amber-200',
}

function fmtDateRange(d1, d2) {
  if (!d1) return ''
  const fmt = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  if (!d2 || d1 === d2) return fmt(d1)
  const a = new Date(d1 + 'T00:00:00'), b = new Date(d2 + 'T00:00:00')
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) {
    return `${a.getDate()}–${b.getDate()} ${a.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`
  }
  return `${a.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${fmt(d2)}`
}

export default function Meets() {
  const [meets, setMeets] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', start_date: '', end_date: '', location: '', course: 'SCM', level: '', warm_up_time: '', notes: '' })
  const [saving, setSaving] = useState(false)

  useEffect(() => { api.getMeets().then(setMeets) }, [])

  const save = async () => {
    setSaving(true)
    try {
      const m = await api.createMeet({
        ...form,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        warm_up_time: form.warm_up_time || null,
        level: form.level || null,
      })
      setMeets((prev) => [...prev, m].sort((a, b) => (a.date || '').localeCompare(b.date || '')))
      setForm({ name: '', start_date: '', end_date: '', location: '', course: 'SCM', level: '', warm_up_time: '', notes: '' })
      setShowForm(false)
    } catch (e) { alert(typeof e === 'string' ? e : (e?.message || 'Error saving meet')) }
    setSaving(false)
  }

  const today = new Date().toISOString().slice(0, 10)
  const upcoming = meets.filter(m => !m.date || m.date >= today)
  const past     = meets.filter(m => m.date && m.date < today)

  return (
    <div className="p-4 space-y-4">
      <div className="flex justify-between items-center pt-2">
        <h1 className="text-xl font-bold">Meets</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="bg-accent-600 text-white rounded-full px-4 py-1.5 text-sm font-semibold"
        >
          {showForm ? 'Cancel' : '+ Add meet'}
        </button>
      </div>

      {showForm && (
        <div className="bg-pool-800 rounded-xl p-4 space-y-3">
          <input
            placeholder="Meet name *"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
          />
          <div className="flex gap-2">
            <div className="flex-1">
              <p className="text-xs text-pool-400 mb-1">Start date</p>
              <input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })}
                className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none" />
            </div>
            <div className="flex-1">
              <p className="text-xs text-pool-400 mb-1">End date</p>
              <input type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })}
                className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none" />
            </div>
          </div>
          <input
            placeholder="Location"
            value={form.location}
            onChange={e => setForm({ ...form, location: e.target.value })}
            className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
          />
          <div className="flex gap-2">
            <div className="flex rounded-xl overflow-hidden border border-pool-600 text-sm font-semibold flex-1">
              {['SCM', 'LCM'].map(c => (
                <button key={c} onClick={() => setForm({ ...form, course: c })}
                  className={`flex-1 py-2.5 ${form.course === c ? 'bg-accent-600 text-white' : 'bg-pool-700 text-pool-400'}`}>
                  {c === 'SCM' ? 'SC' : 'LC'}
                </button>
              ))}
            </div>
            <select value={form.level} onChange={e => setForm({ ...form, level: e.target.value })}
              className="flex-1 bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none">
              <option value="">Level</option>
              {Object.entries(LEVEL_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="flex gap-2 items-center">
            <input type="time" value={form.warm_up_time} onChange={e => setForm({ ...form, warm_up_time: e.target.value })}
              className="w-32 bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none" />
            <span className="text-pool-400 text-sm">warm-up start</span>
          </div>
          <textarea placeholder="Notes (optional)" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2}
            className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none resize-none" />
          <button onClick={save} disabled={saving || !form.name}
            className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-2.5 text-sm font-semibold">
            {saving ? 'Saving…' : 'Add Meet'}
          </button>
        </div>
      )}

      {meets.length === 0 && !showForm && (
        <p className="text-pool-400 text-sm text-center py-8">No meets added yet.</p>
      )}

      {upcoming.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold text-pool-400 uppercase tracking-wide">Upcoming</h2>
          {upcoming.map(m => <MeetCard key={m.id} meet={m} />)}
        </section>
      )}

      {past.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold text-pool-400 uppercase tracking-wide">Past</h2>
          {past.map(m => <MeetCard key={m.id} meet={m} />)}
        </section>
      )}
    </div>
  )
}


function MeetCard({ meet }) {
  const dateStr = fmtDateRange(meet.date, meet.date_to)
  const levelChip = meet.level ? LEVEL_COLORS[meet.level] || 'bg-pool-700 text-pool-300' : null

  return (
    <Link to={`/meets/${meet.id}`} className="block bg-pool-800 rounded-xl p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-sm truncate">{meet.name}</p>
          <p className="text-pool-400 text-xs mt-0.5">
            {dateStr}{meet.location ? ` · ${meet.location}` : ''}
          </p>
          <p className="text-pool-500 text-xs mt-0.5">
            {[meet.course, meet.swimmer_count > 0 && `${meet.swimmer_count} swimmers`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {levelChip && (
            <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${levelChip}`}>
              {LEVEL_LABELS[meet.level]}
            </span>
          )}
          <span className="text-pool-500 text-xs">›</span>
        </div>
      </div>
    </Link>
  )
}
