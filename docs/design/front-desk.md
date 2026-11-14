# The front desk: talking to the staff

Status: proposal, 14 Nov 2026. Not built. Builds on [workers-and-workbooks.md](workers-and-workbooks.md).

## 1. The idea

The coach presses one button, on any page, and talks. A **front desk** listens, works out who on the staff the coach needs, and hands them over: "I'll get Jess." The coach then has a normal conversation with that person, who uses the app's tools while they talk: drafting a session, changing gala entries, logging an injury. Anything that would change a record comes back as a proposal for the coach to tick, as everywhere else in the app.

The coach never needs to know who does what, or say a set phrase. In time they might ask for someone by name ("get me Fiona"), but they never have to.

Anything said that is for someone else, or for later, goes on a **job list** so nothing gets lost.

```
 COACH ── presses the button, talks
   │
 FRONT DESK ── listens all the time, works out who and what, hands over
   │           (fast, cheap model; never does the work itself)
   │
 WORKER ── talks it through with the coach, uses its tools, asks colleagues to check
   │        (Jess, Fiona, Tom, Graham, Erin, Rhys)
   │
 PROPOSALS ── the coach ticks or crosses; nothing changes before that
   │
 RECORDS
```

## 2. No set phrases

Today the AI chat decides what the coach wants by spotting words: "injury" plus "mark" means a status change; "taper" means the taper planner, and so on ([ai_chat.py](../../backend/routers/ai_chat.py) `_conversation_action` and the `_is_...` checks). That is rigid: say it differently and nothing happens.

The front desk works from **meaning**. It is given three things, none of them phrase lists:

| What it reads | Where it comes from |
|---|---|
| Who each worker is and what they look after | each worker's job description ([staff_room.py](../../backend/services/staff_room.py) `ROSTER`, later `job.md`) |
| What each worker can do | the tool list ([staff_actions.py](../../backend/services/staff_actions.py) `ACTIONS`, plus the new tools in section 9) |
| What is going on right now | tonight's and tomorrow's sessions, the next galas, swimmers' names, groups, the page the coach is on, and what they were last doing |

Because the second column is built from the tool list, adding a tool to a worker teaches the front desk about it automatically. Nobody maintains a list of phrases.

So "tonight's going to be a mess, half of them are at county trials" reaches Jess (tonight's session) and mentions Rhys (the trials), even though the coach never said "plan" or "session".

## 3. How it listens

**While the coach is talking**

1. The phone shows the words as they are said, using the phone's own live speech. It is free and instant, but weaker on names.
2. At each pause the front desk makes a quick guess from the words so far: *probably Jess, about tonight's 20:30 session*.
3. It does not hand over yet. It **gets that worker ready**: loads tonight's slot, who is expected, what the plan says for the week. So when the coach stops, the answer comes straight away.
4. If the sentence turns ("…actually it's more Ben's shoulder"), the guess quietly moves to Fiona. A guess only changes when the new one is clearly better, so it does not flicker.

**When the coach stops**

5. The recording goes to Whisper for an accurate copy (names spelled right).
6. The front desk makes its decision on the accurate copy and hands over: "I'll get Jess." If two people are needed, both come in.
7. If it is genuinely unsure, it asks **one** short question rather than guessing: "Tonight's, or Thursday's?"

**After the handover**

8. The front desk keeps listening. If the coach asks Jess "is Ben alright to do fly?", it brings Fiona in. Jess does not pretend to be a physiologist.
9. "No, I wanted Rhys" is a correction. The front desk hands over and remembers what it got wrong, so the same kind of request goes to the right person next time.
10. "Thanks, that's it" ends the conversation. The worker says what is waiting to be ticked.

**Cost.** The front desk's guesses are short calls to the cheap model (the same kind the staff-room chair uses now), a few a minute while the coach talks. The expensive model only runs when a worker does real work, like drafting a session.

## 4. A worker in conversation

A worker in a conversation is the same worker as in the staff room: same job description, same data, same workbook. What changes is that it **holds a conversation** and **uses tools** while it does.

- **Tools, not keywords.** Each worker is given its tools properly and decides mid-conversation when to use one. Reading tools (look up attendance, read the plan, read race splits) run straight away. Changing tools (enter a swim, log an injury) produce a proposal card.
- **The screen follows the conversation.** When Jess drafts the session, the Session Builder opens with the draft in it and the conversation carries on over the top. When Rhys talks about the county champs, the meet page opens. The coach can look, tap, or just keep talking.
- **Asking a colleague.** A worker can say "I'll get Fiona to check the load." Fiona reads the same thing and answers in her own voice. Disagreements are the coach's call, as in the staff room.
- **Voices.** Each worker speaks in their own voice ([staff_voice.py](../../backend/services/staff_voice.py)), a sentence at a time so it starts talking before it has finished writing (the way the profile interview already works, [interview_live.py](../../backend/services/interview_live.py)).

## 5. Rules

- **Nothing changes a record without the coach's tick.** Workers propose; the coach approves. Same as staff notes, the debrief and the check-ins.
- **A worker only acts inside its own remit.** If it needs something outside it, it brings in the person who owns it.
- **The front desk never does the work.** It hands over. Its only actions are opening a page and asking one clarifying question.
- **Thinking aloud is not an instruction.** "I'm wondering whether Josh should move up" starts a conversation with Erin, not a proposal. A proposal only appears when the coach asks for a change, or when a worker suggests one and the coach agrees.
- **Safety flags can't be talked away.** Same rule as the workers doc: a coach can acknowledge a load spike, not switch it off.
- **Waking the server.** The server sleeps when idle (the app already copes with this through `whenAwake`). Pressing the button wakes it straight away, so it is ready by the time the coach finishes the first sentence.

## 6. Examples

Swimmer names below are made up. Each example is marked:

- **Ready**: everything underneath exists; it only needs the front desk to reach it.
- **Partly**: the main part exists; something needs adding (said which).
- **Not wired**: the data or page is in the app, but no worker can do it from a conversation yet.

### 6a. The coach's own examples

**1. "Let's plan tonight's session."** → Jess, then Fiona. **Partly.**

> **Coach:** Let's plan tonight's session.
> **Front desk:** I'll get Jess.
> **Jess:** Tonight's Friday, 20:30 to 21:30, Silver 1. The plan has it as week 3 of the aerobic build, 200 pace the focus. Eighteen expected; Ben's still off with his shoulder. What do you want them to come away with?
> **Coach:** Aerobic, but I want some proper kick in there, they've been lazy on it.
> **Jess:** I'll keep the main set at 200 pace and put a kick set before it while they're fresh. Give me a second. *(The Session Builder opens with the draft.)* That's 4,200 in three blocks. I'll get Fiona to check the load.
> **Fiona:** Fine for week 3. One thing: the 8×50 kick on 1:00 is close to race pace that early. 1:05 keeps it aerobic.
> **Coach:** Yeah, do that.
> **Jess:** Changed. Do you want it marked ready?
> **Coach:** Go on.
> **Jess:** Done. It's on Home as Ready.

What exists: the session workshop (brief, draft, other staff review line by line, coach accepts) ([session_workshop.py](../../backend/services/session_workshop.py)), the builder's draft and staff review ([builder_staff.py](../../backend/services/builder_staff.py)), the Ready mark.
What's new: Jess talking the brief through instead of a typed brief; Jess opening the builder herself; Fiona's check arriving in conversation.

**2. "I want to update who's in the county champs and what they're swimming."** → Rhys, with Tom. **Partly.**

> **Rhys:** County champs, 6 and 7 December, entries close Friday. Nine entered. Who's changing?
> **Coach:** Take Amy out of the 200 fly, put her in the 100 back. And add Josh in the 50 free.
> **Rhys:** Amy's 100 back best this season is under the qualifying time, so that's fine. Josh hasn't swum a 50 free this season.
> **Tom:** His 100 free first split was 27.4 in October, so he'd be well inside. Worth it.
> **Rhys:** Three changes ready for you: Amy out of 200 fly, Amy into 100 back, Josh into 50 free. *(Proposal cards.)*

What exists: Rhys can add a meet and **add** entries; Tom reads times and splits; qualifying standards are in the app.
What's new: **changing and withdrawing entries**. Today's "Enter these swims" deliberately never drops an entry. A new tool is needed (section 9).

**3. "Can I talk to someone about a physiology question? It's about Christian."** → Fiona, one to one. **Partly.**

> **Fiona:** Sure. What are you seeing?
> **Coach:** He's dying on the back half of every 200 pace set. Fine for the first two reps, then he's gone.
> **Fiona:** He's been to 6 of the last 10 sessions, and two of the four he missed were the long aerobic Wednesdays. So he's getting the pace work but missing the base under it. Tom, how do his races look?
> **Tom:** Same shape. Last two 200s, second 100 was 4 to 5 seconds slower than the first.
> **Fiona:** I'd talk to him about Wednesdays before changing his sets. If he can't make them, I'd give him a longer aerobic set on the nights he does come. Want me to put a note on his next sessions?

What exists: Fiona and Tom already get each swimmer's load, attendance and race history when they speak in the staff room. A note on his sessions is an existing tool (Erin's "Add this note").
What's new: a one-to-one conversation (today they make one comment each), and Fiona being able to propose a note herself or hand that to Erin.

### 6b. Other things that would work straight away

Everything underneath these exists. They only need the front desk to reach the right person.

| The coach says | Who | What happens | |
|---|---|---|---|
| "Ben's off for two weeks, he's done his shoulder." | Erin, Fiona | Two cards: Ben unavailable until 28 Nov (Erin); shoulder injury logged (Fiona). Jess mentions tonight's fly set if Ben's group has one. | Ready |
| "Move Sophie up to Silver 1 from January." | Erin | Card: Sophie into Silver 1 from 5 Jan. Graham says if her pathway needs to change too. | Ready |
| "The Christmas gala's on the 13th of December, long course, it's a club level one." | Rhys | Card: new meet. Rhys asks where it is if it wasn't said. | Ready |
| "Results from Sunday. Amy 1:05.2 in the 100 back heat, 1:04.8 in the final…" | Rhys, Tom | Card: results recorded. Tom says whose targets that hits; predictions are checked automatically. | Ready |
| "Next week has to be lighter, half of them have mocks." | Graham, Fiona | Card: next week's load down. Erin offers to add the mocks to those swimmers' availability. | Ready |
| "Set Amy a target of 1:04 for the 100 back at counties." | Tom | Card: target set. | Ready |
| "Cancel Thursday morning, the pool's shut." | Front desk | Cancellation, as the chat does today. | Ready |
| "Everyone's in tonight except Ben and Amy." | Front desk | Opens the register filled in that way, as the chat's register already does. | Ready |
| "Let's debrief." | Front desk | Opens tonight's debrief, with the poolside notes already in. | Ready |
| "How's the block going?" / "Plan the taper for counties." | Graham | The block review and taper planner, which the chat reaches today by keyword. | Ready |
| "What do the staff need from me?" | Front desk | Reads out the list on Home: safety flags waiting, predictions to mark, workbook pages changed. | Ready |

### 6c. Could be done, not wired yet

The data or the page is in the app; no worker can reach it from a conversation. Each needs a tool added to a worker (section 9).

| The coach says | Who | What's there today | What's missing |
|---|---|---|---|
| "Copy this week's sessions into next week." | Jess | The builder's "copy to next week" | A tool for Jess |
| "Put the 200 pace target set on Friday's session." | Jess, Tom | Target sets can be linked to sessions | A tool to link them |
| "Tonight, Ben, Amy and Josh go in the fast lane." | Jess | The builder can say who swims each group | A tool for Jess |
| "Ben's only coming Mondays and Wednesdays this term." | Erin | Each swimmer's timetable and one-off changes | A tool for Erin (she can only add time away today) |
| "Add a 6am Saturday slot from January." | Graham | The timetable of slots | A tool, and deciding who owns the timetable |
| "Ben's back, clear his injury." | Fiona, Erin | Injuries can be marked resolved; status can go back to active | A tool to resolve an existing injury (Fiona can only log new ones) |
| "Christian's turns are loads better." (outside a session) | Erin | Swimmer observations | A tool for Erin (inside a session, poolside notes already cover it) |
| "Redo the goals bit of Amy's plan, she wants to swim at regionals." | Erin, Graham | Swimmer plans can be redrafted a section at a time | A tool to redraft a section |
| *(photo)* "Here's the county qualifying times." | Rhys, Tom | Reading standards and entry lists from a PDF or photo | Handing a photo to Rhys in conversation |
| *(photo)* "This is the gala timetable." | Rhys | Reading a meet timetable from a file | The same |
| "Tom said Amy would go under 1:05. She did." | Tom | Predictions the coach marks right or wrong | Marking one by voice |
| "Remember, I never want fly in the warm-up." | Front desk, Jess | The coach's Remember rules | Saving a rule by voice (always shown back for a tick) |
| "I want to talk about how the term's gone." | Front desk | Coach check-ins | Starting a check-in by voice |
| "Who hasn't been in for two weeks?" | Erin | Attendance figures | Nothing to change, just a reading tool so she can answer |
| "Pull in Christian's latest races from LaneWatch." | Tom | The LaneWatch link and race list | A reading tool for Tom |

### 6d. The awkward cases

How the front desk should behave when it isn't straightforward.

| The coach says | What should happen |
|---|---|
| "I'm wondering whether Josh should move up." | Erin talks it through: attendance, age, what the group above is doing. **No card** unless the coach says to do it. |
| "Plan Friday…" (two Friday sessions) | One question: "Morning or evening?" |
| "…for tonight, actually no, it's more about Ben's shoulder" | The guess moves from Jess to Fiona mid-sentence; Fiona answers. |
| "No, I wanted Rhys." | Rhys takes over; the front desk remembers that mistake. |
| "Remind me to email the parents about the gala." | Nobody on the staff can; it goes on the job list as the coach's own. |
| Half a sentence, then the coach is interrupted by a swimmer | Nothing is handed over until the coach finishes or presses again. The words stay on screen. |
| A name it can't match ("Kristen" when there's a Christian) | The worker checks: "Christian?" before anything is proposed about him. |
| Background noise at the pool | Press-and-hold to talk at the pool; hands-free only when it's quiet (section 10). |

## 7. The job list

Things said in passing that aren't the current conversation's business go on one list, so nothing is lost:

- for a worker: "Rhys: County relay entries, due Friday". The worker picks it up and turns it into a proposal next time it is relevant, or the coach taps it to start that conversation.
- for the coach: "Message Ben's mum". Just a reminder.

The list lives on Home under the staff's asks. Each job is **waiting for you**, **with a worker**, **done** or **dropped**. The front desk suggests the owner; a worker that thinks it isn't theirs passes it on rather than every worker reading every job.

## 8. What exists and what's new

| Part | Exists? | Where |
|---|---|---|
| Speech to text (accurate) | yes | Whisper, `/ai/transcribe`, [useWhisperVoice.js](../../frontend/src/hooks/useWhisperVoice.js) |
| Live words while talking | partly | the phone's speech is used, but only after the coach stops; showing words as they come needs switching on |
| Each worker's voice | yes | [staff_voice.py](../../backend/services/staff_voice.py) |
| Replies spoken a sentence at a time | yes, for the interview | [interview_live.py](../../backend/services/interview_live.py) |
| Choosing who should speak | yes, for the staff room | `choose_speakers` in [staff_room.py](../../backend/services/staff_room.py) |
| Workers' data about a swimmer, meet or week | yes | `role_context` in [staff_room.py](../../backend/services/staff_room.py) |
| Proposals the coach ticks | yes, 14 tools | [staff_actions.py](../../backend/services/staff_actions.py) |
| Session drafting and staff review | yes | session workshop, Session Builder |
| Background work that survives a dropped phone | yes | AI operations queue |
| **Front desk** (who and what, from meaning) | new | |
| **Guessing while the coach talks, getting the worker ready** | new | |
| **Conversation over every page, screen following it** | new | |
| **Workers using tools mid-conversation** | new | replaces keyword routing in the chat |
| **One-to-one and colleague check-ins in conversation** | new | |
| **Job list** | new | |
| **The tools in section 9** | new | |

## 9. New tools

From 6a and 6c. Each is a proposal the coach ticks, unless marked *reading*.

| Tool | Worker | Uses |
|---|---|---|
| Change or withdraw gala entries | Rhys | meet entries |
| Draft into the builder / change a line | Jess | session builder |
| Copy sessions to next week | Jess | builder copy |
| Who swims in which group tonight | Jess | builder groups |
| Link a target set to a session | Jess, Tom | target sets |
| Mark a session ready | Jess | ready mark |
| Set a swimmer's regular days | Erin | swimmer timetable |
| Add an observation | Erin | observations |
| Redraft a section of a swimmer plan | Erin, Graham | swimmer plans |
| Resolve an injury | Fiona | load events |
| Mark a prediction right or wrong | Tom (any worker for its own) | predictions |
| Save a Remember rule | front desk | coach guidance |
| Attendance, races, plan week | all | *reading* |
| Read a photo or PDF (standards, timetable, entries) | Rhys, Tom | existing extractors |

## 10. Build order

1. **The front desk and live listening.** The button on every page, live words, guesses at pauses, Whisper at the end, one clarifying question. At first it only hands over to things that exist already: opening the right page, the register, cancelling, the debrief, the block review. Useful on day one, and it replaces the chat's keyword routing.
2. **Jess, end to end** (example 1). Builds the conversation over a page, the screen following it, tools mid-conversation, and asking a colleague.
3. **Erin and Fiona** (example 3 and the 6b rows), on the tools they already have, plus one-to-one conversations.
4. **Rhys**, with changing and withdrawing entries (example 2).
5. **Graham and Tom.**
6. **The job list** and the rest of the section 9 tools, most useful first.

## 11. Risks

- **Acting on thinking aloud.** The biggest one. Mitigated by the tick on every change and the 6d rule; tuning which things become cards is most of the work.
- **Names.** The phone's live speech mishears them; Whisper is better but not perfect. Workers check a name before proposing anything about a swimmer.
- **Speed.** A conversation that waits three seconds per turn feels like a form. Getting the worker ready during the guess and speaking a sentence at a time are there for this.
- **Noise at the pool.** Hands-free listening will pick up everything. Press-and-hold at the pool.
- **Two routers.** The chat's keyword routing and the front desk must not both act on the same sentence. The front desk replaces it.
- **Cost.** Kept down by the cheap model for the front desk and short worker turns; watch the AI usage page after launch.
- **Privacy.** Swimmers' names and what is said about them already go to the AI and speech services; this sends more of it. Nothing new in kind, but more in amount.

## 12. Open questions

1. **Where is it mostly used?** Driving home, poolside, or at a desk. That decides hands-free vs press-and-hold as the default.
2. **Does the front desk have a name and a voice,** or is it just a quiet hand-over line?
3. **Spoken replies by default,** or written with a speaker button?
4. **Coach's own jobs:** plain reminders, or with a time ("remind me Thursday")?
5. **Who owns the timetable** (adding and moving slots): Graham, Erin, or the front desk?
