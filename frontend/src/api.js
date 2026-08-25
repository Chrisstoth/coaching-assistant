import { flushOfflineSaves, queueRegisterSave } from './offlineQueue'

const BASE = '/api'
const TOKEN_KEY = 'lanewatch_ai_token'
const LEGACY_TOKEN_KEY = 'dx_token'

export function getToken() {
  const token = localStorage.getItem(TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY)
  if (token && !localStorage.getItem(TOKEN_KEY)) {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.removeItem(LEGACY_TOKEN_KEY)
  }
  return token
}
export function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t)
  localStorage.removeItem(LEGACY_TOKEN_KEY)
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(LEGACY_TOKEN_KEY)
}

async function request(method, path, body = null, isFormData = false) {
  const token = getToken()
  const headers = isFormData ? {} : { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const opts = { method, headers }
  if (body) opts.body = isFormData ? body : JSON.stringify(body)
  const res = await fetch(`${BASE}${path}`, opts)
  if (res.status === 401) {
    clearToken()
    window.location.href = '/login'
    const error = new Error('Session expired. Sign in again to sync saved changes.')
    error.status = 401
    throw error
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    const detail = err.detail
    const msg = typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map(d => d.msg || JSON.stringify(d)).join(', ') : JSON.stringify(detail) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  if (res.status === 204) return null
  return res.json()
}

function isConnectionFailure(error) {
  return (typeof navigator !== 'undefined' && !navigator.onLine)
    || error instanceof TypeError
}

async function saveRegisterWithOfflineFallback(sessionId, data) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return queueRegisterSave(sessionId, data)
  }
  try {
    return await request('PUT', `/sessions/${sessionId}/register`, data)
  } catch (error) {
    if (isConnectionFailure(error)) return queueRegisterSave(sessionId, data)
    throw error
  }
}

export const api = {
  // Swimmers
  getSwimmers: (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request('GET', `/swimmers${qs ? '?' + qs : ''}`)
  },
  getSwimmer: (id) => request('GET', `/swimmers/${id}`),
  createSwimmer: (data) => request('POST', '/swimmers', data),
  updateSwimmer: (id, data) => request('PUT', `/swimmers/${id}`, data),
  deleteSwimmer: (id) => request('DELETE', `/swimmers/${id}`),
  getSwimmerTimes: (id, params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request('GET', `/swimmers/${id}/times${qs ? '?' + qs : ''}`)
  },

  // Observations
  getObservations: (id, type) => {
    const qs = type && type !== 'all' ? `?obs_type=${type}` : ''
    return request('GET', `/swimmers/${id}/observations${qs}`)
  },
  addObservation: (id, data) => request('POST', `/swimmers/${id}/observations`, data),
  deleteObservation: (id, obsId) => request('DELETE', `/swimmers/${id}/observations/${obsId}`),

  // Versioned profiles
  synthesiseRaceProfile: (id, conversationContext) => request('POST', `/swimmers/${id}/profile/race/synthesise`, conversationContext ? { conversation_context: conversationContext } : {}),
  synthesiseTrainingProfile: (id, conversationContext) => request('POST', `/swimmers/${id}/profile/training/synthesise`, conversationContext ? { conversation_context: conversationContext } : {}),
  synthesiseBiologicalProfile: (id, conversationContext) => request('POST', `/swimmers/${id}/profile/biological/synthesise`, conversationContext ? { conversation_context: conversationContext } : {}),
  synthesiseTechnicalProfile: (id, conversationContext) => request('POST', `/swimmers/${id}/profile/technical/synthesise`, conversationContext ? { conversation_context: conversationContext } : {}),
  getTechnicalProfiles: (id) => request('GET', `/swimmers/${id}/profile/technical`),
  synthesisePerformanceAnalysis: (id) => request('POST', `/swimmers/${id}/profile/performance/synthesise`),
  debugPerformancePrompt: (id) => request('GET', `/swimmers/${id}/profile/performance/debug-prompt`),
  getRaceProfiles: (id) => request('GET', `/swimmers/${id}/profile/race`),
  getTrainingProfiles: (id) => request('GET', `/swimmers/${id}/profile/training`),
  getBiologicalProfiles: (id) => request('GET', `/swimmers/${id}/profile/biological`),
  getPerformanceAnalyses: (id) => request('GET', `/swimmers/${id}/profile/performance`),
  deleteProfileVersions: (id, profileType) => request('DELETE', `/swimmers/${id}/profile/${profileType}`),
  getSwimmerContext: (id) => request('GET', `/swimmers/${id}/context`),
  getAttendanceStats: (id) => request('GET', `/swimmers/${id}/attendance-stats`),
  getBlockStatus: (id) => request('GET', `/swimmers/${id}/block-status`),

  // Load events
  getLoadEvents: (id) => request('GET', `/swimmers/${id}/load-events`),
  addLoadEvent: (id, data) => request('POST', `/swimmers/${id}/load-events`, data),
  updateLoadEvent: (id, eventId, data) => request('PATCH', `/swimmers/${id}/load-events/${eventId}`, data),
  deleteLoadEvent: (id, eventId) => request('DELETE', `/swimmers/${id}/load-events/${eventId}`),

  // Readiness
  generateReadiness: (id) => request('POST', `/swimmers/${id}/readiness`),

  // Profile conversation
  profileChat: (id, message) => request('POST', `/swimmers/${id}/profile/chat`, { message }),
  synthesiseProfile: (id) => request('POST', `/swimmers/${id}/profile/synthesise`),
  getConversation: (id) => request('GET', `/swimmers/${id}/profile/conversation`),

  // Session planner
  planSession: (data) => request('POST', '/sessions/plan', data),

  // Sessions
  getSessions: (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request('GET', `/sessions${qs ? '?' + qs : ''}`)
  },
  getSession: (id) => request('GET', `/sessions/${id}`),
  createSession: (data) => request('POST', '/sessions', data),
  deleteSession: (id) => request('DELETE', `/sessions/${id}`),
  deleteTimes: (swimmerId = null) => request('DELETE', `/times${swimmerId ? `?swimmer_id=${swimmerId}` : ''}`),
  bulkDeleteSwimmers: (ids) => request('POST', '/swimmers/bulk-delete', { ids }),
  parseObservations: (sessionId, text) => request('POST', `/sessions/${sessionId}/parse-observations`, { text }),
  getRacingNarrative: (id) => request('GET', `/swimmers/${id}/racing-narrative`),
  saveRacingNarrative: (id, narrative) => request('POST', `/swimmers/${id}/racing-narrative`, { narrative }),
  getRaceObservations: (id) => request('GET', `/swimmers/${id}/observations?obs_type=race&limit=100`),
  updateSession: (id, data) => request('PUT', `/sessions/${id}`, data),

  // Calendar
  getCalendar: (weekStart) => {
    const qs = weekStart ? `?week_start=${weekStart}` : ''
    return request('GET', `/sessions/calendar${qs}`)
  },
  startCalendarSession: (data) => request('POST', '/sessions/calendar/start', data),
  cancelCalendarSession: (data) => request('POST', '/sessions/calendar/cancel', data),
  dismissCalendarSession: (data) => request('POST', '/sessions/calendar/dismiss', data),

  // Register
  getRegister: (sessionId) => request('GET', `/sessions/${sessionId}/register`),
  submitRegister: saveRegisterWithOfflineFallback,
  flushOfflineSaves: () => flushOfflineSaves(request),
  recommendGroups: (sessionId) => request('POST', `/sessions/${sessionId}/recommend-groups`),

  // Import
  importCombinedSwims: (file, trackerFile = null, squad = 'Silver 1', replaceExisting = true, reconcileRoster = true) => {
    const fd = new FormData()
    fd.append('file', file)
    if (trackerFile) fd.append('tracker_file', trackerFile)
    fd.append('squad', squad)
    fd.append('replace_existing', String(replaceExisting))
    fd.append('reconcile_roster', String(reconcileRoster))
    return request('POST', '/times/import/combined', fd, true)
  },
  importRoster: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return request('POST', '/swimmers/import/roster', fd, true)
  },
  importCsv: (file, eventName) => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('event_name', eventName || '')
    return request('POST', '/times/import/csv', fd, true)
  },
  importCsvBulk: (filesWithEvents) => {
    // filesWithEvents: [{file, eventName}, ...]
    const fd = new FormData()
    filesWithEvents.forEach(({ file }) => fd.append('files', file))
    fd.append('event_names', JSON.stringify(filesWithEvents.map(f => f.eventName || '')))
    return request('POST', '/times/import/csv/bulk', fd, true)
  },
  importExcel: (file, aiCheck = false, context = null) => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('ai_check', aiCheck ? 'true' : 'false')
    if (context?.date) fd.append('expected_date', context.date)
    if (context?.slotId) fd.append('expected_pool_slot_id', context.slotId)
    if (context?.sessionId) fd.append('expected_session_id', context.sessionId)
    return request('POST', '/sessions/import/excel', fd, true)
  },
  confirmExcelImport: (draft, targetSessionId = null) => request('POST', '/sessions/import/excel/confirm', {
    draft,
    target_session_id: targetSessionId,
  }),
  importExcelBulk: (files) => {
    const fd = new FormData()
    files.forEach((f) => fd.append('files', f))
    return request('POST', '/sessions/import/excel/bulk', fd, true)
  },
  importPhoto: (file, sessionDate, squad) => {
    const fd = new FormData()
    fd.append('file', file)
    if (sessionDate) fd.append('session_date', sessionDate)
    if (squad) fd.append('squad', squad)
    return request('POST', '/sessions/import/photo', fd, true)
  },

  // Meets
  getMeets: () => request('GET', '/meets'),
  createMeet: (data) => request('POST', '/meets', data),
  getMeet: (id) => request('GET', `/meets/${id}`),
  updateMeet: (id, data) => request('PUT', `/meets/${id}`, data),
  deleteMeet: (id) => request('DELETE', `/meets/${id}`),
  addMeetTarget: (meetId, data) => request('POST', `/meets/${meetId}/targets`, data),
  updateMeetTarget: (meetId, targetId, data) => request('PUT', `/meets/${meetId}/targets/${targetId}`, data),
  deleteMeetTarget: (meetId, targetId) => request('DELETE', `/meets/${meetId}/targets/${targetId}`),
  extractSchedule: (meetId, scheduleFile) => {
    const fd = new FormData()
    fd.append('schedule_file', scheduleFile)
    return request('POST', `/meets/${meetId}/extract-schedule`, fd, true)
  },
  extractEntries: (meetId, entriesFile) => {
    const fd = new FormData()
    fd.append('entries_file', entriesFile)
    return request('POST', `/meets/${meetId}/extract-entries`, fd, true)
  },
  combineExtractions: (meetId, data) => {
    return request('POST', `/meets/${meetId}/combine-extractions`, data)
  },
  getMeetTimetable: (meetId) => request('GET', `/meets/${meetId}/timetable`),
  createMeetSession: (meetId, data) => request('POST', `/meets/${meetId}/timetable`, data),
  updateMeetSession: (meetId, sessionId, data) => request('PUT', `/meets/${meetId}/timetable/${sessionId}`, data),
  deleteMeetSession: (meetId, sessionId) => request('DELETE', `/meets/${meetId}/timetable/${sessionId}`),
  importMeetTimetable: (meetId, data) => request('POST', `/meets/${meetId}/timetable/import`, data),

  // Qualification standards and deterministic comparisons
  getQualificationSets: (meetId = null) => request('GET', `/qualification-standards${meetId ? `?meet_id=${meetId}` : ''}`),
  getQualificationSet: (id) => request('GET', `/qualification-standards/${id}`),
  extractQualificationStandards: (document, meetId = null) => {
    const fd = new FormData()
    fd.append('document', document)
    if (meetId) fd.append('meet_id', String(meetId))
    return request('POST', '/qualification-standards/extract', fd, true)
  },
  updateQualificationSet: (id, data) => request('PATCH', `/qualification-standards/${id}`, data),
  replaceQualificationStandards: (id, rows) => request('PUT', `/qualification-standards/${id}/standards`, rows),
  confirmQualificationSet: (id) => request('POST', `/qualification-standards/${id}/confirm`),
  recalculateQualifications: (id) => request('POST', `/qualification-standards/${id}/recalculate`),
  getQualificationAssessments: (id) => request('GET', `/qualification-standards/${id}/assessments`),
  deleteQualificationSet: (id) => request('DELETE', `/qualification-standards/${id}`),

  // Voice
  transcribeAudio: (audioBlob) => {
    const fd = new FormData()
    fd.append('audio', audioBlob, audioBlob.type?.includes('mp4') ? 'audio.mp4' : 'audio.webm')
    return request('POST', '/ai-chat/transcribe', fd, true)
  },

  // Dashboard
  getSquadPulse: () => request('GET', '/dashboard/squad-pulse'),
  getSquadAvailability: (days = 42) => request('GET', `/dashboard/availability?days=${days}`),
  getMeetCountdowns: () => request('GET', '/dashboard/meet-countdowns'),

  // Skills
  planSessionSkill: (data) => request('POST', '/skills/plan-session', data),
  reviewSwimmerSkill: (data) => request('POST', '/skills/review-swimmer', data),
  reviewBlockSkill: (data) => request('POST', '/skills/review-block', data),
  analyseMeetSkill: (data) => request('POST', '/skills/analyse-meet', data),
  planMesoSkill: (data) => request('POST', '/skills/plan-meso', data),
  planMicroSkill: (data) => request('POST', '/skills/plan-micro', data),
  planMacroSkill: (data) => request('POST', '/skills/plan-macro', data),
  planTaperSkill: (data) => request('POST', '/skills/plan-taper', data),
  suggestGroupsSkill: (data) => request('POST', '/skills/suggest-groups', data),
  getSkillHistory: (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request('GET', `/skills/history${qs ? '?' + qs : ''}`)
  },
  getSwimmerSkillHistory: (swimmerId) => request('GET', `/skills/history/${swimmerId}`),

  // AI Chat threads
  getAIChatThreads: () => request('GET', '/ai-chat/threads'),
  createAIChatThread: (data) => request('POST', '/ai-chat/threads', typeof data === 'string' ? { name: data } : data),
  renameAIChatThread: (id, name) => request('PATCH', `/ai-chat/threads/${id}`, { name }),
  deleteAIChatThread: (id) => request('DELETE', `/ai-chat/threads/${id}`),
  getOrCreateSeasonPlanThread: (macroId) => request('POST', '/ai-chat/threads/season-plan', macroId ? { macro_id: macroId } : {}),
  getOrCreateAthletePlanThread: () => request('POST', '/ai-chat/threads/athlete-planning', {}),

  // AI Chat messages (thread-aware)
  getAIChatMessages: (threadId) => request('GET', `/ai-chat/messages${threadId != null ? `?thread_id=${threadId}` : ''}`),
  sendAIChatMessage: (message, threadId, brief = false) => request('POST', '/ai-chat/messages', { message, thread_id: threadId, brief }),
  clearAIChat: (threadId) => request('DELETE', `/ai-chat/messages${threadId != null ? `?thread_id=${threadId}` : ''}`),
  getAIContextStatus: () => request('GET', '/ai-chat/context-status'),

  // Coaching notes (temporary session plans)
  getCoachingNotes: (includeExpired = false) => request('GET', `/coaching-notes${includeExpired ? '?include_expired=true' : ''}`),
  createCoachingNote: (data) => request('POST', '/coaching-notes', data),
  updateCoachingNote: (id, data) => request('PATCH', `/coaching-notes/${id}`, data),
  deleteCoachingNote: (id) => request('DELETE', `/coaching-notes/${id}`),
  pinToSessions: (threadId) => request('POST', '/ai-chat/pin-to-sessions', threadId != null ? { thread_id: threadId } : {}),
  createSessionFromChat: (draft) => request('POST', '/ai-chat/create-session', draft),
  createMeetFromChat: (threadId) => request('POST', '/ai-chat/create-meet', threadId != null ? { thread_id: threadId } : {}),
  extractSessionDraft: (threadId) => request('POST', '/ai-chat/extract-session', threadId != null ? { thread_id: threadId } : {}),
  saveBenchmarkFromChat: (swimmerId, conversation) => request('POST', '/ai-chat/actions/save-benchmark', { swimmer_id: swimmerId, conversation }),
  previewTargetFromChat: (swimmerId, conversation) => request('POST', '/ai-chat/actions/preview-target', { swimmer_id: swimmerId, conversation }),
  saveCoachingIntentFromChat: (swimmerId, conversation) => request('POST', '/ai-chat/actions/save-coaching-intent', { swimmer_id: swimmerId, conversation }),
  updateAthleteProfileFromChat: (swimmerId, messages) => request('POST', '/ai-chat/actions/update-athlete-profile', { swimmer_id: swimmerId, messages }),
  startRegister: (message, threadId) => request('POST', '/ai-chat/start-register', { message, thread_id: threadId }),
  parseRegister: (data) => request('POST', '/ai-chat/parse-register', data),
  submitChatRegister: (data) => request('POST', '/ai-chat/submit-register', data),
  sendAIChatMessageWithImage: (message, imageFile, threadId, brief = false) => {
    const fd = new FormData()
    fd.append('message', message || '')
    fd.append('image', imageFile)
    if (threadId != null) fd.append('thread_id', String(threadId))
    if (brief) fd.append('brief', 'true')
    return request('POST', '/ai-chat/messages-with-image', fd, true)
  },

  // Benchmarks & targets
  logBenchmark: (data) => request('POST', '/benchmarks/benchmarks', data),
  getBenchmarks: (swimmerId) => request('GET', `/benchmarks/benchmarks/${swimmerId}`),
  getCurrentBenchmarks: (swimmerId) => request('GET', `/benchmarks/benchmarks/${swimmerId}/current`),
  deleteBenchmark: (id) => request('DELETE', `/benchmarks/benchmarks/${id}`),
  createTarget: (data) => request('POST', '/benchmarks/targets', data),
  getTargets: (swimmerId) => request('GET', `/benchmarks/targets/${swimmerId}`),
  updateTarget: (id, data) => request('PATCH', `/benchmarks/targets/${id}`, data),
  deleteTarget: (id) => request('DELETE', `/benchmarks/targets/${id}`),

  // Coaching context
  getCoachingProfiles: () => request('GET', '/coaching-context/profiles'),
  getCurrentCoachingProfile: () => request('GET', '/coaching-context/current'),
  getCoachingProfile: (id) => request('GET', `/coaching-context/profiles/${id}`),
  getCoachingConversation: () => request('GET', '/coaching-context/conversation'),
  clearCoachingConversation: () => request('DELETE', '/coaching-context/conversation'),
  coachingChat: (message) => request('POST', '/coaching-context/chat', { message }),
  finaliseCoachingProfile: (title) => request('POST', '/coaching-context/finalise', { title }),

  // AI
  askPhysiology: (swimmerId, question) =>
    request('POST', `/ai/physiology/${swimmerId}`, { question }),
  getAnalyses: (swimmerId, type) => {
    const qs = type ? `?analysis_type=${type}` : ''
    return request('GET', `/ai/analyses/${swimmerId}${qs}`)
  },
  getAIUsage: (days = 30) => request('GET', `/ai-chat/usage?days=${days}`),

  // Periodization
  generateMicro: (swimmerId) => request('POST', `/periodization/${swimmerId}/micro`),
  getPlans: (swimmerId) => request('GET', `/periodization/${swimmerId}`),

  // Season plan
  getMacros: () => request('GET', '/season/macros'),
  createMacro: (data) => request('POST', '/season/macros', data),
  updateMacro: (id, data) => request('PATCH', `/season/macros/${id}`, data),
  deleteMacro: (id) => request('DELETE', `/season/macros/${id}`),
  getSeasonBlocks: () => request('GET', '/season/blocks'),
  createSeasonBlock: (data) => request('POST', '/season/blocks', data),
  updateSeasonBlock: (id, data) => request('PATCH', `/season/blocks/${id}`, data),
  deleteSeasonBlock: (id) => request('DELETE', `/season/blocks/${id}`),
  getSeasonSummary: () => request('GET', '/season/summary'),
  getBlockProgress: (id) => request('GET', `/season/blocks/${id}/progress`),
  analyseBlock: (id) => request('POST', `/season/blocks/${id}/ai-analysis`),
  getMicrocycles: (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request('GET', `/season/microcycles${qs ? '?' + qs : ''}`)
  },
  createMicrocycle: (data) => request('POST', '/season/microcycles', data),
  updateMicrocycle: (id, data) => request('PATCH', `/season/microcycles/${id}`, data),
  deleteMicrocycle: (id) => request('DELETE', `/season/microcycles/${id}`),

  // Persisted planning intelligence
  getPlanningSeasons: () => request('GET', '/planning-agent/seasons'),
  getCurrentPlanningSeason: () => request('GET', '/planning-agent/seasons/current'),
  startPlanningSeason: (data) => request('POST', '/planning-agent/seasons/start', data),
  createPlanningSeason: (data) => request('POST', '/planning-agent/seasons', data),
  getPlanningPathways: (macroId) => request('GET', `/planning-agent/pathways${macroId ? `?macro_id=${macroId}` : ''}`),
  createPlanningPathway: (data) => request('POST', '/planning-agent/pathways', data),
  updatePlanningPathway: (id, data) => request('PATCH', `/planning-agent/pathways/${id}`, data),
  deletePlanningPathway: (id) => request('DELETE', `/planning-agent/pathways/${id}`),
  setPlanningPathwayMembers: (id, members) => request('PUT', `/planning-agent/pathways/${id}/members`, members),
  refreshPlanningAgent: (macroId, asOfDate = null) => request('POST', '/planning-agent/refresh', { macro_id: macroId, as_of_date: asOfDate }),
  getPlanningAgentStatus: (macroId) => request('GET', `/planning-agent/status${macroId ? `?macro_id=${macroId}` : ''}`),
  getAssistantInbox: (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request('GET', `/planning-agent/inbox${qs ? `?${qs}` : ''}`)
  },
  refreshAssistantInbox: () => request('POST', '/planning-agent/inbox/refresh', {}),
  updatePlanningRecommendation: (id, statusOrData) => request(
    'PATCH',
    `/planning-agent/recommendations/${id}`,
    typeof statusOrData === 'string' ? { status: statusOrData } : statusOrData,
  ),
  startPlanningRecommendation: (id) => request('POST', `/planning-agent/recommendations/${id}/start`, {}),
  discussPlanningRecommendation: (id) => request('POST', `/planning-agent/recommendations/${id}/discuss`, {}),

  // Schedule / timetable
  getSlots: () => request('GET', '/schedule/slots'),
  createSlot: (data) => request('POST', '/schedule/slots', data),
  updateSlot: (id, data) => request('PATCH', `/schedule/slots/${id}`, data),
  deleteSlot: (id) => request('DELETE', `/schedule/slots/${id}`),
  getSlotSwimmers: (slotId) => request('GET', `/schedule/slots/${slotId}/swimmers`),
  getSwimmerSlots: (swimmerId) => request('GET', `/schedule/swimmers/${swimmerId}`),
  setSwimmerSlots: (swimmerId, slotIds) => request('PUT', `/schedule/swimmers/${swimmerId}`, slotIds),
  getSwimmerExceptions: (swimmerId) => request('GET', `/schedule/swimmers/${swimmerId}/exceptions`),
  addException: (swimmerId, data) => request('POST', `/schedule/swimmers/${swimmerId}/exceptions`, data),
  deleteException: (swimmerId, excId) => request('DELETE', `/schedule/swimmers/${swimmerId}/exceptions/${excId}`),
  getExpectedAttendance: (date, squad) => {
    const qs = squad ? `?squad=${squad}` : ''
    return request('GET', `/schedule/expected/${date}${qs}`)
  },

  // Profile Wizard
  profileWizardChat: (swimmerId, messages) => request('POST', `/swimmers/${swimmerId}/profile-wizard/chat`, { messages }),
  profileWizardSave: (swimmerId, messages) => request('POST', `/swimmers/${swimmerId}/profile-wizard/save`, { messages }),
  previewFoundationFromEvidence: (swimmerId) => request('POST', `/swimmers/${swimmerId}/profile-wizard/draft-existing`, {}),
  saveReviewedFoundation: (swimmerId, data) => request('POST', `/swimmers/${swimmerId}/profile-wizard/save-draft`, data),

  // Planning cohorts
  getCohorts: () => request('GET', '/cohorts'),
  createCohort: (data) => request('POST', '/cohorts', data),
  updateCohort: (id, data) => request('PATCH', `/cohorts/${id}`, data),
  deleteCohort: (id) => request('DELETE', `/cohorts/${id}`),
  setCohortSwimmers: (cohortId, swimmerIds) => request('PUT', `/cohorts/${cohortId}/swimmers`, { swimmer_ids: swimmerIds }),
  assignSwimmerCohort: (swimmerId, cohortId) => request('PATCH', `/swimmers/${swimmerId}`, { planning_cohort_id: cohortId }),
}
