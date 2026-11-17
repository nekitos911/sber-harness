// Run: node --test web/src/lib/diff.test.ts  (Node 22.6+ strips the types)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDiff } from './diff.ts'

const sample = [
  'diff --git a/src/app.js b/src/app.js',
  'index 111..222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -10,3 +10,3 @@ function main() {',
  ' const a = 1',
  '--- not a header, a deleted line',
  '+++ not a header, an added line',
  ' return a',
  '\\ No newline at end of file',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1 @@',
  '+hello',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n')

test('parses files, hunks, line numbers and tricky lines', () => {
  const files = parseDiff(sample)
  assert.equal(files.length, 3)

  const [app, added, bin] = files
  assert.equal(app.path, 'src/app.js')
  assert.equal(app.added, 1)
  assert.equal(app.removed, 1)
  const del = app.lines.find((l) => l.kind === 'del')!
  assert.equal(del.text, '-- not a header, a deleted line')
  assert.equal(del.old, 11)
  const add = app.lines.find((l) => l.kind === 'add')!
  assert.equal(add.new, 11)
  assert.equal(app.lines.at(-1)!.kind, 'note')

  assert.equal(added.status, 'added')
  assert.equal(added.path, 'new.txt')
  assert.deepEqual(added.lines.filter((l) => l.kind === 'add').map((l) => [l.text, l.new]), [['hello', 1]])

  assert.equal(bin.status, 'binary')
})
