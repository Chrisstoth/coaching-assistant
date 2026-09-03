import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'

export default function CoachCheckIn() {
  const { id } = useParams()
  const navigate = useNavigate()
  const bottomRef = useRef(null)
  const [checkin, setCheckin] = useState(null)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [completing, setCompleting] = useState(false)

  useEffect(() => {
    api.getCoachCheckIn(id)
      .then(setCheckin)
      .catch(error => alert(`Could not load check-in: ${error.message}`))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [checkin?.messages, sending])

  const send = async () => {
    const message = input.trim()
    if (!message || sending) return
    setInput('')
    setSending(true)
    setCheckin(previous => ({
      ...previous,
      messages: [...(previous.messages || []), { role: 'coach', message }],
    }))
    try {
      const result = await api.chatCoachCheckIn(id, message)
      setCheckin(previous => ({ ...previous, messages: result.messages }))
    } catch (error) {
      alert(`Could not send reflection: ${error.message}`)
      setCheckin(previous => ({
        ...previous,
        messages: (previous.messages || []).filter((_, index, all) => index !== all.length - 1),
      }))
      setInput(message)
    }
    setSending(false)
  }

  const complete = async () => {
    setCompleting(true)
    try {
      const result = await api.completeCoachCheckIn(id)
      setCheckin(result)
    } catch (error) {
      alert(`Could not complete check-in: ${error.message}`)
    }
    setCompleting(false)
  }

  const skip = async () => {
    if (!window.confirm('Skip this check-in? It will stop appearing on Today.')) return
    try {
      await api.skipCoachCheckIn(id)
      navigate('/coach-checkins')
    } catch (error) {
      alert(`Could not skip check-in: ${error.message}`)
    }
  }

  if (loading) return <div className="p-5 text-sm text-pool-400">Loading check-in…</div>
  if (!checkin) return <div className="p-5 text-sm text-pool-400">Check-in not found.</div>

  const canComplete = (checkin.messages || []).some(message => message.role === 'coach')
  const closed = checkin.status !== 'in_progress'

  return (
    <div className="min-h-full flex flex-col">
      <header className="px-4 py-3 border-b border-pool-700/70 bg-pool-900/95 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <Link to="/coach-checkins" className="text-pool-400 hover:text-pool-200" aria-label="Back to check-ins">←</Link>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold text-pool-100 truncate">{checkin.title}</h1>
            <p className="text-[11px] text-pool-500">Private coaching reflection</p>
          </div>
          {!closed && checkin.milestone_key && (
            <button onClick={skip} className="text-xs text-pool-500 hover:text-pool-300">Skip</button>
          )}
        </div>
      </header>

      {closed ? (
        <main className="p-4 space-y-4">
          <div className="rounded-2xl bg-teal-900/30 border border-teal-700/50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-teal-400">
              {checkin.status === 'completed' ? 'Reflection summary' : 'Check-in skipped'}
            </p>
            {checkin.summary && <p className="text-sm text-pool-200 mt-2 whitespace-pre-line leading-relaxed">{checkin.summary}</p>}
          </div>
          <p className="text-xs text-pool-500 leading-relaxed">
            This is a dated reflection. It does not overwrite your coaching profile or the plan it relates to.
          </p>
          <Link to="/coach-checkins" className="inline-block text-sm font-medium text-accent-400">Back to all check-ins</Link>
        </main>
      ) : (
        <>
          <main className="flex-1 p-4 space-y-3">
            <div className="flex justify-start">
              <div className="max-w-[88%] rounded-2xl rounded-tl-md bg-pool-800 border border-pool-700 px-3.5 py-3 text-sm text-pool-200 leading-relaxed">
                {checkin.opening_question}
              </div>
            </div>
            {(checkin.messages || []).map((message, index) => (
              <div key={index} className={`flex ${message.role === 'coach' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[88%] rounded-2xl px-3.5 py-3 text-sm leading-relaxed ${
                  message.role === 'coach'
                    ? 'rounded-tr-md bg-teal-700 text-white'
                    : 'rounded-tl-md bg-pool-800 border border-pool-700 text-pool-200'
                }`}>
                  {message.message}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-tl-md bg-pool-800 border border-pool-700 px-4 py-3 text-xs text-pool-500">Thinking…</div>
              </div>
            )}
            <div ref={bottomRef} />
          </main>

          <footer className="sticky bottom-16 bg-pool-900/95 backdrop-blur border-t border-pool-700 p-3 space-y-2">
            <div className="flex gap-2">
              <textarea
                value={input}
                onChange={event => setInput(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    send()
                  }
                }}
                rows={2}
                placeholder="Say what you are thinking…"
                className="flex-1 resize-none rounded-xl bg-pool-800 border border-pool-700 px-3 py-2.5 text-sm text-pool-100 placeholder:text-pool-500 focus:outline-none focus:border-teal-600"
              />
              <button
                onClick={send}
                disabled={!input.trim() || sending}
                className="self-end rounded-xl bg-teal-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
              >
                Send
              </button>
            </div>
            {canComplete && (
              <button
                onClick={complete}
                disabled={completing || sending}
                className="w-full rounded-lg py-2 text-xs font-medium text-pool-400 hover:text-teal-300 disabled:opacity-50"
              >
                {completing ? 'Creating reflection summary…' : 'Finish and save reflection'}
              </button>
            )}
          </footer>
        </>
      )}
    </div>
  )
}
