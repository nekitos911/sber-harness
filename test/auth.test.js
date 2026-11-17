// First-run login: a login link before the first JSON event -> phase 'auth', a message + notification with the link,
// the first-event timeout replaced by authTimeoutMs; system/init afterwards marks the agent as logged in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { startTestServer, tmpDir, rmrf, waitFor, waitPidGone } from './helpers.js';

const root = tmpDir();
let h;
before(async () => {
  // a 1 s first-event timeout would kill the run during the 2 s login wait unless it is suspended
  h = await startTestServer({
    agents: {
      mock: { firstEventTimeoutMs: 1000 },
      mockauth: { launcher: 'mock', label: 'GigaCode (mock)', approvalMode: 'auto', approvalModes: ['auto'], firstEventTimeoutMs: 1000, authTimeoutMs: 1200 },
    },
  });
});
after(async () => {
  await h.close();
  rmrf(root);
});

const state = async () => (await h.api('GET', '/api/state')).body;
const LINK = 'https://auth.example/device?code=ABCD-EFGH';

test('login link -> phase auth, message and notification with the link; the run then completes and auth is ok', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: '#auth' })).body;
  await waitFor(async () => (await state()).sessions.find((x) => x.id === s.id).phase === 'auth', { what: 'phase auth' });
  const msg = (await h.api('GET', `/api/sessions/${s.id}/messages`)).body.find((m) => m.link);
  assert.deepEqual([msg.kind, msg.link], ['system', LINK]);
  assert.match(msg.text, /^🔑 .* ждёт авторизацию… Код: ABCD-EFGH$/);
  assert.ok((await state()).notifications.some((n) => n.link === LINK && n.sessionId === s.id));
  assert.equal((await h.api('GET', '/api/agents/mock/info')).body.auth, 'required');

  await waitFor(async () => (await state()).sessions.find((x) => x.id === s.id).status === 'idle', { what: 'run to finish after login' });
  const msgs = (await h.api('GET', `/api/sessions/${s.id}/messages`)).body;
  assert.ok(msgs.some((m) => m.kind === 'assistant' && m.text.includes('Done.')));
  assert.ok(!msgs.some((m) => m.kind === 'error'), JSON.stringify(msgs.filter((m) => m.kind === 'error')));
  assert.equal((await h.api('GET', '/api/agents/mock/info')).body.auth, 'ok');
  assert.equal((await state()).sessions.find((x) => x.id === s.id).phase, null);
});

test('login not completed within authTimeoutMs -> killed with a clear error', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mockauth', cwd: root, prompt: '#auth' })).body;
  const err = await waitFor(async () => (await h.api('GET', `/api/sessions/${s.id}/messages`)).body.find((m) => m.kind === 'error'), { what: 'auth timeout' });
  assert.match(err.text, /Login was not completed within/);
  assert.equal((await state()).sessions.find((x) => x.id === s.id).status, 'error');
});

test('agent terminal without cwd runs the interactive CLI in data/chats/login; settings expose authTimeoutMs', async (t) => {
  assert.equal((await h.api('GET', '/api/settings')).body.agents.gigacode.authTimeoutMs, 600000);
  assert.equal((await h.api('PUT', '/api/settings', { agents: { mock: { authTimeoutMs: 5 } } })).status, 400);
  const res = await h.api('POST', '/api/sessions', { kind: 'terminal', agent: 'mock', title: 'Вход в GigaCode' });
  if (res.status === 501) return t.skip(res.body.error);
  assert.equal(res.body.cwd, path.join(h.dataDir, 'chats', 'login'));
  assert.ok(fs.statSync(res.body.cwd).isDirectory());
  assert.ok(res.body.command.includes('mock-agent.js') && !res.body.command.includes(' -p'));
  await h.api('DELETE', `/api/sessions/${res.body.id}`);
  await waitPidGone(res.body.pid);
});
