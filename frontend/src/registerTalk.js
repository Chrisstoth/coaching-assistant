/* Taking the register by talking.

   The coach says who is here and which group they swam in, in whatever order
   comes naturally:

     "Group 1 Girls: Amy, Sophie, Ella. Group 2: Josh, Ben."
     "Amy group 1, Josh group 2, Ben's off."
     "Everyone's in except Ben and Chloe."
     "Everyone else in group 3."

   This runs on the phone with no server and no AI: it only has to pick from
   the squad's names and the session's group names, so it can tick swimmers
   as the words arrive. Anything it is not sure of is listed for a tap rather
   than guessed. The whole transcript is re-read each time, so a later word
   ("…group 2") can settle an earlier one ("Amy…").

   Saying it wrong and putting it right works too: "Amy, no sorry, Ella",
   "Amy group 2, actually group 1".

   Swimmers: [{ id, name, excused }]. Groups: [{ number, label, subs: ['A', 'B'] }].
   Aliases: [{ heard, swimmer_id }], what the phone writes for a name, taught
   by the coach's taps ("Neve" is Niamh, "Olly" is Oliver).
*/

const NUMBER_WORDS = {
  one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, tree: 3, four: 4, for: 4, fore: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}

// Words that carry nothing on their own.
const FILLER = new Set([
  'and', 'is', 'are', 'the', 'a', 'an', 'um', 'uh', 'er', 'erm', 'also', 'then', 'plus', 'so', 'ok', 'okay',
  'right', 'now', 'oh', 'well', 'just', 'was', 'were', 'has', 'have', 'been', 'be', 'they', 'theyre', 'he',
  'she', 'hes', 'shes', 'with', 'of', 'tonight', 'today', 'this', 'morning', 'evening', 'session', 'register',
  'take', 'taking', 'lets', 'let', 'i', 'want', 'to', 'for', 'go', 'in', 'on', 'at', 'did', 'swam', 'swimming',
  'doing', 'who', 'there', 'please', 'yes', 'yeah', 'no', 'thats', 'that', 'it', 'its', 'we', 'got',
  'sub', 'lane', 'put', 'them', 'him', 'her', 'into', 'as', 'like', 'mark', 'marked', 'group',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'am', 'pm',
])

// Phrases, as normalised words. The longest match wins at each point.
const PHRASES = {
  // A swimmer who isn't here. Said after a name ("Ben's off") or before a list ("absent: Ben, Amy").
  absent: [
    ['off'], ['out'], ['absent'], ['away'], ['missing'], ['ill'], ['sick'], ['injured'], ['off', 'sick'],
    ['not', 'here'], ['isnt', 'here'], ['arent', 'here'], ['not', 'in'], ['isnt', 'in'], ['arent', 'in'],
    ['not', 'coming'], ['not', 'there'], ['didnt', 'come'], ['no', 'show'], ['cant', 'make', 'it'],
  ],
  // Only ever about the names that follow.
  except: [['except'], ['apart', 'from'], ['but', 'not'], ['without'], ['other', 'than'], ['not']],
  present: [['here'], ['in'], ['present'], ['came'], ['turned', 'up']],
  // Not a bare "all": "that's all" is the end of a list, not everyone in.
  all: [
    ['everyone'], ['everybody'], ['the', 'whole', 'squad'], ['whole', 'squad'], ['all', 'of', 'them'],
    ['all', 'in'], ['all', 'here'], ['all', 'present'], ['all', 'there'],
  ],
  rest: [
    ['everyone', 'else'], ['everybody', 'else'], ['the', 'rest'], ['rest'], ['rest', 'of', 'them'], ['anyone', 'else'],
    ['all', 'the', 'rest'], ['all', 'the', 'others'], ['the', 'others'], ['others'],
  ],
  // Putting the last thing right: it is taken back, then the next words replace it.
  correct: [
    ['no'], ['sorry'], ['no', 'sorry'], ['sorry', 'no'], ['i', 'mean'], ['no', 'i', 'mean'], ['sorry', 'i', 'mean'],
    ['actually'], ['no', 'actually'], ['scratch', 'that'], ['not', 'that'], ['oops'], ['wait'], ['no', 'wait'],
    ['correction'], ['my', 'mistake'],
  ],
  nobody: [
    ['nobody', 'else'], ['no', 'one', 'else'], ['noone', 'else'], ['that', 'is', 'everyone'], ['that', 'is', 'everybody'],
    ['thats', 'everyone'], ['thats', 'everybody'], ['nobody', 'else', 'came'], ['that', 'is', 'all'], ['thats', 'all'],
  ],
}
const PHRASE_KINDS = Object.entries(PHRASES).map(([kind, list]) => ({ kind, list: list.map(w => ({ words: w })) }))
const KEYWORDS = new Set(Object.values(PHRASES).flat(2))

/* Words, lower case, with the original spelling kept for "didn't catch".
   "Ben's off" → ben is off; "group one" → group 1; "1A" → 1 a. */
export function tokenize(text) {
  const cleaned = String(text || '')
    .replace(/[’‘`]/g, "'")
    .replace(/(\w)'s\b/gi, '$1 is')
    .replace(/'/g, '')
    .replace(/(\d)([a-z])/gi, '$1 $2')
  const tokens = cleaned.split(/[^A-Za-z0-9]+/).filter(Boolean).map(r => ({ w: r.toLowerCase(), raw: r }))
  // "group one" / "group to" → group 1 / group 2: straight after "group",
  // "to" and "for" can only be numbers.
  tokens.forEach((t, i) => {
    if (i > 0 && tokens[i - 1].w === 'group' && NUMBER_WORDS[t.w]) t.w = String(NUMBER_WORDS[t.w])
  })
  return tokens
}

const words = text => tokenize(text).map(t => t.w)

/* A rough sound-alike key: Sophie / Sofie, Caitlin / Kaitlyn, Jazz / Jaz. */
export function soundKey(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '')
  if (!w) return ''
  const s = w.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c(?=[aou])/g, 'k').replace(/^c/, 'k')
    .replace(/z/g, 's').replace(/q/g, 'k').replace(/x/g, 'ks')
  return (s[0] + s.slice(1).replace(/[aeiouyhw]/g, '')).replace(/(.)\1+/g, '$1')
}

function editDistance(a, b) {
  if (a === b) return 0
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    let diag = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const keep = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = keep
    }
  }
  return row[b.length]
}

const GROUP_STOP = new Set(['group', 'groups', 'squad', 'the', 'and', 'lane', 'lanes', 'session'])

/* Everything the coach might say: each swimmer's and each group's phrases. */
export function buildVocabulary({ swimmers = [], groups = [], aliases = [] } = {}) {
  const people = swimmers.map(s => {
    const parts = words(s.name)
    return { id: s.id, name: s.name, excused: Boolean(s.excused), parts, first: parts[0] || '', last: parts[parts.length - 1] || '' }
  })
  const count = test => people.filter(test).length
  const swimmerPhrases = []
  for (const p of people) {
    if (p.parts.length > 1) swimmerPhrases.push({ words: p.parts, ids: [p.id] })
    // A first name: one swimmer, or several to choose between ("which Ben?").
    if (p.first) {
      const same = people.filter(o => o.first === p.first).map(o => o.id)
      if (same[0] === p.id) swimmerPhrases.push({ words: [p.first], ids: same })
    }
    // A surname alone, only when it can't be anyone else or an ordinary word.
    if (p.parts.length > 1 && p.last.length >= 4 && !KEYWORDS.has(p.last) && !FILLER.has(p.last)
      && count(o => o.last === p.last) === 1 && count(o => o.first === p.last) === 0) {
      swimmerPhrases.push({ words: [p.last], ids: [p.id] })
    }
  }

  // Taught names first, so they win over a sound-alike guess.
  const ids = new Set(people.map(p => p.id))
  for (const a of aliases) {
    const w = words(a.heard)
    if (w.length && ids.has(a.swimmer_id)) swimmerPhrases.unshift({ words: w, ids: [a.swimmer_id] })
  }

  const groupList = groups.map(g => {
    const label = (g.label || '').trim() || `Group ${g.number}`
    return { number: g.number, label, subs: (g.subs || []).map(x => String(x).toLowerCase()), parts: words(label) }
  })
  const groupPhrases = []
  for (const g of groupList) {
    groupPhrases.push({ words: g.parts, number: g.number })
    // A word only this group's name has: "girls", "sprint", "distance".
    for (const w of g.parts) {
      if (w.length < 3 || /^\d+$/.test(w) || GROUP_STOP.has(w) || FILLER.has(w) || KEYWORDS.has(w)) continue
      if (groupList.filter(o => o.parts.includes(w)).length === 1) groupPhrases.push({ words: [w], number: g.number })
    }
  }
  // "group 2": the group whose name says "group 2", if only one does; otherwise group number 2.
  const numbers = new Set([...groupList.map(g => g.number), ...groupList.map((_, i) => i + 1)])
  for (const n of numbers) {
    const named = groupList.filter(g => ` ${g.parts.join(' ')} `.includes(` group ${n} `))
    const target = named.length === 1 ? named[0] : groupList.find(g => g.number === n)
    if (target) groupPhrases.push({ words: ['group', String(n)], number: target.number })
  }
  return { people, groups: groupList, swimmerPhrases, groupPhrases }
}

function matchAt(tokens, i, phrases) {
  let best = null
  for (const p of phrases) {
    const n = p.words.length
    if (!n || i + n > tokens.length) continue
    let ok = true
    for (let k = 0; k < n; k += 1) if (tokens[i + k].w !== p.words[k]) { ok = false; break }
    if (ok && (!best || n > best.words.length)) best = p
  }
  return best
}

// Near enough to a first name or surname to suggest, never to tick on its own.
function nearSwimmer(word, vocab) {
  if (word.length < 3 || FILLER.has(word) || KEYWORDS.has(word) || NUMBER_WORDS[word] || /^\d+$/.test(word)) return null
  if (vocab.groupPhrases.some(p => p.words.includes(word))) return null
  const key = soundKey(word)
  const hits = new Set()
  for (const p of vocab.people) {
    for (const part of [p.first, p.last]) {
      if (!part || part.length < 3) continue
      const limit = part.length >= 7 ? 2 : part.length >= 4 ? 1 : 0
      if ((key.length >= 2 && soundKey(part) === key) || (limit && editDistance(word, part) <= limit)) hits.add(p.id)
    }
  }
  return hits.size ? [...hits] : null
}

/* Read the transcript into what the coach said, in order. */
export function readRegisterTalk(text, vocab) {
  const tokens = tokenize(text)
  const items = []
  for (let i = 0; i < tokens.length;) {
    const group = matchAt(tokens, i, vocab.groupPhrases)
    const swimmer = matchAt(tokens, i, vocab.swimmerPhrases)
    let kind = null, phrase = null
    for (const { kind: k, list } of PHRASE_KINDS) {
      const m = matchAt(tokens, i, list)
      if (m && (!phrase || m.words.length > phrase.words.length)) { kind = k; phrase = m }
    }
    const longest = Math.max(group?.words.length || 0, swimmer?.words.length || 0, phrase?.words.length || 0)
    const joined = tokens[i - 1]?.w === 'and'

    if (longest && group?.words.length === longest) {
      let used = longest
      let sub = null
      const g = vocab.groups.find(x => x.number === group.number)
      // "Group 1 A", "group 1 sub group A"
      let j = i + used
      if (tokens[j]?.w === 'sub') { j += 1; if (tokens[j]?.w === 'group') j += 1 }
      const next = tokens[j]?.w
      if (g?.subs.length && next && g.subs.includes(next)) { sub = next.toUpperCase(); used = j + 1 - i }
      items.push({ type: 'group', number: group.number, sub })
      i += used
      continue
    }
    if (longest && swimmer?.words.length === longest) {
      items.push({
        type: 'swimmer', ids: swimmer.ids, unsure: swimmer.ids.length > 1, kind: 'ambiguous', joined,
        heard: tokens.slice(i, i + longest).map(t => t.raw).join(' '),
      })
      i += longest
      continue
    }
    if (longest && phrase) {
      items.push({ type: kind })
      i += longest
      continue
    }
    const t = tokens[i]
    const near = nearSwimmer(t.w, vocab)
    if (near) items.push({ type: 'swimmer', ids: near, unsure: true, kind: 'near', heard: t.raw, joined })
    else if (!FILLER.has(t.w) && !/^\d+$/.test(t.w) && t.w.length >= 3 && /^[A-Z]/.test(t.raw)) items.push({ type: 'unknown', heard: t.raw })
    i += 1
  }
  return items
}

/* What the register should look like after what was said.

   `entries`: the register as it stood when the coach started talking
   ([{ swimmer_id, attended, group_done, sub_group_done }]).
   `unnamedOut`: once the coach has named anyone as here, anyone not named is
   marked out (taking the register by naming who's in). Off: left as they were,
   unless "nobody else" is said.
   `useGroups`: false for a whole-squad session, where groups are ignored. */
export function applyRegisterTalk(text, vocab, entries, { unnamedOut = true, useGroups = true } = {}) {
  const items = readRegisterTalk(text, vocab)
  const known = new Set(entries.map(e => e.swimmer_id))
  const excused = new Set(vocab.people.filter(p => p.excused).map(p => p.id))

  // Who was said, and what about them. Built in order, then applied.
  let said = new Map()        // id -> { attended, group, sub }
  let bulk = []               // { scope: 'all' | 'rest', attended, group, sub }
  let unsure = []             // { heard, ids, kind }
  const unknown = []
  let nobodyElse = false
  let style = null            // 'forward': "Group 1: Amy, Ben"; 'backward': "Amy group 1"
  let current = null          // forward style: the group being read out
  let run = []                // names said as here, still waiting for a group
  let absentMode = false      // after "except Ben…" / "not Ben…"
  let open = null             // an "everyone else…" waiting to hear what it means
  let last = null             // the previous thing said

  // Before each thing said, how things stood: a correction goes back one step.
  const history = []
  const snapshot = () => history.push({
    said: new Map([...said].map(([id, c]) => [id, { ...c }])),
    bulk: bulk.map(b => ({ ...b })),
    open: bulk.indexOf(open),
    unsure: unsure.length, nobodyElse, style, current, run: [...run], absentMode, last,
  })
  const goBack = () => {
    const was = history.pop()
    if (!was) return
    said = was.said
    bulk = was.bulk
    open = was.open >= 0 ? bulk[was.open] : null
    unsure = unsure.slice(0, was.unsure)
    ;({ nobodyElse, style, current, absentMode, last } = was)
    run = was.run
  }

  const setGroup = (entry, g) => { entry.group = g.number; entry.sub = g.sub }
  const markOut = id => { said.set(id, { attended: false, group: null, sub: null }); run = run.filter(x => x !== id) }

  for (let k = 0; k < items.length; k += 1) {
    const it = items[k]
    if (it.type === 'unknown') { unknown.push(it.heard); continue }
    if (it.type === 'correct') {
      // "no, sorry" said twice over is still one step back.
      if (last?.type !== 'correct') goBack()
      last = it
      continue
    }
    snapshot()

    if (it.type === 'swimmer') {
      open = null
      if (it.unsure || !known.has(it.ids[0])) {
        unsure.push({ heard: it.heard, ids: it.ids.filter(id => known.has(id)), kind: it.kind || 'near' })
      } else if (absentMode) {
        markOut(it.ids[0])
      } else {
        const entry = { attended: true, group: null, sub: null }
        if (style === 'forward' && current) setGroup(entry, current)
        said.set(it.ids[0], entry)
        run = [...run.filter(x => x !== it.ids[0]), it.ids[0]]
      }
      last = it
      continue
    }

    if (it.type === 'group') {
      if (open) { open.attended = true; setGroup(open, it); open = null; last = it; continue }
      absentMode = false
      // The first group said settles the style: names already waiting means "Amy group 1".
      if (!style) style = run.length ? 'backward' : 'forward'
      if (style === 'forward') current = it
      else for (const id of run) setGroup(said.get(id), it)
      run = []
      last = it
      continue
    }

    if (it.type === 'absent') {
      if (open) { open.attended = false; open = null }
      else if (last?.type === 'swimmer' && !absentMode) {
        // "Ben's off", "Ben and Amy are off": the name just said, and any joined to it by "and".
        for (let b = k - 1; b >= 0 && items[b].type === 'swimmer'; b -= 1) {
          const prev = items[b]
          if (!prev.unsure && known.has(prev.ids[0])) markOut(prev.ids[0])
          if (!prev.joined) break
        }
      } else if (items[k + 1]?.type === 'swimmer') absentMode = true // "absent: Ben, Amy"
      last = it
      continue
    }

    if (it.type === 'except') {
      // "not" means "not Ben" only when a name follows it.
      if (items[k + 1]?.type === 'swimmer') absentMode = true
      open = null
      last = it
      continue
    }

    if (it.type === 'present') {
      absentMode = false
      if (open) {
        open.attended = true
        // "everyone else in group 3": the group still to come belongs to it.
        if (items[k + 1]?.type !== 'group') open = null
      }
      last = it
      continue
    }

    if (it.type === 'all' || it.type === 'rest') {
      open = { scope: it.type, attended: true, group: null, sub: null }
      bulk.push(open)
      absentMode = false
      last = it
      continue
    }

    if (it.type === 'nobody') { nobodyElse = true; open = null; last = it }
  }

  // Apply: everyone first, then the names, then "the rest", then the unnamed.
  const result = entries.map(e => ({ ...e }))
  const byId = new Map(result.map(e => [e.swimmer_id, e]))
  const groupOk = g => useGroups && g != null
  const put = (e, change) => {
    e.attended = change.attended
    if (change.attended && groupOk(change.group)) { e.group_done = change.group; e.sub_group_done = change.sub || null }
  }
  for (const b of bulk.filter(x => x.scope === 'all')) {
    // Like "All present": swimmers known to be away stay as they are.
    for (const e of result) if (!(b.attended && excused.has(e.swimmer_id))) put(e, b)
  }
  for (const [id, change] of said) put(byId.get(id), change)
  const named = new Set(said.keys())
  for (const b of bulk.filter(x => x.scope === 'rest')) {
    for (const e of result) {
      if (named.has(e.swimmer_id)) continue
      if (b.attended && excused.has(e.swimmer_id)) continue
      // "the rest in group 3" is the rest of who's marked in, not the whole squad.
      if (b.attended && b.group != null && !e.attended) continue
      put(e, b)
    }
  }
  // Naming who's here: anyone not named is out.
  const namedHere = [...said.values()].some(c => c.attended)
  const unnamedGoOut = namedHere && bulk.length === 0 && (nobodyElse || unnamedOut)
  if (unnamedGoOut) for (const e of result) if (!named.has(e.swimmer_id)) e.attended = false

  const nameOf = id => vocab.people.find(p => p.id === id)?.name || ''
  const groupName = (n, sub) => `${vocab.groups.find(g => g.number === n)?.label || `Group ${n}`}${sub ? ` ${sub}` : ''}`
  return {
    entries: result,
    heard: [...said].map(([id, c]) => ({ id, name: nameOf(id), attended: c.attended, group: groupOk(c.group) ? groupName(c.group, c.sub) : null })),
    bulk: bulk.map(b => ({ scope: b.scope, attended: b.attended, group: groupOk(b.group) ? groupName(b.group, b.sub) : null })),
    // 'ambiguous': a first name two swimmers share. 'near': sounds like a name, not quite it.
    unsure: unsure.map(u => ({ heard: u.heard, ids: u.ids, kind: u.kind, names: u.ids.map(nameOf).filter(Boolean) })),
    unknown: [...new Set(unknown)],
    unnamedMarkedOut: unnamedGoOut,
    mentionedGroups: items.some(it => it.type === 'group'),
  }
}

/* The coach tapped who they meant: put the full name into what was said, so
   the next read treats it like any other name (with its group, in or out). */
export function resolveHeard(text, heard, name, vocab) {
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Not where a full name is already said ("Ben Jones" stays Ben Jones).
  const surnames = [...new Set((vocab?.people || []).filter(p => p.parts.length > 1).map(p => p.parts.slice(1).join('\\s+')))]
  const guard = surnames.length ? `(?!\\s+(?:${surnames.join('|')})\\b)` : ''
  return String(text).replace(new RegExp(`\\b${escape(heard)}\\b${guard}`, 'gi'), name)
}

/* Spelling help for the slower recorded fallback: the names it will hear. */
export function namesPrompt(vocab) {
  const names = vocab.people.map(p => p.name).join(', ')
  const groups = vocab.groups.map(g => g.label).join(', ')
  return `Swimming register. Groups: ${groups || 'none'}. Swimmers: ${names}.`
}
