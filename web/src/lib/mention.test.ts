// Run: node --test web/src/lib/mention.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenAt } from './mention.ts'

test('tokenAt finds @file anywhere and /command only as the first word', () => {
  assert.deepEqual(tokenAt('fix @src/su', 11), { kind: '@', query: 'src/su', start: 4 })
  assert.deepEqual(tokenAt('@', 1), { kind: '@', query: '', start: 0 })
  assert.deepEqual(tokenAt('/full', 5), { kind: '/', query: 'full', start: 0 })
  assert.equal(tokenAt('run /full', 9), null) // a slash command only works as the first word
  assert.equal(tokenAt('mail a@b', 8), null) // an e-mail is not a mention
  assert.equal(tokenAt('@src/a.js done', 14), null) // the caret left the token
})
