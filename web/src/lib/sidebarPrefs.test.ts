// Run: node --test web/src/lib/sidebarPrefs.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PREFS, compareChats, compareRows, filteredOut, hidesSomething, isDefault, keepOrder, loadPrefs, moveTo, orderProjects, prGroup, staleChat, statusGroup, turnStarts } from './sidebarPrefs.ts'

const wt = { main: false, detached: false, sleeping: false, createdBy: 'user', empty: false }

test('filters: each switch hides its kind; older worktrees count as made outside; the main one never is', () => {
  assert.equal(filteredOut(DEFAULT_PREFS, { ...wt, sleeping: true, empty: true }), false)
  assert.equal(filteredOut({ ...DEFAULT_PREFS, hideSleeping: true }, { ...wt, sleeping: true }), true)
  assert.equal(filteredOut({ ...DEFAULT_PREFS, hideMain: true }, { ...wt, main: true }), true)
  assert.equal(filteredOut({ ...DEFAULT_PREFS, hideAgentMade: true }, { ...wt, createdBy: 'agent' }), true)
  assert.equal(filteredOut({ ...DEFAULT_PREFS, showCli: false }, { ...wt, createdBy: undefined }), true)
  assert.equal(filteredOut({ ...DEFAULT_PREFS, showCli: false }, { ...wt, main: true, createdBy: undefined }), false)
  assert.equal(filteredOut({ ...DEFAULT_PREFS, showCli: false }, { ...wt, createdBy: 'external', chats: true }), false, 'harness chats work in it')
  assert.equal(filteredOut({ ...DEFAULT_PREFS, hideDetached: true }, { ...wt, detached: true }), true)
  assert.equal(filteredOut({ ...DEFAULT_PREFS, hideEmpty: true }, { ...wt, empty: true }), true)
})

test('the dot and «Сбросить»: hiding settings vs any setting; the dragged order is neither', () => {
  assert.equal(hidesSomething(DEFAULT_PREFS), false)
  assert.equal(hidesSomething({ ...DEFAULT_PREFS, group: 'status' }), false)
  assert.equal(hidesSomething({ ...DEFAULT_PREFS, hiddenProjects: ['w1'] }), true)
  assert.equal(isDefault({ ...DEFAULT_PREFS, projectOrder: ['b', 'a'] }), true)
  assert.equal(isDefault({ ...DEFAULT_PREFS, showTime: false }), false)
})

test('status and PR groups', () => {
  assert.equal(statusGroup(['running', 'waiting_permission'], false, false), 'attention')
  assert.equal(statusGroup(['idle'], true, false), 'error')
  assert.equal(statusGroup(['running', 'idle'], false, false), 'busy')
  assert.equal(statusGroup(['done', 'done'], false, false), 'done')
  assert.equal(statusGroup([], false, true), 'done')
  assert.equal(statusGroup([], false, false), 'idle')
  assert.equal(prGroup(null), 'none')
  assert.equal(prGroup({ state: 'declined' }), 'none')
  assert.equal(prGroup({ state: 'open', reviewers: [] }), 'open')
  assert.equal(prGroup({ state: 'open', reviewers: [{}] }), 'review')
  assert.equal(prGroup({ state: 'open' }, 'review'), 'review')
  assert.equal(prGroup({ state: 'merged' }), 'merged')
})

test('worktree sorts', () => {
  const rows = [
    { name: 'b', rank: 2, last: 5, created: 1, changes: 0 },
    { name: 'a', rank: 1, last: 1, created: 3, changes: 4 },
    { name: 'c', rank: 0, last: 9, created: 2, changes: 4 },
  ]
  const names = (s: Parameters<typeof compareRows>[0]) => [...rows].sort(compareRows(s)).map((r) => r.name).join('')
  assert.equal(names('activity'), 'cab')
  assert.equal(names('name'), 'abc')
  assert.equal(names('new'), 'acb')
  assert.equal(names('changes'), 'cab')
})

test('project order: manual keeps the dragged order, new ones after; drag moves onto the target place', () => {
  const list = [{ id: 'a', name: 'Яблоко' }, { id: 'b', name: 'Банан' }, { id: 'c', name: 'Вишня' }]
  const ids = (p: Partial<typeof DEFAULT_PREFS>, last = (x: { id: string }) => ({ a: 1, b: 3, c: 2 })[x.id] ?? 0) => orderProjects(list, { ...DEFAULT_PREFS, ...p }, last).map((x) => x.id).join('')
  assert.equal(ids({}), 'abc')
  assert.equal(ids({ projectOrder: ['c', 'a'] }), 'cab')
  assert.equal(ids({ order: 'alpha' }), 'bca')
  assert.equal(ids({ order: 'activity' }), 'bca')
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 'a', 'c'), ['b', 'c', 'a', 'd'])
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c'])
  assert.deepEqual(moveTo(['a', 'b'], 'a', 'zz'), ['a', 'b'])
})

test('«Скрывать чаты старше N дней»: by last activity; a chat that works or waits for you never hides', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  const old = { lastActivityAt: now - 4 * 86400000, status: 'idle', waitingFor: null }
  const hourly = { ...DEFAULT_PREFS, chatsMaxAgeDays: 1 / 24 }
  assert.equal(staleChat(hourly, { ...old, lastActivityAt: now - 3600000 }, now), false)
  assert.equal(staleChat(hourly, { ...old, lastActivityAt: now - 3600001 }, now), true)
  assert.equal(staleChat(DEFAULT_PREFS, old, now), false)
  const p = { ...DEFAULT_PREFS, chatsMaxAgeDays: 3 }
  assert.equal(staleChat(p, old, now), true)
  assert.equal(staleChat(p, { ...old, lastActivityAt: now - 2 * 86400000 }, now), false)
  assert.equal(staleChat(p, { ...old, status: 'running' }, now), false)
  assert.equal(staleChat(p, { ...old, waitingFor: 'answer' }, now), false)
  assert.equal(hidesSomething(p), true)
})

test('saved prefs: the old «скрыть созданные вне harness» turns «Из CLI» off; unknown keys go', () => {
  assert.deepEqual(loadPrefs(null), DEFAULT_PREFS)
  assert.equal(loadPrefs({ hideExternal: true }).showCli, false)
  assert.equal(loadPrefs({ hideExternal: false, showCli: false }).showCli, false)
  assert.equal(loadPrefs({ hideExternal: false, group: 'pr' }).showCli, true)
  assert.equal('hideExternal' in loadPrefs({ hideExternal: true }), false)
})

test('activity order: a chat moves when a turn starts, not on each streamed event', () => {
  let t = turnStarts(new Map(), [{ id: 'a', status: 'idle', lastActivityAt: 10 }, { id: 'b', status: 'running', lastActivityAt: 20 }])
  assert.deepEqual([t.get('a')?.at, t.get('b')?.at], [10, 20])
  t = turnStarts(t, [{ id: 'a', status: 'idle', lastActivityAt: 10 }, { id: 'b', status: 'running', lastActivityAt: 99 }])
  assert.equal(t.get('b')?.at, 20, 'streaming keeps its place')
  t = turnStarts(t, [{ id: 'a', status: 'running', lastActivityAt: 50 }, { id: 'b', status: 'idle', lastActivityAt: 120 }])
  assert.deepEqual([t.get('a')?.at, t.get('b')?.at], [50, 20], 'a started a turn; b ending one does not move')
  assert.deepEqual(turnStarts(t, [{ id: 'a', status: 'running', lastActivityAt: 70 }]).get('a')?.at, 50, 'idempotent')
})

test('held order: nothing moves under the pointer, new items after', () => {
  const ids = (list: string[], held: string[]) => keepOrder(list, (x) => x, held).join('')
  assert.equal(ids(['c', 'a', 'b'], ['a', 'b', 'c']), 'abc')
  assert.equal(ids(['d', 'c', 'a', 'b'], ['a', 'b', 'c']), 'abcd')
  assert.equal(ids(['b', 'a'], ['a', 'x', 'b']), 'ab')
})

test('chat rows stay in creation order as activity changes, unless sorted by name', () => {
  const chats = [
    { title: 'Б старый', createdAt: 1, lastActivityAt: 50 },
    { title: 'А новый', createdAt: 3, lastActivityAt: 10 },
    { title: 'В средний', createdAt: 2, lastActivityAt: 30 },
  ]
  const order = (s: 'new' | 'activity' | 'name') => [...chats].sort(compareChats(s)).map((c) => c.title[0])
  assert.deepEqual(order('new'), ['А', 'В', 'Б'])
  chats[0].lastActivityAt += 100
  assert.deepEqual(order('activity'), ['А', 'В', 'Б'])
  assert.deepEqual(order('name'), ['А', 'Б', 'В'])
})
