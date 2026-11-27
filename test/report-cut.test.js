// A sub-agent's report to a parent that works on its own: it does not wait for the whole step — the step ends at its
// next boundary and the parent's next turn reads the report, told where it stopped.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, tmpDir, rmrf, waitFor } from './helpers.js';

const root = tmpDir();
let h;
after(async () => {
  await h?.close();
  rmrf(root);
});

test('a background sub-agent finishes while its parent is busy: the report goes in by itself, the parent hears it was cut', async () => {
  h = await startTestServer();
  const cwd = path.join(root, 'p');
  fs.mkdirSync(cwd);
  const messages = async (id) => (await h.api('GET', `/api/sessions/${id}/messages`)).body;
  // the parent works on its own for a minute (its own work, no output)
  const parent = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd, prompt: '#hang 60000' })).body;
  await waitFor(async () => (await h.api('GET', '/api/state')).body.sessions.find((s) => s.id === parent.id).status === 'running', { what: 'parent at work' });
  const started = Date.now();
  // its background harness sub-agent, finishing at once
  const r = await h.api('POST', '/api/agent/agent', { subagent_type: 'general-purpose', description: 'probe', prompt: '#done готово', run_in_background: true }, { 'x-harness-session': parent.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const report = await waitFor(async () => (await messages(parent.id)).find((m) => m.kind === 'user' && m.from && m.from !== 'user' && /готово/.test(m.text)), { timeout: 30000, what: 'the report reached the parent' });
  assert.ok(Date.now() - started < 30000, 'not after the parent\'s minute');
  assert.ok(report);
  await waitFor(async () => (await messages(parent.id)).some((m) => m.kind === 'assistant' && m.text.includes('знаю, что был прерван')), { timeout: 20000, what: 'the parent was told it was cut' });
  assert.ok(!(await messages(parent.id)).some((m) => m.text === 'Остановлено пользователем'), 'not a Stop');
});
