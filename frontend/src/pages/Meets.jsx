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
  const [showImport, setShowImport] = useState(false)
  const [form, setForm] = useState({ name: '', start_date: '', end_date: '', location: '', course: 'SCM', level: '', warm_up_time: '', notes: '' })
  const [saving, setSaving] = useState(false)

  const loadMeets = () => api.getMeets().then(setMeets)
  useEffect(() => { loadMeets() }, [])

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
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setShowImport(!showImport); setShowForm(false) }}
            className="border border-pool-600 text-pool-200 rounded-full px-3 py-1.5 text-xs font-semibold"
          >
            {showImport ? 'Close import' : 'Import Excel'}
          </button>
          <button
            onClick={() => { setShowForm(!showForm); setShowImport(false) }}
            className="bg-accent-600 text-white rounded-full px-3 py-1.5 text-xs font-semibold"
          >
            {showForm ? 'Cancel' : '+ Add meet'}
          </button>
        </div>
      </div>

      {showImport && <MeetExcelImport onImported={loadMeets} onDone={() => setShowImport(false)} />}

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


function MeetExcelImport({ onImported, onDone }) {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [selectedRows, setSelectedRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  const review = async () => {
    if (!file) return
    setLoading(true)
    setError('')
    try {
      const data = await api.previewMeetExcelImport(file)
      setPreview(data)
      setSelectedRows(data.rows.filter(row => row.can_import).map(row => row.row_number))
    } catch (e) {
      setError(e?.message || 'Could not read that workbook')
    } finally {
      setLoading(false)
    }
  }

  const confirm = async () => {
    if (!preview || selectedRows.length === 0) return
    setSaving(true)
    setError('')
    try {
      const rows = preview.rows
        .filter(row => row.can_import && selectedRows.includes(row.row_number))
        .map(row => ({
          row_number: row.row_number,
          name: row.name,
          date: row.date,
          date_to: row.date_to,
          location: row.location,
          course: row.course,
          level: row.level,
          warm_up_time: row.warm_up_time,
          notes: row.notes,
          include: true,
        }))
      const saved = await api.confirmMeetExcelImport(rows)
      setResult(saved)
      await onImported()
    } catch (e) {
      setError(e?.message || 'Could not import the galas')
    } finally {
      setSaving(false)
    }
  }

  const toggleRow = (rowNumber) => {
    setSelectedRows(current => current.includes(rowNumber)
      ? current.filter(value => value !== rowNumber)
      : [...current, rowNumber])
  }

  if (result) {
    return (
      <div className="bg-emerald-900/20 border border-emerald-700/50 rounded-xl p-4 space-y-3">
        <p className="font-semibold text-emerald-300">{result.created_count} gala{result.created_count === 1 ? '' : 's'} imported</p>
        {result.skipped_count > 0 && <p className="text-xs text-pool-400">{result.skipped_count} duplicate or invalid row{result.skipped_count === 1 ? '' : 's'} skipped.</p>}
        <button onClick={onDone} className="w-full bg-accent-600 rounded-xl py-2.5 text-sm font-semibold">Done</button>
      </div>
    )
  }

  return (
    <div className="bg-pool-800 rounded-xl p-4 space-y-3">
      <div>
        <p className="text-sm font-semibold">Import gala calendar</p>
        <p className="text-xs text-pool-400 mt-1">Uses Date Start, Date End, Competition and Venue. Nothing is saved until you review and confirm.</p>
      </div>

      {!preview ? (
        <>
          <label className="block rounded-xl border-2 border-dashed border-pool-600 p-4 text-center cursor-pointer">
            <input
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={event => { setFile(event.target.files[0] || null); setError('') }}
            />
            <p className="text-sm text-pool-300">{file?.name || 'Tap to select the Excel workbook'}</p>
            <p className="text-[11px] text-pool-500 mt-1">.xlsx · first worksheet</p>
          </label>
          <button onClick={review} disabled={!file || loading}
            className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-2.5 text-sm font-semibold">
            {loading ? 'Reading workbook…' : 'Review galas'}
          </button>
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-pool-900/60 rounded-lg p-2"><p className="text-lg font-bold">{preview.summary.ready}</p><p className="text-[10px] text-pool-500">Ready</p></div>
            <div className="bg-pool-900/60 rounded-lg p-2"><p className="text-lg font-bold">{preview.summary.duplicates}</p><p className="text-[10px] text-pool-500">Duplicates</p></div>
            <div className="bg-pool-900/60 rounded-lg p-2"><p className="text-lg font-bold">{preview.summary.invalid}</p><p className="text-[10px] text-pool-500">Needs fixing</p></div>
          </div>
          <div className="max-h-[52vh] overflow-y-auto space-y-2 pr-1">
            {preview.rows.map(row => {
              const selected = selectedRows.includes(row.row_number)
              return (
                <label key={row.row_number} className={`flex items-start gap-3 rounded-xl border p-3 ${row.can_import ? 'border-pool-600 bg-pool-900/35 cursor-pointer' : 'border-pool-700 bg-pool-900/20 opacity-70'}`}>
                  <input type="checkbox" className="mt-1" checked={selected} disabled={!row.can_import} onChange={() => toggleRow(row.row_number)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium leading-snug">{row.name || `Row ${row.row_number}`}</p>
                      {row.course && <span className="shrink-0 text-[10px] bg-pool-700 rounded-full px-2 py-0.5 text-pool-300">{row.course}</span>}
                    </div>
                    <p className="text-xs text-pool-400 mt-1">{row.date ? fmtDateRange(row.date, row.date_to) : 'Invalid date'}{row.location ? ` · ${row.location}` : ''}</p>
                    {[...(row.errors || []), ...(row.warnings || [])].map((message, index) => (
                      <p key={index} className="text-[11px] text-amber-300 mt-1">{message}</p>
                    ))}
                  </div>
                </label>
              )
            })}
          </div>
          <div className="flex gap-2">
            <button onClick={() => { setPreview(null); setSelectedRows([]) }} className="flex-1 border border-pool-600 rounded-xl py-2.5 text-sm font-semibold">Choose another</button>
            <button onClick={confirm} disabled={saving || selectedRows.length === 0}
              className="flex-[1.4] bg-accent-600 disabled:opacity-40 rounded-xl py-2.5 text-sm font-semibold">
              {saving ? 'Importing…' : `Import ${selectedRows.length} gala${selectedRows.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
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
