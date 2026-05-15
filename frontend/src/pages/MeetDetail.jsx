import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { SWIM_EVENTS } from '../swimEvents'

const LEVEL_LABELS = { club: 'Club', regional: 'Regional', national: 'National', international: 'International' }

const PRIORITY_COLORS = {
  A: 'bg-emerald-800 text-emerald-200',
  B: 'bg-blue-900 text-blue-200',
  C: 'bg-pool-700 text-pool-300',
}


function fmtDateRange(d1, d2) {
  if (!d1) return ''
  const fmt = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  if (!d2 || d1 === d2) return fmt(d1)
  const a = new Date(d1 + 'T00:00:00'), b = new Date(d2 + 'T00:00:00')
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth())
    return `${a.getDate()}–${b.getDate()} ${a.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`
  return `${a.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${fmt(d2)}`
}

export default function MeetDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [meet, setMeet] = useState(null)
  const [swimmers, setSwimmers] = useState([])
  const [showAddSwimmer, setShowAddSwimmer] = useState(false)
  const [assignForm, setAssignForm] = useState({ swimmer_id: '', events: [], priority: 'A', target_times: {}, notes: '' })
  const [editingTarget, setEditingTarget] = useState(null) // target id being edited
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [scheduleFile, setScheduleFile] = useState(null)
  const [entriesFile, setEntriesFile] = useState(null)
  const [extractingSchedule, setExtractingSchedule] = useState(false)
  const [extractingEntries, setExtractingEntries] = useState(false)
  const [scheduleExtracted, setScheduleExtracted] = useState(null)
  const [entriesExtracted, setEntriesExtracted] = useState(null)
  const [combining, setCombining] = useState(false)
  const [raceAnalysis, setRaceAnalysis] = useState(null)
  const [analysingMeet, setAnalysingMeet] = useState(false)

  const load = async () => {
    const [m, sq] = await Promise.all([api.getMeet(id), api.getSwimmers({ active: true })])
    setMeet(m)
    setSwimmers(sq)
  }

  useEffect(() => { load() }, [id])

  if (!meet) return <div className="p-4 text-pool-400">Loading…</div>

  const assignedIds = new Set(meet.targets.map(t => t.swimmer_id))
  const unassigned = swimmers.filter(s => !assignedIds.has(s.id))

  const toggleEvent = (ev) => {
    setAssignForm(f => ({
      ...f,
      events: f.events.includes(ev) ? f.events.filter(e => e !== ev) : [...f.events, ev],
    }))
  }

  const openAddSwimmer = () => {
    setEditingTarget(null)
    setAssignForm({ swimmer_id: unassigned[0]?.id || '', events: [], priority: 'A', target_times: {}, notes: '' })
    setShowAddSwimmer(true)
  }

  const openEditTarget = (t) => {
    setEditingTarget(t.id)
    setAssignForm({ swimmer_id: t.swimmer_id, events: t.events || [], priority: t.priority || 'A', target_times: t.target_times || {}, notes: t.notes || '' })
    setShowAddSwimmer(true)
  }

  const saveAssignment = async () => {
    if (!assignForm.swimmer_id || assignForm.events.length === 0) return
    setSaving(true)
    try {
      if (editingTarget) {
        await api.updateMeetTarget(id, editingTarget, {
          events: assignForm.events,
          priority: assignForm.priority,
          target_times: assignForm.target_times,
          notes: assignForm.notes,
        })
      } else {
        await api.addMeetTarget(id, {
          swimmer_id: parseInt(assignForm.swimmer_id),
          events: assignForm.events,
          priority: assignForm.priority,
          target_times: assignForm.target_times,
          notes: assignForm.notes,
        })
      }
      setShowAddSwimmer(false)
      load()
    } catch (e) { alert(e.message) }
    setSaving(false)
  }

  const removeTarget = async (targetId) => {
    await api.deleteMeetTarget(id, targetId)
    load()
  }

  const deleteMeet = async () => {
    if (!window.confirm(`Delete "${meet.name}"? This cannot be undone.`)) return
    setDeleting(true)
    await api.deleteMeet(id)
    navigate('/meets')
  }

  const handleExtractSchedule = async () => {
    if (!scheduleFile) {
      alert('Please select a schedule file')
      return
    }
    setExtractingSchedule(true)
    try {
      const result = await api.extractSchedule(id, scheduleFile)
      setScheduleExtracted(result)
      setScheduleFile(null)
    } catch (e) {
      alert('Error extracting schedule: ' + e.message)
    }
    setExtractingSchedule(false)
  }

  const handleExtractEntries = async () => {
    if (!entriesFile) {
      alert('Please select an entries file')
      return
    }
    setExtractingEntries(true)
    try {
      const result = await api.extractEntries(id, entriesFile)
      setEntriesExtracted(result)
      setEntriesFile(null)
    } catch (e) {
      alert('Error extracting entries: ' + e.message)
    }
    setExtractingEntries(false)
  }

  const handleCombineAndAssign = async () => {
    if (!scheduleExtracted || !entriesExtracted) {
      alert('Please extract both schedule and entries first')
      return
    }
    setCombining(true)
    try {
      await api.combineExtractions(id, {
        events: scheduleExtracted.events || [],
        swimmers: entriesExtracted.swimmers || {},
        auto_assign: true,
      })
      setScheduleExtracted(null)
      setEntriesExtracted(null)
      load()
    } catch (e) {
      alert('Error combining extractions: ' + e.message)
    }
    setCombining(false)
  }

  const daysUntil = meet.date
    ? Math.ceil((new Date(meet.date + 'T00:00:00') - new Date()) / 86400000)
    : null

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3 pt-2">
        <Link to="/meets" className="text-pool-400 text-2xl mt-0.5">‹</Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold leading-tight">{meet.name}</h1>
          <p className="text-pool-400 text-xs mt-0.5">
            {fmtDateRange(meet.date, meet.date_to)}
            {meet.location ? ` · ${meet.location}` : ''}
          </p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {meet.course && (
              <span className="text-xs bg-pool-700 rounded-full px-2.5 py-0.5 text-pool-200">{meet.course}</span>
            )}
            {meet.level && (
              <span className={`text-xs rounded-full px-2.5 py-0.5 font-medium ${
                { club: 'bg-pool-700 text-pool-300', regional: 'bg-blue-900 text-blue-200', national: 'bg-purple-900 text-purple-200', international: 'bg-amber-900 text-amber-200' }[meet.level] || 'bg-pool-700 text-pool-300'
              }`}>
                {LEVEL_LABELS[meet.level] || meet.level}
              </span>
            )}
            {meet.warm_up_time && (
              <span className="text-xs bg-pool-700 rounded-full px-2.5 py-0.5 text-pool-300">
                Warm-up {meet.warm_up_time}
              </span>
            )}
            {daysUntil !== null && daysUntil >= 0 && (
              <span className={`text-xs rounded-full px-2.5 py-0.5 font-medium ${daysUntil <= 7 ? 'bg-amber-900 text-amber-200' : 'bg-emerald-900/50 text-emerald-300'}`}>
                {daysUntil === 0 ? 'Today' : daysUntil === 1 ? 'Tomorrow' : `${daysUntil} days`}
              </span>
            )}
          </div>
        </div>
      </div>

      {meet.notes && (
        <div className="bg-pool-800 rounded-xl p-4">
          <p className="text-xs text-pool-400 mb-1">Notes</p>
          <p className="text-sm text-pool-200">{meet.notes}</p>
        </div>
      )}

      {/* Race Analysis */}
      <div className="bg-pool-800 rounded-xl p-4 space-y-3">
        {raceAnalysis ? (
          <>
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-accent-400 uppercase tracking-wide">Race Analysis</p>
              <button onClick={() => setRaceAnalysis(null)} className="text-xs text-pool-500 hover:text-pool-300">Clear</button>
            </div>
            <div className="text-xs text-pool-300 leading-relaxed space-y-1">
              {raceAnalysis.split('\n').map((line, i) => {
                if (line.startsWith('**') && line.endsWith('**')) {
                  return <p key={i} className="font-semibold text-white mt-3 first:mt-0">{line.replace(/\*\*/g, '')}</p>
                }
                if (line.startsWith('- ')) {
                  return <p key={i} className="pl-3 text-pool-300">{line}</p>
                }
                return line.trim() ? <p key={i}>{line}</p> : null
              })}
            </div>
          </>
        ) : (
          <button
            onClick={async () => {
              setAnalysingMeet(true)
              try {
                const r = await api.analyseMeetSkill({ meet_id: parseInt(id) })
                setRaceAnalysis(r.analysis)
              } catch (e) {
                setRaceAnalysis(`Error: ${e.message}`)
              }
              setAnalysingMeet(false)
            }}
            disabled={analysingMeet}
            className="w-full py-2.5 text-sm font-semibold bg-accent-600/80 rounded-xl disabled:opacity-40"
          >
            {analysingMeet ? 'Analysing…' : 'Race Analysis'}
          </button>
        )}
      </div>

      {/* Document extraction section */}
      <div className="bg-pool-800 rounded-xl p-4 space-y-4">
        <p className="text-sm font-semibold text-pool-200">Extract from documents</p>

        {/* Schedule extraction */}
        <div className="border border-pool-700 rounded-lg p-3 space-y-2">
          <p className="text-xs font-semibold text-pool-300">1. Extract Schedule</p>
          <div>
            <label htmlFor="schedule-input" className="text-xs text-pool-400 block mb-1">Schedule PDF or image</label>
            <input
              id="schedule-input"
              type="file"
              onChange={(e) => setScheduleFile(e.target.files?.[0] || null)}
              accept=".pdf,image/*"
              disabled={scheduleExtracted !== null}
              className="block w-full text-sm text-pool-400 border border-pool-600 rounded-lg p-2.5 bg-pool-700 cursor-pointer disabled:opacity-50"
            />
            {scheduleFile && <p className="text-xs text-accent-400 mt-1 truncate">{scheduleFile.name}</p>}
          </div>
          <button
            onClick={handleExtractSchedule}
            disabled={extractingSchedule || !scheduleFile || scheduleExtracted !== null}
            className="w-full bg-accent-600 disabled:opacity-40 rounded-lg py-2 text-sm font-semibold"
          >
            {extractingSchedule ? 'Extracting…' : scheduleExtracted ? '✓ Extracted' : 'Extract Schedule'}
          </button>
        </div>

        {/* Entries extraction */}
        <div className="border border-pool-700 rounded-lg p-3 space-y-2">
          <p className="text-xs font-semibold text-pool-300">2. Extract Entries</p>
          <div>
            <label htmlFor="entries-input" className="text-xs text-pool-400 block mb-1">Accepted entries PDF or image</label>
            <input
              id="entries-input"
              type="file"
              onChange={(e) => setEntriesFile(e.target.files?.[0] || null)}
              accept=".pdf,image/*"
              disabled={entriesExtracted !== null}
              className="block w-full text-sm text-pool-400 border border-pool-600 rounded-lg p-2.5 bg-pool-700 cursor-pointer disabled:opacity-50"
            />
            {entriesFile && <p className="text-xs text-accent-400 mt-1 truncate">{entriesFile.name}</p>}
          </div>
          <button
            onClick={handleExtractEntries}
            disabled={extractingEntries || !entriesFile || entriesExtracted !== null}
            className="w-full bg-accent-600 disabled:opacity-40 rounded-lg py-2 text-sm font-semibold"
          >
            {extractingEntries ? 'Extracting…' : entriesExtracted ? '✓ Extracted' : 'Extract Entries'}
          </button>
        </div>

        {/* Review schedule extraction */}
        {scheduleExtracted && (
          <div className="bg-blue-900/20 border border-blue-800 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-blue-300">Schedule Events</p>
              <button
                onClick={() => setScheduleExtracted(null)}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                Clear
              </button>
            </div>
            {Object.keys(scheduleExtracted.by_date || {}).length > 0 ? (
              <div className="space-y-2">
                {Object.entries(scheduleExtracted.by_date).map(([date, events]) => (
                  <div key={date} className="bg-blue-900/30 rounded p-2">
                    <p className="text-xs text-blue-400 font-medium mb-1">{date}</p>
                    <div className="flex flex-wrap gap-1">
                      {events.map((ev) => (
                        <span key={ev} className="text-xs bg-blue-800 text-blue-200 rounded px-2 py-0.5">
                          {ev}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {scheduleExtracted.events.map((ev) => (
                  <span key={ev} className="text-xs bg-blue-800 text-blue-200 rounded px-2 py-0.5">
                    {ev}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Review entries extraction */}
        {entriesExtracted && (
          <div className="bg-purple-900/20 border border-purple-800 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-purple-300">
                Swimmers ({Object.keys(entriesExtracted.swimmers).length})
              </p>
              <button
                onClick={() => setEntriesExtracted(null)}
                className="text-xs text-purple-400 hover:text-purple-300"
              >
                Clear
              </button>
            </div>
            <div className="space-y-1">
              {Object.entries(entriesExtracted.swimmers).map(([name, events]) => (
                <div key={name} className="bg-purple-900/30 rounded p-2 text-xs">
                  <p className="text-purple-200 font-medium">{name}</p>
                  <p className="text-purple-400 mt-0.5">{events.join(', ')}</p>
                </div>
              ))}
            </div>
            {entriesExtracted.unmatched && entriesExtracted.unmatched.length > 0 && (
              <div>
                <p className="text-xs text-yellow-400 mt-2 mb-1">Unmatched entries:</p>
                {entriesExtracted.unmatched.map((entry, idx) => (
                  <div key={idx} className="bg-yellow-900/20 border border-yellow-800 rounded p-1.5 text-xs mb-1">
                    <p className="text-yellow-300 font-medium">{entry.name}</p>
                    <p className="text-yellow-400 text-xs">{entry.events.join(', ')}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Combine and assign */}
        {scheduleExtracted && entriesExtracted && (
          <button
            onClick={handleCombineAndAssign}
            disabled={combining}
            className="w-full bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white rounded-lg py-3 text-sm font-semibold transition-colors"
          >
            {combining ? 'Assigning…' : '3. Combine & Auto-assign Swimmers'}
          </button>
        )}
      </div>

      {/* Swimmers section */}
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <h2 className="text-sm font-semibold text-pool-200">
            Swimmers ({meet.targets.length})
          </h2>
          {unassigned.length > 0 && (
            <button onClick={openAddSwimmer} className="text-xs text-accent-400 font-semibold">
              + Add swimmer
            </button>
          )}
        </div>

        {meet.targets.length === 0 ? (
          <div className="bg-pool-800 rounded-xl p-6 text-center">
            <p className="text-pool-400 text-sm">No swimmers assigned yet.</p>
            {unassigned.length > 0 && (
              <button onClick={openAddSwimmer} className="mt-3 bg-accent-600 rounded-xl px-4 py-2 text-sm font-semibold">
                Assign first swimmer
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {meet.targets
              .sort((a, b) => (a.priority || 'Z').localeCompare(b.priority || 'Z'))
              .map(t => (
                <div key={t.id} className="bg-pool-800 rounded-xl p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm">{t.swimmer_name}</p>
                        {t.priority && (
                          <span className={`text-xs rounded-full px-2 py-0.5 font-bold ${PRIORITY_COLORS[t.priority] || 'bg-pool-700 text-pool-300'}`}>
                            {t.priority}
                          </span>
                        )}
                        {t.squad && <span className="text-xs text-pool-500">{t.squad}</span>}
                      </div>
                      {t.events.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {t.events.map(ev => (
                            <span key={ev} className="text-xs bg-pool-700 rounded-full px-2.5 py-0.5 text-pool-200">
                              {ev}
                              {t.target_times?.[ev] && (
                                <span className="text-accent-400 ml-1">{t.target_times[ev]}</span>
                              )}
                            </span>
                          ))}
                        </div>
                      )}
                      {t.notes && <p className="text-xs text-pool-400 mt-1 italic">{t.notes}</p>}
                    </div>
                    <div className="flex gap-3 shrink-0">
                      <button onClick={() => openEditTarget(t)} className="text-xs text-pool-400">Edit</button>
                      <button onClick={() => removeTarget(t.id)} className="text-xs text-red-400">Remove</button>
                    </div>
                  </div>
                </div>
              ))
            }
          </div>
        )}
      </div>

      {/* Delete meet */}
      <button
        onClick={deleteMeet}
        disabled={deleting}
        className="w-full text-xs text-red-400 py-3 disabled:opacity-40"
      >
        Delete meet
      </button>

      {/* Add/edit swimmer bottom sheet */}
      {showAddSwimmer && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end">
          <div className="w-full max-w-lg mx-auto bg-pool-800 rounded-t-2xl p-5 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center">
              <p className="font-semibold">{editingTarget ? 'Edit assignment' : 'Add swimmer'}</p>
              <button onClick={() => setShowAddSwimmer(false)} className="text-pool-400 text-xl">×</button>
            </div>

            {/* Swimmer picker (only for new) */}
            {!editingTarget && (
              <select
                value={assignForm.swimmer_id}
                onChange={e => setAssignForm({ ...assignForm, swimmer_id: e.target.value })}
                className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
              >
                <option value="">Select swimmer</option>
                {unassigned.map(s => (
                  <option key={s.id} value={s.id}>{s.name}{s.squad ? ` (${s.squad})` : ''}</option>
                ))}
              </select>
            )}

            {/* Priority */}
            <div>
              <p className="text-xs text-pool-400 mb-2">Meet priority for this swimmer</p>
              <div className="flex gap-2">
                {['A', 'B', 'C'].map(p => (
                  <button
                    key={p}
                    onClick={() => setAssignForm({ ...assignForm, priority: p })}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-colors ${
                      assignForm.priority === p
                        ? p === 'A' ? 'bg-emerald-700 text-white' : p === 'B' ? 'bg-blue-800 text-white' : 'bg-pool-600 text-white'
                        : 'bg-pool-700 text-pool-400'
                    }`}
                  >
                    {p}{p === 'A' ? ' — Primary' : p === 'B' ? ' — Secondary' : ' — Participation'}
                  </button>
                ))}
              </div>
            </div>

            {/* Events */}
            <div>
              <p className="text-xs text-pool-400 mb-2">Events ({assignForm.events.length} selected)</p>
              <div className="flex flex-wrap gap-2">
                {SWIM_EVENTS.map(ev => (
                  <button
                    key={ev}
                    onClick={() => toggleEvent(ev)}
                    className={`text-sm rounded-full px-3 py-1.5 border transition-colors ${
                      assignForm.events.includes(ev)
                        ? 'bg-accent-600 border-accent-500 text-white'
                        : 'bg-pool-700 border-pool-600 text-pool-300'
                    }`}
                  >
                    {ev}
                  </button>
                ))}
              </div>
            </div>

            {/* Target times (shown if events selected) */}
            {assignForm.events.length > 0 && (
              <div>
                <p className="text-xs text-pool-400 mb-2">Target times (optional)</p>
                <div className="space-y-2">
                  {assignForm.events.map(ev => (
                    <div key={ev} className="flex items-center gap-2">
                      <span className="text-sm text-pool-300 flex-1">{ev}</span>
                      <input
                        placeholder="e.g. 52.50"
                        value={assignForm.target_times?.[ev] || ''}
                        onChange={e => setAssignForm(f => ({
                          ...f,
                          target_times: { ...f.target_times, [ev]: e.target.value },
                        }))}
                        className="w-28 bg-pool-700 rounded-lg px-3 py-1.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none text-right"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Notes */}
            <textarea
              placeholder="Notes for this swimmer at this meet (optional)"
              value={assignForm.notes}
              onChange={e => setAssignForm({ ...assignForm, notes: e.target.value })}
              rows={2}
              className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none resize-none"
            />

            <button
              onClick={saveAssignment}
              disabled={saving || (!editingTarget && !assignForm.swimmer_id) || assignForm.events.length === 0}
              className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-3 text-sm font-semibold"
            >
              {saving ? 'Saving…' : editingTarget ? 'Save changes' : 'Add to meet'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
