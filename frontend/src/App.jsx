import { useCallback, useEffect, useState } from 'react'
import { Routes, Route, NavLink, Link, Navigate, useLocation } from 'react-router-dom'
import { api, getToken } from './api'
import { getOfflineSaveCount, subscribeToOfflineQueue } from './offlineQueue'
import Dashboard from './pages/Dashboard'
import Swimmers from './pages/Swimmers'
import SwimmerDetail from './pages/SwimmerDetail'
import NewSwimmer from './pages/NewSwimmer'
import Sessions from './pages/Sessions'
import SessionDetail from './pages/SessionDetail'
import Register from './pages/Register'
import Meets from './pages/Meets'
import MeetDetail from './pages/MeetDetail'
import Import from './pages/Import'
import Schedule from './pages/Schedule'
import Calendar from './pages/Calendar'
import CoachingContext from './pages/CoachingContext'
import SessionPlanner from './pages/SessionPlanner'
import PlanHub from './pages/PlanHub'
import CoachAI from './pages/CoachAI'
import Settings from './pages/Settings'
import SeasonPlan from './pages/SeasonPlan'
import SessionPrint from './pages/SessionPrint'
import Login from './pages/Login'
import ProfileWizard from './pages/ProfileWizard'
import AssistantInbox from './pages/AssistantInbox'
import TodaySession from './pages/TodaySession'
import SessionPresentationSettings from './pages/SessionPresentationSettings'
import CoachCheckIns from './pages/CoachCheckIns'
import CoachCheckIn from './pages/CoachCheckIn'
import AIOperations from './pages/AIOperations'
import SessionDebrief from './pages/SessionDebrief'
import { LaneWatchAIButton, LaneWatchWordmark } from './components/LaneWatchBrand'
import { SessionPresentationProvider } from './components/SessionPresentationProvider'

function RequireAuth({ children }) {
  return getToken() ? children : <Navigate to="/login" replace />
}

function useBackendStatus() {
  const [status, setStatus] = useState('checking') // checking | online | slow

  useEffect(() => {
    const slow = setTimeout(() => setStatus('slow'), 2000)
    fetch('/api/health')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(() => { clearTimeout(slow); setStatus('online') })
      .catch(() => { clearTimeout(slow); setStatus('slow') })
  }, [])

  return status
}

function StartupBanner({ status }) {
  if (status !== 'slow') return null
  return (
    <div className="fixed top-12 left-0 right-0 z-40 px-4 pt-2">
      <div className="max-w-lg mx-auto bg-pool-800/95 backdrop-blur border border-pool-600 rounded-xl px-4 py-2.5 flex items-center gap-3">
        <svg className="w-4 h-4 text-accent-400 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
        </svg>
        <div>
          <p className="text-xs font-medium text-pool-200">Starting up…</p>
          <p className="text-[11px] text-pool-500">Server wakes from sleep — takes ~30 seconds</p>
        </div>
      </div>
    </div>
  )
}

function useOfflineSync() {
  const [state, setState] = useState(() => ({
    online: navigator.onLine,
    pending: getOfflineSaveCount(),
    syncing: false,
    error: null,
  }))

  const sync = useCallback(async () => {
    const pending = getOfflineSaveCount()
    if (!getToken() || !navigator.onLine || pending === 0) {
      setState(s => ({ ...s, online: navigator.onLine, pending }))
      return
    }
    setState(s => ({ ...s, online: true, pending, syncing: true, error: null }))
    try {
      const result = await api.flushOfflineSaves()
      setState({ online: navigator.onLine, pending: result.pending_count, syncing: false, error: null })
    } catch (error) {
      setState({ online: navigator.onLine, pending: getOfflineSaveCount(), syncing: false, error: error.message })
    }
  }, [])

  useEffect(() => {
    const refreshCount = () => setState(s => ({ ...s, pending: getOfflineSaveCount() }))
    const handleOffline = () => setState(s => ({ ...s, online: false }))
    const handleOnline = () => { setState(s => ({ ...s, online: true })); sync() }
    const unsubscribe = subscribeToOfflineQueue(refreshCount)
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    const timer = window.setInterval(() => {
      if (getOfflineSaveCount() > 0 && navigator.onLine) sync()
    }, 30000)
    sync()
    return () => {
      unsubscribe()
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
      window.clearInterval(timer)
    }
  }, [sync])

  return { ...state, retry: sync }
}

function OfflineSyncBanner({ state }) {
  if (state.online && state.pending === 0 && !state.syncing && !state.error) return null
  const message = !state.online
    ? state.pending > 0
      ? `Offline — ${state.pending} poolside save${state.pending === 1 ? '' : 's'} waiting to sync`
      : 'Offline — register changes will be saved on this device'
    : state.syncing
      ? `Syncing ${state.pending} saved change${state.pending === 1 ? '' : 's'}…`
      : state.error
        ? `Could not sync ${state.pending} saved change${state.pending === 1 ? '' : 's'} — will retry`
        : `${state.pending} saved change${state.pending === 1 ? '' : 's'} waiting to sync`

  return (
    <div className="fixed top-24 left-0 right-0 z-40 px-4">
      <div className="max-w-lg mx-auto bg-amber-950/95 border border-amber-700/60 rounded-xl px-4 py-2.5 text-xs text-amber-200 shadow-lg flex items-center gap-3">
        <span className="flex-1">{message}</span>
        {state.online && state.pending > 0 && !state.syncing && (
          <button onClick={state.retry} className="rounded-lg bg-amber-800/60 px-2.5 py-1.5 font-semibold text-amber-100 shrink-0">Retry now</button>
        )}
      </div>
    </div>
  )
}

// Pages where the bottom nav should be hidden (full-screen flows)
const HIDE_NAV_PATHS = ['/sessions/', '/swimmers/new']

function useHideNav() {
  const loc = useLocation()
  return HIDE_NAV_PATHS.some(p => loc.pathname.startsWith(p) && loc.pathname !== '/sessions')
    || loc.pathname.startsWith('/swimmers/') && loc.pathname !== '/swimmers'
}

function AppHeader() {
  const location = useLocation()
  const isSettings = location.pathname === '/settings'
  const isInbox = location.pathname === '/assistant'
  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-pool-900/95 backdrop-blur border-b border-white/10">
      <div className="flex items-center justify-between max-w-lg mx-auto px-4 h-12">
        <Link to="/" className="flex items-center" aria-label="LaneWatch AI home">
          <LaneWatchWordmark />
        </Link>
        <div className="flex items-center gap-1">
          <Link to="/assistant" className={`p-1.5 rounded-lg transition-colors ${isInbox ? 'text-accent-400' : 'text-pool-400 hover:text-pool-200'}`} aria-label="Assistant inbox">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
          </Link>
          <Link
            to={isSettings ? '/' : '/settings'}
            className={`p-1.5 rounded-lg transition-colors ${isSettings ? 'text-accent-400' : 'text-pool-400 hover:text-pool-200'}`}
            aria-label="Settings"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            </svg>
          </Link>
        </div>
      </div>
    </header>
  )
}

function BottomNav() {
  const hide = useHideNav()
  if (hide) return null

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-pool-900/95 backdrop-blur border-t border-pool-700/60 safe-bottom">
      <div className="flex items-end justify-around max-w-lg mx-auto px-2 h-16">

        <NavLink to="/" end className={({ isActive }) =>
          `flex flex-col items-center gap-0.5 py-2 px-3 text-xs font-medium transition-colors ${isActive ? 'text-accent-400' : 'text-pool-500 hover:text-pool-300'}`
        }>
          {({ isActive }) => (<><HomeIcon active={isActive} /><span>Today</span></>)}
        </NavLink>

        <NavLink to="/swimmers" className={({ isActive }) =>
          `flex flex-col items-center gap-0.5 py-2 px-3 text-xs font-medium transition-colors ${isActive ? 'text-accent-400' : 'text-pool-500 hover:text-pool-300'}`
        }>
          {({ isActive }) => (<><SquadIcon active={isActive} /><span>Squad</span></>)}
        </NavLink>

        {/* LaneWatch family mark, adapted as the raised AI entry point. */}
        <NavLink to="/ai" className="flex flex-col items-center -mt-6" aria-label="Open LaneWatch AI">
          {({ isActive }) => (
            <LaneWatchAIButton active={isActive} />
          )}
        </NavLink>

        <NavLink to="/plan" className={({ isActive }) =>
          `flex flex-col items-center gap-0.5 py-2 px-3 text-xs font-medium transition-colors ${isActive ? 'text-accent-400' : 'text-pool-500 hover:text-pool-300'}`
        }>
          {({ isActive }) => (<><SessionsIcon active={isActive} /><span>Plan</span></>)}
        </NavLink>

        <NavLink to="/meets" className={({ isActive }) =>
          `flex flex-col items-center gap-0.5 py-2 px-3 text-xs font-medium transition-colors ${isActive ? 'text-accent-400' : 'text-pool-500 hover:text-pool-300'}`
        }>
          {({ isActive }) => (<><MeetsIcon active={isActive} /><span>Meets</span></>)}
        </NavLink>

      </div>
    </nav>
  )
}

export default function App() {
  const backendStatus = useBackendStatus()
  const offlineSync = useOfflineSync()
  return (
    <SessionPresentationProvider>
    <div className="flex flex-col min-h-screen max-w-lg mx-auto">
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/sessions/:id/print" element={<RequireAuth><SessionPrint /></RequireAuth>} />
        <Route path="*" element={
          <RequireAuth>
            <AppHeader />
            <StartupBanner status={backendStatus} />
            <OfflineSyncBanner state={offlineSync} />
            <main className="flex-1 overflow-y-auto pb-20 pt-12">
              <Routes>
                <Route path="/" element={<Dashboard />} />
          <Route path="/today-session" element={<TodaySession />} />
          <Route path="/swimmers" element={<Swimmers />} />
          <Route path="/swimmers/new" element={<NewSwimmer />} />
          <Route path="/swimmers/:id" element={<SwimmerDetail />} />
          <Route path="/swimmers/:id/profile-wizard" element={<ProfileWizard />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/sessions/:id/register" element={<Register />} />
          <Route path="/debrief" element={<SessionDebrief />} />
          <Route path="/debrief/:id" element={<SessionDebrief />} />
          <Route path="/meets" element={<Meets />} />
          <Route path="/meets/:id" element={<MeetDetail />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/import" element={<Import />} />
          <Route path="/context" element={<CoachingContext />} />
          <Route path="/coach-checkins" element={<CoachCheckIns />} />
          <Route path="/coach-checkins/:id" element={<CoachCheckIn />} />
          <Route path="/ai" element={<CoachAI />} />
          <Route path="/plan" element={<PlanHub />} />
          <Route path="/session-planner" element={<SessionPlanner />} />
          <Route path="/season" element={<SeasonPlan />} />
                <Route path="/assistant" element={<AssistantInbox />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/ai-operations" element={<AIOperations />} />
                <Route path="/settings/session-presentation" element={<SessionPresentationSettings />} />
              </Routes>
            </main>
            <BottomNav />
          </RequireAuth>
        } />
      </Routes>
    </div>
    </SessionPresentationProvider>
  )
}

// ---- Icons ----

function HomeIcon({ active }) {
  return (
    <svg className={`w-6 h-6 ${active ? 'text-accent-400' : 'text-pool-500'}`} fill="none" viewBox="0 0 24 24" strokeWidth={active ? 2 : 1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
    </svg>
  )
}

function SquadIcon({ active }) {
  return (
    <svg className={`w-6 h-6 ${active ? 'text-accent-400' : 'text-pool-500'}`} fill="none" viewBox="0 0 24 24" strokeWidth={active ? 2 : 1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
    </svg>
  )
}

function SessionsIcon({ active }) {
  return (
    <svg className={`w-6 h-6 ${active ? 'text-accent-400' : 'text-pool-500'}`} fill="none" viewBox="0 0 24 24" strokeWidth={active ? 2 : 1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z" />
    </svg>
  )
}

function MeetsIcon({ active }) {
  return (
    <svg className={`w-6 h-6 ${active ? 'text-accent-400' : 'text-pool-500'}`} fill="none" viewBox="0 0 24 24" strokeWidth={active ? 2 : 1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 0 1 3 3h-15a3 3 0 0 1 3-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 0 1-.982-3.172M9.497 14.25a7.454 7.454 0 0 0 .981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 0 0 7.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 0 0 2.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 0 1 2.916.52 6.003 6.003 0 0 1-5.395 4.972m0 0a6.726 6.726 0 0 1-2.749 1.35m0 0a6.772 6.772 0 0 1-3.044 0" />
    </svg>
  )
}
