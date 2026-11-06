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
      <div className="flex items-center justify-between gap-3 px-4 py-2 bg-pool-900 border-b border-pool-800 text-xs">
        <Link to="/plan" className="text-pool-400">‹ Plan</Link>
        <span className="text-pool-500 truncate">
          {squads && squads.length > 1 && squads.map(s => <Link key={s} to={`/season/${encodeURIComponent(s)}`} className={`ml-2 ${s === squad ? 'text-pool-100 font-semibold' : 'text-accent-400'}`}>{s}</Link>)}
          <Link to="/season/classic" className="ml-3 text-pool-500 underline">Older season planning</Link>
          <HelpLink topic="swimmers" label="Swimmers, groups and the plan" className="ml-3 align-middle" />
        </span>
      </div>
      {!squads && <p className="p-4 text-sm text-pool-400">Opening the season plan…</p>}
      <div ref={host} />
    </div>
  )
}
