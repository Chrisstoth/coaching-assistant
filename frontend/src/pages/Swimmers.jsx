import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'

export default function Swimmers() {
  const [swimmers, setSwimmers] = useState([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    api.getSwimmers({ active_only: false }).then((data) => {
      setSwimmers(data)
      setLoading(false)
    })
  }, [])

  const filtered = swimmers.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase())
  )

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const selectAll = () => setSelected(new Set(filtered.map(s => s.id)))
  const clearSelect = () => { setSelected(new Set()); setSelecting(false); setConfirmDelete(false) }

  const doDelete = async () => {
    setDeleting(true)
    try {
      await api.bulkDeleteSwimmers([...selected])
      setSwimmers(prev => prev.filter(s => !selected.has(s.id)))
      clearSelect()
    } catch (e) {
      alert(`Error: ${e.message}`)
    }
    setDeleting(false)
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex justify-between items-center pt-2">
        <h1 className="text-xl font-bold">Squad</h1>
        {selecting ? (
          <button onClick={clearSelect} className="text-pool-400 text-sm font-medium">
            Cancel
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => setSelecting(true)}
              className="text-pool-400 text-sm font-medium px-3 py-1.5 border border-pool-700 rounded-full"
            >
              Select
            </button>
            <Link
              to="/swimmers/new"
              className="bg-accent-600 text-white rounded-full px-4 py-1.5 text-sm font-semibold"
            >
              + Add
            </Link>
          </div>
        )}
      </div>

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search swimmers..."
        className="w-full bg-pool-800 rounded-xl px-4 py-3 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none"
      />

      {selecting && (
        <div className="flex items-center justify-between text-xs">
          <button onClick={selectAll} className="text-accent-400 font-medium">Select all</button>
          <span className="text-pool-400">{selected.size} selected</span>
        </div>
      )}

      {loading ? (
        <p className="text-pool-400 text-sm">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-pool-400 text-sm">No swimmers found.</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((s) => {
            const statusColor = {
              'active': 'text-green-300 bg-green-900',
              'sabbatical': 'text-yellow-300 bg-yellow-900',
              'injury': 'text-red-300 bg-red-900'
            }[s.status] || 'text-pool-400 bg-pool-700'

            const isSelected = selected.has(s.id)

            if (selecting) {
              return (
                <div
                  key={s.id}
                  onClick={() => toggleSelect(s.id)}
                  className={`flex items-center gap-3 rounded-xl px-4 py-3 cursor-pointer transition-colors ${
                    isSelected ? 'bg-accent-600/20 border border-accent-600/50' : 'bg-pool-800 border border-transparent'
                  }`}
                >
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    isSelected ? 'border-accent-500 bg-accent-600' : 'border-pool-600'
                  }`}>
                    {isSelected && <span className="text-white text-xs">✓</span>}
                  </div>
                  <div className="flex items-baseline gap-2 min-w-0 flex-1">
                    <p className="font-medium text-sm truncate">{s.name}</p>
                    <p className="text-pool-500 text-xs shrink-0">
                      {s.age != null ? `${s.age}` : s.age_group}
                      {s.school_year != null ? ` · Yr ${s.school_year}` : ''}
                    </p>
                  </div>
                  {s.status && s.status !== 'active' && (
                    <span className={`text-xs rounded-full px-2 py-0.5 shrink-0 ${statusColor}`}>
                      {s.status === 'sabbatical' ? 'Sabbatical' : 'Injury'}
                    </span>
                  )}
                </div>
              )
            }

            return (
              <Link
                key={s.id}
                to={`/swimmers/${s.id}`}
                className="flex items-center justify-between bg-pool-800 rounded-xl px-4 py-3 hover:bg-pool-700 transition-colors"
              >
                <div className="flex items-baseline gap-2 min-w-0">
                  <p className="font-medium text-sm truncate">{s.name}</p>
                  <p className="text-pool-500 text-xs shrink-0">
                    {s.age != null ? `${s.age}` : s.age_group}
                    {s.school_year != null ? ` · Yr ${s.school_year}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2 ml-2 shrink-0">
                  {s.status && s.status !== 'active' && (
                    <span className={`text-xs rounded-full px-2 py-0.5 capitalize ${statusColor}`}>
                      {s.status === 'sabbatical' ? 'Sabbatical' : 'Injury'}
                    </span>
                  )}
                  <span className="text-pool-600 text-lg">›</span>
                </div>
              </Link>
            )
          })}
        </div>
      )}

      {/* Bulk delete bar — sits above bottom nav */}
      {selecting && selected.size > 0 && (
        <div className="fixed bottom-20 left-0 right-0 px-4">
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="w-full bg-red-900 rounded-xl py-3 font-semibold text-sm text-red-100 shadow-lg"
            >
              Delete {selected.size} swimmer{selected.size !== 1 ? 's' : ''}
            </button>
          ) : (
            <div className="bg-red-900/30 border border-red-800/60 rounded-xl p-3 space-y-2 shadow-lg backdrop-blur">
              <p className="text-xs text-red-300 text-center">
                Permanently delete {selected.size} swimmer{selected.size !== 1 ? 's' : ''} and all their data?
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="flex-1 bg-pool-700 rounded-lg py-2.5 text-sm font-semibold"
                >
                  Cancel
                </button>
                <button
                  onClick={doDelete}
                  disabled={deleting}
                  className="flex-1 bg-red-900 disabled:opacity-40 rounded-lg py-2.5 text-sm font-semibold text-red-100"
                >
                  {deleting ? 'Deleting…' : 'Confirm Delete'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
