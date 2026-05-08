import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import useLongPress from '../hooks/useLongPress'

const ENERGY_COLOURS = {
  aerobic: 'bg-blue-900 text-blue-300',
  threshold: 'bg-yellow-900 text-yellow-300',
  speed: 'bg-red-900 text-red-300',
  recovery: 'bg-green-900 text-green-300',
}

function SessionCard({ s, onLongPress }) {
  const navigate = useNavigate()
  const eColour = ENERGY_COLOURS[s.energy_system_focus] || 'bg-pool-700 text-pool-400'
  const longPress = useLongPress(
    () => onLongPress(s),
    () => navigate(`/sessions/${s.id}`)
  )

  return (
    <div
      {...longPress}
      className="block bg-pool-800 rounded-xl p-4 hover:bg-pool-700 transition-colors select-none cursor-pointer"
    >
      <div className="flex justify-between items-start">
        <div className="flex-1">
          <p className="font-medium text-sm">{s.title || 'Session'}</p>
          <p className="text-pool-400 text-xs mt-0.5">
            {s.date}
            {(s.start_time || s.end_time) && (
              <span> · {s.start_time}{s.end_time ? `–${s.end_time}` : ''}</span>
            )}
          </p>
          {s.coach_intent && (
            <p className="text-pool-400 text-xs mt-1 line-clamp-1">Intent: {s.coach_intent}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 ml-3">
          {s.energy_system_focus && (
            <span className={`text-xs rounded-full px-2 py-0.5 ${eColour}`}>
              {s.energy_system_focus}
            </span>
          )}
          <Link
            to={`/sessions/${s.id}/register`}
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-accent-400"
          >
            Register →
          </Link>
        </div>
      </div>
    </div>
  )
}

export default function Sessions() {
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(null)

  useEffect(() => {
    api.getSessions({ limit: 30 }).then((data) => {
      setSessions(data)
      setLoading(false)
    })
  }, [])

  const handleDelete = async () => {
    if (!confirmDelete) return
    await api.deleteSession(confirmDelete.id)
    setSessions(prev => prev.filter(s => s.id !== confirmDelete.id))
    setConfirmDelete(null)
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex justify-between items-center pt-2">
        <h1 className="text-xl font-bold">Sessions</h1>
        <Link
          to="/sessions/new"
          className="bg-accent-600 text-white rounded-full px-4 py-1.5 text-sm font-semibold"
        >
          + New
        </Link>
      </div>

      {loading ? (
        <p className="text-pool-400 text-sm">Loading...</p>
      ) : sessions.length === 0 ? (
        <div className="text-center py-12 space-y-3">
          <p className="text-pool-400">No sessions yet.</p>
          <Link to="/import" className="text-accent-400 text-sm">Import session files →</Link>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-pool-500 text-center">Hold to delete a session</p>
          {sessions.map((s) => (
            <SessionCard key={s.id} s={s} onLongPress={setConfirmDelete} />
          ))}
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 px-4 pb-8">
          <div className="bg-pool-800 border border-pool-600 rounded-2xl p-5 w-full max-w-sm space-y-4">
            <p className="font-semibold text-sm">Delete session?</p>
            <p className="text-pool-400 text-xs">{confirmDelete.title || 'Session'} · {confirmDelete.date}</p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDelete(null)}
                className="flex-1 py-2.5 rounded-xl bg-pool-700 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="flex-1 py-2.5 rounded-xl bg-red-600 text-sm font-medium text-white"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
