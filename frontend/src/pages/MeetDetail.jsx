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

function QualificationPanel({ meetId }) {
  const [sets, setSets] = useState([])
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState(null)
  const [assessments, setAssessments] = useState(null)

  const load = async () => setSets(await api.getQualificationSets(meetId))
  useEffect(() => { load().catch(() => {}) }, [meetId])

  const extract = async () => {
    if (!file) return
    setBusy(true)
    try {
      const result = await api.extractQualificationStandards(file, meetId)
      setReview(result)
      setFile(null)
      await load()
    } catch (e) { alert('Standards extraction failed: ' + e.message) }
    setBusy(false)
  }

  const openReview = async (setId) => {
    setBusy(true)
    try { setReview(await api.getQualificationSet(setId)); setAssessments(null) }
    catch (e) { alert(e.message) }
    setBusy(false)
  }

  const confirm = async () => {
    if (!review) return
    setBusy(true)
    try {
      const result = await api.confirmQualificationSet(review.id)
      setReview(result.standard_set)
      setAssessments(await api.getQualificationAssessments(review.id))
      await load()
    } catch (e) { alert('Could not confirm standards: ' + e.message) }
    setBusy(false)
  }

  const saveCorrections = async () => {
    if (!review) return
    setBusy(true)
    try {
      await api.updateQualificationSet(review.id, { rules: review.rules })
      const updated = await api.replaceQualificationStandards(review.id, review.standards.map(row => ({
        ...row, time: row.time_display,
      })))
      setReview(updated)
      await load()
    } catch (e) { alert('Could not save corrections: ' + e.message) }
    setBusy(false)
  }

  const compare = async (setId) => {
    setBusy(true)
    try {
      await api.recalculateQualifications(setId)
      setAssessments(await api.getQualificationAssessments(setId))
      setReview(await api.getQualificationSet(setId))
    } catch (e) { alert('Comparison failed: ' + e.message) }
    setBusy(false)
  }

  const rules = review?.rules || {}
  const statusStyle = {
    qualified: 'text-emerald-300', consideration: 'text-blue-300', chasing: 'text-amber-300',
    not_qualified: 'text-pool-400', unknown: 'text-pool-500',
  }

  return (
    <section className="bg-pool-800 rounded-xl p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-pool-200">Qualification standards</h2>
        <p className="text-xs text-pool-500 mt-0.5">The PDF is extracted once; later swimmer comparisons run locally.</p>
      </div>
      <div className="flex gap-2">
        <input type="file" accept=".pdf,image/*" onChange={e => setFile(e.target.files?.[0] || null)}
          className="min-w-0 flex-1 block text-xs text-pool-400 border border-pool-600 rounded-lg p-2 bg-pool-700" />
        <button onClick={extract} disabled={!file || busy} className="px-3 py-2 text-xs font-semibold bg-accent-600 rounded-lg disabled:opacity-40">
          {busy ? 'Working…' : 'Extract'}
        </button>
      </div>

      {sets.map(row => (
        <div key={row.id} className="border border-pool-700 rounded-xl p-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-pool-200 truncate">{row.name}</p>
            <p className="text-xs text-pool-500">{row.standard_count} standards · {row.status}</p>
          </div>
          <button onClick={() => openReview(row.id)} className="text-xs text-accent-400">Review</button>
          {row.status === 'confirmed' && <button onClick={() => compare(row.id)} className="text-xs text-teal-400">Compare</button>}
        </div>
      ))}

      {review && (
        <div className="bg-pool-900/45 border border-pool-700 rounded-xl p-3 space-y-3">
          <div className="flex justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">{review.name}</p>
              <p className="text-xs text-pool-500">{review.source_filename} · {review.extraction_model}</p>
            </div>
            <button onClick={() => { setReview(null); setAssessments(null) }} className="text-xs text-pool-500">Close</button>
          </div>
          {(review.extraction_notes || []).map((note, index) => (
            <p key={index} className="text-xs text-amber-300 bg-amber-950/20 rounded-lg p-2">{note}</p>
          ))}
          {review.status === 'draft' ? (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label className="text-pool-500">Age date<input type="date" value={rules.age_as_of_date || ''} onChange={e => setReview(p => ({ ...p, rules: { ...p.rules, age_as_of_date: e.target.value || null } }))} className="mt-1 w-full bg-pool-700 text-pool-200 rounded p-1.5 border border-pool-600" /></label>
              <label className="text-pool-500">Window start<input type="date" value={rules.qualification_window_start || ''} onChange={e => setReview(p => ({ ...p, rules: { ...p.rules, qualification_window_start: e.target.value || null } }))} className="mt-1 w-full bg-pool-700 text-pool-200 rounded p-1.5 border border-pool-600" /></label>
              <label className="text-pool-500">Window end<input type="date" value={rules.qualification_window_end || rules.entry_closing_date || ''} onChange={e => setReview(p => ({ ...p, rules: { ...p.rules, qualification_window_end: e.target.value || null } }))} className="mt-1 w-full bg-pool-700 text-pool-200 rounded p-1.5 border border-pool-600" /></label>
              <label className="text-pool-500">Licence levels<input value={(rules.accepted_license_levels || []).join(', ')} onChange={e => setReview(p => ({ ...p, rules: { ...p.rules, accepted_license_levels: e.target.value.split(',').map(v => Number(v.trim())).filter(Boolean) } }))} className="mt-1 w-full bg-pool-700 text-pool-200 rounded p-1.5 border border-pool-600" /></label>
              <label className="text-pool-500 col-span-2">Conversion rule<input value={rules.conversion_method || ''} onChange={e => setReview(p => ({ ...p, rules: { ...p.rules, conversion_method: e.target.value || null, long_course_conversions_accepted: !!e.target.value } }))} className="mt-1 w-full bg-pool-700 text-pool-200 rounded p-1.5 border border-pool-600" /></label>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div><span className="text-pool-500">Age date</span><p>{rules.age_as_of_date || 'Not specified'}</p></div>
              <div><span className="text-pool-500">Window</span><p>{rules.qualification_window_start || '?'} – {rules.qualification_window_end || rules.entry_closing_date || '?'}</p></div>
              <div><span className="text-pool-500">Licence levels</span><p>{(rules.accepted_license_levels || []).join(', ') || 'Not specified'}</p></div>
              <div><span className="text-pool-500">Conversion</span><p>{rules.conversion_method || (rules.long_course_conversions_accepted ? 'Allowed' : 'No conversion')}</p></div>
            </div>
          )}
          {rules.rules_summary && <p className="text-xs text-pool-300 leading-relaxed">{rules.rules_summary}</p>}
          <div className="max-h-64 overflow-auto border border-pool-700 rounded-lg">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-pool-700 text-pool-300"><tr>
                <th className="text-left p-2">Event</th><th className="text-left p-2">Group</th><th className="text-left p-2">Type</th><th className="text-right p-2">Time</th>
              </tr></thead>
              <tbody>{(review.standards || []).map(row => (
                <tr key={row.id} className="border-t border-pool-700/70">
                  <td className="p-2 whitespace-nowrap">{row.event_name} {row.course}</td>
                  <td className="p-2 whitespace-nowrap text-pool-400">{row.gender} · {row.age_label}</td>
                  <td className="p-2 capitalize text-pool-400">{row.standard_type}</td>
                  <td className="p-2 text-right font-mono">{review.status === 'draft' ? (
                    <input value={row.time_display || ''} onChange={e => setReview(previous => ({
                      ...previous, standards: previous.standards.map(item => item.id === row.id ? { ...item, time_display: e.target.value } : item),
                    }))} className="w-20 bg-pool-700 rounded px-1.5 py-1 text-right border border-pool-600" />
                  ) : row.time_display}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {review.status === 'draft' ? (
            <div className="space-y-2">
              <p className="text-xs text-amber-300">Check the rules and table against the PDF before confirming.</p>
              <div className="flex gap-2">
                <button onClick={saveCorrections} disabled={busy} className="flex-1 py-2 text-xs font-semibold bg-pool-700 rounded-lg disabled:opacity-40">Save corrections</button>
                <button onClick={confirm} disabled={busy} className="flex-1 py-2 text-xs font-semibold bg-emerald-700 rounded-lg disabled:opacity-40">Confirm and compare</button>
                <button onClick={async () => {
                  if (!window.confirm('Delete this extracted draft?')) return
                  await api.deleteQualificationSet(review.id); setReview(null); await load()
                }} className="px-3 py-2 text-xs text-red-400 bg-pool-700 rounded-lg">Delete draft</button>
              </div>
            </div>
          ) : <button onClick={() => compare(review.id)} disabled={busy} className="w-full py-2 text-xs font-semibold bg-teal-700 rounded-lg disabled:opacity-40">Recalculate from current swimmer times</button>}
        </div>
      )}

      {assessments && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-pool-400">Squad comparison</p>
          {assessments.swimmers.map(swimmer => (
            <details key={swimmer.swimmer_id} className="bg-pool-900/45 rounded-lg p-2.5">
              <summary className="list-none cursor-pointer flex justify-between gap-2">
                <span className="text-xs font-semibold">{swimmer.swimmer}</span>
                <span className={`text-xs capitalize ${statusStyle[swimmer.qualification_status] || 'text-pool-400'}`}>{swimmer.qualification_status.replace('_', ' ')}</span>
              </summary>
              <div className="mt-2 space-y-1">
                {swimmer.events.filter(event => event.status !== 'no_time').sort((a, b) => (a.gap_seconds ?? 999) - (b.gap_seconds ?? 999)).slice(0, 12).map((event, index) => (
                  <div key={`${event.standard_id}-${index}`} className="grid grid-cols-[1fr_auto] gap-2 text-xs border-t border-pool-700/60 pt-1">
                    <span>{event.event} · {event.standard_type} <span className="text-pool-500">({event.course})</span></span>
                    <span className={event.status === 'achieved' ? 'text-emerald-300' : event.status === 'chasing' ? 'text-amber-300' : 'text-pool-400'}>
                      {event.status === 'conversion_required' ? 'conversion needed' : event.best_time_display ? `${event.best_time_display} / ${event.standard_display}${event.gap_seconds > 0 ? ` (+${event.gap_seconds.toFixed(2)})` : ''}` : event.status}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  )
}

function MeetResultsPanel({ meetId, meet }) {
  const [data, setData] = useState(null)
  const [times, setTimes] = useState({})
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState([])

  const rowKey = (row) => `${row.swimmer_id}::${row.canonical_event}`

  const load = async () => {
    const result = await api.getMeetResults(meetId)
    setData(result)
    setTimes(Object.fromEntries(result.rows.map(row => [rowKey(row), row.recorded_time || ''])))
  }

  useEffect(() => { load().catch(() => {}) }, [meetId])

  const save = async () => {
    setSaving(true)
    setErrors([])
    try {
      const result = await api.saveMeetResults(meetId, data.rows.map(row => ({
        swimmer_id: row.swimmer_id,
        event: row.event,
        round: row.round || null,
        time: times[rowKey(row)] || '',
      })))
      setErrors(result.errors || [])
      setData({ meet: result.meet, rows: result.rows, recorded_count: result.recorded_count })
      setTimes(Object.fromEntries(result.rows.map(row => [rowKey(row), row.recorded_time || ''])))
    } catch (e) { alert(`Could not save results: ${e.message}`) }
    setSaving(false)
  }

  if (!data || !data.rows.length) return null

  const meetIsOver = meet.date && new Date((meet.date_to || meet.date) + 'T23:59:59') < new Date()
  const bySwimmer = data.rows.reduce((acc, row) => {
    (acc[row.swimmer_name] = acc[row.swimmer_name] || []).push(row)
    return acc
  }, {})

  return (
    <section className="bg-pool-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-pool-200">Results</h2>
          <p className="text-xs text-pool-400 mt-0.5">
            {data.recorded_count > 0
              ? `${data.recorded_count} of ${data.rows.length} swims recorded`
              : meetIsOver ? 'No results recorded yet' : `${data.rows.length} swims entered`}
          </p>
        </div>
        <button onClick={() => setOpen(!open)} className="text-xs text-accent-400 shrink-0">
          {open ? 'Close' : data.recorded_count > 0 ? 'Edit results' : 'Add results'}
        </button>
      </div>

      {open && (
        <div className="space-y-3">
          <p className="text-[11px] text-pool-500">
            Enter times as 1:02.45 or 62.45. Saved times go into each swimmer&apos;s times history.
            Clearing a box removes that result.
          </p>
          {Object.entries(bySwimmer).map(([name, rows]) => (
            <div key={name} className="border border-pool-700/60 rounded-lg p-3 space-y-2">
              <p className="text-xs font-semibold text-pool-300">{name}</p>
              {rows.map(row => (
                <div key={rowKey(row)} className="flex items-center gap-2">
                  <span className="flex-1 text-xs text-pool-400 min-w-0 truncate">
                    {row.event}
                    {row.target_time && <span className="text-pool-600"> · target {row.target_time}</span>}
                  </span>
                  <input
                    inputMode="decimal"
                    placeholder="—"
                    value={times[rowKey(row)] ?? ''}
                    onChange={e => setTimes({ ...times, [rowKey(row)]: e.target.value })}
                    className="w-24 bg-pool-700 rounded-lg px-2 py-1.5 text-sm text-right tabular-nums border border-pool-600 focus:border-accent-500 focus:outline-none"
                  />
                </div>
              ))}
            </div>
          ))}
          {errors.length > 0 && (
            <div className="rounded-lg bg-amber-900/20 border border-amber-800/40 px-3 py-2 space-y-1">
              {errors.map((message, index) => (
                <p key={index} className="text-[11px] text-amber-300">{message}</p>
              ))}
            </div>
          )}
          <button onClick={save} disabled={saving}
            className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-2.5 text-sm font-semibold">
            {saving ? 'Saving…' : 'Save results'}
          </button>
        </div>
      )}

      {!open && data.recorded_count > 0 && (
        <div className="divide-y divide-pool-700/40">
          {data.rows.filter(row => row.recorded_time).slice(0, 8).map(row => (
            <div key={rowKey(row)} className="flex items-center justify-between py-1.5">
              <span className="text-xs text-pool-300 min-w-0 truncate">{row.swimmer_name} · {row.event}</span>
              <span className="text-sm text-pool-100 tabular-nums shrink-0 ml-2">{row.recorded_time}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
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
  const [editingDetails, setEditingDetails] = useState(false)
  const [detailsForm, setDetailsForm] = useState(null)
  const [savingDetails, setSavingDetails] = useState(false)
  const [showTimetableForm, setShowTimetableForm] = useState(false)
  const [editingMeetSession, setEditingMeetSession] = useState(null)
  const [timetableSaving, setTimetableSaving] = useState(false)
  const [timetableForm, setTimetableForm] = useState({
    name: '', date: '', warm_up_time: '', start_time: '', end_time: '', events_text: '', notes: '', order_index: 0,
  })

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

  const openDetailsForm = () => {
    setDetailsForm({
      name: meet.name || '',
      date: meet.date || '',
      date_to: meet.date_to || '',
      location: meet.location || '',
      course: meet.course || '',
      level: meet.level || '',
      warm_up_time: meet.warm_up_time || '',
      notes: meet.notes || '',
    })
    setEditingDetails(true)
  }

  const saveDetails = async () => {
    if (!detailsForm.name.trim()) return
    setSavingDetails(true)
    try {
      const updated = await api.updateMeet(id, {
        name: detailsForm.name.trim(),
        date: detailsForm.date || null,
        date_to: detailsForm.date_to || null,
        location: detailsForm.location.trim() || null,
        course: detailsForm.course || null,
        level: detailsForm.level || null,
        warm_up_time: detailsForm.warm_up_time || null,
        notes: detailsForm.notes.trim() || null,
      })
      setMeet(updated)
      setEditingDetails(false)
    } catch (e) { alert(`Could not save the meet details: ${e.message}`) }
    setSavingDetails(false)
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
      await api.importMeetTimetable(id, { ...scheduleExtracted, replace: true })
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

  const openTimetableForm = (session = null) => {
    setEditingMeetSession(session?.id || null)
    setTimetableForm(session ? {
      ...session,
      date: session.date || '',
      warm_up_time: session.warm_up_time || '',
      start_time: session.start_time || '',
      end_time: session.end_time || '',
      notes: session.notes || '',
      events_text: (session.events || []).map(event => {
        if (typeof event === 'string') return event
        return `${event.number ? `${event.number}. ` : ''}${event.name || ''}${event.start_time ? ` @ ${event.start_time}` : ''}`
      }).join('\n'),
    } : {
      name: '', date: meet.date || '', warm_up_time: '', start_time: '', end_time: '',
      events_text: '', notes: '', order_index: meet.timetable?.length || 0,
    })
    setShowTimetableForm(true)
  }

  const parseTimetableEvents = (text) => text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const match = line.match(/^(?:(\d+[A-Za-z]?)\.\s*)?(.*?)(?:\s+@\s+(\d{1,2}:\d{2}))?$/)
    return { number: match?.[1] || null, name: match?.[2] || line, start_time: match?.[3] || null }
  })

  const saveTimetableSession = async () => {
    if (!timetableForm.name.trim()) return
    setTimetableSaving(true)
    const payload = {
      ...timetableForm,
      date: timetableForm.date || null,
      warm_up_time: timetableForm.warm_up_time || null,
      start_time: timetableForm.start_time || null,
      end_time: timetableForm.end_time || null,
      notes: timetableForm.notes || null,
      events: parseTimetableEvents(timetableForm.events_text),
    }
    delete payload.events_text
    try {
      if (editingMeetSession) await api.updateMeetSession(id, editingMeetSession, payload)
      else await api.createMeetSession(id, payload)
      setShowTimetableForm(false)
      await load()
    } catch (e) { alert(e.message) }
    setTimetableSaving(false)
  }

  const saveExtractedTimetable = async () => {
    setTimetableSaving(true)
    try {
      await api.importMeetTimetable(id, { ...scheduleExtracted, replace: true })
      setScheduleExtracted(null)
      await load()
    } catch (e) { alert(e.message) }
    setTimetableSaving(false)
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
          <div className="flex items-start justify-between gap-2">
            <h1 className="text-lg font-bold leading-tight">{meet.name}</h1>
            <button
              onClick={editingDetails ? () => setEditingDetails(false) : openDetailsForm}
              className="text-xs text-accent-400 shrink-0 px-1 py-0.5"
            >
              {editingDetails ? 'Cancel' : 'Edit'}
            </button>
          </div>
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

      {editingDetails && detailsForm && (
        <div className="bg-pool-800 rounded-xl p-4 space-y-3">
          <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide">Meet details</p>
          <input
            placeholder="Meet name *"
            value={detailsForm.name}
            onChange={e => setDetailsForm({ ...detailsForm, name: e.target.value })}
            className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
          />
          <div className="flex gap-2">
            <div className="flex-1">
              <p className="text-xs text-pool-400 mb-1">Start date</p>
              <input type="date" value={detailsForm.date}
                onChange={e => setDetailsForm({ ...detailsForm, date: e.target.value })}
                className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none" />
            </div>
            <div className="flex-1">
              <p className="text-xs text-pool-400 mb-1">End date</p>
              <input type="date" value={detailsForm.date_to}
                onChange={e => setDetailsForm({ ...detailsForm, date_to: e.target.value })}
                className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none" />
            </div>
          </div>
          <input
            placeholder="Location"
            value={detailsForm.location}
            onChange={e => setDetailsForm({ ...detailsForm, location: e.target.value })}
            className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
          />
          <div>
            <p className="text-xs text-pool-400 mb-1">Pool course</p>
            <div className="flex gap-2">
              <div className="flex rounded-xl overflow-hidden border border-pool-600 text-sm font-semibold flex-1">
                {['SCM', 'LCM'].map(c => (
                  <button key={c}
                    onClick={() => setDetailsForm({ ...detailsForm, course: detailsForm.course === c ? '' : c })}
                    className={`flex-1 py-2.5 ${detailsForm.course === c ? 'bg-accent-600 text-white' : 'bg-pool-700 text-pool-400'}`}>
                    {c === 'SCM' ? 'SC' : 'LC'}
                  </button>
                ))}
              </div>
              <select value={detailsForm.level}
                onChange={e => setDetailsForm({ ...detailsForm, level: e.target.value })}
                className="flex-1 bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none">
                <option value="">Level</option>
                {Object.entries(LEVEL_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2 items-center">
            <input type="time" value={detailsForm.warm_up_time}
              onChange={e => setDetailsForm({ ...detailsForm, warm_up_time: e.target.value })}
              className="w-32 bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none" />
            <span className="text-pool-400 text-sm">warm-up start</span>
          </div>
          <textarea placeholder="Notes (optional)" value={detailsForm.notes} rows={2}
            onChange={e => setDetailsForm({ ...detailsForm, notes: e.target.value })}
            className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none resize-none" />
          <div className="flex gap-2">
            <button onClick={() => setEditingDetails(false)}
              className="flex-1 bg-pool-700 rounded-xl py-2.5 text-sm font-semibold text-pool-300">Cancel</button>
            <button onClick={saveDetails} disabled={savingDetails || !detailsForm.name.trim()}
              className="flex-1 bg-accent-600 disabled:opacity-40 rounded-xl py-2.5 text-sm font-semibold">
              {savingDetails ? 'Saving…' : 'Save details'}
            </button>
          </div>
        </div>
      )}

      {!editingDetails && <MeetResultsPanel meetId={id} meet={meet} />}

      {meet.notes && !editingDetails && (
        <div className="bg-pool-800 rounded-xl p-4">
          <p className="text-xs text-pool-400 mb-1">Notes</p>
          <p className="text-sm text-pool-200">{meet.notes}</p>
        </div>
      )}

      {/* Persisted competition timetable */}
      <section className="bg-pool-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-pool-200">Competition timetable</h2>
            <p className="text-xs text-pool-500 mt-0.5">Used by season, taper and weekly planning.</p>
          </div>
          <button onClick={() => openTimetableForm()} className="text-xs text-accent-400 font-semibold">+ Add session</button>
        </div>

        {(meet.timetable || []).length === 0 && !showTimetableForm && (
          <p className="text-xs text-pool-500 py-2">No competition sessions saved yet. Add one manually or import the schedule below.</p>
        )}

        {(meet.timetable || []).map(session => (
          <div key={session.id} className="border border-pool-700 rounded-xl p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-pool-200">{session.name}</p>
                <p className="text-xs text-pool-400">
                  {session.date ? fmtDateRange(session.date) : 'Date TBC'}
                  {session.warm_up_time ? ` · warm-up ${session.warm_up_time}` : ''}
                  {session.start_time ? ` · start ${session.start_time}` : ''}
                </p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => openTimetableForm(session)} className="text-xs text-accent-400">Edit</button>
                <button onClick={async () => {
                  if (!window.confirm(`Delete ${session.name}?`)) return
                  await api.deleteMeetSession(id, session.id)
                  load()
                }} className="text-xs text-red-400">Delete</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(session.events || []).map((event, idx) => (
                <span key={idx} className="text-xs bg-pool-700 rounded px-2 py-1 text-pool-300">
                  {typeof event === 'string' ? event : `${event.number ? `${event.number}. ` : ''}${event.name}${event.start_time ? ` · ${event.start_time}` : ''}`}
                </span>
              ))}
            </div>
            {session.notes && <p className="text-xs text-pool-500">{session.notes}</p>}
          </div>
        ))}

        {showTimetableForm && (
          <div className="border border-accent-700/50 bg-pool-900/30 rounded-xl p-3 space-y-2">
            <input value={timetableForm.name} onChange={e => setTimetableForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Session name, e.g. Saturday AM" className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600" />
            <div className="grid grid-cols-2 gap-2">
              <input type="date" value={timetableForm.date} onChange={e => setTimetableForm(f => ({ ...f, date: e.target.value }))}
                className="bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600" />
              <input type="time" value={timetableForm.warm_up_time} onChange={e => setTimetableForm(f => ({ ...f, warm_up_time: e.target.value }))}
                title="Warm-up time" className="bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600" />
              <input type="time" value={timetableForm.start_time} onChange={e => setTimetableForm(f => ({ ...f, start_time: e.target.value }))}
                title="Start time" className="bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600" />
              <input type="time" value={timetableForm.end_time} onChange={e => setTimetableForm(f => ({ ...f, end_time: e.target.value }))}
                title="End time" className="bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600" />
            </div>
            <textarea rows={6} value={timetableForm.events_text} onChange={e => setTimetableForm(f => ({ ...f, events_text: e.target.value }))}
              placeholder={'One event per line, e.g.\n1. 400 Freestyle\n5. 100 Backstroke @ 10:30'}
              className="w-full bg-pool-700 rounded-lg px-3 py-2 text-xs border border-pool-600 resize-y" />
            <textarea rows={2} value={timetableForm.notes} onChange={e => setTimetableForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Session notes" className="w-full bg-pool-700 rounded-lg px-3 py-2 text-xs border border-pool-600 resize-none" />
            <div className="flex gap-2">
              <button onClick={() => setShowTimetableForm(false)} className="flex-1 py-2 text-xs bg-pool-700 rounded-lg">Cancel</button>
              <button onClick={saveTimetableSession} disabled={timetableSaving || !timetableForm.name.trim()}
                className="flex-1 py-2 text-xs font-semibold bg-accent-600 rounded-lg disabled:opacity-40">
                {timetableSaving ? 'Saving…' : 'Save session'}
              </button>
            </div>
          </div>
        )}
      </section>

      <QualificationPanel meetId={Number(id)} />

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
            <button onClick={saveExtractedTimetable} disabled={timetableSaving}
              className="w-full bg-blue-700 hover:bg-blue-600 disabled:opacity-40 rounded-lg py-2 text-xs font-semibold">
              {timetableSaving ? 'Saving…' : 'Save as competition timetable'}
            </button>
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
