import { useState, useEffect } from 'react'
import { api } from '../api'
import { DEFAULT_PRESENTATION, energyPresentation, openSessionPrint } from '../sessionPresentation'

const ENERGY_COLOURS = {
  aerobic: 'bg-blue-900/40 text-blue-300 border-blue-800',
  threshold: 'bg-orange-900/40 text-orange-300 border-orange-800',
  speed: 'bg-red-900/40 text-red-300 border-red-800',
  recovery: 'bg-green-900/40 text-green-300 border-green-800',
  mixed: 'bg-purple-900/40 text-purple-300 border-purple-800',
}

export default function SessionPlanner() {
  const [text, setText] = useState('')
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(null)
  const [presentation, setPresentation] = useState(DEFAULT_PRESENTATION)
  const displayEnergy = zone => energyPresentation(zone, presentation)

  useEffect(() => {
    api.getSessionPresentation().then(setPresentation).catch(() => {})
  }, [])

  const analyse = async () => {
    if (!text.trim()) return
    setLoading(true)
    setError(null)
    setResult(null)
    setSaved(null)
    try {
      const data = await api.planSession({ text, date })
      setResult(data)
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  const saveAsSession = async () => {
    if (!result) return
    setSaving(true)
    try {
      const parsed = result.parsed
      const session = await api.createSession({
        date,
        title: parsed.title,
        energy_system_focus: parsed.energy_focus,
        coach_intent: result.plan_alignment,
        groups: parsed.groups,
        status: 'planned',
      })
      setSaved(session)
    } catch (e) {
      alert('Error saving: ' + e.message)
    }
    setSaving(false)
  }

  const printSheet = () => {
    if (!result) return
    const parsed = result.parsed || {}
    try {
      openSessionPrint({
        session: {
          ...parsed,
          date,
          energy_system_focus: parsed.energy_focus,
          groups: parsed.groups || {},
          coach_intent: result.plan_alignment,
        },
        settings: presentation,
        recommendations: result.per_swimmer || [],
      })
    } catch (error) {
      alert(error.message)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 shrink-0 border-b border-pool-600">
        <div className="flex items-center gap-2 mb-0.5">
          <div className="w-1.5 h-5 bg-accent-500 rounded-full" />
          <h1 className="text-lg font-bold tracking-tight">Session Planner</h1>
        </div>
        <p className="text-pool-400 text-xs pl-3.5">Write a session in plain text — get an AI preview and a printable sheet</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Input section */}
        <div className="px-4 pt-4 space-y-3">
          {/* Date row */}
          <div>
            <label className="text-xs text-pool-400 block mb-1">Date</label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2.5 text-sm focus:border-accent-500 focus:outline-none"
            />
          </div>

          {/* Session text */}
          <div>
            <label className="text-xs text-pool-400 block mb-1">Session</label>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="Type your session here — as free or as structured as you like.&#10;&#10;e.g. Warm up 400 easy, 4x100 drill. Main set 6x400 on 5:30 threshold, 30s extra rest for anyone coming back from illness. Finish 8x50 sprint off 1:30. Cool down 200 easy."
              rows={7}
              className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2.5 text-sm focus:border-accent-500 focus:outline-none resize-none leading-relaxed"
            />
          </div>

          <button
            onClick={analyse}
            disabled={loading || !text.trim()}
            className="w-full bg-accent-600 hover:bg-accent-500 active:bg-accent-700 disabled:opacity-40 rounded-xl py-3 text-sm font-semibold transition-colors"
          >
            {loading ? 'Analysing…' : 'Preview & Analyse'}
          </button>

          {error && (
            <p className="text-red-400 text-sm bg-red-900/20 rounded-xl px-3 py-2">{error}</p>
          )}
        </div>

        {/* Results */}
        {result && (
          <div className="px-4 pt-5 pb-6 space-y-4">
            {/* Session title + meta */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-bold text-base text-pool-200">{result.parsed?.title}</h2>
                <div className="flex items-center gap-2 mt-1">
                  {result.parsed?.energy_focus && (
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${ENERGY_COLOURS[result.parsed.energy_focus] || 'bg-pool-700 text-pool-400 border-pool-600'}`}>
                      {displayEnergy(result.parsed.energy_focus).label}
                    </span>
                  )}
                  {result.parsed?.total_volume_m && (
                    <span className="text-xs text-pool-400">{result.parsed.total_volume_m}</span>
                  )}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={printSheet}
                  className="bg-pool-700 border border-pool-600 hover:border-accent-500 rounded-xl px-3 py-2 text-xs font-semibold transition-colors"
                >
                  Print sheet
                </button>
                {saved ? (
                  <span className="bg-green-900/40 border border-green-800 text-green-300 rounded-xl px-3 py-2 text-xs font-semibold">
                    Saved ✓
                  </span>
                ) : (
                  <button
                    onClick={saveAsSession}
                    disabled={saving}
                    className="bg-accent-600 hover:bg-accent-500 disabled:opacity-40 rounded-xl px-3 py-2 text-xs font-semibold transition-colors"
                  >
                    {saving ? 'Saving…' : 'Save session'}
                  </button>
                )}
              </div>
            </div>

            {/* Warm up / cool down */}
            {(result.parsed?.warm_up || result.parsed?.cool_down) && (
              <div className="grid grid-cols-2 gap-2">
                {result.parsed.warm_up && (
                  <div className="bg-pool-700 border border-pool-600 rounded-xl p-3">
                    <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-1.5">Warm Up</p>
                    <p className="text-sm text-pool-200">{result.parsed.warm_up}</p>
                  </div>
                )}
                {result.parsed.cool_down && (
                  <div className="bg-pool-700 border border-pool-600 rounded-xl p-3">
                    <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-1.5">Cool Down</p>
                    <p className="text-sm text-pool-200">{result.parsed.cool_down}</p>
                  </div>
                )}
              </div>
            )}

            {/* Groups */}
            {result.parsed?.groups && (
              <div>
                <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-2">Main Set</p>
                <div className="space-y-2">
                  {Object.entries(result.parsed.groups).map(([num, grp]) => (
                    <div key={num} className="bg-pool-700 border border-pool-600 rounded-xl overflow-hidden">
                      <div className={`flex items-baseline gap-2 px-3 py-2 border-b border-pool-600 ${
                        num === '1' ? 'border-l-2 border-l-accent-600' :
                        num === '2' ? 'border-l-2 border-l-amber-600' :
                        'border-l-2 border-l-green-700'
                      }`}>
                        <span className="font-bold text-sm">Group {num}</span>
                        <span className="text-xs text-pool-400">{grp.label}</span>
                      </div>
                      <ul className="px-3 py-2 space-y-1.5">
                        {(grp.sets || []).map((s, i) => (
                          <li key={i} className="text-sm text-pool-200 flex gap-2">
                            <span className="text-pool-600 shrink-0">›</span>
                            <span>{s}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Plan alignment */}
            {result.plan_alignment && (
              <div className="bg-pool-700 border border-pool-600 rounded-xl p-3">
                <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-1.5">Plan Alignment</p>
                <p className="text-sm text-pool-200 leading-relaxed">{result.plan_alignment}</p>
              </div>
            )}

            {/* Per swimmer */}
            {result.per_swimmer && result.per_swimmer.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-2">
                  Swimmer Adaptations
                  <span className="ml-2 font-normal normal-case text-pool-400">({result.per_swimmer.length} swimmers)</span>
                </p>
                <div className="space-y-1.5">
                  {result.per_swimmer.map((sw, i) => (
                    <div key={i} className="bg-pool-700 border border-pool-600 rounded-xl px-3 py-2.5 flex items-start gap-3">
                      <div className={`shrink-0 mt-0.5 text-xs font-bold rounded-md px-1.5 py-0.5 ${
                        sw.suggested_group === 1 ? 'bg-accent-600/20 text-accent-400' :
                        sw.suggested_group === 2 ? 'bg-amber-900/30 text-amber-400' :
                        'bg-green-900/30 text-green-400'
                      }`}>G{sw.suggested_group}</div>
                      <div className="flex-1 min-w-0">
                        <span className="font-semibold text-sm text-pool-200">{sw.name}</span>
                        {sw.note && <p className="text-xs text-pool-400 mt-0.5 leading-relaxed">{sw.note}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Expected effects */}
            {result.expected_effects && (
              <div className="bg-accent-600/10 border border-accent-600/30 rounded-xl p-3">
                <p className="text-xs font-semibold text-accent-400 uppercase tracking-wide mb-1.5">Expected Effects</p>
                <p className="text-sm text-pool-200 leading-relaxed">{result.expected_effects}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
