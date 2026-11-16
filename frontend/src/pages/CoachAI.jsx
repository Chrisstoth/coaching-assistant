import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { api, wakeServer } from '../api'
import { stashDraft } from '../planDrafts'
import SessionCancellationDialog from '../components/SessionCancellationDialog'
import RegisterSavedOverlay from '../components/RegisterSavedOverlay'
import SpeakButton from '../components/SpeakButton'
import { useSessionPresentation } from '../components/SessionPresentationProvider'
import useWhisperVoice, { primeMicrophone } from '../hooks/useWhisperVoice'
import { deskWeekStarts } from '../sessionProximity'
import { stop as stopSpeaking } from '../staffSpeech'
import {
  PLANNING_THREADS, TRY_ASKING, actionCopy, conversationName, conversationTitle,
  recentConversations, relativeTime, startSuggestions,
} from '../chatStart'

// The page fills the space between the header and the bottom bar, so the
// message box is always in reach and only the conversation scrolls.
const PAGE_HEIGHT = 'calc(100dvh - 8rem - env(safe-area-inset-bottom, 0px))'

// Holding the mic this long is push-to-talk (let go to send). A quicker tap
// listens hands-free and sends when the coach stops talking.
const HOLD_MS = 350

// A reply within this long means the server is up; no need to check first.
const AWAKE_FOR_MS = 120000

const POOLSIDE_KEY = 'lanewatch.chat.poolside'

function readPoolside() {
  try { return localStorage.getItem(POOLSIDE_KEY) === '1' } catch { return false }
}

function savePoolside(on) {
  try { localStorage.setItem(POOLSIDE_KEY, on ? '1' : '0') } catch { /* private window */ }
}

const INTENT_LABELS = {
  session_writing: { label: 'session', colour: 'teal' },
  meet_creation: { label: 'meet', colour: 'purple' },
  biological_profile: { label: 'biological profile', colour: 'blue' },
  race_profile: { label: 'race profile', colour: 'orange' },
  training_profile: { label: 'training profile', colour: 'green' },
  performance_analysis: { label: 'performance analysis', colour: 'purple' },
  session_plan: { label: 'session plan', colour: 'amber' },
  meet_prep: { label: 'session plan', colour: 'amber' },
  season_plan: { label: 'season plan', colour: 'teal' },
  season_plan_navigation: { label: 'season plan', colour: 'teal' },
  athlete_plan_navigation: { label: 'athlete planning', colour: 'orange' },
  coaching_intent: { label: 'training intent', colour: 'teal' },
  athlete_profile_update: { label: 'athlete profile', colour: 'orange' },
  status_change: { label: 'status update', colour: 'amber' },
}

const ACTION_COLOURS = {
  blue: 'border-blue-700/50 bg-blue-900/20 text-blue-300',
  orange: 'border-orange-700/50 bg-orange-900/20 text-orange-300',
  green: 'border-green-700/50 bg-green-900/20 text-green-300',
  purple: 'border-purple-700/50 bg-purple-900/20 text-purple-300',
  amber: 'border-amber-700/50 bg-amber-900/20 text-amber-300',
  teal: 'border-teal-700/50 bg-teal-900/20 text-teal-300',
  accent: 'border-accent-700/50 bg-accent-900/20 text-accent-300',
}

function getDefaultDates() {
  const today = new Date()
  const from = today.toISOString().slice(0, 10)
  const to = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return { from, to }
}

function plainText(text) {
  return String(text || '').replace(/[*_`#>]/g, '').trim()
}

export default function CoachAI() {
  const navigate = useNavigate()
  const location = useLocation()
  const [threads, setThreads] = useState([])
  const [activeThreadId, setActiveThreadId] = useState(null)
  const [messages, setMessages] = useState([])
  const [threadLoading, setThreadLoading] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [waking, setWaking] = useState(false)
  const [loading, setLoading] = useState(true)
  const [context, setContext] = useState(null)
  const [lastInjected, setLastInjected] = useState([])
  const [startData, setStartData] = useState({ calendar: [], awaitingDebrief: [] })
  const [opening, setOpening] = useState('')
  const [startError, setStartError] = useState('')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // Intent / suggested action
  const [suggestedAction, setSuggestedAction] = useState(null)
  const [actioning, setActioning] = useState(false)
  const [actionResult, setActionResult] = useState(null)

  // Session draft card
  const [sessionDraft, setSessionDraft] = useState(null) // extracted session JSON
  const [savingSession, setSavingSession] = useState(false)

  // Register card
  const [registerData, setRegisterData] = useState(null) // { session_id, session_title, attendees, attendance }
  const [registerSaved, setRegisterSaved] = useState(false)
  const [cancellationData, setCancellationData] = useState(null)
  const [targetDraft, setTargetDraft] = useState(null)
  const [savedTarget, setSavedTarget] = useState(null)

  // Pin modal
  const [pinning, setPinning] = useState(false)
  const [pinModal, setPinModal] = useState(null)
  const [pinDates, setPinDates] = useState(getDefaultDates())
  const [saving, setSaving] = useState(false)
  const [pinSaved, setPinSaved] = useState(false)

  const [attachedImage, setAttachedImage] = useState(null) // { file, preview }
  const [savedBenchmarksToast, setSavedBenchmarksToast] = useState(null) // [{swimmer_name, label}, ...]
  const [savedIntentsToast, setSavedIntentsToast] = useState(null) // [{swimmer_name, label}, ...]
  const [poolside, setPoolside] = useState(readPoolside)
  const [feedbackPrompt, setFeedbackPrompt] = useState(null) // post-register feedback
  const [handsFree, setHandsFree] = useState(false)
  const [voiceNote, setVoiceNote] = useState('')

  const fileInputRef = useRef(null)
  const textareaRef = useRef(null)
  const listRef = useRef(null)
  const bottomRef = useRef(null)
  const lastReplyRef = useRef(null)
  const scrollMode = useRef(null)
  const loadToken = useRef(0)
  const awakeAt = useRef(0)
  const pressRef = useRef(null)

  // The voice callback outlives renders; it reads the latest of these.
  const inputRef = useRef('')
  inputRef.current = input
  const sendingRef = useRef(false)
  sendingRef.current = sending
  const sendRef = useRef(null)

  // Said, not typed: send it straight away, as if the coach had pressed send.
  // If they'd already typed something, or listening ended unsure, the words go
  // in the box to check instead.
  const onVoiceResult = useCallback((transcript, { unsure } = {}) => {
    if (unsure || inputRef.current.trim() || sendingRef.current) {
      setInput(previous => (previous ? `${previous} ${transcript}` : transcript))
      setVoiceNote(unsure ? "Here's what I heard. Check it, then send." : '')
      return
    }
    sendRef.current?.(transcript)
  }, [])

  const {
    recording, transcribing, supported: voiceSupported, start: startVoice, stop: stopVoice,
    cancel: cancelVoice, listenForPause, error: voiceError, clearError: clearVoiceError,
  } = useWhisperVoice(onVoiceResult, {
    onNoSpeech: () => setVoiceNote("I didn't catch anything. Try again."),
    onCannotTell: () => setVoiceNote("Tap the mic when you've finished."),
  })

  useEffect(() => { if (!recording) setHandsFree(false) }, [recording])

  useEffect(() => {
    if (!registerSaved) return undefined
    const returnHome = window.setTimeout(() => {
      navigate('/', { replace: true })
    }, 1400)
    return () => window.clearTimeout(returnHome)
  }, [navigate, registerSaved])

  // ---- Opening ----

  const resetCards = () => {
    setSuggestedAction(null)
    setActionResult(null)
    setSessionDraft(null)
    setRegisterData(null)
    setCancellationData(null)
    setTargetDraft(null)
    setSavedTarget(null)
    setRegisterSaved(false)
    setPinSaved(false)
    setFeedbackPrompt(null)
    setLastInjected([])
  }

  const openThread = (threadId) => {
    resetCards()
    setSheetOpen(false)
    setMenuOpen(false)
    setActiveThreadId(threadId)
    setMessages([])
    setThreadLoading(true)
    const token = ++loadToken.current
    api.getAIChatMessages(threadId)
      .then(stored => {
        if (loadToken.current !== token) return
        scrollMode.current = 'instant'
        setMessages(stored)
      })
      .catch(() => {})
      .finally(() => { if (loadToken.current === token) setThreadLoading(false) })
  }

  const newConversation = () => {
    loadToken.current += 1
    resetCards()
    setSheetOpen(false)
    setMenuOpen(false)
    setActiveThreadId(null)
    setMessages([])
    setThreadLoading(false)
    setVoiceNote('')
  }

  useEffect(() => {
    const initialMessage = location.state?.initialMessage
    const targetThreadId = location.state?.threadId
    // Read once; going back to this page later shouldn't fill the box again.
    if (location.state) navigate(location.pathname, { replace: true, state: null })

    // Pressing the button wakes the server, so it's up by the time the coach
    // has finished their first sentence.
    wakeServer().then(awake => { if (awake) awakeAt.current = Date.now() })

    Promise.all([
      api.getAIChatThreads().catch(() => []),
      api.getAIContextStatus().catch(() => null),
    ]).then(([threadList, ctx]) => {
      setThreads(threadList)
      setContext(ctx)
      if (initialMessage) {
        setInput(initialMessage)
        setTimeout(() => textareaRef.current?.focus(), 100)
      } else if (targetThreadId) {
        openThread(targetThreadId)
      }
      setLoading(false)
    })

    Promise.all([
      Promise.all(deskWeekStarts().map(week => api.getCalendar(week))).then(weeks => weeks.flat()).catch(() => []),
      api.getSessionsAwaitingDebrief().then(result => result?.items || []).catch(() => []),
    ]).then(([calendar, awaitingDebrief]) => setStartData({ calendar, awaitingDebrief }))
  }, [])

  // ---- Scrolling ----

  // A new message scrolls into view. A long reply is shown from its start,
  // not its end, so it can be read from the top.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const mode = scrollMode.current
    scrollMode.current = null
    if (mode === 'instant') {
      list.scrollTop = list.scrollHeight
      return
    }
    const reply = lastReplyRef.current
    if (mode === 'reply' && reply && reply.offsetHeight > list.clientHeight * 0.6) {
      reply.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    if (mode || sending) bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [messages, sending])

  // Cards that arrive after the reply (the register, a target) come into view too.
  useEffect(() => {
    if (registerData || targetDraft || sessionDraft || feedbackPrompt) {
      bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
    }
  }, [registerData, targetDraft, sessionDraft, feedbackPrompt])

  // The message box grows with what's typed, up to a few lines.
  useLayoutEffect(() => {
    const box = textareaRef.current
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${Math.min(box.scrollHeight, 160)}px`
  }, [input, recording, transcribing])

  // ---- Sending ----

  const ensureAwake = async () => {
    if (Date.now() - awakeAt.current < AWAKE_FOR_MS) return
    let done = false
    const slow = window.setTimeout(() => { if (!done) setWaking(true) }, 700)
    const awake = await wakeServer()
    done = true
    window.clearTimeout(slow)
    setWaking(false)
    if (awake) awakeAt.current = Date.now()
  }

  const recoverSavedReply = async (threadId, expectedMessage, requestStartedAt, hasImage) => {
    const delays = [0, 1500, 3000, 5000]
    for (const delay of delays) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      try {
        const stored = await api.getAIChatMessages(threadId)
        const expectedIndex = stored.findLastIndex(message => {
          if (message.role !== 'user') return false
          const savedText = (message.message || '').trim()
          const textMatches = hasImage
            ? savedText.startsWith('[Photo') && (!expectedMessage || savedText.includes(expectedMessage))
            : savedText === expectedMessage
          const savedAt = message.created_at ? new Date(message.created_at).getTime() : 0
          return textMatches && savedAt >= requestStartedAt - 120000
        })
        if (expectedIndex >= 0 && stored.slice(expectedIndex + 1).some(message => message.role === 'assistant')) {
          scrollMode.current = 'bottom'
          setMessages(stored)
          return true
        }
      } catch {}
    }
    return false
  }

  const markFailed = (id, text, photo) => {
    setMessages(previous => previous.map(m => (m.id === id ? { ...m, failed: true, retry: { text, photo } } : m)))
  }

  // What came back alongside the reply: drafts to review, cards to fill in,
  // somewhere to go next.
  const handleReplyExtras = async (res, { msg, displayMsg, threadId, history }) => {
    // Skill result — meso plan draft
    if (res.skill_result?.type === 'meso_plan' && res.skill_result.draft) {
      setSuggestedAction({
        label: 'Review and save this block',
        type: 'view_season_plan',
        plan_type: 'meso',
        meso_draft: res.skill_result.draft,
      })
    }

    if (res.skill_result?.type === 'macro_plan' && res.skill_result.draft) {
      setSuggestedAction({
        label: 'Review and save this season plan',
        type: 'view_season_plan',
        plan_type: 'macro',
        macro_draft: res.skill_result.draft,
      })
    }

    // Year-level and pathway drafts are reviewed on the planning page, where the
    // timeline they change is on screen.
    if ((res.skill_result?.type === 'season_macros' || res.skill_result?.type === 'pathway_plan')
        && res.skill_result.draft) {
      setSuggestedAction({
        label: res.skill_result.type === 'season_macros'
          ? 'Review these macrocycles'
          : 'Review these pathways',
        type: 'view_planning',
        plan_kind: res.skill_result.type,
        plan_draft: res.skill_result.draft,
      })
    }

    if (res.skill_result?.type === 'micro_plan' && res.skill_result.draft) {
      setSuggestedAction({
        label: 'Review and save this weekly plan',
        type: 'view_season_plan',
        plan_type: 'micro',
        micro_draft: res.skill_result.draft,
      })
    }

    // Skill result — race analysis (analysis already in reply; suggest viewing the meet)
    if (res.skill_result?.type === 'race_analysis' && res.skill_result.meet_id) {
      setSuggestedAction({
        label: `View ${res.skill_result.meet_name || 'meet'} details`,
        type: 'view_meet',
        meet_id: res.skill_result.meet_id,
        meet_name: res.skill_result.meet_name,
      })
    }

    // Skill result — block review (analysis already in reply; suggest viewing season plan)
    if (res.skill_result?.type === 'block_review' && res.skill_result.block_id) {
      setSuggestedAction({
        label: 'View Season Plan',
        type: 'view_season_plan',
        block_id: res.skill_result.block_id,
        block_name: res.skill_result.block_name,
      })
    }

    // Skill result — adaptation review (analysis already in reply; set suggested action to view profile)
    if (res.skill_result?.type === 'adaptation_review' && res.skill_result.swimmer_id) {
      setSuggestedAction({
        label: `View ${res.skill_result.swimmer_name}'s full profile`,
        type: 'view_swimmer',
        swimmer_id: res.skill_result.swimmer_id,
        swimmer_name: res.skill_result.swimmer_name,
      })
    }

    // Skill result — taper plan
    if (res.skill_result?.type === 'taper_plan' && res.skill_result.swimmer_id) {
      setSuggestedAction({
        label: `View ${res.skill_result.swimmer_name}'s profile`,
        type: 'view_swimmer',
        swimmer_id: res.skill_result.swimmer_id,
        swimmer_name: res.skill_result.swimmer_name,
      })
    }

    // Skill result — session plan draft
    if (res.skill_result?.type === 'session_plan' && res.skill_result.draft) {
      const d = res.skill_result.draft
      const groupsDict = d.groups || {}
      setSessionDraft({
        title: d.title || '',
        date: d.date || '',
        coach_intent: d.coach_intent || '',
        energy_system_focus: d.energy_system_focus || '',
        groups: Object.entries(groupsDict).map(([num, g]) => ({
          group_number: parseInt(num),
          description: g.description || '',
          sets: g.sets || '',
          volume_breakdown: g.volume_breakdown || {},
          sub_groups: [],
        })),
      })
    }

    if (res.saved_benchmarks?.length > 0) {
      setSavedBenchmarksToast(res.saved_benchmarks)
      setTimeout(() => setSavedBenchmarksToast(null), 5000)
    }
    if (res.saved_intents?.length > 0) {
      setSavedIntentsToast(res.saved_intents)
      setTimeout(() => setSavedIntentsToast(null), 7000)
    }

    // Auto-trigger register card if register topic detected
    if (res.cancellation_data) {
      setCancellationData(res.cancellation_data)
    } else if ((res.topics_detected || []).includes('register')) {
      // Newer backends resolve the slot as part of the deterministic chat
      // response. Keep the fallback for clients talking to an older server.
      const regData = res.register_data || await api.startRegister(msg, threadId)
      if (regData.session_id) {
        setRegisterData({ ...regData, attendance: null })
      }
    } else if (res.intent?.type === 'formal_target_capture' && res.intent?.swimmer_id) {
      const targetConversation = [
        ...history.map(message => `${message.role === 'user' ? 'Coach' : 'AI'}: ${message.message}`),
        `Coach: ${displayMsg}`,
        `AI: ${res.reply}`,
      ].join('\n')
      try {
        const preview = await api.previewTargetFromChat(res.intent.swimmer_id, targetConversation)
        setTargetDraft({
          ...preview.target,
          possible_duplicate_id: preview.possible_duplicate_id,
        })
      } catch (error) {
        setMessages(previous => [...previous, {
          role: 'assistant',
          message: `I couldn't prepare a formal target yet: ${error.message}`,
          id: Date.now() + 2,
        }])
      }
    } else if (res.suggested_action) {
      setSuggestedAction({
        label: res.suggested_action,
        type: res.intent?.type,
        swimmer_id: res.intent?.swimmer_id,
        swimmer_name: res.intent?.swimmer_name,
        new_status: res.intent?.new_status,
      })
    }
  }

  // `text` from a chip, the voice or a retry; nothing means what's in the box.
  const send = async (text, { image = null } = {}) => {
    const fromBox = text === undefined
    const msg = (fromBox ? input : text).trim()
    const photo = fromBox ? attachedImage : image
    if ((!msg && !photo) || sending) return

    const history = messages
    setVoiceNote('')
    setStartError('')
    if (fromBox) {
      setInput('')
      setAttachedImage(null)
    }
    setSending(true)
    setSuggestedAction(null)
    setActionResult(null)
    setTargetDraft(null)
    setSavedTarget(null)
    setPinSaved(false)

    const displayMsg = photo ? `[Photo attached] ${msg || ''}`.trim() : msg
    const localId = `sent-${Date.now()}`
    scrollMode.current = 'bottom'
    setMessages(previous => [...previous, {
      role: 'user', message: displayMsg, id: localId,
      imagePreview: photo?.preview,
    }])

    await ensureAwake()

    // A conversation is only made once something is said in it.
    let threadId = activeThreadId
    if (!threadId) {
      try {
        const thread = await api.createAIChatThread()
        threadId = thread.id
        setThreads(previous => [{ thread_type: 'general', message_count: 0, ...thread }, ...previous])
        setActiveThreadId(thread.id)
      } catch {
        markFailed(localId, msg, photo)
        setSending(false)
        return
      }
    }
    // Named as the server names it, so the header and list show it at once.
    setThreads(previous => previous.map(t => (t.id === threadId ? {
      ...t,
      name: t.name || conversationName(displayMsg),
      last_message_at: new Date().toISOString(),
      message_count: (t.message_count || 0) + 1,
    } : t)))

    const requestStartedAt = Date.now()
    try {
      const res = photo
        ? await api.sendAIChatMessageWithImage(msg, photo.file, threadId, poolside)
        : await api.sendAIChatMessage(msg, threadId, poolside)
      awakeAt.current = Date.now()
      setLastInjected(res.context_injected || [])
      scrollMode.current = 'reply'
      setMessages(previous => [...previous, { role: 'assistant', message: res.reply, id: `reply-${Date.now()}` }])
      await handleReplyExtras(res, { msg, displayMsg, threadId, history })
    } catch (e) {
      const recovered = await recoverSavedReply(threadId, msg, requestStartedAt, Boolean(photo))
      if (!recovered) markFailed(localId, msg, photo)
    }
    setSending(false)
  }
  sendRef.current = send

  const retry = (message) => {
    setMessages(previous => previous.filter(m => m.id !== message.id))
    send(message.retry.text, { image: message.retry.photo })
  }

  const handleImagePick = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const preview = URL.createObjectURL(file)
    setAttachedImage({ file, preview })
    e.target.value = ''
  }

  // ---- The mic: hold to talk, or tap and talk ----

  const settlePress = (press) => {
    pressRef.current = null
    if (press.up - press.at >= HOLD_MS) {
      stopVoice()
    } else {
      setHandsFree(true)
      listenForPause()
    }
  }

  const micDown = async (event) => {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    if (transcribing) return
    // Listening hands-free: a tap sends now.
    if (recording) {
      stopVoice()
      return
    }
    setVoiceNote('')
    clearVoiceError()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    primeMicrophone()
    const press = { at: Date.now(), up: 0, started: false }
    pressRef.current = press
    await startVoice()
    press.started = true
    // Let go while the mic was still opening (the first time, the phone asks).
    if (press.up && pressRef.current === press) settlePress(press)
  }

  const micUp = () => {
    const press = pressRef.current
    if (!press || press.up) return
    press.up = Date.now()
    if (press.started) settlePress(press)
  }

  // ---- Start screen ----

  const runSuggestion = async (suggestion) => {
    if (suggestion.kind === 'plan') {
      send(suggestion.message)
      return
    }
    if (suggestion.kind === 'debrief') {
      navigate(`/debrief?session=${suggestion.sessionId}`)
      return
    }
    const register = suggestion.kind === 'register'
    const to = id => (register ? `/sessions/${id}/register` : `/sessions/${id}`)
    if (suggestion.session.session_id) {
      navigate(to(suggestion.session.session_id))
      return
    }
    // A timetabled session with no record yet gets one the first time it's opened.
    setOpening(suggestion.kind)
    setStartError('')
    try {
      const created = await api.startCalendarSession(
        { pool_slot_id: suggestion.session.slot_id, date: suggestion.session.date },
        { onWaking: () => setWaking(true) },
      )
      navigate(to(created.id))
    } catch (error) {
      setStartError(`Could not open ${register ? 'the register' : 'the session'}: ${error.message}. Check you have signal and try again.`)
    }
    setOpening('')
    setWaking(false)
  }

  const openPlanningThread = async (kind) => {
    try {
      const thread = kind === 'season_plan'
        ? await api.getOrCreateSeasonPlanThread()
        : await api.getOrCreateAthletePlanThread()
      setThreads(previous => (previous.some(t => t.id === thread.id)
        ? previous
        : [{ thread_type: kind, last_message_at: thread.created_at, ...thread }, ...previous]))
      openThread(thread.id)
      return true
    } catch {
      return false
    }
  }

  const deleteThread = async (thread) => {
    if (!window.confirm(`Delete "${conversationTitle(thread)}"? This can't be undone.`)) return
    try {
      await api.deleteAIChatThread(thread.id)
    } catch (error) {
      window.alert(`Could not delete it: ${error.message}`)
      return
    }
    setThreads(previous => previous.filter(t => t.id !== thread.id))
    if (activeThreadId === thread.id) newConversation()
  }

  // ---- The card under a reply ----

  const handleSuggestedAction = async () => {
    if (!suggestedAction || actioning) return
    const { type, swimmer_id } = suggestedAction
    setActioning(true)

    const conversationContext = messages
      .map(m => `${m.role === 'user' ? 'Coach' : 'AI'}: ${m.message}`)
      .join('\n')
    const conversationMessages = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.message }))

    try {
      if (type === 'view_meet' && suggestedAction.meet_id) {
        navigate(`/meets/${suggestedAction.meet_id}`)
        return
      } else if (type === 'open_season_plan_thread' || type === 'open_athlete_plan_thread') {
        const opened = await openPlanningThread(type === 'open_season_plan_thread' ? 'season_plan' : 'athlete_planning')
        if (!opened) setActionResult('error')
        else setSuggestedAction(null)
      } else if (type === 'view_planning') {
        stashDraft(suggestedAction.plan_kind, suggestedAction.plan_draft)
        navigate('/planning')
        return
      } else if (type === 'view_season_plan') {
        if (suggestedAction.plan_type) {
          sessionStorage.setItem('dx_plan_handoff', JSON.stringify(suggestedAction))
        }
        navigate('/season')
        return
      } else if (type === 'view_swimmer' && swimmer_id) {
        navigate(`/swimmers/${swimmer_id}`)
        return
      } else if (type === 'status_change' && swimmer_id && suggestedAction.new_status) {
        await api.updateSwimmer(swimmer_id, { status: suggestedAction.new_status })
        setActionResult('saved')
      } else if (type === 'benchmark_capture' && swimmer_id) {
        const result = await api.saveBenchmarkFromChat(swimmer_id, conversationContext)
        if (result.saved?.length > 0) {
          setSavedBenchmarksToast(result.saved)
          setTimeout(() => setSavedBenchmarksToast(null), 5000)
        }
        setActionResult('saved')
      } else if (type === 'coaching_intent' && swimmer_id) {
        const result = await api.saveCoachingIntentFromChat(swimmer_id, conversationContext)
        if (result.saved?.length > 0) {
          setSavedIntentsToast(result.saved)
          setTimeout(() => setSavedIntentsToast(null), 7000)
        }
        setActionResult('saved')
      } else if (type === 'athlete_profile_update' && swimmer_id) {
        await api.updateAthleteProfileFromChat(swimmer_id, conversationMessages)
        setActionResult('saved')
      } else if (type === 'session_writing') {
        const draft = await api.extractSessionDraft(activeThreadId)
        setSessionDraft(draft)
        setSuggestedAction(null)
      } else if (type === 'meet_creation') {
        const result = await api.createMeetFromChat(activeThreadId)
        navigate(`/meets/${result.meet_id}`)
      } else if ((type === 'biological_profile' || type === 'race_profile' || type === 'training_profile' || type === 'performance_analysis') && swimmer_id) {
        // Always synthesise all three visible profile types from the conversation
        await Promise.all([
          api.synthesiseBiologicalProfile(swimmer_id, conversationContext),
          api.synthesiseTechnicalProfile(swimmer_id, conversationContext),
          api.synthesisePerformanceAnalysis(swimmer_id).catch(() => null), // may fail if not enough times
        ])
        setActionResult('saved')
      } else if (type === 'session_plan' || type === 'meet_prep') {
        setPinning(true)
        const result = await api.pinToSessions(activeThreadId)
        setPinDates(getDefaultDates())
        setPinModal(result)
        setPinning(false)
      } else if (type === 'season_plan') {
        setActionResult('season')
      } else {
        setActionResult('error')
      }
    } catch (e) {
      setPinning(false)
      if (swimmer_id) {
        setActionResult('error_with_link')
      } else {
        setActionResult('error')
      }
    }
    setActioning(false)
  }

  const dismissAction = () => {
    setSuggestedAction(null)
    setActionResult(null)
  }

  // ---- The menu ----

  const clear = async () => {
    setMenuOpen(false)
    if (!window.confirm('Clear this conversation? This cannot be undone.')) return
    stopSpeaking()
    await api.clearAIChat(activeThreadId)
    setMessages([])
    setThreads(previous => previous.map(t => (t.id === activeThreadId && !PLANNING_THREADS[t.thread_type]
      ? { ...t, name: null, message_count: 0 }
      : t)))
    setSuggestedAction(null)
    setActionResult(null)
    setCancellationData(null)
    setTargetDraft(null)
    setPinSaved(false)
    setLastInjected([])
  }

  const openPinModal = async () => {
    setMenuOpen(false)
    setPinning(true)
    try {
      const result = await api.pinToSessions(activeThreadId)
      setPinDates(getDefaultDates())
      setPinModal(result)
    } catch (e) {
      alert(`Could not summarise conversation: ${e.message}`)
    }
    setPinning(false)
  }

  const savePin = async () => {
    if (!pinModal) return
    setSaving(true)
    try {
      await api.createCoachingNote({
        title: pinModal.title,
        body: pinModal.body,
        swimmer_ids: pinModal.swimmer_ids,
        swimmer_names: pinModal.swimmer_names,
        date_from: pinDates.from,
        date_to: pinDates.to,
      })
      setPinModal(null)
      setPinSaved(true)
      setSuggestedAction(null)
      setActionResult('saved')
    } catch (e) {
      alert(`Failed to save note: ${e.message}`)
    }
    setSaving(false)
  }

  const togglePoolside = () => {
    setPoolside(on => {
      savePoolside(!on)
      return !on
    })
  }

  // ---- Drawing ----

  const activeThread = threads.find(t => t.id === activeThreadId) || null
  const actionCardClass = ACTION_COLOURS[suggestedAction ? (INTENT_LABELS[suggestedAction.type]?.colour || 'accent') : 'accent']
  const copy = actionCopy(suggestedAction)
  const lastReplyIndex = messages.map(m => m.role).lastIndexOf('assistant')
  const showStart = !loading && !activeThreadId && messages.length === 0
  const listening = recording || transcribing
  const showSend = !voiceSupported || (!listening && Boolean(input.trim() || attachedImage))

  return (
    <div className="flex flex-col" style={{ height: PAGE_HEIGHT }}>
      {registerSaved && <RegisterSavedOverlay />}

      {/* Header */}
      <div className="shrink-0 h-12 px-2 flex items-center gap-1 border-b border-pool-700">
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="p-2 rounded-lg text-pool-300 hover:text-pool-100"
          aria-label="Conversations"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h10.5" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-pool-100 truncate">
            {activeThread ? conversationTitle(activeThread) : 'LaneWatch AI'}
          </p>
          {poolside && <p className="text-[10px] text-amber-400 font-medium leading-tight">Poolside · short replies</p>}
        </div>
        <button
          type="button"
          onClick={togglePoolside}
          className={`text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-colors ${
            poolside ? 'bg-amber-600 text-white' : 'bg-pool-700 text-pool-400 hover:text-pool-200'
          }`}
          aria-pressed={poolside}
          title="Poolside mode: short replies"
        >
          Poolside
        </button>
        {(activeThreadId || messages.length > 0) && (
          <button
            type="button"
            onClick={newConversation}
            className="p-2 rounded-lg text-pool-300 hover:text-pool-100"
            aria-label="New conversation"
            title="New conversation"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
            </svg>
          </button>
        )}
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen(open => !open)}
            className="p-2 rounded-lg text-pool-300 hover:text-pool-100"
            aria-label="More"
            aria-expanded={menuOpen}
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
            </svg>
          </button>
          {menuOpen && (
            <>
              <button type="button" aria-label="Close menu" className="fixed inset-0 z-40 cursor-default" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-pool-800 border border-pool-600 rounded-xl shadow-xl py-1 text-sm">
                {activeThreadId && messages.length >= 2 && (
                  <button type="button" onClick={openPinModal} disabled={pinning || sending}
                    className="w-full text-left px-4 py-2.5 hover:bg-pool-700 disabled:opacity-50">
                    {pinning ? 'Summarising…' : 'Pin to sessions'}
                    <span className="block text-[11px] text-pool-500">Keep this in mind when planning</span>
                  </button>
                )}
                {activeThreadId && messages.length > 0 && (
                  <button type="button" onClick={clear} className="w-full text-left px-4 py-2.5 hover:bg-pool-700 text-red-300">
                    Clear this conversation
                  </button>
                )}
                <Link to="/context" onClick={() => setMenuOpen(false)} className="block px-4 py-2.5 hover:bg-pool-700">
                  Coaching context
                  <span className="block text-[11px] text-pool-500">
                    {context?.active ? `Using: ${context.title}` : 'None yet: build one'}
                  </span>
                </Link>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Coaching intent saved toast */}
      {savedIntentsToast && (
        <div className="mx-4 mt-2 bg-teal-900/60 border border-teal-700/50 rounded-xl px-3 py-2.5 flex items-start gap-2">
          <span className="text-teal-300 text-base mt-0.5">🎯</span>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-teal-200">Training intent saved to profile</p>
            <p className="text-xs text-teal-300 mt-0.5 leading-relaxed">
              {savedIntentsToast.map((i, idx) => (
                <span key={idx}>{idx > 0 ? ' · ' : ''}{i.swimmer_name}: {i.label}</span>
              ))}
            </p>
          </div>
          <button onClick={() => setSavedIntentsToast(null)} className="text-teal-500 hover:text-teal-300 text-sm shrink-0">✕</button>
        </div>
      )}

      {/* Benchmark saved toast */}
      {savedBenchmarksToast && (
        <div className="mx-4 mt-2 bg-indigo-900/60 border border-indigo-700/50 rounded-xl px-3 py-2.5 flex items-start gap-2">
          <span className="text-indigo-300 text-base mt-0.5">📌</span>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-indigo-200">Benchmarks saved</p>
            <p className="text-xs text-indigo-300 mt-0.5 leading-relaxed">
              {savedBenchmarksToast.map((b, i) => (
                <span key={i}>{i > 0 ? ' · ' : ''}{b.swimmer_name}: {b.label}</span>
              ))}
            </p>
          </div>
          <button onClick={() => setSavedBenchmarksToast(null)} className="text-indigo-500 hover:text-indigo-300 text-sm shrink-0">✕</button>
        </div>
      )}

      {/* Messages */}
      <div ref={listRef} className="flex-1 overflow-y-auto overscroll-contain px-4 py-3 space-y-3">

        {showStart && (
          <ChatStart
            suggestions={startSuggestions(startData)}
            recent={recentConversations(threads, { limit: 3 })}
            moreConversations={recentConversations(threads).length > 3}
            context={context}
            opening={opening}
            waking={waking}
            error={startError}
            voiceSupported={voiceSupported}
            onSuggestion={runSuggestion}
            onOpenThread={openThread}
            onShowAll={() => setSheetOpen(true)}
            onAsk={text => send(text)}
          />
        )}

        {threadLoading && messages.length === 0 && (
          <p className="text-sm text-pool-500 pt-2">Opening the conversation…</p>
        )}

        {messages.map((m, index) => (
          <div key={m.id} ref={index === lastReplyIndex ? lastReplyRef : undefined} className="space-y-1">
            <div className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed space-y-2 ${
                m.role === 'user'
                  ? `bg-accent-700 text-white rounded-br-sm ${m.failed ? 'opacity-60' : ''}`
                  : 'bg-pool-700 text-pool-200 rounded-bl-sm'
              }`}>
                {m.imagePreview && (
                  <img src={m.imagePreview} alt="Attached" className="rounded-xl max-h-40 object-cover w-full" />
                )}
                <MessageContent text={m.role === 'user' && m.message.startsWith('[Photo attached] ')
                  ? m.message.replace('[Photo attached] ', '').trim() || 'Photo attached'
                  : m.message} />
                {m.role === 'assistant' && (
                  <SpeakButton text={plainText(m.message)} speaker="interviewer" speakKey={`chat-${m.id}`} className="pt-0.5" />
                )}
              </div>
            </div>
            {m.failed && (
              <div className="flex justify-end">
                <button type="button" onClick={() => retry(m)} disabled={sending}
                  className="text-xs text-red-300 hover:text-red-200 px-1 disabled:opacity-50">
                  Didn't send. Tap to try again
                </button>
              </div>
            )}
          </div>
        ))}

        {sending && (
          <div className="flex justify-start">
            <div className="bg-pool-700 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-2.5">
              <ThinkingDots />
              {waking && <span className="text-xs text-pool-400">Waking the server…</span>}
            </div>
          </div>
        )}

        {lastInjected.length > 0 && !sending && (
          <p className="text-[11px] text-pool-500 px-1">
            Full profile loaded: <span className="text-pool-400">{lastInjected.join(', ')}</span>
          </p>
        )}

        {/* Suggested action card */}
        {suggestedAction && !sending && (
          <div className={`border rounded-xl px-4 py-3 space-y-2.5 ${actionCardClass}`}>
            {actionResult === null && (
              <>
                <p className="text-xs font-semibold">{suggestedAction.label}</p>
                {copy.detail && <p className="text-xs opacity-75">{copy.detail}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={handleSuggestedAction}
                    disabled={actioning}
                    className="flex-1 bg-white/10 hover:bg-white/20 disabled:opacity-50 rounded-lg py-2.5 text-xs font-semibold transition-colors"
                  >
                    {actioning ? copy.busy : copy.button}
                  </button>
                  <button
                    onClick={dismissAction}
                    className="px-3 py-2 text-xs opacity-60 hover:opacity-100"
                  >
                    Not now
                  </button>
                </div>
              </>
            )}
            {actionResult === 'saved' && (
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold">{copy.done || 'Done.'}</p>
                <button onClick={dismissAction} className="text-xs opacity-60 hover:opacity-100 shrink-0">OK</button>
              </div>
            )}
            {actionResult === 'season' && (
              <p className="text-xs">Season plan changes aren't auto-saved yet. Take the key points to the season plan to update it.</p>
            )}
            {actionResult === 'error' && (
              <p className="text-xs opacity-75">Couldn't do that from here. Try again, or do it from the page itself.</p>
            )}
            {actionResult === 'error_with_link' && (
              <div className="space-y-2">
                <p className="text-xs opacity-75">Couldn't save automatically.</p>
                <button
                  onClick={() => navigate(`/swimmers/${suggestedAction.swimmer_id}`)}
                  className="text-xs font-semibold underline opacity-90 hover:opacity-100"
                >
                  Open {suggestedAction.swimmer_name}'s profile →
                </button>
              </div>
            )}
          </div>
        )}

        {pinSaved && !suggestedAction && (
          <div className="border border-green-700/50 bg-green-900/20 rounded-xl px-4 py-3">
            <p className="text-xs text-green-300 font-semibold">Pinned. The AI will use this plan for sessions in that date range.</p>
          </div>
        )}

        {sessionDraft && (
          <SessionDraftCard
            draft={sessionDraft}
            saving={savingSession}
            onDismiss={() => setSessionDraft(null)}
            onConfirm={async (data) => {
              setSavingSession(true)
              try {
                const result = await api.createSessionFromChat(data)
                setSessionDraft(null)
                navigate(`/sessions/${result.session_id}`)
              } catch (e) {
                alert(`Could not create session: ${e.message}`)
              }
              setSavingSession(false)
            }}
          />
        )}

        {targetDraft && (
          <TargetDraftCard
            draft={targetDraft}
            onDismiss={() => setTargetDraft(null)}
            onSaved={(target) => {
              setSavedTarget({
                ...target,
                swimmer_name: targetDraft.swimmer_name,
              })
              setTargetDraft(null)
            }}
          />
        )}

        {savedTarget && !targetDraft && (
          <div className="border border-indigo-700/50 bg-indigo-900/20 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-indigo-200">Formal target saved</p>
              <p className="text-xs text-indigo-300 mt-0.5">{savedTarget.swimmer_name} · {savedTarget.label}</p>
            </div>
            <Link to={`/swimmers/${savedTarget.swimmer_id}`} className="text-xs text-indigo-300 font-semibold shrink-0">View profile →</Link>
          </div>
        )}

        {registerData && !registerSaved && (
          <RegisterCard
            data={registerData}
            onDismiss={() => setRegisterData(null)}
            onSaved={(_sessionId, fbPrompt) => {
              setRegisterSaved(true)
              setRegisterData(null)
              if (fbPrompt) setFeedbackPrompt(fbPrompt)
            }}
          />
        )}

        <SessionCancellationDialog
          session={cancellationData}
          onClose={() => setCancellationData(null)}
          onCancelled={(result, reason) => {
            const label = cancellationData?.label || 'The session'
            setCancellationData(null)
            setMessages(previous => [...previous, {
              role: 'assistant',
              message: `${label} has been recorded as cancelled (${reason}). The recurring timetable is unchanged.`,
              id: `cancelled-${result.session_id}-${Date.now()}`,
            }])
          }}
        />

        {feedbackPrompt && (
          <div className="border border-accent-700/50 bg-accent-900/20 rounded-xl px-4 py-3 space-y-2.5">
            <p className="text-xs font-semibold text-accent-300">Session feedback</p>
            <p className="text-xs text-pool-300 leading-relaxed">{feedbackPrompt}</p>
            <div className="flex gap-2">
              <button
                onClick={() => { setFeedbackPrompt(null); setInput('It went well — session achieved the intent.') }}
                className="flex-1 bg-accent-700 hover:bg-accent-600 rounded-lg py-2 text-xs font-semibold transition-colors"
              >
                It went well
              </button>
              <button
                onClick={() => { setFeedbackPrompt(null); setInput('The session didn\'t quite achieve the intent — ') }}
                className="flex-1 bg-pool-700 hover:bg-pool-600 rounded-lg py-2 text-xs font-semibold transition-colors"
              >
                Not quite
              </button>
              <button onClick={() => setFeedbackPrompt(null)} className="px-3 text-xs text-pool-500 hover:text-pool-300">Dismiss</button>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Message box */}
      <div className="shrink-0 px-3 pt-2 pb-3 border-t border-pool-700">
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImagePick} />
        {voiceError && (
          <div className="mb-2 bg-red-900 border border-red-700 text-red-200 text-xs rounded-xl px-3 py-2 flex items-center justify-between gap-2">
            <span>{voiceError}</span>
            <button onClick={clearVoiceError} className="text-red-400 hover:text-red-200 text-base leading-none shrink-0" aria-label="Dismiss">×</button>
          </div>
        )}
        {voiceNote && !listening && (
          <p className="mb-1.5 px-2 text-xs text-pool-400">{voiceNote}</p>
        )}
        {attachedImage && !listening && (
          <div className="mb-2 ml-1 relative inline-block">
            <img src={attachedImage.preview} alt="Attached" className="h-16 rounded-lg object-cover border border-pool-600" />
            <button onClick={() => setAttachedImage(null)} aria-label="Remove photo"
              className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-pool-600 rounded-full text-xs text-pool-200 flex items-center justify-center">×</button>
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className={`flex-1 min-w-0 min-h-[44px] flex items-end rounded-3xl border transition-colors ${
            recording ? 'bg-red-950/40 border-red-700/60'
              : transcribing ? 'bg-pool-700 border-yellow-600/60'
                : 'bg-pool-700 border-pool-600 focus-within:border-accent-500'
          }`}>
            {listening ? (
              <div className="flex-1 flex items-center gap-2 pl-1 pr-3 min-h-[42px]">
                {recording ? (
                  <button type="button" onClick={cancelVoice} aria-label="Cancel"
                    className="w-9 h-9 shrink-0 rounded-full text-pool-300 hover:text-pool-100 flex items-center justify-center">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                    </svg>
                  </button>
                ) : (
                  <span className="w-9 h-9 shrink-0 flex items-center justify-center">
                    <svg className="w-4 h-4 animate-spin text-yellow-400" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                  </span>
                )}
                {recording && <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />}
                <span className="text-sm text-pool-200 truncate">
                  {transcribing ? 'Writing that down…'
                    : handsFree ? "Listening. I'll send when you stop"
                      : 'Listening… let go to send'}
                </span>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-11 h-11 shrink-0 flex items-center justify-center text-pool-400 hover:text-pool-200 rounded-full"
                  aria-label="Attach photo"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
                  </svg>
                </button>
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() } }}
                  placeholder={voiceSupported ? 'Message, or hold the mic' : 'Message LaneWatch AI'}
                  rows={1}
                  className="flex-1 min-w-0 bg-transparent py-2.5 pr-4 text-base leading-6 placeholder:text-pool-500 focus:outline-none resize-none"
                />
              </>
            )}
          </div>

          {showSend ? (
            <button
              type="button"
              onClick={() => send()}
              disabled={sending || (!input.trim() && !attachedImage)}
              className="w-11 h-11 shrink-0 rounded-full bg-accent-600 hover:bg-accent-500 active:bg-accent-700 disabled:opacity-30 flex items-center justify-center transition-colors"
              aria-label="Send"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onPointerDown={micDown}
              onPointerUp={micUp}
              onPointerCancel={micUp}
              onContextMenu={e => e.preventDefault()}
              disabled={transcribing}
              style={{ touchAction: 'none' }}
              className={`relative w-11 h-11 shrink-0 rounded-full flex items-center justify-center select-none transition-all ${
                recording ? 'bg-red-600 text-white scale-110' : 'bg-accent-600 hover:bg-accent-500 text-white disabled:opacity-40'
              }`}
              aria-label={recording ? (handsFree ? 'Send now' : 'Let go to send') : transcribing ? 'Writing that down' : 'Hold to talk, or tap and talk'}
            >
              {recording && <span className="absolute inset-0 rounded-full bg-red-500/40 animate-ping" />}
              {recording && handsFree ? (
                <svg className="relative w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
                </svg>
              ) : (
                <svg className="relative w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
                </svg>
              )}
            </button>
          )}
        </div>
      </div>

      {sheetOpen && (
        <ConversationsSheet
          threads={threads}
          activeThreadId={activeThreadId}
          onClose={() => setSheetOpen(false)}
          onOpen={openThread}
          onDelete={deleteThread}
          onNew={newConversation}
          onPlanning={openPlanningThread}
        />
      )}

      {/* Pin modal */}
      {pinModal && (
        <div className="fixed inset-0 bg-black/70 z-[60] flex items-end justify-center p-4">
          <div className="bg-pool-800 border border-pool-600 rounded-2xl w-full max-w-lg p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-bold text-base">Pin to sessions</h2>
              <button onClick={() => setPinModal(null)} className="text-pool-500 hover:text-pool-300 text-lg leading-none">×</button>
            </div>

            <div>
              <label className="text-xs text-pool-400 block mb-1">Title</label>
              <input
                value={pinModal.title}
                onChange={e => setPinModal(p => ({ ...p, title: e.target.value }))}
                className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
              />
            </div>

            <div>
              <label className="text-xs text-pool-400 block mb-1">Plan (edit if needed)</label>
              <textarea
                value={pinModal.body}
                onChange={e => setPinModal(p => ({ ...p, body: e.target.value }))}
                rows={5}
                className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-accent-500 resize-none"
              />
            </div>

            {pinModal.swimmer_names?.length > 0 && (
              <p className="text-xs text-pool-400">
                Applies to: <span className="text-pool-200">{pinModal.swimmer_names.join(', ')}</span>
              </p>
            )}

            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-xs text-pool-400 block mb-1">From</label>
                <input type="date" value={pinDates.from}
                  onChange={e => setPinDates(p => ({ ...p, from: e.target.value }))}
                  className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
                />
              </div>
              <div className="flex-1">
                <label className="text-xs text-pool-400 block mb-1">To</label>
                <input type="date" value={pinDates.to}
                  onChange={e => setPinDates(p => ({ ...p, to: e.target.value }))}
                  className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
                />
              </div>
            </div>

            <p className="text-xs text-pool-500">
              This note will inform AI context for all session planning during this period. Expires automatically — won't affect swimmer profiles.
            </p>

            <div className="flex gap-3">
              <button onClick={() => setPinModal(null)}
                className="flex-1 border border-pool-600 rounded-xl py-2.5 text-sm text-pool-400">
                Cancel
              </button>
              <button onClick={savePin} disabled={saving}
                className="flex-1 bg-accent-600 hover:bg-accent-500 disabled:opacity-50 rounded-xl py-2.5 text-sm font-semibold transition-colors">
                {saving ? 'Saving…' : 'Pin to sessions'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

const SUGGESTION_DOTS = {
  open: 'bg-accent-400',
  register: 'bg-blue-400',
  debrief: 'bg-teal-400',
  plan: 'bg-amber-400',
}

function SectionLabel({ children }) {
  return <p className="text-[11px] text-pool-500 uppercase tracking-wider font-semibold mb-2">{children}</p>
}

function Chevron() {
  return (
    <svg className="w-4 h-4 text-pool-500 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
    </svg>
  )
}

// What the chat shows when it opens: what's on now, where the coach left off,
// and a couple of things to ask.
function ChatStart({
  suggestions, recent, moreConversations, context, opening, waking, error, voiceSupported,
  onSuggestion, onOpenThread, onShowAll, onAsk,
}) {
  return (
    <div className="space-y-6 pt-2 pb-2">
      <div>
        <p className="text-lg font-semibold text-pool-100">What do you need?</p>
        <p className="text-sm text-pool-400 mt-1 leading-relaxed">
          {voiceSupported
            ? 'Type, or hold the mic and talk. A quick tap on the mic listens until you stop.'
            : 'Ask about a swimmer, a session, a gala or the plan.'}
        </p>
      </div>

      {suggestions.length > 0 && (
        <section>
          <SectionLabel>Right now</SectionLabel>
          <div className="space-y-2">
            {suggestions.map(suggestion => (
              <button
                key={`${suggestion.kind}-${suggestion.title}`}
                type="button"
                onClick={() => onSuggestion(suggestion)}
                disabled={Boolean(opening)}
                className="w-full flex items-center gap-3 bg-pool-800 border border-pool-700 hover:border-accent-600/60 rounded-2xl px-4 py-3 text-left transition-colors disabled:opacity-60"
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${SUGGESTION_DOTS[suggestion.kind]}`} />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-pool-100 truncate">{suggestion.title}</span>
                  <span className="block text-xs text-pool-400 truncate">{suggestion.detail}</span>
                </span>
                {opening === suggestion.kind
                  ? <span className="text-xs text-pool-400 shrink-0">{waking ? 'Waking…' : 'Opening…'}</span>
                  : <Chevron />}
              </button>
            ))}
          </div>
          {error && <p className="text-xs text-red-300 mt-2">{error}</p>}
        </section>
      )}

      {recent.length > 0 && (
        <section>
          <SectionLabel>Carry on</SectionLabel>
          <div className="bg-pool-800 border border-pool-700 rounded-2xl divide-y divide-pool-700/70 overflow-hidden">
            {recent.map(thread => (
              <button
                key={thread.id}
                type="button"
                onClick={() => onOpenThread(thread.id)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-pool-700/60 transition-colors"
              >
                <span className="flex-1 min-w-0 text-sm text-pool-200 truncate">{conversationTitle(thread)}</span>
                <span className="text-xs text-pool-500 shrink-0">{relativeTime(thread.last_message_at)}</span>
              </button>
            ))}
            {moreConversations && (
              <button type="button" onClick={onShowAll}
                className="w-full px-4 py-2.5 text-left text-xs font-medium text-accent-300 hover:bg-pool-700/60">
                All conversations
              </button>
            )}
          </div>
        </section>
      )}

      <section>
        <SectionLabel>Or ask</SectionLabel>
        <div className="flex flex-wrap gap-2">
          {TRY_ASKING.map(text => (
            <button
              key={text}
              type="button"
              onClick={() => onAsk(text)}
              className="text-xs bg-pool-800 hover:bg-pool-700 border border-pool-700 hover:border-accent-600/50 rounded px-3 py-2 text-pool-300 transition-colors"
            >
              {text}
            </button>
          ))}
        </div>
      </section>

      <p className="text-xs text-pool-500 flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${context?.active ? 'bg-green-500' : 'bg-pool-600'}`} />
        {context?.active
          ? <span>Using your coaching context: <span className="text-pool-300">{context.title}</span></span>
          : <span>No coaching context yet. <Link to="/context" className="text-accent-400 underline">Build one</Link></span>}
      </p>
    </div>
  )
}

// Every conversation, newest first, with the planning conversations to hand.
function ConversationsSheet({ threads, activeThreadId, onClose, onOpen, onDelete, onNew, onPlanning }) {
  const list = recentConversations(threads)
  const [planningError, setPlanningError] = useState('')

  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const openPlanning = async (kind) => {
    setPlanningError('')
    if (!(await onPlanning(kind))) setPlanningError('Could not open that just now. Try again in a moment.')
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" role="dialog" aria-modal="true" aria-label="Conversations">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/60 cursor-default" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-pool-800 border-t border-pool-600 rounded-t-2xl max-h-[80dvh] flex flex-col safe-bottom">
        <div className="flex items-center justify-between px-4 pt-4 pb-3">
          <h2 className="text-base font-semibold">Conversations</h2>
          <button type="button" onClick={onClose} className="text-sm text-accent-300 px-2 py-1">Done</button>
        </div>
        <div className="px-4 pb-3 space-y-2">
          <button type="button" onClick={onNew}
            className="w-full bg-accent-600 hover:bg-accent-500 rounded-xl py-2.5 text-sm font-semibold transition-colors">
            New conversation
          </button>
          <div className="flex gap-2">
            {Object.entries(PLANNING_THREADS).map(([kind, label]) => (
              <button key={kind} type="button" onClick={() => openPlanning(kind)}
                className={`flex-1 rounded-xl py-2 text-xs font-medium border transition-colors ${
                  kind === 'season_plan'
                    ? 'text-teal-300 bg-teal-900/30 border-teal-700/40 hover:bg-teal-900/50'
                    : 'text-orange-300 bg-orange-900/30 border-orange-700/40 hover:bg-orange-900/50'
                }`}>
                {label}
              </button>
            ))}
          </div>
          {planningError && <p className="text-xs text-red-300">{planningError}</p>}
        </div>
        <div className="overflow-y-auto overscroll-contain px-2 pb-4 border-t border-pool-700/70 pt-2">
          {list.length === 0 ? (
            <p className="text-sm text-pool-500 px-3 py-4">Nothing yet. What you talk about will be kept here.</p>
          ) : list.map(thread => (
            <div key={thread.id} className={`flex items-center rounded-xl ${thread.id === activeThreadId ? 'bg-pool-700' : 'hover:bg-pool-700/50'}`}>
              <button type="button" onClick={() => onOpen(thread.id)} className="flex-1 min-w-0 text-left px-3 py-2.5">
                <span className="block text-sm text-pool-100 truncate">{conversationTitle(thread)}</span>
                <span className="block text-xs text-pool-500 mt-0.5">{relativeTime(thread.last_message_at)}</span>
              </button>
              <button type="button" onClick={() => onDelete(thread)} aria-label={`Delete ${conversationTitle(thread)}`}
                className="p-3 text-pool-600 hover:text-red-400 shrink-0">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const ENERGY_OPTIONS = ['aerobic', 'threshold', 'vo2max', 'speed_endurance', 'sprint', 'recovery', 'mixed']

function SessionDraftCard({ draft, saving, onConfirm, onDismiss }) {
  const { settings: presentation, energy } = useSessionPresentation()
  const [data, setData] = useState(() => ({
    ...draft,
    groups: (draft.groups || []).map(g => ({
      ...g,
      sets: Array.isArray(g.sets) ? g.sets.join('\n') : (g.sets || ''),
      sub_groups: (g.sub_groups || []).map(sg => ({
        ...sg,
        sets: Array.isArray(sg.sets) ? sg.sets.join('\n') : (sg.sets || ''),
      })),
    })),
  }))

  const setField = (key, val) => setData(p => ({ ...p, [key]: val }))
  const setGroup = (i, key, val) => setData(p => ({
    ...p,
    groups: p.groups.map((g, idx) => idx === i ? { ...g, [key]: val } : g),
  }))
  const setSubGroup = (gi, si, key, val) => setData(p => ({
    ...p,
    groups: p.groups.map((g, gIdx) => gIdx !== gi ? g : {
      ...g,
      sub_groups: g.sub_groups.map((sg, sIdx) => sIdx !== si ? sg : { ...sg, [key]: val }),
    }),
  }))

  const buildSubmit = () => ({
    ...data,
    groups: data.groups.map(g => ({
      ...g,
      sets: typeof g.sets === 'string' ? g.sets.split('\n').map(s => s.trim()).filter(Boolean) : g.sets,
      sub_groups: (g.sub_groups || []).map(sg => ({
        ...sg,
        sets: typeof sg.sets === 'string' ? sg.sets.split('\n').map(s => s.trim()).filter(Boolean) : sg.sets,
      })),
    })),
  })

  return (
    <div className="border border-teal-700/50 bg-teal-900/15 rounded-2xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold text-teal-300 uppercase tracking-wide">Session draft — review before saving</p>
        <button onClick={onDismiss} className="text-pool-500 hover:text-pool-300 text-base leading-none shrink-0">×</button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <label className="text-xs text-pool-400 block mb-1">Title</label>
          <input
            value={data.title || ''}
            onChange={e => setField('title', e.target.value)}
            className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-teal-500"
          />
        </div>
        <div>
          <label className="text-xs text-pool-400 block mb-1">Date</label>
          <input
            type="date"
            value={data.date || ''}
            onChange={e => setField('date', e.target.value)}
            className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-teal-500"
          />
        </div>
        <div>
          <label className="text-xs text-pool-400 block mb-1">Energy focus</label>
          <select
            value={data.energy_system_focus || ''}
            onChange={e => setField('energy_system_focus', e.target.value)}
            className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-teal-500"
          >
            <option value="">— select —</option>
            {[...new Set([
              ...presentation.terminology_levels.map(level => level.canonical_zone),
              data.energy_system_focus,
              ...ENERGY_OPTIONS,
            ].filter(Boolean))].map(option => <option key={option} value={option}>{energy(option).label}</option>)}
          </select>
        </div>
      </div>

      {data.coach_intent && (
        <div>
          <label className="text-xs text-pool-400 block mb-1">Coach intent</label>
          <textarea
            value={data.coach_intent}
            onChange={e => setField('coach_intent', e.target.value)}
            rows={2}
            className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-teal-500 resize-none"
          />
        </div>
      )}

      {data.individual_mods && Object.keys(data.individual_mods).length > 0 && (
        <div className="bg-amber-900/20 border border-amber-700/40 rounded-xl p-3 space-y-1.5">
          <p className="text-xs font-semibold text-amber-300 uppercase tracking-wide">Individual Modifications</p>
          {Object.entries(data.individual_mods).map(([name, note]) => (
            <div key={name} className="flex gap-2 items-start">
              <span className="text-xs font-medium text-amber-200 shrink-0 w-24 truncate">{name}</span>
              <input
                value={note}
                onChange={e => setField('individual_mods', { ...data.individual_mods, [name]: e.target.value })}
                className="flex-1 bg-pool-700 border border-pool-600 rounded px-2 py-1 text-xs focus:outline-none focus:border-amber-500"
              />
            </div>
          ))}
        </div>
      )}

      {data.groups?.length > 0 && (
        <div className="space-y-2.5">
          <p className="text-xs text-pool-400 font-medium">Groups</p>
          {data.groups.map((g, i) => (
            <div key={i} className="bg-pool-800 border border-pool-700 rounded-xl p-3 space-y-2">
              <p className="text-xs font-semibold text-pool-200">Group {g.group_number}</p>
              <input
                value={g.description || ''}
                onChange={e => setGroup(i, 'description', e.target.value)}
                placeholder="Description / who this is for"
                className="w-full bg-pool-700 border border-pool-600 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-teal-500"
              />

              {/* Sub-groups (if present) */}
              {(g.sub_groups || []).length > 0 ? (
                <div className="space-y-2 mt-1">
                  {g.sub_groups.map((sg, si) => (
                    <div key={si} className="bg-pool-750 border border-pool-600/60 rounded-lg p-2 space-y-1.5 pl-3 border-l-2 border-l-teal-700/60">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-teal-400">Sub-group {sg.label}</span>
                        {sg.swimmer_names?.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {sg.swimmer_names.map(n => (
                              <span key={n} className="text-xs bg-teal-900/40 text-teal-300 border border-teal-800/50 rounded px-1.5 py-0">{n}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <input
                        value={sg.aim || ''}
                        onChange={e => setSubGroup(i, si, 'aim', e.target.value)}
                        placeholder="Aim / focus for this sub-group"
                        className="w-full bg-pool-700 border border-pool-600 rounded px-2 py-1 text-xs focus:outline-none focus:border-teal-500"
                      />
                      <textarea
                        value={typeof sg.sets === 'string' ? sg.sets : (sg.sets || []).join('\n')}
                        onChange={e => setSubGroup(i, si, 'sets', e.target.value)}
                        rows={3}
                        placeholder="Sets — one per line"
                        className="w-full bg-pool-700 border border-pool-600 rounded px-2 py-1 text-xs focus:outline-none focus:border-teal-500 resize-none font-mono leading-relaxed"
                      />
                    </div>
                  ))}
                </div>
              ) : (
                /* No sub-groups: show flat sets textarea */
                <textarea
                  value={typeof g.sets === 'string' ? g.sets : (g.sets || []).join('\n')}
                  onChange={e => setGroup(i, 'sets', e.target.value)}
                  rows={3}
                  placeholder="Sets — one per line"
                  className="w-full bg-pool-700 border border-pool-600 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-teal-500 resize-none font-mono leading-relaxed"
                />
              )}

              {/* Group-level swimmer names (when no sub-groups) */}
              {(g.sub_groups || []).length === 0 && g.swimmer_names?.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {g.swimmer_names.map(n => (
                    <span key={n} className="text-xs bg-teal-900/40 text-teal-300 border border-teal-800/50 rounded px-2 py-0.5">{n}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={onDismiss}
          className="px-4 py-2.5 text-xs text-pool-400 border border-pool-700 rounded-xl"
        >
          Cancel
        </button>
        <button
          onClick={() => onConfirm(buildSubmit())}
          disabled={saving}
          className="flex-1 bg-teal-700 hover:bg-teal-600 disabled:opacity-50 rounded-xl py-2.5 text-sm font-semibold transition-colors"
        >
          {saving ? 'Creating…' : 'Create session'}
        </button>
      </div>
    </div>
  )
}

function TargetDraftCard({ draft, onDismiss, onSaved }) {
  const [form, setForm] = useState({
    label: draft.label || '',
    description: draft.description || '',
    distance: draft.distance || '',
    stroke: draft.stroke || '',
    effort: draft.effort || '',
    target_time_seconds: draft.target_time_seconds ?? '',
    deadline: draft.deadline || '',
  })
  const [saving, setSaving] = useState(false)

  const update = (field, value) => setForm(previous => ({ ...previous, [field]: value }))
  const save = async () => {
    if (!form.label.trim()) return
    setSaving(true)
    try {
      const target = await api.createTarget({
        swimmer_id: draft.swimmer_id,
        label: form.label.trim(),
        description: form.description.trim() || null,
        distance: form.distance ? Number(form.distance) : null,
        stroke: form.stroke.trim() || null,
        effort: form.effort.trim() || null,
        target_time_seconds: form.target_time_seconds !== '' ? Number(form.target_time_seconds) : null,
        deadline: form.deadline || null,
      })
      onSaved(target)
    } catch (error) {
      alert(`Could not save target: ${error.message}`)
      setSaving(false)
    }
  }

  return (
    <div className="border border-indigo-700/50 bg-indigo-900/15 rounded-2xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-indigo-300 uppercase tracking-wide">Review formal target</p>
          <p className="text-sm font-semibold text-pool-100 mt-0.5">{draft.swimmer_name}</p>
        </div>
        <button type="button" onClick={onDismiss} className="text-pool-500 text-base">×</button>
      </div>

      <p className="text-xs text-pool-400">This is the measurable outcome. Coaching methods and session watchpoints remain separate.</p>

      {draft.possible_duplicate_id && (
        <p className="text-xs text-amber-300 bg-amber-900/20 border border-amber-800/40 rounded-lg px-3 py-2">
          A similar active target may already exist. Check the details before saving another.
        </p>
      )}

      <label className="block">
        <span className="text-[11px] text-pool-400">Target label</span>
        <input value={form.label} onChange={event => update('label', event.target.value)}
          className="w-full mt-1 bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500" />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="text-[11px] text-pool-400">Distance (metres)</span>
          <input type="number" min="1" value={form.distance} onChange={event => update('distance', event.target.value)}
            className="w-full mt-1 bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500" />
        </label>
        <label>
          <span className="text-[11px] text-pool-400">Stroke/event</span>
          <input value={form.stroke} onChange={event => update('stroke', event.target.value)} placeholder="e.g. back"
            className="w-full mt-1 bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500" />
        </label>
        <label>
          <span className="text-[11px] text-pool-400">Target time (seconds)</span>
          <input type="number" min="0" step="0.01" value={form.target_time_seconds} onChange={event => update('target_time_seconds', event.target.value)}
            className="w-full mt-1 bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500" />
        </label>
        <label>
          <span className="text-[11px] text-pool-400">Deadline</span>
          <input type="date" value={form.deadline} onChange={event => update('deadline', event.target.value)}
            className="w-full mt-1 bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500" />
        </label>
      </div>

      <label className="block">
        <span className="text-[11px] text-pool-400">Context (optional)</span>
        <textarea value={form.description} onChange={event => update('description', event.target.value)} rows={2}
          className="w-full mt-1 bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-indigo-500" />
      </label>

      <div className="flex gap-2">
        <button type="button" onClick={onDismiss} disabled={saving} className="px-4 py-2.5 text-xs text-pool-400 border border-pool-700 rounded-xl disabled:opacity-50">Not yet</button>
        <button type="button" onClick={save} disabled={saving || !form.label.trim()}
          className="flex-1 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 rounded-xl py-2.5 text-sm font-semibold">
          {saving ? 'Saving…' : 'Save formal target'}
        </button>
      </div>
    </div>
  )
}

function RegisterCard({ data, onDismiss, onSaved }) {
  const initialGroupCount = data.register_group_count || null
  const initialAttendance = (data.attendees || []).map(a => ({
    swimmer_id: a.id,
    name: a.name,
    present: a.attended === true,
    group: a.group_done ?? (initialGroupCount === 1 ? 1 : null),
    note: '',
    exception_reason: a.exception_reason || null,
    usual_for_slot: a.usual_for_slot || false,
  }))
  const [attendance, setAttendance] = useState(initialAttendance)
  const [parseInput, setParseInput] = useState('')
  const [parsing, setParsing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [groupCount, setGroupCount] = useState(initialGroupCount)
  const [editingGroupCount, setEditingGroupCount] = useState(!initialGroupCount)
  const [savingGroupCount, setSavingGroupCount] = useState(false)

  const suppliedGroupNumbers = data.register_group_numbers || []
  const groupNumbers = groupCount > 1 && suppliedGroupNumbers.length === groupCount
    ? suppliedGroupNumbers
    : Array.from({ length: groupCount || 0 }, (_, index) => index + 1)

  const setEntry = (i, key, val) => setAttendance(prev => prev.map((e, idx) => idx === i ? { ...e, [key]: val } : e))

  const chooseGroupCount = async (count) => {
    setSavingGroupCount(true)
    try {
      await api.updateSession(data.session_id, { register_group_count: count })
      setGroupCount(count)
      setEditingGroupCount(false)
      setAttendance(previous => previous.map(entry => ({
        ...entry,
        group: count === 1 ? 1 : entry.group && entry.group <= count ? entry.group : null,
      })))
    } catch (error) {
      alert(`Could not save the session group setup: ${error.message}`)
    } finally {
      setSavingGroupCount(false)
    }
  }

  const handleParse = async () => {
    if (!parseInput.trim()) return
    setParsing(true)
    try {
      const res = await api.parseRegister({
        session_id: data.session_id,
        message: parseInput,
        attendees: data.attendees,
      })
      const parsed = res.attendance || []
      setAttendance(prev => prev.map(e => {
        const match = parsed.find(p => p.swimmer_id === e.swimmer_id)
        if (!match) return e
        return {
          ...e,
          present: match.present ?? e.present,
          group: match.group ?? e.group,
          note: match.note || e.note,
        }
      }))
      setParseInput('')
    } catch (err) {
      alert(`Parse failed: ${err.message}`)
    }
    setParsing(false)
  }

  const handleSubmit = async () => {
    setSaving(true)
    try {
      const res = await api.submitChatRegister({ session_id: data.session_id, attendance })
      onSaved(data.session_id, res.feedback_prompt || null)
    } catch (err) {
      alert(`Could not save register: ${err.message}`)
      setSaving(false)
    }
  }

  const presentCount = attendance.filter(e => e.present).length

  return (
    <div className="border border-blue-700/50 bg-blue-900/15 rounded-2xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-blue-300 uppercase tracking-wide">Register</p>
          <p className="text-xs text-pool-400 mt-0.5">{data.session_title} · {data.session_date}</p>
        </div>
        <button onClick={onDismiss} className="text-pool-500 hover:text-pool-300 text-base leading-none shrink-0">×</button>
      </div>

      {data.register_taken && (
        <p className="text-xs text-amber-400 bg-amber-900/20 border border-amber-800/40 rounded-lg px-3 py-2">
          Register already taken — submitting will overwrite it.
        </p>
      )}

      {groupCount && !editingGroupCount ? (
        <div className="flex items-center justify-between gap-2 bg-pool-800/60 border border-pool-700 rounded-xl px-3 py-2">
          <div>
            <p className="text-[10px] text-pool-500 uppercase tracking-wide font-semibold">Session format</p>
            <p className="text-xs text-pool-200 mt-0.5">{groupCount === 1 ? 'Everyone did the same session' : `${groupCount} training groups`}</p>
          </div>
          <button onClick={() => setEditingGroupCount(true)} className="text-xs text-blue-300 px-2 py-1.5">Change</button>
        </div>
      ) : (
        <div className="bg-amber-900/15 border border-amber-800/40 rounded-xl p-3">
          <p className="text-xs font-semibold text-amber-200">How many different programmes were done?</p>
          <div className="grid grid-cols-3 gap-1.5 mt-2">
            {[[1, 'Everyone'], [2, '2 groups'], [3, '3 groups']].map(([count, label]) => (
              <button key={count} onClick={() => chooseGroupCount(count)} disabled={savingGroupCount}
                className="bg-pool-700 border border-pool-600 rounded-lg px-2 py-2 text-[11px] font-semibold disabled:opacity-50">
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Freetext parse */}
      <div className="space-y-1.5">
        <p className="text-xs text-pool-400">Describe who's here (or edit manually below):</p>
        <div className="flex gap-2">
          <input
            value={parseInput}
            onChange={e => setParseInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleParse()}
            placeholder='e.g. "everyone except Tom, Sarah in group 2"'
            className="flex-1 bg-pool-700 border border-pool-600 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={handleParse}
            disabled={parsing || !parseInput.trim()}
            className="bg-blue-800 hover:bg-blue-700 disabled:opacity-40 rounded-xl px-3 py-2 text-xs font-semibold transition-colors shrink-0"
          >
            {parsing ? '…' : 'Parse'}
          </button>
        </div>
      </div>

      {/* Attendance list */}
      <div className="space-y-1.5">
        {attendance.map((e, i) => (
          <div key={e.swimmer_id} className={`flex items-center gap-2 rounded-xl px-3 py-2 ${e.present ? 'bg-pool-700' : 'bg-pool-800/50 opacity-60'}`}>
            <button
              onClick={() => setEntry(i, 'present', !e.present)}
              className={`w-6 h-6 rounded-full shrink-0 text-xs font-bold transition-colors ${
                e.present ? 'bg-green-600 text-white' : 'bg-pool-600 text-pool-400'
              }`}
            >
              {e.present ? '✓' : '×'}
            </button>
            <span className="flex-1 text-xs font-medium">{e.name}</span>
            {e.usual_for_slot && (
              <span className="text-[10px] text-teal-300">Usual</span>
            )}
            {e.exception_reason && !e.present && (
              <span className="text-xs text-amber-400">{e.exception_reason}</span>
            )}
            {e.present && groupCount > 1 && (
              <div className="flex gap-1 shrink-0">
                {groupNumbers.map(g => (
                  <button
                    key={g}
                    onClick={() => setEntry(i, 'group', e.group === g ? null : g)}
                    className={`w-6 h-6 rounded-lg text-xs font-semibold transition-colors ${
                      e.group === g ? 'bg-blue-700 text-white' : 'bg-pool-600 text-pool-400'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <p className="text-xs text-pool-500">{presentCount} of {attendance.length} present</p>

      <div className="flex gap-2 pt-1">
        <button
          onClick={onDismiss}
          className="px-4 py-2.5 text-xs text-pool-400 border border-pool-700 rounded-xl"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={saving || !groupCount}
          className="flex-1 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded-xl py-2.5 text-sm font-semibold transition-colors"
        >
          {!groupCount ? 'Choose session groups first' : saving ? 'Saving…' : 'Save register'}
        </button>
      </div>
    </div>
  )
}

function MessageContent({ text }) {
  const lines = text.split('\n')
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        if (!line.trim()) return null
        if (line.match(/^[-•*]\s/)) {
          return (
            <div key={i} className="flex gap-2">
              <span className="text-accent-400 shrink-0 mt-0.5">·</span>
              <span>{renderInline(line.replace(/^[-•*]\s/, ''))}</span>
            </div>
          )
        }
        if (line.match(/^\d+\.\s/)) {
          const [num, ...rest] = line.split(/\.\s(.+)/)
          return (
            <div key={i} className="flex gap-2">
              <span className="text-accent-400 shrink-0 font-semibold text-xs mt-0.5">{num}.</span>
              <span>{renderInline(rest.join('. '))}</span>
            </div>
          )
        }
        if (line.startsWith('## ') || line.startsWith('# ')) {
          return <p key={i} className="font-semibold text-pool-200 mt-1">{line.replace(/^#+ /, '')}</p>
        }
        return <p key={i}>{renderInline(line)}</p>
      })}
    </div>
  )
}

function renderInline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="font-semibold text-pool-100">{part.slice(2, -2)}</strong>
    }
    return part
  })
}

function ThinkingDots() {
  return (
    <div className="flex gap-1 items-center h-5">
      {[0, 1, 2].map(i => (
        <div key={i} className="w-1.5 h-1.5 rounded-full bg-pool-400 animate-bounce"
          style={{ animationDelay: `${i * 0.15}s`, animationDuration: '0.8s' }} />
      ))}
    </div>
  )
}
