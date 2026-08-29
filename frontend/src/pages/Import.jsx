import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { SWIM_EVENTS } from '../swimEvents'
import { useSessionPresentation } from '../components/SessionPresentationProvider'
import { calendarDayLabel, localDateIso, mondayFor } from '../calendarDates'

export default function Import() {
  const { energy } = useSessionPresentation()
  const [searchParams] = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const [tab, setTab] = useState(['combined', 'excel', 'photo', 'profiles'].includes(requestedTab) ? requestedTab : 'combined')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [plannedSessions, setPlannedSessions] = useState([])

  useEffect(() => {
    if (tab === 'photo') {
      // Fetch upcoming planned sessions
      api.getCalendar().then(days => {
        setPlannedSessions(days.flatMap(day => (day.items || [])
          .filter(item => item.session_id && !['cancelled', 'dismissed'].includes(item.status))
          .map(item => ({ ...item, id: item.session_id, date: day.date }))))
      })
    }
  }, [tab])

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold pt-2">Import Data</h1>

      {/* Tab selector */}
      <div className="grid grid-cols-2 sm:grid-cols-4 bg-pool-800 rounded-xl p-1 gap-1">
        {[
          { id: 'combined', label: 'Squad + Times' },
          { id: 'excel', label: 'Sessions' },
          { id: 'photo', label: 'Photo' },
          { id: 'profiles', label: 'Profiles' },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); setResult(null) }}
            className={`py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.id ? 'bg-accent-600 text-white' : 'text-pool-400'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'combined' && <CombinedImport setResult={setResult} setLoading={setLoading} loading={loading} />}
      {tab === 'excel' && <ExcelImport setResult={setResult} setLoading={setLoading} loading={loading} importContext={{
        date: searchParams.get('date'),
        slotId: searchParams.get('slot'),
        sessionId: searchParams.get('session'),
      }} />}
      {tab === 'photo' && <PhotoImport setResult={setResult} setLoading={setLoading} loading={loading} plannedSessions={plannedSessions} />}
      {tab === 'profiles' && <FoundationProfileImport setResult={setResult} />}

      {result && (
        <div className="bg-pool-800 rounded-xl p-4 text-sm space-y-1">
          <p className="font-semibold text-accent-400">Import Result</p>
          <pre className="text-pool-300 text-xs whitespace-pre-wrap">{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}


function FoundationProfileImport({ setResult }) {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [selected, setSelected] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const review = async () => {
    if (!file) return
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const parsed = JSON.parse(await file.text())
      const data = await api.previewFoundationProfileImport(parsed)
      setPreview(data)
      setSelected(data.rows.filter(row => row.can_import).map(row => row.index))
    } catch (e) {
      setError(e instanceof SyntaxError ? 'That file is not valid JSON.' : (e?.message || 'Could not review the profile package.'))
    } finally {
      setLoading(false)
    }
  }

  const confirm = async () => {
    if (!preview || selected.length === 0) return
    setSaving(true)
    setError('')
    setResult(null)
    try {
      const profiles = preview.rows
        .filter(row => selected.includes(row.index) && row.can_import)
        .map(row => ({
          swimmer_name: row.matched_swimmer_name || row.swimmer_name,
          review_status: 'coach_confirmed',
          physical: row.physical,
          psychological: row.psychological,
          notes: row.notes,
        }))
      const result = await api.confirmFoundationProfileImport({
        schema_version: preview.schema_version,
        source: preview.source,
        generated_at: preview.generated_at,
        profiles,
      })
      setResult(result)
      setPreview(null)
      setFile(null)
      setSelected([])
    } catch (e) {
      setError(e?.message || 'Could not import the profile package.')
    } finally {
      setSaving(false)
    }
  }

  const toggle = (index) => {
    setSelected(current => current.includes(index)
      ? current.filter(value => value !== index)
      : [...current, index])
  }

  return (
    <div className="space-y-3">
      <div className="bg-accent-900/20 border border-accent-700/40 rounded-xl p-3">
        <p className="text-sm font-semibold text-accent-300">Profile Builder import</p>
        <p className="text-xs text-pool-400 mt-1 leading-relaxed">
          Upload the JSON produced by the dedicated $lanewatch-profile-builder agent. LaneWatch fills blank foundation fields only; existing confirmed information is never overwritten.
        </p>
        <p className="text-[10px] text-green-300 mt-2">No in-app AI call or token cost.</p>
      </div>

      {!preview ? (
        <>
          <label className="block bg-pool-800 rounded-xl p-4 text-center cursor-pointer border-2 border-dashed border-pool-600 hover:border-accent-500 transition-colors">
            <input
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={event => { setFile(event.target.files[0] || null); setError('') }}
            />
            <p className="text-sm text-pool-200">{file?.name || 'Tap to select foundation-profiles.json'}</p>
            <p className="text-[11px] text-pool-500 mt-1">Canonical Profile Builder JSON</p>
          </label>
          <button onClick={review} disabled={!file || loading}
            className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-3 text-sm font-semibold">
            {loading ? 'Checking profiles…' : 'Review profile matches'}
          </button>
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-pool-800 rounded-lg p-2"><p className="text-lg font-bold">{preview.summary.ready}</p><p className="text-[10px] text-pool-500">Ready</p></div>
            <div className="bg-pool-800 rounded-lg p-2"><p className="text-lg font-bold">{preview.summary.fields_to_add}</p><p className="text-[10px] text-pool-500">Fields to add</p></div>
            <div className="bg-pool-800 rounded-lg p-2"><p className="text-lg font-bold">{preview.summary.with_conflicts}</p><p className="text-[10px] text-pool-500">With conflicts</p></div>
          </div>

          <div className="max-h-[52vh] overflow-y-auto space-y-2 pr-1">
            {preview.rows.map(row => (
              <label key={row.index} className={`flex items-start gap-3 rounded-xl border p-3 ${row.can_import ? 'bg-pool-800 border-pool-600 cursor-pointer' : 'bg-pool-900/30 border-pool-700 opacity-70'}`}>
                <input type="checkbox" checked={selected.includes(row.index)} disabled={!row.can_import} onChange={() => toggle(row.index)} className="mt-1" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{row.swimmer_name}</p>
                  <p className="text-xs text-pool-400 mt-0.5">
                    {row.matched_swimmer_name ? `Matched ${row.matched_swimmer_name}` : 'Not matched'}
                    {row.squad ? ` · ${row.squad}` : ''}
                  </p>
                  {row.can_import && <p className="text-[11px] text-green-300 mt-1">{row.fillable_fields.length} blank field{row.fillable_fields.length === 1 ? '' : 's'} ready to add</p>}
                  {row.conflicts.length > 0 && <p className="text-[11px] text-amber-300 mt-1">Preserving {row.conflicts.length} existing field{row.conflicts.length === 1 ? '' : 's'}</p>}
                  {row.errors.map((message, index) => <p key={index} className="text-[11px] text-red-300 mt-1">{message}</p>)}
                  {row.warnings.filter(message => !message.includes('existing field')).map((message, index) => <p key={index} className="text-[11px] text-amber-300 mt-1">{message}</p>)}
                </div>
              </label>
            ))}
          </div>

          <div className="flex gap-2">
            <button onClick={() => { setPreview(null); setSelected([]) }} className="flex-1 border border-pool-600 rounded-xl py-2.5 text-sm font-semibold">Choose another</button>
            <button onClick={confirm} disabled={saving || selected.length === 0}
              className="flex-[1.4] bg-accent-600 disabled:opacity-40 rounded-xl py-2.5 text-sm font-semibold">
              {saving ? 'Importing…' : `Import ${selected.length} profile${selected.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  )
}


function CombinedImport({ setResult, setLoading, loading }) {
  const [file, setFile] = useState(null)
  const [trackerFile, setTrackerFile] = useState(null)
  const [squad, setSquad] = useState('Silver 1')
  const [replaceExisting, setReplaceExisting] = useState(true)
  const [reconcileRoster, setReconcileRoster] = useState(true)

  const submit = async () => {
    if (!file) return
    setLoading(true)
    setResult(null)
    try {
      const res = await api.importCombinedSwims(file, trackerFile, squad, replaceExisting, reconcileRoster)
      setResult(res)
      setFile(null)
    } catch (e) {
      setResult({ error: e.message })
    }
    setLoading(false)
  }

  return (
    <div className="space-y-3">
      <p className="text-pool-400 text-sm">
        Import one combined .xlsx workbook containing every current squad member and all their race times.
      </p>

      <label className="block space-y-1">
        <span className="text-xs text-pool-400">Squad name</span>
        <input
          value={squad}
          onChange={(e) => setSquad(e.target.value)}
          className="w-full bg-pool-800 rounded-xl px-3 py-2.5 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none"
        />
      </label>

      <label className="block bg-pool-800 rounded-xl p-4 text-center cursor-pointer border-2 border-dashed border-pool-600 hover:border-accent-500 transition-colors">
        <input
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(e) => setFile(e.target.files[0])}
        />
        {file ? (
          <p className="text-sm text-pool-200">{file.name}</p>
        ) : (
          <>
            <p className="text-sm text-accent-400 font-medium">Select combined workbook</p>
            <p className="text-xs text-pool-500 mt-1">Current members + all swims</p>
          </>
        )}
      </label>

      <label className="block bg-pool-800 rounded-xl p-3 cursor-pointer border border-pool-700 hover:border-accent-500 transition-colors">
        <input
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => setTrackerFile(e.target.files[0])}
        />
        <p className="text-xs text-pool-300 font-medium">
          {trackerFile ? trackerFile.name : 'Add tracker names CSV (optional)'}
        </p>
        <p className="text-[11px] text-pool-500 mt-1">
          Adds Homeclub and CS start date. Needed once; future imports preserve the saved values.
        </p>
      </label>

      <label className="flex items-start gap-3 bg-pool-800 rounded-xl p-3">
        <input
          type="checkbox"
          checked={replaceExisting}
          onChange={(e) => setReplaceExisting(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-xs text-pool-400 leading-relaxed">
          Replace existing race times for swimmers in this workbook. Coaching notes, profiles, observations and session history are preserved.
        </span>
      </label>

      <label className="flex items-start gap-3 bg-pool-800 rounded-xl p-3">
        <input
          type="checkbox"
          checked={reconcileRoster}
          onChange={(e) => setReconcileRoster(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-xs text-pool-400 leading-relaxed">
          Treat this as the complete current roster. Existing {squad || 'squad'} swimmers missing from the workbook are marked inactive, never deleted.
        </span>
      </label>

      <button
        onClick={submit}
        disabled={loading || !file || !squad.trim()}
        className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-3 font-semibold text-sm"
      >
        {loading ? 'Importing squad + times…' : 'Import Combined Workbook'}
      </button>
    </div>
  )
}


function RosterImport({ setResult, setLoading, loading }) {
  const [file, setFile] = useState(null)

  const submit = async () => {
    if (!file) return
    setLoading(true)
    setResult(null)
    try {
      const res = await api.importRoster(file)
      setResult(res)
    } catch (e) {
      setResult({ error: e.message })
    }
    setLoading(false)
  }

  return (
    <div className="space-y-3">
      <p className="text-pool-400 text-sm">
        Import a squad roster CSV to bulk-create swimmers. Download the template below to get the right format.
      </p>
      <a
        href={"data:text/plain;charset=utf-8,ID\tSwimmer Name\tDate of Birth\tGender\tHomeclub\tSquad Start date\r\n123456\tJane Smith\t15/03/2006\tF\tCity SC\t01/09/2023"}
        download="swimmer_roster_template.txt"
        className="block text-center text-accent-400 text-sm border border-accent-600 rounded-xl py-2.5"
      >
        Download template
      </a>
      <p className="text-pool-400 text-xs">
        Columns: <span className="text-pool-300">ID</span> (swimrankings ID — links to times imports), Swimmer Name, Date of Birth, Gender, Homeclub, Squad Start date. Tab or comma separated.
      </p>
      <label className="block bg-pool-800 rounded-xl p-4 text-center cursor-pointer border-2 border-dashed border-pool-600 hover:border-accent-500 transition-colors">
        <input
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => setFile(e.target.files[0])}
        />
        {file ? (
          <p className="text-sm text-pool-200">{file.name}</p>
        ) : (
          <p className="text-sm text-pool-400">Tap to select roster CSV</p>
        )}
      </label>
      <button
        onClick={submit}
        disabled={loading || !file}
        className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-3 font-semibold text-sm"
      >
        {loading ? 'Importing...' : 'Import Squad'}
      </button>
    </div>
  )
}


const COMMON_EVENTS = SWIM_EVENTS

function WipeTimes({ setResult }) {
  const [confirm, setConfirm] = useState(false)
  const [wiping, setWiping] = useState(false)

  const doWipe = async () => {
    setWiping(true)
    try {
      const res = await api.deleteTimes()
      setResult({ wiped: true, deleted: res.deleted })
      setConfirm(false)
    } catch (e) {
      setResult({ error: e.message })
    }
    setWiping(false)
  }

  if (!confirm) {
    return (
      <button
        onClick={() => setConfirm(true)}
        className="w-full bg-pool-800 border border-red-900 rounded-xl py-2.5 text-sm font-semibold text-red-400"
      >
        Wipe all times
      </button>
    )
  }

  return (
    <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-3 space-y-2">
      <p className="text-xs text-red-300 text-center">Delete every swim time in the database? This cannot be undone.</p>
      <div className="flex gap-2">
        <button
          onClick={() => setConfirm(false)}
          className="flex-1 bg-pool-700 rounded-lg py-2 text-sm font-semibold"
        >
          Cancel
        </button>
        <button
          onClick={doWipe}
          disabled={wiping}
          className="flex-1 bg-red-900 disabled:opacity-40 rounded-lg py-2 text-sm font-semibold text-red-100"
        >
          {wiping ? 'Wiping…' : 'Confirm Wipe'}
        </button>
      </div>
    </div>
  )
}


function CSVImport({ setResult, setLoading, loading }) {
  const [rows, setRows] = useState([])  // [{file, eventName}]

  const addFiles = (e) => {
    const newFiles = Array.from(e.target.files).map(f => ({ file: f, eventName: guessEvent(f.name) }))
    setRows(prev => [...prev, ...newFiles])
    e.target.value = ''
  }

  const guessEvent = (filename) => {
    // Try to extract event from filename e.g. "100_freestyle_scm.csv" → "100 Freestyle"
    const clean = filename.replace(/\.(csv)$/i, '').replace(/[_\-]/g, ' ')
    for (const ev of COMMON_EVENTS) {
      if (clean.toLowerCase().includes(ev.toLowerCase())) return ev
    }
    return ''
  }

  const setEvent = (i, val) => setRows(prev => prev.map((r, idx) => idx === i ? { ...r, eventName: val } : r))
  const remove = (i) => setRows(prev => prev.filter((_, idx) => idx !== i))

  const submit = async () => {
    if (!rows.length) return
    setLoading(true)
    setResult(null)
    try {
      const res = rows.length === 1
        ? await api.importCsv(rows[0].file, rows[0].eventName)
        : await api.importCsvBulk(rows)
      setResult(res)
      setRows([])
    } catch (e) {
      setResult({ error: e.message })
    }
    setLoading(false)
  }

  return (
    <div className="space-y-3">
      <p className="text-pool-400 text-sm">
        Import swimrankings CSV exports — one file per event (e.g. "100 Freestyle SCM"). Select all event files at once and set the event name for each.
      </p>

      <label className="block bg-pool-800 rounded-xl p-4 text-center cursor-pointer border-2 border-dashed border-pool-600 hover:border-accent-500 transition-colors">
        <input type="file" accept=".csv" multiple className="hidden" onChange={addFiles} />
        <p className="text-sm text-accent-400 font-medium">+ Add CSV files</p>
        <p className="text-xs text-pool-500 mt-1">Select one or more swimrankings exports</p>
      </label>

      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="bg-pool-800 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-pool-300 truncate flex-1">{row.file.name}</p>
                <button onClick={() => remove(i)} className="text-xs text-red-400 ml-2 shrink-0">✕</button>
              </div>
              <input
                placeholder="Event name e.g. '100 Freestyle'"
                value={row.eventName}
                onChange={(e) => setEvent(i, e.target.value)}
                list="event-list"
                className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
              />
            </div>
          ))}
          <datalist id="event-list">
            {COMMON_EVENTS.map(e => <option key={e} value={e} />)}
          </datalist>
        </div>
      )}

      <button
        onClick={submit}
        disabled={loading || !rows.length}
        className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-3 font-semibold text-sm"
      >
        {loading ? 'Importing…' : rows.length ? `Import ${rows.length} file${rows.length > 1 ? 's' : ''}` : 'Import Times'}
      </button>

      <div className="border-t border-pool-700 pt-3">
        <p className="text-xs text-pool-500 mb-2">Danger zone — wipe all times and re-import from scratch</p>
        <WipeTimes setResult={setResult} />
      </div>
    </div>
  )
}


function ExcelImport({ setResult, setLoading, loading, importContext }) {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [draft, setDraft] = useState(null)
  const [aiCheck, setAiCheck] = useState(true)
  const [saving, setSaving] = useState(false)
  const [selectedTarget, setSelectedTarget] = useState(null)
  const [dateTargets, setDateTargets] = useState([])
  const [targetsLoading, setTargetsLoading] = useState(false)
  const [targetsError, setTargetsError] = useState('')
  const targetLocked = Boolean(importContext?.date || importContext?.slotId || importContext?.sessionId)

  useEffect(() => {
    if (!preview || targetLocked || !draft?.date) {
      setDateTargets([])
      setTargetsError('')
      return
    }

    let cancelled = false
    const [year, month, day] = draft.date.split('-').map(Number)
    const selectedDate = new Date(year, month - 1, day, 12)
    if (Number.isNaN(selectedDate.getTime())) {
      setDateTargets([])
      return
    }

    setTargetsLoading(true)
    setTargetsError('')
    api.getCalendar(localDateIso(mondayFor(selectedDate)))
      .then(days => {
        if (cancelled) return
        const matchingDay = days.find(calendarDay => calendarDay.date === draft.date)
        setDateTargets((matchingDay?.items || []).filter(item => item.status !== 'dismissed'))
      })
      .catch(error => {
        if (!cancelled) {
          setDateTargets([])
          setTargetsError(error?.message || 'Could not load sessions for this date.')
        }
      })
      .finally(() => {
        if (!cancelled) setTargetsLoading(false)
      })

    return () => { cancelled = true }
  }, [preview, targetLocked, draft?.date])

  const targetKey = (target) => {
    if (!target) return 'standalone'
    if (target.session_id) return `session-${target.session_id}`
    return `slot-${target.pool_slot_id || target.slot_id}`
  }

  const extract = async () => {
    if (!file) return
    setLoading(true)
    setResult(null)
    try {
      const res = await api.importExcel(file, aiCheck, importContext)
      setPreview(res)
      setDraft(JSON.parse(JSON.stringify(res.draft)))
      setSelectedTarget(res.suggested_target || null)
    } catch (e) {
      setResult({ error: e.message })
    } finally {
      setLoading(false)
    }
  }

  const updateGroupSets = (value) => {
    setDraft(current => ({
      ...current,
      groups: {
        ...current.groups,
        1: { ...current.groups?.['1'], sets: value, items: [] },
      },
    }))
  }

  const changeDate = (value) => {
    setSelectedTarget(null)
    setDraft(current => ({ ...current, date: value, pool_slot_id: null }))
  }

  const chooseTarget = (target) => {
    if (target?.status === 'cancelled') return
    if (!target) {
      setSelectedTarget(null)
      setDraft(current => ({ ...current, pool_slot_id: null }))
      return
    }
    const poolSlotId = target.pool_slot_id || target.slot_id || null
    setSelectedTarget({
      ...target,
      pool_slot_id: poolSlotId,
      can_import: true,
    })
    setDraft(current => ({
      ...current,
      date: target.date || current.date,
      start_time: target.time || current.start_time,
      end_time: target.end_time || current.end_time,
      squad: target.squad || current.squad,
      course: target.course || current.course,
      pool_slot_id: poolSlotId,
    }))
  }

  const save = async () => {
    if (!draft) return
    setSaving(true)
    setResult(null)
    try {
      const saveTarget = targetLocked ? preview?.suggested_target : selectedTarget
      const targetId = saveTarget?.can_import !== false
        ? saveTarget?.session_id || null
        : null
      const session = await api.confirmExcelImport(draft, targetId, aiCheck)
      window.location.replace(`/sessions/${session.id}/register`)
    } catch (e) {
      setResult({ error: e.message })
      setSaving(false)
    }
  }

  if (!preview) {
    return (
      <div className="space-y-3">
        {importContext?.date && (
          <div className="bg-accent-900/20 border border-accent-700/40 rounded-xl p-3">
            <p className="text-xs font-semibold text-accent-300">Adding a plan for {importContext.date}</p>
            <p className="text-[11px] text-pool-500 mt-1">The workbook date and time will be checked against this session before it is linked.</p>
          </div>
        )}
        <p className="text-pool-400 text-sm">
          Upload your session-plan workbook. Nothing is saved until you review and confirm the extraction.
        </p>
        <label className="block bg-pool-800 rounded-xl p-4 text-center cursor-pointer border-2 border-dashed border-pool-600 hover:border-accent-500 transition-colors">
          <input
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => setFile(e.target.files[0] || null)}
          />
          {file ? (
            <p className="text-sm text-pool-200">{file.name}</p>
          ) : (
            <p className="text-sm text-pool-400">Tap to select an Excel session plan</p>
          )}
        </label>
        <label className="flex items-start gap-3 bg-pool-800 rounded-xl p-3">
          <input
            type="checkbox"
            checked={aiCheck}
            onChange={(e) => setAiCheck(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-xs text-pool-400 leading-relaxed">
            Analyse the session: check the extraction, estimate energy-system emphasis from work/rest structure, and prepare personalised swimmer watchpoints.
          </span>
        </label>
        <button
          onClick={extract}
          disabled={loading || !file}
          className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-3 font-semibold text-sm"
        >
          {loading ? 'Extracting…' : 'Extract & Review'}
        </button>
      </div>
    )
  }

  const target = targetLocked ? preview.suggested_target : selectedTarget
  const blocked = target?.can_import === false || (targetLocked && preview.context_match === false)
  return (
    <div className="space-y-3">
      <p className="text-pool-300 text-sm font-semibold">Review extracted session</p>

      {targetLocked && target && (
        <div className={`rounded-xl border p-3 ${blocked ? 'bg-red-900/20 border-red-800/60' : 'bg-emerald-900/20 border-emerald-700/50'}`}>
          <p className={`text-xs font-semibold ${blocked ? 'text-red-300' : 'text-emerald-300'}`}>
            {blocked ? 'Cancelled session matched' : target.session_id ? 'Existing session matched' : 'Timetable slot matched'}
          </p>
          <p className="text-sm text-pool-200 mt-1">
            {target.label || 'Scheduled session'} · {target.date} at {target.time}
          </p>
          {!blocked && <p className="text-xs text-pool-400 mt-1">The plan will be linked here automatically.</p>}
        </div>
      )}

      {!targetLocked && (
        <div className="bg-pool-800 rounded-xl p-3 space-y-3 border border-pool-700">
          <div>
            <p className="text-xs font-semibold text-pool-200">Choose the date and session</p>
            <p className="text-[11px] text-pool-500 mt-1">The workbook suggestion is selected initially. You can attach the plan to a different timetable occurrence before saving.</p>
          </div>

          <label className="block">
            <span className="block text-xs text-pool-400 mb-1">Session date</span>
            <input
              type="date"
              value={draft.date || ''}
              onChange={(event) => changeDate(event.target.value)}
              className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
            />
          </label>

          {draft.date && (
            <div className="space-y-2">
              <p className="text-[11px] text-pool-400">{calendarDayLabel(draft.date)}</p>
              {targetsLoading && <p className="text-xs text-pool-500">Loading timetable sessions…</p>}
              {targetsError && <p className="text-xs text-red-300">{targetsError}</p>}
              {!targetsLoading && !targetsError && dateTargets.length === 0 && (
                <p className="text-xs text-pool-500">No timetable sessions are scheduled on this date.</p>
              )}
              {!targetsLoading && dateTargets.map(item => {
                const itemTarget = { ...item, date: draft.date, pool_slot_id: item.slot_id }
                const isSelected = targetKey(selectedTarget) === targetKey(itemTarget)
                const isCancelled = item.status === 'cancelled'
                return (
                  <button
                    type="button"
                    key={targetKey(itemTarget)}
                    onClick={() => chooseTarget(itemTarget)}
                    disabled={isCancelled}
                    className={`w-full text-left rounded-lg border p-3 transition-colors ${
                      isCancelled
                        ? 'border-pool-700 bg-pool-900/40 opacity-60'
                        : isSelected
                          ? 'border-accent-500 bg-accent-900/20'
                          : 'border-pool-600 bg-pool-700 hover:border-pool-500'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-pool-200">{item.label || item.title || 'Scheduled session'}</p>
                        <p className="text-xs text-pool-400 mt-0.5">{item.time || 'Time not set'}{item.end_time ? `–${item.end_time}` : ''}{item.squad ? ` · ${item.squad}` : ''}</p>
                      </div>
                      <span className={`text-[10px] rounded-full px-2 py-1 ${isCancelled ? 'bg-pool-700 text-pool-400' : 'bg-pool-600 text-pool-300'}`}>
                        {isCancelled ? 'Cancelled' : item.session_id ? item.status : 'Timetable'}
                      </span>
                    </div>
                  </button>
                )
              })}

              <button
                type="button"
                onClick={() => chooseTarget(null)}
                className={`w-full text-left rounded-lg border p-3 transition-colors ${
                  selectedTarget === null
                    ? 'border-accent-500 bg-accent-900/20'
                    : 'border-pool-600 bg-pool-700 hover:border-pool-500'
                }`}
              >
                <p className="text-sm font-medium text-pool-200">New standalone session</p>
                <p className="text-xs text-pool-400 mt-0.5">Use this date without linking to a timetable occurrence.</p>
              </button>
            </div>
          )}
        </div>
      )}

      {(preview.warnings?.length > 0 || preview.ai_review) && (
        <div className="bg-pool-800 rounded-xl p-3 space-y-2">
          {preview.warnings?.map((warning, index) => (
            <p key={index} className="text-xs text-amber-300">• {warning}</p>
          ))}
          {preview.ai_review && (
            <div className="border-t border-pool-700 pt-2">
              <p className="text-xs font-semibold text-pool-300">AI consistency check: {preview.ai_review.status}</p>
              <p className="text-xs text-pool-400 mt-1">{preview.ai_review.summary}</p>
              {preview.ai_review.issues?.map((issue, index) => (
                <p key={index} className="text-xs text-amber-300 mt-1">• {issue}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {draft.energy_analysis && (
        <div className="bg-teal-900/20 border border-teal-700/40 rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-teal-300">Estimated prescribed dose</p>
            <span className="text-[10px] uppercase text-teal-200">{draft.energy_analysis.confidence || 'estimated'} confidence</span>
          </div>
          <p className="text-sm text-pool-200">{draft.energy_analysis.primary_emphasis || energy(draft.energy_system_focus).label}</p>
          <p className="text-xs text-pool-400">Density: {draft.energy_analysis.density || 'unclear'} · AI estimate for coach review, not measured swimmer fatigue.</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(draft.groups?.['1']?.volume_breakdown || {}).filter(([, value]) => Number(value) > 0).map(([zone, value]) => (
              <span key={zone} className="text-[10px] bg-pool-800 border border-pool-700 rounded-full px-2 py-1 text-pool-300">
                {energy(zone).label} · {Number(value).toLocaleString()}m
              </span>
            ))}
          </div>
          {draft.energy_analysis.assumptions?.length > 0 && (
            <details>
              <summary className="text-[11px] text-pool-500 cursor-pointer">Review assumptions</summary>
              {draft.energy_analysis.assumptions.map((item, index) => <p key={index} className="text-[11px] text-pool-400 mt-1">• {item}</p>)}
            </details>
          )}
        </div>
      )}

      <div className="bg-pool-800 rounded-xl p-3 space-y-3">
        <label className="block">
          <span className="block text-xs text-pool-400 mb-1">Title</span>
          <input value={draft.title || ''} onChange={(e) => setDraft({...draft, title: e.target.value})}
            className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600" />
        </label>
        <div className={`grid ${targetLocked ? 'grid-cols-3' : 'grid-cols-2'} gap-2`}>
          {targetLocked && (
            <label className="block">
              <span className="block text-xs text-pool-400 mb-1">Date</span>
              <input type="date" value={draft.date || ''} disabled
                className="w-full bg-pool-700 opacity-60 rounded-lg px-2 py-2 text-xs border border-pool-600" />
            </label>
          )}
          <label className="block">
            <span className="block text-xs text-pool-400 mb-1">Start</span>
            <input type="time" value={draft.start_time || ''} onChange={(e) => setDraft({...draft, start_time: e.target.value})}
              className="w-full bg-pool-700 rounded-lg px-2 py-2 text-xs border border-pool-600" />
          </label>
          <label className="block">
            <span className="block text-xs text-pool-400 mb-1">End</span>
            <input type="time" value={draft.end_time || ''} onChange={(e) => setDraft({...draft, end_time: e.target.value})}
              className="w-full bg-pool-700 rounded-lg px-2 py-2 text-xs border border-pool-600" />
          </label>
        </div>
        <label className="block">
          <span className="block text-xs text-pool-400 mb-1">Aim</span>
          <textarea value={draft.coach_intent || ''} onChange={(e) => setDraft({...draft, coach_intent: e.target.value})}
            rows="2" className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600" />
        </label>
        <label className="block">
          <span className="block text-xs text-pool-400 mb-1">Extracted set</span>
          <textarea value={draft.groups?.['1']?.sets || ''} onChange={(e) => updateGroupSets(e.target.value)}
            rows="13" className="w-full bg-pool-700 rounded-lg px-3 py-2 text-xs font-mono border border-pool-600" />
        </label>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => { setPreview(null); setDraft(null) }}
          className="flex-1 bg-pool-700 rounded-xl py-3 font-semibold text-sm"
        >
          Back
        </button>
        <button
          onClick={save}
          disabled={saving || blocked}
          className="flex-1 bg-accent-600 disabled:opacity-40 rounded-xl py-3 font-semibold text-sm"
        >
          {saving ? 'Saving…' : 'Save & Open Register'}
        </button>
      </div>
    </div>
  )
}


function PhotoImport({ setResult, setLoading, loading, plannedSessions }) {
  const [files, setFiles] = useState([])
  const [extractedData, setExtractedData] = useState(null)
  const [editingData, setEditingData] = useState(null)
  const [date, setDate] = useState('')
  const [observations, setObservations] = useState('')
  const [creatingSession, setCreatingSession] = useState(false)
  const [selectedSessionId, setSelectedSessionId] = useState(null)
  const [step, setStep] = useState('upload') // upload, edit, selectSession

  const addFiles = (e) => {
    const newFiles = Array.from(e.target.files)
    setFiles(prev => [...prev, ...newFiles])
    e.target.value = ''
  }

  const removeFile = (idx) => {
    setFiles(prev => prev.filter((_, i) => i !== idx))
  }

  const extractFromPhotos = async () => {
    if (files.length === 0) return
    setLoading(true)
    setExtractedData(null)
    try {
      // Extract from each photo and merge
      const allExtracted = {}
      for (const file of files) {
        const res = await api.importPhoto(file, date || null, null)
        if (res.error) {
          setResult({ error: `Failed to extract from ${file.name}: ${res.error}` })
          setLoading(false)
          return
        }
        // Merge groups
        if (res.groups) {
          allExtracted.groups = { ...allExtracted.groups, ...res.groups }
        }
        allExtracted.title = allExtracted.title || res.title
        allExtracted.date = allExtracted.date || res.date
        allExtracted.energy_system_focus = allExtracted.energy_system_focus || res.energy_system_focus
        allExtracted.notes = (allExtracted.notes || '') + '\n' + (res.notes || '')
      }
      setExtractedData(allExtracted)
      setEditingData(JSON.parse(JSON.stringify(allExtracted)))
      setStep('edit')
    } catch (e) {
      setResult({ error: e.message })
    }
    setLoading(false)
  }

  const proceedToSessionSelection = () => {
    setStep('selectSession')
  }

  const updateGroup = (groupNum, field, value) => {
    setEditingData(prev => ({
      ...prev,
      groups: {
        ...prev.groups,
        [groupNum]: { ...(prev.groups[groupNum] || {}), [field]: value }
      }
    }))
  }

  const createOrUpdateSession = async () => {
    if (!editingData) return
    setCreatingSession(true)
    try {
      const sessionData = {
        title: editingData.title || `Session ${date}`,
        date: date || new Date().toISOString().split('T')[0],
        coach_intent: editingData.notes || '',
        energy_system_focus: editingData.energy_system_focus || '',
        planned_content: editingData.groups || {}
      }

      let sessionId
      if (selectedSessionId) {
        // Update existing planned session
        await api.updateSession(selectedSessionId, sessionData)
        sessionId = selectedSessionId
      } else {
        // Create new session
        const created = await api.createSession(sessionData)
        sessionId = created.id
      }

      // Parse and distribute observations if provided
      if (observations.trim()) {
        await api.parseObservations(sessionId, observations.trim()).catch(() => {})
      }

      setResult({ success: true })
      // Redirect to register
      window.location.replace(`/sessions/${sessionId}/register`)
    } catch (e) {
      setResult({ error: e.message })
    }
    setCreatingSession(false)
  }

  // Step 1: Upload photos
  if (step === 'upload') {
    return (
      <div className="space-y-3">
        <p className="text-pool-400 text-sm">
          Take photos of your session whiteboard (or upload multiple for different boards). Claude Vision will extract the session structure.
        </p>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-full bg-pool-800 rounded-xl px-4 py-3 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none"
        />
        <label className="block bg-pool-800 rounded-xl p-4 text-center cursor-pointer border-2 border-dashed border-pool-600 hover:border-accent-500 transition-colors">
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="hidden"
            onChange={addFiles}
          />
          <p className="text-sm text-accent-400 font-medium">+ Add Photos</p>
          <p className="text-xs text-pool-500 mt-1">Select one or more whiteboard photos</p>
        </label>

        {files.length > 0 && (
          <div className="space-y-2">
            {files.map((f, i) => (
              <div key={i} className="bg-pool-800 rounded-xl p-3 flex items-center justify-between">
                <span className="text-xs text-pool-300">{f.name}</span>
                <button onClick={() => removeFile(i)} className="text-xs text-red-400">✕</button>
              </div>
            ))}
          </div>
        )}

        <button
          onClick={extractFromPhotos}
          disabled={loading || files.length === 0}
          className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-3 font-semibold text-sm"
        >
          {loading ? 'Extracting...' : `Extract from ${files.length} Photo${files.length !== 1 ? 's' : ''}`}
        </button>
      </div>
    )
  }

  // Step 2: Review & edit extracted content
  if (step === 'edit') {
    return (
    <div className="space-y-3">
      <p className="text-pool-400 text-sm font-semibold">Review & Edit Session Content</p>

      <div className="bg-pool-800 rounded-xl p-3 space-y-3">
        <div>
          <label className="block text-xs text-pool-400 mb-1">Session Title</label>
          <input
            type="text"
            value={editingData.title || ''}
            onChange={(e) => setEditingData({...editingData, title: e.target.value})}
            className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
            placeholder="e.g. Monday Main Set"
          />
        </div>

        {Object.entries(editingData.groups || {}).map(([groupNum, group]) => (
          <div key={groupNum} className="border-t border-pool-700 pt-3">
            <label className="block text-xs text-pool-400 mb-2 font-semibold">Group {groupNum}</label>
            <textarea
              value={group?.sets || ''}
              onChange={(e) => updateGroup(groupNum, 'sets', e.target.value)}
              className="w-full bg-pool-700 rounded-lg px-3 py-2 text-xs border border-pool-600 focus:border-accent-500 focus:outline-none font-mono"
              rows="6"
              placeholder="Edit the sets here..."
            />
          </div>
        ))}

        <div className="border-t border-pool-700 pt-3">
          <label className="block text-xs text-pool-400 mb-1">Notes / Coach Intent</label>
          <textarea
            value={editingData.notes || ''}
            onChange={(e) => setEditingData({...editingData, notes: e.target.value})}
            className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
            rows="3"
            placeholder="Why is this session planned?"
          />
        </div>

        <div className="border-t border-pool-700 pt-3">
          <label className="block text-xs text-pool-400 mb-1">Swimmer observations <span className="text-pool-600">(optional)</span></label>
          <p className="text-xs text-pool-600 mb-2">Write naturally — Claude will assign to each swimmer. e.g. "Tom and Sarah — recovery from champs. Everyone else — general fatigue from block 2."</p>
          <textarea
            value={observations}
            onChange={(e) => {
              setObservations(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = `${e.target.scrollHeight}px`
            }}
            className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none resize-none min-h-[80px] max-h-48 overflow-y-auto"
            placeholder="Any observations about how swimmers responded or their context for this session?"
          />
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => setStep('upload')}
          className="flex-1 bg-pool-700 rounded-xl py-3 font-semibold text-sm"
        >
          Back
        </button>
        <button
          onClick={proceedToSessionSelection}
          className="flex-1 bg-accent-600 rounded-xl py-3 font-semibold text-sm"
        >
          Next
        </button>
      </div>
    </div>
    )
  }

  // Step 3: Link to planned session or create new
  if (step === 'selectSession') {
    return (
      <div className="space-y-3">
        <p className="text-pool-400 text-sm font-semibold">Link to Planned Session or Create New</p>

        {plannedSessions.length > 0 && (
          <div>
            <p className="text-pool-400 text-xs mb-2">Select a planned session to update:</p>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {plannedSessions.map(s => (
                <button
                  key={s.id}
                  onClick={() => setSelectedSessionId(s.id)}
                  className={`w-full text-left p-3 rounded-lg border-2 transition-colors ${
                    selectedSessionId === s.id
                      ? 'border-accent-500 bg-pool-700'
                      : 'border-pool-600 bg-pool-800 hover:border-pool-500'
                  }`}
                >
                  <p className="font-medium text-sm">{s.title || `Session ${s.date}`}</p>
                  <p className="text-xs text-pool-400">{s.date}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="border-t border-pool-700 pt-3">
          <button
            onClick={() => setSelectedSessionId(null)}
            className={`w-full text-left p-3 rounded-lg border-2 transition-colors ${
              selectedSessionId === null
                ? 'border-accent-500 bg-pool-700'
                : 'border-pool-600 bg-pool-800 hover:border-pool-500'
            }`}
          >
            <p className="font-medium text-sm text-pool-200">Create as New (Historical)</p>
            <p className="text-xs text-pool-400">Create a new session not linked to a plan</p>
          </button>
        </div>

        <div className="flex gap-2 pt-4">
          <button
            onClick={() => setStep('edit')}
            className="flex-1 bg-pool-700 rounded-xl py-3 font-semibold text-sm"
          >
            Back
          </button>
          <button
            onClick={createOrUpdateSession}
            disabled={creatingSession}
            className="flex-1 bg-accent-600 disabled:opacity-40 rounded-xl py-3 font-semibold text-sm"
          >
            {creatingSession ? 'Saving...' : 'Continue to Register'}
          </button>
        </div>
      </div>
    )
  }
}
