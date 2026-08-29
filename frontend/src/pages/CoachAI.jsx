import { useEffect, useRef, useState, useCallback } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { api } from '../api'
import SessionCancellationDialog from '../components/SessionCancellationDialog'
import RegisterSavedOverlay from '../components/RegisterSavedOverlay'
import { useSessionPresentation } from '../components/SessionPresentationProvider'

function useWhisperVoice(onResult) {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder)

  const start = useCallback(async () => {
    if (recording || transcribing) return
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      const recorder = new MediaRecorder(stream, { mimeType })
      chunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(chunksRef.current, { type: mimeType })
        setTranscribing(true)
        try {
          const result = await api.transcribeAudio(blob)
          if (result?.text) onResult(result.text)
        } catch (e) {
          setError(`Transcription failed: ${e.message}`)
        }
        setTranscribing(false)
      }
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
    } catch (e) {
      setError(e.name === 'NotAllowedError'
        ? 'Microphone blocked — tap the lock icon in your address bar to allow it.'
        : `Microphone unavailable: ${e.message}`)
    }
  }, [recording, transcribing, onResult])

  const stop = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    setRecording(false)
  }, [])

  return { recording, transcribing, supported, start, stop, error, clearError: () => setError(null) }
}

const STARTERS = [
  "Which of my swimmers would benefit most from more aerobic base work right now?",
  "How do I know if a swimmer is adapting to the training load or just accumulating fatigue?",
  "How should I approach tapering for a swimmer with a history of peaking early?",
  "I read that polarised training outperforms threshold-heavy approaches — does that apply here?",
  "What energy systems are we targeting in a typical threshold session?",
]

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

function getDefaultDates() {
  const today = new Date()
  const from = today.toISOString().slice(0, 10)
  const to = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return { from, to }
}

export default function CoachAI() {
  const navigate = useNavigate()
  const location = useLocation()
  const [threads, setThreads] = useState([])
  const [activeThreadId, setActiveThreadId] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [context, setContext] = useState(null)
  const [lastInjected, setLastInjected] = useState([])
  const [lastTopics, setLastTopics] = useState([])

  // Intent / suggested action
  const [suggestedAction, setSuggestedAction] = useState(null)
  const [actioning, setActioning] = useState(false)
  const [actionResult, setActionResult] = useState(null)

  // Session draft card
  const [sessionDraft, setSessionDraft] = useState(null) // extracted session JSON
  const [savingSession, setSavingSession] = useState(false)

  // Register card
  const [registerData, setRegisterData] = useState(null) // { session_id, session_title, attendees, attendance }
  const [registerInput, setRegisterInput] = useState('')
  const [parsingRegister, setParsingRegister] = useState(false)
  const [savingRegister, setSavingRegister] = useState(false)
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
  const [speakingId, setSpeakingId] = useState(null)
  const [poolside, setPoolside] = useState(false)
  const [feedbackPrompt, setFeedbackPrompt] = useState(null) // post-register feedback
  const fileInputRef = useRef(null)

  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  const { recording, transcribing, supported: voiceSupported, start: startVoice, stop: stopVoice, error: voiceError, clearError: clearVoiceError } = useWhisperVoice(
    useCallback((transcript) => {
      setInput(prev => prev ? `${prev} ${transcript}` : transcript)
    }, [])
  )

  useEffect(() => {
    if (!registerSaved) return undefined
    const returnHome = window.setTimeout(() => {
      navigate('/', { replace: true })
    }, 1400)
    return () => window.clearTimeout(returnHome)
  }, [navigate, registerSaved])

  const switchToThread = (threadId) => {
    setActiveThreadId(threadId)
    setMessages([])
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
    api.getAIChatMessages(threadId).then(setMessages).catch(() => {})
  }

  useEffect(() => {
    const initialMessage = location.state?.initialMessage
    const targetThreadId = location.state?.threadId
    Promise.all([
      api.getAIChatThreads().catch(() => []),
      api.getAIContextStatus().catch(() => null),
    ]).then(async ([threadList, ctx]) => {
      setThreads(threadList)
      setContext(ctx)
      if (initialMessage) {
        // Open a fresh thread pre-seeded with the message
        try {
          const thread = await api.createAIChatThread()
          setThreads(prev => [thread, ...prev])
          switchToThread(thread.id)
          setInput(initialMessage)
          setTimeout(() => textareaRef.current?.focus(), 100)
        } catch {
          if (threadList.length > 0) {
            switchToThread(threadList[0].id)
          }
          setInput(initialMessage)
        }
      } else if (targetThreadId) {
        const found = threadList.find(t => t.id === targetThreadId)
        if (found) {
          setActiveThreadId(targetThreadId)
          api.getAIChatMessages(targetThreadId).then(msgs => {
            setMessages(msgs)
            requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'auto' }))
          }).catch(() => {})
        }
      }
      // Default: start empty — no thread loaded on open
      setLoading(false)
    })
  }, [])

  const createThread = async () => {
    const thread = await api.createAIChatThread()
    setThreads(prev => [...prev, thread])
    switchToThread(thread.id)
  }

  const deleteThread = async (threadId) => {
    if (threads.length === 1) {
      alert("You need at least one conversation.")
      return
    }
    await api.deleteAIChatThread(threadId)
    const remaining = threads.filter(t => t.id !== threadId)
    setThreads(remaining)
    if (activeThreadId === threadId) {
      switchToThread(remaining[0].id)
    }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [messages, suggestedAction])

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
          setMessages(stored)
          return true
        }
      } catch {}
    }
    return false
  }

  const send = async (text) => {
    const msg = (text || input).trim()
    const hasImage = Boolean(attachedImage)
    if ((!msg && !hasImage) || sending) return

    // Ensure active thread — create one if starting fresh
    let threadId = activeThreadId
    if (!threadId) {
      try {
        const newThread = await api.createAIChatThread()
        setThreads(prev => [newThread, ...prev])
        setActiveThreadId(newThread.id)
        threadId = newThread.id
      } catch (e) {
        setMessages(prev => [...prev, { role: 'assistant', message: `Error: ${e.message}`, id: Date.now() }])
        return
      }
    }

    setInput('')
    setAttachedImage(null)
    setSending(true)
    setSuggestedAction(null)
    setActionResult(null)
    setTargetDraft(null)
    setSavedTarget(null)
    setPinSaved(false)

    const displayMsg = hasImage ? `[Photo attached] ${msg || ''}`.trim() : msg
    setMessages(prev => [...prev, {
      role: 'user', message: displayMsg, id: Date.now(),
      imagePreview: attachedImage?.preview,
    }])

    const requestStartedAt = Date.now()
    try {
      const res = hasImage
        ? await api.sendAIChatMessageWithImage(msg, attachedImage.file, threadId, poolside)
        : await api.sendAIChatMessage(msg, threadId, poolside)
      setLastInjected(res.context_injected || [])
      setLastTopics(res.topics_detected || [])
      setMessages(prev => [...prev, { role: 'assistant', message: res.reply, id: Date.now() + 1 }])

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
          ...messages.map(message => `${message.role === 'user' ? 'Coach' : 'AI'}: ${message.message}`),
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
    } catch (e) {
      const recovered = await recoverSavedReply(threadId, msg, requestStartedAt, hasImage)
      if (!recovered) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          message: 'The connection ended before the reply reached this screen. The conversation is saved; tap the conversation again in a moment to recover any completed reply.',
          id: Date.now() + 1,
        }])
      }
    }
    setSending(false)
  }

  const handleImagePick = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const preview = URL.createObjectURL(file)
    setAttachedImage({ file, preview })
    e.target.value = ''
  }

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
      } else if (type === 'open_season_plan_thread') {
        try {
          const spThread = await api.getOrCreateSeasonPlanThread()
          if (!threads.find(t => t.id === spThread.id)) {
            setThreads(prev => [spThread, ...prev])
          }
          switchToThread(spThread.id)
        } catch (e) {
          setActionResult('error')
        }
        setSuggestedAction(null)
        return
      } else if (type === 'open_athlete_plan_thread') {
        try {
          const apThread = await api.getOrCreateAthletePlanThread()
          if (!threads.find(t => t.id === apThread.id)) {
            setThreads(prev => [apThread, ...prev])
          }
          switchToThread(apThread.id)
        } catch (e) {
          setActionResult('error')
        }
        setSuggestedAction(null)
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
        setSuggestedAction(null)
      } else if (type === 'benchmark_capture' && swimmer_id) {
        const result = await api.saveBenchmarkFromChat(swimmer_id, conversationContext)
        if (result.saved?.length > 0) {
          setSavedBenchmarksToast(result.saved)
          setTimeout(() => setSavedBenchmarksToast(null), 5000)
        }
        setActionResult('saved')
        setSuggestedAction(null)
      } else if (type === 'coaching_intent' && swimmer_id) {
        const result = await api.saveCoachingIntentFromChat(swimmer_id, conversationContext)
        if (result.saved?.length > 0) {
          setSavedIntentsToast(result.saved)
          setTimeout(() => setSavedIntentsToast(null), 7000)
        }
        setActionResult('saved')
        setSuggestedAction(null)
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

  const speakMessage = (id, text) => {
    window.speechSynthesis.cancel()
    if (speakingId === id) { setSpeakingId(null); return }
    const plainText = text.replace(/[*_`#>]/g, '').replace(/\n+/g, ' ').trim()
    const utt = new SpeechSynthesisUtterance(plainText)
    utt.lang = 'en-GB'
    utt.rate = 1.05
    utt.onend = () => setSpeakingId(null)
    utt.onerror = () => setSpeakingId(null)
    setSpeakingId(id)
    window.speechSynthesis.speak(utt)
  }

  const clear = async () => {
    if (!window.confirm('Clear this conversation? This cannot be undone.')) return
    window.speechSynthesis.cancel()
    setSpeakingId(null)
    await api.clearAIChat(activeThreadId)
    setMessages([])
    setSuggestedAction(null)
    setActionResult(null)
    setCancellationData(null)
    setTargetDraft(null)
    setPinSaved(false)
  }

  const openPinModal = async () => {
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

  const actionColour = suggestedAction ? (INTENT_LABELS[suggestedAction.type]?.colour || 'accent') : 'accent'
  const colourMap = {
    blue: 'border-blue-700/50 bg-blue-900/20 text-blue-300',
    orange: 'border-orange-700/50 bg-orange-900/20 text-orange-300',
    'orange-dark': 'border-orange-700/50 bg-orange-900/20 text-orange-300',
    green: 'border-green-700/50 bg-green-900/20 text-green-300',
    purple: 'border-purple-700/50 bg-purple-900/20 text-purple-300',
    amber: 'border-amber-700/50 bg-amber-900/20 text-amber-300',
    teal: 'border-teal-700/50 bg-teal-900/20 text-teal-300',
    accent: 'border-accent-700/50 bg-accent-900/20 text-accent-300',
  }
  const actionCardClass = colourMap[actionColour]

  return (
    <div className="flex flex-col h-full">
      {registerSaved && <RegisterSavedOverlay />}

      {/* Header */}
      <div className="px-4 pt-4 pb-2 shrink-0 border-b border-pool-600">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-5 bg-accent-500 rounded-full" />
            <h1 className="text-lg font-bold tracking-tight">LaneWatch AI</h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setPoolside(p => !p)}
              className={`text-xs font-semibold px-2.5 py-1 rounded-lg transition-colors ${
                poolside
                  ? 'bg-amber-600 text-white'
                  : 'bg-pool-700 text-pool-400 hover:text-pool-200'
              }`}
              title="Poolside mode — brief responses only"
            >
              {poolside ? 'Poolside' : 'Poolside'}
            </button>
            {messages.length >= 2 && !sending && (
              <button
                onClick={openPinModal}
                disabled={pinning}
                className="text-xs text-accent-400 font-medium hover:text-accent-300 disabled:opacity-50"
              >
                {pinning ? 'Summarising…' : 'Pin to sessions'}
              </button>
            )}
            {messages.length > 0 && (
              <button onClick={clear} className="text-xs text-pool-500 hover:text-pool-400">Clear</button>
            )}
            <Link to="/context" className="text-xs text-accent-400 font-medium">Context →</Link>
          </div>
        </div>

        <div className="mt-2 pl-3.5 flex items-center gap-3 flex-wrap">
          {context?.active ? (
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <span className="text-xs text-pool-400">
                Context: <span className="text-pool-200">{context.title}</span>
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-pool-600" />
              <span className="text-xs text-pool-500">
                No coaching context —{' '}
                <Link to="/context" className="text-accent-400 underline">build one</Link>
              </span>
            </div>
          )}
          {poolside && (
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              <span className="text-xs text-amber-400 font-medium">Brief responses</span>
            </div>
          )}
          {lastTopics.length > 0 && (
            <div className="flex items-center gap-1">
              {lastTopics.map(t => (
                <span key={t} className="text-xs bg-pool-700 text-pool-400 rounded px-1.5 py-0.5">{t}</span>
              ))}
            </div>
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
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">

        {!loading && messages.length === 0 && (
          <div className="space-y-4 pt-2">
            {threads.some(t => t.thread_type === 'general' || !t.thread_type) && (
              <button
                onClick={() => {
                  const last = threads.find(t => t.thread_type === 'general' || !t.thread_type)
                  if (last) switchToThread(last.id)
                }}
                className="w-full text-left bg-pool-800 hover:bg-pool-700 border border-pool-600 rounded-xl px-4 py-3 transition-colors flex items-center justify-between group"
              >
                <div>
                  <p className="text-sm font-medium text-pool-200">Resume last conversation</p>
                  <p className="text-xs text-pool-400 mt-0.5">Continue where you left off</p>
                </div>
                <svg className="w-4 h-4 text-pool-500 group-hover:text-pool-300" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                </svg>
              </button>
            )}
            <p className="text-pool-400 text-sm leading-relaxed">
              Ask LaneWatch AI anything — swimmer profiles, session planning, competition prep, training science.
              I know your squad and I'll pull in the right context as the conversation develops.
            </p>
            <div className="space-y-2">
              <p className="text-xs text-pool-500 uppercase tracking-wide font-semibold">Try asking:</p>
              {STARTERS.map((s, i) => (
                <button
                  key={i}
                  onClick={() => send(s)}
                  className="w-full text-left text-xs bg-pool-700 hover:bg-pool-600 border border-pool-600 hover:border-accent-600/50 rounded-xl px-3 py-2.5 text-pool-300 transition-all leading-relaxed"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} group`}>
            <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed space-y-2 ${
              m.role === 'user'
                ? 'bg-accent-700 text-white rounded-br-sm'
                : 'bg-pool-700 text-pool-200 rounded-bl-sm'
            }`}>
              {m.imagePreview && (
                <img src={m.imagePreview} alt="session" className="rounded-xl max-h-40 object-cover w-full" />
              )}
              <MessageContent text={m.role === 'user' && m.message.startsWith('[Photo attached] ')
                ? m.message.replace('[Photo attached] ', '').trim() || 'Photo attached'
                : m.message} />
              {m.role === 'assistant' && (
                <button
                  onClick={() => speakMessage(m.id, m.message)}
                  className={`mt-1 flex items-center gap-1 text-xs transition-colors ${
                    speakingId === m.id ? 'text-accent-400' : 'text-pool-600 hover:text-pool-400'
                  }`}
                  aria-label={speakingId === m.id ? 'Stop speaking' : 'Listen'}
                >
                  {speakingId === m.id ? (
                    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                      <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
                    </svg>
                  )}
                </button>
              )}
            </div>
          </div>
        ))}

        {sending && (
          <div className="flex justify-start">
            <div className="bg-pool-700 rounded-2xl rounded-bl-sm px-4 py-3">
              <ThinkingDots />
            </div>
          </div>
        )}

        {/* Suggested action card */}
        {suggestedAction && !sending && (
          <div className={`border rounded-xl px-4 py-3 space-y-2.5 ${actionCardClass}`}>
            {actionResult === null && (
              <>
                <p className="text-xs font-semibold">{suggestedAction.label}</p>
                <p className="text-xs opacity-75">
                  {suggestedAction.type === 'session_writing'
                    ? "I'll extract the session structure from our conversation, create it in history, and take you straight to the register."
                    : suggestedAction.type === 'meet_creation'
                    ? "I'll extract the meet details and swimmer entries from our conversation and create it — you can review and add targets on the meet page."
                    : suggestedAction.type === 'athlete_profile_update'
                    ? `Update ${suggestedAction.swimmer_name}'s stored physical and psychological coaching profile using the new details in this conversation.`
                    : suggestedAction.swimmer_name
                    ? `Save this conversation to ${suggestedAction.swimmer_name}'s profile — builds biological, technical, and performance summaries from what was discussed.`
                    : "Ready to save this — it'll be used in future planning context."}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleSuggestedAction}
                    disabled={actioning}
                    className="flex-1 bg-white/10 hover:bg-white/20 disabled:opacity-50 rounded-lg py-2 text-xs font-semibold transition-colors"
                  >
                    {actioning ? 'Saving…' : 'Yes, save it'}
                  </button>
                  <button
                    onClick={dismissAction}
                    className="px-3 py-2 text-xs opacity-60 hover:opacity-100"
                  >
                    Not yet
                  </button>
                </div>
              </>
            )}
            {actionResult === 'saved' && (
              <p className="text-xs font-semibold">Saved. The AI will use this in future context for this swimmer.</p>
            )}
            {actionResult === 'season' && (
              <p className="text-xs">Season plan changes aren't auto-saved yet — take the key points to the Periodization section to update the plan.</p>
            )}
            {actionResult === 'error' && (
              <p className="text-xs opacity-75">Couldn't save automatically — try from the swimmer's profile page.</p>
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

      {/* Context injection indicator */}
      {lastInjected.length > 0 && !sending && (
        <div className="px-4 py-1.5 shrink-0 flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-accent-500 shrink-0" />
          <p className="text-xs text-pool-500">
            Full profile loaded: <span className="text-pool-400">{lastInjected.join(', ')}</span>
          </p>
        </div>
      )}

      {/* Thread tabs */}
      <div className="px-4 pt-2 shrink-0 flex items-center gap-1.5 overflow-x-auto scrollbar-none">
        {threads.map((t, i) => {
          const isSeasonPlan = t.thread_type === 'season_plan'
          const isAthletePlan = t.thread_type === 'athlete_planning'
          return (
            <div key={t.id} className="flex items-center shrink-0">
              <button
                onClick={() => switchToThread(t.id)}
                className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${
                  activeThreadId === t.id
                    ? isSeasonPlan ? 'bg-teal-600 text-white' : isAthletePlan ? 'bg-orange-600 text-white' : 'bg-accent-600 text-white'
                    : isSeasonPlan ? 'bg-teal-900/50 text-teal-300 hover:text-teal-100 border border-teal-700/40' : isAthletePlan ? 'bg-orange-900/50 text-orange-300 hover:text-orange-100 border border-orange-700/40' : 'bg-pool-700 text-pool-400 hover:text-pool-200'
                }`}
                title={isSeasonPlan ? 'Season planning thread' : isAthletePlan ? 'Athlete planning thread' : undefined}
              >
                {isSeasonPlan && <span className="text-[10px] opacity-75">📋</span>}
                {isAthletePlan && <span className="text-[10px] opacity-75">🏊</span>}
                {t.name || `Chat ${i + 1}`}
              </button>
              {threads.length > 1 && (
                <button
                  onClick={() => deleteThread(t.id)}
                  className="ml-0.5 text-pool-600 hover:text-red-400 text-xs w-4 h-4 flex items-center justify-center transition-colors"
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
        <button
          onClick={async () => {
            try {
              const spThread = await api.getOrCreateSeasonPlanThread()
              if (!threads.find(t => t.id === spThread.id)) {
                setThreads(prev => [spThread, ...prev])
              }
              switchToThread(spThread.id)
            } catch {}
          }}
          className="shrink-0 text-xs text-teal-400 hover:text-teal-200 bg-teal-900/40 hover:bg-teal-800/60 border border-teal-700/40 px-2 py-1.5 rounded-lg transition-colors"
          title="Open season planning chat"
        >
          📋 Season
        </button>
        <button
          onClick={async () => {
            try {
              const apThread = await api.getOrCreateAthletePlanThread()
              if (!threads.find(t => t.id === apThread.id)) {
                setThreads(prev => [apThread, ...prev])
              }
              switchToThread(apThread.id)
            } catch {}
          }}
          className="shrink-0 text-xs text-orange-400 hover:text-orange-200 bg-orange-900/40 hover:bg-orange-800/60 border border-orange-700/40 px-2 py-1.5 rounded-lg transition-colors"
          title="Open athlete planning chat"
        >
          🏊 Athletes
        </button>
        <button
          onClick={() => {
            setActiveThreadId(null)
            setMessages([])
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
            setLastTopics([])
          }}
          className="shrink-0 text-xs text-pool-500 hover:text-accent-400 bg-pool-700 hover:bg-pool-600 w-7 h-7 rounded-lg flex items-center justify-center transition-colors font-bold"
          title="New conversation"
        >
          +
        </button>
      </div>

      {/* Input */}
      <div className="px-3 pb-4 pt-2 shrink-0 border-t border-pool-700">
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImagePick} />
        {voiceError && (
          <div className="mb-2 bg-red-900 border border-red-700 text-red-200 text-xs rounded-xl px-3 py-2 flex items-center justify-between gap-2">
            <span>{voiceError}</span>
            <button onClick={clearVoiceError} className="text-red-400 hover:text-red-200 text-base leading-none shrink-0">×</button>
          </div>
        )}
        {attachedImage && (
          <div className="mb-2 relative inline-block">
            <img src={attachedImage.preview} alt="attached" className="h-16 rounded-lg object-cover border border-pool-600" />
            <button onClick={() => setAttachedImage(null)} className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-pool-600 rounded-full text-xs text-pool-200 flex items-center justify-center">×</button>
          </div>
        )}
        {/* Single container — ChatGPT style */}
        <div className={`flex flex-col bg-pool-700 border rounded-2xl transition-colors ${recording ? 'border-red-500' : transcribing ? 'border-yellow-500' : 'border-pool-600 focus-within:border-accent-500'}`}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() } }}
            placeholder={recording ? 'Recording…' : transcribing ? 'Transcribing…' : 'Ask LaneWatch AI…'}
            rows={3}
            className="bg-transparent px-4 pt-3 pb-1 text-sm focus:outline-none resize-none w-full"
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
              {/* Camera */}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-2 text-pool-500 hover:text-pool-300 transition-colors rounded-lg"
                aria-label="Attach photo"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
                </svg>
              </button>
              {/* Mic */}
              {voiceSupported && (
                <button
                  onMouseDown={startVoice}
                  onMouseUp={stopVoice}
                  onMouseLeave={stopVoice}
                  onTouchStart={(e) => { e.preventDefault(); startVoice() }}
                  onTouchEnd={(e) => { e.preventDefault(); stopVoice() }}
                  disabled={transcribing}
                  className={`p-2 rounded-lg transition-all select-none ${
                    recording ? 'text-red-400 animate-pulse' :
                    transcribing ? 'text-yellow-400 animate-pulse' :
                    'text-pool-500 hover:text-pool-300'
                  }`}
                  aria-label={recording ? 'Release to send' : transcribing ? 'Transcribing…' : 'Hold to speak'}
                >
                  {transcribing ? (
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
                    </svg>
                  )}
                </button>
              )}
            </div>
            {/* Send */}
            <button
              onClick={() => send()}
              disabled={sending || (!input.trim() && !attachedImage)}
              className="bg-accent-600 hover:bg-accent-500 active:bg-accent-700 disabled:opacity-30 rounded-xl w-9 h-9 flex items-center justify-center transition-colors shrink-0"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Pin modal */}
      {pinModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-end justify-center p-4">
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
                              <span key={n} className="text-xs bg-teal-900/40 text-teal-300 border border-teal-800/50 rounded-full px-1.5 py-0">{n}</span>
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
                    <span key={n} className="text-xs bg-teal-900/40 text-teal-300 border border-teal-800/50 rounded-full px-2 py-0.5">{n}</span>
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
