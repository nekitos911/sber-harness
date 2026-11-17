// GigaCode lingers after `result` (MCP shutdown, chat recording): the turn is over for the user at `result`; a queued
// message waits for the old process at most exitGraceMs, then the lingering process is killed and the next turn starts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isAlive } from '../server/runner.js';
import { startTestServer, tmpDir, rmrf, waitFor, waitPidGone } from './helpers.js';

const root = tmpDir();
let h;

before(async () => {
  h = await startTestServer({ agents: { mock: { exitGraceMs: 1500 } } });
});
after(async () => {
  await h.close();
  rmrf(root);
});

const session = async (id) => (await h.api('GET', '/api/state')).body.sessions.find((s) => s.id === id);
const messages = async (id) => (await h.api('GET', `/api/sessions/${id}/messages`)).body;

test('result ends the turn for the user although the process lingers; a queued message kills it after exitGraceMs', async () => {
  const t0 = Date.now();
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: '#linger' })).body;
  const closed = await waitFor(async () => { const x = await session(s.id); return x.status === 'idle' && x.turnClosing && x; }, { what: 'idle at result' });
  assert.ok(Date.now() - t0 < 10000, 'not waiting for the 20 s linger');
  assert.ok(closed.pid && isAlive(closed.pid), 'the process is still alive and tracked');
  assert.deepEqual([closed.phase, closed.lastEventKind], [null, 'result']);
  assert.ok((await messages(s.id)).some((m) => m.kind === 'assistant' && m.text.includes('Done.')));

  const sent = Date.now();
  const r = (await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'дальше' })).body;
  assert.equal(r.queued, true, 'waits for the lingering process');
  await waitPidGone(closed.pid, 10000);
  await waitFor(async () => (await messages(s.id)).some((m) => m.kind === 'assistant' && /resumed .*turn 2/.test(m.text)), { what: 'turn 2' });
  const waited = Date.now() - sent;
  assert.ok(waited < 1500 + 6000, `next turn started ${waited} ms after the message`);
  await waitFor(async () => (await session(s.id)).status === 'idle' && !(await session(s.id)).turnClosing, { what: 'turn 2 done', timeout: 30000 });
  const log = fs.readFileSync(path.join(h.dataDir, 'runs', s.id, 'stderr.log'), 'utf8');
  assert.match(log, /process exited \d+ ms after result \(killed after exitGraceMs\)/);
  assert.ok(!(await messages(s.id)).some((m) => m.kind === 'error' || m.text === 'Остановлено пользователем'));
});
