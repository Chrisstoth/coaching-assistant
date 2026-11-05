# Session Builder: what it does today

Everything the BPSC Session Builder artifact does, so nothing is lost when it moves into the app. Read from the artifact on 5 Nov 2026 (last updated 25 Oct).

Tick what you use. Cross out anything you'd happily lose. Add anything missing.

---

## 1. Writing sets

**Reps and distance**
- [ ] `4x100`, `4 x 100`, `4×100`, or just `200`. The "m" is optional.
- [ ] Anything after the distance is the description: `4x100 Free build`.

**Send-off**
- [ ] `@1:30`, `(1:30)`, `on 1:30`, `off 1:30`
- [ ] Times as `1:30`, `1.30` or `90` (two or three digits are seconds; a single digit is minutes)
- [ ] Two lanes: `4x100 off 1:30/1:40`. The second lane gets its own session time.

**Rest instead of a send-off**
- [ ] `r20`, `w/ 20`, `rest 30`, `20s rest`, `1 min rest`, `:20`
- [ ] With an estimated swim time per rep: `4x100 r20 ~1:20` (or `est 1:20`). This keeps the session time right.
- [ ] A rest-only line (`Rest 2 mins`) counts as time.

**Intensity**
- [ ] In square brackets: `[14]`, mixed `[14-16]`, build `[12->16]`. Or at the end: `e 14`, `effort 14`.
- [ ] Any scale's labels are understood: `[Red]`, `[A3]`, `[EN2]`, `[HVO]`.

**Numbered lines** (what each rep does)
- [ ] `4x100 1) Kick 2) Drill 3) Swim 4) Build`
- [ ] Shift+Enter on a set adds the next number. Typing `2) swim` after a set carries on its numbering.
- [ ] A line can have its own send-off or rest: `2) Build @4:45`, `3) Fast r30`. Lines without one use line 1's.
- [ ] Reps are shared evenly across the lines (8 reps, 4 lines = 2 each). Otherwise one each, and leftover reps follow line 1.
- [ ] Alternating: `4 x 50 alt max dive start (1:10) and max finish (1:50)` becomes numbered lines, each on its own send-off.

**Notes inside a block**
- [ ] A line with only words (`Fins on`) is a note and prints in italics.

**Several sets at once**
- [ ] `4x50 off 60, 2x100` adds two sets.

**Rounds**
- [ ] `3x` on its own starts an empty round to fill.
- [ ] `2 x (4x50 off 60, 2x100)` or `3 rounds of …` makes a round of both sets.
- [ ] A round can have a note, and rounds can sit inside rounds.
- [ ] Totals multiply through rounds.

**Edit a block as text**
- [ ] Write or paste the whole block as text. Indenting puts sets inside the round above.

## 2. Speaking sets

**Keyboard dictation** (Windows + H, or the mic on a phone keyboard)
- [ ] "4 by 50", "4 times 50", "4 lots of 50", "4 by 1 50" (= 150)
- [ ] "on 1 10" (= 1:10), "a minute and a half", "every 1:10", "leaving on the 1:10"
- [ ] "20 seconds rest", "about 1:20 each"
- [ ] "effort 14", "effort 14 to 18", "effort 14 building to 18", "zone red"
- [ ] "line 2 build on 4 45"

**Mic button** (Chrome only)
- [ ] Number words become digits ("four by fifty on one ten")
- [ ] Commands: "undo", "stop", "end round", "new block called Kick"
- [ ] Stops listening by itself after 90 seconds of quiet

## 3. Editing

**Blocks**
- [ ] New sessions start with Warm up, Main set and Swim down.
- [ ] Rename, add, move up or down, drag, duplicate, delete (with undo).
- [ ] Notes blocks ("Additional notes"), which can go anywhere.

**Sets**
- [ ] Drag by holding the dots.
- [ ] Select several (tap the dots, Shift-click for a run, or swipe down them), then wrap in 2×, 3×, 4×, or press any number 2–9.
- [ ] Move into the round above (Ctrl ]) or out of a round (Ctrl [). Remove a round but keep its sets.
- [ ] Move with Alt ↑ / ↓. Duplicate with Ctrl D. Delete.
- [ ] Enter jumps to the next empty cell, then starts a new set.
- [ ] Undo with Ctrl Z, up to 40 steps.
- [ ] Each set is in columns: reps · distance · description · send-off · lane 2 · intensity. Estimated times show in italics, and a rest set with no estimate is outlined.

## 4. Groups within a session

- [ ] Name the groups for a session (each gets a colour).
- [ ] Each block is for every group or just some ("Who swims this block?").
- [ ] A tab for each group shows just their session.
- [ ] "Make a separate copy for Group X" splits a shared block. "Copy for Group X" duplicates it.
- [ ] Deleting a group removes the blocks only it swims (with undo).

9 of your 16 saved sessions use groups, for example "Group 1 Girls / Group 2 Boys", "Group 1 IM / Group 2 No.1 / Group 3 No.1", and "Girls + Boys Development / Boys". Shared blocks (warm up, "All Groups Sub") are swum by everyone. 10 of the 16 also use two-lane send-offs.

## 5. Totals

For each group:
- [ ] Distance and time, plus the second lane's time and finish time
- [ ] Finish time on the clock (from the start time)
- [ ] Spare or over against the session's length (amber under 3 minutes spare, red when over)
- [ ] Average intensity, weighted by time
- [ ] A coloured strip of intensity across the session

For each block:
- [ ] Distance, time and the clock time it starts

## 6. Session details

- [ ] Title (or one made from the date), date, AM/PM, start and end time
- [ ] Pool and lanes, coach, week key (e.g. 1.2.1), aim 1, aim 2
- [ ] Intensity scale for this session

## 7. Intensity scales

- [ ] Six scales: Effort /20, RPE 0–10, BPSC HR colours, Urbanchek colours, Sweetenham, Maglischo.
- [ ] Every value is stored on one common scale. Switching only changes the labels.
- [ ] A chart showing how the scales line up.
- [ ] Colours on every intensity, and a legend.

## 8. Poolside view

- [ ] Large text for reading on deck, with a tab for each group.
- [ ] Keeps the screen awake.

## 9. Outputs

- [ ] **Copy as text**
- [ ] **PDF:** club logo, "SILVER 1 · SESSION PLAN" header, week, group, aims; rounds drawn as lane ropes; coloured intensity pills; clock times for each block; ruled notes space; page numbers. One PDF per group, or all groups as a zip.
- ~~**Excel** in your own session-plan template, with working formulas~~ (dropped: PDF is enough)

## 10. Saved sessions

- [ ] A list of sessions, newest first, with totals.
- [ ] Copy a session to next week.
- [ ] Delete (tap twice to confirm).
- [ ] Saves automatically and syncs across devices.
- [ ] An offline copy, plus save and load of a library file.

## 11. Importing your Excel sessions

- [ ] Reads your session-plan Excel layout: blocks, rounds, groups, numbered lines, either/or, notes, aims, week key.
- [ ] Checks every block against the totals in your Excel file and explains any difference (a missing formula, a time typed in by hand, a total covering the wrong rows).
- [ ] Flags likely typos (faster than 50s per 100), sets with no send-off, and a title date that doesn't match the file name.
- [ ] Fills in usual start and end times when the sheet has none.

This already reads your 2022-onward Excel files. It's a head start for the history import.

---

## What changes in the app (my proposals, for you to check)

| Today | In the app |
|---|---|
| Its own list of saved sessions | The app's sessions, linked to the calendar slot, the week in the plan and the register |
| Nothing says who a session was for | Every session says **who it's for**: the whole squad, a group or sub group, a **camp** (linked to the camp in the season plan), or one swimmer. Several sessions can share a date and time (home squad and camp at once). The workers only count a session for the swimmers it was for, and the register confirms who actually swam it. |
| Week key typed in | Filled in from the season plan, and still editable |
| Intensity scale chosen per session | Your usual scale everywhere, with a different one allowed for a single session |
| Groups typed in for each session | **Groups start from the season plan** (e.g. Girls, Boys, sub groups), already holding the swimmers in them. Per session you can rename or re-split them (IM / No.1 stroke) and move individual swimmers. The register shows each swimmer's expected group, and you correct it on the day if someone swam a different set. |
| — | **Each swimmer's load counts only what they swam:** the shared blocks plus their own group's blocks, on the lane they were in. |
| Totals by distance, time and average intensity | Also time and distance in each intensity zone, worked out by code. This replaces the AI's estimate. |
| Nothing after the session | A quick "how it went / what changed" step |
| Light page | The app's dark theme, phone-first; poolside view kept |
| "SILVER 1", logo, usual times and the Excel template written into the code | Club and squad settings: the user sets the squad name and logo for the PDF header |
| PDF and Excel export | PDF only |
| Set-by-set dictation | Kept, plus talking the whole session through to Jess, who fills it in |
| — | Later: comments from the staff, pinned to lines |

It replaces the app's current Session Planner, the live session workshop and the print page.

**Proof it works:** your 16 saved sessions (21 Sep – 30 Oct) are copied across exactly and must give the same totals in the app as in the artifact. Some of them are Lanzarote camp sessions, so each is tagged as home squad or camp when it's copied (see question 5).

## Decisions (5 Nov 2026)

1. **Two lanes:** the register does **not** record which lane a swimmer was in. Load uses lane 1's send-off. The difference is only in time, not distance, and recording it adds work on deck. It can be added later if the staff find it matters.
2. **Outputs:** PDF only. The Excel **export** is dropped. The Excel **import** of your template is kept, because it reads your 2022-onward history.
3. **Speaking a session to Jess:** a new feature, not in the artifact. You talk the session through as you would to an assistant coach ("warm up 400 choice, then the girls do 3 rounds of 4×100 on 1:25 at 16, boys 200s…"). Jess fills the builder in as you speak, in the shared notation, and you correct by voice or tap. The parser checks every line she writes, so a line she gets wrong is flagged, not guessed. It reuses the app's existing voice set-up from the profile interview. The artifact's set-by-set dictation stays as the quick option that needs no AI.
4. **PDF header:** shows the squad name and club logo, set by the user in Settings. Nothing BPSC-specific is written into the code.
5. **Camp sessions:** taken from Dropbox, not the builder. `BPSC 2026-2027/Lanzarote/Sessions` holds 10 camp sessions (25–30 Oct), one PDF per group. `Silver 1/1.2.2` holds the home sessions for the same week. The builder's 29 and 30 Oct sessions match the home ones. One saved builder session (30 Oct PM) is Silver 2, so it's tagged with that squad.

**Found along the way:** this season's Silver 1 folders are organised by week code (`0.1.1` … `1.2.2`), so the import can take each session's week from its folder.
