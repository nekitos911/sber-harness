// A turn that broke (a crash, a dropped connection) or went silent is continued by the harness, not dropped: a few
// attempts with pauses, then a notification with «Повторить».
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, tmpDir, rmrf, waitFor } from './helpers.js';
import { CODE_ROOT } from '../server/config.js';

const root = tmpDir();
let h;
before(async () => {
  h = await startTestServer({
    session: { stallSec: 1, stallCheckSec: 0.3, revive: { attempts: 2, delaysSec: [0.2, 0.3], stallWakeMin: 0.02 } },
    // one cold start at a time (agents.<id>.maxStarting)
    agents: { mockone: { launcher: 'mock', label: 'Mock one', approvalMode: 'auto', approvalModes: ['default', 'auto'], maxStarting: 1, spawnGapMs: 0, modelsDiscovery: null } },
  });
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

test('GigaCode\'s «Unable to update lock within the stale threshold» at start: retried the same way', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: `#busylock lock-${Date.now()} 1 привет` })).body;
  await waitFor(async () => (await messages(s.id)).some((m) => m.kind === 'assistant' && /Hello from mock agent/.test(m.text)), { timeout: 20000, what: 'started on the retry' });
  const ms = await messages(s.id);
  assert.ok(ms.some((m) => m.kind === 'system' && /занят другим запуском \(Unable to update lock within the stale threshold\)/.test(m.text)));
  assert.ok(!ms.some((m) => m.kind === 'error'), 'no error card');
});

test('GigaCode\'s «protected storage is unavailable» at start: retried the same way', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: `#busysecret secret-${Date.now()} 1 привет` })).body;
  await waitFor(async () => (await messages(s.id)).some((m) => m.kind === 'assistant' && /Hello from mock agent/.test(m.text)), { timeout: 20000, what: 'started on the retry' });
  const ms = await messages(s.id);
  assert.ok(ms.some((m) => m.kind === 'system' && /занят другим запуском \(protected storage is unavailable\)/.test(m.text)));
  assert.ok(!ms.some((m) => m.kind === 'error'), 'no error card');
});

test('«Повторить» on a chat that cannot start: one «продолжи» stays in its queue, not one more per click', async () => {
  const dir = path.join(root, 'исчезнет');
  fs.mkdirSync(dir);
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: dir, prompt: 'привет' })).body;
  await waitFor(async () => (await session(s.id)).status === 'idle', { what: 'first turn' });
  rmrf(dir); // the next turns cannot start: their messages go back to the queue
  for (let i = 0; i < 3; i++) {
    assert.equal((await h.api('POST', `/api/sessions/${s.id}/revive`)).status, 200);
    await settled(s.id);
  }
  const q = (await session(s.id)).queue;
  assert.equal(q.filter((x) => /Предыдущий ход оборвался/.test(x.text)).length, 1, JSON.stringify(q.map((x) => x.text.slice(0, 40))));
});

test('a helper that never starts ends its caller\'s wait with «failed» — the orchestrator does not hang', async () => {
  const caller = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: `#run helper #busy never-${Date.now()} 99 #done ок` })).body;
  const said = await waitFor(async () => (await messages(caller.id)).find((m) => m.kind === 'assistant' && /worker_run result:/.test(m.text)), { timeout: 60000, what: 'the wait ended' });
  assert.match(said.text, /Субагент не смог работать/);
});

test('«Прервать и отправить»: the running turn stops, the queued message goes at once', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: 'привет' })).body;
  await waitFor(async () => (await session(s.id)).status === 'idle', { what: 'first turn' });
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: '#slow долго' });
  await waitFor(async () => (await session(s.id)).status === 'running', { what: 'running' });
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'срочно вот это' });
  assert.equal((await session(s.id)).queued, 1);
  assert.equal((await h.api('POST', `/api/sessions/${s.id}/queue/send`, { interrupt: true })).status, 200);
  await waitFor(async () => { const ms = await messages(s.id); const i = ms.findIndex((m) => m.text === 'срочно вот это'); return i >= 0 && ms.slice(i).some((m) => m.kind === 'assistant'); }, { timeout: 20000, what: 'the queued message ran' });
  const ms = await messages(s.id);
  assert.ok(ms.some((m) => m.text === 'Остановлено пользователем'));
  assert.equal((await session(s.id)).queued, 0);
});

test('cold starts of one agent wait for a slot (maxStarting): the second chat says it waits, then runs', async () => {
  // the first process says nothing for a while: it holds the only start slot
  const a = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mockone', cwd: root, prompt: '#silent 2500' })).body;
  await waitFor(async () => (await session(a.id)).pid, { what: 'first started' });
  const b = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mockone', cwd: root, prompt: 'привет' })).body;
  const waiting = await waitFor(async () => { const x = await session(b.id); return x.startWait === 1 && x; }, { what: 'second waits' });
  assert.equal(waiting.phase, 'starting');
  assert.equal(waiting.pid, null, 'nothing spawned while the slot is taken');
  await waitFor(async () => { const x = await session(b.id); return x.status === 'idle' && !x.startWait; }, { timeout: 15000, what: 'second ran after the first' });
  assert.ok((await messages(b.id)).some((m) => m.kind === 'assistant'));
});

test('«Переподключить MCP» while the turn still waits for its start slot: no extra «continue» turn', async () => {
  const a = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mockone', cwd: root, prompt: '#silent 2500' })).body;
  await waitFor(async () => (await session(a.id)).pid, { what: 'first started' });
  const b = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mockone', cwd: root, prompt: 'привет' })).body;
  await waitFor(async () => (await session(b.id)).startWait === 1, { what: 'second waits' });
  assert.equal((await h.api('POST', `/api/sessions/${b.id}/restart`, { keepContext: true })).status, 200);
  await waitFor(async () => { const x = await session(b.id); return x.status === 'idle' && !x.pid && (x.queue || []).length === 0; }, { timeout: 15000, what: 'second ran' });
  await new Promise((r) => setTimeout(r, 1000));
  const ms = await messages(b.id);
  assert.ok(!ms.some((m) => m.kind === 'user' && /Предыдущий ход оборвался/.test(m.text)), JSON.stringify(ms.map((m) => m.text)));
  assert.ok(!ms.some((m) => m.kind === 'assistant' && /turn 2/.test(m.text)), 'one turn');
});

test('a chat that keeps failing to start stops retrying after 4 failed starts in a row, whatever the retry kind', async () => {
  const h2 = await startTestServer({ session: { revive: { attempts: 10, delaysSec: [0.2] } } });
  try {
    const st = async (id) => (await h2.api('GET', '/api/state')).body.sessions.find((s) => s.id === id);
    const s = (await h2.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: 'привет' })).body;
    await waitFor(async () => (await st(s.id)).status === 'idle', { what: 'first turn' });
    await h2.api('POST', `/api/sessions/${s.id}/messages`, { text: 'сделай #crashalways' });
    const said = await waitFor(async () => (await h2.api('GET', `/api/sessions/${s.id}/messages`)).body.find((m) => m.kind === 'system' && /не стартует 4 раза подряд/.test(m.text)), { timeout: 30000, what: 'gave up' });
    assert.ok(said);
    await new Promise((r) => setTimeout(r, 1500)); // no more revive after that
    const x = await st(s.id);
    assert.deepEqual([x.status, x.startFailStreak], ['error', 4]);
    assert.ok((await h2.api('GET', '/api/state')).body.notifications.some((n) => n.sessionId === s.id && /не стартует 4 раза подряд/.test(n.text)));
  } finally {
    await h2.close();
  }
});

test('a turn that keeps breaking mid-work: retried 5 times by default, the person hears of it after the 3rd and the tries go on', async () => {
  const acp = { launcher: 'mock', label: 'ACP mock', transport: 'acp', command: [process.execPath, path.join(CODE_ROOT, 'scripts', 'mock-acp-agent.js')], approvalMode: 'auto', approvalModes: ['default', 'auto'] };
  const h3 = await startTestServer({ session: { revive: { delaysSec: [0.2] } }, agents: { acpmock: acp } });
  try {
    const st = async (id) => (await h3.api('GET', '/api/state')).body.sessions.find((s) => s.id === id);
    const s = (await h3.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpmock', cwd: root, prompt: 'привет' })).body;
    await waitFor(async () => (await st(s.id)).status === 'idle', { what: 'first turn' });
    await h3.api('POST', `/api/sessions/${s.id}/messages`, { text: 'сделай #diealways' });
    await waitFor(async () => (await st(s.id)).revive?.gaveUp, { timeout: 60000, what: 'gave up after the default attempts' });
    const ms = (await h3.api('GET', `/api/sessions/${s.id}/messages`)).body;
    assert.ok(ms.some((m) => m.kind === 'system' && /попытка 5 из 5/.test(m.text)), 'five tries by default');
    const notes = (await h3.api('GET', '/api/state')).body.notifications.filter((n) => n.sessionId === s.id && n.kind === 'escalation');
    assert.ok(notes.some((n) => /обрывается уже 3 раза .*Продолжаю пробовать/.test(n.text)), JSON.stringify(notes.map((n) => n.text)));
    assert.ok(notes.some((n) => /после 5 повторов/.test(n.text)), 'and once more when they ran out');
  } finally {
    await h3.close();
  }
});
