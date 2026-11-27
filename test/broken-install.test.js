// GigaCode's own launcher says its node or CLI files are missing (a half-done update, a stale path): the harness says
// what it is and does not retry every minute; the message waits in the queue.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, tmpDir, rmrf, waitFor } from './helpers.js';

const root = tmpDir();
const broken = path.join(root, 'broken.js');
fs.writeFileSync(broken, "process.stderr.write('GigaCode launcher error: the bundled Node runtime or CLI closure is missing\\n'); process.exit(1);\n");
let h;
after(async () => {
  await h?.close();
  rmrf(root);
});

test('a broken GigaCode install: said in plain words, no retry loop, the message stays queued', async () => {
  h = await startTestServer({ agents: { broken: { launcher: 'mock', label: 'broken', transport: 'acp', command: [process.execPath, broken], approvalMode: 'auto', approvalModes: ['default', 'auto'] } } });
  const cwd = path.join(root, 'p');
  fs.mkdirSync(cwd);
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'broken', cwd, prompt: 'Продолжи' })).body;
  const err = await waitFor(async () => (await h.api('GET', `/api/sessions/${s.id}/messages`)).body.find((m) => m.kind === 'error'), { timeout: 20000, what: 'the error' });
  assert.match(err.text, /установлен не полностью/);
  assert.doesNotMatch(err.text, /Повторю запуск сам/);
  const x = (await h.api('GET', '/api/state')).body.sessions.find((y) => y.id === s.id);
  assert.deepEqual([x.queue.map((q) => q.text), x.startRetryAt ?? null], [['Продолжи'], null]);
});
