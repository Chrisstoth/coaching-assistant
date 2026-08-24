import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'src', 'api.js'), 'utf8')

for (const name of ['submitRegister', 'submitChatRegister']) {
  const matches = source.match(new RegExp(`^\\s{2}${name}:`, 'gm')) || []
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${name} API method; found ${matches.length}`)
  }
}

console.log('API contract check passed')
