import { useEffect, useRef, useState, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'

function useSpeechRecognition(onResult) {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState(null)
  const recRef = useRef(null)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  const supported = Boolean(SR)

  const start = useCallback(async () => {
    if (!supported || listening) return
    setError(null)
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach(t => t.stop())
      } catch (e) {
        setError(e.name === 'NotAllowedError'
          ? 'Microphone blocked — tap the lock icon in your address bar to allow it.'
          : `Microphone unavailable: ${e.message}`)
        return
      }
    }
    const rec = new SR()
    rec.continuous = true
    rec.interimResults = false
    rec.lang = 'en-US'
    rec.onresult = (e) => {
      const transcript = Array.from(e.results)
        .filter(r => r.isFinal)
        .map(r => r[0].transcript)
        .join(' ')
        .trim()
      if (transcript) onResult(transcript)
    }
    rec.onend = () => setListening(false)
    rec.onerror = (e) => {
      setListening(false)
      if (e.error !== 'no-speech') setError(`Mic error: ${e.error}`)
    }
    try {
      rec.start()
      recRef.current = rec
      setListening(true)
    } catch (e) {
      setError(`Could not start: ${e.message}`)
    }
  }, [listening, supported, onResult])

  const stop = useCallback(() => {
    recRef.current?.stop()
    setListening(false)
  }, [])

  const toggle = start

  return { listening, supported, toggle, stop, error, clearError: () => setError(null) }
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
}

function getDefaultDates() {
  const today = new Date()
  const from = today.toISOString().slice(0, 10)
  const to = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return { from, to }
}

export default function CoachAI() {
  const navigate = useNavigate()
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

  // Pin modal
  const [pinning, setPinning] = useState(false)
  const [pinModal, setPinModal] = useState(null)
  const [pinDates, setPinDates] = useState(getDefaultDates())
  const [saving, setSaving] = useState(false)
  const [pinSaved, setPinSaved] = useState(false)

  const [attachedImage, setAttachedImage] = useState(null) // { file, preview }
  const fileInputRef = useRef(null)

  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  const { listening, supported: voiceSupported, toggle: toggleVoice, stop: stopVoice, error: voiceError, clearError: clearVoiceError } = useSpeechRecognition(
    useCallback((transcript) => {
      setInput(prev => prev ? `${prev} ${transcript}` : transcript)
    }, [])
  )

  const switchToThread = (threadId) => {
    setActiveThreadId(threadId)
    setMessages([])
    setSuggestedAction(null)
    setActionResult(null)
    setSessionDraft(null)
    setRegisterData(null)
    setRegisterSaved(false)
    setPinSaved(false)
    api.getAIChatMessages(threadId).then(setMessages).catch(() => {})
  }

  useEffect(() => {
    Promise.all([
      api.getAIChatThreads().catch(() => []),
      api.getAIContextStatus().catch(() => null),
    ]).then(([threadList, ctx]) => {
      setThreads(threadList)
      setContext(ctx)
      if (threadList.length > 0) {
        const firstId = threadList[0].id
        setActiveThreadId(firstId)
        api.getAIChatMessages(firstId).then(setMessages).catch(() => {})
      }
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
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, suggestedAction])

  const send = async (text) => {
    const msg = (text || input).trim()
    const hasImage = Boolean(attachedImage)
    if ((!msg && !hasImage) || sending) return
    setInput('')
    setAttachedImage(null)
    setSending(true)
    setSuggestedAction(null)
    setActionResult(null)
    setPinSaved(false)

    const displayMsg = hasImage ? `[Photo attached] ${msg || ''}`.trim() : msg
    setMessages(prev => [...prev, {
      role: 'user', message: displayMsg, id: Date.now(),
      imagePreview: attachedImage?.preview,
    }])

    try {
      const res = hasImage
        ? await api.sendAIChatMessageWithImage(msg, attachedImage.file, activeThreadId)
        : await api.sendAIChatMessage(msg, activeThreadId)
      setLastInjected(res.context_injected || [])
      setLastTopics(res.topics_detected || [])
      setMessages(prev => [...prev, { role: 'assistant', message: res.reply, id: Date.now() + 1 }])

      // Auto-trigger register card if register topic detected
      if ((res.topics_detected || []).includes('register')) {
        const regData = await api.startRegister(msg, activeThreadId)
        if (regData.session_id) {
          setRegisterData({ ...regData, attendance: null })
        }
      } else if (res.suggested_action) {
        setSuggestedAction({
          label: res.suggested_action,
          type: res.intent?.type,
          swimmer_id: res.intent?.swimmer_id,
          swimmer_name: res.intent?.swimmer_name,
        })
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', message: `Error: ${e.message}`, id: Date.now() + 1 }])
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

    try {
      if (type === 'session_writing') {
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
      setActionResult('error')
    }
    setActioning(false)
  }

  const dismissAction = () => {
    setSuggestedAction(null)
    setActionResult(null)
  }

  const clear = async () => {
    if (!window.confirm('Clear this conversation? This cannot be undone.')) return
    await api.clearAIChat(activeThreadId)
    setMessages([])
    setSuggestedAction(null)
    setActionResult(null)
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
    green: 'border-green-700/50 bg-green-900/20 text-green-300',
    purple: 'border-purple-700/50 bg-purple-900/20 text-purple-300',
    amber: 'border-amber-700/50 bg-amber-900/20 text-amber-300',
    teal: 'border-teal-700/50 bg-teal-900/20 text-teal-300',
    accent: 'border-accent-700/50 bg-accent-900/20 text-accent-300',
  }
  const actionCardClass = colourMap[actionColour]

  return (
    <div className="flex flex-col h-full">

      {/* Header */}
      <div className="px-4 pt-4 pb-2 shrink-0 border-b border-pool-600">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-5 bg-accent-500 rounded-full" />
            <h1 className="text-lg font-bold tracking-tight">Coach's AI</h1>
          </div>
          <div className="flex items-center gap-3">
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
          {lastTopics.length > 0 && (
            <div className="flex items-center gap-1">
              {lastTopics.map(t => (
                <span key={t} className="text-xs bg-pool-700 text-pool-400 rounded px-1.5 py-0.5">{t}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">

        {!loading && messages.length === 0 && (
          <div className="space-y-4 pt-2">
            <p className="text-pool-400 text-sm leading-relaxed">
              Talk to me like an assistant coach — swimmer profiles, session planning, competition prep, training science.
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
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
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

        {registerData && !registerSaved && (
          <RegisterCard
            data={registerData}
            onDismiss={() => setRegisterData(null)}
            onSaved={(sessionId) => {
              setRegisterSaved(true)
              setRegisterData(null)
              navigate(`/sessions/${sessionId}/register`)
            }}
          />
        )}

        {registerSaved && !registerData && (
          <div className="border border-green-700/50 bg-green-900/20 rounded-xl px-4 py-3">
            <p className="text-xs text-green-300 font-semibold">Register saved.</p>
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
        {threads.map((t, i) => (
          <div key={t.id} className="flex items-center shrink-0">
            <button
              onClick={() => switchToThread(t.id)}
              className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
                activeThreadId === t.id
                  ? 'bg-accent-600 text-white'
                  : 'bg-pool-700 text-pool-400 hover:text-pool-200'
              }`}
            >
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
        ))}
        <button
          onClick={createThread}
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
        <div className={`flex flex-col bg-pool-700 border rounded-2xl transition-colors ${listening ? 'border-red-500' : 'border-pool-600 focus-within:border-accent-500'}`}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            placeholder={listening ? 'Listening…' : 'Ask anything…'}
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
                  onMouseDown={toggleVoice}
                  onMouseUp={stopVoice}
                  onMouseLeave={stopVoice}
                  onTouchStart={(e) => { e.preventDefault(); toggleVoice() }}
                  onTouchEnd={(e) => { e.preventDefault(); stopVoice() }}
                  className={`p-2 rounded-lg transition-all select-none ${listening ? 'text-red-400 animate-pulse' : 'text-pool-500 hover:text-pool-300'}`}
                  aria-label={listening ? 'Release to stop' : 'Hold to speak'}
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
                  </svg>
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
  const [data, setData] = useState(() => ({
    ...draft,
    groups: (draft.groups || []).map(g => ({
      ...g,
      sets: Array.isArray(g.sets) ? g.sets.join('\n') : (g.sets || ''),
    })),
  }))

  const setField = (key, val) => setData(p => ({ ...p, [key]: val }))
  const setGroup = (i, key, val) => setData(p => ({
    ...p,
    groups: p.groups.map((g, idx) => idx === i ? { ...g, [key]: val } : g),
  }))

  const buildSubmit = () => ({
    ...data,
    groups: data.groups.map(g => ({
      ...g,
      sets: typeof g.sets === 'string' ? g.sets.split('\n').map(s => s.trim()).filter(Boolean) : g.sets,
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
            {ENERGY_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
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
              <textarea
                value={typeof g.sets === 'string' ? g.sets : (g.sets || []).join('\n')}
                onChange={e => setGroup(i, 'sets', e.target.value)}
                rows={3}
                placeholder="Sets — one per line"
                className="w-full bg-pool-700 border border-pool-600 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-teal-500 resize-none font-mono leading-relaxed"
              />
              {g.swimmer_names?.length > 0 && (
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

function RegisterCard({ data, onDismiss, onSaved }) {
  const initialAttendance = (data.attendees || []).map(a => ({
    swimmer_id: a.id,
    name: a.name,
    present: a.expected !== false,
    group: null,
    note: '',
    exception_reason: a.exception_reason || null,
  }))
  const [attendance, setAttendance] = useState(initialAttendance)
  const [parseInput, setParseInput] = useState('')
  const [parsing, setParsing] = useState(false)
  const [saving, setSaving] = useState(false)

  const setEntry = (i, key, val) => setAttendance(prev => prev.map((e, idx) => idx === i ? { ...e, [key]: val } : e))

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
      await api.submitRegister({ session_id: data.session_id, attendance })
      onSaved(data.session_id)
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
            {e.exception_reason && !e.present && (
              <span className="text-xs text-amber-400">{e.exception_reason}</span>
            )}
            {e.present && (
              <div className="flex gap-1 shrink-0">
                {[1, 2, 3].map(g => (
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
          disabled={saving}
          className="flex-1 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded-xl py-2.5 text-sm font-semibold transition-colors"
        >
          {saving ? 'Saving…' : 'Save register'}
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
