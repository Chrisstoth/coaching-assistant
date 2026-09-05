import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'

const FILTERS = [
  ['active', 'Active'],
  ['failed', 'Needs attention'],
  ['completed', 'Completed'],
  ['all', 'All'],
]

function formatDate(value) {
  if (!value) return ''
  return new Date(value).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

function OperationCard({ item, onRetry, retrying }) {
  const statusStyle = {
    queued: 'bg-amber-900/40 text-amber-300',
    running: 'bg-blue-900/40 text-blue-300',
    completed: 'bg-teal-900/50 text-teal-300',
    failed: 'bg-red-900/40 text-red-300',
  }[item.status] || 'bg-pool-700 text-pool-300'

  return (
    <article className="rounded-2xl border border-pool-700 bg-pool-800 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-pool-100 leading-snug">{item.title}</h2>
          <p className="text-[11px] text-pool-500 mt-1">Operation #{item.id} · {item.execution_mode} · created {formatDate(item.created_at)}</p>
        </div>
        <span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide shrink-0 ${statusStyle}`}>
          {item.status}
        </span>
      </div>

      {item.status === 'queued' && (
        <p className="text-xs text-pool-400">
          {item.error ? `Retry ${item.attempts + 1} of ${item.max_attempts} is waiting.` : 'Waiting for the background worker.'}
        </p>
      )}
      {item.status === 'running' && <p className="text-xs text-blue-300">AI is working on this now. You can leave this screen.</p>}
      {item.result_summary && <p className="text-xs text-pool-300 leading-relaxed">{item.result_summary}</p>}
      {item.error && (
        <div className="rounded-xl border border-red-800/40 bg-red-950/25 px-3 py-2 text-xs text-red-300 leading-relaxed">
          {item.error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="text-[11px] text-pool-500">
          {item.status === 'completed' && `Finished ${formatDate(item.completed_at)}`}
          {item.status === 'running' && `Started ${formatDate(item.started_at)}`}
          {item.status === 'failed' && `${item.attempts} attempts made`}
        </div>
        <div className="flex items-center gap-3">
          {item.entity_type === 'session' && item.entity_id && (
            <Link to={`/sessions/${item.entity_id}`} className="text-xs text-accent-400">Open session</Link>
          )}
          {item.status === 'failed' && (
            <button
              onClick={() => onRetry(item.id)}
              disabled={retrying}
              className="rounded-lg bg-accent-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {retrying ? 'Queueing…' : 'Retry'}
            </button>
          )}
        </div>
      </div>
    </article>
  )
}

export default function AIOperations() {
  const [data, setData] = useState({ items: [], counts: {} })
  const [filter, setFilter] = useState('active')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retryingId, setRetryingId] = useState(null)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      setData(await api.getAIOperations())
      setError('')
    } catch (loadError) {
      setError(loadError.message)
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const hasActive = data.items.some(item => ['queued', 'running'].includes(item.status))
    if (!hasActive) return undefined
    const timer = window.setInterval(() => load(true), 3000)
    return () => window.clearInterval(timer)
  }, [data.items, load])

  const items = useMemo(() => data.items.filter(item => {
    if (filter === 'active') return ['queued', 'running'].includes(item.status)
    if (filter === 'failed') return item.status === 'failed'
    if (filter === 'completed') return item.status === 'completed'
    return true
  }), [data.items, filter])

  const retry = async id => {
    setRetryingId(id)
    try {
      await api.retryAIOperation(id)
      setFilter('active')
      await load(true)
    } catch (retryError) {
      setError(retryError.message)
    } finally {
      setRetryingId(null)
    }
  }

  return (
    <div className="p-4 space-y-4 pb-8">
      <header className="pt-2 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-accent-400">Background work</p>
          <h1 className="text-xl font-bold tracking-tight mt-0.5">AI Operations</h1>
          <p className="text-xs text-pool-500 mt-1 leading-relaxed">See what AI is waiting for, working on, or could not finish.</p>
        </div>
        <button onClick={() => load()} disabled={loading} className="rounded-xl border border-pool-700 bg-pool-800 px-3 py-2 text-xs text-pool-300 disabled:opacity-50">
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </header>

      <div className="grid grid-cols-4 gap-2">
        {[
          ['queued', 'Waiting', 'text-amber-300'],
          ['running', 'Running', 'text-blue-300'],
          ['completed', 'Done', 'text-teal-300'],
          ['failed', 'Failed', 'text-red-300'],
        ].map(([key, label, colour]) => (
          <div key={key} className="rounded-xl border border-pool-700 bg-pool-800 px-2 py-2.5 text-center">
            <p className={`text-lg font-bold ${colour}`}>{data.counts?.[key] || 0}</p>
            <p className="text-[9px] uppercase tracking-wide text-pool-500">{label}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-pool-700/70 bg-pool-800/60 px-3.5 py-3 text-xs text-pool-400 leading-relaxed">
        Registers save before their AI work begins. Live chat and other responses you are actively waiting for still run in the foreground.
      </div>

      <div className="flex gap-1 overflow-x-auto">
        {FILTERS.map(([key, label]) => (
          <button key={key} onClick={() => setFilter(key)} className={`shrink-0 rounded-lg px-3 py-1.5 text-xs ${filter === key ? 'bg-accent-600 text-white' : 'border border-pool-700 bg-pool-800 text-pool-400'}`}>
            {label}
          </button>
        ))}
      </div>

      {error && <div className="rounded-xl border border-red-800/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">{error}</div>}
      {!loading && items.length === 0 && (
        <div className="rounded-2xl border border-dashed border-pool-700 px-5 py-8 text-center">
          <p className="text-sm font-medium text-pool-300">No {filter === 'all' ? '' : filter} operations</p>
          <p className="text-xs text-pool-500 mt-1">New background AI work will appear here automatically.</p>
        </div>
      )}
      <div className="space-y-3">
        {items.map(item => <OperationCard key={item.id} item={item} onRetry={retry} retrying={retryingId === item.id} />)}
      </div>
    </div>
  )
}
