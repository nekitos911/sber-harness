// Session recovery after a restart: turns the harness could not continue are listed with a reason and resumed
// (or dismissed) on request, or automatically with recovery.autoResume.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { CODE_ROOT } from '../server/config.js';
import { interruptReason } from '../server/sessions.js';
import { killTree, isAlive } from '../server/runner.js';
import { tmpDir, rmrf, waitFor } from './helpers.js';

const root = tmpDir();
const cwd = path.join(root, 'папка');
fs.mkdirSync(cwd);
process.env.MOCK_AGENT_STATE_DIR = path.join(root, 'mock-state');
const configFile = path.join(root, 'config.json');
fs.copyFileSync(path.join(CODE_ROOT, 'harness.config.json'), configFile);
after(() => rmrf(root));

async function harness(dataDir, extra = {}) {
  const srv = await startServer({ dataDir, configFile, port: 0, configOverrides: { defaultAgent: 'mock', mcpServersFrom: null, history: { adopt: false }, agents: { mock: { modelsDiscovery: null } }, ...extra } });
  const api = async (method, p, body) => {
    const res = await fetch(srv.url + p, { method, headers: { 'x-harness-token': srv.token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const state = async () => (await api('GET', '/api/state')).body;
  const messages = async (id) => (await api('GET', `/api/sessions/${id}/messages`)).body;
  return { srv, api, state, messages };
}

/** Two slow turns, then the harness stops and their processes die while it is down (a reboot would do the same). */
async function interruptedPair(dataDir, { leaveServerJson = false, count = 2 } = {}) {
  const h = await harness(dataDir);
  const ids = [];
  for (let i = 0; i < count; i++) {
    const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd, prompt: '#slow' })).body;
    await waitFor(async () => (await h.messages(s.id)).some((m) => m.kind === 'assistant' && m.text.includes('slow')), { what: 'slow output' });
    ids.push(s.id);
  }
  await h.srv.close();
  const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  for (const id of ids) {
    const { pid } = db.sessions.find((s) => s.id === id);
    if (isAlive(pid)) killTree(pid);
    await waitFor(() => !isAlive(pid), { what: 'agent killed' });
  }
  if (leaveServerJson) fs.writeFileSync(path.join(dataDir, 'server.json'), JSON.stringify({ url: 'http://127.0.0.1:1', pid: 999999 }));
  return ids;
}

test('interrupted turns: reason, recovery notification, GET lists them, resume continues via --resume, dismiss clears', async () => {
  const dataDir = path.join(root, 'данные 1');
  const [a, b] = await interruptedPair(dataDir);
  const h = await harness(dataDir);
  try {
    const list = (await h.api('GET', '/api/recovery')).body;
    assert.deepEqual(list.sessions.map((s) => s.id).sort(), [a, b].sort());
    const item = list.sessions.find((s) => s.id === a);
    assert.deepEqual([item.reason, item.cwd, item.role], ['harness_restart', cwd, 'solo']);
    assert.match(item.lastActivity, /^read_file README\.md$|slow/);
    assert.match(list.message, /Был перезапуск/);
    const st = await h.state();
    assert.ok(st.notifications.some((n) => n.kind === 'recovery' && n.text === 'Прервано агентов: 2'));
    assert.equal(st.sessions.find((s) => s.id === a).status, 'idle');

    const r = (await h.api('POST', '/api/recovery/resume', { sessionIds: [a], message: 'Продолжай' })).body;
    assert.deepEqual(r, { resumed: [a] });
    await waitFor(async () => (await h.messages(a)).some((m) => m.kind === 'assistant' && /resumed .*turn 2/.test(m.text)), { what: 'resumed turn' });
    assert.ok((await h.messages(a)).some((m) => m.kind === 'user' && m.text === 'Продолжай'));
    assert.deepEqual((await h.api('POST', '/api/recovery/dismiss', { sessionIds: [b] })).body, { dismissed: [b] });
    assert.deepEqual((await h.api('GET', '/api/recovery')).body.sessions, []);
    assert.equal((await h.api('POST', '/api/recovery/resume', { sessionIds: 'x' })).status, 400);
    await waitFor(async () => (await h.state()).sessions.find((s) => s.id === a).status === 'idle', { what: 'resumed turn done' });
  } finally {
    await h.srv.close();
  }
});

test('crash (server.json left behind) and autoResume: the configured message goes out on startup', async () => {
  const dataDir = path.join(root, 'данные 2');
  const [a] = await interruptedPair(dataDir, { leaveServerJson: true });
  const h = await harness(dataDir, { recovery: { autoResume: true } });
  try {
    await waitFor(async () => (await h.messages(a)).some((m) => m.kind === 'user' && /^Был перезапуск/.test(m.text)), { what: 'auto-resume message' });
    await waitFor(async () => (await h.state()).sessions.every((s) => s.status === 'idle' && !s.interrupted), { what: 'both resumed', timeout: 30000 });
    const last = (await h.messages(a)).filter((m) => m.kind === 'system').map((m) => m.text);
    assert.ok(last.some((t) => /Harness перезапущен/.test(t)));
    assert.equal((await h.api('GET', '/api/settings')).body.recovery.autoResume, true);
  } finally {
    await h.srv.close();
  }
  const dataDir3 = path.join(root, 'данные 3');
  const [c] = await interruptedPair(dataDir3, { leaveServerJson: true, count: 1 });
  const h3 = await harness(dataDir3);
  try {
    assert.deepEqual((await h3.api('GET', '/api/recovery')).body.sessions.map((s) => [s.id, s.reason]), [[c, 'crash']]);
  } finally {
    await h3.srv.close();
  }
  assert.equal(interruptReason({ startedAt: 1000, bootTime: 2000, crashed: true }), 'reboot');
  assert.equal(interruptReason({ startedAt: 3000, bootTime: 2000, crashed: true }), 'crash');
  assert.equal(interruptReason({ startedAt: 3000, bootTime: 2000, crashed: false }), 'harness_restart');
});

test('recovery lists leads only: cut sub-agents go under their orchestrator, which gets them by id and decides', async () => {
  const dataDir = path.join(root, 'данные лидеры');
  fs.mkdirSync(dataDir);
  const at = Date.now() - 60000;
  const cut = { at, reason: 'reboot', lastActivity: 'Edit' };
  const chat = (id, extra = {}) => ({
    id, kind: 'chat', title: id, agent: 'mock', launcherId: 'mock', cwd, workspaceId: null, branch: null, role: 'solo', parentId: null,
    taskId: null, status: 'idle', externalSessionId: null, settingsPath: null, model: null, approvalMode: null, autoReport: false, queued: 0,
    queue: [], preview: '', command: null, pid: null, createdAt: at, lastActivityAt: at, everStarted: true, ...extra,
  });
  const sessions = [
    chat('s_coord', { role: 'coordinator', interrupted: cut }),
    chat('s_worker', { role: 'worker', parentId: 's_coord', interrupted: cut }),
    chat('s_lead', {}), // not cut itself: its cut helper is still its call
    chat('s_helper', { role: 'worker', parentId: 's_lead', ephemeral: true, interrupted: cut }),
  ];
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ seq: { task: 0 }, tasks: [], workspaces: [], notifications: [], sessions }));
  const h = await harness(dataDir);
  try {
    const list = (await h.api('GET', '/api/recovery')).body.sessions;
    assert.deepEqual(list.map((x) => [x.id, x.interrupted, x.subagents.map((y) => y.id)]).sort(), [['s_coord', true, ['s_worker']], ['s_lead', false, ['s_helper']]]);
    // naming the sub-agent means its lead
    const r = (await h.api('POST', '/api/recovery/resume', { sessionIds: ['s_worker', 's_helper'], message: 'продолжай' })).body;
    assert.deepEqual(r.resumed.sort(), ['s_coord', 's_lead']);
    const told = await waitFor(async () => (await h.messages('s_coord')).find((m) => m.kind === 'user'), { what: 'coordinator told' });
    assert.match(told.text, /^продолжай\n\n\[harness\] .*s_worker «s_worker».*send_message.*worker_stop/s);
    assert.match((await waitFor(async () => (await h.messages('s_lead')).find((m) => m.kind === 'user'))).text, /^\[harness\] .*s_helper/, 'a lead that was not cut gets only the list');
    const st = await h.state();
    assert.ok(['s_worker', 's_helper'].every((id) => !st.sessions.find((s) => s.id === id).interrupted), 'no longer listed');
    assert.equal((await h.messages('s_worker')).length, 0, 'the sub-agent is not started by the harness');
    assert.equal((await h.api('GET', '/api/recovery')).body.sessions.length, 0);
  } finally {
    await h.srv.close();
  }
});
