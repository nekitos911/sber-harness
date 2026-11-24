// Run: node --test web/src/lib/agentsBoard.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentRows, archivable, countCats, groupRows, inFilter, rowMatches } from './agentsBoard.ts'
import { sessionVisualState } from './sessionState.ts'
import type { Session } from '../types'

const s = (id: string, extra: Partial<Session> = {}) =>
  ({ id, parentId: null, kind: 'chat', title: id, cwd: 'C:\\p', branch: null, model: null, createdAt: 1, lastActivityAt: 1, status: 'idle', queued: 0, ...extra }) as Session
const kidsOf = (all: Session[]) => (id: string) => all.filter((x) => x.parentId === id)
const rows = (all: Session[], archive = false) => agentRows(all, sessionVisualState, kidsOf(all), archive)

test('one row per top-level chat; helpers fold in, virtual / system / untouched CLI history stay out', () => {
  const all = [
    s('a'), s('w1', { parentId: 'a', status: 'done' }), s('w2', { parentId: 'a', status: 'running' }),
    s('v', { parentId: 'a', virtual: true, status: 'done' }), s('sys', { system: true }),
    s('cli', { origin: 'cli' }), s('cli-run', { origin: 'cli', status: 'running' }), s('old', { archived: true }),
  ]
  const r = rows(all)
  assert.deepEqual(r.map((x) => x.s.id), ['a', 'cli-run'])
  assert.equal(r[0].kids.length, 3)
  assert.equal(r[0].finished, 2, 'the done worker and the done built-in one')
  assert.deepEqual(rows(all, true).map((x) => x.s.id), ['old'])
})

test('a worker whose parent is archived is a row of its own', () => {
  const r = rows([s('p', { archived: true }), s('w', { parentId: 'p' })])
  assert.deepEqual(r.map((x) => x.s.id), ['w'])
})

test('a helper waiting for the person lifts its parent into «Ждут вас»', () => {
  const all = [s('a', { status: 'running' }), s('w', { parentId: 'a', status: 'running', waitingFor: 'answer' })]
  const [r] = rows(all)
  assert.equal(r.cat, 'you')
  assert.equal(r.who.id, 'w')
  assert.ok(inFilter(r, 'you') && !inFilter(r, 'run'))
})

test('groups: urgent first; search spans the helpers', () => {
  const all = [
    s('ok', { lastActivityAt: 9, workspaceId: 'x' }), s('bad', { status: 'error', workspaceId: 'y' }),
    s('ask', { waitingFor: 'permission', workspaceId: 'x', lastActivityAt: 2 }),
    s('w', { parentId: 'ok', branch: 'feature/SOWA-7' }),
  ]
  const r = rows(all)
  const proj = (x: Session) => x.workspaceId ?? ''
  assert.deepEqual(groupRows(r, 'none', proj)[0].rows.map((x) => x.s.id), ['ask', 'bad', 'ok'])
  assert.deepEqual(groupRows(r, 'project', proj).map((g) => [g.label, g.rows.map((x) => x.s.id)]), [['x', ['ask', 'ok']], ['y', ['bad']]])
  assert.deepEqual(groupRows(r, 'status', proj).map((g) => g.label), ['Ждут вас', 'Ошибки', 'Готовые'])
  assert.deepEqual(countCats(r), { you: 1, fail: 1, run: 0, done: 1 })
  const fields = (x: Session) => [x.title, x.branch]
  assert.deepEqual(r.filter((x) => rowMatches(x, 'sowa-7', fields)).map((x) => x.s.id), ['ok'])
  assert.equal(r.filter((x) => rowMatches(x, '  ', fields)).length, 3)
})

test('bulk archive takes only settled rows with nothing pending', () => {
  const all = [
    s('idle'), s('queued', { queued: 1 }), s('run', { status: 'running' }), s('closing', { turnClosing: true }),
    s('busy-kid'), s('k', { parentId: 'busy-kid', status: 'running' }), s('err', { status: 'error' }),
  ]
  assert.deepEqual(rows(all).filter((r) => archivable(r, sessionVisualState)).map((r) => r.s.id), ['idle'])
})
