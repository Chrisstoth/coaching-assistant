import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { getToken, setToken } from './api'
import { LaneWatchLockup } from './components/LaneWatchBrand'
import './index.css'

function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        setError('Incorrect password')
        setLoading(false)
        return
      }
      const { token } = await res.json()
      setToken(token)
      onLogin()
    } catch {
      setError('Could not reach server')
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 brand-canvas flex flex-col items-center justify-center px-8 gap-10">
      <LaneWatchLockup />
      <form onSubmit={submit} className="w-full max-w-xs space-y-3">
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="w-full bg-pool-800 border border-pool-600 rounded-xl px-4 py-3 text-sm text-center focus:outline-none focus:border-accent-500"
        />
        {error && <p className="text-red-400 text-xs text-center">{error}</p>}
        <button
          type="submit"
          disabled={loading || !password}
          className="w-full bg-accent-600 disabled:opacity-50 rounded-xl py-3 text-sm font-semibold"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

function Root() {
  const [splash, setSplash] = useState(true)
  const [authed, setAuthed] = useState(false)

  useEffect(() => {
    if (getToken() || window.location.hostname === 'localhost') setAuthed(true)
    const t = setTimeout(() => setSplash(false), 1500)
    return () => clearTimeout(t)
  }, [])

  if (splash) {
    return (
      <div className="fixed inset-0 brand-canvas flex items-center justify-center">
        <LaneWatchLockup />
      </div>
    )
  }

  if (!authed) {
    return <LoginScreen onLogin={() => setAuthed(true)} />
  }

  return (
    <BrowserRouter>
      <App />
    </BrowserRouter>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
