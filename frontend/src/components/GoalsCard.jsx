import { useEffect, useState } from 'react'
import { api } from '../api'

// A swimmer's goals. One list: the same goals the Season Planner shows (with a
// star on their line for a goal tied to a meet) and the athlete plan prints.

export function parseTime(text) {
  const t = String(text || '').trim()
  if (!t) return null
  const parts = t.split(':')
  const v = parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : Number(t)
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : NaN
}

// A goal for a plan's dates: one with no date that is still open, or one dated inside them.
export function inPeriod(goal, from, to) {
  if (!goal.deadline) return !goal.achieved
  return (!from || goal.deadline >= from) && (!to || goal.deadline <= to)
}

function shortDate(iso) {
  if (!iso) return ''
  return new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

const BLANK = { text: '', event: '', target: '', course: 'SC', meet_id: '', deadline: '', achieved: false }

function formFrom(goal) {
  return {
    text: goal.text || '', event: goal.event || '', target: goal.target || '', course: goal.course || 'SC',
    meet_id: goal.meet_id ? String(goal.meet_id) : '', deadline: goal.meet_id ? '' : (goal.deadline || ''),
    achieved: Boolean(goal.achieved),
  }
}

const input = 'bg-pool-700 border border-pool-600 rounded-lg px-2 py-2 text-sm text-pool-100 focus:border-accent-500 focus:outline-none'

function GoalForm({ goal, options, onSave, onCancel, onRemove, busy }) {
  const [f, setF] = useState(goal ? formFrom(goal) : BLANK)
  const [error, setError] = useState('')
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))
  const meet = options.meets.find(m => String(m.id) === f.meet_id)
  const others = options.all_events.filter(e => !options.events.includes(e))
  // An old goal may name an event that's in neither list: keep it on offer.
  const extra = f.event && !options.events.includes(f.event) && !others.includes(f.event) ? [f.event] : []

  const save = () => {
    const target = parseTime(f.target)
    if (Number.isNaN(target)) { setError('Write the target time as 26.31 or 1:02.45'); return }
    if (!f.text.trim() && !f.event) { setError('Say what the goal is, or pick an event'); return }
    setError('')
    onSave({
      text: f.text.trim(), event: f.event || null, target_time_seconds: target,
      course: meet?.course || f.course, meet_id: f.meet_id ? Number(f.meet_id) : null,
      deadline: f.meet_id ? null : (f.deadline || null), achieved: f.achieved,
    })
  }

  return (
    <div className="bg-pool-700/50 rounded-xl p-3 space-y-2">
      <input value={f.text} onChange={e => set('text', e.target.value)} autoFocus
        placeholder="e.g. Sub 28.0 in 50 Fly, or 10m underwater off every wall"
        className={`w-full ${input}`} />
      <div className="grid grid-cols-3 gap-2">
        <select value={f.event} onChange={e => set('event', e.target.value)} aria-label="Event" className={`col-span-2 min-w-0 ${input}`}>
          <option value="">No event</option>
          {options.events.length > 0 && <optgroup label="Their events">{options.events.map(e => <option key={e} value={e}>{e}</option>)}</optgroup>}
          <optgroup label={options.events.length ? 'Other events' : 'Events'}>{[...extra, ...others].map(e => <option key={e} value={e}>{e}</option>)}</optgroup>
        </select>
        <input value={f.target} onChange={e => set('target', e.target.value)} placeholder="Target" inputMode="decimal"
          aria-label="Target time" className={`min-w-0 font-mono ${input}`} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <select value={f.meet_id} onChange={e => set('meet_id', e.target.value)} aria-label="By meet" className={`col-span-2 min-w-0 ${input}`}>
          <option value="">Any time / by a date</option>
          {options.meets.map(m => <option key={m.id} value={m.id}>By {m.name} · {shortDate(m.date)}</option>)}
        </select>
        <select value={meet?.course || f.course} onChange={e => set('course', e.target.value)} disabled={Boolean(meet?.course)}
          title={meet?.course ? 'Set by the meet' : undefined} aria-label="Course" className={`min-w-0 disabled:opacity-60 ${input}`}>
          <option value="SC">SC</option>
          <option value="LC">LC</option>
        </select>
      </div>
      {!f.meet_id && (
        <label className="flex items-center gap-2 text-xs text-pool-400">
          By
          <input type="date" value={f.deadline} onChange={e => set('deadline', e.target.value)} className={`flex-1 min-w-0 ${input}`} />
        </label>
      )}
      <label className="flex items-center gap-2 text-sm text-pool-200">
        <input type="checkbox" checked={f.achieved} onChange={e => set('achieved', e.target.checked)} /> Achieved
      </label>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2 items-center">
        {onRemove && (
          <button onClick={onRemove} disabled={busy} className="text-xs text-red-400 mr-auto">Remove</button>
        )}
        <button onClick={onCancel} className="px-3 py-2 text-sm text-pool-400 ml-auto">Cancel</button>
        <button onClick={save} disabled={busy} className="px-4 py-2 text-sm font-semibold bg-accent-600 rounded-lg disabled:opacity-40">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export function GoalLine({ goal, muted }) {
  const good = goal.achieved || /already under/.test(goal.status || '')
  return (
    <div className={`min-w-0 ${muted ? 'opacity-50' : ''}`}>
      <p className={`text-sm font-medium ${goal.achieved ? 'line-through text-pool-400' : 'text-pool-100'}`}>{goal.label}</p>
      <p className="text-xs text-pool-400">
        {[goal.race && goal.race !== goal.label ? goal.race : '',
          goal.meet_name ? `by ${goal.meet_name}${goal.meet_date ? ` · ${shortDate(goal.meet_date)}` : ''}` : goal.deadline ? `by ${shortDate(goal.deadline)}` : '',
        ].filter(Boolean).join(' · ')}
      </p>
      {goal.status && <p className={`text-xs ${good ? 'text-green-400' : 'text-pool-500'}`}>{goal.status}</p>}
      {goal.description && <p className="text-xs text-pool-500 italic">{goal.description}</p>}
    </div>
  )
}

export default function GoalsCard({ swimmerId, firstName, period, onChanged }) {
  const [data, setData] = useState(null)
  const [editing, setEditing] = useState(null)       // a goal id, or 'new'
  const [busy, setBusy] = useState(false)

  const load = () => api.getGoals(swimmerId).then(setData).catch(() => setData({ goals: [], events: [], all_events: [], meets: [] }))
  useEffect(() => { load() }, [swimmerId])

  const act = async (fn) => {
    setBusy(true)
    try {
      await fn()
      await load()
      setEditing(null)
      onChanged?.()
    } catch (e) {
      alert('Could not save the goal: ' + e.message)
    }
    setBusy(false)
  }

  const goals = data?.goals || []
  const open = goals.filter(g => !g.achieved).length

  return (
    <section className="bg-pool-800 rounded-xl p-4 space-y-3">
      <div className="flex justify-between items-center gap-2">
        <h3 className="font-semibold text-sm text-accent-400">
          Goals{open ? <span className="text-pool-500 font-normal"> · {open} open</span> : null}
        </h3>
        {editing !== 'new' && data && (
          <button onClick={() => setEditing('new')} className="text-xs text-accent-400 hover:text-accent-200">+ Add goal</button>
        )}
      </div>

      {data === null && <p className="text-xs text-pool-500">Loading…</p>}

      {editing === 'new' && (
        <GoalForm options={data} busy={busy} onCancel={() => setEditing(null)}
          onSave={body => act(() => api.createGoal({ swimmer_id: swimmerId, ...body }))} />
      )}

      {data && goals.length === 0 && editing !== 'new' && (
        <p className="text-xs text-pool-500">
          No goals yet. A goal tied to a meet puts a star on {firstName ? `${firstName}'s` : 'their'} line in the Season Planner,
          and goals print on the athlete plan.
        </p>
      )}

      <div className="space-y-1.5">
        {goals.map(g => editing === g.id ? (
          <GoalForm key={g.id} goal={g} options={data} busy={busy} onCancel={() => setEditing(null)}
            onSave={body => act(() => api.updateGoal(g.id, body))}
            onRemove={() => { if (window.confirm('Remove this goal? It goes from the Season Planner too.')) act(() => api.deleteGoal(g.id)) }} />
        ) : (
          <div key={g.id} className={`flex items-start gap-2 rounded-lg px-3 py-2 ${g.achieved ? 'bg-green-900/20' : 'bg-pool-700/40'}`}>
            <div className="flex-1 min-w-0">
              <GoalLine goal={g} muted={period && !inPeriod(g, period.from, period.to)} />
              {period && !inPeriod(g, period.from, period.to) && (
                <p className="text-[11px] text-pool-500">Not in this plan's dates, so not printed on it</p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!g.achieved && (
                <button onClick={() => act(() => api.updateGoal(g.id, { achieved: true }))} disabled={busy}
                  title="Mark achieved" aria-label="Mark achieved"
                  className="text-xs text-green-400 border border-green-800 rounded px-2 py-0.5">✓</button>
              )}
              <button onClick={() => setEditing(g.id)} className="text-xs text-pool-400 hover:text-pool-200">Edit</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
