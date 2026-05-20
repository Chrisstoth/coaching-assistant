import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../api'

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

export default function ProfileWizard() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [swimmer, setSwimmer] = useState(null)
  const [messages, setMessages] = useState([]) // [{role:'user'|'assistant', content:'...'}]
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)  // initial AI opener
  const [sending, setSending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  // Load swimmer info
  useEffect(() => {
    api.getSwimmer(id).then(setSwimmer).catch(() => {})
  }, [id])

  // Fetch opening message from AI
  useEffect(() => {
    if (!id) return
    api.profileWizardChat(id, [])
      .then(data => {
        setMessages([{ role: 'assistant', content: data.reply }])
        setLoading(false)
      })
      .catch(e => {
        setError(e.message)
        setLoading(false)
      })
  }, [id])

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
      const data = await api.profileWizardChat(id, next)
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply }])
    } catch (e) {
      setError(e.message)
    }
    setSending(false)
  }, [id, input, messages, sending])

  const saveProfile = async () => {
    if (saving || saved) return
    setSaving(true)
    setError(null)
    try {
      await api.profileWizardSave(id, messages)
      setSaved(true)
    } catch (e) {
      setError(e.message)
    }
    setSaving(false)
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const canSave = messages.length >= 6 && !saved // at least a few exchanges

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
          <p className="text-sm font-semibold text-pool-100">Profile Wizard</p>
          {swimmer && <p className="text-xs text-pool-500">{swimmer.name}</p>}
        </div>

        <button
          onClick={saveProfile}
          disabled={!canSave || saving || saved}
          className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
            saved
              ? 'bg-green-800/50 text-green-400'
              : canSave
              ? 'bg-accent-600 text-white hover:bg-accent-500'
              : 'text-pool-600 cursor-not-allowed'
          }`}
        >
          {saved ? 'Saved' : saving ? 'Saving…' : 'Save Profile'}
        </button>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {loading && (
          <div className="flex justify-start">
            <div className="bg-pool-700 rounded-2xl rounded-bl-sm px-4 py-3">
              <ThinkingDots />
            </div>
          </div>
        )}

        {!loading && messages.length === 0 && !error && (
          <p className="text-pool-500 text-sm text-center pt-8">Starting profiling session…</p>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
              m.role === 'user'
                ? 'bg-accent-700 text-white rounded-br-sm'
                : 'bg-pool-700 text-pool-200 rounded-bl-sm'
            }`}>
              <MessageContent text={m.content} />
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

        {error && (
          <div className="bg-red-900/20 border border-red-800/50 rounded-xl px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        {saved && (
          <div className="bg-green-900/20 border border-green-800/50 rounded-xl px-4 py-3 text-sm text-green-300 text-center">
            Profile saved — {swimmer?.name}'s physical and psychological profiles have been updated.
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
      {!saved && (
        <div className="px-4 pb-6 pt-2 border-t border-pool-700/60 shrink-0">
          <div className="flex items-end gap-2 bg-pool-800 border border-pool-600 rounded-2xl px-3 py-2.5 focus-within:border-accent-500 transition-colors">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Reply…"
              rows={1}
              className="flex-1 bg-transparent text-sm text-pool-100 placeholder-pool-500 resize-none focus:outline-none leading-relaxed"
              style={{ maxHeight: '120px', overflowY: 'auto' }}
              onInput={e => {
                e.target.style.height = 'auto'
                e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
              }}
            />
            <button
              onClick={send}
              disabled={!input.trim() || sending}
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
