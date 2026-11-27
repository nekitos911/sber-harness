// Run: node --test web/src/lib/overview.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bucket, childOfCall, clock, descendants, dockRows, places, plainInline, runningShells, taskHead, taskText, timeline, watchedShells } from './overview.ts'
import type { Message, Session } from '../types'

const s = (id: string, parentId: string | null, extra: Partial<Session> = {}) =>
  ({ id, parentId, kind: 'chat', title: id, cwd: 'C:\\p', branch: null, createdAt: 1, status: 'idle', ...extra }) as Session
const m = (id: string, kind: Message['kind'], text: string, extra: Partial<Message> = {}) =>
  ({ id, sessionId: 'a', at: Number(id.slice(1)), kind, text, from: null, tool: null, turn: 1, ...extra }) as Message

test('task text drops the harness paragraphs and a record\'s folder line', () => {
  assert.equal(taskText('[harness] Ты — субагент\n\nПочини тесты'), 'Почини тесты')
  assert.equal(taskText('C:\\Projects\\x\nСделай отчёт'), 'Сделай отчёт')
  assert.equal(taskText('C:\\Projects\\x'), 'C:\\Projects\\x', 'a path alone is the message')
})

test('a command shows its task key and title', () => {
  assert.equal(taskHead('/full-task SOWA-1', { key: 'SOWA-1', title: 'Логин' }), '/full-task SOWA-1 · Логин')
  assert.equal(taskHead('/full-task', { key: 'SOWA-1', title: 'Логин' }), '/full-task SOWA-1 · Логин')
  assert.equal(taskHead('Сделай  это\nподробно', { key: 'SOWA-1', title: 'Логин' }), 'Сделай это')
})

test('descendants: the whole tree in start order, no system chats, no loop', () => {
  const list = [s('c', 'a', { createdAt: 3 }), s('b', 'a', { createdAt: 2 }), s('d', 'b'), s('x', 'a', { system: true }), s('a', 'd')]
  assert.deepEqual(descendants(list, 'a').map((n) => `${n.s.id}${n.depth}`), ['b0', 'd1', 'c0'])
})

test('buckets and places', () => {
  assert.equal(bucket('idle', { status: 'failed', at: 1 }), 'fail')
  assert.equal(bucket('running', { status: 'done', at: 1 }), 'run')
  assert.equal(bucket('idle', null), 'done')
  const p = places([s('a', null), s('b', 'a', { cwd: 'C:/p/', branch: 'T-1' }), s('c', 'a', { worktreePath: 'C:\\w', cwd: 'C:\\w\\sub' })])
  assert.deepEqual(p.map((x) => [x.path, x.branch, x.sessions]), [['C:\\p', 'T-1', 2], ['C:\\w', null, 1]])
})

test('timeline: people, helpers, errors, commits in time order', () => {
  const list = [
    m('m1', 'user', 'Задача'),
    m('m5', 'tool', '', { tool: { id: 't', name: 'run_shell_command', input: { command: 'git commit -m x' }, output: null, status: 'ok' } }),
    m('m6', 'error', 'Упал\nподробно'),
    m('m7', 'user', 'Готово', { from: 'harness' }),
  ]
  const kid = s('k', 'a', { createdAt: 3, status: 'done', report: { status: 'done', at: 4 } })
  assert.deepEqual(timeline(list, [kid]).map((e) => `${e.kind}:${e.text}`), ['user:Задача', 'sub-start:k', 'sub-end:k', 'git:git commit -m x', 'error:Упал', 'harness:Готово'])
})

test('a harness agent call finds its chat: by the id in its output, else by its prompt', () => {
  const kids = [
    { id: 'old', createdAt: 5, first: 'Проверь  тесты' }, // before the call
    { id: 'k1', createdAt: 12, first: 'Проверь тесты\nподробно' },
    { id: 'k2', createdAt: 15, first: 'Другое' },
    { id: 'k3', createdAt: 20 }, // transcript not loaded
  ]
  assert.equal(childOfCall({ at: 10, prompt: 'x', output: '{"sessionId":"s9","placement":"current"}' }, kids), 's9')
  assert.equal(childOfCall({ at: 10, prompt: 'Проверь тесты подробно', output: null }, kids), 'k1')
  assert.equal(childOfCall({ at: 10, prompt: 'Нет такого', output: 'работает в фоне' }, kids), null)
  assert.equal(childOfCall({ at: 10, prompt: '', output: null }, kids), null)
})

test('plain inline text of a markdown line', () => {
  assert.equal(plainInline('Перенести **модуль** `ledger/5.ts` в *новый* сервис'), 'Перенести модуль ledger/5.ts в новый сервис')
  assert.equal(plainInline('## См. [доку](http://x) и __init__.py, a * b * c'), 'См. доку и __init__.py, a * b * c')
  assert.equal(taskHead('Почини **тест** `refund`'), 'Почини тест refund')
})

test('dock: live descendants indented under a live parent, finished ones newest first', () => {
  const list = [
    s('w1', 'a', { createdAt: 2, status: 'running' }), s('r1', 'w1', { createdAt: 3, waitingFor: 'answer' }),
    s('w2', 'a', { createdAt: 4, status: 'done', finishedAt: 10 }), s('g', 'w2', { createdAt: 5, status: 'running' }),
    s('w3', 'a', { createdAt: 6, status: 'stopped', finishedAt: 20 }),
  ]
  const d = dockRows(list, 'a')
  assert.deepEqual(d.live.map((r) => `${r.s.id}${r.indent}`), ['w10', 'r11', 'g0'])
  assert.deepEqual(d.done.map((x) => x.id), ['w3', 'w2'])
})

test('running shells: running calls and this turn\'s background ones, not other tools', () => {
  const t = (id: string, name: string, input: object, status: 'running' | 'ok', turn = 2) =>
    m(id, 'tool', '', { turn, tool: { id, name, input, output: null, status } })
  const list = [
    t('m1', 'run_shell_command', { command: 'npm run dev', is_background: true }, 'ok', 1),
    t('m2', 'Bash', { command: 'sleep 100', run_in_background: true }, 'ok'),
    t('m3', 'run_shell_command', { command: 'git status' }, 'ok'),
    t('m4', 'read_file', { path: 'x' }, 'running'),
    t('m5', 'run_shell_command', { command: 'npm test\n--watch' }, 'running'),
  ]
  assert.deepEqual(runningShells(list).map((r) => [r.command, r.background]), [['sleep 100', true], ['npm test', false]])
})

test('a background command the harness watches: listed while its status file says it runs, in any turn; its last output line', () => {
  const sh = (id: string, state: string, turn: number) =>
    m(id, 'tool', '', { turn, tool: { id, name: 'run_shell_command', input: { command: 'x' }, output: null, status: 'ok', bgShell: { id: null, command: 'mvn test', outputFile: null, statusFile: 's', state, startedAt: 5, tail: '[INFO] Building\n[INFO] Tests run: 42\n' } } })
  const list = [sh('a', 'running', 1), sh('b', 'completed', 2), m('c', 'assistant', 'жду тесты', { turn: 2 })]
  assert.deepEqual(runningShells(list).map((r) => [r.id, r.command, r.last]), [['a', 'mvn test', '[INFO] Tests run: 42']])
  assert.deepEqual(watchedShells(list, ['a', 'b', 'gone']).map((r) => [r.id, r.at, r.background]), [['a', 5, true]])
})

test('clock', () => {
  assert.equal(clock(39_000), '39 с')
  assert.equal(clock(699_000), '11 мин 39 с')
  assert.equal(clock(7_500_000), '2 ч 05 мин')
})
