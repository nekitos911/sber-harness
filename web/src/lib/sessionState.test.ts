// Run: node --test web/src/lib/sessionState.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionVisualState as v, stateSummary } from './sessionState.ts'

test('priority: waiting answer beats stalled beats starting beats running', () => {
  assert.equal(v({ kind: 'chat', status: 'running', waitingFor: 'answer', stalled: true }), 'waiting_answer')
  assert.equal(v({ kind: 'chat', status: 'running', stalled: true, phase: 'starting' }), 'stalled')
  assert.equal(v({ kind: 'chat', status: 'running', phase: 'auth' }), 'auth')
  assert.equal(v({ kind: 'chat', status: 'running', phase: 'starting' }), 'starting')
  assert.equal(v({ kind: 'chat', status: 'running' }), 'running')
  assert.equal(v({ kind: 'chat', status: 'failed' }), 'error')
  assert.equal(v({ kind: 'chat', status: 'idle', stalled: true }), 'idle') // stalled only means something while running
  assert.equal(v({ kind: 'terminal', status: 'idle' }), 'terminal')
})

test('summary: attention first, plurals, calm states and terminals not counted', () => {
  const s = stateSummary([
    { kind: 'chat', status: 'running' }, { kind: 'chat', status: 'running', phase: 'starting' },
    { kind: 'chat', status: 'error' }, { kind: 'chat', status: 'failed' }, { kind: 'chat', status: 'running', waitingFor: 'answer' },
    { kind: 'chat', status: 'idle' }, { kind: 'terminal', status: 'running' },
  ])
  assert.deepEqual(s.map((x) => x.text), ['1 ждёт ответа', '2 ошибки', '2 работают'])
})
