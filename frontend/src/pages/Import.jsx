import { useState, useEffect } from 'react'
import { api } from '../api'
import { SWIM_EVENTS } from '../swimEvents'

export default function Import() {
  const [tab, setTab] = useState('roster')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [plannedSessions, setPlannedSessions] = useState([])

  useEffect(() => {
    if (tab === 'photo' || tab === 'excel') {
      // Fetch upcoming planned sessions
      api.getCalendar().then(sessions => {
        setPlannedSessions(sessions.filter(s => s.status === 'planned' || !s.status))
      })
    }
  }, [tab])

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold pt-2">Import Data</h1>

      {/* Tab selector */}
      <div className="grid grid-cols-4 bg-pool-800 rounded-xl p-1 gap-1">
        {[
          { id: 'roster', label: 'Squad' },
          { id: 'csv', label: 'Times' },
          { id: 'excel', label: 'Sessions' },
          { id: 'photo', label: 'Photo' },
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

      {tab === 'roster' && <RosterImport setResult={setResult} setLoading={setLoading} loading={loading} />}
      {tab === 'csv' && <CSVImport setResult={setResult} setLoading={setLoading} loading={loading} />}
      {tab === 'excel' && <ExcelImport setResult={setResult} setLoading={setLoading} loading={loading} plannedSessions={plannedSessions} />}
      {tab === 'photo' && <PhotoImport setResult={setResult} setLoading={setLoading} loading={loading} plannedSessions={plannedSessions} />}

      {result && (
        <div className="bg-pool-800 rounded-xl p-4 text-sm space-y-1">
          <p className="font-semibold text-accent-400">Import Result</p>
          <pre className="text-pool-300 text-xs whitespace-pre-wrap">{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
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


function ExcelImport({ setResult, setLoading, loading, plannedSessions }) {
  const [files, setFiles] = useState([])
  const [extractedData, setExtractedData] = useState(null)
  const [selectedSessionId, setSelectedSessionId] = useState(null)
  const [creatingSession, setCreatingSession] = useState(false)

  const submit = async () => {
    if (!files.length) return
    setLoading(true)
    setResult(null)
    try {
      const res = files.length === 1
        ? await api.importExcel(files[0])
        : await api.importExcelBulk(files)
      setExtractedData(res)
    } catch (e) {
      setResult({ error: e.message })
    }
    setLoading(false)
  }

  const createOrUpdateSession = async () => {
    if (!extractedData) return
    setCreatingSession(true)
    try {
      const sessionData = Array.isArray(extractedData) ? extractedData[0] : extractedData
      if (selectedSessionId) {
        await api.updateSession(selectedSessionId, sessionData)
      } else {
        const created = await api.createSession(sessionData)
        sessionData.id = created.id
      }
      setResult({ success: true })
      window.location.href = `/sessions/${sessionData.id}/register`
    } catch (e) {
      setResult({ error: e.message })
    }
    setCreatingSession(false)
  }

  if (!extractedData) {
    return (
      <div className="space-y-3">
        <p className="text-pool-400 text-sm">
          Import one or multiple .xlsx session files. Select files to import historical sessions.
        </p>
        <label className="block bg-pool-800 rounded-xl p-4 text-center cursor-pointer border-2 border-dashed border-pool-600 hover:border-accent-500 transition-colors">
          <input
            type="file"
            accept=".xlsx,.xls"
            multiple
            className="hidden"
            onChange={(e) => setFiles(Array.from(e.target.files))}
          />
          {files.length > 0 ? (
            <p className="text-sm text-pool-200">{files.length} file{files.length > 1 ? 's' : ''} selected</p>
          ) : (
            <p className="text-sm text-pool-400">Tap to select Excel file(s)</p>
          )}
        </label>
        <button
          onClick={submit}
          disabled={loading || !files.length}
          className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-3 font-semibold text-sm"
        >
          {loading ? 'Importing...' : `Import ${files.length > 1 ? files.length + ' Sessions' : 'Session'}`}
        </button>
      </div>
    )
  }

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
          onClick={() => { setExtractedData(null); setFiles([]) }}
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
      window.location.href = `/sessions/${sessionId}/register`
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
