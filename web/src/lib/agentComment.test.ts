// Run: node --test web/src/lib/agentComment.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commentMessage, commentTargets, pathFor } from './agentComment.ts'

const chat = (id: string, cwd: string, lastActivityAt: number, extra = {}) => ({ id, kind: 'chat', cwd, lastActivityAt, ...extra })

test('targets: chats that see the file (their folder, an added folder, the projects root); the open one first, then the latest', () => {
  const file = 'C:\\Projects\\svc\\server\\history.js'
  const list = [
    chat('root', 'C:\\Projects', 10),
    chat('here', 'c:/projects/svc', 5),
    chat('open', 'C:\\Projects\\svc', 1),
    chat('other', 'C:\\Projects\\lib', 99),
    chat('extra', 'C:\\Projects\\lib', 50, { includeDirs: ['C:\\Projects\\svc'] }),
    chat('gone', 'C:\\Projects\\svc', 100, { archived: true }),
    chat('sub', 'C:\\Projects\\svc', 100, { virtual: true }),
    { ...chat('term', 'C:\\Projects\\svc', 100), kind: 'terminal' },
  ]
  assert.deepEqual(commentTargets(list, file, 'open').map((s) => s.id), ['open', 'extra', 'root', 'here'])
  assert.deepEqual(commentTargets(list, file, null).map((s) => s.id), ['extra', 'root', 'here', 'open'])
})

test('path as the chat sees it: relative inside its folder (any case, any slash), absolute otherwise', () => {
  assert.equal(pathFor('C:\\Projects', 'C:\\Projects\\svc\\server\\history.js'), 'svc/server/history.js')
  assert.equal(pathFor('c:/projects/svc/', 'C:\\Projects\\svc\\a.js'), 'a.js')
  assert.equal(pathFor('C:\\Other', 'C:\\Projects\\svc\\a.js'), 'C:/Projects/svc/a.js')
})

test('message: the note, where, and the lines in a fence that survives backticks inside', () => {
  assert.equal(commentMessage({ path: 'server/history.js', from: 71, to: 72, snippet: '+ a\n+ b\n', note: ' вынеси в функцию ' }),
    'вынеси в функцию\n\n`server/history.js`, строки 71–72:\n```\n+ a\n+ b\n```')
  assert.equal(commentMessage({ path: 'a.md', from: 3, to: 3, snippet: '```js', note: 'x' }), 'x\n\n`a.md`, строка 3:\n~~~\n```js\n~~~')
})
