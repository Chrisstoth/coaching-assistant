import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import VoiceInput from '../components/VoiceInput'

const EVENTS = [
  { stroke: 'Freestyle',        distances: [50, 100, 200, 400, 800, 1500] },
  { stroke: 'Backstroke',       distances: [50, 100, 200] },
  { stroke: 'Breaststroke',     distances: [50, 100, 200] },
  { stroke: 'Butterfly',        distances: [50, 100, 200] },
  { stroke: 'Individual Medley',distances: [200, 400] },
]

const COURSE_OPTIONS = ['SCM', 'LCM', 'Both']

const BIAS_OPTIONS = [
  { value: 'strong_scm',  label: 'Strong SCM' },
  { value: 'slight_scm',  label: 'Slight SCM' },
  { value: 'neutral',     label: 'Neutral' },
  { value: 'slight_lcm',  label: 'Slight LCM' },
  { value: 'strong_lcm',  label: 'Strong LCM' },
]

export default function NewSwimmer() {
  const navigate = useNavigate()
  const [form, setForm] = useState({
    name: '',
    dob: '',
    gender: '',
    swimrankings_id: '',
    target_events: [],   // [{event: "100 Freestyle", course: "SCM"}]
    course_bias: '',
    strengths: '',
    weaknesses: '',
    historical_background: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const eventKey = (stroke, dist) => `${dist} ${stroke}`

  const getEventEntry = (key) => form.target_events.find((e) => e.event === key)

  const toggleEvent = (key) => {
    setForm((f) => {
      const exists = f.target_events.find((e) => e.event === key)
      return {
        ...f,
        target_events: exists
          ? f.target_events.filter((e) => e.event !== key)
          : [...f.target_events, { event: key, course: 'Both' }],
      }
    })
  }

  const setCourse = (key, course) => {
    setForm((f) => ({
      ...f,
      target_events: f.target_events.map((e) =>
        e.event === key ? { ...e, course } : e
      ),
    }))
  }

  const save = async () => {
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError(null)
    try {
      const payload = {
        ...form,
        dob: form.dob || null,
        gender: form.gender || null,
        swimrankings_id: form.swimrankings_id || null,
        historical_background: form.historical_background || null,
      }
      const swimmer = await api.createSwimmer(payload)
      navigate(`/swimmers/${swimmer.id}`)
    } catch (e) {
      setError(e.message)
      setSaving(false)
    }
  }

  return (
    <div className="p-4 space-y-5 pb-8">
      <div className="flex items-center gap-3 pt-2">
        <Link to="/swimmers" className="text-pool-400 text-2xl">‹</Link>
        <h1 className="text-lg font-bold">Add Swimmer</h1>
      </div>

      {error && (
        <div className="bg-red-900 text-red-200 rounded-xl px-4 py-3 text-sm">{error}</div>
      )}

      {/* Basic info */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-pool-400 uppercase tracking-wide">Basic Info</h2>
        <input
          placeholder="Full name *"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="w-full bg-pool-800 rounded-xl px-4 py-3 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none"
        />
        <div className="flex gap-3">
          <input
            type="date"
            value={form.dob}
            onChange={(e) => setForm({ ...form, dob: e.target.value })}
            className="flex-1 bg-pool-800 rounded-xl px-4 py-3 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none"
          />
          <select
            value={form.gender}
            onChange={(e) => setForm({ ...form, gender: e.target.value })}
            className="flex-1 bg-pool-800 rounded-xl px-4 py-3 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none"
          >
            <option value="">Gender</option>
            <option value="M">Male</option>
            <option value="F">Female</option>
          </select>
        </div>
        <input
          placeholder="Swimrankings ID (optional)"
          value={form.swimrankings_id}
          onChange={(e) => setForm({ ...form, swimrankings_id: e.target.value })}
          className="w-full bg-pool-800 rounded-xl px-4 py-3 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none"
        />
      </section>

      {/* Target events */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-pool-400 uppercase tracking-wide">Target Events</h2>
        <div className="space-y-4">
          {EVENTS.map(({ stroke, distances }) => (
            <div key={stroke}>
              <p className="text-xs text-pool-400 mb-2">{stroke}</p>
              <div className="space-y-2">
                {distances.map((dist) => {
                  const key = eventKey(stroke, dist)
                  const entry = getEventEntry(key)
                  return (
                    <div key={key} className="flex items-center gap-2">
                      {/* Toggle select */}
                      <button
                        type="button"
                        onClick={() => toggleEvent(key)}
                        className={`rounded-lg px-3 py-2 text-xs font-medium w-24 text-left transition-colors ${
                          entry ? 'bg-accent-600 text-white' : 'bg-pool-700 text-pool-400'
                        }`}
                      >
                        {dist}m
                      </button>

                      {/* SCM / LCM / Both — only show when selected */}
                      {entry && (
                        <div className="flex gap-1">
                          {COURSE_OPTIONS.map((c) => (
                            <button
                              key={c}
                              type="button"
                              onClick={() => setCourse(key, c)}
                              className={`rounded-lg px-2.5 py-2 text-xs font-medium transition-colors ${
                                entry.course === c
                                  ? 'bg-pool-200 text-pool-900'
                                  : 'bg-pool-700 text-pool-400'
                              }`}
                            >
                              {c}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Course bias */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-pool-400 uppercase tracking-wide">Perceived Course Bias</h2>
        <p className="text-xs text-pool-400">Does this swimmer tend to perform relatively better in short course or long course?</p>
        <div className="flex gap-2">
          {BIAS_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setForm({ ...form, course_bias: form.course_bias === value ? '' : value })}
              className={`flex-1 rounded-lg py-2 text-xs font-medium transition-colors ${
                form.course_bias === value
                  ? value.includes('scm') ? 'bg-blue-700 text-white'
                    : value === 'neutral' ? 'bg-pool-500 text-white'
                    : 'bg-orange-700 text-white'
                  : 'bg-pool-700 text-pool-400'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {/* Coaching notes */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-pool-400 uppercase tracking-wide">Coaching Notes</h2>
        <textarea
          placeholder="Known strengths..."
          value={form.strengths}
          onChange={(e) => setForm({ ...form, strengths: e.target.value })}
          rows={2}
          className="w-full bg-pool-800 rounded-xl px-4 py-3 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none resize-none"
        />
        <textarea
          placeholder="Known weaknesses / areas to work on..."
          value={form.weaknesses}
          onChange={(e) => setForm({ ...form, weaknesses: e.target.value })}
          rows={2}
          className="w-full bg-pool-800 rounded-xl px-4 py-3 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none resize-none"
        />
      </section>

      {/* Historical background */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-pool-400 uppercase tracking-wide">Training Background</h2>
        <p className="text-xs text-pool-400">
          Describe this swimmer's history — previous club, years training, session frequency, injuries, anything relevant. Claude will synthesise this into their profile.
        </p>
        <VoiceInput
          onTranscript={(t) => setForm({ ...form, historical_background: t })}
          placeholder="e.g. Trained at City SC for 4 years, 5x per week. Sprint-focused, had a shoulder injury in 2023 that kept them out 3 months. Strong technique, struggles with race management in longer events..."
        />
      </section>

      <button
        onClick={save}
        disabled={saving || !form.name.trim()}
        className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-3.5 font-semibold text-sm"
      >
        {saving ? (form.historical_background ? 'Creating + building AI history...' : 'Creating...') : 'Add Swimmer'}
      </button>
    </div>
  )
}
