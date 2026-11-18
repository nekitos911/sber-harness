// Run: node --test web/src/lib/flow.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowState } from './flow.ts'

const base = { changed: 0, ahead: 0, upstream: true, onBase: false, pr: null, prEnabled: true }
const view = (f: Parameters<typeof flowState>[0]) => { const r = flowState(f); return r && [r.steps.map((s) => `${s.label}:${s.state}`).join(' '), r.next] }

test('a feature branch walks Коммит → Push → PR → Влит; the first step not done is «now»', () => {
  assert.deepEqual(view({ ...base, changed: 3 }), ['Коммит:now Push:later PR:later Влит:later', 'commit'])
  assert.deepEqual(view({ ...base, ahead: 2 }), ['Коммит:done Push:now PR:later Влит:later', 'push'])
  assert.deepEqual(view({ ...base, upstream: false }), ['Коммит:done Push:now PR:later Влит:later', 'push'], 'never pushed')
  assert.deepEqual(view(base), ['Коммит:done Push:done PR:now Влит:later', 'create-pr'])
  assert.deepEqual(view({ ...base, prEnabled: false })?.[1], 'pr-off')
  assert.deepEqual(view({ ...base, pr: { state: 'open' } }), ['Коммит:done Push:done PR:done На ревью:now', 'review'], 'open: not «Влит» yet')
  assert.deepEqual(view({ ...base, pr: { state: 'merged' } }), ['Коммит:done Push:done PR:done Влит:done', 'merged'])
  assert.equal(view({ ...base, pr: { state: 'declined' } })?.[1], 'declined')
  assert.equal(view({ ...base, changed: 1, pr: { state: 'open' } })?.[1], 'commit', 'a fix after review: commit again first')
})

test('the base branch has no PR steps and no strip at rest', () => {
  assert.equal(flowState({ ...base, onBase: true }), null)
  assert.deepEqual(view({ ...base, onBase: true, changed: 1 }), ['Коммит:now Push:later', 'commit'])
  assert.deepEqual(view({ ...base, onBase: true, ahead: 1 }), ['Коммит:done Push:now', 'push'])
})
