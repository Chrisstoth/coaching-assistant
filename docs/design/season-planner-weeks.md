# The season planner's weeks, timetable, meets and intensity

Agreed with the coach on 2026-11-24. The season planner (frontend/src/planner) was
built as a stand-alone artifact and brought into the app unchanged, so it kept its
own copies of three things the app already has: the intensity scales, the
pool timetable and the meet calendar. This design makes the app's copy the only
copy, and turns the planner's "Session templates" into a micro planner: one
week (or micro of any length) at a time, for every group and every swimmer
who differs.

The rule throughout: **one list of each thing in the app.** The planner keeps only
what is about planning (A/B/C targets, metres per hour, a session's role, the
week's focus), and shows the shared fields of everything else.

## 1. Intensity: one set of scales

* The scales are the ones in **Settings → Intensity scales**. The planner has no
  scales of its own any more. Its Weeks tab shows the scale in use as a zone bar,
  with a link to Settings to change it.
* Every focus in the plan is stored on the app's common line (Effort /20, 6–21,
  21 = speed / HVO), the same line every session is stored on. The plan carries
  `line: "common"` once converted.
* **Converting an older plan.** The planner's old line was RPE 1–21. Each value is
  carried across by its BPSC colour (what the coach sees today):
  White 10, Yellow 13.5, Pink 15.5, Red 17, Purple 18, Blue 19.5, Gold 21.
  This happens on the server when the plan is opened (and in the planner for a
  restored older version), so the colours on every sheet stay the same.
* The plan remembers which scale it is shown in (`scale`, a key from Settings).
  Unset, it uses the club's usual scale.
* **The scale editor** in Settings is a horizontal bar of zones. The coach picks
  how many zones (2–12), drags the edge between two zones (one zone ends where
  the next starts, so there are no gaps or overlaps), and names, colours and notes
  each zone. "Sits at" (the value stored when you type the zone) follows the
  middle of the zone unless the coach sets it.

## 2. Timetable: the Schedule page is the timetable

* Each planner session is tied to a pool slot (`slot`: PoolSlot id). The slots for
  a squad are its own slots plus every slot with no squad, the same rule as the
  register and the Today tab.
* When the plan opens, the server lines it up with the timetable:
  * a linked session takes the slot's day, times, hours and pool;
  * an older session with no link is matched to a slot on the same day and the
    same half of the day (AM / PM), keeping its id so its templates and
    changes stay with it; if none matches, a slot is made for it;
  * a slot with no planner session gets one (2,500 m an hour to start);
  * a session whose slot is deleted or turned off is put aside
    (`sessionsRetired`) and comes back with everything on it if the slot does.
* In the planner, day, time and pool are shown, not edited ("Edit in Schedule").
  The planner keeps the short name used for its columns ("Mon AM"), metres per
  hour and the session's role.
* **Groups in different slots (later).** Not needed yet. A session will be able
  to carry `groups: [groupId…]` (empty means every group), so a group can have a
  session the others don't. Nothing reads it yet; the week grid will show a blank
  cell for a group that isn't in that slot.

## 3. Meets: the Meets tab is the calendar

* Each planner meet is tied to an app meet (`meet`: Meet id). The planner shows
  every club meet that falls in the season, so a meet added in the Meets tab
  appears in the plan (with no A/B/C until the coach gives it one).
* When the plan opens, the server lines it up:
  * a linked meet takes the app's name, dates, course and venue;
  * an older planner meet with no link is matched on start date and name, or added
    to the Meets tab if it isn't there;
  * a meet deleted in the Meets tab leaves the plan.
* Editing a meet's name, dates, course or venue in the planner saves it to the
  Meets tab straight away; adding a meet in the planner adds it there. A meet is
  deleted from the Meets tab, not from the plan (it holds entries and results).
* Planner-only: the short name, A/B/C per group, the licence level (L1–L3), which
  qualifying times it uses, and its note.

## 4. Micros and the Weeks tab

Revised with the coach later on 2026-11-24. The first Weeks tab (a row for every
week, grouped under each block, for one group or swimmer at a time) was hard to
use. The timing of macros, mesos and micros is set on the Season tab by the bars,
so the Weeks tab doesn't repeat it: it is a look at one week (one micro) at a
time, where the coach plans the next few and looks back at the last.

### 4.1 Micros of any length

* A **micro is a run of dates**. By default it is a week, Monday to Sunday, and a
  coach who plans in weeks never sees anything else. A coach who plans in micros
  starts a new micro on any day: lengths are free (8, 6, 4 days; alternating
  weeks), and nothing assumes they repeat.
* The season chart has **one bar per micro** (as wide as its days), and the load
  is set per micro.
* What a micro holds comes from the timetable: the sessions that fall on its dates.
* **Planned sessions are found by their date and pool slot.** The plan still
  keeps everything per column (loads, blocks, session changes, group moves, a
  short-term group's weeks); when micro edges move, each is carried to the
  column its date now falls in (setMicros), so nothing planned is lost. A
  session that comes round twice in one micro is told apart ("monam~2").
* A **standard micro** (today's "standard week") is an ordered list of sessions
  (1st session aerobic, 2nd threshold, and so on), laid over the sessions a
  micro holds, in order. A 7-day standard week behaves exactly as now. Sessions
  past the end of the list start blank.
* Built: micros are the same for every group in the plan (one set of columns,
  settings.micros). Different micros for different groups can come later if
  a coach needs them.

### 4.2 The week view

Simplified with the coach on 2026-11-25: set things up once, then just fill in the week.

* **A strip of every micro** along the top replaces the arrows and the overview:
  each chip has a bar for its load and block, a dot when someone isn't with their
  group, and × when a session was cancelled. More than 3 ahead is faded.
* **What happened** (the record) sits beside the micro (left on a big screen,
  above on a phone): the whole of the micro before, as it was swum. Sessions
  written, metres, who came, cancelled sessions struck through, extra sessions,
  each with its PDF, and the planned focus alongside. It is recessed and dashed,
  with nothing to type into: it is for looking back (cancellations, the shape of
  the week). ‹ › go further back.
* **The plan** (raised, blue along the top): each group's sessions as tappable
  rows (focus, a short note, versions with how many are on each, written / to
  write / cancelled). A tap opens the session in a sheet: focus, notes, this
  micro's versions, last time, Write or Open ›.
* **Where a group's sessions come from**: a dropdown on each group, "Its own
  sessions" or "Same as" any other group (`branch.follow`; unset = its parent
  while on the same block). A group copying another folds to one line until one
  session is changed just this micro. Loops fall back to the block's usual week.
* **Weeks roll forward**: a micro nobody changed shows the block's usual week,
  faded. "Use it for every week of <block>" makes a changed micro the usual one.
* **Not with their group** (amber along the top): one list, each swimmer once,
  with the reason (own load, time away, camp, a session changed, Right now
  injury or illness). A swimmer differs only where their season chart bar
  differs from their group's; a version of a session or coming to fewer sessions
  is not differing. Same differences share a line; each line opens to edit.
* The timetable, **How the season is split** (weeks or micros) and **Session
  versions** are on the Calendar tab.

### 4.3 Versions of a session

* **Versions are set once on the timetable** (the Calendar tab, `sessions[].v`)
  and apply every micro; a block's usual week, or one micro ("Split it just this
  week"), can still have its own.
* A session can have **versions, each saying who it is for**: swimmers who did
  certain sessions, swimmers who missed any of them, named swimmers, or everyone
  else (the default). For example, Wednesday AM is recovery for those who did
  Monday PM and Tuesday PM, and speed and pace for everyone else.
* **A version is part of the plan.** A swimmer on it is following their group.
* "Did" and "missed" look at the last time each named session ran, up to 14
  days back, so Monday can depend on Saturday in the micro before.
* **Who gets which version** comes from each swimmer's usual sessions (4.4) ahead
  of time, and from the register and time away once they are known,
  automatically: marked absent Tuesday, on the other version Wednesday.
* The Session Builder opens the session **already split into its versions**,
  with the right swimmers in each.
* Each swimmer's plan sheet shows the version they are on. Their load stays on
  the group's line; the mix of work in it is what changes.

### 4.4 Usual sessions: one list

* Each swimmer's usual sessions are the Schedule page's list of who comes to each
  slot (SwimmerSlot), the list the register already uses for "expected". It is
  edited there, slot by slot, and on the swimmer's own page ("Usual sessions",
  a tick for each slot): one list, either place.
* A swimmer who comes to fewer sessions has the group's plan for the sessions
  they come to; that is not differing.
* **History check.** The swimmer manager compares the register with each
  swimmer's usual sessions. When a swimmer has missed a usual session the last 4
  times it ran (not counting time away, injury or a cancelled session), or come
  to one that isn't on their list the last 4 times, a staff note asks the
  coach, for example "Sam hasn't been to Monday PM in 5 weeks. Take it off Sam's
  usual sessions?", with Take it off / Keep it. The list never changes by itself.

### 4.5 Links to what actually happened

* A **cancelled session** is struck through in its micro with the reason, its
  share comes off the micro's load for everyone in it (as time away does), and it
  shows on the swimmers' plan sheets. Its focus is not moved anywhere by itself.
* An **extra session** for picked swimmers shows in its micro with those
  swimmers, and counts towards their load.
* The swimmer's plan sheet shows **the next 4 micros**: their versions, their
  differences, time away and cancelled sessions.

### 4.6 The overview

Replaced on 2026-11-25 by the strip of micros at the top of the Weeks tab.

## 5. What the staff see

**Today** shows the staff a guide to the micro (season_planner.guide, on
`/season-planner/{squad}/week`): the block and how far through it, each group's
sessions with their versions and who is on each, who isn't with their group, and
what was cancelled last time. Each person can hide it ("Got it") until the next
micro starts; "Open the week" opens the planner on the Weeks tab.

The staff's week lines (season_planner.staff_lines) include the planned focus of
the session being written, for each group and each version, so the Session
Builder's staff write to the plan.

## Order of work

Done: one set of scales, the timetable lined up with the Schedule page, meets
lined up with the Meets tab, and the first Weeks tab with its links to sessions.

The redesign (section 4), built on 2026-11-24 in these steps:

1. Usual sessions, one list: the swimmer's page edits the Schedule page's list;
   the history check.
2. Planned sessions kept by date and slot (carrying today's per-week changes over).
3. The week view, in weeks: this week, ◀ ▶, faded far ahead, last week folded
   under each group, Open › to the PDF, cancelled and extra sessions. The
   timetable moves to the Calendar tab.
4. Versions of a session, with the Session Builder opening already split and the
   plan sheet's next 4 weeks.
5. Swimmers who differ, with the Right now prompts.
6. The overview grid.
7. Micros of any length, with one bar per micro.
