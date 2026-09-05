import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = relative => fs.readFileSync(path.join(here, '..', relative), 'utf8')

const api = read('src/api.js')
const app = read('src/App.jsx')
const register = read('src/pages/Register.jsx')
const operations = read('src/pages/AIOperations.jsx')
const settings = read('src/pages/Settings.jsx')

assert.match(api, /getAIOperations:/)
assert.match(api, /retryAIOperation:/)
assert.match(api, /\[408, 425, 429\]/)
assert.match(api, /AbortSignal\.timeout\(15000\)/)
assert.match(app, /path="\/ai-operations"/)
assert.match(settings, /label: 'AI Operations'/)
assert.match(register, /client_saved_at/)
assert.match(register, /lanewatch_register_draft:/)
assert.match(operations, /Registers save before their AI work begins/)
assert.match(operations, /Needs attention/)

console.log('AI operations and register reliability checks passed')
