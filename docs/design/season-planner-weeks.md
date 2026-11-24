# The season planner's weeks, timetable, meets and intensity

Agreed with the coach on 2026-11-24. The season planner (frontend/src/planner) was
built as a stand-alone artifact and brought into the app unchanged, so it kept its
own copies of three things the app already has: the intensity scales, the
pool timetable and the meet calendar. This design makes the app's copy the only
copy, and turns the planner's "Session templates" into a week-by-week micro
planner.

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

## 4. The Weeks tab (the micro planner, with the meso blocks in it)

Replaces the Sessions tab and its "Session templates" card.

* **Pick a plan line** at the top: a group or a swimmer.
* **One row per week**, grouped under a heading for each block of that line.
* **Block heading = the meso plan.** Its code (1.2), name, dates, aim, and its
  **standard week**: a focus (main, 2nd, optional 3rd) and notes for every
  session. Every week in the block starts from it. A standard week can be shared
  by several blocks; the heading says so and offers "Copy for this block only".
  The load mix (aerobic / anaerobic / speed ×) sits with it.
* **Week row = the micro plan.** For each week:
  * this line's code (1.3.1), Monday's date and the load;
  * every group's code that week (e.g. "Nationals 1.3.1 · Silver 1.2.8");
  * the next A meet and the next meet of any priority for this line, with days
    or weeks to go;
  * each session's focus and notes. A session changed for this week has a
    coloured edge and a Reset. Opening the row edits the week.
  * each session links to the real session for that date and slot: "Open" when
    it has been written, "Write" when it hasn't (the Session Builder opens it or
    starts it).
* **A swimmer who differs from their group has their own week**: picking them as
  the line and changing a session makes a change for them only, filed under the
  group they're in that week (as now).
* Earlier weeks fold away; the list opens on this week.
* At the bottom: the timetable (section 2) and the standard weeks no block uses.

## 5. What the staff see

The staff's week lines (season_planner.staff_lines) include the planned focus of
the session being written, for each group, so the Session Builder's staff write
to the plan.

## Order of work

1. Intensity: one set of scales, the zone-bar editor, plan values converted.
2. Timetable lined up with the Schedule page.
3. The Weeks tab.
4. Links from each week to the real sessions, and the plan's focus for the staff.
5. Meets lined up with the Meets tab.
