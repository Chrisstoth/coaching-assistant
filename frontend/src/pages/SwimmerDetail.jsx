import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { SWIM_EVENTS } from '../swimEvents'
import VoiceInput from '../components/VoiceInput'
import ObservationsTab from '../components/ObservationsTab'

const TABS = ['Overview', 'Racing', 'Observations', 'Attendance', 'Times', 'Analysis', 'Context']

const VOLUME_COLOURS = {
  aerobic: 'bg-blue-500', threshold: 'bg-yellow-500', vo2: 'bg-orange-500',
  race_pace: 'bg-purple-500', lact_tol: 'bg-red-500', short_race_pace: 'bg-pink-500',
  kicking: 'bg-teal-500', sprint: 'bg-green-500',
}
const VOLUME_LABELS = {
  aerobic: 'Aer', threshold: 'Thr', vo2: 'VO2', race_pace: 'RP',
  lact_tol: 'LT', short_race_pace: 'SRP', kicking: 'Kck', sprint: 'Spr',
}
const PHASE_COLOURS = {
  base: 'text-blue-300', build: 'text-green-300', peak: 'text-orange-300',
  taper: 'text-yellow-300', competition: 'text-red-300', recovery: 'text-teal-300',
}

function fmtTime(s) {
  if (!s) return '—'
  const mins = Math.floor(s / 60)
  const secs = (s % 60).toFixed(2).padStart(5, '0')
  return mins > 0 ? `${mins}:${secs}` : `${secs}s`
}

function BlockStatusCard({ status }) {
  const { current_meso, group, group_intent, weeks, benchmarks, recent_observations } = status
  const [expandedWeek, setExpandedWeek] = useState(null)

  const recentWeeks = weeks.slice(-6)
  const activeWeeks = recentWeeks.filter(w => w.total > 0)

  // Trend: compare last 2 active weeks
  let loadTrend = null
  if (activeWeeks.length >= 2) {
    const last = activeWeeks[activeWeeks.length - 1].total
    const prev = activeWeeks[activeWeeks.length - 2].total
    const pct = prev > 0 ? Math.round(((last - prev) / prev) * 100) : null
    if (pct !== null) loadTrend = { pct, up: pct >= 5, down: pct <= -5 }
  }

  return (
    <section className="bg-pool-800 rounded-xl p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-sm text-pool-200">Current Block</h3>
          {current_meso ? (
            <p className={`text-xs mt-0.5 ${PHASE_COLOURS[current_meso.phase_type] || 'text-pool-400'}`}>
              {current_meso.name} · Week {current_meso.week_in}/{current_meso.total_weeks}
            </p>
          ) : (
            <p className="text-xs text-pool-500 mt-0.5">No active block</p>
          )}
        </div>
        {group && (
          <span className="text-xs font-semibold bg-accent-600/30 text-accent-300 rounded-full px-2 py-0.5">{group}</span>
        )}
      </div>

      {/* Group intent */}
      {group_intent && (
        <p className="text-xs text-pool-300 leading-relaxed border-l-2 border-accent-600/50 pl-3">
          {group_intent}
        </p>
      )}

      {/* Weekly load */}
      {activeWeeks.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs text-pool-500">Weekly load (last 6 weeks)</p>
            {loadTrend && (
              <span className={`text-xs font-semibold ${loadTrend.up ? 'text-green-400' : loadTrend.down ? 'text-red-400' : 'text-pool-400'}`}>
                {loadTrend.up ? '↑' : loadTrend.down ? '↓' : '→'} {Math.abs(loadTrend.pct)}% vs prev week
              </span>
            )}
          </div>
          <div className="flex gap-1.5">
            {recentWeeks.map(w => (
              <button
                key={w.week}
                onClick={() => setExpandedWeek(expandedWeek === w.week ? null : w.week)}
                className={`flex-1 rounded-lg p-1.5 text-center transition-colors ${expandedWeek === w.week ? 'bg-pool-600' : 'bg-pool-700/60'}`}
              >
                <p className="text-xs text-pool-500 mb-1">{w.week.replace(/\d{4}-W/, 'W')}</p>
                {w.total > 0 ? (
                  <>
                    {/* Stacked colour bar */}
                    <div className="flex rounded-sm overflow-hidden h-1.5 mb-1">
                      {Object.entries(w.volumes).map(([k, v]) =>
                        v > 0 ? (
                          <div
                            key={k}
                            className={VOLUME_COLOURS[k] || 'bg-pool-500'}
                            style={{ width: `${(v / w.total) * 100}%` }}
                          />
                        ) : null
                      )}
                    </div>
                    <p className="text-xs font-semibold text-pool-200">{(w.total / 1000).toFixed(1)}k</p>
                    <p className="text-xs text-pool-500">{w.sessions}s</p>
                  </>
                ) : (
                  <p className="text-xs text-pool-700">—</p>
                )}
              </button>
            ))}
          </div>
          {/* Expanded week breakdown */}
          {expandedWeek && (() => {
            const w = recentWeeks.find(x => x.week === expandedWeek)
            if (!w || w.total === 0) return null
            return (
              <div className="mt-2 bg-pool-700/40 rounded-lg p-2 flex flex-wrap gap-2">
                {Object.entries(w.volumes).map(([k, v]) =>
                  v > 0 ? (
                    <div key={k} className="flex items-center gap-1">
                      <span className={`w-2 h-2 rounded-full ${VOLUME_COLOURS[k]}`} />
                      <span className="text-xs text-pool-300">{VOLUME_LABELS[k]} {v.toLocaleString()}m</span>
                    </div>
                  ) : null
                )}
              </div>
            )
          })()}
        </div>
      )}

      {/* Benchmarks */}
      {benchmarks.length > 0 && (
        <div>
          <p className="text-xs text-pool-500 mb-1.5">Benchmarks</p>
          <div className="space-y-1.5">
            {benchmarks.slice(0, 3).map(bm => (
              <div key={bm.category} className="flex items-center justify-between">
                <span className="text-xs text-pool-300 capitalize">{bm.category}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-pool-200">{fmtTime(bm.entries[0]?.time_seconds)}</span>
                  {bm.trend && (
                    <span className={`text-xs ${bm.trend === 'improving' ? 'text-green-400' : bm.trend === 'slower' ? 'text-red-400' : 'text-pool-500'}`}>
                      {bm.trend === 'improving' ? '↑' : bm.trend === 'slower' ? '↓' : '→'}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent observations */}
      {recent_observations.length > 0 && (
        <div>
          <p className="text-xs text-pool-500 mb-1.5">Recent observations</p>
          <div className="space-y-1">
            {recent_observations.slice(0, 2).map((o, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-xs text-pool-600 shrink-0 w-16">{o.date?.slice(5)}</span>
                <span className="text-xs text-pool-400 leading-relaxed line-clamp-2">{o.content}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function ProfileProgressCard({ status, onOpenWizard }) {
  if (!status) return null
  const complete = status.state === 'complete'
  const started = status.state === 'in_progress'
  const tone = complete
    ? 'border-green-700/50 bg-green-900/10'
    : started
    ? 'border-amber-700/50 bg-amber-900/10'
    : 'border-pool-700 bg-pool-800'
  const accent = complete ? 'text-green-300' : started ? 'text-amber-300' : 'text-pool-300'

  return (
    <section className={`rounded-xl border p-4 space-y-4 ${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold text-sm text-pool-100">Profile foundation</h3>
            <span className={`text-xs font-semibold ${accent}`}>
              {status.completed_areas}/{status.total_areas} areas
            </span>
          </div>
          <div className="h-1.5 bg-pool-700 rounded-full overflow-hidden mt-2">
            <div
              className={`h-full rounded-full ${complete ? 'bg-green-500' : 'bg-amber-500'}`}
              style={{ width: `${status.completion_percent}%` }}
            />
          </div>
          <p className={`text-xs font-medium mt-2 ${accent}`}>{status.label}</p>
          <p className="text-xs text-pool-400 mt-1 leading-relaxed">
            {complete
              ? 'Ready to use for planning. New coaching notes can refine this foundation without replacing what is already known.'
              : 'Finish these core coaching areas once. The profile can then keep developing through notes and observations.'}
          </p>
        </div>
      </div>

      {status.missing_areas?.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-pool-500 mb-1.5">Still to cover</p>
          <div className="flex flex-wrap gap-1.5">
            {status.missing_areas.map(area => (
              <span key={area} className="text-[10px] bg-pool-800/80 border border-pool-700 rounded-full px-2 py-1 text-pool-300">
                {area}
              </span>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={onOpenWizard}
        className="w-full bg-accent-600 hover:bg-accent-500 rounded-lg py-2.5 text-sm font-semibold transition-colors"
      >
        {status.next_action}
      </button>

      <div className="border-t border-pool-700/70 pt-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-pool-300">Living profile</p>
            <p className="text-[10px] text-pool-500 mt-0.5">Built from evidence over the season; not required to finish the foundation.</p>
          </div>
          <span className="text-xs text-pool-400">{status.living_built}/{status.living_total}</span>
        </div>
        <div className="grid grid-cols-2 gap-1.5 mt-2">
          {status.living_sections?.map(section => (
            <div key={section.key} className="flex items-center gap-1.5 text-xs">
              <span className={section.built ? 'text-green-400' : 'text-pool-600'}>{section.built ? '✓' : '○'}</span>
              <span className={section.built ? 'text-pool-300' : 'text-pool-500'}>{section.label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export default function SwimmerDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [swimmer, setSwimmer] = useState(null)
  const [tab, setTab] = useState('Overview')
  const [conversation, setConversation] = useState([])
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [times, setTimes] = useState([])
  const [analyses, setAnalyses] = useState([])
  const [synthesising, setSynthesising] = useState(false)
  const [observations, setObservations] = useState([])
  const [obsFilter, setObsFilter] = useState('all')
  const [raceProfiles, setRaceProfiles] = useState([])
  const [trainingProfiles, setTrainingProfiles] = useState([])
  const [showRaceHistory, setShowRaceHistory] = useState(false)
  const [showTrainingHistory, setShowTrainingHistory] = useState(false)
  const [showBioHistory, setShowBioHistory] = useState(false)
  const [biologicalProfiles, setBiologicalProfiles] = useState([])
  const [technicalProfiles, setTechnicalProfiles] = useState([])
  const [synthBio, setSynthBio] = useState(false)
  const [synthTech, setSynthTech] = useState(false)
  const [techError, setTechError] = useState(null)
  const [perfAnalyses, setPerfAnalyses] = useState([])
  const [synthPerf, setSynthPerf] = useState(false)
  const [showPerfHistory, setShowPerfHistory] = useState(false)
  const [loadEvents, setLoadEvents] = useState([])
  const [loadForm, setLoadForm] = useState({ event_type: 'competition', date_from: new Date().toISOString().split('T')[0], date_to: '', severity: 2, description: '', resolved: true })
  const [showLoadForm, setShowLoadForm] = useState(false)
  const [readiness, setReadiness] = useState(null)
  const [generatingReadiness, setGeneratingReadiness] = useState(false)
  const [bioError, setBioError] = useState(null)
  const [perfError, setPerfError] = useState(null)
  const [readinessError, setReadinessError] = useState(null)
  const [swimmerContext, setSwimmerContext] = useState(null)
  const [attendanceStats, setAttendanceStats] = useState(null)
  const [allSlots, setAllSlots] = useState([])
  const [attendingIds, setAttendingIds] = useState(new Set())
  const [exceptions, setExceptions] = useState([])
  const [excForm, setExcForm] = useState({ reason: 'holiday', date_from: '', date_to: '', notes: '' })
  const [savingSlots, setSavingSlots] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [editForm, setEditForm] = useState(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [editingEvents, setEditingEvents] = useState(false)
  const [eventsForm, setEventsForm] = useState([])
  const [newEvent, setNewEvent] = useState({ event: '', course: 'SCM' })
  const [savingEvents, setSavingEvents] = useState(false)
  const [racingNarrative, setRacingNarrative] = useState('')
  const [racingNarrativeDraft, setRacingNarrativeDraft] = useState('')
  const [savingNarrative, setSavingNarrative] = useState(false)
  const [raceObs, setRaceObs] = useState([])
  const [newMeetObs, setNewMeetObs] = useState({ date: '', event: '', content: '' })
  const [addingMeetObs, setAddingMeetObs] = useState(false)
  const [benchmarks, setBenchmarks] = useState([])
  const [targets, setTargets] = useState([])
  const [blockStatus, setBlockStatus] = useState(null)
  const [adaptationReview, setAdaptationReview] = useState(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [taperResult, setTaperResult] = useState(null)
  const [taperLoading, setTaperLoading] = useState(false)
  const [skillHistory, setSkillHistory] = useState(null)
  const [skillHistoryLoading, setSkillHistoryLoading] = useState(false)
  const [showBenchmarkForm, setShowBenchmarkForm] = useState(false)
  const [benchmarkForm, setBenchmarkForm] = useState({ distance: 100, stroke: 'free', effort: 'max', time_seconds: '', date: new Date().toISOString().split('T')[0], notes: '' })
  const [savingBenchmark, setSavingBenchmark] = useState(false)
  const [showTargetForm, setShowTargetForm] = useState(false)
  const [targetForm, setTargetForm] = useState({ label: '', description: '', distance: '', stroke: '', effort: '', target_time_seconds: '', deadline: '' })
  const [savingTarget, setSavingTarget] = useState(false)

  useEffect(() => {
    api.getSwimmer(id).then((s) => {
      setSwimmer(s)
      setEditForm({
        name: s.name,
        dob: s.dob || '',
        status: s.status || 'active'
      })
    })
  }, [id])

  useEffect(() => {
    if (tab === 'Observations') api.getObservations(id).then(setObservations)
    if (tab === 'Racing') {
      api.getRacingNarrative(id).then(r => { setRacingNarrative(r.narrative || ''); setRacingNarrativeDraft(r.narrative || '') })
      api.getRaceObservations(id).then(setRaceObs)
    }
    if (tab === 'Times') api.getSwimmerTimes(id).then(setTimes)
    if (tab === 'Analysis') api.getAnalyses(id).then(setAnalyses)
    if (tab === 'Overview') {
      api.getRaceProfiles(id).then(setRaceProfiles)
      api.getTrainingProfiles(id).then(setTrainingProfiles)
      api.getBiologicalProfiles(id).then(setBiologicalProfiles)
      api.getTechnicalProfiles(id).then(setTechnicalProfiles)
      api.getPerformanceAnalyses(id).then(setPerfAnalyses)
      api.getAttendanceStats(id).then(setAttendanceStats).catch(() => {})
      api.getCurrentBenchmarks(id).then(setBenchmarks).catch(() => {})
      api.getTargets(id).then(setTargets).catch(() => {})
      api.getBlockStatus(id).then(setBlockStatus).catch(() => {})
    }
    if (tab === 'Context') {
      api.getSwimmerContext(id).then(setSwimmerContext)
    }
    if (tab === 'Attendance') {
      api.getSwimmerSlots(id).then((slots) => {
        setAllSlots(slots)
        setAttendingIds(new Set(slots.filter((s) => s.attending).map((s) => s.id)))
      })
      api.getSwimmerExceptions(id).then(setExceptions)
      api.getLoadEvents(id).then(setLoadEvents)
    }
  }, [tab, id])

  const toggleSlot = (slotId) => {
    setAttendingIds((prev) => {
      const next = new Set(prev)
      next.has(slotId) ? next.delete(slotId) : next.add(slotId)
      return next
    })
  }

  const saveSlots = async () => {
    setSavingSlots(true)
    await api.setSwimmerSlots(id, [...attendingIds])
    setSavingSlots(false)
  }

  const addException = async () => {
    if (!excForm.date_from || !excForm.date_to) return
    const exc = await api.addException(id, excForm)
    setExceptions((prev) => [...prev, exc])
    setExcForm({ reason: 'holiday', date_from: '', date_to: '', notes: '' })
  }

  const removeException = async (excId) => {
    await api.deleteException(id, excId)
    setExceptions((prev) => prev.filter((e) => e.id !== excId))
  }

  const saveSwimmerEdit = async () => {
    if (!editForm) return
    setSavingEdit(true)
    try {
      const updated = await api.updateSwimmer(id, editForm)
      setSwimmer(updated)
      setShowEditModal(false)
    } catch (e) {
      alert(`Error saving: ${e.message}`)
    }
    setSavingEdit(false)
  }

  const deleteSwimmer = async () => {
    setDeleting(true)
    try {
      await api.deleteSwimmer(id)
      window.location.href = '/swimmers'
    } catch (e) {
      alert(`Error deleting: ${e.message}`)
      setDeleting(false)
    }
  }

  const sendMessage = async () => {
    if (!message.trim()) return
    setSending(true)
    const draft = message
    setMessage('')
    setConversation((prev) => [...prev, { role: 'coach', message: draft }])
    try {
      const res = await api.profileChat(id, draft)
      setConversation((prev) => [...prev, { role: 'ai', message: res.reply }])
    } catch (e) {
      setConversation((prev) => [...prev, { role: 'ai', message: `Error: ${e.message}` }])
    }
    setSending(false)
  }

  const doSynthesise = async () => {
    setSynthesising(true)
    await api.synthesiseProfile(id)
    const updated = await api.getSwimmer(id)
    setSwimmer(updated)
    setSynthesising(false)
  }

  if (!swimmer) return <div className="p-4 text-pool-400">Loading...</div>

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="bg-pool-800 px-4 pt-4 pb-0">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-3 flex-1">
            <Link to="/swimmers" className="text-pool-400 text-2xl">‹</Link>
            <div>
              <h1 className="text-lg font-bold">{swimmer.name}</h1>
              <p className="text-pool-400 text-xs">
                Age {swimmer.age_group}{swimmer.school_year ? ` (Yr ${swimmer.school_year})` : ' (post school)'} · {swimmer.target_events?.map((e) => typeof e === 'object' ? e.event : e).join(', ')}
              </p>
              {swimmer.status && swimmer.status !== 'active' && (
                <p className={`text-xs mt-1 font-semibold capitalize ${
                  swimmer.status === 'sabbatical' ? 'text-yellow-400' : 'text-red-400'
                }`}>
                  {swimmer.status === 'sabbatical' ? 'On Sabbatical' : 'Long-term Injury'}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={() => setShowEditModal(true)}
            className="text-pool-400 hover:text-accent-400 px-3 py-1.5 text-sm"
          >
            Edit
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-pool-700 -mx-4 px-4 overflow-x-auto scrollbar-none" style={{scrollbarWidth:'none',msOverflowStyle:'none'}}>
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-shrink-0 px-3 py-2 text-sm whitespace-nowrap border-b-2 transition-colors ${
                tab === t ? 'border-accent-400 text-accent-400' : 'border-transparent text-pool-400'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'Overview' && (
          <div className="space-y-4">

            <ProfileProgressCard
              status={swimmer.profile_status}
              onOpenWizard={() => navigate(`/swimmers/${id}/profile-wizard`)}
            />

            {/* Block Status */}
            {blockStatus && (
              <BlockStatusCard status={blockStatus} />
            )}

            {/* Adaptation Review */}
            {!adaptationReview && (
              <button
                onClick={async () => {
                  setReviewLoading(true)
                  try {
                    const res = await api.reviewSwimmerSkill({ swimmer_id: swimmer.id })
                    setAdaptationReview(res.reply)
                  } catch (e) {
                    alert(`Review failed: ${e.message}`)
                  }
                  setReviewLoading(false)
                }}
                disabled={reviewLoading}
                className="w-full bg-pool-800 hover:bg-pool-700 border border-pool-700 hover:border-accent-600/50 rounded-xl py-3 text-sm font-medium text-pool-300 disabled:opacity-40 transition-colors"
              >
                {reviewLoading ? 'Generating adaptation review…' : 'Adaptation Review'}
              </button>
            )}
            {adaptationReview && (
              <div className="bg-pool-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-accent-400 uppercase tracking-wide">Adaptation Review</p>
                  <button onClick={() => setAdaptationReview(null)} className="text-xs text-pool-500 hover:text-pool-300">Dismiss</button>
                </div>
                <div className="text-sm text-pool-200 leading-relaxed whitespace-pre-wrap space-y-1">
                  {adaptationReview.split('\n').map((line, i) => {
                    if (line.startsWith('**') && line.endsWith('**')) {
                      return <p key={i} className="font-semibold text-white mt-3 first:mt-0">{line.replace(/\*\*/g, '')}</p>
                    }
                    return line.trim() ? <p key={i} className="text-pool-300">{line}</p> : null
                  })}
                </div>
              </div>
            )}

            {/* Taper Planning */}
            {!taperResult && (
              <button
                onClick={async () => {
                  setTaperLoading(true)
                  try {
                    const res = await api.planTaperSkill({ swimmer_id: swimmer.id })
                    setTaperResult(res.reply)
                  } catch (e) {
                    alert(`Taper planning failed: ${e.message}`)
                  }
                  setTaperLoading(false)
                }}
                disabled={taperLoading}
                className="w-full bg-pool-800 hover:bg-pool-700 border border-pool-700 hover:border-yellow-600/50 rounded-xl py-3 text-sm font-medium text-pool-300 disabled:opacity-40 transition-colors"
              >
                {taperLoading ? 'Generating taper plan…' : 'Plan Taper'}
              </button>
            )}
            {taperResult && (
              <div className="bg-pool-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-yellow-400 uppercase tracking-wide">Taper Plan</p>
                  <button onClick={() => setTaperResult(null)} className="text-xs text-pool-500 hover:text-pool-300">Dismiss</button>
                </div>
                <div className="text-sm text-pool-200 leading-relaxed whitespace-pre-wrap space-y-1">
                  {taperResult.split('\n').map((line, i) => {
                    if (line.startsWith('**') && line.endsWith('**')) {
                      return <p key={i} className="font-semibold text-white mt-3 first:mt-0">{line.replace(/\*\*/g, '')}</p>
                    }
                    return line.trim() ? <p key={i} className="text-pool-300">{line}</p> : null
                  })}
                </div>
              </div>
            )}

            {/* Skill History */}
            <div className="bg-pool-800 rounded-xl overflow-hidden">
              <button
                onClick={async () => {
                  if (skillHistory !== null) { setSkillHistory(null); return }
                  setSkillHistoryLoading(true)
                  try {
                    const res = await api.getSwimmerSkillHistory(swimmer.id)
                    setSkillHistory(res)
                  } catch (e) {
                    setSkillHistory([])
                  }
                  setSkillHistoryLoading(false)
                }}
                className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-pool-300 hover:text-pool-100 transition-colors"
              >
                <span>Skill History</span>
                <span className="text-pool-500 text-xs">{skillHistory !== null ? '▲ Hide' : skillHistoryLoading ? 'Loading…' : '▼ Show'}</span>
              </button>
              {skillHistory !== null && (
                <div className="px-4 pb-4 space-y-3 border-t border-pool-700">
                  {skillHistory.length === 0 ? (
                    <p className="text-xs text-pool-500 pt-3">No skill outputs recorded yet.</p>
                  ) : (
                    skillHistory.map((item) => (
                      <div key={item.id} className="pt-3 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-accent-400 capitalize">{item.skill_type.replace(/_/g, ' ')}</span>
                          <span className="text-xs text-pool-500">{new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}</span>
                        </div>
                        <p className="text-xs text-pool-300 leading-relaxed whitespace-pre-wrap">
                          {item.brief_output || item.full_output?.slice(0, 300) + (item.full_output?.length > 300 ? '…' : '')}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Attendance Stats */}
            {attendanceStats && attendanceStats.overall_total > 0 && (
              <section className="bg-pool-800 rounded-xl p-4 space-y-3">
                <h3 className="font-semibold text-sm text-pool-300">Attendance</h3>
                <div className="flex gap-4">
                  <div className="flex-1 bg-pool-700/50 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-white">{attendanceStats.overall_pct}%</p>
                    <p className="text-xs text-pool-400 mt-0.5">overall</p>
                    <p className="text-xs text-pool-500">{attendanceStats.overall_attended}/{attendanceStats.overall_total} sessions</p>
                  </div>
                  {attendanceStats.four_week_total > 0 && (
                    <div className="flex-1 bg-pool-700/50 rounded-lg p-3 text-center">
                      <p className={`text-2xl font-bold ${attendanceStats.four_week_pct >= 80 ? 'text-green-400' : attendanceStats.four_week_pct >= 60 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {attendanceStats.four_week_pct}%
                      </p>
                      <p className="text-xs text-pool-400 mt-0.5">last 4 weeks</p>
                      <p className="text-xs text-pool-500">{attendanceStats.four_week_attended}/{attendanceStats.four_week_total} sessions</p>
                    </div>
                  )}
                </div>

                {/* Weekly bar chart */}
                {attendanceStats.weekly?.length > 0 && (
                  <div>
                    <p className="text-xs text-pool-500 mb-1.5">Weekly attendance</p>
                    <div className="flex items-end gap-1 h-10">
                      {attendanceStats.weekly.slice(-8).map((w) => {
                        const pct = w.total > 0 ? w.attended / w.total : 0
                        return (
                          <div key={w.week} className="flex-1 flex flex-col items-center gap-0.5" title={`${w.week}: ${w.attended}/${w.total}`}>
                            <div
                              className={`w-full rounded-sm ${pct >= 0.8 ? 'bg-green-500' : pct >= 0.5 ? 'bg-yellow-500' : pct > 0 ? 'bg-red-500' : 'bg-pool-700'}`}
                              style={{ height: `${Math.max(pct * 100, w.total > 0 ? 8 : 4)}%` }}
                            />
                          </div>
                        )
                      })}
                    </div>
                    <div className="flex gap-1 mt-0.5">
                      {attendanceStats.weekly.slice(-8).map((w) => (
                        <p key={w.week} className="flex-1 text-center text-pool-600" style={{fontSize:'9px'}}>
                          {w.week.split('-W')[1]}
                        </p>
                      ))}
                    </div>
                  </div>
                )}

                {/* Per-slot breakdown */}
                {attendanceStats.per_slot && Object.keys(attendanceStats.per_slot).length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs text-pool-500">By session slot</p>
                    {Object.entries(attendanceStats.per_slot).map(([slot, v]) => (
                      <div key={slot} className="flex items-center gap-2">
                        <p className="text-xs text-pool-300 w-28 shrink-0">{slot}</p>
                        <div className="flex-1 bg-pool-700 rounded-full h-1.5">
                          <div
                            className={`h-1.5 rounded-full ${v.pct >= 80 ? 'bg-green-500' : v.pct >= 60 ? 'bg-yellow-500' : 'bg-red-500'}`}
                            style={{ width: `${v.pct}%` }}
                          />
                        </div>
                        <p className="text-xs text-pool-400 w-16 text-right">{v.pct}% ({v.attended}/{v.total})</p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* Biological Profile — synthesis button + versioned display */}
            <section className="bg-pool-800 rounded-xl p-4 space-y-3">
              <div className="flex justify-between items-center gap-2">
                <h3 className="font-semibold text-sm text-green-400">Biological Profile</h3>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => navigate(`/swimmers/${id}/profile-wizard`)}
                    className="text-xs bg-accent-700/40 text-accent-300 hover:bg-accent-700/70 border border-accent-600/30 rounded-lg px-2.5 py-1 transition-colors"
                  >
                    {biologicalProfiles.length > 0 ? 'Reassess' : 'Build Profile'}
                  </button>
                  <button
                    onClick={async () => {
                      setSynthBio(true)
                      setBioError(null)
                      try {
                        const v = await api.synthesiseBiologicalProfile(id)
                        setBiologicalProfiles((prev) => [v, ...prev])
                      } catch (e) { setBioError(e.message) }
                      setSynthBio(false)
                    }}
                    disabled={synthBio}
                    className="text-xs text-pool-500 hover:text-pool-300 disabled:opacity-40 transition-colors"
                  >
                    {synthBio ? 'Updating…' : 'Synthesise'}
                  </button>
                </div>
              </div>
              {bioError && (
                <div className="bg-red-900/20 border border-red-800/50 rounded-lg px-3 py-2 text-xs text-red-300 leading-relaxed">
                  {bioError}
                </div>
              )}

              {biologicalProfiles.length === 0 ? (
                <p className="text-pool-400 text-xs">
                  No biological profile yet. Build it once you have observations, times, and training history — the richer the data, the better.
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-pool-500">
                      v{biologicalProfiles.length} · {biologicalProfiles[0].created_at?.split('T')[0]}
                      {biologicalProfiles[0].obs_count != null ? ` · ${biologicalProfiles[0].obs_count} obs` : ''}
                    </span>
                    {biologicalProfiles.length > 1 && (
                      <button
                        onClick={() => setShowBioHistory(!showBioHistory)}
                        className="text-xs text-pool-400 underline"
                      >
                        {showBioHistory ? 'hide history' : `history (${biologicalProfiles.length - 1})`}
                      </button>
                    )}
                  </div>
                  {biologicalProfiles[0].change_summary && (
                    <div className="bg-green-900/30 rounded-lg p-2 text-xs text-green-300 italic">
                      {biologicalProfiles[0].change_summary}
                    </div>
                  )}
                  {biologicalProfiles[0].data?.summary ? (
                    <p className="text-sm leading-relaxed text-pool-200 whitespace-pre-line">
                      {biologicalProfiles[0].data.summary}
                    </p>
                  ) : (
                    <p className="text-xs text-pool-500 italic">Profile saved but no summary generated — build a training profile first.</p>
                  )}
                  {showBioHistory && biologicalProfiles.slice(1).map((v, i) => (
                    <div key={v.id} className="border-t border-pool-700 pt-3 mt-2 opacity-60">
                      <p className="text-xs text-pool-500 mb-1">v{biologicalProfiles.length - 1 - i} · {v.created_at?.split('T')[0]}</p>
                      {v.change_summary && (
                        <p className="text-xs text-pool-400 italic">{v.change_summary}</p>
                      )}
                    </div>
                  ))}
                </>
              )}
            </section>

            {/* Technical Notes */}
            <section className="bg-pool-800 rounded-xl p-4 space-y-3">
              <div className="flex justify-between items-center">
                <h3 className="font-semibold text-sm text-sky-400">Technical Notes</h3>
                <button
                  onClick={async () => {
                    setSynthTech(true)
                    setTechError(null)
                    try {
                      const v = await api.synthesiseTechnicalProfile(id)
                      setTechnicalProfiles((prev) => [v, ...prev])
                    } catch (e) { setTechError(e.message) }
                    setSynthTech(false)
                  }}
                  disabled={synthTech}
                  className="text-xs text-pool-500 hover:text-pool-300 disabled:opacity-40 transition-colors"
                >
                  {synthTech ? 'Updating…' : technicalProfiles.length > 0 ? 'Re-synthesise' : 'Synthesise from data'}
                </button>
              </div>
              {techError && (
                <div className="bg-red-900/20 border border-red-800/50 rounded-lg px-3 py-2 text-xs text-red-300 leading-relaxed">
                  {techError}
                </div>
              )}
              {technicalProfiles.length === 0 ? (
                <p className="text-pool-400 text-xs">No technical profile yet. Synthesise from existing observations, or build it via AI Chat for a richer result.</p>
              ) : (
                <>
                  <p className="text-xs text-pool-500">
                    v{technicalProfiles.length} · {technicalProfiles[0].created_at?.split('T')[0]}
                  </p>
                  {technicalProfiles[0].change_summary && (
                    <div className="bg-sky-900/20 rounded-lg p-2 text-xs text-sky-300 italic">
                      {technicalProfiles[0].change_summary}
                    </div>
                  )}
                  {technicalProfiles[0].data && Object.values(technicalProfiles[0].data).some(Boolean) ? (
                    Object.entries(technicalProfiles[0].data).map(([k, v]) =>
                      v ? (
                        <div key={k}>
                          <span className="text-pool-400 text-xs capitalize">{k.replace(/_/g, ' ')}: </span>
                          <span className="text-sm">{typeof v === 'object' ? Object.entries(v).map(([ek, ev]) => `${ek}: ${ev}`).join(' · ') : v}</span>
                        </div>
                      ) : null
                    )
                  ) : (
                    <p className="text-xs text-pool-500 italic">Profile saved — not enough observations yet for a full technical picture.</p>
                  )}
                </>
              )}
            </section>

            {/* Performance Analysis */}
            <section className="bg-pool-800 rounded-xl p-4 space-y-3">
              <div className="flex justify-between items-center">
                <h3 className="font-semibold text-sm text-orange-400">Performance Analysis</h3>
                <div className="flex items-center gap-2">
                  {perfAnalyses.length > 0 && (
                    <button
                      onClick={async () => {
                        if (!window.confirm('Reset performance analysis? All versions will be deleted.')) return
                        await api.deleteProfileVersions(id, 'performance_analysis')
                        setPerfAnalyses([])
                      }}
                      className="text-xs text-red-400 border border-red-900 rounded-lg px-2.5 py-1 font-medium"
                    >
                      Reset
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      setSynthPerf(true)
                      setPerfError(null)
                      try {
                        const v = await api.synthesisePerformanceAnalysis(id)
                        setPerfAnalyses((prev) => [v, ...prev])
                      } catch (e) { setPerfError(e.message) }
                      setSynthPerf(false)
                    }}
                    disabled={synthPerf}
                    className="bg-orange-900/60 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                  >
                    {synthPerf ? 'Analysing...' : perfAnalyses.length > 0 ? 'Re-analyse' : 'Analyse Times'}
                  </button>
                </div>
              </div>
              {perfError && (
                <div className="bg-red-900/20 border border-red-800/50 rounded-lg px-3 py-2 text-xs text-red-300 leading-relaxed">
                  {perfError}
                </div>
              )}

              {perfAnalyses.length === 0 ? (
                <p className="text-pool-400 text-xs">
                  Run after importing times. Identifies where performance gains are available, what limits current performance, and what training would unlock it. Feeds into all session planning.
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-pool-500">
                      v{perfAnalyses.length} · {perfAnalyses[0].created_at?.split('T')[0]}
                      {perfAnalyses[0].obs_count != null ? ` · ${perfAnalyses[0].obs_count} swims` : ''}
                    </span>
                    {perfAnalyses.length > 1 && (
                      <button onClick={() => setShowPerfHistory(!showPerfHistory)} className="text-xs text-pool-400 underline">
                        {showPerfHistory ? 'hide history' : `history (${perfAnalyses.length - 1})`}
                      </button>
                    )}
                  </div>

                  {perfAnalyses[0].change_summary && (
                    <div className="bg-orange-900/20 rounded-lg p-2 text-xs text-orange-300 italic">
                      {perfAnalyses[0].change_summary}
                    </div>
                  )}

                  {/* Gains narrative — shown prominently */}
                  {perfAnalyses[0].data?.gains_narrative && (
                    <p className="text-sm leading-relaxed text-pool-200 whitespace-pre-line">
                      {perfAnalyses[0].data.gains_narrative}
                    </p>
                  )}

                  {/* Target event deep dive */}
                  {perfAnalyses[0].data?.target_event_analysis?.length > 0 && (
                    <div className="border-t border-pool-700 pt-3 space-y-3">
                      <p className="text-xs text-pool-400 font-semibold uppercase tracking-wide">Target Event Analysis</p>
                      {perfAnalyses[0].data.target_event_analysis.map((ev, i) => (
                        <div key={i} className="bg-pool-700/40 rounded-lg p-3 space-y-1.5">
                          <p className="text-sm font-semibold text-accent-300">{ev.event}</p>
                          {ev.current_level && <p className="text-xs text-pool-300">{ev.current_level}</p>}
                          {ev.trend && (
                            <p className="text-xs">
                              <span className="text-pool-500">Trend: </span>
                              <span className="text-pool-200">{ev.trend}</span>
                            </p>
                          )}
                          {ev.limiting_factor && (
                            <p className="text-xs">
                              <span className="text-pool-500">Limiter: </span>
                              <span className="text-pool-200">{ev.limiting_factor}</span>
                            </p>
                          )}
                          {ev.split_analysis && (
                            <p className="text-xs">
                              <span className="text-pool-500">Splits: </span>
                              <span className="text-pool-200">{ev.split_analysis}</span>
                            </p>
                          )}
                          {ev.next_step && (
                            <p className="text-xs text-green-300 bg-green-900/20 rounded px-2 py-1">{ev.next_step}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Training priorities */}
                  {perfAnalyses[0].data?.training_priorities?.length > 0 && (
                    <div className="space-y-2 border-t border-pool-700 pt-3">
                      <p className="text-xs text-pool-400 font-semibold uppercase tracking-wide">Training priorities</p>
                      {perfAnalyses[0].data.training_priorities.map((p, i) => (
                        <div key={i} className="bg-pool-700/50 rounded-lg p-3 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs bg-orange-900 text-orange-200 rounded-full w-5 h-5 flex items-center justify-center font-bold shrink-0">
                              {p.priority || i + 1}
                            </span>
                            <span className="text-sm font-medium">{p.focus}</span>
                          </div>
                          {p.rationale && <p className="text-xs text-pool-400 ml-7">{p.rationale}</p>}
                          {p.target_events_benefited?.length > 0 && (
                            <div className="flex flex-wrap gap-1 ml-7">
                              {p.target_events_benefited.map(ev => (
                                <span key={ev} className="text-xs bg-pool-700 rounded-full px-2 py-0.5 text-pool-300">{ev}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Opportunity events */}
                  {perfAnalyses[0].data?.opportunity_events?.length > 0 && (
                    <div className="border-t border-pool-700 pt-3 space-y-1">
                      <p className="text-xs text-pool-400 font-semibold uppercase tracking-wide">Biggest opportunity events</p>
                      <div className="flex flex-wrap gap-1.5">
                        {perfAnalyses[0].data.opportunity_events.map(ev => (
                          <span key={ev} className="text-xs bg-orange-900/40 border border-orange-700 rounded-full px-2.5 py-1 text-orange-200">{ev}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Split findings */}
                  {perfAnalyses[0].data?.split_findings && (
                    <div className="border-t border-pool-700 pt-3">
                      <p className="text-xs text-pool-400 font-semibold uppercase tracking-wide mb-1">Split patterns</p>
                      <p className="text-xs text-pool-300">{perfAnalyses[0].data.split_findings}</p>
                    </div>
                  )}

                  {showPerfHistory && perfAnalyses.slice(1).map((v, i) => (
                    <div key={v.id} className="border-t border-pool-700 pt-3 mt-2 opacity-60">
                      <p className="text-xs text-pool-500 mb-1">v{perfAnalyses.length - 1 - i} · {v.created_at?.split('T')[0]}</p>
                      {v.change_summary && <p className="text-xs text-pool-400 italic">{v.change_summary}</p>}
                    </div>
                  ))}
                </>
              )}
            </section>

            {/* Readiness / Fatigue Assessment */}
            <section className="bg-pool-800 rounded-xl p-4 space-y-3">
              <div className="flex justify-between items-center">
                <h3 className="font-semibold text-sm text-yellow-400">Readiness & Fatigue</h3>
                <button
                  onClick={async () => {
                    setGeneratingReadiness(true)
                    setReadinessError(null)
                    try { setReadiness(await api.generateReadiness(id)) }
                    catch (e) { setReadinessError(e.message) }
                    setGeneratingReadiness(false)
                  }}
                  disabled={generatingReadiness}
                  className="bg-yellow-900/60 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                >
                  {generatingReadiness ? 'Assessing...' : readiness ? 'Refresh' : 'Assess Now'}
                </button>
              </div>
              {readinessError && (
                <div className="bg-red-900/20 border border-red-800/50 rounded-lg px-3 py-2 text-xs text-red-300 leading-relaxed">
                  {readinessError}
                </div>
              )}

              {!readiness ? (
                <p className="text-pool-400 text-xs">
                  Generate a readiness assessment to see current fatigue state, short-term forecast, and session recommendations.
                  Reads recent sessions, competitions, illness, and the swimmer's recovery profile.
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <ReadinessBadge state={readiness.current_state} />
                    <span className={`text-sm font-semibold ${
                      readiness.fatigue_level === 'very_high' ? 'text-red-400' :
                      readiness.fatigue_level === 'high' ? 'text-orange-400' :
                      readiness.fatigue_level === 'moderate' ? 'text-yellow-400' : 'text-green-400'
                    }`}>
                      {readiness.fatigue_level?.replace('_', ' ')} fatigue
                    </span>
                    <span className="text-xs text-pool-500 ml-auto">as of {readiness.generated_at}</span>
                  </div>

                  <p className="text-sm leading-relaxed">{readiness.summary}</p>

                  {readiness.key_factors?.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {readiness.key_factors.map((f, i) => (
                        <span key={i} className="text-xs bg-pool-700 rounded-full px-2 py-0.5 text-pool-300">{f}</span>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-2 border-t border-pool-700 pt-3">
                    {readiness.session_recommendation && (
                      <div>
                        <span className="text-xs text-pool-400">This week: </span>
                        <span className="text-sm">{readiness.session_recommendation}</span>
                      </div>
                    )}
                    {readiness.seven_day_forecast && (
                      <div>
                        <span className="text-xs text-pool-400">7-day outlook: </span>
                        <span className="text-sm">{readiness.seven_day_forecast}</span>
                      </div>
                    )}
                    {readiness.fourteen_day_forecast && (
                      <div>
                        <span className="text-xs text-pool-400">14-day outlook: </span>
                        <span className="text-sm">{readiness.fourteen_day_forecast}</span>
                      </div>
                    )}
                    {readiness.taper_note && (
                      <div className="bg-yellow-900/20 rounded-lg p-2">
                        <span className="text-xs text-yellow-400 font-semibold">Competition prep: </span>
                        <span className="text-sm">{readiness.taper_note}</span>
                      </div>
                    )}
                    {readiness.watch_points && (
                      <div className="bg-red-900/20 rounded-lg p-2">
                        <span className="text-xs text-red-400 font-semibold">Watch: </span>
                        <span className="text-sm">{readiness.watch_points}</span>
                      </div>
                    )}
                  </div>
                </>
              )}
            </section>

            {/* Training Benchmarks & Targets */}
            <section className="bg-pool-800 rounded-xl p-4 space-y-3">
              <div className="flex justify-between items-center">
                <h3 className="font-semibold text-sm text-indigo-400">Training Benchmarks</h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowTargetForm(v => !v)}
                    className="text-xs text-pool-400 hover:text-pool-200"
                  >+ target</button>
                  <button
                    onClick={() => setShowBenchmarkForm(v => !v)}
                    className="text-xs text-indigo-400 hover:text-indigo-200"
                  >+ log time</button>
                </div>
              </div>

              {/* Add benchmark form */}
              {showBenchmarkForm && (
                <div className="bg-pool-700/50 rounded-xl p-3 space-y-2">
                  <p className="text-xs text-pool-400 font-semibold">Log a benchmark time</p>
                  <div className="grid grid-cols-3 gap-2">
                    <select value={benchmarkForm.distance} onChange={e => setBenchmarkForm(p => ({...p, distance: Number(e.target.value)}))}
                      className="bg-pool-700 rounded-lg px-2 py-2 text-sm border border-pool-600 focus:border-indigo-500 focus:outline-none">
                      {[25,50,100,200,400].map(d => <option key={d} value={d}>{d}m</option>)}
                    </select>
                    <select value={benchmarkForm.stroke} onChange={e => setBenchmarkForm(p => ({...p, stroke: e.target.value}))}
                      className="bg-pool-700 rounded-lg px-2 py-2 text-sm border border-pool-600 focus:border-indigo-500 focus:outline-none">
                      {['free','back','breast','fly','IM'].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <select value={benchmarkForm.effort} onChange={e => setBenchmarkForm(p => ({...p, effort: e.target.value}))}
                      className="bg-pool-700 rounded-lg px-2 py-2 text-sm border border-pool-600 focus:border-indigo-500 focus:outline-none">
                      {['max','threshold','aerobic'].map(e => <option key={e} value={e}>{e}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input type="number" step="0.01" placeholder="Time (seconds)" value={benchmarkForm.time_seconds}
                      onChange={e => setBenchmarkForm(p => ({...p, time_seconds: e.target.value}))}
                      className="bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-indigo-500 focus:outline-none" />
                    <input type="date" value={benchmarkForm.date}
                      onChange={e => setBenchmarkForm(p => ({...p, date: e.target.value}))}
                      className="bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-indigo-500 focus:outline-none" />
                  </div>
                  <input placeholder="Notes (optional)" value={benchmarkForm.notes}
                    onChange={e => setBenchmarkForm(p => ({...p, notes: e.target.value}))}
                    className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-indigo-500 focus:outline-none" />
                  <div className="flex gap-2">
                    <button onClick={() => setShowBenchmarkForm(false)} className="flex-1 py-2 text-sm text-pool-400">Cancel</button>
                    <button
                      disabled={savingBenchmark || !benchmarkForm.time_seconds}
                      onClick={async () => {
                        setSavingBenchmark(true)
                        try {
                          await api.logBenchmark({ swimmer_id: Number(id), ...benchmarkForm, time_seconds: Number(benchmarkForm.time_seconds) })
                          const updated = await api.getCurrentBenchmarks(id)
                          setBenchmarks(updated)
                          setShowBenchmarkForm(false)
                          setBenchmarkForm({ distance: 100, stroke: 'free', effort: 'max', time_seconds: '', date: new Date().toISOString().split('T')[0], notes: '' })
                        } catch(e) { alert(e.message) }
                        setSavingBenchmark(false)
                      }}
                      className="flex-1 bg-indigo-700 rounded-lg py-2 text-sm font-semibold disabled:opacity-40"
                    >{savingBenchmark ? 'Saving…' : 'Save'}</button>
                  </div>
                </div>
              )}

              {/* Add target form */}
              {showTargetForm && (
                <div className="bg-pool-700/50 rounded-xl p-3 space-y-2">
                  <p className="text-xs text-pool-400 font-semibold">Set a target</p>
                  <input placeholder="Label (e.g. Sub-60 100 free)" value={targetForm.label}
                    onChange={e => setTargetForm(p => ({...p, label: e.target.value}))}
                    className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-indigo-500 focus:outline-none" />
                  <input placeholder="Description (optional)" value={targetForm.description}
                    onChange={e => setTargetForm(p => ({...p, description: e.target.value}))}
                    className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-indigo-500 focus:outline-none" />
                  <div className="grid grid-cols-2 gap-2">
                    <input type="number" step="0.01" placeholder="Target time (s, optional)" value={targetForm.target_time_seconds}
                      onChange={e => setTargetForm(p => ({...p, target_time_seconds: e.target.value}))}
                      className="bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-indigo-500 focus:outline-none" />
                    <input type="date" placeholder="Deadline" value={targetForm.deadline}
                      onChange={e => setTargetForm(p => ({...p, deadline: e.target.value}))}
                      className="bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-indigo-500 focus:outline-none" />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setShowTargetForm(false)} className="flex-1 py-2 text-sm text-pool-400">Cancel</button>
                    <button
                      disabled={savingTarget || !targetForm.label.trim()}
                      onClick={async () => {
                        setSavingTarget(true)
                        try {
                          await api.createTarget({
                            swimmer_id: Number(id),
                            label: targetForm.label,
                            description: targetForm.description || null,
                            target_time_seconds: targetForm.target_time_seconds ? Number(targetForm.target_time_seconds) : null,
                            deadline: targetForm.deadline || null,
                          })
                          const updated = await api.getTargets(id)
                          setTargets(updated)
                          setShowTargetForm(false)
                          setTargetForm({ label: '', description: '', distance: '', stroke: '', effort: '', target_time_seconds: '', deadline: '' })
                        } catch(e) { alert(e.message) }
                        setSavingTarget(false)
                      }}
                      className="flex-1 bg-indigo-700 rounded-lg py-2 text-sm font-semibold disabled:opacity-40"
                    >{savingTarget ? 'Saving…' : 'Save'}</button>
                  </div>
                </div>
              )}

              {/* Benchmarks list */}
              {benchmarks.length === 0 && targets.length === 0 ? (
                <p className="text-pool-400 text-xs">No benchmarks logged yet. Use AI Chat to log times, or tap "+ log time" above.</p>
              ) : (
                <div className="space-y-2">
                  {benchmarks.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-xs text-pool-500 uppercase tracking-wide">Current benchmarks</p>
                      {benchmarks.map(b => {
                        const mins = Math.floor(b.time_seconds / 60)
                        const secs = (b.time_seconds % 60).toFixed(2).padStart(5, '0')
                        const display = mins > 0 ? `${mins}:${secs}` : `${Number(b.time_seconds).toFixed(2)}s`
                        return (
                          <div key={b.id} className="flex items-center justify-between bg-pool-700/40 rounded-lg px-3 py-2">
                            <div>
                              <span className="text-sm font-medium">{b.distance}m {b.stroke}</span>
                              <span className="text-xs text-pool-400 ml-2 capitalize">{b.effort}</span>
                            </div>
                            <div className="text-right">
                              <span className="text-sm font-mono text-indigo-300">{display}</span>
                              <p className="text-xs text-pool-500">{b.date}</p>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {targets.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      <p className="text-xs text-pool-500 uppercase tracking-wide">Targets</p>
                      {targets.map(t => (
                        <div key={t.id} className={`flex items-start justify-between rounded-lg px-3 py-2 ${t.achieved ? 'bg-green-900/20' : 'bg-pool-700/40'}`}>
                          <div className="flex-1 min-w-0">
                            <p className={`text-sm font-medium ${t.achieved ? 'line-through text-pool-400' : ''}`}>{t.label}</p>
                            {t.description && <p className="text-xs text-pool-400">{t.description}</p>}
                            {t.deadline && <p className="text-xs text-pool-500">By {t.deadline}</p>}
                          </div>
                          <div className="flex items-center gap-2 ml-2 shrink-0">
                            {t.target_time_seconds && (
                              <span className="text-xs font-mono text-indigo-300">
                                {Math.floor(t.target_time_seconds / 60) > 0
                                  ? `${Math.floor(t.target_time_seconds / 60)}:${(t.target_time_seconds % 60).toFixed(2).padStart(5, '0')}`
                                  : `${Number(t.target_time_seconds).toFixed(2)}s`}
                              </span>
                            )}
                            {!t.achieved && (
                              <button
                                onClick={async () => {
                                  await api.updateTarget(t.id, { achieved: true, achieved_date: new Date().toISOString().split('T')[0] })
                                  setTargets(prev => prev.map(x => x.id === t.id ? {...x, achieved: true} : x))
                                }}
                                className="text-xs text-green-400 border border-green-800 rounded-full px-2 py-0.5"
                              >✓</button>
                            )}
                            <button
                              onClick={async () => {
                                await api.deleteTarget(t.id)
                                setTargets(prev => prev.filter(x => x.id !== t.id))
                              }}
                              className="text-xs text-pool-600 hover:text-red-400"
                            >✕</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Target events + course bias */}
            <section className="bg-pool-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm text-accent-400">Target Events</h3>
                {!editingEvents ? (
                  <button
                    onClick={() => { setEventsForm((swimmer.target_events || []).map(e => typeof e === 'string' ? { event: e, course: 'SCM' } : e)); setEditingEvents(true) }}
                    className="text-xs text-accent-400 font-medium"
                  >
                    Edit
                  </button>
                ) : (
                  <button onClick={() => setEditingEvents(false)} className="text-xs text-pool-400">Cancel</button>
                )}
              </div>

              {!editingEvents ? (
                <>
                  {swimmer.target_events?.length > 0 ? (
                    <div className="space-y-1.5">
                      {swimmer.target_events.map((e, i) => (
                        <div key={i} className="flex justify-between items-center text-sm">
                          <span>{e.event || e}</span>
                          {e.course && (
                            <span className="text-xs bg-pool-700 rounded-full px-2 py-0.5 text-pool-300">{e.course}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-pool-400 text-sm">No target events set.</p>
                  )}
                  {swimmer.course_bias && (
                    <div className="pt-2 border-t border-pool-700">
                      <span className="text-xs text-pool-400">Course bias: </span>
                      <span className="text-sm capitalize">{swimmer.course_bias.replace('_', ' ')}</span>
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-3">
                  {/* Current events */}
                  {eventsForm.length > 0 && (
                    <div className="space-y-1.5">
                      {eventsForm.map((e, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="flex-1 text-sm">{e.event}</span>
                          <span className="text-xs bg-pool-700 rounded-full px-2 py-0.5 text-pool-300 shrink-0">{e.course}</span>
                          <button
                            onClick={() => setEventsForm(prev => prev.filter((_, idx) => idx !== i))}
                            className="text-red-400 text-sm shrink-0"
                          >✕</button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add new event row */}
                  <div className="flex gap-2 items-center">
                    <input
                      list="target-event-list"
                      value={newEvent.event}
                      onChange={e => setNewEvent(prev => ({ ...prev, event: e.target.value }))}
                      placeholder="Event name"
                      className="flex-1 bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
                    />
                    <select
                      value={newEvent.course}
                      onChange={e => setNewEvent(prev => ({ ...prev, course: e.target.value }))}
                      className="bg-pool-700 rounded-lg px-2 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
                    >
                      <option>SCM</option>
                      <option>LCM</option>
                      <option>Both</option>
                    </select>
                    <button
                      onClick={() => {
                        if (!newEvent.event.trim()) return
                        setEventsForm(prev => [...prev, { event: newEvent.event.trim(), course: newEvent.course }])
                        setNewEvent({ event: '', course: 'SCM' })
                      }}
                      className="bg-accent-600 rounded-lg px-3 py-2 text-sm font-semibold shrink-0"
                    >Add</button>
                  </div>
                  <datalist id="target-event-list">
                    {SWIM_EVENTS.map(ev => <option key={ev} value={ev} />)}
                  </datalist>

                  {/* Course bias */}
                  <div className="pt-2 border-t border-pool-700">
                    <label className="block text-xs text-pool-400 mb-1.5">Course bias</label>
                    <select
                      value={swimmer.course_bias || ''}
                      onChange={async e => {
                        const updated = await api.updateSwimmer(id, { course_bias: e.target.value || null })
                        setSwimmer(updated)
                      }}
                      className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
                    >
                      <option value="">Not set</option>
                      <option value="scm">SCM</option>
                      <option value="lcm">LCM</option>
                    </select>
                  </div>

                  <button
                    onClick={async () => {
                      setSavingEvents(true)
                      try {
                        const updated = await api.updateSwimmer(id, { target_events: eventsForm })
                        setSwimmer(updated)
                        setEditingEvents(false)
                      } catch (e) {
                        alert(e.message)
                      }
                      setSavingEvents(false)
                    }}
                    disabled={savingEvents}
                    className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-2.5 text-sm font-semibold"
                  >
                    {savingEvents ? 'Saving…' : 'Save Target Events'}
                  </button>
                </div>
              )}
            </section>

            {swimmer.physical_profile && (
              <section className="bg-pool-800 rounded-xl p-4 space-y-2">
                <h3 className="font-semibold text-sm text-accent-400">Physical Profile</h3>
                {Object.entries(swimmer.physical_profile).map(([k, v]) => (
                  <div key={k}>
                    <span className="text-pool-400 text-xs capitalize">{k.replace(/_/g, ' ')}: </span>
                    <span className="text-sm">{v}</span>
                  </div>
                ))}
              </section>
            )}

            {swimmer.psychological_profile && (
              <section className="bg-pool-800 rounded-xl p-4 space-y-2">
                <h3 className="font-semibold text-sm text-accent-400">Psychological Profile</h3>
                {Object.entries(swimmer.psychological_profile).map(([k, v]) => (
                  <div key={k}>
                    <span className="text-pool-400 text-xs capitalize">{k.replace(/_/g, ' ')}: </span>
                    <span className="text-sm">{v}</span>
                  </div>
                ))}
              </section>
            )}

            {swimmer.training_histories?.length > 0 && (
              <section className="bg-pool-800 rounded-xl p-4">
                <h3 className="font-semibold text-sm text-accent-400 mb-2">Training History</h3>
                <p className="text-sm text-pool-200 leading-relaxed">{swimmer.training_histories[0].narrative}</p>
              </section>
            )}

            {/* Race Profile */}
            {raceProfiles.length > 0 ? (
              <section className="bg-pool-800 rounded-xl p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <h3 className="font-semibold text-sm text-purple-400">Race Profile</h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={async () => {
                        if (!window.confirm('Delete all race profile versions? This cannot be undone.')) return
                        await api.deleteProfileVersions(id, 'race')
                        setRaceProfiles([])
                      }}
                      className="text-xs text-pool-600 hover:text-red-400 transition-colors"
                    >
                      Clear
                    </button>
                    <span className="text-xs text-pool-500">
                      v{raceProfiles.length} · {raceProfiles[0].created_at?.split('T')[0]}
                      {raceProfiles[0].obs_count != null ? ` · ${raceProfiles[0].obs_count} obs` : ''}
                    </span>
                    {raceProfiles.length > 1 && (
                      <button
                        onClick={() => setShowRaceHistory(!showRaceHistory)}
                        className="text-xs text-pool-400 underline"
                      >
                        {showRaceHistory ? 'hide history' : `history (${raceProfiles.length - 1})`}
                      </button>
                    )}
                  </div>
                </div>
                {raceProfiles[0].change_summary && (
                  <div className="bg-purple-900/30 rounded-lg p-2 text-xs text-purple-300 italic">
                    {raceProfiles[0].change_summary}
                  </div>
                )}
                {Object.entries(raceProfiles[0].data).map(([k, v]) =>
                  v && typeof v !== 'object' ? (
                    <div key={k}>
                      <span className="text-pool-400 text-xs capitalize">{k.replace(/_/g, ' ')}: </span>
                      <span className="text-sm">{v}</span>
                    </div>
                  ) : v && typeof v === 'object' ? (
                    <div key={k}>
                      <p className="text-pool-400 text-xs capitalize mb-1">{k.replace(/_/g, ' ')}:</p>
                      {Object.entries(v).map(([ek, ev]) => (
                        <div key={ek} className="ml-2">
                          <span className="text-pool-500 text-xs">{ek}: </span>
                          <span className="text-xs text-pool-200">{ev}</span>
                        </div>
                      ))}
                    </div>
                  ) : null
                )}
                {showRaceHistory && raceProfiles.slice(1).map((v) => (
                  <div key={v.id} className="border-t border-pool-700 pt-3 mt-2 opacity-60">
                    <p className="text-xs text-pool-500 mb-1">
                      v{raceProfiles.indexOf(v) + 1} · {v.created_at?.split('T')[0]}
                    </p>
                    {v.change_summary && (
                      <p className="text-xs text-pool-400 italic mb-2">{v.change_summary}</p>
                    )}
                  </div>
                ))}
              </section>
            ) : (
              <section className="bg-pool-800 rounded-xl p-4">
                <h3 className="font-semibold text-sm text-purple-400 mb-1">Race Profile</h3>
                <p className="text-pool-400 text-xs">No race profile yet. Add race observations then tap "Update Race Profile".</p>
              </section>
            )}

            {/* Training Profile */}
            {trainingProfiles.length > 0 ? (
              <section className="bg-pool-800 rounded-xl p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <h3 className="font-semibold text-sm text-blue-400">Training Profile</h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={async () => {
                        if (!window.confirm('Delete all training profile versions? This cannot be undone.')) return
                        await api.deleteProfileVersions(id, 'training')
                        setTrainingProfiles([])
                      }}
                      className="text-xs text-pool-600 hover:text-red-400 transition-colors"
                    >
                      Clear
                    </button>
                    <span className="text-xs text-pool-500">
                      v{trainingProfiles.length} · {trainingProfiles[0].created_at?.split('T')[0]}
                      {trainingProfiles[0].obs_count != null ? ` · ${trainingProfiles[0].obs_count} obs` : ''}
                    </span>
                    {trainingProfiles.length > 1 && (
                      <button
                        onClick={() => setShowTrainingHistory(!showTrainingHistory)}
                        className="text-xs text-pool-400 underline"
                      >
                        {showTrainingHistory ? 'hide history' : `history (${trainingProfiles.length - 1})`}
                      </button>
                    )}
                  </div>
                </div>
                {trainingProfiles[0].change_summary && (
                  <div className="bg-blue-900/30 rounded-lg p-2 text-xs text-blue-300 italic">
                    {trainingProfiles[0].change_summary}
                  </div>
                )}
                {Object.entries(trainingProfiles[0].data).map(([k, v]) =>
                  v ? (
                    <div key={k}>
                      <span className="text-pool-400 text-xs capitalize">{k.replace(/_/g, ' ')}: </span>
                      <span className="text-sm">{v}</span>
                    </div>
                  ) : null
                )}
                {showTrainingHistory && trainingProfiles.slice(1).map((v) => (
                  <div key={v.id} className="border-t border-pool-700 pt-3 mt-2 opacity-60">
                    <p className="text-xs text-pool-500 mb-1">
                      v{trainingProfiles.indexOf(v) + 1} · {v.created_at?.split('T')[0]}
                    </p>
                    {v.change_summary && (
                      <p className="text-xs text-pool-400 italic mb-2">{v.change_summary}</p>
                    )}
                  </div>
                ))}
              </section>
            ) : (
              <section className="bg-pool-800 rounded-xl p-4">
                <h3 className="font-semibold text-sm text-blue-400 mb-1">Training Profile</h3>
                <p className="text-pool-400 text-xs">No training profile yet. Add training observations then tap "Update Training Profile".</p>
              </section>
            )}

            {!swimmer.physical_profile && !swimmer.psychological_profile && raceProfiles.length === 0 && trainingProfiles.length === 0 && (
              <p className="text-pool-400 text-sm">No profile built yet. Add observations, then use the Build button above to generate one.</p>
            )}
          </div>
        )}

        {tab === 'Racing' && (
          <div className="space-y-5">
            {/* Racing Story */}
            <section className="bg-pool-800 rounded-xl p-4 space-y-3">
              <div>
                <h3 className="font-semibold text-sm text-accent-400">Racing Story</h3>
                <p className="text-xs text-pool-500 mt-0.5">Your coaching observations up to now — read by Claude in every analysis, profile synthesis, and session plan for this swimmer.</p>
              </div>
              <textarea
                value={racingNarrativeDraft}
                onChange={e => {
                  setRacingNarrativeDraft(e.target.value)
                  e.target.style.height = 'auto'
                  e.target.style.height = `${e.target.scrollHeight}px`
                }}
                className="w-full bg-pool-700 rounded-xl px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none resize-none min-h-[140px] max-h-[50vh] overflow-y-auto"
                placeholder={`Describe this swimmer's racing patterns and history as you see them.\n\ne.g. "Tom tends to go out too hard in the 100 free and fade badly on the back 25. His 200 is more controlled — he paces it better instinctively. Has gone sub-60 twice but can't replicate it consistently. Best performances when well-rested. Technically weak coming off the turns."`}
              />
              <div className="flex items-center gap-3">
                <button
                  onClick={async () => {
                    setSavingNarrative(true)
                    try {
                      await api.saveRacingNarrative(id, racingNarrativeDraft)
                      setRacingNarrative(racingNarrativeDraft)
                    } catch (e) { alert(e.message) }
                    setSavingNarrative(false)
                  }}
                  disabled={savingNarrative || racingNarrativeDraft === racingNarrative}
                  className="flex-1 bg-accent-600 disabled:opacity-40 rounded-xl py-2.5 text-sm font-semibold"
                >
                  {savingNarrative ? 'Saving…' : 'Save Racing Story'}
                </button>
                {racingNarrativeDraft !== racingNarrative && (
                  <button onClick={() => setRacingNarrativeDraft(racingNarrative)} className="text-xs text-pool-400">
                    Discard
                  </button>
                )}
              </div>
            </section>

            {/* Meet Observations */}
            <section className="bg-pool-800 rounded-xl p-4 space-y-3">
              <div>
                <h3 className="font-semibold text-sm text-accent-400">Meet Observations</h3>
                <p className="text-xs text-pool-500 mt-0.5">Add an observation after each meet. These build the longitudinal racing picture over time.</p>
              </div>

              {/* Add form */}
              <div className="space-y-2 pb-3 border-b border-pool-700">
                <div className="flex gap-2">
                  <input
                    type="date"
                    value={newMeetObs.date}
                    onChange={e => setNewMeetObs(p => ({ ...p, date: e.target.value }))}
                    className="flex-1 bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
                  />
                  <input
                    value={newMeetObs.event}
                    onChange={e => setNewMeetObs(p => ({ ...p, event: e.target.value }))}
                    placeholder="Event (optional)"
                    list="racing-event-list"
                    className="flex-1 bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
                  />
                  <datalist id="racing-event-list">
                    {SWIM_EVENTS.map(ev => <option key={ev} value={ev} />)}
                  </datalist>
                </div>
                <textarea
                  value={newMeetObs.content}
                  onChange={e => {
                    setNewMeetObs(p => ({ ...p, content: e.target.value }))
                    e.target.style.height = 'auto'
                    e.target.style.height = `${e.target.scrollHeight}px`
                  }}
                  placeholder="What did you observe? e.g. went out in 28.1, came back 33.4 — clear aerobic limiter. Good underwater off the start."
                  className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none resize-none min-h-[80px] overflow-y-auto"
                />
                <button
                  onClick={async () => {
                    if (!newMeetObs.content.trim()) return
                    setAddingMeetObs(true)
                    try {
                      const obs = await api.addObservation(id, {
                        obs_type: 'race',
                        date: newMeetObs.date || null,
                        event: newMeetObs.event.trim() || null,
                        content: newMeetObs.content.trim(),
                      })
                      setRaceObs(prev => [obs, ...prev])
                      setNewMeetObs({ date: '', event: '', content: '' })
                    } catch (e) { alert(e.message) }
                    setAddingMeetObs(false)
                  }}
                  disabled={addingMeetObs || !newMeetObs.content.trim()}
                  className="w-full bg-pool-700 border border-pool-600 rounded-xl py-2.5 text-sm font-semibold disabled:opacity-40"
                >
                  {addingMeetObs ? 'Adding…' : '+ Add Observation'}
                </button>
              </div>

              {/* Observation list */}
              {raceObs.length === 0 ? (
                <p className="text-pool-400 text-sm">No meet observations yet.</p>
              ) : (
                <div className="space-y-2">
                  {raceObs.map(o => (
                    <div key={o.id} className="bg-pool-700/50 rounded-lg p-3 space-y-1">
                      <div className="flex justify-between items-start gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          {o.date && <span className="text-xs text-pool-400">{o.date}</span>}
                          {o.event && <span className="text-xs text-accent-400 bg-accent-600/15 rounded-full px-2 py-0.5">{o.event}</span>}
                        </div>
                        <button
                          onClick={async () => {
                            await api.deleteObservation(id, o.id)
                            setRaceObs(prev => prev.filter(x => x.id !== o.id))
                          }}
                          className="text-pool-600 hover:text-red-400 text-sm shrink-0"
                        >✕</button>
                      </div>
                      <p className="text-sm text-pool-200 leading-relaxed">{o.content}</p>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {tab === 'Observations' && (
          <ObservationsTab
            swimmerId={id}
            swimmer={swimmer}
            observations={observations}
            setObservations={setObservations}
            obsFilter={obsFilter}
            setObsFilter={setObsFilter}
            onRaceProfileUpdated={(v) => setRaceProfiles((prev) => [v, ...prev])}
            onTrainingProfileUpdated={(v) => setTrainingProfiles((prev) => [v, ...prev])}
          />
        )}

        {tab === 'Attendance' && (
          <div className="space-y-5">
            {/* Session slots */}
            <section className="space-y-3">
              <div className="flex justify-between items-center">
                <h3 className="font-semibold text-sm">Regular Sessions</h3>
                <button
                  onClick={saveSlots}
                  disabled={savingSlots}
                  className="text-xs bg-accent-600 disabled:opacity-40 rounded-full px-3 py-1.5 font-semibold"
                >
                  {savingSlots ? 'Saving...' : 'Save'}
                </button>
              </div>
              {allSlots.length === 0 ? (
                <p className="text-pool-400 text-sm">No pool slots defined yet — add them in the Schedule tab first.</p>
              ) : (
                <div className="space-y-2">
                  {allSlots.map((slot) => (
                    <button
                      key={slot.id}
                      onClick={() => toggleSlot(slot.id)}
                      className={`w-full flex justify-between items-center rounded-xl p-3 text-sm transition-colors ${
                        attendingIds.has(slot.id)
                          ? 'bg-accent-600 text-white'
                          : 'bg-pool-700 text-pool-400'
                      }`}
                    >
                      <span>{slot.label}</span>
                      <span className="text-xs opacity-70">{slot.day_name} {slot.time}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* Load Events */}
            <section className="space-y-3">
              <div className="flex justify-between items-center">
                <div>
                  <h3 className="font-semibold text-sm">Load Events</h3>
                  <p className="text-pool-400 text-xs mt-0.5">Competitions, illness, injury, camps — anything that affects fatigue or readiness.</p>
                </div>
                <button
                  onClick={() => setShowLoadForm(!showLoadForm)}
                  className="text-xs bg-pool-700 rounded-full px-3 py-1.5 font-semibold"
                >
                  {showLoadForm ? 'Cancel' : '+ Add'}
                </button>
              </div>

              {loadEvents.length === 0 && !showLoadForm && (
                <p className="text-pool-400 text-xs">No load events logged. Add competitions, illness, and other significant events to improve readiness assessments.</p>
              )}

              {loadEvents.map((e) => (
                <div key={e.id} className="bg-pool-800 rounded-xl p-3">
                  <div className="flex justify-between items-start">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs rounded-full px-2 py-0.5 capitalize ${
                          e.event_type === 'competition' ? 'bg-purple-800 text-purple-200' :
                          e.event_type === 'illness' ? 'bg-red-900 text-red-200' :
                          e.event_type === 'injury' ? 'bg-orange-900 text-orange-200' :
                          e.event_type === 'camp' ? 'bg-blue-900 text-blue-200' :
                          'bg-pool-700 text-pool-300'
                        }`}>{e.event_type.replace('_', ' ')}</span>
                        <span className="text-xs text-pool-500">{'●'.repeat(e.severity)}</span>
                        {!e.resolved && <span className="text-xs text-red-400 font-medium">ongoing</span>}
                      </div>
                      <p className="text-xs text-pool-400">{e.date_from}{e.date_to && e.date_to !== e.date_from ? ` → ${e.date_to}` : ''}</p>
                      {e.description && <p className="text-sm">{e.description}</p>}
                    </div>
                    <div className="flex gap-2 ml-3">
                      {!e.resolved && (
                        <button
                          onClick={async () => {
                            const updated = await api.updateLoadEvent(id, e.id, { resolved: true })
                            setLoadEvents((prev) => prev.map((x) => x.id === e.id ? updated : x))
                          }}
                          className="text-xs text-green-400"
                        >Resolve</button>
                      )}
                      <button
                        onClick={async () => {
                          await api.deleteLoadEvent(id, e.id)
                          setLoadEvents((prev) => prev.filter((x) => x.id !== e.id))
                        }}
                        className="text-xs text-pool-600 hover:text-red-400"
                      >✕</button>
                    </div>
                  </div>
                </div>
              ))}

              {showLoadForm && (
                <div className="bg-pool-800 rounded-xl p-3 space-y-2">
                  <select
                    value={loadForm.event_type}
                    onChange={(e) => setLoadForm({ ...loadForm, event_type: e.target.value })}
                    className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
                  >
                    {['competition', 'illness', 'injury', 'travel', 'camp', 'extra_load', 'other'].map((t) => (
                      <option key={t} value={t}>{t.replace('_', ' ')}</option>
                    ))}
                  </select>

                  <div className="flex gap-2">
                    <input type="date" value={loadForm.date_from}
                      onChange={(e) => setLoadForm({ ...loadForm, date_from: e.target.value })}
                      className="flex-1 bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
                    />
                    <input type="date" value={loadForm.date_to}
                      placeholder="End date (optional)"
                      onChange={(e) => setLoadForm({ ...loadForm, date_to: e.target.value })}
                      className="flex-1 bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
                    />
                  </div>

                  <div className="flex gap-2 items-center">
                    <span className="text-xs text-pool-400">Severity:</span>
                    {[1, 2, 3].map((s) => (
                      <button
                        key={s}
                        onClick={() => setLoadForm({ ...loadForm, severity: s })}
                        className={`rounded-full px-3 py-1 text-xs font-medium ${
                          loadForm.severity === s
                            ? s === 1 ? 'bg-green-800 text-green-200'
                              : s === 2 ? 'bg-yellow-800 text-yellow-200'
                              : 'bg-red-800 text-red-200'
                            : 'bg-pool-700 text-pool-400'
                        }`}
                      >
                        {s === 1 ? 'Mild' : s === 2 ? 'Moderate' : 'Significant'}
                      </button>
                    ))}
                  </div>

                  <input
                    placeholder="Description (optional)"
                    value={loadForm.description}
                    onChange={(e) => setLoadForm({ ...loadForm, description: e.target.value })}
                    className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
                  />

                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={loadForm.resolved}
                      onChange={(e) => setLoadForm({ ...loadForm, resolved: e.target.checked })}
                      className="rounded"
                    />
                    <span className="text-pool-300">Resolved / completed</span>
                  </label>

                  <button
                    onClick={async () => {
                      const payload = { ...loadForm, date_to: loadForm.date_to || null }
                      const ev = await api.addLoadEvent(id, payload)
                      setLoadEvents((prev) => [ev, ...prev])
                      setLoadForm({ event_type: 'competition', date_from: new Date().toISOString().split('T')[0], date_to: '', severity: 2, description: '', resolved: true })
                      setShowLoadForm(false)
                    }}
                    disabled={!loadForm.date_from}
                    className="w-full bg-accent-600 disabled:opacity-40 rounded-lg py-2 text-sm font-semibold"
                  >
                    Add Load Event
                  </button>
                </div>
              )}
            </section>

            {/* Exceptions */}
            <section className="space-y-3">
              <h3 className="font-semibold text-sm">Availability</h3>
              <p className="text-pool-400 text-xs">Holiday, competition, taper rest or another planned period when this swimmer won't train.</p>

              {exceptions.map((e) => (
                <div key={e.id} className="bg-pool-800 rounded-xl p-3 flex justify-between items-center">
                  <div>
                    <p className="text-sm font-medium capitalize">{e.reason.replace('_', ' ')}</p>
                    <p className="text-pool-400 text-xs">{e.date_from} → {e.date_to}</p>
                    {e.notes && <p className="text-pool-400 text-xs">{e.notes}</p>}
                  </div>
                  <button onClick={() => removeException(e.id)} className="text-red-400 text-xs ml-3">Remove</button>
                </div>
              ))}

              <div className="bg-pool-800 rounded-xl p-3 space-y-2">
                <select
                  value={excForm.reason}
                  onChange={(e) => setExcForm({ ...excForm, reason: e.target.value })}
                  className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
                >
                  {['holiday', 'competition', 'planned_rest', 'taper_rest', 'exams', 'work', 'injury', 'other'].map((r) => (
                    <option key={r} value={r} className="capitalize">{r.replace('_', ' ')}</option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <input type="date" value={excForm.date_from}
                    onChange={(e) => setExcForm({ ...excForm, date_from: e.target.value })}
                    className="flex-1 bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
                  />
                  <input type="date" value={excForm.date_to}
                    onChange={(e) => setExcForm({ ...excForm, date_to: e.target.value })}
                    className="flex-1 bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
                  />
                </div>
                <input placeholder="Notes (optional)" value={excForm.notes}
                  onChange={(e) => setExcForm({ ...excForm, notes: e.target.value })}
                  className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
                />
                <button
                  onClick={addException}
                  disabled={!excForm.date_from || !excForm.date_to}
                  className="w-full bg-pool-600 disabled:opacity-40 rounded-lg py-2 text-sm font-semibold"
                >
                  Add Exception
                </button>
              </div>
            </section>
          </div>
        )}

        {tab === 'Times' && (
          <div className="space-y-2">
            {times.length === 0 ? (
              <p className="text-pool-400 text-sm">No times imported yet.</p>
            ) : (
              times.map((t) => (
                <div key={t.id} className="bg-pool-800 rounded-xl p-3 flex justify-between items-center">
                  <div>
                    <p className="text-sm font-medium">{t.event}</p>
                    <p className="text-pool-400 text-xs">{t.date} · {t.meet || 'Training'} · {t.round}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono font-bold text-accent-400">{t.time_display}</p>
                    {t.wa_points && <p className="text-pool-400 text-xs">{t.wa_points} pts</p>}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'Analysis' && (
          <div className="space-y-3">
            {analyses.length === 0 ? (
              <p className="text-pool-400 text-sm">No analyses yet.</p>
            ) : (
              analyses.map((a) => (
                <div key={a.id} className="bg-pool-800 rounded-xl p-4">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs bg-pool-700 rounded-full px-2 py-0.5 text-pool-400 capitalize">
                      {a.type}
                    </span>
                    <span className="text-pool-400 text-xs">{a.created_at?.split('T')[0]}</span>
                  </div>
                  <p className="text-sm leading-relaxed">{a.content}</p>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'Context' && (
          <div className="space-y-4">
            {!swimmerContext ? (
              <p className="text-pool-400 text-sm text-center py-8">Loading context...</p>
            ) : (
              <>
                {/* Breakdown summary */}
                <section className="bg-pool-800 rounded-xl p-4 space-y-3">
                  <h3 className="font-semibold text-sm text-accent-400">Context Inventory</h3>
                  <p className="text-xs text-pool-400">Everything the AI has access to for this swimmer.</p>

                  <div className="grid grid-cols-2 gap-2">
                    <ContextCard
                      label="Observations"
                      value={swimmerContext.breakdown.observations.total}
                      detail={Object.entries(swimmerContext.breakdown.observations.by_type)
                        .map(([k, v]) => `${v} ${k}`)
                        .join(' · ')}
                      ok={swimmerContext.breakdown.observations.total > 0}
                    />
                    <ContextCard
                      label="Race Times"
                      value={swimmerContext.breakdown.times}
                      detail="imported from CSV"
                      ok={swimmerContext.breakdown.times > 0}
                    />
                    <ContextCard
                      label="Race Profile"
                      value={swimmerContext.breakdown.race_profile_versions > 0
                        ? `v${swimmerContext.breakdown.race_profile_versions}`
                        : 'None'}
                      detail={swimmerContext.breakdown.race_profile_versions > 0
                        ? `${swimmerContext.breakdown.race_profile_versions} version${swimmerContext.breakdown.race_profile_versions > 1 ? 's' : ''}`
                        : 'Add race obs → Update Race Profile'}
                      ok={swimmerContext.breakdown.race_profile_versions > 0}
                    />
                    <ContextCard
                      label="Training Profile"
                      value={swimmerContext.breakdown.training_profile_versions > 0
                        ? `v${swimmerContext.breakdown.training_profile_versions}`
                        : 'None'}
                      detail={swimmerContext.breakdown.training_profile_versions > 0
                        ? `${swimmerContext.breakdown.training_profile_versions} version${swimmerContext.breakdown.training_profile_versions > 1 ? 's' : ''}`
                        : 'Add training obs → Update Training Profile'}
                      ok={swimmerContext.breakdown.training_profile_versions > 0}
                    />
                    <ContextCard
                      label="Biological Profile"
                      value={swimmerContext.breakdown.biological_profile_versions > 0
                        ? `v${swimmerContext.breakdown.biological_profile_versions}`
                        : 'None'}
                      detail={swimmerContext.breakdown.biological_profile_versions > 0
                        ? `${swimmerContext.breakdown.biological_profile_versions} version${swimmerContext.breakdown.biological_profile_versions > 1 ? 's' : ''}`
                        : 'Overview → Build Profile'}
                      ok={swimmerContext.breakdown.biological_profile_versions > 0}
                    />
                    <ContextCard
                      label="Physical Profile"
                      value={swimmerContext.breakdown.has_physical_profile ? 'Built' : 'None'}
                      detail="from AI Chat synthesis"
                      ok={swimmerContext.breakdown.has_physical_profile}
                    />
                    <ContextCard
                      label="Training History"
                      value={swimmerContext.breakdown.training_histories}
                      detail="background narratives"
                      ok={swimmerContext.breakdown.training_histories > 0}
                    />
                    <ContextCard
                      label="Target Events"
                      value={swimmerContext.breakdown.target_event_count}
                      detail="events with course preference"
                      ok={swimmerContext.breakdown.target_event_count > 0}
                    />
                    <ContextCard
                      label="Course Bias"
                      value={swimmerContext.breakdown.has_course_bias ? 'Set' : 'Not set'}
                      detail="SCM vs LCM tendency"
                      ok={swimmerContext.breakdown.has_course_bias}
                    />
                  </div>
                </section>

                {/* Assembled context text */}
                <section className="bg-pool-800 rounded-xl p-4 space-y-2">
                  <div className="flex justify-between items-center">
                    <h3 className="font-semibold text-sm text-accent-400">Assembled Context</h3>
                    <span className="text-xs text-pool-500">
                      {swimmerContext.assembled_context.length.toLocaleString()} chars
                    </span>
                  </div>
                  <p className="text-xs text-pool-400">
                    This is exactly what Claude receives when you trigger any AI feature for this swimmer.
                  </p>
                  <pre className="bg-pool-900 rounded-lg p-3 text-xs text-pool-300 leading-relaxed overflow-x-auto whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
                    {swimmerContext.assembled_context}
                  </pre>
                </section>
              </>
            )}
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {showEditModal && editForm && (
        <div className="fixed inset-0 bg-black/50 flex items-end z-50">
          <div className="w-full bg-pool-800 rounded-t-2xl p-4 space-y-4 max-h-[90vh] overflow-y-auto pb-20">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-bold">Edit Swimmer</h2>
              <button
                onClick={() => setShowEditModal(false)}
                className="text-pool-400 hover:text-white text-2xl"
              >
                ✕
              </button>
            </div>

            <div>
              <label className="block text-xs text-pool-400 mb-2">Name</label>
              <input
                type="text"
                value={editForm.name}
                onChange={(e) => setEditForm({...editForm, name: e.target.value})}
                className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs text-pool-400 mb-2">Date of Birth</label>
              <input
                type="date"
                value={editForm.dob}
                onChange={(e) => setEditForm({...editForm, dob: e.target.value})}
                className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs text-pool-400 mb-2">Status</label>
              <select
                value={editForm.status}
                onChange={(e) => setEditForm({...editForm, status: e.target.value})}
                className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
              >
                <option value="active">Active</option>
                <option value="sabbatical">Sabbatical</option>
                <option value="injury">Long-term Injury</option>
              </select>
            </div>

            <div className="space-y-3 pt-4 border-t border-pool-700">
              <div className="flex gap-2">
                <button
                  onClick={() => setShowEditModal(false)}
                  className="flex-1 bg-pool-700 rounded-lg py-2.5 font-semibold text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={saveSwimmerEdit}
                  disabled={savingEdit}
                  className="flex-1 bg-accent-600 disabled:opacity-40 rounded-lg py-2.5 font-semibold text-sm"
                >
                  {savingEdit ? 'Saving...' : 'Save'}
                </button>
              </div>

              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="w-full bg-red-900 hover:bg-red-800 rounded-lg py-2.5 font-semibold text-sm text-red-100"
              >
                Remove Swimmer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-pool-800 rounded-2xl p-6 max-w-sm space-y-4">
            <h3 className="text-lg font-bold">Remove Swimmer?</h3>
            <p className="text-pool-400 text-sm">
              Are you sure you want to remove <span className="font-semibold text-white">{swimmer.name}</span>? This cannot be undone.
            </p>
            <div className="flex gap-2 pt-4">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 bg-pool-700 rounded-lg py-2.5 font-semibold text-sm"
              >
                Cancel
              </button>
              <button
                onClick={deleteSwimmer}
                disabled={deleting}
                className="flex-1 bg-red-900 disabled:opacity-40 rounded-lg py-2.5 font-semibold text-sm"
              >
                {deleting ? 'Removing...' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ReadinessBadge({ state }) {
  const config = {
    fresh:               { label: 'Fresh',              bg: 'bg-green-800 text-green-200' },
    normal:              { label: 'Normal',             bg: 'bg-pool-600 text-pool-200' },
    fatigued:            { label: 'Fatigued',           bg: 'bg-orange-800 text-orange-200' },
    accumulating:        { label: 'Accumulating load',  bg: 'bg-yellow-800 text-yellow-200' },
    recovering_illness:  { label: 'Recovering — illness', bg: 'bg-red-800 text-red-200' },
    recovering_injury:   { label: 'Recovering — injury',  bg: 'bg-red-800 text-red-200' },
    detrained_rested:    { label: 'Detrained / rested', bg: 'bg-blue-800 text-blue-200' },
    pre_competition:     { label: 'Pre-competition',    bg: 'bg-purple-800 text-purple-200' },
  }
  const { label, bg } = config[state] || { label: state, bg: 'bg-pool-700 text-pool-300' }
  return <span className={`text-xs rounded-full px-2.5 py-1 font-medium ${bg}`}>{label}</span>
}

function ContextCard({ label, value, detail, ok }) {
  return (
    <div className={`rounded-lg p-3 space-y-0.5 ${ok ? 'bg-pool-700' : 'bg-pool-800 border border-pool-700'}`}>
      <div className="flex justify-between items-center">
        <span className="text-xs text-pool-400">{label}</span>
        <span className={`text-xs font-semibold ${ok ? 'text-accent-400' : 'text-pool-500'}`}>
          {ok ? '✓' : '–'}
        </span>
      </div>
      <p className={`text-sm font-semibold ${ok ? 'text-white' : 'text-pool-500'}`}>{value}</p>
      {detail && <p className="text-xs text-pool-500">{detail}</p>}
    </div>
  )
}
