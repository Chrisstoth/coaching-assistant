import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, getToken } from '../api'
import { readCallback } from '../laneWatch'

// Where LaneWatch sends the coach back after "Connect with LaneWatch". On a
// phone this can open outside the app's signed-in view, so it works without
// being signed in here: the server only finishes an attempt it started.
export default function LaneWatchCallback() {
  const [result, setResult] = useState({ state: 'working' })
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    const answer = readCallback(window.location.search)
    // The code is single-use, but keep it out of the address bar and history.
    window.history.replaceState(null, '', window.location.pathname)
    if (!answer.state) {
      setResult({ state: 'failed', message: 'This page was opened without a LaneWatch answer. Start connecting again from Settings.' })
      return
    }
    api.finishLaneWatchConnect(answer)
      .then(body => setResult({ state: 'connected', connectedAs: body.connected_as }))
      .catch(error => setResult({ state: 'failed', message: error.message }))
  }, [])

  const signedIn = Boolean(getToken())

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-pool-800 border border-pool-700 rounded-xl p-5 space-y-3 text-center">
        <h1 className="text-base font-semibold text-pool-100">LaneWatch</h1>
        {result.state === 'working' && <p className="text-sm text-pool-400">Connecting LaneWatch…</p>}
        {result.state === 'connected' && (
          <p className="text-sm text-pool-200">
            Connected{result.connectedAs ? ` as ${result.connectedAs}` : ''}. The Performance Analyst can now read
            your swimmers&apos; race analysis.
          </p>
        )}
        {result.state === 'failed' && <p className="text-sm text-red-300">{result.message}</p>}
        {result.state !== 'working' && (signedIn ? (
          <Link to="/settings" replace className="block w-full py-2.5 text-sm font-semibold bg-accent-600 rounded-xl">
            {result.state === 'connected' ? 'Pair your swimmers' : 'Back to Settings'}
          </Link>
        ) : (
          <p className="text-xs text-pool-500">You can close this page and go back to the app.</p>
        ))}
      </div>
    </div>
  )
}
