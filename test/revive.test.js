// A turn that broke (a crash, a dropped connection) or went silent is continued by the harness, not dropped: a few
// attempts with pauses, then a notification with «Повторить».
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, tmpDir, rmrf, waitFor } from './helpers.js';

const root = tmpDir();
let h;
before(async () => {
  h = await startTestServer({ session: { stallSec: 1, stallCheckSec: 0.3, revive: { attempts: 2, delaysSec: [0.2, 0.3], stallWakeMin: 0.02 } } });
});
after(async () => {
  await h.close();
  rmrf(root);
});

const session = async (id) => (await h.api('GET', '/api/state')).body.sessions.find((s) => s.id === id);
const messages = async (id) => (await h.api('GET', `/api/sessions/${id}/messages`)).body;
const chat = async (prompt) => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt })).body;
  await waitFor(async () => (await session(s.id)).status === 'idle', { what: 'first turn' });
  return s;
};
const settled = (id) => waitFor(async () => { const s = await session(id); return s.status !== 'running' && !s.pid && s; }, { what: 'settled' });

test('a crash in the middle of the work: continued by itself with the same session; the count starts over after a good turn', async () => {
  const s = await chat('привет');
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'сделай #crash' });
  const cont = await waitFor(async () => (await messages(s.id)).find((m) => m.kind === 'user' && /Предыдущий ход оборвался/.test(m.text)), { timeout: 15000, what: 'continuation' });
  assert.match(cont.text, /Продолжи с того места/);
  const done = await waitFor(async () => { const x = await session(s.id); return x.status === 'idle' && !x.pid && !x.revive && x; }, { timeout: 15000, what: 'good turn' });
  assert.equal(done.status, 'idle');
  const ms = await messages(s.id);
  assert.ok(ms.some((m) => m.kind === 'system' && /продолжу сам через .+ \(попытка 1 из 2\)/.test(m.text)));
  assert.ok(!(await h.api('GET', '/api/state')).body.notifications.some((n) => n.sessionId === s.id && n.kind === 'escalation'), 'no alarm for a turn that came back');
});

test('attempts run out: one notification with «Повторить», which continues it again', async () => {
  const s = await chat('привет');
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'сделай #crashalways' });
  const n = await waitFor(async () => (await h.api('GET', '/api/state')).body.notifications.find((x) => x.sessionId === s.id && x.kind === 'escalation'), { timeout: 20000, what: 'gave up' });
  assert.deepEqual(n.actions, ['retry', 'open']);
  assert.match(n.text, /после 2 повторов/);
  const x = await settled(s.id);
  assert.equal(x.revive.gaveUp, true);
  const before = (await messages(s.id)).filter((m) => /Предыдущий ход оборвался/.test(m.text)).length;
  assert.equal((await h.api('POST', `/api/sessions/${s.id}/revive`)).status, 200);
  await waitFor(async () => (await messages(s.id)).filter((m) => /Предыдущий ход оборвался/.test(m.text)).length === before + 1, { what: 'manual retry' });
});

test('silent with no tool running: woken (stopped and continued), not «Остановлено пользователем»', async () => {
  const s = await chat('привет');
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: '#silent' });
  await waitFor(async () => (await messages(s.id)).some((m) => m.kind === 'user' && /Предыдущий ход оборвался \(нет вывода/.test(m.text)), { timeout: 20000, what: 'woken' });
  const ms = await messages(s.id);
  assert.ok(!ms.some((m) => m.text === 'Остановлено пользователем'));
  await settled(s.id);
});

test('settings: attempts and the wake-up time; bad values are refused', async () => {
  const s = (await h.api('PUT', '/api/settings', { session: { revive: { attempts: 5, stallWakeMin: 30 } } })).body;
  assert.deepEqual(s.session.revive, { attempts: 5, stallWakeMin: 30 });
  assert.equal((await h.api('PUT', '/api/settings', { session: { revive: { attempts: 99 } } })).status, 400);
});

test('«Extension store is busy» at start: the same message again a few seconds later, no «не запустился»', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: `#busy start-${Date.now()} 1 привет` })).body;
  const ok = await waitFor(async () => (await messages(s.id)).some((m) => m.kind === 'assistant' && /Hello from mock agent/.test(m.text)), { timeout: 20000, what: 'started on the retry' });
  assert.ok(ok);
  const ms = await messages(s.id);
  assert.ok(ms.some((m) => m.kind === 'system' && /занят другим запуском \(ExtensionStoreBusyError\) — повторяю через \d+ с \(попытка 1 из 4\)/.test(m.text)));
  assert.ok(!ms.some((m) => m.kind === 'error'), 'no error card for a collision that cleared');
});

test('a helper that never starts ends its caller\'s wait with «failed» — the orchestrator does not hang', async () => {
  const caller = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: `#run helper #busy never-${Date.now()} 99 #done ок` })).body;
  const said = await waitFor(async () => (await messages(caller.id)).find((m) => m.kind === 'assistant' && /worker_run result:/.test(m.text)), { timeout: 60000, what: 'the wait ended' });
  assert.match(said.text, /Субагент не смог работать/);
});
