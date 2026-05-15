import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api } from '../api'
import VoiceInput from '../components/VoiceInput'

export default function Register() {
  const { id } = useParams()
  const [session, setSession] = useState(null)
  const [entries, setEntries] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [expandedId, setExpandedId] = useState(null)

  useEffect(() => {
    Promise.all([api.getSession(id), api.getRegister(id)]).then(([sess, reg]) => {
      setSession(sess)

      // Get expected attendance for this session's date to pre-fill the register
      const expectedPromise = sess.date
        ? api.getExpectedAttendance(sess.date, sess.squad).catch(() => [])
        : Promise.resolve([])

      expectedPromise.then((expected) => {
        const expectedMap = Object.fromEntries(expected.map((e) => [e.id, e]))
        setEntries(
          reg.map((r) => {
            const exp = expectedMap[r.swimmer_id]
            return {
              swimmer_id: r.swimmer_id,
              swimmer_name: r.swimmer_name,
              squad: r.squad,
              attended: r.attended ?? false,
              normally_attends: exp?.expected ?? null,
              exception_reason: exp?.exception_reason ?? null,
              group_planned: r.group_planned ?? null,
              sub_group_planned: r.sub_group_planned ?? null,
              group_done: r.group_done ?? r.group_planned ?? null,
              sub_group_done: r.sub_group_done ?? null,
              coach_observation: r.coach_observation ?? '',
              ai_characterisation: r.ai_characterisation ?? null,
            }
          })
        )
      })
    })
  }, [id])

  const update = (swimmerId, field, value) => {
    setEntries((prev) =>
      prev.map((e) => (e.swimmer_id === swimmerId ? { ...e, [field]: value } : e))
    )
  }

  const markAllPresent = () =>
    setEntries((prev) => prev.map((e) => ({ ...e, attended: true })))

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
      // Update AI characterisations
      const aiMap = Object.fromEntries(results.map((r) => [r.swimmer_id, r.ai_characterisation]))
      setEntries((prev) =>
        prev.map((e) => ({ ...e, ai_characterisation: aiMap[e.swimmer_id] ?? e.ai_characterisation }))
      )
      setSubmitted(true)
    } catch (e) {
      alert(`Error: ${e.message}`)
    }
    setSubmitting(false)
  }

  const presentCount = entries.filter((e) => e.attended).length

  // Build lookup: group_number -> sub_group labels available
  const subGroupsByGroup = {}
  for (const g of (session?.groups || [])) {
    if (g.sub_groups?.length > 1) {
      subGroupsByGroup[g.group_number] = g.sub_groups.map((sg) => sg.label)
    }
  }

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
            <p className="text-pool-400 text-xs">{session.date} · {presentCount}/{entries.length} present</p>
          </div>
          <button
            onClick={markAllPresent}
            className="text-xs text-accent-400 font-medium"
          >
            All present
          </button>
        </div>
      </div>

      {/* Entries */}
      <div className="flex-1 divide-y divide-pool-700">
        {entries.map((entry) => (
          <div key={entry.swimmer_id} className="p-4">
            {/* Row: name + attended toggle */}
            <div className="flex items-center justify-between mb-2">
              <button
                onClick={() => setExpandedId(expandedId === entry.swimmer_id ? null : entry.swimmer_id)}
                className="flex-1 text-left"
              >
                <p className={`font-medium text-sm ${entry.attended ? 'text-pool-200' : 'text-pool-500'}`}>
                  {entry.swimmer_name}
                </p>
                <p className="text-xs text-pool-500">
                  {entry.group_planned && (
                    <span className="text-pool-500">
                      Planned G{entry.group_planned}{entry.sub_group_planned || ''}
                    </span>
                  )}
                  {entry.exception_reason && (
                    <span className="ml-2 text-yellow-500 capitalize">· {entry.exception_reason}</span>
                  )}
                  {entry.normally_attends && !entry.exception_reason && (
                    <span className="ml-2 text-pool-600">· normally here</span>
                  )}
                </p>
              </button>

              <button
                onClick={() => update(entry.swimmer_id, 'attended', !entry.attended)}
                className={`ml-4 rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
                  entry.attended
                    ? 'bg-green-600 text-white'
                    : 'bg-pool-700 text-pool-400'
                }`}
              >
                {entry.attended ? 'In' : 'Out'}
              </button>
            </div>

            {/* Expanded: group + observation */}
            {entry.attended && (
              <div className="space-y-2 mt-2">
                {/* Group selector */}
                <div className="flex gap-2">
                  {[1, 2, 3].map((g) => (
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

                {/* Sub-group selector — only shown when the selected group has multiple sub-groups */}
                {entry.group_done && subGroupsByGroup[entry.group_done] && (
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
                {expandedId === entry.swimmer_id && (
                  <VoiceInput
                    onTranscript={(t) => update(entry.swimmer_id, 'coach_observation', t)}
                    placeholder="Observation (optional)..."
                  />
                )}

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
        {submitted && (
          <p className="text-green-400 text-sm text-center">Register saved!</p>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => submit(false)}
            disabled={submitting}
            className="flex-1 bg-pool-700 rounded-xl py-3 text-sm font-semibold disabled:opacity-40"
          >
            Save
          </button>
          <button
            onClick={() => submit(true)}
            disabled={submitting}
            className="flex-1 bg-accent-600 rounded-xl py-3 text-sm font-semibold disabled:opacity-40"
          >
            {submitting ? 'Saving + AI...' : 'Save + AI Analysis'}
          </button>
        </div>
      </div>
    </div>
  )
}
