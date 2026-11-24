// Run: node --test web/src/lib/prFilter.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activePrFilters, filterPrs, NO_PR_FILTERS, prFilterOptions } from './prFilter.ts'

const pr = (index: number, o = {}) => ({ repo: 'PROJ/a', index, title: `PR ${index}`, head: `feature/${index}`, base: 'develop', author: 'ivanov', reviewers: [{ name: 'petrov', status: 'PENDING' }], taskKey: null, ...o })
const items = [pr(1, { title: 'Отчёт по платежам', taskKey: 'PROJ-15' }), pr(2, { repo: 'PROJ/b', author: 'petrov', reviewers: [], base: 'release/54' }), pr(3)]

test('search: every word somewhere (title, #number, branch, task key), any case', () => {
  assert.deepEqual(filterPrs(items, 'отчёт proj-15', NO_PR_FILTERS).map((i) => i.index), [1])
  assert.deepEqual(filterPrs(items, '#2', NO_PR_FILTERS).map((i) => i.index), [2])
  assert.deepEqual(filterPrs(items, 'feature/3', NO_PR_FILTERS).map((i) => i.index), [3])
  assert.deepEqual(filterPrs(items, '  ', NO_PR_FILTERS).length, 3)
})

test('filters: repo, author, reviewer, base; options come from the list', () => {
  assert.deepEqual(filterPrs(items, '', { ...NO_PR_FILTERS, author: 'petrov' }).map((i) => i.index), [2])
  assert.deepEqual(filterPrs(items, '', { ...NO_PR_FILTERS, reviewer: 'petrov', repo: 'PROJ/a' }).map((i) => i.index), [1, 3])
  assert.deepEqual(filterPrs(items, '', { ...NO_PR_FILTERS, base: 'release/54' }).map((i) => i.index), [2])
  assert.deepEqual(prFilterOptions(items), { repo: ['PROJ/a', 'PROJ/b'], author: ['ivanov', 'petrov'], reviewer: ['petrov'], base: ['develop', 'release/54'] })
  assert.equal(activePrFilters({ ...NO_PR_FILTERS, base: 'x', author: 'y' }), 2)
})
