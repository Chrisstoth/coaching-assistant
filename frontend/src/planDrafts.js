// What the planning skills hand back, and how each kind is described and saved.
//
// A draft is only ever a proposal: nothing here runs until the coach approves,
// and every save goes through the same endpoints the season page already uses.

export const DRAFT_KINDS = {
  season_macros: 'season_macros',
  macro_plan: 'macro_plan',
  meso_plan: 'meso_plan',
  micro_plan: 'micro_plan',
  pathway_plan: 'pathway_plan',
}

export function draftFromResult(result) {
  const skill = result && result.skill_result
  if (!skill || !skill.draft || !DRAFT_KINDS[skill.type]) return null
  return { kind: skill.type, draft: skill.draft }
}

function weeksBetween(from, to) {
  if (!from || !to) return null
  const days = (new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000
  return Math.max(1, Math.round((days + 1) / 7))
}

// Plain-language summary for the review card.
export function describeDraft(kind, draft) {
  if (kind === 'season_macros') {
    return {
      heading: 'Proposed macrocycles',
      title: draft.name,
      note: draft.narrative || null,
      items: (draft.macros || []).map((m, i) => ({
        key: i,
        title: `${i + 1}. ${m.name}`,
        detail: `${m.date_from} to ${m.date_to} · ${m.weeks || weeksBetween(m.date_from, m.date_to)}w`
          + (m.primary_meet ? ` · target ${m.primary_meet}` : ''),
        body: m.focus || null,
      })),
      warnings: draft.warnings || [],
      questions: draft.questions || [],
      saveLabel: 'Create these macrocycles',
    }
  }

  if (kind === 'macro_plan') {
    const scoped = Boolean(draft.macro_id)
    return {
      heading: scoped ? 'Proposed blocks for this macrocycle' : 'Proposed season plan',
      title: draft.name,
      note: draft.narrative || null,
      items: (draft.phases || []).map((p, i) => ({
        key: i,
        title: p.name,
        detail: `${p.phase_type || 'phase'} · ${p.date_from} to ${p.date_to} · ${p.weeks || weeksBetween(p.date_from, p.date_to)}w`,
        body: p.focus || null,
      })),
      warnings: [],
      questions: [],
      saveLabel: scoped ? 'Add these blocks' : 'Save this season plan',
    }
  }

  if (kind === 'meso_plan') {
    return {
      heading: 'Proposed block',
      title: draft.name,
      note: draft.notes || null,
      items: [{
        key: 0,
        title: draft.phase_type || 'Block',
        detail: `${draft.date_from} to ${draft.date_to}`,
        body: null,
      }],
      warnings: [],
      questions: [],
      saveLabel: 'Save this block',
    }
  }

  if (kind === 'micro_plan') {
    return {
      heading: 'Proposed week',
      title: draft.week_label || 'Weekly plan',
      note: draft.meso_position_note || null,
      items: (draft.sessions || []).map((s, i) => ({
        key: i,
        title: [s.day, s.slot_label].filter(Boolean).join(' · ') || `Session ${i + 1}`,
        detail: s.session_type || s.energy_focus || '',
        body: s.key_emphasis || null,
      })),
      warnings: [],
      questions: [],
      saveLabel: 'Save this week',
    }
  }

  return {
    heading: 'Proposed pathways',
    title: null,
    note: draft.reasoning || null,
    items: (draft.pathways || []).map((p, i) => ({
      key: i,
      title: p.name,
      detail: `→ ${p.primary_meet || 'no target meet'}` + (p.fallback_meet ? ` · else ${p.fallback_meet}` : ''),
      body: p.objective || null,
      chips: (p.swimmers || []).map(s => s.name),
    })),
    warnings: [],
    questions: draft.questions || [],
    saveLabel: 'Save these pathways',
  }
}

function macroContaining(macros, from, to, preferredId) {
  const fits = macros.filter(m => from >= m.date_from && to <= m.date_to)
  return fits.find(m => m.id === preferredId) || fits[0]
    || macros.find(m => m.id === preferredId) || macros.find(m => m.is_current) || macros[0] || null
}

// Approve a draft. Returns { macroId } naming the macro the coach should be
// looking at afterwards, so the workspace can move focus to what just changed.
export async function saveDraft(kind, draft, { api, macros = [], macroId = null }) {
  if (kind === 'season_macros') {
    // Sequential, in date order: macro numbers are handed out as each is created.
    let first = null
    for (const m of draft.macros || []) {
      const created = await api.createMacro({
        name: m.name,
        squad: draft.squad || null,
        date_from: m.date_from,
        date_to: m.date_to,
        primary_meet_id: m.primary_meet_id || null,
        narrative: m.focus || null,
        mesos: [],
      })
      if (first === null) first = created.id
    }
    return { macroId: first }
  }

  if (kind === 'macro_plan') {
    if (draft.macro_id) {
      // Blocks go into the macro that was asked about, not a new one.
      for (const p of draft.phases || []) {
        await api.createSeasonBlock({
          macro_id: draft.macro_id,
          name: p.name,
          phase_type: p.phase_type,
          date_from: p.date_from,
          date_to: p.date_to,
          group_intents: p.group_intents || {},
          notes: p.focus || null,
        })
      }
      const target = macros.find(m => m.id === draft.macro_id)
      const hasGroups = target && target.group_definitions && Object.keys(target.group_definitions).length
      if (!hasGroups && draft.group_definitions && Object.keys(draft.group_definitions).length) {
        await api.updateMacro(draft.macro_id, { group_definitions: draft.group_definitions })
      }
      return { macroId: draft.macro_id }
    }
    const created = await api.createMacro({
      name: draft.name,
      squad: draft.squad || null,
      date_from: draft.date_from,
      date_to: draft.date_to,
      narrative: draft.narrative,
      group_definitions: draft.group_definitions || {},
      mesos: (draft.phases || []).map(p => ({
        name: p.name, phase_type: p.phase_type, date_from: p.date_from, date_to: p.date_to,
        group_intents: p.group_intents || {}, notes: p.focus || null,
      })),
    })
    return { macroId: created.id }
  }

  if (kind === 'meso_plan') {
    const target = macroContaining(macros, draft.date_from, draft.date_to, macroId)
    await api.createSeasonBlock({ ...draft, macro_id: target ? target.id : null })
    return { macroId: target ? target.id : null }
  }

  if (kind === 'micro_plan') {
    const block = macros.flatMap(m => m.mesos || [])
      .find(b => draft.week_of >= b.date_from && draft.week_of <= b.date_to)
    await api.createMicrocycle({
      macro_id: block ? block.macro_id : null,
      block_id: block ? block.id : null,
      squad: block ? block.squad : null,
      week_start: draft.week_of,
      label: draft.week_label || 'Weekly plan',
      meso_position_note: draft.meso_position_note,
      progression_note: draft.progression_note,
      recovery_placement: draft.recovery_placement,
      next_week_direction: draft.next_week_direction,
      coach_flags: draft.coach_flags || [],
      sessions: draft.sessions || [],
    })
    return { macroId: block ? block.macro_id : macroId }
  }

  // Pathways attach to the macro they were proposed for.
  const targetMacro = draft.macro_id || macroId
  if (!targetMacro) throw new Error('There is no macrocycle to attach these pathways to yet.')
  for (const pathway of draft.pathways || []) {
    const created = await api.createPlanningPathway({
      macro_id: targetMacro,
      name: pathway.name,
      objective: pathway.objective || null,
      primary_meet_id: pathway.primary_meet_id || null,
      fallback_meet_id: pathway.fallback_meet_id || null,
    })
    const members = (pathway.swimmers || []).map(s => ({
      swimmer_id: s.swimmer_id,
      qualification_status: s.qualification_status || 'unknown',
      notes: s.reason || null,
    }))
    if (members.length) await api.setPlanningPathwayMembers(created.id, members)
  }
  return { macroId: targetMacro }
}

// A draft that arrives from another page (the main AI chat) waits here.
const HANDOFF_KEY = 'dx_plan_draft'

export function stashDraft(kind, draft, storage = globalThis.sessionStorage) {
  try { storage.setItem(HANDOFF_KEY, JSON.stringify({ kind, draft })) } catch { /* private mode */ }
}

export function takeStashedDraft(storage = globalThis.sessionStorage) {
  try {
    const raw = storage.getItem(HANDOFF_KEY)
    if (!raw) return null
    storage.removeItem(HANDOFF_KEY)
    const parsed = JSON.parse(raw)
    return parsed && DRAFT_KINDS[parsed.kind] && parsed.draft ? parsed : null
  } catch {
    return null
  }
}
