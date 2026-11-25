// Run: node --test web/src/lib/agentChip.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentChip, chipStates } from './agentChip.ts'

const dur = (ms: number) => `${Math.round(ms / 60000)} мин`
const now = 100 * 60000
const worker = { id: 'w', title: 'PROJ-1', state: 'idle', label: 'ответил', since: now }
const chat = (state: string, since = now - 20 * 60000) => ({ id: 'r', title: 'Ревью PROJ-1', state, label: state === 'idle' ? 'ответил' : 'ждёт ответа', since })
const review = (o = {}) => ({ state: 'reviewing' as const, round: 2, maxRounds: 2, workerSessionId: 'w', reviewerSessionId: 'r', startedAt: now - 12 * 60000, ...o })

test('a running reviewer: spins, says round, who and how long, opens the reviewer chat', () => {
  const c = agentChip({ agentState: 'reviewing', review: review() }, worker, chat('running'), now, dur)
  assert.deepEqual([c.spin, c.stalled, c.open], [true, false, 'r'])
  assert.equal(c.tip, 'Ревью силами harness, раунд 2 из 2: ревьюер «Ревью PROJ-1» работает 12 мин. Открыть чат ревьюера')
})

test('a reviewing task whose reviewer does not run for long looks stalled and offers a retry', () => {
  const c = agentChip({ agentState: 'reviewing', review: review() }, worker, chat('idle'), now, dur)
  assert.deepEqual([c.spin, c.stalled, c.retry, c.text], [false, true, true, 'ревью стоит'])
  assert.match(c.tip, /не работает \(ответил\) 20 мин/)
  // just between turns: still running
  assert.equal(agentChip({ agentState: 'reviewing', review: review() }, worker, chat('idle', now - 5000), now, dur).spin, true)
  // no reviewer chat: starting at first, stalled later
  assert.equal(agentChip({ agentState: 'reviewing', review: review({ startedAt: now - 5000, reviewerSessionId: null }) }, worker, null, now, dur).spin, true)
  assert.equal(agentChip({ agentState: 'reviewing', review: review() }, worker, null, now, dur).stalled, true)
  assert.equal(agentChip({ agentState: 'reviewing', review: review() }, worker, chat('waiting_answer'), now, dur).tone, 'wait')
})

test('review_stopped: the reason, opens the worker chat, retry offered; rounds exhausted also retry', () => {
  const c = agentChip({ agentState: 'review_stopped', review: review({ state: 'review_stopped', stoppedReason: 'чат ревьюера удалён', stoppedAt: now - 3 * 60000 }) }, worker, null, now, dur)
  assert.deepEqual([c.open, c.retry, c.tone], ['w', true, 'fail'])
  assert.match(c.tip, /^Ревью прервано 3 мин назад: чат ревьюера удалён\./)
  assert.equal(agentChip({ agentState: 'changes_requested', review: review({ state: 'changes_requested' }) }, worker, chat('done'), now, dur).retry, true)
  assert.equal(agentChip({ agentState: 'changes_requested', review: review({ state: 'changes_requested', round: 1 }) }, worker, chat('done'), now, dur).retry, false)
})

test('chipStates: review states, checks running or failed; a plain agent failure keeps the live line', () => {
  assert.equal(chipStates({ agentState: 'checking' }), true)
  assert.equal(chipStates({ agentState: 'failed', checks: { round: 2, state: 'failed', workerSessionId: 'w' } }), true)
  assert.equal(chipStates({ agentState: 'failed' }), false)
  assert.equal(chipStates({ agentState: 'running' }), false)
})
