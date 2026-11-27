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
    // a finished turn: its answer waits for a look (finishedAt later than dismissedAt) until the chat is opened or «×»
    const answered = (await state()).sessions.find((s) => s.id === sub.id);
    assert.ok(answered.finishedAt > 0 && answered.finishedAt > (answered.dismissedAt ?? 0), 'a finished turn is stamped, not yet seen');
    // «Убрать из «Ждут вас»»: seen at, the chat stays; a non-boolean is refused
    const seen = (await h.api('PATCH', `/api/sessions/${sub.id}`, { dismissed: true })).body;
    assert.ok(seen.dismissedAt >= seen.lastActivityAt && seen.dismissedAt >= seen.finishedAt && !seen.archived);
    assert.equal((await h.api('PATCH', `/api/sessions/${sub.id}`, { dismissed: 'да' })).status, 400);

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
    chat('s_interrupted', { status: 'running' }), // cut by this restart: «прервана», waits for the person
    chat('s_stale', { interrupted: { at: old, reason: 'crash', lastActivity: null } }), // a mark of an earlier restart, ignored since: an old idle chat like any
    chat('s_owner'),
    chat('s_coord', { role: 'coordinator' }),
    chat('s_worker', { role: 'worker', parentId: 's_coord', lastActivityAt: Date.now() }),
    { ...chat('s_term'), kind: 'terminal', agent: 'shell', launcherId: null, status: 'exited' },
  ];
  const tasks = [{ id: 'T-1', title: 'в работе', status: 'in_progress', assigneeSessionId: 's_owner', deps: [], labels: [], targets: ['main'], ports: [], log: [], order: 1 }];
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ seq: { task: 1 }, tasks, workspaces: [], notifications: [], sessions }));
  const configFile = path.join(root, 'config.json');
  fs.copyFileSync(path.join(CODE_ROOT, 'harness.config.json'), configFile);
  const srv = await startServer({ dataDir, configFile, port: 0, configOverrides: { mcpServersFrom: null, history: { adopt: false }, terminal: { autoRespawn: false }, sessions: { autoArchiveDays: 7 }, agents: { mock: { modelsDiscovery: null } } } });
  try {
    const st = await (await fetch(`${srv.url}/api/state`, { headers: { 'x-harness-token': srv.token } })).json();
    const archived = st.sessions.filter((s) => s.archived).map((s) => s.id).sort();
    assert.deepEqual(archived, ['s_old', 's_stale', 's_term']);
    assert.equal((await (await fetch(`${srv.url}/api/settings`, { headers: { 'x-harness-token': srv.token } })).json()).sessions.autoArchiveDays, 7);
  } finally {
    await srv.close();
  }
});

test('purge on start: archived longer than purgeArchivedDays are deleted with their files; pinned, task-held and leftover run folders', async () => {
  const dataDir = path.join(root, 'данные чистка');
  fs.mkdirSync(path.join(dataDir, 'runs'), { recursive: true });
  const old = Date.now() - 40 * 86400000;
  const chat = (id, extra = {}) => ({
    id, kind: 'chat', title: id, agent: 'mock', launcherId: 'mock', cwd: root, workspaceId: null, branch: null, role: 'solo', parentId: null,
    taskId: null, status: 'idle', externalSessionId: null, settingsPath: null, model: null, approvalMode: null, autoReport: false, queued: 0,
    queue: [], preview: '', command: null, pid: null, createdAt: old, lastActivityAt: old, archived: true, archivedAt: old, ...extra,
  });
  const sessions = [chat('s_gone'), chat('s_pinned', { pinnedAt: old }), chat('s_held'), chat('s_fresh', { archivedAt: Date.now() }), chat('s_live', { archived: false })];
  const tasks = [{ id: 'T-1', title: 'не закрыта', status: 'review', assigneeSessionId: 's_held', deps: [], labels: [], targets: ['main'], ports: [], log: [], order: 1 }];
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ seq: { task: 1 }, tasks, workspaces: [], notifications: [], sessions }));
  for (const id of ['s_gone', 's_orphan', 's_young_orphan']) fs.mkdirSync(path.join(dataDir, 'runs', id, 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'runs', 's_gone', 'turn-1.out.ndjson'), '{}');
  const dayAgo = new Date(Date.now() - 2 * 86400000);
  for (const id of ['s_gone', 's_orphan']) fs.utimesSync(path.join(dataDir, 'runs', id), dayAgo, dayAgo);
  const configFile = path.join(root, 'config чистка.json');
  fs.copyFileSync(path.join(CODE_ROOT, 'harness.config.json'), configFile);
  const srv = await startServer({ dataDir, configFile, port: 0, configOverrides: { mcpServersFrom: null, history: { adopt: false }, terminal: { autoRespawn: false }, sessions: { autoArchiveDays: 0, purgeArchivedDays: 30 }, agents: { mock: { modelsDiscovery: null } } } });
  try {
    const st = await (await fetch(`${srv.url}/api/state`, { headers: { 'x-harness-token': srv.token } })).json();
    assert.deepEqual(st.sessions.map((s) => s.id).sort(), ['s_fresh', 's_held', 's_live', 's_pinned']);
    assert.ok(!fs.existsSync(path.join(dataDir, 'runs', 's_gone')), 'its run folder went with it');
    assert.ok(!fs.existsSync(path.join(dataDir, 'runs', 's_orphan')), 'a leftover run folder of no session');
    assert.ok(fs.existsSync(path.join(dataDir, 'runs', 's_young_orphan')), 'a folder younger than a day may belong to a session being created');
  } finally {
    await srv.close();
  }
});

test('a long chat keeps the files of its last 10 turns in its run folder (the transcript has all of them)', async () => {
  const h = await startTestServer();
  try {
    const session = async (id) => (await h.api('GET', '/api/state')).body.sessions.find((s) => s.id === id);
    const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: 'ход 1' })).body;
    for (let n = 2; n <= 13; n++) {
      await waitFor(async () => { const x = await session(s.id); return x.status === 'idle' && !x.pid && !x.turnClosing; }, { what: `turn ${n - 1}` });
      await h.api('POST', `/api/sessions/${s.id}/messages`, { text: `ход ${n}` });
    }
    await waitFor(async () => { const x = await session(s.id); return x.status === 'idle' && !x.pid && x.turnCount === 13; }, { what: 'turn 13' });
    const turns = fs.readdirSync(path.join(h.dataDir, 'runs', s.id)).filter((f) => /^turn-\d+\.out\.ndjson$/.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);
    assert.deepEqual(turns, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    assert.equal((await h.api('GET', `/api/sessions/${s.id}/messages`)).body.filter((m) => m.kind === 'user').length, 13);
  } finally {
    await h.close();
  }
});
