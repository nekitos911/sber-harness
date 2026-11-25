// Run: node --test web/src/lib/sorted.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstIndex } from './sorted.ts'

test('firstIndex: the first index where a monotonic predicate holds, -1 when it never does', () => {
  const tops = [-300, -10, 0, 0, 40, 900]
  assert.equal(firstIndex(tops, (t) => t >= 0), 2)
  assert.equal(firstIndex(tops, (t) => t >= -1000), 0)
  assert.equal(firstIndex(tops, (t) => t >= 1000), -1)
  assert.equal(firstIndex([], () => true), -1)
  for (let n = 0; n < 40; n++) {
    const list = Array.from({ length: n }, (_, i) => i)
    for (let k = 0; k <= n; k++) assert.equal(firstIndex(list, (x) => x >= k), list.findIndex((x) => x >= k))
  }
})
