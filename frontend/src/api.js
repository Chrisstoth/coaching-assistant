const BASE = '/api'

async function request(method, path, body = null, isFormData = false) {
  const opts = {
    method,
    headers: isFormData ? {} : { 'Content-Type': 'application/json' },
  }
  if (body) opts.body = isFormData ? body : JSON.stringify(body)
  const res = await fetch(`${BASE}${path}`, opts)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    const detail = err.detail
    const msg = typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map(d => d.msg || JSON.stringify(d)).join(', ') : JSON.stringify(detail) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  if (res.status === 204) return null
  return res.json()
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

  // Register
  getRegister: (sessionId) => request('GET', `/sessions/${sessionId}/register`),
  submitRegister: (sessionId, data) => request('PUT', `/sessions/${sessionId}/register`, data),
  recommendGroups: (sessionId) => request('POST', `/sessions/${sessionId}/recommend-groups`),

  // Import
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
  importExcel: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return request('POST', '/sessions/import/excel', fd, true)
  },
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

  // AI Chat threads
  getAIChatThreads: () => request('GET', '/ai-chat/threads'),
  createAIChatThread: (name) => request('POST', '/ai-chat/threads', { name }),
  renameAIChatThread: (id, name) => request('PATCH', `/ai-chat/threads/${id}`, { name }),
  deleteAIChatThread: (id) => request('DELETE', `/ai-chat/threads/${id}`),

  // AI Chat messages (thread-aware)
  getAIChatMessages: (threadId) => request('GET', `/ai-chat/messages${threadId != null ? `?thread_id=${threadId}` : ''}`),
  sendAIChatMessage: (message, threadId) => request('POST', '/ai-chat/messages', { message, thread_id: threadId }),
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
  startRegister: (message, threadId) => request('POST', '/ai-chat/start-register', { message, thread_id: threadId }),
  parseRegister: (data) => request('POST', '/ai-chat/parse-register', data),
  submitRegister: (data) => request('POST', '/ai-chat/submit-register', data),
  sendAIChatMessageWithImage: (message, imageFile, threadId) => {
    const fd = new FormData()
    fd.append('message', message || '')
    fd.append('image', imageFile)
    if (threadId != null) fd.append('thread_id', String(threadId))
    return request('POST', '/ai-chat/messages-with-image', fd, true)
  },

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

  // Periodization
  generateMicro: (swimmerId) => request('POST', `/periodization/${swimmerId}/micro`),
  getPlans: (swimmerId) => request('GET', `/periodization/${swimmerId}`),

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
}
