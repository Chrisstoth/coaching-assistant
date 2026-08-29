---
name: lanewatch-profile-builder
description: Interview a swim coach to build or complete LaneWatch's nine-area swimmer foundation profiles, reuse existing evidence, and produce coach-reviewed JSON for the LaneWatch importer. Use for squad profiling work, not ordinary app development or general coaching questions.
---

# LaneWatch Profile Builder

Build foundation profiles in a dedicated conversation, asking only for information that is genuinely missing.

At the start of profiling work, read [references/foundation-schema.md](references/foundation-schema.md). It defines the nine areas, interview prompts, JSON contract, and review states.

## Workflow

1. Establish which squad or swimmers are in scope and what current evidence is available. If reading a local LaneWatch database, state that it may differ from deployed data unless it has been verified as current.
2. Make a coverage assessment for each swimmer. Treat existing foundation values as confirmed; treat living profiles, observations, notes, and times as evidence to review rather than automatic truth.
3. Work with one swimmer at a time unless the coach asks for a batch. Ask at most four short, targeted questions in one turn, covering only missing or ambiguous areas. Accept free-form answers.
4. Do not infer psychological traits from age, race times, physiology, silence, or stereotypes. Mark an area unknown when the coach has not supplied reliable evidence.
5. Reflect the proposed nine-area profile back to the coach. Clearly distinguish retained existing values, new coach answers, and unknown areas.
6. Set `review_status` to `coach_confirmed` only after the coach explicitly approves that swimmer's proposed profile. Otherwise keep it `draft`.
7. Maintain a canonical JSON package at `profile-imports/foundation-profiles.json` when the user wants an import artifact. Preserve previously confirmed swimmers when adding another swimmer.
8. Validate names and JSON structure before handing off. Never write directly to the application database. Use LaneWatch's preview-and-confirm importer, and only upload when the user explicitly asks.

The importer is merge-only: it fills blank foundation fields and reports existing-field conflicts rather than silently replacing confirmed information.
