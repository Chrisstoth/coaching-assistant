import { useState } from 'react'
import { api } from '../api'
import VoiceInput from './VoiceInput'

const OBS_TYPES = [
  { value: 'race',      label: 'Race',      colour: 'bg-purple-700 text-purple-200' },
  { value: 'aerobic',   label: 'Aerobic',   colour: 'bg-blue-800 text-blue-200' },
  { value: 'threshold', label: 'Threshold', colour: 'bg-yellow-800 text-yellow-200' },
  { value: 'vo2',       label: 'VO2',       colour: 'bg-orange-800 text-orange-200' },
  { value: 'speed',     label: 'Speed',     colour: 'bg-red-800 text-red-200' },
  { value: 'recovery',  label: 'Recovery',  colour: 'bg-green-800 text-green-200' },
  { value: 'physical',  label: 'Physical',  colour: 'bg-teal-800 text-teal-200' },
  { value: 'general',   label: 'General',   colour: 'bg-pool-700 text-pool-300' },
  { value: 'coaching_intent', label: 'Training Intent', colour: 'bg-teal-800 text-teal-200' },
]

const typeColour = (t) => OBS_TYPES.find((o) => o.value === t)?.colour || 'bg-pool-700 text-pool-300'
const typeLabel  = (t) => OBS_TYPES.find((o) => o.value === t)?.label || t

const isTraining = (t) => ['aerobic', 'threshold', 'vo2', 'speed', 'recovery'].includes(t)
const isRace     = (t) => t === 'race'

export default function ObservationsTab({
  swimmerId, swimmer, observations, setObservations,
  obsFilter, setObsFilter,
  onRaceProfileUpdated, onTrainingProfileUpdated,
}) {
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    obs_type: 'race', date: new Date().toISOString().split('T')[0],
    event: '', content: '',
  })
  const [structured, setStructured] = useState({
    hr_range: '', rep_times: '', recovery: '', pacing: '', technical_notes: '',
  })
  const [saving, setSaving] = useState(false)
  const [synthRace, setSynthRace] = useState(false)
  const [synthTraining, setSynthTraining] = useState(false)

  const targetEvents = (swimmer?.target_events || []).map((e) =>
    typeof e === 'object' ? e.event : e
  )

  const save = async () => {
    if (!form.content.trim()) return
    setSaving(true)
    const payload = {
      ...form,
      date: form.date || null,
      event: form.event || null,
      structured: Object.fromEntries(
        Object.entries(structured).filter(([, v]) => v.trim())
      ) || null,
    }
    const obs = await api.addObservation(swimmerId, payload)
    setObservations((prev) => [obs, ...prev])
    setForm({ obs_type: 'race', date: new Date().toISOString().split('T')[0], event: '', content: '' })
    setStructured({ hr_range: '', rep_times: '', recovery: '', pacing: '', technical_notes: '' })
    setShowForm(false)
    setSaving(false)
  }

  const remove = async (obsId) => {
    await api.deleteObservation(swimmerId, obsId)
    setObservations((prev) => prev.filter((o) => o.id !== obsId))
  }

  const hasRaceObs = observations.some((o) => o.obs_type === 'race')
  const hasTrainingObs = observations.some((o) => ['aerobic','threshold','vo2','speed','recovery'].includes(o.obs_type))

  const runRaceSynthesis = async () => {
    setSynthRace(true)
    try {
      const result = await api.synthesiseRaceProfile(swimmerId)
      onRaceProfileUpdated?.(result)
    } catch (e) {
      alert(`Error: ${e.message}`)
    }
    setSynthRace(false)
  }

  const runTrainingSynthesis = async () => {
    setSynthTraining(true)
    try {
      const result = await api.synthesiseTrainingProfile(swimmerId)
      onTrainingProfileUpdated?.(result)
    } catch (e) {
      alert(`Error: ${e.message}`)
    }
    setSynthTraining(false)
  }

  const filtered = obsFilter === 'all'
    ? observations
    : observations.filter((o) => o.obs_type === obsFilter)

  return (
    <div className="space-y-4">
      {/* Actions */}
      <div className="space-y-2">
        <button
          onClick={() => setShowForm(!showForm)}
          className="w-full bg-accent-600 rounded-xl py-2.5 text-sm font-semibold"
        >
          {showForm ? 'Cancel' : '+ Add Observation'}
        </button>
        <div className="flex gap-2">
          <button
            onClick={runRaceSynthesis}
            disabled={synthRace || !hasRaceObs}
            className="flex-1 bg-purple-800 rounded-xl py-2 text-xs font-semibold disabled:opacity-40"
            title="Synthesise race profile from all race observations"
          >
            {synthRace ? '...' : 'Update Race Profile'}
          </button>
          <button
            onClick={runTrainingSynthesis}
            disabled={synthTraining || !hasTrainingObs}
            className="flex-1 bg-blue-900 rounded-xl py-2 text-xs font-semibold disabled:opacity-40"
            title="Synthesise training profile from all training observations"
          >
            {synthTraining ? '...' : 'Update Training Profile'}
          </button>
        </div>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="bg-pool-800 rounded-xl p-4 space-y-3">
          {/* Type selector */}
          <div className="flex flex-wrap gap-2">
            {OBS_TYPES.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => setForm({ ...form, obs_type: value, event: '' })}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  form.obs_type === value ? typeColour(value) : 'bg-pool-700 text-pool-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className="flex-1 bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
            />
            {/* Event selector for race obs */}
            {isRace(form.obs_type) && (
              <select
                value={form.event}
                onChange={(e) => setForm({ ...form, event: e.target.value })}
                className="flex-1 bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
              >
                <option value="">Event (optional)</option>
                {targetEvents.map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
            )}
          </div>

          {/* Main observation text */}
          <VoiceInput
            onTranscript={(t) => setForm({ ...form, content: t })}
            placeholder={
              isRace(form.obs_type)
                ? 'Describe how they raced — pacing, split pattern, underwaters, how they looked under pressure...'
                : isTraining(form.obs_type)
                ? 'Describe how they responded — technique under fatigue, energy, how they looked, times across the set...'
                : 'Observation...'
            }
          />

          {/* Structured fields for training observations */}
          {isTraining(form.obs_type) && (
            <div className="space-y-2 border-t border-pool-700 pt-3">
              <p className="text-xs text-pool-400 font-medium">Optional data points</p>
              <div className="grid grid-cols-2 gap-2">
                <input placeholder="HR range (e.g. 145-158)"
                  value={structured.hr_range}
                  onChange={(e) => setStructured({ ...structured, hr_range: e.target.value })}
                  className="bg-pool-700 rounded-lg px-3 py-2 text-xs border border-pool-600 focus:border-accent-500 focus:outline-none"
                />
                <input placeholder="Recovery (good/poor/etc)"
                  value={structured.recovery}
                  onChange={(e) => setStructured({ ...structured, recovery: e.target.value })}
                  className="bg-pool-700 rounded-lg px-3 py-2 text-xs border border-pool-600 focus:border-accent-500 focus:outline-none"
                />
              </div>
              <input placeholder="Rep times (e.g. 1:18, 1:19, 1:22, 1:24)"
                value={structured.rep_times}
                onChange={(e) => setStructured({ ...structured, rep_times: e.target.value })}
                className="w-full bg-pool-700 rounded-lg px-3 py-2 text-xs border border-pool-600 focus:border-accent-500 focus:outline-none"
              />
              <input placeholder="Technical notes under fatigue"
                value={structured.technical_notes}
                onChange={(e) => setStructured({ ...structured, technical_notes: e.target.value })}
                className="w-full bg-pool-700 rounded-lg px-3 py-2 text-xs border border-pool-600 focus:border-accent-500 focus:outline-none"
              />
            </div>
          )}

          {/* Structured fields for race observations */}
          {isRace(form.obs_type) && (
            <div className="space-y-2 border-t border-pool-700 pt-3">
              <p className="text-xs text-pool-400 font-medium">Optional data points</p>
              <select
                value={structured.pacing}
                onChange={(e) => setStructured({ ...structured, pacing: e.target.value })}
                className="w-full bg-pool-700 rounded-lg px-3 py-2 text-xs border border-pool-600 focus:border-accent-500 focus:outline-none"
              >
                <option value="">Pacing pattern...</option>
                <option value="positive split">Positive split (went out too fast)</option>
                <option value="negative split">Negative split (built through)</option>
                <option value="even split">Even split</option>
                <option value="variable">Variable / erratic</option>
              </select>
              <input placeholder="Technical notes during race"
                value={structured.technical_notes}
                onChange={(e) => setStructured({ ...structured, technical_notes: e.target.value })}
                className="w-full bg-pool-700 rounded-lg px-3 py-2 text-xs border border-pool-600 focus:border-accent-500 focus:outline-none"
              />
            </div>
          )}

          <button
            onClick={save}
            disabled={saving || !form.content.trim()}
            className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-2.5 text-sm font-semibold"
          >
            {saving ? 'Saving...' : 'Add Observation'}
          </button>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        <button
          onClick={() => setObsFilter('all')}
          className={`rounded-full px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
            obsFilter === 'all' ? 'bg-pool-500 text-white' : 'bg-pool-700 text-pool-400'
          }`}
        >
          All ({observations.length})
        </button>
        {OBS_TYPES.filter((t) => observations.some((o) => o.obs_type === t.value)).map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setObsFilter(value)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
              obsFilter === value ? typeColour(value) : 'bg-pool-700 text-pool-400'
            }`}
          >
            {label} ({observations.filter((o) => o.obs_type === value).length})
          </button>
        ))}
      </div>

      {/* Observations list */}
      {filtered.length === 0 ? (
        <p className="text-pool-400 text-sm text-center py-6">
          No observations yet. Add race profiles and training responses to help the AI learn this swimmer.
        </p>
      ) : (
        <div className="space-y-3">
          {filtered.map((obs) => (
            <div key={obs.id} className="bg-pool-800 rounded-xl p-4 space-y-2">
              <div className="flex justify-between items-start">
                <div className="flex items-center gap-2">
                  <span className={`text-xs rounded-full px-2 py-0.5 ${typeColour(obs.obs_type)}`}>
                    {typeLabel(obs.obs_type)}
                  </span>
                  {obs.event && (
                    <span className="text-xs text-pool-400">{obs.event}</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-pool-500">{obs.date}</span>
                  <button onClick={() => remove(obs.id)} className="text-pool-600 hover:text-red-400 text-xs">✕</button>
                </div>
              </div>

              <p className="text-sm leading-relaxed">{obs.content}</p>

              {obs.structured && Object.values(obs.structured).some(Boolean) && (
                <div className="border-t border-pool-700 pt-2 grid grid-cols-2 gap-x-4 gap-y-1">
                  {Object.entries(obs.structured).map(([k, v]) =>
                    v ? (
                      <div key={k}>
                        <span className="text-xs text-pool-500 capitalize">{k.replace(/_/g, ' ')}: </span>
                        <span className="text-xs text-pool-300">{v}</span>
                      </div>
                    ) : null
                  )}
                </div>
              )}

              {obs.ai_summary && (
                <div className="bg-pool-700 rounded-lg p-2 text-xs text-pool-300 italic">
                  {obs.ai_summary}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
