import { Link } from 'react-router-dom'

// How the app works, for a coach opening it for the first time: the staff,
// what each one does, and how their work joins up around the coach.

const STAFF = [
  {
    name: 'Graham', title: 'Periodisation Planner', role: 'planner',
    does: 'Turns what the swimmers need into the season: blocks, weekly structure, lighter weeks, and where the peaks land against the meets.',
    reads: 'Your season plan, what was actually swum (sessions and the register), meet priorities, and what the others have found.',
    flags: 'No recovery week after a competition; a planned load the register shows isn\'t happening.',
  },
  {
    name: 'Jess', title: 'Session Writer', role: 'sessions',
    does: 'Writes and checks sessions in your style. Drafts a session from a short brief, and learns from every session you write.',
    reads: 'Your recent sessions, this week of the plan, who is likely to be there, and what Fiona and Tom say each swimmer needs.',
    flags: 'A session well over the pool time; the same group given hard sessions back to back.',
  },
  {
    name: 'Fiona', title: 'Physiologist', role: 'physiologist',
    does: 'Tracks what each swimmer\'s body is actually getting from training, from the sessions they came to (not the ones planned), and how they\'re coping.',
    reads: 'The register, the group each swimmer swam, metres in each training zone (worked out by the app, not guessed), responses (good / flat / ill / injured).',
    flags: 'A week-on-week load jump over 15%; a swimmer back from injury or illness; hard days stacked up; a growth spurt.',
  },
  {
    name: 'Tom', title: 'Performance Analyst', role: 'analyst',
    does: 'Where races are won and lost: times, splits, pacing and PBs against each swimmer\'s own history. Predicts race times and checks them against results.',
    reads: 'Race results and splits, LaneWatch race analysis, qualifying gaps, and the training before each race.',
    flags: 'Stays quiet when there is no new race evidence.',
  },
  {
    name: 'Erin', title: 'Swimmer Manager', role: 'manager',
    does: 'The swimmer as a person: attendance, availability, school year, injuries and sabbaticals, and whether their group and pathway still fit. Suggests group moves; you decide.',
    reads: 'Attendance, availability, status and each swimmer\'s profile.',
    flags: 'Attendance or wellbeing changing sharply; exam years and life load.',
  },
  {
    name: 'Rhys', title: 'Meet Manager', role: 'meets',
    does: 'The competition calendar: which meets are on, entries, timetables, and getting results recorded.',
    reads: 'The meets, entries and results.',
    flags: 'Two races too close together for a swimmer.',
  },
  {
    name: 'Maggie', title: 'Records Officer', role: 'records',
    does: 'Reads your old session files (Excel, Word, PDF) into the app, keeps a glossary of your shorthand, and asks when she\'s unsure. Speaks only about data.',
    reads: 'The folders of old sessions you point her at.',
    flags: 'Anything she can\'t read with confidence goes to you to check, never straight in.',
  },
]

const LOOP = [
  { step: 'Plan the season', where: '/season', label: 'Season',
    text: 'In the Season Planner you set the groups, phases, weekly loads and meets. The app\'s training groups follow it, and Graham, Fiona, Jess and Erin read the current week before they say anything.' },
  { step: 'Write the session', where: '/builder/new', label: 'Session Builder',
    text: 'A new session starts with that day\'s groups and swimmers from the plan. Jess can draft it from a brief. As you write, the staff pin short comments on the lines they\'re about.' },
  { step: 'Take the register', where: '/sessions', label: 'Sessions',
    text: 'Who came, which group they swam, how they responded, and whether it was swum as written. This is what the staff learn from, so a quick register matters more than anything else.' },
  { step: 'The staff write it down', where: '/workbooks', label: 'Staff workbooks',
    text: 'After each session Fiona and Jess update their workbooks from what actually happened. Each change is saved as a new version you can read, edit or undo.' },
  { step: 'The weekly review', where: '/workbooks', label: 'Staff workbooks',
    text: 'When you run it, Graham, Fiona, Tom and Jess each look back over the week: gaps (work not done for a while), links between training and performance, and how their predictions turned out. You get one short list.' },
]

function Section({ title, children, open = false }) {
  return (
    <details open={open} className="bg-pool-800 border border-pool-700 rounded-xl group">
      <summary className="cursor-pointer list-none px-4 py-3 flex items-center justify-between text-sm font-semibold text-pool-100">
        {title}<span className="text-pool-500 group-open:rotate-90 transition-transform">›</span>
      </summary>
      <div className="px-4 pb-4 space-y-3 text-sm text-pool-300 leading-relaxed">{children}</div>
    </details>
  )
}

export default function HelpGuide() {
  return (
    <div className="p-4 space-y-4 pb-10 max-w-2xl">
      <header className="pt-2 space-y-1">
        <Link to="/settings" className="text-xs text-accent-400">‹ Settings</Link>
        <h1 className="text-xl font-bold tracking-tight">How the app works</h1>
        <p className="text-pool-400 text-sm leading-relaxed">
          You coach. The app gives you a staff of seven specialists who read your plan, your sessions and your registers, keep notes,
          and speak up when they have something useful. They suggest; you decide. Nothing they write changes your plan or your sessions.
        </p>
      </header>

      <Section title="The idea in one minute" open>
        <p>Each member of staff has one job and a <b>workbook</b>: plain notes they write about the swimmers, the squad and their own area. Because they write things down, they remember from week to week, and you can see exactly what they think and why.</p>
        <p>They all read the same records: the <b>season plan</b>, the <b>sessions</b> you write, the <b>register</b> and <b>race results</b>. Numbers such as metres per training zone are worked out by the app, not guessed by the staff.</p>
        <p>They stay quiet when nothing would change a decision. When they do speak, a <b>safety flag</b> (for example a big jump in load) is kept until you acknowledge it. A <b>preference</b> you dismiss is remembered, so it isn't raised again.</p>
      </Section>

      <Section title="Meet the staff">
        <div className="space-y-3">
          {STAFF.map(s => (
            <div key={s.name} className="bg-pool-900/40 rounded-lg p-3 space-y-1">
              <p className="text-pool-100 font-semibold">{s.name} <span className="text-pool-400 font-normal">· {s.title}</span></p>
              <p>{s.does}</p>
              <p className="text-xs text-pool-400"><b className="text-pool-300">Reads:</b> {s.reads}</p>
              <p className="text-xs text-pool-400"><b className="text-pool-300">Speaks up about:</b> {s.flags}</p>
              <Link to={`/workbooks/${s.role}`} className="text-xs text-accent-400">Open {s.name}'s workbook ›</Link>
            </div>
          ))}
        </div>
      </Section>

      <Section title="How they work together: the weekly loop">
        <ol className="space-y-3">
          {LOOP.map((l, i) => (
            <li key={l.step} className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-accent-600/30 text-accent-300 text-xs grid place-items-center">{i + 1}</span>
              <div>
                <p className="text-pool-100 font-medium">{l.step} <Link to={l.where} className="text-xs text-accent-400 font-normal">{l.label} ›</Link></p>
                <p>{l.text}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="text-xs text-pool-400">Then round again: what the staff found feeds the next week of the plan and the next session.</p>
        <div className="bg-pool-900/40 rounded-lg p-3 text-xs text-pool-400 space-y-1">
          <p><b className="text-pool-300">Who passes what to whom</b></p>
          <p>Season plan → Graham, Jess, Fiona and Erin</p>
          <p>Register and responses → Fiona (load and recovery) and Erin (attendance)</p>
          <p>Fiona's view of each swimmer, and Tom's race targets → Jess, when she writes</p>
          <p>Race results → Tom (checks his predictions) and Rhys (records them)</p>
          <p>Your old session files → Maggie → Jess's notes on your style</p>
          <p>Everyone's findings → Graham, for the next block</p>
        </div>
      </Section>

      <Section title="Writing a session with the staff">
        <p><b>Ask the staff</b> gets a read from Graham, Fiona, Tom and Erin on the session as it stands. With <b>Comment as I write</b> on, they also take a look after you pause for a while. Their comments sit under the line they're about.</p>
        <p><b>Draft with Jess</b>: type or say a short brief ("aerobic Tuesday, 4,000, kick focus") and she writes it in your notation and your current style, using this week of the plan. Undo takes her draft out again.</p>
        <p>At the top of the builder, <b>staff notes from last time</b> shows what they wrote after recent sessions.</p>
      </Section>

      <Section title="Workbooks: what the staff write down">
        <p>Each workbook is a set of pages: one per swimmer, the squad, their own area, a watch list and a journal. Every note says how sure they are: a <b>hypothesis</b>, <b>seen once</b>, or a <b>pattern</b>.</p>
        <p>You can read and edit any page. Your edits win: if a member of staff and you change the same page, yours stands. You can <b>lock</b> a section so they can't change it, compare any two versions, restore an old one, or undo everything one update did.</p>
        <p>Each member of staff writes only in their own workbook. If a swimmer is deleted from the app, they're removed from every workbook as well.</p>
        <Link to="/workbooks" className="text-xs text-accent-400">Open the staff workbooks ›</Link>
      </Section>

      <Section title="Swimmers and groups">
        <p>Groups, and who is in each, are set on the <b>Squad tab of the Season Planner</b>: add or remove swimmers, change groups, or move someone between groups from a set week. The rest of the app follows it.</p>
        <p>Swimmers under <b>Not planned</b> (uni or visiting swimmers who come out of term) stay on the register so you can mark them in, but the staff don't plan for them. A swimmer removed from the planner is kept in the app as inactive, with their history.</p>
        <Link to="/season" className="text-xs text-accent-400">Open the Season Planner ›</Link>
      </Section>

      <Section title="Intensity scales">
        <p>Every intensity is stored on one common line (Effort /20). Your scale (colours, Sweetenham bands, RPE and so on) only changes how it's shown and typed, so you can switch scale or change one without changing any session.</p>
        <p>Pick your usual scale, make your own, or copy a standard one and change your copy. A single session can use a different scale.</p>
        <Link to="/settings/intensity-scales" className="text-xs text-accent-400">Manage intensity scales ›</Link>
      </Section>

      <Section title="Your old sessions (Maggie)">
        <p>Point Maggie at the folders your old sessions are in. She reads them in batches, checks totals where the file has them, and puts anything she's unsure of on your list rather than guessing.</p>
        <p>When she meets shorthand she doesn't know, she asks you once and adds it to her glossary. Jess then compares the years so you can tell her what you've <b>moved on from</b> and what's still your <b>current style</b>.</p>
        <Link to="/history-import" className="text-xs text-accent-400">Open Maggie's desk ›</Link>
      </Section>

      <Section title="What stays in your hands">
        <p>The staff never change your plan, your sessions or your groups. They comment, suggest and keep notes. Group moves, plan changes and anything about a swimmer's status are yours.</p>
        <p>Each club has its own staff and workbooks. What one club's staff learn stays with that club.</p>
        <p>AI costs are tracked in <Link to="/settings" className="text-accent-400">Settings</Link>.</p>
      </Section>
    </div>
  )
}
