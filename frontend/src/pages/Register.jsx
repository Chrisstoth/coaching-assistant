import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api } from '../api'
import VoiceInput from '../components/VoiceInput'

export default function Register() {
  const { id } = useParams()
  const [session, setSession] = useState(null)
  const [entries, setEntries] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(null) // null | synced | queued
  const [expandedId, setExpandedId] = useState(null)
  const [groupCount, setGroupCount] = useState(null)
  const [editingGroupCount, setEditingGroupCount] = useState(false)
  const [savingGroupCount, setSavingGroupCount] = useState(false)

  useEffect(() => {
    Promise.all([api.getSession(id), api.getRegister(id)]).then(([sess, reg]) => {
      setSession(sess)
      const inferredGroupCount = sess.register_group_count ?? (
        sess.groups?.length || Object.keys(sess.planned_content || {}).length || null
      )
      setGroupCount(inferredGroupCount)
      setEntries(reg.map((r) => ({
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
      })))
    })
  }, [id])

  const update = (swimmerId, field, value) => {
    setSubmitted(null)
    setEntries((prev) =>
      prev.map((e) => (e.swimmer_id === swimmerId ? { ...e, [field]: value } : e))
    )
  }

  const markAllPresent = () => {
    setSubmitted(null)
    setEntries((prev) => prev.map((e) => ({
      ...e,
      attended: e.exception_reason ? e.attended : true,
    })))
  }

  const chooseGroupCount = async (count) => {
    setSavingGroupCount(true)
    try {
      const updatedSession = await api.updateSession(id, { register_group_count: count })
      setSession(updatedSession)
      setGroupCount(count)
      setEditingGroupCount(false)
      setSubmitted(null)
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
    } catch (error) {
      alert(`Could not save the session group setup: ${error.message}`)
    } finally {
      setSavingGroupCount(false)
    }
  }

  const submit = async (runAI = true) => {
    setSubmitting(true)
    try {
      const results = await api.submitRegister(id, {
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
      })
      if (results?.queued) {
        setSubmitted('queued')
        return
      }
      // Update AI characterisations
      const aiMap = Object.fromEntries(results.map((r) => [r.swimmer_id, r.ai_characterisation]))
      setEntries((prev) =>
        prev.map((e) => ({ ...e, ai_characterisation: aiMap[e.swimmer_id] ?? e.ai_characterisation }))
      )
      setSubmitted('synced')
    } catch (e) {
      alert(`Error: ${e.message}`)
    } finally {
      setSubmitting(false)
    }
  }

  const presentCount = entries.filter((e) => e.attended).length
  const excusedCount = entries.filter((e) => !e.attended && e.exception_reason).length

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
      {/* Header */}
      <div className="bg-pool-800 px-4 pt-4 pb-3 sticky top-0 z-10">
        <div className="flex items-center gap-3 mb-2">
          <Link to={`/sessions/${id}`} className="text-pool-400 text-2xl">‹</Link>
          <div className="flex-1">
            <h1 className="text-base font-bold">{session.title || 'Register'}</h1>
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

      {/* Session group setup */}
      <div className={`px-3 py-2.5 border-b ${groupCount && !editingGroupCount ? 'bg-pool-800/60 border-pool-700' : 'bg-amber-900/15 border-amber-800/40'}`}>
        {groupCount && !editingGroupCount ? (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-wide font-semibold text-pool-500">Session format</p>
              <p className="text-sm text-pool-200 mt-0.5">
                {groupCount === 1 ? 'Whole squad · everyone did the same session' : `${groupCount} training groups`}
              </p>
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
                  disabled={savingGroupCount}
                  className={`rounded-lg border px-2 py-2 text-xs font-semibold disabled:opacity-50 ${groupCount === count ? 'bg-accent-700 border-accent-500 text-white' : 'bg-pool-700 border-pool-600 text-pool-300'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

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
                onClick={() => update(entry.swimmer_id, 'attended', !entry.attended)}
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
                {groupCount > 1 && <div className="flex gap-2">
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
                </div>}

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
                <VoiceInput
                  onTranscript={(t) => update(entry.swimmer_id, 'coach_observation', t)}
                  placeholder="Observation (optional)..."
                />

                {/* AI characterisation */}
                {entry.ai_characterisation && (
                  <div className="bg-pool-700 rounded-lg p-3 text-xs text-pool-300 leading-relaxed">
                    <p className="text-pool-400 font-medium mb-1">AI Response</p>
                    {entry.ai_characterisation}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Submit */}
      <div className="p-4 bg-pool-800 border-t border-pool-700 space-y-2 safe-bottom">
        {submitted === 'synced' && (
          <p className="text-green-400 text-sm text-center">Register saved and synced.</p>
        )}
        {submitted === 'queued' && (
          <p className="text-amber-300 text-sm text-center">Saved on this device — it will sync automatically when the connection returns.</p>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => submit(false)}
            disabled={submitting || !groupCount}
            className="flex-1 bg-pool-700 rounded-xl py-3 text-sm font-semibold disabled:opacity-40"
          >
            Save
          </button>
          <button
            onClick={() => submit(true)}
            disabled={submitting || !groupCount}
            className="flex-1 bg-accent-600 rounded-xl py-3 text-sm font-semibold disabled:opacity-40"
          >
            {!groupCount ? 'Choose session groups first' : submitting ? 'Saving + AI...' : 'Save + analyse notes'}
          </button>
        </div>
      </div>
    </div>
  )
}
