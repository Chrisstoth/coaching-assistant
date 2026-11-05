# Workers, workbooks and history import

Status: agreed direction, 5 Nov 2026. Not built yet.

## 1. The idea

The staff ("workers") keep written knowledge that builds up season after season, instead of starting from scratch each time they speak. Each worker has a **job description** the coach can edit and a **workbook** the worker writes itself. Both are markdown pages with full version history. Six to seven years of the coach's session files, plus registers, are imported so the workers have real evidence to learn from.

One rule runs through everything: **AI reads and judges; code counts and stores.** Totals, zones, loads, dates and name matching are done by code. The AI never does the arithmetic.

## 2. The four parts

```
 COACH ── decides, approves, corrects
   │
 WORKERS ── judgement, a voice in the staff room
   │   each = job description (.md, coach edits)
   │        + workbook (.md, worker writes)
   │        + the tools it may use
   │
 TOOLS ── exact code: session notation parser, season plan engine, importers
   │
 RECORDS ── facts: swimmers, sessions, registers, times, plan
```

## 3. Workers

| Worker | Exists? | Owns | Tools it uses | Speaks in the staff room |
|---|---|---|---|---|
| Physiologist | yes | training response, recovery, load | load figures | yes |
| Analyst | yes | race results, progression, pacing | race times, splits | yes |
| Planner | yes | season shape, phases, tapers | season plan engine | yes |
| Swimmer manager | yes | the swimmer as a person, foundation profile | profiles | yes |
| Meet manager | yes | galas, entries, qualifying times | meets | yes |
| Session Writer | yes | how sessions are written | session notation | yes |
| **Records Officer** | **new** | imports, decoding, glossary | importers, notation parser | **only about data** |

Rules:
- A worker writes only to its own workbook. It can read every other worker's.
- When workers disagree, it becomes a staff note to the coach. A worker never quietly edits another worker's page.
- Standing instructions still go through the coach's **Remember** button (coach guidance). Workbooks are working notes, not rules.
- Job descriptions move out of code ([staff_room.py](../../backend/services/staff_room.py) `ROSTER`) into `job.md` pages.
- **A job description has two parts.** The **fixed part** (set by the app): how the worker operates, its safety rules, what counts as evidence, what it may write and where. The **editable part** (the coach's): focus, priorities, tone. The coach can't accidentally break how a worker operates.
- **Every job description spells out:** what counts as evidence for this worker; what it predicts, in a checkable form ("Sophie 200 free under 2:10 at County"); its safety flags; when to stay quiet; what it may write and where.
- **Preferences vs safety flags.** The coach can teach a worker to drop a preference ("don't flag mixed-stroke warm-ups"). Safety flags (a load spike, a swimmer returning from injury, hard days stacked) can be acknowledged but never switched off. A worker must not learn to stay quiet just because the coach dismisses things.

### Where each kind of information goes

| Kind | Lives in | Owner |
|---|---|---|
| Facts (sessions, registers, times, plan) | records | code |
| Who the swimmer is | foundation profile | swimmer manager, with the coach |
| How the coach wants things done | coach rules (Remember button) | coach |
| Conversations and flags | staff notes | whoever raised it |
| A worker's beliefs and findings | its workbook | that worker |

The same fact is never stored in two places. Workbooks link to records instead of copying them.

## 4. Workbooks

### Layout (example: physiologist)

```
physiologist/
  job.md                 ← job description (coach edits)
  _index.md              ← one line per page; read first
  philosophy/            ← the COACH'S view, not textbook science
  squad/
    responses-to-blocks.md
  swimmers/
    sophie-b.md
  journal/
    2026-11.md           ← dated raw notes, added to over time
```

Not a library of textbook science: the model already knows that. The reference pages hold **the coach's view**: which methods they trust and where they disagree with the textbook.

### Page header

```markdown
---
title: Sophie B – training response
kind: case                 # job / index / philosophy / case / journal
swimmers: [14]
confidence: hypothesis     # hypothesis / seen-once / pattern
last_reviewed: 2026-11-04
summary: Possibly needs 48h after race-pace sets
---
```

- **pattern** needs 3 or more sightings, each linked to a session, debrief or result. Anything less stays a hypothesis.
- A claim with no new evidence and no review fades. A weekly tidy-up flags it for review.
- Pages have a size limit. The weekly tidy-up turns journal notes into casebook entries.

### What a worker can do

`read_index`, `search`, `read_page(path, section)`, `write_section(path, heading, content, reason)`, `append_journal(text)`, `create_page(...)`, all limited to its own folder for writing. Editing one section at a time keeps edits cheap and stops a bad rewrite from wiping a page.

### Storage

Pages and versions live in the app database (works from the phone, backed up with everything else, no OneDrive sync clashes). Search uses SQLite full-text search. An export to a real folder (for example, to browse in Obsidian) can come later.

- `workbook_pages`: role, path, title, kind, summary, tags, swimmer_ids, current_version, locked sections, updated_at
- `page_revisions`: page, version, content, author (worker role or coach), reason, trigger (conversation, debrief, import), created_at

## 5. Versioning

- Every save is a new version with who wrote it, why, and what triggered it.
- **See what changed:** "what did the physio change this week?"
- **Restore without losing anything:** restoring copies an old version forward. Nothing is deleted.
- **Undo a conversation:** every change from one chat can be rolled back in one go.
- **Snapshots:** named snapshots, for example at the start of each macrocycle.
- **The coach's edits win.** A worker's edit is refused if the coach changed the page after the worker read it. The worker re-reads the page and tries again. The coach can lock sections so workers can only suggest changes to them.
- **Deleting a swimmer really deletes them.** Version history keeps everything, which conflicts with a family asking for their child's data to be removed. Deleting a swimmer clears their pages, every old version of those pages, and mentions of them on squad pages.

## 6. One notation, one glossary

The Session Builder artifact's text notation becomes the squad's shared language (`4x100 r20 ~1:20`, rounds, numbered lines, alternating sets, two-lane send-offs, six intensity scales mapped onto one common scale).

- The Session Writer drafts in it, the Records Officer converts old sheets into it, and the coach reads and edits in it.
- Its parser and intensity scales are moved into the backend so there is **one parser**. Test cases are taken from the builder so both behave the same.
- If a decoded line won't parse, it is flagged, not guessed.
- **The in-app Session Builder replaces** the current session editor and the session workshop. It is rebuilt from the artifact's behaviour, with layout improvements, as part of the app (linked to the week's plan, the register and the staff). There is one way to write a session.

### Intensity scales

- **Every intensity is stored on one common scale.** Scales only change the labels, never the stored value. The builder already works this way (Effort /20, RPE, BPSC HR colours, Urbanchek, Sweetenham, Maglischo).
- **Each coach picks a usual scale,** used everywhere they look: builder, planner, swimmer plans, worker comments.
- **A single session can use a different scale** (for example, a standalone session written for another coach). Its values are still stored on the common scale.
- **Decided 5 Nov 2026: the Session Builder's line-up is the common scale** (calibrated to how the coach uses Effort /20 alongside HR counts: HR 22–24 ≈ 12–13, HR 27 ≈ 16, HVO 21). The Season Planner lined the colours up differently (its Red was 15–16; the builder's Red is 17). When the plan is brought in, each target is **carried over by its level** (a Red week stays Red, stored as the builder's Red value), never by its number. The planner's Olbrecht scale is added, lined up the same way.
- Training-zone totals (metres and time in recovery, aerobic, threshold, VO2, lactate tolerance, race pace, sprint, kick) are worked out in code from the common scale. The default bands follow Sweetenham's zones and are club data.
- Scales are club or coach data, not code, so other clubs can add their own.
- **Glossary:** one shared page of the coach's terms and shorthand, kept by the Records Officer and approved by the coach. It extends [terminology.py](../../backend/services/terminology.py).

## 7. History: evidence vs style

Old sessions are useful in two different ways, kept apart on purpose:

- **Evidence** (what was done → why → how the body responded → result): all years count, weighted by how relevant they are to the current squad.
- **Style** (how to write a session today): only the coach's current way counts.

The Session Writer's workbook has three style pages:

1. **Current style.** Written from recent sessions, **confirmed by the coach**, and overrides everything else.
2. **Moved on from.** Practices the coach has dropped, each with the coach's reason. Never used unless the coach asks.
3. **Style history.** A summary by period: BPSC 2014–15, Leeds 2015–17, BPSC 2022–now.

How it works:
- After the import, the Analyst compares the periods ("2015: lots of long pull sets. 2025: almost none"). The coach taps **moved on**, **still do** or **sometimes**, and gives the reason if they want. Those answers fill the pages above and record the coach's philosophy.
- When writing, the Session Writer takes examples from roughly the last 12 months. Older sets are only used if marked "still do", or if the coach asks.
- If the coach keeps editing drafts the same way, the Session Writer suggests an update to "Current style". The suggestion is versioned like any other change.

## 8. Importing history

### What exists (found 5 Nov 2026)

About 1,570 files named like sessions (`250704 Friday AM`), plus race times from 2015 to 2026 (8,803, most from 2021–24).

| Period | Where | Files | Format | Use |
|---|---|---|---|---|
| 2014–15 | Dropbox/BPSC/2014-2015 | ~240 | Word | style history |
| 2015–17 | Dropbox/University of Leeds SWP | ~220 | Word | style history only (a different squad of university swimmers) |
| 2015–16 | Dropbox/BPSC/2015-2016/Silver 1 | ~135 | to check | style history |
| 2018–22 | Dropbox/BPSC 2018-2019 … 2021-2022 | unknown | **online only in Dropbox**: must be made available offline before import | evidence + style history |
| 2022–27 | Dropbox/BPSC 20xx-20xx/Silver 1, Silver 2, camps | ~830 | mostly Excel; recent ones are PDFs exported from the Session Builder | evidence + current style |
| mixed | OneDrive/Sets for JC/Sessions | ~225 | Word | check for duplicates |

Some file names start with the year (YYMMDD) and some start with the day, so dates come from the file contents and folder, not just the name.

**Registers (BPSC):** this season (2026–27) only, taken in the app's own session register (each swimmer marked attended or not). No import is needed for BPSC. Older seasons have no attendance, so their sessions are linked at group level only (what the group did), not to individual swimmers. Swimmer-level links start this season and grow from there. Register "Group 1 / Group 2" means **the set the swimmer swam**, never their training group.

**Register import (a general feature):** built for other clubs if the tool goes public, not for BPSC's own data. Every club uses a different system and export layout, so the Records Officer works out the column mapping from a sample, the coach confirms it, and the mapping is saved **for that club**. After that, code reads every export from the same system. The same applies to session files: decoding notes and the glossary belong to a club or coach, never to the code.

### Pipeline

1. **Find:** scan the chosen folders. The originals are only read, never changed. OneDrive online-only files have to be downloaded first (two files in Attachments couldn't be read).
2. **Remove duplicates:** match on date plus content, so copies in different folders count once.
3. **Read:** known layouts (the Excel template in [importer.py](../../backend/services/importer.py), the builder's PDFs) are read by code. Unknown layouts are read by the AI using its decoding notes.
4. **Convert:** sessions go into the shared notation; registers become who attended which session.
5. **Check in code:** lines parse, totals add up, dates make sense, names match swimmers.
6. **Ask about patterns, not items:** "37 sheets use 'BK'. Is that backstroke kick?" The coach answers once, the answer goes into the decoding notes, and every later file uses it.
7. **Save:** clean records are saved automatically. Uncertain ones wait for the coach in one batch.

A missing session file means **unknown**, never a rest day, so load figures aren't understated.

**Each swimmer's own training record.** The workers and the load counter work from what each swimmer actually did, never from what the squad did:

- **Groups come from the season plan.** A session starts with the plan's groups for that week (e.g. Girls, Boys, sub groups) and their swimmers. The coach can re-split per session (IM / No.1 stroke) and move individual swimmers. The register shows each swimmer's expected group, corrected on the day. A swimmer's load is the shared blocks plus their own group's blocks.
- **Away with another programme** (a national or para camp, a county camp, a school trip). Home sessions are marked "away on camp" for that swimmer, never "missed". Their camp sessions are added to **their** record:
  - written in full in the builder when the coach has the sessions, or
  - as a **quick summary** when they haven't ("Manchester para camp, 5 days, 9 sessions, mostly aerobic, about 40 km"), marked as an estimate.
- **Why it matters:** the load counter stays right, and each worker gets the context. The physio sees a heavy, different week. The analyst links it to the next meet. The swimmer manager knows it's part of the swimmer's para pathway. Estimates are always treated as estimates.

**Who a session was for.** Every session, written or imported, says who it was for: the whole squad, a group or sub group, a camp, or one swimmer. Camp sessions (Lanzarote, Cyprus, "CAMP 2026") are linked to the camp and its attendees, never counted for the whole squad. Several sessions can share a date and time. Where the register exists, it confirms who actually swam. Where it doesn't (past seasons), a session counts only for the group or camp it was written for.

### Records Officer workbook

- `formats/`: one page per layout ("2022–25 Excel template: column C is the set group…")
- `glossary.md`: the shared glossary (see section 6)
- `import-log/`: what was imported, from where, with what doubts

## 9. Writing sessions with the workers commenting live

From now on, sessions are written in an in-app version of the Session Builder. The workers comment while the coach writes. This takes over from the existing session workshop ([session_workshop.py](../../backend/services/session_workshop.py)), where the Session Writer drafts and the specialists suggest changes to particular lines for the coach to accept or reject. Every line in the builder has a fixed ID from the start, so comments can attach to it.

- **Speaking a session to Jess:** the coach talks the session through naturally and Jess fills in the builder live, in the shared notation. The parser checks each line she writes. This reuses the voice set-up from the profile interview.
- **When they look:** when a block is finished or the coach pauses, never on every keystroke.
- **Where comments appear:** as small notes pinned to the line they're about, for example "3rd threshold set this week for Group 2" (physio), or "no 200 race pace for Sophie before County" (analyst).
- **Who speaks:** only the worker that owns the topic. Staying quiet is normal.
- **What the coach does:** accept, dismiss, or dismiss with a reason. Reasons go into the worker's workbook, so it learns which **preferences** the coach doesn't want flagged. Safety flags can't be silenced (section 3).
- **How workers are judged:** by "was this useful?" taps and by how often their predictions come true, **not** by how often the coach agrees. A worker who is right but unwelcome is still worth having.
- **Cost:** fast model; each worker reads its index and one or two pages, not raw history.

## 10. Learning: gaps and links

Each worker runs its own system for spotting two things:

- **Gaps:** what hasn't been done but should have been. **Code** works out coverage from the history (zones, strokes, skills, distances, race-pace work, per group and per week). The **worker** judges it against the plan and the target meets. Examples: "no starts work in 5 weeks", "the 200 swimmers have had no race pace since October".
- **Links:** connections between sessions, attendance and performance. Examples: "swimmers who made most of the threshold sessions in block 2 improved more over 400". These start at group level from past seasons, then become per swimmer once this season's registers are in.

| Worker | Watches for gaps in | Looks for links between |
|---|---|---|
| Planner | plan vs what was actually done | block shape and meet results |
| Physiologist | recovery, load balance | load and how swimmers responded |
| Analyst | race-pace work for each swimmer's events | session content, attendance and race results |
| Session Writer | variety; stale or repeated sets | set types and how sessions went in debriefs |

### What the workers learn from

Race results alone are too rare and too noisy (few meets, taper, pool, conditions). The loop also needs:

- **How each session went:** a quick tap per swimmer on the register (good / flat / ill / injured), plus an optional 20-second voice note. It must take seconds, or it won't happen.
- **What was actually swum:** after a session, "swum as written" or "changed", with changes recorded, so the workers learn from what really happened and not from the plan.
- **Regular test sets** (for example, a monthly 6×200 or kick test) logged as benchmarks. The app already has this feature; it's unused so far.
- **Later, the swimmers' own view:** an optional effort score after each session. This needs parental consent for under-18s and is a later decision, but the design leaves room for it.

How this stays honest:
- Each worker keeps a **watch list** page (what it's tracking) and a **findings** page (what it has found, with confidence and evidence links).
- **Predictions:** before a meet, workers write down what they expect. Afterwards they mark themselves right or wrong. Their track record shows how far to trust each worker.
- With about 25 swimmers, links are hypotheses for the coach to judge, not proof.

### If the tool goes public

Nothing is built for this yet, but the design shouldn't block it:
- **Club-specific knowledge lives in data, not code:** decoding notes, glossaries, job descriptions, groups and intensity scales. BPSC is the first club, not a special case.
- **Importers start with no knowledge of a club** and learn each new club's formats through the Records Officer.
- **Each club has its own workers and workbooks.** Three layers:

  | Layer | Belongs to | Holds |
  |---|---|---|
  | Starter kit | the app | default job descriptions, session notation, intensity scales, empty workbook layouts |
  | Club | each club | its own copy of every worker: job descriptions, workbooks, glossary, import mappings, swimmer and squad pages |
  | Coach | each coach in a club | personal session style ("Current style", "Moved on from") and philosophy pages |

  - A new club gets a copy of the starter kit. From then on, its workers learn only from that club's data.
  - **Nothing passes between clubs automatically.** Starter-kit improvements are offered to a club as suggestions, never overwrites, using page version history.
  - Swimmer and squad pages are shared within a club (a swimmer moving squads keeps their history). Session style stays with each coach.
  - Every page and record is tagged with its club, and its coach where relevant. A worker is identified by club and role ("BPSC's physiologist").
  - Build with a club tag from the start, even while BPSC is the only club.
- Before any public release, these need their own design: data protection for children's records, keeping each club's data separate, hosting, and AI cost per club.

## 11. Build order

The Session Builder comes first: everything else uses its notation, and it starts clean data flowing from day one. Each step has a check that must pass before moving on. Use [backend/evals](../../backend/evals/README.md) to compare answers with and without workbooks.

| # | Step | Done when |
|---|---|---|
| 1 | **Notation and one shared intensity scale** in the backend: the builder's parser and scales moved to Python, the planner's scale lined up | The builder's own examples give the same results in Python |
| 2 | **Session Builder in the app**, replacing the current editor and the workshop: sessions linked to the plan and the register, fixed line IDs, a quick "how it went / what changed" step | The coach can do everything the artifact does, and stops using the artifact |
| 3 | **Workbook storage**, versions, a simple viewer; job description pages (fixed + editable parts); the Records Officer | Pages can be edited, compared and restored from the phone |
| 4 | **Sample import trial:** about 10 files from each period | Decoding accuracy, number of questions and cost per file are known |
| 5 | **First full loop:** session written → swum → register and quick notes → analyst and session writer update their workbooks → it shows in the next session | The loop runs for 2–3 weeks with real sessions |
| 6 | **Live comments** from the workers in the builder | "Was this useful?" is mostly yes |
| 7 | **Import 2022–now**; then 2014–17 with the review of how the style changed; Session Writer style pages | The coach has reviewed the uncertain batch and confirmed "Current style" |
| 8 | **Gaps and links:** coverage figures in code, then each worker's watch list, findings and predictions | First gap reports match what the coach recognises |
| 9 | **Season Planner** in the app (live plan copied from the artifact's storage) + Planner workbook | See the season planner rebuild notes |
| 10 | **Physiologist workbook** | Has the history and session notes to learn from |

Until step 2 is done, the coach keeps using the artifact, and new Dropbox PDFs are imported so the history has no gap.

## 12. Risks

- **Workers believing their own mistakes.** A wrong belief gets written, read back and repeated. Guarded by confidence levels, links to evidence, fading claims, and quick review by the coach.
- **Small, noisy numbers.** About 25 swimmers, mixed in with growth spurts, exams and illness. Most findings are hypotheses for the coach to judge, and the app must say so.
- **The coach not reviewing.** Reviewing has to take seconds on a phone: a list of what changed, then ✓ or correct.
- **Swimmers' data.** These are under-18s, so everything stays local. Workers write training observations, never medical diagnoses.
- **Cost.** Use the fast model for reading and tidy-ups, and only use the AI where code can't read a file. The sample trial measures this before the bulk import. A monthly AI spending cap per club protects the coach, and is needed to price the tool if it goes public.
- **Too many notifications.** Seven workers could flood the coach's phone. The weekly review is designed as one short list, not a stream of alerts.
- **Swimmers who have left** appear by name in old files. They're kept as past swimmers (for squad history) or the names are ignored. They never get new swimmer pages.

## 13. Open questions

1. The 2018–22 Dropbox folders need downloading ("Make available offline"). Is there a 2017–18 folder anywhere?
2. Do the "Sets for JC" files duplicate the Dropbox folders, or are they different sessions?
3. A name for the Records Officer.

Settled: going public is a goal (section 10). The register importer is built for other clubs after BPSC's own steps.
