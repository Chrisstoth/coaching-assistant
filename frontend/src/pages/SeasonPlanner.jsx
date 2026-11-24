import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import HelpLink from '../components/HelpLink'
import { api } from '../api'
import { mountPlanner } from '../planner/plannerApp'
import '../planner/planner.css'

/* The coach's Season Planner, running inside the app (frontend/src/planner).
   It saves through the app, so the staff, the Session Builder and the load
   counter read the same plan. */
export default function SeasonPlanner() {
  const params = useParams()
  const navigate = useNavigate()
  const nav = useRef(navigate)
  nav.current = navigate
  const host = useRef(null)
  const [squads, setSquads] = useState(null)
  const [club, setClub] = useState(null)
  const [scales, setScales] = useState(null)
  const squad = params.squad || (squads && squads[0]) || 'Silver 1'

  // The rest of the app stops pinch-zoom (no accidental zoom at poolside); the season
  // chart is dense, so here a coach can pinch in. The app's setting comes back on leaving.
  useEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]')
    if (!meta) return
    const before = meta.getAttribute('content')
    meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes')
    return () => meta.setAttribute('content', before)
  }, [])

  useEffect(() => {
    api.getPlannerSquads().then(setSquads).catch(() => setSquads([]))
    api.getSessionPresentation().then(setClub).catch(() => setClub({}))
    // the club's intensity scales (Settings): the planner shows its focuses in them
    api.getBuilderSettings().then(setScales).catch(() => setScales({}))
  }, [])

  useEffect(() => {
    if (!squads || !club || !scales || !host.current) return
    const store = {
      getDocs: () => api.getPlannerDocs(squad),
      putDoc: (key, data) => api.putPlannerDoc(squad, key, data),
      listVersions: limit => api.getPlannerVersions(squad, limit),
      getVersion: id => api.getPlannerVersion(squad, id),
      deleteVersion: id => api.deletePlannerVersion(squad, id),
      addVersion: v => api.addPlannerVersion(squad, v),
    }
    const mark = (club.club_name || 'Plan').split(/\s+/).map(w => w[0]).join('').slice(0, 5).toUpperCase()
    const planner = mountPlanner(host.current, {
      store, squad, mark,
      scales: { usual: scales.effort_scale || 'effort20', standard: scales.standard || [], custom: scales.custom || [] },
      navigate: to => nav.current(to),
      // a session written for a week opens as its PDF, in a window of its own
      openPdf: id => window.open(`/sessions/${id}/print`, '_blank'),
      // the Meets tab's meets, and what actually happened (registers, cancelled and extra sessions,
      // usual sessions, time away, Right now notes), shared with the rest of the app
      api: {
        createMeet: data => api.createMeet(data),
        updateMeet: (id, data) => api.updateMeet(id, data),
        sessionsBetween: (from, to) => api.getSessions({ date_from: from, date_to: to, limit: 2000 }),
        actuals: (from, to) => api.getPlannerActuals(squad, from, to),
      },
    })
    return () => planner.destroy()
  }, [squads, club, scales, squad])

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
                className={`shrink-0 px-3 py-1.5 rounded text-xs font-semibold border ${s === squad ? 'bg-accent-600 border-accent-600 text-white' : 'border-pool-700 text-pool-400'}`}>
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
