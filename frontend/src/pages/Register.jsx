import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import VoiceInput from '../components/VoiceInput'
import RegisterSavedOverlay from '../components/RegisterSavedOverlay'
import { useSessionPresentation } from '../components/SessionPresentationProvider'

function SessionWatchpoints({ notes }) {
  const [open, setOpen] = useState(false)
  if (notes.length === 0) return null
  return (
    <div className="bg-amber-900/15 border-b border-amber-800/35">
      <button type="button" onClick={() => setOpen(value => !value)} className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left" aria-expanded={open}>
        <div>
          <p className="text-xs font-semibold text-amber-200">Session watchpoints</p>
          <p className="text-[11px] text-pool-500 mt-0.5">{notes.length} active coaching note{notes.length === 1 ? '' : 's'} for this date</p>
        </div>
        <span className={`text-pool-500 transition-transform ${open ? 'rotate-180' : ''}`}>⌄</span>
      </button>
      {open && (
        <div className="border-t border-amber-800/25 divide-y divide-amber-800/20 px-3">
          {notes.map(note => (
            <div key={note.id} className="py-2.5">
              <p className="text-xs font-semibold text-amber-200">{note.swimmer_names?.join(', ') || 'Squad'} · {note.title}</p>
              <p className="text-xs text-pool-300 whitespace-pre-line leading-relaxed mt-1">{note.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SessionDose({ analysis }) {
  const { energy } = useSessionPresentation()
  if (!analysis) return null
  const breakdowns = Object.values(analysis.group_breakdowns || {})
  const zones = breakdowns[0]?.zones || {}
  return (
    <div className="bg-teal-900/15 border-b border-teal-800/35 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-teal-200">Estimated session dose</p>
          <p className="text-[11px] text-pool-400 mt-0.5">{analysis.primary_emphasis || 'Energy emphasis estimated from the imported set'} · {analysis.density || 'unclear'} density</p>
        </div>
        <span className="text-[9px] uppercase text-teal-300 shrink-0">AI estimate</span>
      </div>
      <div className="flex flex-wrap gap-1 mt-2">
        {Object.entries(zones).filter(([, value]) => Number(value) > 0).map(([zone, value]) => (
          <span key={zone} className="text-[9px] rounded-full bg-pool-800 px-2 py-0.5 text-pool-300">{energy(zone).label} {Number(value).toLocaleString()}m</span>
        ))}
      </div>
    </div>
  )
}

function PredictionCard({ prediction }) {
  if (!prediction || typeof prediction !== 'object') return null
  return (
    <div className="bg-teal-900/15 border border-teal-700/35 rounded-lg p-3 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[10px] uppercase tracking-wide font-semibold text-teal-300">AI prediction · not an observation</p>
        {prediction.selected_because && (
          <span className="text-[10px] text-pool-500 shrink-0">{prediction.selected_because}</span>
        )}
      </div>
      {prediction.predicted_response && <p className="text-xs text-pool-300">{prediction.predicted_response}</p>}
      {prediction.watch_question && (
        <div className="border-t border-teal-800/40 pt-2 mt-2">
          <p className={`text-xs font-semibold ${
            prediction.priority >= 3 ? 'text-red-300'
              : prediction.priority === 2 ? 'text-amber-200' : 'text-pool-300'
          }`}>
            {prediction.priority >= 3 ? 'Worth a close look' : 'Question for you'}
          </p>
          <p className="text-xs text-pool-200 mt-1">{prediction.watch_question}</p>
          {prediction.watch_reason && <p className="text-[11px] text-pool-500 mt-1">{prediction.watch_reason}</p>}
        </div>
      )}
    </div>
  )
}

function AssessmentCard({ assessment }) {
  if (!assessment) return null
  if (typeof assessment === 'string') return <div className="bg-pool-700 rounded-lg p-3 text-xs text-pool-300 leading-relaxed">{assessment}</div>
  return (
    <div className="bg-pool-700 rounded-lg p-3 text-xs text-pool-300 leading-relaxed space-y-1.5">
      <p className="text-pool-400 font-medium">Post-session interpretation</p>
      {assessment.observed_response && <p>{assessment.observed_response}</p>}
      {assessment.prediction_comparison && <p><span className="text-pool-500">Prediction · </span>{assessment.prediction_comparison}</p>}
      {assessment.fatigue_and_recovery && <p><span className="text-pool-500">Recovery · </span>{assessment.fatigue_and_recovery}</p>}
      {assessment.next_session_action && <p className="text-teal-200"><span className="text-pool-500">Next session · </span>{assessment.next_session_action}</p>}
    </div>
  )
}

export default function Register() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [session, setSession] = useState(null)
  const [entries, setEntries] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(null) // null | synced | queued
  const [expandedId, setExpandedId] = useState(null)
  const [groupCount, setGroupCount] = useState(null)
  const [editingGroupCount, setEditingGroupCount] = useState(false)
  const [groupCountPending, setGroupCountPending] = useState(false)
  const [sessionNotes, setSessionNotes] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [draftDirty, setDraftDirty] = useState(false)
  const [draftRevision, setDraftRevision] = useState(null)

  const draftKey = `lanewatch_register_draft:${id}`

  useEffect(() => {
    Promise.all([
      api.getSession(id),
      api.getRegister(id),
      api.getCoachingNotes().catch(() => []),
    ]).then(([sess, reg, notes]) => {
      setSession(sess)
      setSessionNotes(notes.filter(note => note.date_from <= sess.date && note.date_to >= sess.date))
      const inferredGroupCount = sess.register_group_count ?? (
        sess.groups?.length || Object.keys(sess.planned_content || {}).length || null
      )
      setGroupCount(inferredGroupCount)
      const serverEntries = reg.map((r) => ({
        swimmer_id: r.swimmer_id,
        swimmer_name: r.swimmer_name,
        squad: r.squad,
        attended: r.attended ?? false,
        normally_attends: r.usual_for_slot ?? false,
        exception_reason: r.exception_reason ?? null,
        availability: r.availability ?? null,
        group_planned: r.group_planned ?? null,
        sub_group_planned: r.sub_group_planned ?? null,
        group_done: r.group_done ?? (
          inferredGroupCount === 1
            ? 1
            : inferredGroupCount > 1 && r.group_planned <= inferredGroupCount
              ? r.group_planned
              : null
        ),
        sub_group_done: r.sub_group_done ?? null,
        coach_observation: r.coach_observation ?? '',
        ai_characterisation: r.ai_characterisation ?? null,
        ai_expected_response: r.ai_expected_response ?? null,
      }))
      let draft = null
      try {
        draft = JSON.parse(localStorage.getItem(draftKey) || 'null')
      } catch {
        localStorage.removeItem(draftKey)
      }
      if (draft?.revision && draft.revision === sess.register_revision) {
        localStorage.removeItem(draftKey)
        draft = null
      }
      if (Array.isArray(draft?.entries)) {
        const draftById = Object.fromEntries(draft.entries.map(entry => [entry.swimmer_id, entry]))
        setEntries(serverEntries.map(entry => draftById[entry.swimmer_id] ? { ...entry, ...draftById[entry.swimmer_id] } : entry))
        setDraftDirty(true)
        setDraftRevision(draft.revision || null)
        if (draft.group_count) {
          setGroupCount(draft.group_count)
          setGroupCountPending(draft.group_count !== sess.register_group_count)
        }
      } else {
        setEntries(serverEntries)
      }
      setLoaded(true)
    })
  }, [draftKey, id])

  useEffect(() => {
    if (!loaded || !draftDirty) return
    localStorage.setItem(draftKey, JSON.stringify({
      entries,
      group_count: groupCount,
      revision: draftRevision,
      updated_at: new Date().toISOString(),
    }))
  }, [draftDirty, draftKey, draftRevision, entries, groupCount, loaded])

  useEffect(() => {
    // A completed session offers a debrief, so don't navigate out from under it.
    if (!submitted || submitted.queued || submitted.complete) return undefined
    const returnHome = window.setTimeout(() => {
      navigate('/', { replace: true })
    }, 1400)
    return () => window.clearTimeout(returnHome)
  }, [navigate, submitted])

  const update = (swimmerId, field, value) => {
    setSubmitted(null)
    setDraftDirty(true)
    setEntries((prev) =>
      prev.map((e) => (e.swimmer_id === swimmerId ? { ...e, [field]: value } : e))
    )
  }

  const markAllPresent = () => {
    setSubmitted(null)
    setDraftDirty(true)
    setEntries((prev) => prev.map((e) => ({
      ...e,
      attended: e.exception_reason ? e.attended : true,
    })))
  }

  const toggleAttendance = (entry) => {
    const attended = !entry.attended
    update(entry.swimmer_id, 'attended', attended)

    if (attended && groupCount > 1) {
      setExpandedId(entry.swimmer_id)
    } else if (!attended && expandedId === entry.swimmer_id) {
      setExpandedId(null)
    }
  }

  const chooseGroupCount = (count) => {
    setGroupCount(count)
    setEditingGroupCount(false)
    setSubmitted(null)
    setDraftDirty(true)
    setEntries(prev => prev.map(entry => ({
      ...entry,
      group_done: count === 1
        ? 1
        : entry.group_done && entry.group_done <= count
          ? entry.group_done
          : entry.group_planned && entry.group_planned <= count
            ? entry.group_planned
            : null,
      sub_group_done: count === 1 ? null : entry.sub_group_done,
    })))
    setGroupCountPending(true)
  }

  const submit = async (runAI = true, sessionComplete = true) => {
    setSubmitting(true)
    try {
      const revision = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
      const clientSavedAt = new Date().toISOString()
      const payload = {
        entries: entries.map(({ swimmer_id, attended, group_planned, sub_group_planned, group_done, sub_group_done, coach_observation }) => ({
          swimmer_id,
          attended,
          group_planned: group_planned ?? null,
          sub_group_planned: sub_group_planned ?? null,
          group_done: attended ? group_done : null,
          sub_group_done: attended ? sub_group_done : null,
          coach_observation: attended ? coach_observation : null,
        })),
        run_ai: runAI,
        session_complete: sessionComplete,
        revision,
        client_saved_at: clientSavedAt,
        register_group_count: groupCount,
      }
      localStorage.setItem(draftKey, JSON.stringify({
        entries,
        group_count: groupCount,
        revision,
        updated_at: clientSavedAt,
      }))
      setDraftRevision(revision)
      const results = await api.submitRegister(id, payload)
      if (results?.queued) {
        setSubmitted({ queued: true, complete: sessionComplete, operation: null })
        return
      }
      if (results?.stale_ignored) {
        alert('A newer register save is already on the server. Reloading that version now.')
        window.location.reload()
        return
      }
      // Update AI characterisations
      const savedEntries = results.entries || results
      const aiMap = Object.fromEntries(savedEntries.map((r) => [r.swimmer_id, r.ai_characterisation]))
      const predictionMap = Object.fromEntries(savedEntries.map((r) => [r.swimmer_id, r.ai_expected_response]))
      setEntries((prev) =>
        prev.map((e) => ({
          ...e,
          ai_characterisation: aiMap[e.swimmer_id] ?? e.ai_characterisation,
          ai_expected_response: predictionMap[e.swimmer_id] ?? e.ai_expected_response,
        }))
      )
      localStorage.removeItem(draftKey)
      setDraftDirty(false)
      setDraftRevision(null)
      setGroupCountPending(false)
      setSession(previous => ({
        ...previous,
        status: results.session_status || previous.status,
        register_group_count: groupCount,
      }))
      setSubmitted({ queued: false, complete: sessionComplete, operation: results.ai_operation })
    } catch (e) {
      alert(`Error: ${e.message}`)
    } finally {
      setSubmitting(false)
    }
  }

  const presentCount = entries.filter((e) => e.attended).length
  const excusedCount = entries.filter((e) => !e.attended && e.exception_reason).length
  const watchedSwimmerIds = new Set([
    ...sessionNotes.flatMap(note => note.swimmer_ids || []),
    ...entries.filter(entry => entry.ai_expected_response?.watch_question).map(entry => entry.swimmer_id),
  ])
  // Watchpoints are answered in the debrief now, so this is a reminder of what
  // to talk about rather than a prompt for a note on this screen.
  // Ordered by the priority the prediction already carries (3 = high concern),
  // so the three names shown are the three worth watching rather than whichever
  // swimmers happen to come first in the register.
  const openWatchpoints = entries
    .filter(entry => entry.attended && watchedSwimmerIds.has(entry.swimmer_id))
    .slice()
    .sort((a, b) => (b.ai_expected_response?.priority || 0) - (a.ai_expected_response?.priority || 0))
  const watchpointNames = openWatchpoints.slice(0, 3).map(entry => entry.swimmer_name).join(', ')
  const additionalWatchpointCount = Math.max(0, openWatchpoints.length - 3)

  // Build lookup: group_number -> sub_group labels available
  const subGroupsByGroup = {}
  for (const g of (session?.groups || [])) {
    if (g.sub_groups?.length > 1) {
      subGroupsByGroup[g.group_number] = g.sub_groups.map((sg) => sg.label)
    }
  }
  const plannedGroupNumbers = (session?.groups || []).map(group => group.group_number)
  const groupNumbers = groupCount > 1
    ? (plannedGroupNumbers.length === groupCount
        ? plannedGroupNumbers
        : Array.from({ length: groupCount }, (_, index) => index + 1))
    : []

  if (!session || entries.length === 0) {
    return <div className="p-4 text-pool-400">Loading register...</div>
  }

  return (
    <div className="flex flex-col min-h-screen">
      {submitted && (
        <RegisterSavedOverlay
          queued={submitted.queued}
          complete={submitted.complete}
          operation={submitted.operation}
          sessionId={id}
          onClose={() => setSubmitted(null)}
          onHome={() => navigate('/', { replace: true })}
          onDebrief={() => navigate(`/debrief?session=${id}`)}
        />
      )}

      {/* Header */}
      <div className="bg-pool-800 px-4 pt-4 pb-3 sticky top-0 z-10">
        <div className="flex items-center gap-3 mb-2">
          <button
            type="button"
            onClick={() => {
              if (location.key && location.key !== 'default') navigate(-1)
              else navigate(`/sessions/${id}`, { replace: true })
            }}
            aria-label="Go back"
            className="text-pool-400 text-2xl"
          >‹</button>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold">{session.title || 'Register'}</h1>
              {session.cycle_code && <span className="text-[10px] font-semibold text-teal-300 bg-teal-900/35 border border-teal-700/40 rounded px-1.5 py-0.5">{session.cycle_code}</span>}
            </div>
            <p className="text-pool-400 text-xs">
              {session.date} · {entries.length} swimmers · {presentCount} present{excusedCount > 0 ? ` · ${excusedCount} excused` : ''}
            </p>
          </div>
          <button
            onClick={markAllPresent}
            className="text-xs text-accent-400 font-medium"
          >
            All present
          </button>
        </div>
      </div>

      <SessionDose analysis={session.energy_analysis} />

      {/* Session group setup */}
      <div className={`px-3 py-2.5 border-b ${groupCount && !editingGroupCount ? 'bg-pool-800/60 border-pool-700' : 'bg-amber-900/15 border-amber-800/40'}`}>
        {groupCount && !editingGroupCount ? (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-wide font-semibold text-pool-500">Session format</p>
              <p className="text-sm text-pool-200 mt-0.5">
                {groupCount === 1 ? 'Whole squad · everyone did the same session' : `${groupCount} training groups`}
              </p>
              {groupCountPending && <p className="text-[10px] text-amber-300 mt-0.5">Will sync with the register save</p>}
            </div>
            <button onClick={() => setEditingGroupCount(true)} className="text-xs text-accent-400 px-2 py-2">Change</button>
          </div>
        ) : (
          <div>
            <p className="text-xs font-semibold text-amber-200">How many different programmes are being done?</p>
            <p className="text-[11px] text-pool-400 mt-0.5">Choose one before saving the register. You can change it later.</p>
            <div className="grid grid-cols-3 gap-2 mt-2">
              {[
                [1, 'Everyone together'],
                [2, '2 groups'],
                [3, '3 groups'],
              ].map(([count, label]) => (
                <button
                  key={count}
                  onClick={() => chooseGroupCount(count)}
                  className={`rounded-lg border px-2 py-2 text-xs font-semibold ${groupCount === count ? 'bg-accent-700 border-accent-500 text-white' : 'bg-pool-700 border-pool-600 text-pool-300'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <SessionWatchpoints notes={sessionNotes} />

      {/* Entries */}
      <div className="flex-1 divide-y divide-pool-700">
        {entries.map((entry) => (
          <div key={entry.swimmer_id} className="px-3 py-2">
            {/* Row: name + attended toggle */}
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => setExpandedId(expandedId === entry.swimmer_id ? null : entry.swimmer_id)}
                className="flex-1 min-w-0 text-left py-0.5"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <p className={`font-medium text-sm truncate ${entry.attended ? 'text-pool-100' : 'text-pool-400'}`}>
                    {entry.swimmer_name}
                  </p>
                  {entry.normally_attends && <span className="text-[10px] text-teal-300 bg-teal-900/30 rounded px-1.5 py-0.5 shrink-0">Usual</span>}
                  {entry.exception_reason && (
                    <span className="text-[10px] text-amber-300 bg-amber-900/30 rounded px-1.5 py-0.5 shrink-0">
                      {entry.availability?.label || entry.exception_reason.replace('_', ' ')}
                    </span>
                  )}
                  {watchedSwimmerIds.has(entry.swimmer_id) && (
                    <span className="text-[10px] text-amber-200 bg-amber-900/30 rounded px-1.5 py-0.5 shrink-0">Watch</span>
                  )}
                </div>
                <p className="text-[11px] text-pool-500 truncate mt-0.5">
                  {groupCount === 1
                    ? 'Whole squad session'
                    : entry.group_done
                    ? `G${entry.group_done}${entry.sub_group_done || ''}`
                    : entry.group_planned
                      ? `Planned G${entry.group_planned}${entry.sub_group_planned || ''}`
                      : entry.attended ? 'Tap to set group or add a note' : 'Not marked present'}
                  {entry.availability?.detail ? ` · ${entry.availability.detail}` : ''}
                </p>
              </button>

              <button
                onClick={() => toggleAttendance(entry)}
                className={`min-w-14 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
                  entry.attended
                    ? 'bg-green-600 text-white'
                    : 'bg-pool-700 text-pool-400'
                }`}
              >
                {entry.attended ? 'In' : 'Out'}
              </button>
            </div>

            {/* Expanded: group + observation */}
            {entry.attended && expandedId === entry.swimmer_id && (
              <div className="space-y-2 mt-2 pl-1">
                {/* Group selector */}
                {groupCount > 1 && (
                  <div>
                    <p className="text-[11px] font-medium text-pool-400 mb-1.5">Which group is this swimmer in?</p>
                    <div className="flex gap-2">
                      {groupNumbers.map((g) => (
                        <button
                          key={g}
                          onClick={() => update(entry.swimmer_id, 'group_done', g)}
                          className={`flex-1 rounded-lg py-2 text-sm font-semibold transition-colors ${
                            entry.group_done === g
                              ? 'bg-accent-600 text-white'
                              : 'bg-pool-700 text-pool-400'
                          }`}
                        >
                          G{g}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Sub-group selector — only shown when the selected group has multiple sub-groups */}
                {groupCount > 1 && entry.group_done && subGroupsByGroup[entry.group_done] && (
                  <div className="flex gap-2">
                    {subGroupsByGroup[entry.group_done].map((label) => (
                      <button
                        key={label}
                        onClick={() => update(entry.swimmer_id, 'sub_group_done', label)}
                        className={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors ${
                          entry.sub_group_done === label
                            ? 'bg-accent-700 text-white'
                            : 'bg-pool-700 text-pool-500'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}

                {/* Observation */}
                <PredictionCard prediction={entry.ai_expected_response} />
                <VoiceInput
                  onTranscript={(t) => update(entry.swimmer_id, 'coach_observation', t)}
                  placeholder="Attendance note (optional) — late, pre-pool, out early…"
                />

                {/* AI characterisation */}
                <AssessmentCard assessment={entry.ai_characterisation} />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Submit */}
      <div className="p-4 bg-pool-800 border-t border-pool-700 space-y-2 safe-bottom">
        {openWatchpoints.length > 0 && (
          <p className="text-amber-300 text-xs text-center">
            Watchpoints open for {watchpointNames}{additionalWatchpointCount ? ` and ${additionalWatchpointCount} more` : ''} — cover {openWatchpoints.length === 1 ? 'it' : 'them'} in the debrief after you save.
          </p>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => submit(true, false)}
            disabled={submitting || !groupCount}
            className="flex-1 bg-pool-700 rounded-xl py-3 text-sm font-semibold disabled:opacity-40"
          >
            {submitting ? 'Saving…' : session.status === 'completed' ? 'Update attendance' : 'Save attendance'}
          </button>
          <button
            onClick={() => submit(true, true)}
            disabled={submitting || !groupCount}
            className="flex-1 bg-accent-600 rounded-xl py-3 text-sm font-semibold disabled:opacity-40"
          >
            {!groupCount ? 'Choose session groups first' : submitting ? 'Saving…' : session.status === 'completed' ? 'Reassess observations' : 'Finish + assess'}
          </button>
        </div>
      </div>
    </div>
  )
}
