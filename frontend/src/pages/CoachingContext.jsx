import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

export default function CoachingContext() {
  const [profiles, setProfiles] = useState([])
  const [current, setCurrent] = useState(null)
  const [conversation, setConversation] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [finalising, setFinalising] = useState(false)
  const [titleInput, setTitleInput] = useState('')
  const [view, setView] = useState('chat') // 'chat' | 'current' | 'history'
  const [selectedProfile, setSelectedProfile] = useState(null)
  const [showFinalise, setShowFinalise] = useState(false)
  const bottomRef = useRef(null)

  const load = async () => {
    const [profs, cur, conv] = await Promise.all([
      api.getCoachingProfiles().catch(() => []),
      api.getCurrentCoachingProfile().catch(() => null),
      api.getCoachingConversation().catch(() => []),
    ])
    setProfiles(profs)
    setCurrent(cur)
    setConversation(conv)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [conversation])

  const send = async () => {
    const msg = input.trim()
    if (!msg || sending) return
    setInput('')
    setSending(true)
    setConversation(prev => [...prev, { role: 'coach', message: msg }])
    try {
      const { reply } = await api.coachingChat(msg)
      setConversation(prev => [...prev, { role: 'ai', message: reply }])
    } catch (e) {
      alert('Error: ' + e.message)
    }
    setSending(false)
  }

  const finalise = async () => {
    if (!titleInput.trim()) { alert('Give this context a title first'); return }
    setFinalising(true)
    try {
      const profile = await api.finaliseCoachingProfile(titleInput.trim())
      setCurrent(profile)
      setShowFinalise(false)
      setTitleInput('')
      await load()
      setView('current')
    } catch (e) {
      alert('Error: ' + e.message)
    }
    setFinalising(false)
  }

  const clearConversation = async () => {
    if (!window.confirm('Clear the current conversation? This cannot be undone.')) return
    await api.clearCoachingConversation()
    setConversation([])
  }

  const openProfile = async (id) => {
    const p = await api.getCoachingProfile(id)
    setSelectedProfile(p)
    setView('history-detail')
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0">
        <h1 className="text-lg font-bold">Coaching Context</h1>
        <div className="flex gap-1">
          {['chat', 'current', 'history'].map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`text-xs px-3 py-1.5 rounded-full font-medium capitalize ${
                view === v || (view === 'history-detail' && v === 'history')
                  ? 'bg-accent-600 text-white'
                  : 'bg-pool-700 text-pool-400'
              }`}
            >
              {v === 'chat' ? 'Build' : v === 'current' ? 'Current' : 'History'}
            </button>
          ))}
        </div>
      </div>

      {/* Chat view */}
      {view === 'chat' && (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Context banner */}
          {current && (
            <div className="mx-4 mb-2 bg-pool-800 rounded-lg px-3 py-2 text-xs text-pool-400 shrink-0">
              Updating on: <span className="text-pool-200 font-medium">{current.title}</span>
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 space-y-3 pb-2">
            {conversation.length === 0 && (
              <div className="text-center py-10 space-y-3">
                <p className="text-pool-400 text-sm">
                  {current
                    ? "Add an update to your coaching context — what's changed?"
                    : "Let's build your coaching context. I'll ask you some questions to understand your philosophy, where your squad is, and what you're working towards."}
                </p>
                <button
                  onClick={() => send()}
                  disabled
                  className="hidden"
                />
                <button
                  onClick={async () => {
                    setSending(true)
                    setConversation([{ role: 'ai', message: current
                      ? "What's changed or evolved since your last context update? Tell me about anything — training response, squad dynamics, your own thinking, targets that have shifted."
                      : "Let's build your coaching context. Start wherever feels natural — your philosophy, where your squad currently is, or what you're building towards this season. What would you like to begin with?"
                    }])
                    setSending(false)
                  }}
                  className="bg-accent-600 text-white rounded-xl px-5 py-2.5 text-sm font-semibold mx-auto block"
                >
                  {current ? 'Start update' : 'Start building'}
                </button>
              </div>
            )}

            {conversation.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'coach' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                  m.role === 'coach'
                    ? 'bg-accent-700 text-white rounded-br-sm'
                    : 'bg-pool-800 text-pool-200 rounded-bl-sm'
                }`}>
                  <p className="whitespace-pre-wrap leading-relaxed">{m.message}</p>
                </div>
              </div>
            ))}

            {sending && (
              <div className="flex justify-start">
                <div className="bg-pool-800 rounded-2xl rounded-bl-sm px-4 py-3">
                  <p className="text-pool-400 text-sm">Thinking…</p>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Actions row */}
          {conversation.length > 0 && !showFinalise && (
            <div className="px-4 pt-1 pb-1 shrink-0 flex gap-2">
              <button
                onClick={() => setShowFinalise(true)}
                className="flex-1 bg-emerald-700 hover:bg-emerald-600 text-white rounded-xl py-2 text-xs font-semibold transition-colors"
              >
                Finalise → Save context
              </button>
              <button
                onClick={clearConversation}
                className="text-xs text-pool-500 px-3"
              >
                Clear
              </button>
            </div>
          )}

          {/* Finalise form */}
          {showFinalise && (
            <div className="px-4 pb-2 space-y-2 shrink-0 bg-pool-900 pt-3 border-t border-pool-700">
              <p className="text-xs text-pool-400">Give this context snapshot a title:</p>
              <input
                placeholder="e.g. Season Start 2025-26, Post-Christmas Block…"
                value={titleInput}
                onChange={e => setTitleInput(e.target.value)}
                className="w-full bg-pool-700 rounded-lg px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={finalise}
                  disabled={finalising || !titleInput.trim()}
                  className="flex-1 bg-emerald-700 disabled:opacity-40 rounded-xl py-2.5 text-sm font-semibold"
                >
                  {finalising ? 'Synthesising…' : 'Confirm & save'}
                </button>
                <button
                  onClick={() => setShowFinalise(false)}
                  className="text-xs text-pool-400 px-3"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Input */}
          {!showFinalise && conversation.length > 0 && (
            <div className="px-4 pb-4 pt-1 shrink-0 flex gap-2">
              <textarea
                value={input}
                onChange={e => {
                  setInput(e.target.value)
                  e.target.style.height = 'auto'
                  e.target.style.height = `${e.target.scrollHeight}px`
                }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                placeholder="Type your response…"
                rows={4}
                className="flex-1 bg-pool-700 rounded-xl px-3 py-2.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none resize-none min-h-[96px] max-h-64 overflow-y-auto"
              />
              <button
                onClick={send}
                disabled={sending || !input.trim()}
                className="bg-accent-600 disabled:opacity-40 rounded-xl px-4 text-sm font-semibold self-end py-2.5"
              >
                Send
              </button>
            </div>
          )}
        </div>
      )}

      {/* Current profile view */}
      {view === 'current' && (
        <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-4">
          {!current ? (
            <div className="text-center py-10">
              <p className="text-pool-400 text-sm">No coaching context yet.</p>
              <button
                onClick={() => setView('chat')}
                className="mt-4 bg-accent-600 rounded-xl px-5 py-2.5 text-sm font-semibold"
              >
                Build context
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-pool-200">{current.title}</p>
                  <p className="text-xs text-pool-500">{new Date(current.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                </div>
                <button
                  onClick={() => setView('chat')}
                  className="text-xs bg-accent-700 text-accent-200 rounded-full px-3 py-1.5 font-medium"
                >
                  + Update
                </button>
              </div>

              {[
                { label: 'Philosophy & Ethos', content: current.ethos },
                { label: 'Squad State Right Now', content: current.squad_state },
                { label: 'Season Targets', content: current.targets },
                { label: 'Current Training Block Focus', content: current.current_focus },
              ].map(({ label, content }) => content && (
                <div key={label} className="bg-pool-800 rounded-xl p-4">
                  <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-2">{label}</p>
                  <p className="text-sm text-pool-200 leading-relaxed whitespace-pre-wrap">{content}</p>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* History list */}
      {view === 'history' && (
        <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-2">
          {profiles.length === 0 ? (
            <p className="text-pool-400 text-sm text-center py-10">No saved contexts yet.</p>
          ) : (
            profiles.map(p => (
              <button
                key={p.id}
                onClick={() => openProfile(p.id)}
                className="w-full bg-pool-800 rounded-xl p-4 text-left"
              >
                <div className="flex items-center justify-between">
                  <p className="font-medium text-sm text-pool-200">{p.title}</p>
                  <div className="flex items-center gap-2 shrink-0">
                    {p.is_current && (
                      <span className="text-xs bg-emerald-900 text-emerald-300 rounded-full px-2 py-0.5 font-medium">Current</span>
                    )}
                    <span className="text-pool-500 text-xs">›</span>
                  </div>
                </div>
                <p className="text-xs text-pool-500 mt-0.5">
                  {new Date(p.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </p>
              </button>
            ))
          )}
        </div>
      )}

      {/* History detail */}
      {view === 'history-detail' && selectedProfile && (
        <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-4">
          <button onClick={() => setView('history')} className="text-xs text-pool-400 flex items-center gap-1">
            ‹ Back
          </button>
          <div>
            <p className="font-semibold text-pool-200">{selectedProfile.title}</p>
            <p className="text-xs text-pool-500">{new Date(selectedProfile.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
            {selectedProfile.is_current && <span className="text-xs bg-emerald-900 text-emerald-300 rounded-full px-2 py-0.5 font-medium inline-block mt-1">Current</span>}
          </div>
          {[
            { label: 'Philosophy & Ethos', content: selectedProfile.ethos },
            { label: 'Squad State Right Now', content: selectedProfile.squad_state },
            { label: 'Season Targets', content: selectedProfile.targets },
            { label: 'Current Training Block Focus', content: selectedProfile.current_focus },
          ].map(({ label, content }) => content && (
            <div key={label} className="bg-pool-800 rounded-xl p-4">
              <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-2">{label}</p>
              <p className="text-sm text-pool-200 leading-relaxed whitespace-pre-wrap">{content}</p>
            </div>
          ))}
          <div className="bg-pool-800 rounded-xl p-4">
            <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-2">Full Summary</p>
            <p className="text-sm text-pool-200 leading-relaxed whitespace-pre-wrap">{selectedProfile.summary}</p>
          </div>
        </div>
      )}
    </div>
  )
}
