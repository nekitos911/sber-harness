// Tidying up: archive / unarchive (a working session only with stop), auto-archive of inactive sessions, delete guard.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { CODE_ROOT } from '../server/config.js';
import { startTestServer, tmpDir, rmrf, waitFor } from './helpers.js';

const root = tmpDir();
after(() => rmrf(root));

test('archive: refused while working unless stop; virtual sub-agents follow; unarchive; delete needs force while working', async () => {
  const h = await startTestServer();
  try {
    const state = async () => (await h.api('GET', '/api/state')).body;
    const sub = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: '#subagent' })).body;
    await waitFor(async () => (await state()).sessions.find((s) => s.id === sub.id).status === 'idle', { what: 'subagent turn' });
    const kids = (await state()).sessions.filter((s) => s.virtual && s.parentId === sub.id);
    assert.ok(kids.length > 0, 'the fixture opens a virtual sub-agent chat');
    const archived = (await h.api('PATCH', `/api/sessions/${sub.id}`, { archived: true })).body;
    assert.ok(archived.archived && archived.archivedAt > 0);
    assert.ok((await state()).sessions.filter((s) => s.parentId === sub.id && s.virtual).every((s) => s.archived), 'virtual children archived too');
    assert.equal((await h.api('PATCH', `/api/sessions/${sub.id}`, { archived: false })).body.archived, false);

    const busy = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: '#silent' })).body;
    await waitFor(async () => (await state()).sessions.find((s) => s.id === busy.id).status === 'running', { what: 'running' });
    assert.equal((await h.api('PATCH', `/api/sessions/${busy.id}`, { archived: true })).status, 409);
    assert.equal((await h.api('DELETE', `/api/sessions/${busy.id}`)).status, 409);
    const stopped = (await h.api('PATCH', `/api/sessions/${busy.id}`, { archived: true, stop: true })).body;
    assert.deepEqual([stopped.archived, stopped.status], [true, 'stopped']);
    await waitFor(async () => (await state()).sessions.find((s) => s.id === busy.id).pid === null, { what: 'process gone' });

    const again = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: '#silent' })).body;
    await waitFor(async () => (await state()).sessions.find((s) => s.id === again.id).status === 'running', { what: 'running' });
    assert.equal((await h.api('DELETE', `/api/sessions/${again.id}?force=1`)).status, 200);
    assert.ok(!(await state()).sessions.some((s) => s.id === again.id));
    assert.ok(!fs.existsSync(path.join(h.dataDir, 'transcripts', `${again.id}.json`)));
  } finally {
    await h.close();
  }
});

test('auto-archive on start: only idle, unwaited, uninterrupted sessions without open work, older than autoArchiveDays', async () => {
  const dataDir = path.join(root, 'данные');
  fs.mkdirSync(dataDir);
  const old = Date.now() - 10 * 86400000;
  const chat = (id, extra = {}) => ({
    id, kind: 'chat', title: id, agent: 'mock', launcherId: 'mock', cwd: root, workspaceId: null, branch: null, role: 'solo', parentId: null,
    taskId: null, status: 'idle', externalSessionId: null, settingsPath: null, model: null, approvalMode: null, autoReport: false, queued: 0,
    queue: [], preview: '', command: null, pid: null, createdAt: old, lastActivityAt: old, ...extra,
  });
  const sessions = [
    chat('s_old'),
    chat('s_recent', { lastActivityAt: Date.now() }),
    chat('s_waiting', { waitingFor: 'answer' }),
    chat('s_interrupted', { interrupted: { at: old, reason: 'crash', lastActivity: null } }),
    chat('s_owner'),
    chat('s_coord', { role: 'coordinator' }),
    chat('s_worker', { role: 'worker', parentId: 's_coord', lastActivityAt: Date.now() }),
    { ...chat('s_term'), kind: 'terminal', agent: 'shell', launcherId: null, status: 'exited' },
  ];
  const tasks = [{ id: 'T-1', title: 'в работе', status: 'in_progress', assigneeSessionId: 's_owner', deps: [], labels: [], targets: ['main'], ports: [], log: [], order: 1 }];
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ seq: { task: 1 }, tasks, workspaces: [], notifications: [], sessions }));
  const configFile = path.join(root, 'config.json');
  fs.copyFileSync(path.join(CODE_ROOT, 'harness.config.json'), configFile);
  const srv = await startServer({ dataDir, configFile, port: 0, configOverrides: { mcpServersFrom: null, terminal: { autoRespawn: false }, sessions: { autoArchiveDays: 7 }, agents: { mock: { modelsDiscovery: null } } } });
  try {
    const st = await (await fetch(`${srv.url}/api/state`, { headers: { 'x-harness-token': srv.token } })).json();
    const archived = st.sessions.filter((s) => s.archived).map((s) => s.id).sort();
    assert.deepEqual(archived, ['s_old', 's_term']);
    assert.equal((await (await fetch(`${srv.url}/api/settings`, { headers: { 'x-harness-token': srv.token } })).json()).sessions.autoArchiveDays, 7);
  } finally {
    await srv.close();
  }
});
