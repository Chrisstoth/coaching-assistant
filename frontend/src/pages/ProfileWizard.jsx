import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { staffLabel, staffStyle } from '../staffRoom'
import StaffAvatar from '../components/StaffAvatar'
import SpeakButton, { useSpeaking } from '../components/SpeakButton'
import useWhisperVoice, { primeMicrophone } from '../hooks/useWhisperVoice'
import useWakeLock from '../hooks/useWakeLock'
import {
  enqueue, hold, isBusy, onFinished, release,
  say, stop as stopSpeaking, unlock as unlockSpeech,
} from '../staffSpeech'

function ThinkingDots() {
  return (
    <div className="flex gap-1 items-center h-5">
      {[0, 1, 2].map(i => (
        <div
          key={i}
          className="w-1.5 h-1.5 bg-pool-400 rounded-full animate-bounce"
          style={{ animationDelay: `${i * 150}ms`, animationDuration: '0.9s' }}
        />
      ))}
    </div>
  )
}

// Matches the sentinel the wizard's system prompt is told to append when the
// interview is complete. Saying "yes" in the chat itself does nothing — only
// tapping Save Profile calls the save endpoint — so this marker is used to put
// a real, tappable button right where the AI just asked to save.
const READY_TO_SAVE_MARKER = '[[READY_TO_SAVE]]'

// The system prompt asks the AI to append READY_TO_SAVE_MARKER, but a model
// doesn't always reproduce an arbitrary formatting token reliably. It is told
// to always name the button "Save Profile" verbatim in the same sentence, so
// that mention is the primary, sturdier signal — the marker is a bonus, not
// the only path.
function messageSignalsReadyToSave(content) {
  return content.includes(READY_TO_SAVE_MARKER) || /save profile/i.test(content)
}

function MessageContent({ text }) {
  const lines = text.split('\n')
  return (
    <div className="space-y-1">
      {lines.map((line, i) => (
        line.trim() === '' ? <br key={i} /> : <p key={i}>{line}</p>
      ))}
    </div>
  )
}

function StaffBadge({ role }) {
  return <StaffAvatar role={role} size={20} />
}

// Who is speaking a message: a specialist, or the interviewer who leads.
function speakerOf(message) {
  return message.speaker || 'interviewer'
}

function spokenText(message) {
  return message.content.split(READY_TO_SAVE_MARKER).join('').trim()
}

// Hands-free: an answer is sent this long after it is written down, unless
// the coach taps to edit it first.
const AUTO_SEND_MS = 2000

// "Save it", "save the profile", "yes, save" - said once the interview is done.
function asksToSave(text) {
  return /^(yes[,.]?\s*)?(please\s+)?save(\s+(it|that|the profile|profile))?(\s+please)?[.!]?$/i.test(text.trim())
}

// Who on the staff is sitting in, and how many of their questions are still to come.
function StaffAtTheTable({ questions }) {
  if (!questions.length) return null
  const byRole = {}
  for (const q of questions) {
    byRole[q.role] = byRole[q.role] || { waiting: 0, answered: 0 }
    if (q.status === 'answered') byRole[q.role].answered += 1
    else byRole[q.role].waiting += 1
  }
  return (
    <div className="bg-pool-900/60 border border-pool-700 rounded-xl px-3 py-2">
      <p className="text-[10px] text-pool-500">The staff's questions for this interview</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-1.5">
        {Object.entries(byRole).map(([role, count]) => (
          <span key={role} className="flex items-center gap-1.5 text-[11px] text-pool-300">
            <StaffBadge role={role} />
            {staffLabel(role)}
            <span className="text-pool-500">
              {count.waiting ? `${count.waiting} to ask` : 'all answered'}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

// The staff's messages arrive with the interviewer's reply, after the coach's
// answer. A stored draft that is longer than what was sent, and starts with it,
// holds a reply that finished while the browser was away.
function completedOnServer(stored, submitted) {
  return (
    stored.length > submitted.length
    && submitted.every((message, index) => (
      message.role === stored[index]?.role && message.content === stored[index]?.content
    ))
    && stored.slice(submitted.length).every(message => message.role === 'assistant')
  )
}

const FOUNDATION_FIELDS = {
  physical: [
    ['aerobic_base', 'Aerobic base'],
    ['sprint_tendency', 'Sprint and power'],
    ['race_pattern', 'Race patterns'],
    ['fatigue_profile', 'Fatigue and recovery'],
    ['training_response', 'Training response'],
  ],
  psychological: [
    ['motivation_style', 'Motivation'],
    ['competition_response', 'Competition mindset'],
    ['response_to_hard_training', 'Response to hard training'],
    ['coachability', 'Coachability and feedback'],
  ],
}

function FoundationDraftReview({ draft, saving, onSave, onCancel }) {
  const [form, setForm] = useState(() => ({
    physical: Object.fromEntries(
      FOUNDATION_FIELDS.physical.map(([key]) => [key, draft.physical?.[key]?.value || '']),
    ),
    psychological: Object.fromEntries(
      FOUNDATION_FIELDS.psychological.map(([key]) => [key, draft.psychological?.[key]?.value || '']),
    ),
  }))

  const update = (section, field, value) => {
    setForm(previous => ({
      ...previous,
      [section]: { ...previous[section], [field]: value },
    }))
  }
  const allFields = [...FOUNDATION_FIELDS.physical, ...FOUNDATION_FIELDS.psychological]
  const filled = allFields.filter(([key]) => (
    (form.physical[key] || form.psychological[key] || '').trim()
  )).length
  const sourceCounts = draft.source_counts || {}

  const confidenceStyle = {
    confirmed: 'bg-green-900/30 text-green-300 border-green-800/50',
    supported: 'bg-blue-900/30 text-blue-300 border-blue-800/50',
    missing: 'bg-amber-900/30 text-amber-300 border-amber-800/50',
  }
  const confidenceLabel = {
    confirmed: 'Already confirmed',
    supported: 'Existing evidence',
    missing: 'Needs your input',
  }

  return (
    <div className="space-y-4">
      <div className="bg-pool-800 border border-pool-700 rounded-2xl p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-pool-100">Review the carry-over draft</p>
            <p className="text-xs text-pool-400 mt-1 leading-relaxed">
              Stored profile text has been copied into directly matching fields. Edit anything that is inaccurate; blank fields can be completed through the interview later.
            </p>
            {draft.uses_ai === false && (
              <span className="inline-block mt-2 bg-green-900/30 border border-green-800/50 text-green-300 rounded-full px-2 py-1 text-[10px] font-semibold">
                No AI call · no tokens used
              </span>
            )}
          </div>
          <button type="button" onClick={onCancel} disabled={saving} className="text-pool-500 text-lg">×</button>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-3 text-[10px] text-pool-400">
          <span className="bg-pool-900/60 rounded-md px-2 py-1">{sourceCounts.living_profiles || 0} living profiles</span>
          <span className="bg-pool-900/60 rounded-md px-2 py-1">{sourceCounts.observations || 0} observations</span>
          <span className="bg-pool-900/60 rounded-md px-2 py-1">{sourceCounts.coaching_notes || 0} coaching notes</span>
        </div>
      </div>

      {Object.entries(FOUNDATION_FIELDS).map(([section, fields]) => (
        <section key={section} className="space-y-2.5">
          <h2 className="text-xs uppercase tracking-wide text-pool-500 px-1">
            {section === 'physical' ? 'Physical foundation' : 'Psychological foundation'}
          </h2>
          {fields.map(([key, label]) => {
            const evidence = draft[section]?.[key] || { confidence: 'missing', evidence: '' }
            const confidence = evidence.confidence || 'missing'
            return (
              <label key={key} className="block bg-pool-800 border border-pool-700 rounded-xl p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-semibold text-pool-200">{label}</span>
                  <span className={`text-[9px] border rounded-full px-2 py-0.5 ${confidenceStyle[confidence] || confidenceStyle.missing}`}>
                    {confidenceLabel[confidence] || confidenceLabel.missing}
                  </span>
                </div>
                <textarea
                  value={form[section][key]}
                  onChange={event => update(section, key, event.target.value)}
                  rows={form[section][key] ? 3 : 2}
                  placeholder="Add what you know, or leave blank for the interview"
                  className="w-full bg-pool-900/60 border border-pool-600 rounded-lg px-3 py-2 text-xs text-pool-100 placeholder-pool-600 resize-y focus:outline-none focus:border-accent-500"
                />
                <p className="text-[10px] text-pool-500 mt-1.5 leading-relaxed">{evidence.evidence}</p>
              </label>
            )
          })}
        </section>
      ))}

      <div className="sticky bottom-0 bg-pool-950/95 border-t border-pool-700 py-3 space-y-2">
        <p className="text-[10px] text-pool-500 text-center">
          {filled}/9 fields ready · {9 - filled} will remain to cover
        </p>
        <button
          type="button"
          onClick={() => onSave(form)}
          disabled={saving || filled === 0}
          className="w-full bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded-xl py-3 text-sm font-semibold"
        >
          {saving ? 'Saving reviewed foundation…' : 'Confirm and save reviewed fields'}
        </button>
        <p className="text-[10px] text-pool-600 text-center">This is a preview — nothing changes until you confirm.</p>
      </div>
    </div>
  )
}

export default function ProfileWizard() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [swimmer, setSwimmer] = useState(null)
  const [messages, setMessages] = useState([]) // [{role:'user'|'assistant', content, speaker?, asks_for?}]
  const [staffQuestions, setStaffQuestions] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)  // initial AI opener
  const [sending, setSending] = useState(false)
  const [pendingReply, setPendingReply] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState('loading') // loading | choice | chat | draft
  const [draft, setDraft] = useState(null)
  const [drafting, setDrafting] = useState(false)
  const [draftSaving, setDraftSaving] = useState(false)

  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  // Voice: each new message is read aloud in its speaker's voice, and the
  // coach can answer by talking. Off until the coach turns it on, because a
  // phone only plays sound a tap has started.
  const [voiceOn, setVoiceOn] = useState(false)
  const spokenUpTo = useRef(null)
  const playing = useSpeaking()

  // Hands-free: once the staff finish speaking the mic opens by itself, a
  // pause ends the answer, and it is sent after a short countdown.
  const [handsFree, setHandsFree] = useState(false)
  const handsFreeRef = useRef(false)
  handsFreeRef.current = handsFree
  const [autoSendAt, setAutoSendAt] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [handsFreeNote, setHandsFreeNote] = useState(null)

  // The screen stays on for the whole conversation, typed or spoken.
  useWakeLock(mode === 'chat' && !saved)

  // "Done, send it": the coach has finished, so what they said goes as soon as
  // it is written down - no waiting for a pause, no countdown.
  const sendNowRef = useRef(false)

  const {
    recording, transcribing, supported: micSupported,
    start: startMic, stop: stopMic, cancel: cancelMic, error: micError, clearError: clearMicError,
  } = useWhisperVoice(useCallback((text, { unsure = false } = {}) => {
    setInput(previous => (previous ? `${previous} ${text}` : text))
    if (sendNowRef.current) {
      sendNowRef.current = false
      setAutoSendAt(Date.now())
    } else if (unsure) {
      // Listening gave up thinking nobody spoke, but something was recorded:
      // the coach checks it rather than it going without them.
      setHandsFreeNote("I wasn't sure I heard you, so I haven't sent this. Check it and tap send.")
    } else if (handsFreeRef.current) {
      setAutoSendAt(Date.now() + AUTO_SEND_MS)
    }
  }, []), {
    onNoSpeech: () => setHandsFreeNote("I didn't hear anything, so I've stopped listening. Tap the mic when you're ready."),
    onCannotTell: () => setHandsFreeNote("This phone isn't letting me hear when you pause. Talk as normal, then tap “Done, send it”."),
  })

  const recoverAfterRequestError = useCallback(async (submittedMessages, requestError) => {
    try {
      const interviewDraft = await api.getProfileWizardDraft(id)
      const stored = interviewDraft.messages || []
      if (completedOnServer(stored, submittedMessages)) {
        setMessages(stored)
        setStaffQuestions(interviewDraft.staff_questions || [])
        setPendingReply(false)
        return
      }
      if (interviewDraft.awaiting_reply) {
        setPendingReply(true)
        return
      }
    } catch {
      // Fall through to the request error while retaining the on-screen answer.
    }
    setError(requestError?.name === 'TimeoutError'
      ? 'The reply is taking longer than expected. Your answer is still here; try the reply again.'
      : requestError.message)
  }, [id])

  // The server returns the whole transcript, including anything the staff said.
  const applyReply = useCallback((data) => {
    if (data.messages) setMessages(data.messages)
    else setMessages(previous => [...previous, { role: 'assistant', content: data.reply }])
    if (data.staff_questions) setStaffQuestions(data.staff_questions)
  }, [])

  // A reply as it arrives: the staff's notes, and the interviewer's words so far.
  const [live, setLive] = useState(null)
  const voiceOnRef = useRef(false)
  voiceOnRef.current = voiceOn

  // One turn of the conversation, live: the staff's notes and the reply are
  // shown - and, with voice on, spoken - as they arrive, rather than all at
  // once at the end.
  const runTurn = useCallback(async (history, { retry = false } = {}) => {
    const speaking = voiceOnRef.current
    let heard = false
    let turn
    if (speaking) turn = hold()
    setLive({ staff: [], text: '' })
    let text = ''
    try {
      let data
      try {
        data = await api.profileWizardChatLive(id, history, { retry, spoken: speaking }, (event) => {
          if (event.type === 'staff' && event.message) {
            setLive(previous => ({ ...previous, staff: [...previous.staff, event.message] }))
            if (speaking && !event.late) {
              enqueue({ text: event.message.content, speaker: event.message.speaker, key: 'live-staff' }, turn)
              heard = true
            }
          } else if (event.type === 'sentence') {
            text = text ? `${text} ${event.text}` : event.text
            setLive(previous => ({ ...previous, text }))
            if (speaking) {
              enqueue({ text: event.text, speaker: 'interviewer', key: 'live' }, turn)
              heard = true
            }
          }
        })
      } catch (e) {
        // A server without live turns yet: the ordinary request.
        if (e.status !== 404 && e.status !== 405) throw e
        data = await api.profileWizardChat(id, history, retry)
      }
      if (data.pending) {
        setPendingReply(true)
      } else {
        // What was spoken as it arrived is not read out again.
        if (heard) spokenUpTo.current = (data.messages || []).length
        applyReply(data)
      }
    } finally {
      setLive(null)
      if (speaking) release(turn)
    }
  }, [id, applyReply])

  const startInterview = useCallback(async () => {
    setMode('chat')
    setLoading(true)
    setError(null)
    setMessages([])
    setStaffQuestions([])
    setPendingReply(false)
    try {
      await api.discardProfileWizardDraft(id)
      await runTurn([])
    } catch (e) {
      await recoverAfterRequestError([], e)
    }
    setLoading(false)
  }, [id, runTurn, recoverAfterRequestError])

  // Restore a server-side interview draft before showing the start choices.
  useEffect(() => {
    if (!id) return
    Promise.all([api.getSwimmer(id), api.getProfileWizardDraft(id)])
      .then(([swimmerData, interviewDraft]) => {
        setSwimmer(swimmerData)
        if (interviewDraft.messages?.length || interviewDraft.awaiting_reply) {
          setMessages(interviewDraft.messages || [])
          setStaffQuestions(interviewDraft.staff_questions || [])
          setPendingReply(Boolean(interviewDraft.awaiting_reply))
          setMode('chat')
        } else {
          setMode('choice')
        }
        setLoading(false)
      })
      .catch(e => {
        setError(e.message)
        setLoading(false)
      })
  }, [id])

  // A reply may finish after navigation or a dropped browser connection. Poll
  // the persisted draft so it appears as soon as the server has saved it.
  useEffect(() => {
    if (!pendingReply || !id) return undefined
    let cancelled = false
    const check = async () => {
      try {
        const interviewDraft = await api.getProfileWizardDraft(id)
        if (cancelled) return
        if (!interviewDraft.awaiting_reply) {
          setMessages(interviewDraft.messages || [])
          setStaffQuestions(interviewDraft.staff_questions || [])
          setPendingReply(false)
          if (interviewDraft.messages?.at(-1)?.role !== 'assistant') {
            setError('The reply did not finish, but your answer is saved. Try the reply again.')
          }
        }
      } catch {
        // Keep the visible draft and try again; no coach answer is lost.
      }
    }
    check()
    const timer = window.setInterval(check, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [id, pendingReply])

  // Read out whatever arrived since the last reading.
  useEffect(() => {
    if (!voiceOn) return
    if (spokenUpTo.current === null) {
      spokenUpTo.current = messages.length
      return
    }
    const fresh = messages
      .map((message, index) => ({ message, index }))
      .slice(spokenUpTo.current)
      .filter(({ message }) => message.role === 'assistant')
    spokenUpTo.current = messages.length
    if (fresh.length) {
      say(fresh.map(({ message, index }) => ({ text: spokenText(message), speaker: speakerOf(message), key: index })))
    }
  }, [messages, voiceOn])

  useEffect(() => () => stopSpeaking(), [])

  // Start from where the interview is: the last thing said to the coach.
  // Returns false when there was nothing to read.
  const readLatest = () => {
    const lastIndex = messages.map(m => m.role).lastIndexOf('assistant')
    if (lastIndex < 0) return false
    say({ text: spokenText(messages[lastIndex]), speaker: speakerOf(messages[lastIndex]), key: lastIndex })
    return true
  }

  const stopHandsFree = () => {
    setHandsFree(false)
    setAutoSendAt(null)
    cancelMic()
  }

  const toggleVoice = () => {
    if (voiceOn) {
      stopSpeaking()
      stopHandsFree()
      setVoiceOn(false)
      return
    }
    unlockSpeech()
    setVoiceOn(true)
    spokenUpTo.current = messages.length
    readLatest()
  }

  const toggleHandsFree = () => {
    if (handsFree) {
      stopHandsFree()
      return
    }
    // Both started from this tap, as phones require.
    unlockSpeech()
    primeMicrophone()
    setHandsFreeNote(null)
    setVoiceOn(true)
    voiceOnRef.current = true
    setHandsFree(true)
    handsFreeRef.current = true
    spokenUpTo.current = messages.length
    if (!readLatest()) startMic({ autoStop: true })
  }

  // Starting by voice: everything is switched on from this one tap, which is
  // what lets a phone play the staff's voices and open the mic later.
  const startByVoice = () => {
    unlockSpeech()
    primeMicrophone()
    setHandsFreeNote(null)
    setVoiceOn(true)
    voiceOnRef.current = true
    if (micSupported) {
      setHandsFree(true)
      handsFreeRef.current = true
    }
    spokenUpTo.current = 0
    startInterview()
  }

  const listenNow = () => {
    stopSpeaking()
    sendNowRef.current = false
    setAutoSendAt(null)
    setHandsFreeNote(null)
    startMic({ autoStop: handsFree })
  }

  const toggleMic = () => {
    if (recording) {
      stopMic()
      return
    }
    listenNow()
  }

  const sendNow = () => {
    sendNowRef.current = true
    stopMic()
  }

  // The mic opens when the staff have finished talking - unless a reply is on
  // its way, the coach is already speaking, or the interview is over.
  // The staff can finish speaking a moment before the screen knows the turn
  // is over; then listening starts as soon as it does.
  const listenRef = useRef(null)
  const listenWhenFree = useRef(false)
  listenRef.current = () => {
    if (!handsFreeRef.current || mode !== 'chat' || saved || recording || transcribing || autoSendAt) return
    if (sending || pendingReply || isBusy()) {
      listenWhenFree.current = true
      return
    }
    listenWhenFree.current = false
    setHandsFreeNote(null)
    startMic({ autoStop: true })
  }
  useEffect(() => onFinished(() => listenRef.current()), [])
  useEffect(() => {
    if (listenWhenFree.current && !sending && !pendingReply) listenRef.current()
  }, [sending, pendingReply])

  // Scroll to bottom on new message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setError(null)

    const userMsg = { role: 'user', content: text }
    const next = [...messages, userMsg]
    setMessages(next)
    setSending(true)

    try {
      await runTurn(next)
    } catch (e) {
      await recoverAfterRequestError(next, e)
    }
    setSending(false)
  }, [input, messages, runTurn, recoverAfterRequestError, sending])

  const readySignalled = messages.some(m => m.role === 'assistant' && messageSignalsReadyToSave(m.content))

  // Hands-free countdown to sending what the coach said.
  const autoSendRef = useRef(null)
  autoSendRef.current = () => {
    setAutoSendAt(null)
    if (readySignalled && asksToSave(input)) {
      setInput('')
      saveProfile()
      return
    }
    send()
  }
  useEffect(() => {
    if (!autoSendAt) return undefined
    const timer = window.setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= autoSendAt) autoSendRef.current()
    }, 200)
    return () => window.clearInterval(timer)
  }, [autoSendAt])

  const retryLastReply = async () => {
    if (sending || messages.at(-1)?.role !== 'user') return
    setSending(true)
    setPendingReply(false)
    setError(null)
    try {
      await runTurn(messages, { retry: true })
    } catch (e) {
      await recoverAfterRequestError(messages, e)
    }
    setSending(false)
  }

  const discardInterview = async () => {
    if (!window.confirm('Discard this unfinished interview and start again? The confirmed swimmer profile will not change.')) return
    setError(null)
    try {
      await api.discardProfileWizardDraft(id)
      setMessages([])
      setStaffQuestions([])
      setPendingReply(false)
      setMode('choice')
    } catch (e) {
      setError(e.message)
    }
  }

  const saveProfile = async () => {
    if (saving || saved) return
    setSaving(true)
    setError(null)
    try {
      await api.profileWizardSave(id, messages)
      setPendingReply(false)
      setSaved(true)
    } catch (e) {
      setError(e.message)
    }
    setSaving(false)
  }

  const prepareExistingDraft = async () => {
    if (drafting) return
    setDrafting(true)
    setError(null)
    try {
      const result = await api.previewFoundationFromEvidence(id)
      setDraft(result)
      setMode('draft')
    } catch (e) {
      setError(e.message)
    }
    setDrafting(false)
  }

  const saveReviewedDraft = async (reviewed) => {
    if (draftSaving) return
    setDraftSaving(true)
    setError(null)
    try {
      await api.saveReviewedFoundation(id, reviewed)
      setSaved(true)
    } catch (e) {
      setError(e.message)
    }
    setDraftSaving(false)
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const canSave = (readySignalled || (messages.length >= 6 && messages.at(-1)?.role === 'assistant')) && !saved

  return (
    <div className="fixed inset-0 bg-pool-950 flex flex-col max-w-lg mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between px-4 h-14 border-b border-pool-700/60 shrink-0">
        <button
          onClick={() => navigate(`/swimmers/${id}`)}
          className="flex items-center gap-2 text-pool-400 hover:text-pool-200 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
          </svg>
          <span className="text-sm">{swimmer?.name || 'Back'}</span>
        </button>

        <div className="text-center">
          <p className="text-sm font-semibold text-pool-100">Foundation Profile</p>
          {swimmer && <p className="text-xs text-pool-500">{swimmer.name}</p>}
        </div>

        {mode === 'chat' ? (
        <button
          onClick={saveProfile}
          disabled={!canSave || saving || saved}
          className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
            saved
              ? 'bg-green-800/50 text-green-400'
              : canSave
              ? `bg-accent-600 text-white hover:bg-accent-500 ${readySignalled ? 'animate-pulse' : ''}`
              : 'text-pool-600 cursor-not-allowed'
          }`}
        >
          {saved ? 'Saved' : saving ? 'Saving…' : 'Save Profile'}
        </button>
        ) : <span className="w-16" />}
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        <div className="bg-accent-700/20 border border-accent-700/40 rounded-xl px-3 py-2.5">
          <p className="text-xs font-medium text-accent-400">One foundation, nine coaching areas</p>
          <p className="text-[11px] text-pool-400 mt-1 leading-relaxed">
            Complete this core picture once. Future confirmed notes add to it, while race, training and technical summaries develop separately through the season.
          </p>
        </div>

        {mode === 'choice' && !saved && (
          <div className="bg-pool-800 border border-pool-700 rounded-2xl p-4 space-y-4">
            <div>
              <p className="text-sm font-semibold text-pool-100">
                {swimmer?.profile_status?.has_profile ? 'Continue this swimmer’s profile' : 'Choose how to build this swimmer’s profile'}
              </p>
              <p className="text-xs text-pool-400 mt-1 leading-relaxed">
                The interview reads {swimmer?.name}'s live times, observations, completed foundation areas and living profiles before choosing each question.
                The physiologist, performance analyst and swimmer manager sit in: they bring their own questions and react to your answers. Name one of them in a reply to ask them directly.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="bg-pool-900/50 rounded-xl px-3 py-2">
                <p className="text-lg font-semibold text-accent-300">{swimmer?.profile_status?.living_built || 0}/{swimmer?.profile_status?.living_total || 4}</p>
                <p className="text-[10px] text-pool-500">living sections</p>
              </div>
              <div className="bg-pool-900/50 rounded-xl px-3 py-2">
                <p className="text-lg font-semibold text-amber-300">{swimmer?.profile_status?.completed_areas || 0}/{swimmer?.profile_status?.total_areas || 9}</p>
                <p className="text-[10px] text-pool-500">foundation confirmed</p>
              </div>
            </div>
            {swimmer?.profile_status?.has_profile && (
              <button
                type="button"
                onClick={prepareExistingDraft}
                disabled={drafting}
                className="w-full bg-accent-600 hover:bg-accent-500 disabled:opacity-50 rounded-xl py-3 text-sm font-semibold"
              >
                {drafting ? 'Preparing carry-over…' : 'Carry over existing profile evidence'}
              </button>
            )}
            <p className="text-xs text-pool-400 pt-1">Start the interview with Sam and the staff:</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={startByVoice}
                disabled={drafting}
                className={`rounded-xl py-3 px-2 text-sm font-semibold disabled:opacity-50 ${swimmer?.profile_status?.has_profile ? 'border border-pool-600 text-pool-200' : 'bg-accent-600 text-white'}`}
              >
                Talk it through
                <span className="block text-[10px] font-normal opacity-80 mt-0.5">
                  {micSupported ? 'They speak, you answer out loud' : 'They speak, you type'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => startInterview()}
                disabled={drafting}
                className="rounded-xl py-3 px-2 text-sm font-semibold border border-pool-600 text-pool-200 disabled:opacity-50"
              >
                Type it
                <span className="block text-[10px] font-normal opacity-80 mt-0.5">Read and type; voice can be turned on later</span>
              </button>
            </div>

            <p className="text-[10px] text-pool-600 text-center">The API interview saves a draft as you go; the swimmer profile changes only when you choose Save Profile.</p>
          </div>
        )}

        {mode === 'draft' && draft && !saved && (
          <FoundationDraftReview
            draft={draft}
            saving={draftSaving}
            onSave={saveReviewedDraft}
            onCancel={() => {
              setDraft(null)
              setMode('choice')
            }}
          />
        )}

        {mode === 'chat' && messages.length > 0 && !saved && (
          <div className="flex items-center justify-between gap-3 bg-pool-900/60 border border-pool-700 rounded-xl px-3 py-2">
            <p className="text-[10px] text-pool-500 leading-relaxed">
              Interview draft saved automatically — you can leave and return here.
            </p>
            <button
              type="button"
              onClick={discardInterview}
              disabled={sending || pendingReply}
              className="shrink-0 text-[10px] text-pool-400 underline disabled:opacity-40"
            >
              Start over
            </button>
          </div>
        )}

        {mode === 'chat' && !saved && <StaffAtTheTable questions={staffQuestions} />}

        {loading && !live?.text && (
          <div className="flex justify-start">
            <div className="bg-pool-700 rounded-2xl rounded-bl-sm px-4 py-3">
              <ThinkingDots />
            </div>
          </div>
        )}

        {mode === 'chat' && !loading && messages.length === 0 && !error && (
          <p className="text-pool-500 text-sm text-center pt-8">Starting profiling session…</p>
        )}

        {mode === 'chat' && messages.map((m, i) => {
          if (m.speaker) {
            const style = staffStyle(m.speaker)
            const speaking = playing?.key === i
            return (
              <div key={i} className="flex items-end gap-2">
                <StaffAvatar role={m.speaker} size={32} className={speaking ? 'ring-2 ring-accent-400' : ''} />
                <div
                  className="max-w-[80%] rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed bg-pool-800 text-pool-200 border-l-4"
                  style={{ borderLeftColor: style.colour }}
                >
                  <p className="flex items-center gap-2 text-[11px] font-semibold text-pool-300 mb-1">
                    {staffLabel(m.speaker)}
                    <SpeakButton text={spokenText(m)} speaker={m.speaker} speakKey={i} className="ml-auto" />
                  </p>
                  <MessageContent text={m.content} />
                </div>
              </div>
            )
          }
          const ready = m.role === 'assistant' && messageSignalsReadyToSave(m.content)
          const displayText = ready ? m.content.split(READY_TO_SAVE_MARKER).join('').trim() : m.content
          const askingFor = m.asks_for && staffQuestions.find(q => q.id === m.asks_for)
          const speaking = playing?.key === i
          return (
            <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`flex items-end gap-2 ${m.role === 'user' ? 'justify-end' : ''}`}>
              {m.role === 'assistant' && (
                <StaffAvatar role="interviewer" size={32} className={speaking ? 'ring-2 ring-accent-400' : ''} />
              )}
              <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'bg-accent-700 text-white rounded-br-sm'
                  : 'bg-pool-700 text-pool-200 rounded-bl-sm'
              }`}>
                {askingFor && (
                  <p className="flex items-center gap-1.5 text-[10px] text-pool-400 mb-1.5">
                    <StaffBadge role={askingFor.role} />
                    Asking for {staffLabel(askingFor.role)}
                  </p>
                )}
                <MessageContent text={displayText} />
                {m.role === 'assistant' && (
                  <SpeakButton text={displayText} speaker="interviewer" speakKey={i} className="mt-1.5" />
                )}
              </div>
              </div>
              {ready && !saved && (
                <button
                  type="button"
                  onClick={saveProfile}
                  disabled={saving}
                  className="mt-2 bg-green-700 hover:bg-green-600 disabled:opacity-50 rounded-xl px-4 py-2.5 text-sm font-semibold text-white"
                >
                  {saving ? 'Saving…' : 'Save Profile'}
                </button>
              )}
            </div>
          )
        })}

        {mode === 'chat' && live && live.staff.map((m, i) => (
          <div key={`live-staff-${i}`} className="flex items-end gap-2">
            <StaffAvatar role={m.speaker} size={32} />
            <div
              className="max-w-[80%] rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed bg-pool-800 text-pool-200 border-l-4"
              style={{ borderLeftColor: staffStyle(m.speaker).colour }}
            >
              <p className="text-[11px] font-semibold text-pool-300 mb-1">{staffLabel(m.speaker)}</p>
              <MessageContent text={m.content} />
            </div>
          </div>
        ))}

        {mode === 'chat' && live?.text && (
          <div className="flex items-end gap-2">
            <StaffAvatar role="interviewer" size={32} className="ring-2 ring-accent-400" />
            <div className="max-w-[80%] rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed bg-pool-700 text-pool-200">
              <MessageContent text={live.text} />
            </div>
          </div>
        )}

        {mode === 'chat' && sending && !live?.text && (
          <div className="flex justify-start">
            <div className="bg-pool-700 rounded-2xl rounded-bl-sm px-4 py-3">
              <ThinkingDots />
            </div>
          </div>
        )}

        {mode === 'chat' && pendingReply && !sending && (
          <div className="bg-amber-900/20 border border-amber-800/50 rounded-xl px-3 py-2.5">
            <div className="flex items-center gap-2">
              <ThinkingDots />
              <p className="text-xs text-amber-200">Your answer is saved. Waiting for the reply…</p>
            </div>
            <p className="text-[10px] text-pool-500 mt-1.5">You can leave this screen; the interview will resume here.</p>
          </div>
        )}

        {error && (
          <div className="bg-red-900/20 border border-red-800/50 rounded-xl px-3 py-2 text-xs text-red-300">
            {error}
            {mode === 'chat' && messages.at(-1)?.role === 'user' && !sending && !pendingReply && (
              <button
                type="button"
                onClick={retryLastReply}
                className="block mt-2 text-red-200 underline font-semibold"
              >
                Try the reply again
              </button>
            )}
          </div>
        )}

        {saved && (
          <div className="bg-green-900/20 border border-green-800/50 rounded-xl px-4 py-3 text-sm text-green-300 text-center">
            Foundation saved — {swimmer?.name}'s existing profile has been safely updated.
            <br />
            <button
              onClick={() => navigate(`/swimmers/${id}`)}
              className="mt-2 text-xs text-green-400 underline"
            >
              Back to {swimmer?.name}
            </button>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      {!saved && mode === 'chat' && (
        <div className="px-4 pb-6 pt-2 border-t border-pool-700/60 shrink-0">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <button
              type="button"
              onClick={toggleVoice}
              className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                voiceOn ? 'bg-accent-600 border-accent-500 text-white' : 'border-pool-600 text-pool-400'
              }`}
              aria-pressed={voiceOn}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
              </svg>
              {voiceOn ? 'Voices on' : 'Hear the staff'}
            </button>
            {micSupported && (
              <button
                type="button"
                onClick={toggleHandsFree}
                className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                  handsFree ? 'bg-green-700 border-green-600 text-white' : 'border-pool-600 text-pool-400'
                }`}
                aria-pressed={handsFree}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
                </svg>
                {handsFree ? 'Talking it through' : 'Talk it through'}
              </button>
            )}
            {playing && (
              <span className="flex items-center gap-1.5 text-[11px] text-pool-400 ml-auto">
                <StaffAvatar role={playing.speaker} size={18} />
                {staffStyle(playing.speaker).name || staffStyle(playing.speaker).title} speaking
              </span>
            )}
          </div>
          {playing && micSupported && !recording && !pendingReply && (
            <button
              type="button"
              onClick={listenNow}
              className="w-full mb-2 rounded-xl py-2.5 text-sm font-semibold border border-accent-500 text-accent-200"
            >
              My turn: stop and listen to me
            </button>
          )}
          {recording && (
            <div className="flex items-center gap-3 mb-2">
              <p className="text-[11px] text-green-300 flex-1">
                {handsFree ? "Listening. Tap when you're done, or just pause." : "Listening. Tap when you're done."}
              </p>
              <button
                type="button"
                onClick={sendNow}
                className="shrink-0 rounded-xl px-4 py-2.5 text-sm font-semibold bg-green-600 hover:bg-green-500 text-white"
              >
                Done, send it
              </button>
            </div>
          )}
          {transcribing && (
            <p className="text-[11px] text-yellow-300 mb-2">Writing down what you said…</p>
          )}
          {autoSendAt && (
            <div className="flex items-center gap-2 bg-green-900/30 border border-green-800/60 rounded-xl px-3 py-2 mb-2">
              <p className="text-xs text-green-200 flex-1">
                {readySignalled && asksToSave(input) ? 'Saving the profile' : 'Sending'} in {Math.max(1, Math.ceil((autoSendAt - now) / 1000))}…
              </p>
              <button type="button" onClick={() => { setAutoSendAt(null); textareaRef.current?.focus() }}
                className="text-xs text-pool-300 underline">Edit</button>
              <button type="button" onClick={() => autoSendRef.current()}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-green-600 text-white">Send now</button>
            </div>
          )}
          {handsFreeNote && (
            <p className="text-[11px] text-pool-400 mb-2">{handsFreeNote}</p>
          )}
          {micError && (
            <button type="button" onClick={clearMicError} className="block text-xs text-amber-400 text-left mb-2">
              {micError} (tap to dismiss)
            </button>
          )}
          <div className={`flex items-end gap-2 bg-pool-800 border rounded-2xl px-3 py-2.5 focus-within:border-accent-500 transition-colors ${
            recording ? 'border-red-500' : transcribing ? 'border-yellow-500' : 'border-pool-600'
          }`}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => { setAutoSendAt(null); setInput(e.target.value) }}
              onFocus={() => setAutoSendAt(null)}
              onKeyDown={handleKey}
              disabled={pendingReply}
              placeholder={recording ? 'Listening… tap the mic to finish' : transcribing ? 'Writing down what you said…' : 'Reply, or tap the mic…'}
              rows={1}
              className="flex-1 bg-transparent text-sm text-pool-100 placeholder-pool-500 resize-none focus:outline-none leading-relaxed"
              style={{ maxHeight: '120px', overflowY: 'auto' }}
              onInput={e => {
                e.target.style.height = 'auto'
                e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
              }}
            />
            {micSupported && (
              <button
                type="button"
                onClick={toggleMic}
                disabled={transcribing || pendingReply}
                className={`shrink-0 w-8 h-8 flex items-center justify-center rounded-full transition-colors disabled:opacity-40 ${
                  recording ? 'bg-red-500 text-white animate-pulse' : transcribing ? 'text-yellow-400 animate-pulse' : 'bg-pool-700 text-pool-300'
                }`}
                aria-label={recording ? 'Finish speaking' : 'Answer by speaking'}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
                </svg>
              </button>
            )}
            <button
              onClick={send}
              disabled={!input.trim() || sending || pendingReply}
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-accent-600 disabled:opacity-40 transition-opacity"
            >
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 10.5 7.5-7.5m0 0 7.5 7.5M12 3v18" />
              </svg>
            </button>
          </div>
          {!canSave && messages.length > 0 && !saved && (
            <p className="text-xs text-pool-600 text-center mt-2">
              Continue the conversation — "Save Profile" unlocks after a few exchanges
            </p>
          )}
        </div>
      )}
    </div>
  )
}
