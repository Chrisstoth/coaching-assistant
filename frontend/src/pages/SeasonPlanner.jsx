import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import HelpLink from '../components/HelpLink'
import { api } from '../api'
import { mountPlanner } from '../planner/plannerApp'
import '../planner/planner.css'

/* The coach's Season Planner, running inside the app (frontend/src/planner).
   It saves through the app, so the staff, the Session Builder and the load
   counter read the same plan. */
export default function SeasonPlanner() {
  const params = useParams()
  const host = useRef(null)
  const [squads, setSquads] = useState(null)
  const [club, setClub] = useState(null)
  const squad = params.squad || (squads && squads[0]) || 'Silver 1'

  useEffect(() => {
    api.getPlannerSquads().then(setSquads).catch(() => setSquads([]))
    api.getSessionPresentation().then(setClub).catch(() => setClub({}))
  }, [])

  useEffect(() => {
    if (!squads || !club || !host.current) return
    const store = {
      getDocs: () => api.getPlannerDocs(squad),
      putDoc: (key, data) => api.putPlannerDoc(squad, key, data),
      listVersions: limit => api.getPlannerVersions(squad, limit),
      getVersion: id => api.getPlannerVersion(squad, id),
      deleteVersion: id => api.deletePlannerVersion(squad, id),
      addVersion: v => api.addPlannerVersion(squad, v),
    }
    const mark = (club.club_name || 'Plan').split(/\s+/).map(w => w[0]).join('').slice(0, 5).toUpperCase()
    const planner = mountPlanner(host.current, { store, squad, mark })
    return () => planner.destroy()
  }, [squads, club, squad])

  return (
    <div className="min-h-full">
      <div className="px-4 pt-2 space-y-2 max-w-[1600px] mx-auto">
        <div className="flex items-center justify-between gap-3">
          <Link to="/plan" className="inline-flex items-center text-xs text-pool-400 hover:text-pool-200">‹ Plan</Link>
          <HelpLink topic="swimmers" label="Swimmers, groups and the plan" />
        </div>
        {squads && squads.length > 1 && (
          <div className="flex gap-2 overflow-x-auto">
            {squads.map(s => (
              <Link key={s} to={`/season/${encodeURIComponent(s)}`} style={{ minHeight: 0 }}
                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${s === squad ? 'bg-accent-600 border-accent-600 text-white' : 'border-pool-700 text-pool-400'}`}>
                {s}
              </Link>
            ))}
          </div>
        )}
      </div>
      {!squads && <p className="p-4 text-sm text-pool-400">Opening the season plan…</p>}
      <div ref={host} />
      <p className="px-4 pb-6 text-xs text-pool-500 max-w-[1600px] mx-auto">
        <Link to="/season/classic" className="underline" style={{ minHeight: 0 }}>Older season planning</Link>
      </p>
    </div>
  )
}
