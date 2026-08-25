import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { setToken } from '../api'
import { LaneWatchLockup } from '../components/LaneWatchBrand'

export default function Login() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.status === 401) { setError('Incorrect password'); return }
      if (!res.ok) { setError('Something went wrong'); return }
      const data = await res.json()
      setToken(data.token)
      navigate('/', { replace: true })
    } catch {
      setError('Could not reach server')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen brand-canvas flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-8">
        <LaneWatchLockup />

        <form onSubmit={submit} className="space-y-4">
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoFocus
            className="w-full bg-pool-800 border border-pool-600 rounded-xl px-4 py-3 text-sm text-pool-100 placeholder-pool-500 focus:border-accent-500 focus:outline-none"
          />
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <button
            type="submit"
            disabled={loading || !password}
            className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-3 text-sm font-semibold text-white"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
