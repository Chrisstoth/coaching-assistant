import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import SquadGroups from '../components/SquadGroups'

function profileStatusFor(swimmer) {
  return swimmer.profile_status || {
    state: swimmer.has_profile ? 'complete' : 'not_started',
    completed_areas: swimmer.has_profile ? 9 : 0,
    total_areas: 9,
    living_built: 0,
  }
}

export default function Swimmers() {
  const [swimmers, setSwimmers] = useState([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showNoProfile, setShowNoProfile] = useState(true)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'groups' ? 'groups' : 'swimmers'
  const setView = (next) => setParams(next === 'groups' ? { view: 'groups' } : {}, { replace: true })

  useEffect(() => {
    api.getSwimmers({ active_only: false }).then(sw => {
      setSwimmers(sw)
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
        {view === 'groups' ? null : selecting ? (
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

      <div className="flex bg-pool-800 rounded-xl p-1 text-sm" role="tablist">
        {[['swimmers', 'Swimmers'], ['groups', 'Groups']].map(([key, label]) => (
          <button key={key} role="tab" aria-selected={view === key} onClick={() => { clearSelect(); setView(key) }}
            className={`flex-1 rounded-lg py-1.5 font-medium transition-colors ${
              view === key ? 'bg-pool-600 text-pool-100' : 'text-pool-400'}`}>
            {label}
          </button>
        ))}
      </div>

      {view === 'groups' ? <SquadGroups /> : (<>
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

      {/* Foundation profile progress */}
      {!loading && !selecting && (() => {
        const noProfile = swimmers.filter(s => s.active && profileStatusFor(s).state !== 'complete')
        if (noProfile.length === 0) return null
        return (
          <div className="bg-amber-900/20 border border-amber-700/40 rounded-xl overflow-hidden">
            <button
              onClick={() => setShowNoProfile(p => !p)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-left"
            >
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                <span className="text-xs font-semibold text-amber-300">
                  {noProfile.length} foundation profile{noProfile.length !== 1 ? 's' : ''} need attention
                </span>
              </div>
              <svg
                className={`w-4 h-4 text-amber-500 transition-transform ${showNoProfile ? 'rotate-180' : ''}`}
                fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            {showNoProfile && (
              <div className="px-4 pb-3 space-y-1.5">
                <p className="text-xs text-pool-400 pb-1">
                  Finish the one-off coaching foundation. Race, training and technical profiles keep developing afterwards.
                </p>
                {noProfile.map(s => {
                  const status = profileStatusFor(s)
                  return (
                    <div key={s.id} className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs text-pool-300 truncate">{s.name}</p>
                        <p className="text-[10px] text-pool-500">
                          {status.completed_areas}/{status.total_areas} foundation areas
                          {status.living_built > 0 ? ` · ${status.living_built} living section${status.living_built !== 1 ? 's' : ''}` : ''}
                        </p>
                      </div>
                      <button
                        onClick={() => navigate(`/swimmers/${s.id}/profile-wizard`)}
                        className="text-xs text-accent-400 hover:text-accent-300 font-medium shrink-0"
                      >
                        {status.state === 'not_started' ? 'Build foundation' : 'Continue'} →
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })()}

      {loading ? (
        <p className="text-pool-400 text-sm">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-pool-400 text-sm">No swimmers found.</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((s) => {
            const profileStatus = profileStatusFor(s)
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
                  {/* A complete profile can still be well behind the record,
                      so staleness shows even when completeness does not. */}
                  {s.active && profileStatus.stale && (
                    <span
                      className="text-[10px] rounded-full px-2 py-0.5 shrink-0 bg-amber-900/50 text-amber-300"
                      title={`${profileStatus.observations_since_profile} observations recorded since the profile was built`}
                    >
                      +{profileStatus.observations_since_profile} obs
                    </span>
                  )}
                  {s.active && profileStatus.state !== 'complete' && (
                    <span
                      className={`text-[10px] rounded-full px-2 py-0.5 shrink-0 ${
                        profileStatus.state === 'in_progress'
                          ? 'bg-amber-900/50 text-amber-300'
                          : 'bg-pool-700 text-pool-400'
                      }`}
                      title={(profileStatus.missing_areas || []).join(', ')}
                    >
                      {profileStatus.state === 'in_progress'
                        ? `Profile ${profileStatus.completed_areas}/${profileStatus.total_areas}`
                        : 'No foundation'}
                    </span>
                  )}
                  <span className="text-pool-600 text-lg">›</span>
                </div>
              </Link>
            )
          })}
        </div>
      )}

      </>)}

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
