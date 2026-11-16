import assert from 'node:assert/strict'

const { buildVocabulary, applyRegisterTalk, readRegisterTalk, resolveHeard, soundKey, tokenize } = await import('../src/registerTalk.js')

const swimmers = [
  { id: 1, name: 'Amy Stone' },
  { id: 2, name: 'Sophie Clarke' },
  { id: 3, name: 'Ella Hughes' },
  { id: 4, name: 'Josh Patel' },
  { id: 5, name: 'Ben Carter' },
  { id: 6, name: 'Ben Jones' },
  { id: 7, name: 'Chloe Wright' },
  { id: 8, name: 'Caitlin Moss', excused: true },
]
const groups = [
  { number: 1, label: 'Group 1 Girls', subs: [] },
  { number: 2, label: 'Group 1 Boys', subs: [] },
  { number: 3, label: 'Distance', subs: ['A', 'B'] },
]
const vocab = buildVocabulary({ swimmers, groups })
// The register when talking starts: expected swimmers already marked in.
const start = swimmers.map(s => ({ swimmer_id: s.id, attended: [1, 2, 3, 4, 5].includes(s.id), group_done: null, sub_group_done: null }))
const run = (text, options) => applyRegisterTalk(text, vocab, start, options)
const state = (result, id) => result.entries.find(e => e.swimmer_id === id)

// --- words -------------------------------------------------------------------
assert.deepEqual(tokenize("Ben's off, group one").map(t => t.w), ['ben', 'is', 'off', 'group', '1'])
assert.deepEqual(tokenize('group to 1A').map(t => t.w), ['group', '2', '1', 'a'])
assert.equal(soundKey('Sophie'), soundKey('Sofie'))
assert.equal(soundKey('Caitlin'), soundKey('Kaitlyn'))

// --- group name first, then who's in it --------------------------------------
{
  const r = run('Group 1 Girls Amy Sophie Ella. Group 1 Boys Josh and Ben Carter')
  assert.equal(state(r, 1).group_done, 1)
  assert.equal(state(r, 3).group_done, 1)
  assert.equal(state(r, 4).group_done, 2, '"Group 1 Boys" is its own group, not group 1.')
  assert.equal(state(r, 5).group_done, 2)
  assert.equal(state(r, 5).attended, true)
  assert.equal(state(r, 7).attended, false, 'Not named while naming who is here: out.')
  assert.equal(r.unnamedMarkedOut, true)
}

// --- a distinctive word is enough: "girls", "boys", "distance" ---------------
{
  const r = run('girls: Amy, Chloe. boys: Josh. distance B: Ella')
  assert.equal(state(r, 7).group_done, 1)
  assert.equal(state(r, 4).group_done, 2)
  assert.equal(state(r, 3).group_done, 3)
  assert.equal(state(r, 3).sub_group_done, 'B', 'Sub group said straight after its group.')
}

// --- each swimmer, then their group -------------------------------------------
{
  const r = run('Amy group 1 Josh group 2 Ella and Sophie distance')
  assert.equal(state(r, 1).group_done, 1)
  assert.equal(state(r, 4).group_done, 2)
  assert.equal(state(r, 3).group_done, 3)
  assert.equal(state(r, 2).group_done, 3)
}

// --- who isn't here ----------------------------------------------------------
{
  const r = run("Everyone's in except Josh and Amy")
  assert.equal(state(r, 4).attended, false)
  assert.equal(state(r, 1).attended, false)
  assert.equal(state(r, 7).attended, true, 'Everyone means everyone…')
  assert.equal(state(r, 8).attended, false, '…except a swimmer already known to be away.')
}
{
  const r = run("Ben Carter's off")
  assert.equal(state(r, 5).attended, false)
  assert.equal(state(r, 1).attended, true, 'Only an absence said: everyone else stays as they were.')
  assert.equal(r.unnamedMarkedOut, false)
}
{
  const r = run("Group 1 Girls Amy Sophie, Chloe's off")
  assert.equal(state(r, 7).attended, false)
  assert.equal(state(r, 1).attended, true, 'Only the name just before "off" is out.')
  assert.equal(state(r, 2).attended, true)
}
{
  const r = run('Josh and Ella are off sick')
  assert.equal(state(r, 4).attended, false)
  assert.equal(state(r, 3).attended, false, 'Names joined by "and" go out together.')
}
{
  const r = run("Ben's off, group 1 girls Amy Sophie group 1 boys Josh")
  // "Ben" is two swimmers: it is asked about, not guessed.
  assert.deepEqual(r.unsure[0].ids, [5, 6])
  assert.equal(state(r, 1).group_done, 1, 'An absence first does not turn the list round.')
  assert.equal(state(r, 4).group_done, 2)
}

// --- the rest ----------------------------------------------------------------
{
  const r = run('Amy group 1, Josh group 2, everyone else distance')
  assert.equal(state(r, 1).group_done, 1)
  assert.equal(state(r, 2).group_done, 3, 'The rest of who is in go in distance.')
  assert.equal(state(r, 5).group_done, 3)
  assert.equal(state(r, 7).attended, false, 'Not expected, not named: still out.')
  assert.equal(state(r, 7).group_done, null)
}
{
  const r = run('Group 1 Girls Amy, the rest are in group 1 boys')
  assert.equal(state(r, 4).group_done, 2)
  assert.equal(state(r, 1).group_done, 1)
}
{
  const r = run("Amy, Josh, that's everyone", { unnamedOut: false })
  assert.equal(state(r, 2).attended, false, '"That\'s everyone" means nobody else came.')
}
{
  const r = run('Amy and Josh', { unnamedOut: false })
  assert.equal(state(r, 2).attended, true, 'With the option off, unnamed swimmers are left alone.')
}
{
  const r = run("Amy group 1, that's all")
  assert.equal(state(r, 7).attended, false, '"That\'s all" never marks everyone in.')
  assert.equal(state(r, 1).attended, true)
}

// --- whole-squad sessions ignore groups --------------------------------------
{
  const r = run('Group 1 Girls Amy', { useGroups: false })
  assert.equal(state(r, 1).attended, true)
  assert.equal(state(r, 1).group_done, null)
}

// --- not sure: listed, never guessed ----------------------------------------
{
  const r = run('Group 1 Girls Sofie and Ammy')
  assert.equal(state(r, 2).group_done, null, 'A near miss is not ticked.')
  assert.deepEqual(r.unsure.map(u => u.names), [['Sophie Clarke'], ['Amy Stone']])
  const fixed = resolveHeard('Group 1 Girls Sofie and Ammy', 'Sofie', 'Sophie Clarke', vocab)
  const again = applyRegisterTalk(fixed, vocab, start)
  assert.equal(state(again, 2).group_done, 1, 'Tapped: then read like any name, with its group.')
}
{
  const text = 'Ben Jones group 1 boys, Ben group 1 boys'
  const fixed = resolveHeard(text, 'Ben', 'Ben Carter', vocab)
  assert.equal(fixed, 'Ben Jones group 1 boys, Ben Carter group 1 boys', 'The other Ben is left alone.')
}
{
  const r = run('Group 1 Girls Amy Zelda')
  assert.deepEqual(r.unknown, ['Zelda'], 'A name it does not know is shown.')
  assert.ok(!readRegisterTalk('take the register for this morning', vocab).length, 'Asking for the register changes nothing.')
}

// --- ums, ahs and putting it right --------------------------------------------
{
  const r = run('um okay so group one girls uh Amy Sophie erm Ella and and Chloe')
  assert.deepEqual(r.heard.map(h => h.id), [1, 2, 3, 7])
  assert.ok(r.heard.every(h => h.group === 'Group 1 Girls'), 'Ums and ahs change nothing.')
  assert.deepEqual(r.unknown, [])
}
{
  const r = run('group 1 girls Amy no sorry Ella')
  assert.equal(state(r, 1).attended, false, '"Amy, no sorry, Ella": Amy is taken back.')
  assert.equal(state(r, 3).group_done, 1)
}
{
  const r = run('Amy distance actually group 1 girls')
  assert.equal(state(r, 1).group_done, 1, '"…actually group 1": the group is put right.')
}
{
  const r = run('group 1 boys, sorry, group 1 girls Amy Sophie')
  assert.equal(state(r, 1).group_done, 1, 'A wrong group before the names is put right too.')
}
{
  const r = run("Josh is off, no wait, Ella's off")
  assert.equal(state(r, 4).attended, true, 'An absence taken back leaves them as they were.')
  assert.equal(state(r, 3).attended, false)
}
{
  const r = run('Amy group 1 Josh group 2, no one else')
  assert.equal(state(r, 1).attended, true, '"No one else" is not a correction.')
  assert.equal(state(r, 2).attended, false)
}
{
  const r = run('group 1 girls Sofie')
  assert.equal(r.unsure[0].kind, 'near')
  assert.equal(run('Ben group 2').unsure[0].kind, 'ambiguous')
}

// --- names taught by the coach's taps ---------------------------------------
{
  const taught = buildVocabulary({ swimmers, groups, aliases: [{ heard: 'Neve', swimmer_id: 3 }, { heard: 'olly', swimmer_id: 999 }] })
  const r = applyRegisterTalk('group one girls Neve and Amy', taught, start)
  assert.equal(state(r, 3).group_done, 1, 'A taught name is ticked like the real one.')
  assert.deepEqual(r.unsure, [])
  assert.deepEqual(r.unknown, [])
  const gone = applyRegisterTalk('Olly', taught, start)
  assert.deepEqual(gone.unknown, ['Olly'], 'An alias for a swimmer no longer in the squad is ignored.')
}

console.log('register talk: ok')
