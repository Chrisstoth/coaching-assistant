import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { DEFAULT_PRESENTATION, energyPresentation, openSessionPrint } from '../sessionPresentation'
import { buildSessionOccurrences, localIsoDate, nextSessionIndex } from '../sessionPlannerSchedule'

const ENERGY_COLOURS = {
  aerobic: 'bg-blue-900/40 text-blue-300 border-blue-800',
  threshold: 'bg-orange-900/40 text-orange-300 border-orange-800',
  speed: 'bg-red-900/40 text-red-300 border-red-800',
  recovery: 'bg-green-900/40 text-green-300 border-green-800',
  mixed: 'bg-purple-900/40 text-purple-300 border-purple-800',
}

const SESSION_DATE = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})

function occurrenceDateLabel(date) {
  const [year, month, day] = date.split('-').map(Number)
  return SESSION_DATE.format(new Date(year, month - 1, day, 12))
}

function editablePhotoDraftText(draft) {
  if (!draft) return ''
  const lines = []
  if (draft.title?.trim()) lines.push(`Title: ${draft.title.trim()}`)
  for (const [groupNum, group] of Object.entries(draft.groups || {})) {
    const description = String(group?.description || '').trim()
    const sets = Array.isArray(group?.sets) ? group.sets.join('\n') : String(group?.sets || '')
    if (description || sets.trim()) {
      lines.push(`Group ${groupNum}${description ? ` — ${description}` : ''}:\n${sets.trim()}`)
    }
  }
  if (draft.notes?.trim()) lines.push(`Coach notes: ${draft.notes.trim()}`)
  if (draft.energy_system_focus?.trim()) lines.push(`Energy focus: ${draft.energy_system_focus.trim()}`)
  return lines.join('\n\n')
}

export default function SessionPlanner() {
  const [inputMethod, setInputMethod] = useState('text')
  const [text, setText] = useState('')
  const [photoFile, setPhotoFile] = useState(null)
  const [photoDraft, setPhotoDraft] = useState(null)
  const [date, setDate] = useState(localIsoDate(new Date()))
  const [slots, setSlots] = useState([])
  const [slotsLoading, setSlotsLoading] = useState(true)
  const [poolSlotId, setPoolSlotId] = useState('')
  const [unscheduled, setUnscheduled] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(null)
  const [presentation, setPresentation] = useState(DEFAULT_PRESENTATION)
  const carouselRef = useRef(null)
  const cardRefs = useRef({})
  const scrollTimer = useRef(null)
  const initialSelectionMade = useRef(false)
  const displayEnergy = zone => energyPresentation(zone, presentation)

  useEffect(() => {
    Promise.all([
      api.getSessionPresentation().then(setPresentation).catch(() => {}),
      api.getSlots().then(setSlots).catch(() => setSlots([])).finally(() => setSlotsLoading(false)),
    ])
  }, [])

  const occurrences = useMemo(() => buildSessionOccurrences(slots), [slots])
  const upcomingIndex = useMemo(() => nextSessionIndex(occurrences), [occurrences])
  const selectedKey = unscheduled || !poolSlotId ? null : `${date}-${poolSlotId}`
  const selectedSlot = unscheduled
    ? null
    : slots.find(slot => String(slot.id) === String(poolSlotId)) || null

  useEffect(() => {
    if (slotsLoading || initialSelectionMade.current || occurrences.length === 0) return
    const next = occurrences[upcomingIndex]
    initialSelectionMade.current = true
    setDate(next.date)
    setPoolSlotId(String(next.id))
    window.requestAnimationFrame(() => {
      cardRefs.current[next.key]?.scrollIntoView({ block: 'nearest', inline: 'center' })
    })
  }, [occurrences, slotsLoading, upcomingIndex])

  useEffect(() => () => window.clearTimeout(scrollTimer.current), [])

  const clearPreview = () => {
    setResult(null)
    setSaved(null)
    setError(null)
  }

  const selectOccurrence = (occurrence, scroll = true) => {
    setUnscheduled(false)
    if (selectedKey !== occurrence.key) {
      setDate(occurrence.date)
      setPoolSlotId(String(occurrence.id))
      clearPreview()
    }
    if (scroll) {
      cardRefs.current[occurrence.key]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    }
  }

  const handleCarouselScroll = () => {
    window.clearTimeout(scrollTimer.current)
    scrollTimer.current = window.setTimeout(() => {
      const carousel = carouselRef.current
      if (!carousel) return
      const centre = carousel.getBoundingClientRect().left + carousel.clientWidth / 2
      let nearest = null
      let nearestDistance = Number.POSITIVE_INFINITY
      for (const occurrence of occurrences) {
        const card = cardRefs.current[occurrence.key]
        if (!card) continue
        const rect = card.getBoundingClientRect()
        const distance = Math.abs(rect.left + rect.width / 2 - centre)
        if (distance < nearestDistance) {
          nearest = occurrence
          nearestDistance = distance
        }
      }
      if (nearest) selectOccurrence(nearest, false)
    }, 120)
  }

  const moveSelection = direction => {
    const currentIndex = Math.max(0, occurrences.findIndex(occurrence => occurrence.key === selectedKey))
    const nextIndex = Math.min(occurrences.length - 1, Math.max(0, currentIndex + direction))
    if (occurrences[nextIndex]) selectOccurrence(occurrences[nextIndex])
  }

  const toggleUnscheduled = () => {
    if (unscheduled && occurrences[upcomingIndex]) {
      selectOccurrence(occurrences[upcomingIndex])
      return
    }
    setUnscheduled(true)
    setPoolSlotId('')
    clearPreview()
  }

  const changeDate = value => {
    setDate(value)
    clearPreview()
  }

  const changeBrief = value => {
    setText(value)
    setResult(null)
    setSaved(null)
    setError(null)
  }

  const changeInputMethod = method => {
    setInputMethod(method)
    clearPreview()
  }

  const changePhoto = file => {
    setPhotoFile(file)
    setPhotoDraft(null)
    clearPreview()
  }

  const updatePhotoDraft = (field, value) => {
    setPhotoDraft(current => ({ ...current, [field]: value }))
    clearPreview()
  }

  const updatePhotoGroup = (groupNum, field, value) => {
    setPhotoDraft(current => ({
      ...current,
      groups: {
        ...(current?.groups || {}),
        [groupNum]: { ...(current?.groups?.[groupNum] || {}), [field]: value },
      },
    }))
    clearPreview()
  }

  const removePhotoGroup = groupNum => {
    setPhotoDraft(current => ({
      ...current,
      groups: Object.fromEntries(Object.entries(current?.groups || {}).filter(([key]) => key !== groupNum)),
    }))
    clearPreview()
  }

  const addPhotoGroup = () => {
    const groups = photoDraft?.groups || {}
    const groupNum = String([1, 2, 3].find(number => !groups[String(number)]) || Object.keys(groups).length + 1)
    setPhotoDraft(current => ({
      ...current,
      groups: { ...(current?.groups || {}), [groupNum]: { description: '', sets: '' } },
    }))
    clearPreview()
  }

  const analyse = async () => {
    const draftText = editablePhotoDraftText(photoDraft)
    const hasInput = inputMethod === 'photo' ? (photoDraft ? draftText : photoFile) : text.trim()
    if (!hasInput || (!unscheduled && occurrences.length > 0 && !selectedSlot)) return
    setLoading(true)
    setError(null)
    setResult(null)
    setSaved(null)
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), inputMethod === 'photo' ? 110000 : 70000)
    try {
      if (inputMethod === 'photo' && !photoDraft) {
        const extraction = await api.extractSessionPhoto(photoFile, { signal: controller.signal })
        setPhotoDraft(extraction.draft)
        return
      }
      const data = await api.planSession({
        text: inputMethod === 'photo' ? draftText : text,
        date,
        pool_slot_id: selectedSlot?.id || null,
        squad: selectedSlot?.squad || null,
      }, { signal: controller.signal })
      setResult(data)
    } catch (e) {
      setError(e.name === 'AbortError'
        ? 'The planner took too long to respond. Please try again; your session idea is still in the box.'
        : e.message)
    } finally {
      window.clearTimeout(timeout)
      setLoading(false)
    }
  }

  const saveAsSession = async () => {
    if (!result) return
    setSaving(true)
    try {
      const parsed = result.parsed
      const groupEntries = Object.entries(parsed.groups || {})
      const groups = Object.fromEntries(groupEntries.map(([num, group], index) => {
        const lines = []
        if (index === 0 && parsed.warm_up) lines.push(`Warm up: ${parsed.warm_up}`)
        lines.push(...(Array.isArray(group.sets) ? group.sets : [group.sets]).filter(Boolean))
        if (index === groupEntries.length - 1 && parsed.cool_down) lines.push(`Cool down: ${parsed.cool_down}`)
        return [num, {
          description: group.label || `Group ${num}`,
          sets: lines.join('\n'),
          volume_breakdown: group.volume_breakdown || {},
        }]
      }))
      const individualMods = Object.fromEntries(
        (result.per_swimmer || []).filter(row => row.name && row.note).map(row => [row.name, row.note]),
      )
      const session = await api.createSession({
        date,
        title: parsed.title,
        energy_system_focus: result.energy_analysis?.energy_system_focus || parsed.energy_focus,
        energy_analysis: result.energy_analysis || null,
        coach_intent: parsed.coach_intent || result.plan_alignment,
        coach_notes: [result.plan_alignment, result.expected_effects].filter(Boolean).join('\n\n'),
        groups,
        individual_mods: individualMods,
        pool_slot_id: selectedSlot?.id || null,
        start_time: selectedSlot?.time || null,
        end_time: selectedSlot?.end_time || null,
        squad: selectedSlot?.squad || null,
        course: selectedSlot?.course || null,
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
          start_time: selectedSlot?.time || null,
          end_time: selectedSlot?.end_time || null,
          squad: selectedSlot?.squad || null,
          course: selectedSlot?.course || null,
          energy_system_focus: parsed.energy_focus,
          groups: parsed.groups || {},
          coach_intent: parsed.coach_intent || result.plan_alignment,
          energy_analysis: result.energy_analysis,
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
          {/* Timetable occurrence carousel */}
          <div>
            <div className="flex items-center justify-between gap-3 mb-1.5">
              <label className="text-xs text-pool-400">Training session</label>
              {!slotsLoading && occurrences.length > 0 && (
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => moveSelection(-1)}
                    aria-label="Previous training session"
                    className="w-7 h-7 rounded-full bg-pool-700 text-pool-300"
                  >‹</button>
                  <button
                    type="button"
                    onClick={() => moveSelection(1)}
                    aria-label="Next training session"
                    className="w-7 h-7 rounded-full bg-pool-700 text-pool-300"
                  >›</button>
                </div>
              )}
            </div>
            {slotsLoading ? (
              <p className="bg-pool-800 border border-pool-700 rounded-xl px-3 py-2.5 text-xs text-pool-400">Loading timetable sessions…</p>
            ) : occurrences.length > 0 ? (
              <div
                ref={carouselRef}
                onScroll={handleCarouselScroll}
                className="flex gap-2 overflow-x-auto snap-x snap-proximity py-1 px-[11%] -mx-4 touch-pan-x"
                aria-label="Choose a training session"
              >
                {occurrences.map((occurrence, index) => {
                  const selected = selectedKey === occurrence.key
                  const period = Number(String(occurrence.time || '12:00').split(':')[0]) < 12 ? 'AM' : 'PM'
                  return (
                    <button
                      type="button"
                      key={occurrence.key}
                      ref={node => { cardRefs.current[occurrence.key] = node }}
                      onClick={() => selectOccurrence(occurrence)}
                      className={`min-w-[78%] sm:min-w-80 snap-center rounded-xl border px-4 py-3 text-left transition-colors ${selected
                        ? 'bg-accent-600/20 border-accent-500 text-white'
                        : 'bg-pool-700 border-pool-600 text-pool-300'
                      }`}
                      aria-pressed={selected}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold">{occurrenceDateLabel(occurrence.date)} · {period}</p>
                          <p className="text-xs text-pool-400 mt-0.5">{occurrence.label || occurrence.squad || 'Training session'}</p>
                        </div>
                        {index === upcomingIndex && (
                          <span className="text-[9px] uppercase tracking-wide font-semibold text-teal-300 bg-teal-900/35 rounded-full px-2 py-0.5">Next</span>
                        )}
                      </div>
                      <p className="text-xs mt-2">
                        {occurrence.time}{occurrence.end_time ? `–${occurrence.end_time}` : ''}
                        {occurrence.course ? ` · ${occurrence.course}` : ''}
                      </p>
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="bg-pool-800 border border-pool-700 rounded-xl px-3 py-2.5 text-xs text-pool-400">
                No timetable sessions are configured.
              </p>
            )}
            <div className="flex items-center justify-between gap-3 mt-1.5">
              <p className="text-[11px] text-pool-500">Swipe gently for one session, or flick to move further.</p>
              <button
                type="button"
                onClick={toggleUnscheduled}
                className="text-[11px] text-accent-400 shrink-0"
              >
                {unscheduled ? 'Use timetable' : 'Other date'}
              </button>
            </div>
            {unscheduled && (
              <div className="mt-2">
                <label className="text-[11px] text-pool-400 block mb-1">Unscheduled session date</label>
                <input
                  type="date"
                  value={date}
                  onChange={e => changeDate(e.target.value)}
                  className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2.5 text-sm focus:border-accent-500 focus:outline-none"
                />
              </div>
            )}
          </div>

          {/* Session source */}
          <div>
            <div className="grid grid-cols-2 bg-pool-800 rounded-xl p-1 mb-2">
              <button
                type="button"
                onClick={() => changeInputMethod('text')}
                className={`rounded-lg py-2 text-xs font-semibold transition-colors ${inputMethod === 'text' ? 'bg-accent-600 text-white' : 'text-pool-400'}`}
              >
                Type a brief
              </button>
              <button
                type="button"
                onClick={() => changeInputMethod('photo')}
                className={`rounded-lg py-2 text-xs font-semibold transition-colors ${inputMethod === 'photo' ? 'bg-accent-600 text-white' : 'text-pool-400'}`}
              >
                Import photo
              </button>
            </div>

            {inputMethod === 'text' ? (
              <>
                <label className="text-xs text-pool-400 block mb-1">Session type or brief</label>
                <textarea
                  value={text}
                  onChange={e => changeBrief(e.target.value)}
                  placeholder="Enter a short session type or a complete set.&#10;&#10;e.g. Threshold session focused on holding 200 race pace&#10;&#10;or: Warm up 400 easy, 4x100 drill. Main set 6x400 on 5:30 threshold. Cool down 200 easy."
                  rows={7}
                  className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2.5 text-sm focus:border-accent-500 focus:outline-none resize-none leading-relaxed"
                />
                <p className="text-[11px] text-pool-500 mt-1">The AI turns what you type into a structured session template with sets, groups and training dose.</p>
              </>
            ) : (
              <>
                {!photoDraft ? (
                  <>
                    <label className="block bg-pool-700 border-2 border-dashed border-pool-600 hover:border-accent-500 rounded-xl p-5 text-center cursor-pointer transition-colors">
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={event => changePhoto(event.target.files?.[0] || null)}
                      />
                      {photoFile ? (
                        <>
                          <p className="text-sm font-semibold text-pool-200 truncate">{photoFile.name}</p>
                          <p className="text-xs text-accent-400 mt-1">Tap to choose a different photo</p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm font-semibold text-accent-400">Take or choose a session photo</p>
                          <p className="text-xs text-pool-500 mt-1">Whiteboard, printed sheet or handwritten programme</p>
                        </>
                      )}
                    </label>
                    <p className="text-[11px] text-pool-500 mt-1">First the photo becomes an editable draft. No session is created or analysed yet.</p>
                  </>
                ) : (
                  <div className="bg-pool-800 border border-pool-700 rounded-xl p-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold text-pool-200">Editable photo draft</p>
                        <p className="text-[11px] text-pool-500 mt-0.5">Correct anything the photo reader misread before continuing.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => changePhoto(null)}
                        className="text-[11px] text-accent-400 shrink-0"
                      >
                        Start again
                      </button>
                    </div>

                    <label className="block">
                      <span className="block text-[11px] text-pool-400 mb-1">Title</span>
                      <input
                        value={photoDraft.title || ''}
                        onChange={event => updatePhotoDraft('title', event.target.value)}
                        className="w-full bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm focus:border-accent-500 focus:outline-none"
                        placeholder="Session title"
                      />
                    </label>

                    {Object.entries(photoDraft.groups || {}).map(([groupNum, group]) => (
                      <div key={groupNum} className="border-t border-pool-700 pt-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold text-pool-300">Group {groupNum}</p>
                          {Object.keys(photoDraft.groups || {}).length > 1 && (
                            <button type="button" onClick={() => removePhotoGroup(groupNum)} className="text-[11px] text-red-400">Remove</button>
                          )}
                        </div>
                        <input
                          value={group?.description || ''}
                          onChange={event => updatePhotoGroup(groupNum, 'description', event.target.value)}
                          className="w-full bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-xs focus:border-accent-500 focus:outline-none"
                          placeholder="Group label or purpose"
                        />
                        <textarea
                          value={Array.isArray(group?.sets) ? group.sets.join('\n') : group?.sets || ''}
                          onChange={event => updatePhotoGroup(groupNum, 'sets', event.target.value)}
                          rows={5}
                          className="w-full bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-xs font-mono leading-relaxed focus:border-accent-500 focus:outline-none resize-y"
                          placeholder="Session sets"
                        />
                      </div>
                    ))}

                    {Object.keys(photoDraft.groups || {}).length < 3 && (
                      <button type="button" onClick={addPhotoGroup} className="text-xs text-accent-400">+ Add group</button>
                    )}

                    <label className="block border-t border-pool-700 pt-3">
                      <span className="block text-[11px] text-pool-400 mb-1">Coach notes</span>
                      <textarea
                        value={photoDraft.notes || ''}
                        onChange={event => updatePhotoDraft('notes', event.target.value)}
                        rows={3}
                        className="w-full bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm focus:border-accent-500 focus:outline-none resize-y"
                        placeholder="Intent or notes visible in the photo"
                      />
                    </label>

                    <label className="block">
                      <span className="block text-[11px] text-pool-400 mb-1">Energy focus</span>
                      <select
                        value={photoDraft.energy_system_focus || ''}
                        onChange={event => updatePhotoDraft('energy_system_focus', event.target.value)}
                        className="w-full bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm focus:border-accent-500 focus:outline-none"
                      >
                        <option value="">Let the planner infer it</option>
                        <option value="aerobic">Aerobic</option>
                        <option value="threshold">Threshold</option>
                        <option value="speed">Speed</option>
                        <option value="recovery">Recovery</option>
                        <option value="mixed">Mixed</option>
                      </select>
                    </label>
                  </div>
                )}
              </>
            )}
          </div>

          <button
            onClick={analyse}
            disabled={loading || slotsLoading || (inputMethod === 'photo' ? !(photoDraft ? editablePhotoDraftText(photoDraft) : photoFile) : !text.trim()) || (!unscheduled && occurrences.length > 0 && !selectedSlot)}
            className="w-full bg-accent-600 hover:bg-accent-500 active:bg-accent-700 disabled:opacity-40 rounded-xl py-3 text-sm font-semibold transition-colors"
          >
            {loading
              ? inputMethod === 'photo' && !photoDraft ? 'Extracting draft…' : 'Building plan & dose…'
              : inputMethod === 'photo'
                ? photoDraft ? 'Submit draft & build template' : 'Extract editable draft'
                : 'Build session template'}
          </button>

          {error && (
            <p className="text-red-400 text-sm bg-red-900/20 rounded-xl px-3 py-2">{error}</p>
          )}
          {loading && (
            <p className="text-xs text-pool-400 text-center">
              {inputMethod === 'photo'
                ? photoDraft
                  ? 'Turning your corrected draft into the pool-ready plan and training dose.'
                  : 'Reading the programme into an editable draft. Nothing is being saved.'
                : 'Turning your idea into a pool-ready plan, then estimating distance by work zone.'}
            </p>
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
                      {Object.values(grp.volume_breakdown || {}).some(value => Number(value) > 0) && (
                        <div className="px-3 pb-3 flex flex-wrap gap-1.5">
                          {Object.entries(grp.volume_breakdown).filter(([, value]) => Number(value) > 0).map(([zone, value]) => (
                            <span key={zone} className="text-[11px] bg-pool-800 border border-pool-600 text-pool-300 rounded-full px-2 py-0.5">
                              {displayEnergy(zone).label} {Number(value)}m
                            </span>
                          ))}
                        </div>
                      )}
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

            {result.energy_analysis && (
              <div className="bg-pool-700 border border-pool-600 rounded-xl p-3">
                <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-1.5">Prescribed Dose</p>
                <p className="text-sm text-pool-200 leading-relaxed">
                  {result.energy_analysis.primary_emphasis || displayEnergy(result.energy_analysis.energy_system_focus).label}
                  {result.energy_analysis.density ? ` · ${result.energy_analysis.density.replace('_', ' ')} density` : ''}
                </p>
                {result.energy_analysis.assumptions?.length > 0 && (
                  <p className="text-xs text-pool-400 mt-1">Assumption: {result.energy_analysis.assumptions[0]}</p>
                )}
              </div>
            )}

            {result.analysis_warning && (
              <p className="text-amber-300 text-xs bg-amber-900/20 border border-amber-800/40 rounded-xl px-3 py-2">{result.analysis_warning}</p>
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
