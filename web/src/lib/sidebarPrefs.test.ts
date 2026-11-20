// Run: node --test web/src/lib/sidebarPrefs.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PREFS, compareChats, compareRows, filteredOut, hidesSomething, isDefault, moveTo, orderProjects, prGroup, staleChat, statusGroup } from './sidebarPrefs.ts'

const wt = { main: false, detached: false, sleeping: false, createdBy: 'user', empty: false }

test('filters: each switch hides its kind; older worktrees count as made outside; the main one never is', () => {
  assert.equal(filteredOut(DEFAULT_PREFS, { ...wt, sleeping: true, empty: true }), false)
  assert.equal(filteredOut({ ...DEFAULT_PREFS, hideSleeping: true }, { ...wt, sleeping: true }), true)
  assert.equal(filteredOut({ ...DEFAULT_PREFS, hideMain: true }, { ...wt, main: true }), true)
  assert.equal(filteredOut({ ...DEFAULT_PREFS, hideAgentMade: true }, { ...wt, createdBy: 'agent' }), true)
  assert.equal(filteredOut({ ...DEFAULT_PREFS, hideExternal: true }, { ...wt, createdBy: undefined }), true)
  assert.equal(filteredOut({ ...DEFAULT_PREFS, hideExternal: true }, { ...wt, main: true, createdBy: undefined }), false)
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

test('chats in a folder follow «Сортировать по»: Новые = newest first, Активность = latest activity, Имя', () => {
  const chats = [
    { title: 'Б старый', createdAt: 1, lastActivityAt: 50 },
    { title: 'А новый', createdAt: 3, lastActivityAt: 10 },
    { title: 'В средний', createdAt: 2, lastActivityAt: 30 },
  ]
  const order = (s: 'new' | 'activity' | 'name') => [...chats].sort(compareChats(s)).map((c) => c.title[0])
  assert.deepEqual(order('new'), ['А', 'В', 'Б'])
  assert.deepEqual(order('activity'), ['Б', 'В', 'А'])
  assert.deepEqual(order('name'), ['А', 'Б', 'В'])
})
