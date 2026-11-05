// The frontend notation still gives the reference answers in shared/notation/cases.json.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildCases } from './build-notation-cases.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const expected = JSON.parse(readFileSync(join(here, '..', '..', 'shared', 'notation', 'cases.json'), 'utf8'))
const actual = JSON.parse(JSON.stringify(buildCases()))

for (const key of Object.keys(expected)) {
  assert.deepEqual(actual[key], expected[key], `notation cases differ in "${key}"`)
}
console.log('session notation: frontend matches the reference cases')
