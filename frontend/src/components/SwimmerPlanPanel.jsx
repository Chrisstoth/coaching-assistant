import { useEffect, useState } from 'react'
import { api } from '../api'
import { staffStyle } from '../staffRoom'
import StaffAvatar from './StaffAvatar'
import { AUDIENCE_LABELS, gapsToFill } from '../swimmerPlan'

// An athlete plan for one swimmer: what we're working towards, what we're
// working on, and how we plan to do it. The staff draft each section from the
// swimmer's real data; the coach edits, redrafts, switches sections off, and
// marks it final. Final plans are kept as they were.

function SectionEditor({ plan, section, onPlan, locked }) {
  const style = section.role === 'coach' ? { title: 'You', initials: 'You', colour: '#6b7280' } : staffStyle(section.role)
  const [text, setText] = useState(section.content || '')
  const [asking, setAsking] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { setText(section.content || '') }, [section.content])

  const save = async (changes) => {
    try {
      onPlan(await api.updateSwimmerPlan(plan.id, { sections: [{ key: section.key, ...changes }] }))
    } catch (e) {
      alert('Could not save: ' + e.message)
    }
  }

  const redraft = async () => {
    setBusy(true)
    try {
      onPlan(await api.redraftPlanSection(plan.id, section.key, instruction.trim() || null))
      setInstruction('')
      setAsking(false)
    } catch (e) {
      alert('Could not redraft: ' + e.message)
    }
    setBusy(false)
  }

  if (locked) {
    if (!section.included || !String(section.content || '').trim()) return null
    return (
      <div className="bg-pool-800 rounded-xl p-3 space-y-1">
        <p className="text-sm font-semibold text-pool-100">{section.title}</p>
        <p className="text-sm text-pool-300 whitespace-pre-wrap leading-relaxed">{section.content}</p>
      </div>
    )
  }

  return (
    <div className={`bg-pool-800 border rounded-xl p-3 space-y-2 ${section.included ? 'border-pool-700' : 'border-pool-800 opacity-60'}`}>
      <div className="flex items-center gap-2">
        <span title={`Drafted by ${section.drafted_by}`} className="shrink-0 inline-flex">
          <StaffAvatar role={section.role} style={style} size={24} />
        </span>
        <p className="text-sm font-semibold text-pool-100 flex-1 min-w-0">{section.title}</p>
        {section.edited && <span className="text-[10px] text-accent-300">edited</span>}
        <label className="flex items-center gap-1 text-[11px] text-pool-400 shrink-0">
          <input type="checkbox" checked={section.included} onChange={e => save({ included: e.target.checked })} />
          Include
        </label>
      </div>
      {section.included && (
        <>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onBlur={() => { if (text !== (section.content || '')) save({ content: text }) }}
            rows={Math.min(14, Math.max(section.role === 'coach' ? 3 : 5, Math.ceil(text.length / 60)))}
            placeholder={section.role === 'coach' ? 'Anything you want to say in your own words.' : ''}
            className="w-full bg-pool-900/60 border border-pool-700 rounded-lg px-3 py-2 text-sm text-pool-100 leading-relaxed focus:border-accent-500 focus:outline-none"
          />
          {section.role !== 'coach' && (
            asking ? (
              <div className="flex gap-2 items-center">
                <input value={instruction} onChange={e => setInstruction(e.target.value)} autoFocus
                  onKeyDown={e => { if (e.key === 'Enter') redraft() }}
                  placeholder={`Tell the ${style.title.toLowerCase()} what to change (optional)`}
                  className="flex-1 min-w-0 bg-pool-700 border border-pool-600 rounded-lg px-2 py-1.5 text-xs text-pool-100" />
                <button onClick={redraft} disabled={busy}
                  className="px-3 py-1.5 text-xs font-semibold bg-accent-600 rounded-lg disabled:opacity-40 shrink-0">
                  {busy ? 'Drafting…' : 'Redraft'}
                </button>
              </div>
            ) : (
              <button onClick={() => setAsking(true)} className="text-xs text-accent-400">
                Ask the {style.title.toLowerCase()} to redraft{section.edited ? ' (replaces your edits)' : ''}
              </button>
            )
          )}
        </>
      )}
    </div>
  )
}

function PlanEditor({ plan, onPlan, onClose, onChanged }) {
  const [busy, setBusy] = useState('')
  const locked = plan.status === 'final'
  const gaps = gapsToFill(plan)

  const act = async (label, fn) => {
    setBusy(label)
    try {
      await fn()
    } catch (e) {
      alert(e.message)
    }
    setBusy('')
  }

  const printPlan = () => window.open(`/swimmer-plans/${plan.id}/print`, '_blank')

  return (
    <div className="space-y-3">
      <button onClick={onClose} className="text-xs text-pool-400">‹ All plans</button>

      <div className="bg-pool-800 rounded-xl p-3 space-y-2">
        {locked ? (
          <p className="text-base font-semibold text-pool-100">{plan.title}</p>
        ) : (
          <input defaultValue={plan.title}
            onBlur={e => { if (e.target.value.trim() && e.target.value !== plan.title) act('title', async () => onPlan(await api.updateSwimmerPlan(plan.id, { title: e.target.value.trim() }))) }}
            className="w-full bg-pool-900/60 border border-pool-700 rounded-lg px-3 py-2 text-sm font-semibold text-pool-100" />
        )}
        <p className="text-xs text-pool-400">
          For {AUDIENCE_LABELS[plan.audience] || plan.audience} · {plan.period_from} to {plan.period_to}
          {' · '}
          <span className={locked ? 'text-green-400' : 'text-amber-300'}>{locked ? `Final ${String(plan.finalised_at || '').slice(0, 10)}` : 'Draft'}</span>
        </p>
      </div>

      {!locked && gaps.length > 0 && (
        <div className="bg-amber-950/30 border border-amber-800/50 rounded-xl p-3 space-y-1">
          <p className="text-xs font-semibold text-amber-300">For you to fill in ({gaps.length})</p>
          {gaps.slice(0, 8).map((gap, i) => (
            <p key={i} className="text-xs text-amber-200/80">{gap.section}: {gap.what}</p>
          ))}
        </div>
      )}

      {plan.sections.map(section => (
        <SectionEditor key={section.key} plan={plan} section={section} onPlan={onPlan} locked={locked} />
      ))}

      <div className="flex flex-wrap gap-2 pt-1">
        <button onClick={printPlan} className="flex-1 py-2.5 text-sm font-semibold bg-pool-700 border border-pool-600 rounded-xl">
          {locked ? 'Print or PDF' : 'Preview'}
        </button>
        {locked ? (
          <button disabled={Boolean(busy)} onClick={() => act('copy', async () => { onPlan(await api.copySwimmerPlan(plan.id)); onChanged() })}
            className="flex-1 py-2.5 text-sm font-semibold bg-accent-600 rounded-xl disabled:opacity-40">
            {busy === 'copy' ? 'Copying…' : 'Make a new version'}
          </button>
        ) : (
          <button disabled={Boolean(busy)}
            onClick={() => {
              if (gaps.length && !window.confirm(`There are still ${gaps.length} gaps marked "to add". Make it final anyway?`)) return
              act('final', async () => { onPlan(await api.finaliseSwimmerPlan(plan.id)); onChanged() })
            }}
            className="flex-1 py-2.5 text-sm font-semibold bg-accent-600 rounded-xl disabled:opacity-40">
            {busy === 'final' ? 'Saving…' : 'Mark final'}
          </button>
        )}
      </div>
      {!locked && (
        <div className="flex justify-between pt-1">
          <button disabled={Boolean(busy)}
            onClick={() => act('redraft', async () => onPlan(await api.redraftSwimmerPlan(plan.id)))}
            className="text-xs text-pool-400">
            {busy === 'redraft' ? 'Redrafting…' : 'Redraft sections you have not edited'}
          </button>
          <button onClick={() => {
            if (!window.confirm('Delete this draft?')) return
            act('delete', async () => { await api.deleteSwimmerPlan(plan.id); onChanged(); onClose() })
          }} className="text-xs text-red-400">Delete draft</button>
        </div>
      )}
    </div>
  )
}

export default function SwimmerPlanPanel({ swimmer }) {
  const [plans, setPlans] = useState(null)
  const [open, setOpen] = useState(null)
  const [audience, setAudience] = useState('performance')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [creating, setCreating] = useState(false)

  const load = () => api.getSwimmerPlans(swimmer.id).then(setPlans).catch(() => setPlans([]))
  useEffect(() => { load() }, [swimmer.id])

  const create = async () => {
    setCreating(true)
    try {
      const plan = await api.createSwimmerPlan({
        swimmer_id: swimmer.id, audience, period_from: from || null, period_to: to || null,
      })
      setOpen(plan)
      load()
    } catch (e) {
      alert('Could not draft the plan: ' + e.message)
    }
    setCreating(false)
  }

  const openPlan = async (id) => {
    try {
      setOpen(await api.getSwimmerPlan(id))
    } catch (e) {
      alert(e.message)
    }
  }

  if (open) return <PlanEditor plan={open} onPlan={setOpen} onClose={() => { setOpen(null); load() }} onChanged={load} />

  return (
    <div className="space-y-4">
      <section className="bg-pool-800 rounded-2xl p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold text-pool-100">Athlete plan</p>
          <p className="text-xs text-pool-400 mt-1 leading-relaxed">
            What we're working towards, what we're working on, and how we plan to do it. The staff draft each
            section from {swimmer.name.split(' ')[0]}'s own data; you edit it, then mark it final to print or share.
          </p>
        </div>
        {!swimmer.para_class && !swimmer.considerations && (
          <p className="text-[11px] text-pool-500">
            Para swimmer? Add their sport classes and anything the staff should keep in mind under Edit at the top of this page.
          </p>
        )}
        <div className="space-y-1.5">
          <p className="text-[11px] uppercase tracking-wide text-pool-500">Who is it for?</p>
          {Object.entries(AUDIENCE_LABELS).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-pool-200">
              <input type="radio" name="plan-audience" checked={audience === key} onChange={() => setAudience(key)} />
              {label}
            </label>
          ))}
        </div>
        <div className="space-y-1.5">
          <p className="text-[11px] uppercase tracking-wide text-pool-500">Period (leave blank for this season)</p>
          <div className="flex items-center gap-2">
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
              className="flex-1 min-w-0 bg-pool-700 border border-pool-600 rounded-lg px-2 py-2 text-sm text-pool-100" />
            <span className="text-xs text-pool-500">to</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
              className="flex-1 min-w-0 bg-pool-700 border border-pool-600 rounded-lg px-2 py-2 text-sm text-pool-100" />
          </div>
        </div>
        <button onClick={create} disabled={creating}
          className="w-full py-2.5 text-sm font-semibold bg-accent-600 rounded-xl disabled:opacity-40">
          {creating ? 'The staff are drafting it… (about half a minute)' : 'Draft a new plan'}
        </button>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-pool-300 uppercase tracking-wide">Plans</h2>
        {plans === null ? (
          <p className="text-xs text-pool-500">Loading…</p>
        ) : plans.length === 0 ? (
          <p className="text-xs text-pool-500">No plans yet.</p>
        ) : plans.map(plan => (
          <button key={plan.id} onClick={() => openPlan(plan.id)}
            className="w-full text-left bg-pool-800 hover:bg-pool-700 rounded-xl px-3 py-2.5">
            <p className="text-sm text-pool-100">{plan.title}</p>
            <p className="text-[11px] text-pool-500">
              {AUDIENCE_LABELS[plan.audience] || plan.audience} ·{' '}
              <span className={plan.status === 'final' ? 'text-green-400' : 'text-amber-300'}>
                {plan.status === 'final' ? `Final ${String(plan.finalised_at || '').slice(0, 10)}` : 'Draft'}
              </span>
            </p>
          </button>
        ))}
      </section>
    </div>
  )
}
