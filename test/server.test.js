import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { startTestServer, makeRepo, tmpDir, rmrf, waitFor, waitPidGone } from './helpers.js';

let h;
let repo;
const root = tmpDir();
before(async () => {
  repo = makeRepo(path.join(root, 'repo'));
  h = await startTestServer();
});
after(async () => {
  await h.close();
  rmrf(root);
});

const messages = async (sid) => (await h.api('GET', `/api/sessions/${sid}/messages`)).body;
const state = async () => (await h.api('GET', '/api/state')).body;

test('security: Host guard, token, body limit', async () => {
  const port = new URL(h.srv.url).port;
  const status = (headers) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/state', headers }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(await status({ host: `evil.example:${port}`, 'x-harness-token': h.srv.token }), 403);
  assert.equal(await status({}), 401);
  assert.equal(await status({ 'x-harness-token': 'wrong' }), 401);
  assert.equal(await status({ 'x-harness-token': h.srv.token }), 200);
  assert.equal((await h.api('POST', '/api/tasks', { title: 'x'.repeat(1100 * 1024) })).status, 413);

  const wsStatus = (url, headers) => new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
  });
  const wsUrl = h.srv.url.replace('http', 'ws');
  assert.equal(await wsStatus(`${wsUrl}/ws`), 401);
  assert.equal(await wsStatus(`${wsUrl}/ws?token=${h.srv.token}`, { origin: 'http://evil.example' }), 403);
  assert.equal(await wsStatus(`${wsUrl}/ws?token=${h.srv.token}`), 'open');
});

test('index.html gets the token meta', async () => {
  const res = await fetch(`${h.srv.url}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('harness-token') || html.includes('npm run build'));
});

test('task CRUD, move ordering, deps', async () => {
  const mk = async (title, extra = {}) => (await h.api('POST', '/api/tasks', { title, ...extra })).body;
  const a = await mk('A');
  const b = await mk('B');
  const c = await mk('C', { deps: [a.id] });
  assert.equal(a.status, 'todo');
  assert.deepEqual(a.targets, ['develop']);
  assert.equal((await h.api('POST', '/api/tasks', { title: '' })).status, 400);
  assert.equal((await h.api('PATCH', `/api/tasks/${a.id}`, { deps: [c.id] })).status, 400, 'cycle rejected');

  await h.api('POST', `/api/tasks/${c.id}/move`, { status: 'todo', beforeId: a.id });
  const col = (await state()).tasks.filter((t) => t.status === 'todo' && [a.id, b.id, c.id].includes(t.id)).sort((x, y) => x.order - y.order).map((t) => t.title);
  assert.deepEqual(col, ['C', 'A', 'B']);

  let ready = (await h.api('POST', '/api/agent/task_list', { ready: true })).body.map((t) => t.id);
  assert.ok(ready.includes(a.id) && !ready.includes(c.id));
  await h.api('POST', `/api/tasks/${a.id}/move`, { status: 'done' });
  ready = (await h.api('POST', '/api/agent/task_list', { ready: true })).body.map((t) => t.id);
  assert.ok(ready.includes(c.id));

  const patched = (await h.api('PATCH', `/api/tasks/${b.id}`, { title: 'B2', comment: 'note', priority: 'high' })).body;
  assert.equal(patched.title, 'B2');
  assert.equal(patched.log.at(-1).text, 'note');
  assert.equal((await h.api('DELETE', `/api/tasks/${b.id}`)).status, 200);
  assert.equal((await h.api('PATCH', '/api/tasks/nope', { title: 'x' })).status, 404);
  assert.equal((await h.api('PATCH', `/api/tasks/${b.id}`, { title: 'x' })).status, 404);
});

test('chat session: two turns resume the same CLI session; crash shows stderr', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: 'hello' })).body;
  // idle at result; the process may still be closing (turnClosing): only then does a message start a turn at once
  await waitFor(async () => (await state()).sessions.find((x) => x.id === s.id && x.status === 'idle' && !x.turnClosing && x.externalSessionId), { what: 'turn 1' });
  const ext = (await state()).sessions.find((x) => x.id === s.id).externalSessionId;
  assert.deepEqual((await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'again' })).body, { queued: false });
  await waitFor(async () => (await messages(s.id)).some((m) => m.kind === 'assistant' && m.text.includes(`resumed ${ext}, turn 2`)), { what: 'turn 2' });

  const c = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: '#crash' })).body;
  const err = await waitFor(async () => (await messages(c.id)).find((m) => m.kind === 'error'), { what: 'crash error' });
  assert.match(err.text, /^Агент завершился с ошибкой \(код 1\):\nmock-agent: simulated crash/);
  assert.equal((await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'nope' })).status, 400);
});

test('coordinator spawns a worker; worker_done moves the task to review and wakes the parent', async () => {
  const coord = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', role: 'coordinator', cwd: repo, prompt: '#spawn do X #done' })).body;
  const worker = await waitFor(async () => (await state()).sessions.find((s) => s.parentId === coord.id), { what: 'worker session' });
  assert.equal(worker.role, 'worker');
  assert.ok(worker.taskId);
  const task = await waitFor(async () => (await state()).tasks.find((t) => t.id === worker.taskId && t.agentState === 'done'), { what: 'worker done badge' });
  assert.equal(task.status, 'in_progress', 'the card stays in its column');
  assert.equal(task.assigneeSessionId, worker.id);
  assert.ok(task.log.some((l) => l.type === 'agent_done' && l.text === 'Агент закончил' && l.data.summary));
  const delivered = await waitFor(async () => (await messages(coord.id)).find((m) => m.kind === 'user' && m.from === worker.id), { what: 'delivery to parent' });
  assert.match(delivered.text, /^\[harness\] Message from .*finished task/s);
  assert.ok((await state()).notifications.some((n) => n.kind === 'done' && n.sessionId === worker.id));
  assert.equal((await state()).sessions.find((s) => s.id === worker.id).status, 'done');
  // the coordinator wakes for the report (turn 2) and goes back to idle
  await waitFor(async () => (await messages(coord.id)).some((m) => m.kind === 'assistant' && m.turn === 2), { what: 'coordinator turn 2' });
  // a second worker on the same task while the first is active is refused
  const t2 = (await h.api('POST', '/api/tasks', { title: 'locked' })).body;
  const w2 = (await h.api('POST', '/api/agent/worker_start', { task_id: t2.id, agent: 'mock' })).body;
  assert.equal((await h.api('POST', '/api/agent/worker_start', { task_id: t2.id, agent: 'mock' })).status, 409);
  assert.equal((await h.api('POST', '/api/agent/task_update', { id: t2.id, title: 'x' }, { 'x-harness-session': coord.id })).status, 409);
  await h.api('POST', `/api/sessions/${w2.id}/stop`);
});

test('worker without parent: escalation and question go to notifications', async () => {
  const t = (await h.api('POST', '/api/tasks', { title: 'lonely #ask which db? | pg | mysql' })).body;
  const w = (await h.api('POST', `/api/tasks/${t.id}/assign`, { agent: 'mock', cwd: repo })).body;
  assert.equal(w.parentId, null);
  const q = await waitFor(async () => (await state()).notifications.find((n) => n.kind === 'question' && n.sessionId === w.id), { what: 'question' });
  assert.deepEqual([q.text, q.options], ['which db?', ['pg', 'mysql']]);
  const plain = (await h.api('POST', '/api/tasks', { title: 'silent worker' })).body;
  const w2 = (await h.api('POST', `/api/tasks/${plain.id}/assign`, { agent: 'mock', cwd: repo })).body;
  await waitFor(async () => (await state()).notifications.some((n) => n.kind === 'escalation' && n.sessionId === w2.id), { what: 'escalation' });
  const n = (await state()).notifications[0];
  assert.equal((await h.api('POST', `/api/notifications/${n.id}/read`)).body.read, true);
});

test('harness-mcp stdio server proxies tools/list and tools/call', async () => {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'mcp', 'harness-mcp.js')], {
    env: { ...process.env, HARNESS_URL: h.srv.url, HARNESS_TOKEN: h.srv.token, HARNESS_SESSION_ID: '' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const replies = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.set(msg.id, msg);
    }
  });
  const send = (o) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'tools/call', params: { name: 'task_list', arguments: {} } });
  send({ id: 4, method: 'tools/call', params: { name: 'task_get', arguments: { id: 'T-999' } } });
  try {
    await waitFor(() => replies.size >= 4, { what: 'mcp replies' });
    assert.equal(replies.get(1).result.protocolVersion, '2025-06-18');
    const names = replies.get(2).result.tools.map((t) => t.name);
    for (const n of ['task_list', 'worker_start', 'worker_done', 'workspace_list', 'task_port']) assert.ok(names.includes(n), n);
    assert.equal(replies.get(3).result.isError, false);
    assert.ok(Array.isArray(JSON.parse(replies.get(3).result.content[0].text)));
    assert.equal(replies.get(4).result.isError, true);
  } finally {
    child.kill();
  }
});

test('terminal session runs a command in a PTY', async (t) => {
  const isWin = process.platform === 'win32';
  const res = await h.api('POST', '/api/sessions', { kind: 'terminal', cwd: os.tmpdir(), command: isWin ? "Write-Output ('при' + 'вет' + (6*7001))" : 'echo "при""вет"$((6*7001))' });
  if (res.status === 501) return t.skip(res.body.error);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const s = res.body;
  const ws = new WebSocket(`${h.srv.url.replace('http', 'ws')}/ws?token=${h.srv.token}`);
  let out = '';
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString());
    if ((f.t === 'term' || f.t === 'term.replay') && f.id === s.id) out += f.data;
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'term.attach', id: s.id }));
  try {
    await waitFor(() => out.includes('привет42006'), { timeout: 20000, what: 'pty output (UTF-8)' });
  } finally {
    ws.close();
    await h.api('DELETE', `/api/sessions/${s.id}`);
    await waitPidGone(s.pid);
  }
});

test('restart: an interrupted chat turn becomes idle with a system message', async () => {
  const dataDir = tmpDir('harness-data-');
  const old = {
    id: 's_old', kind: 'chat', title: 'old', agent: 'mock', launcherId: 'mock', cwd: repo, workspaceId: null, branch: null, role: 'solo',
    parentId: null, taskId: null, status: 'running', externalSessionId: 'x', settingsPath: null, model: null, approvalMode: null,
    autoReport: false, queued: 2, preview: '', command: null, pid: 123, createdAt: 1, lastActivityAt: 1,
  };
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ seq: { task: 0 }, tasks: [], workspaces: [], notifications: [], sessions: [old] }));
  const srv = await startServer({ dataDir, port: 0, configOverrides: { history: { adopt: false }, agents: { mock: { modelsDiscovery: null } } } });
  try {
    const get = (p) => fetch(srv.url + p, { headers: { 'x-harness-token': srv.token } }).then((r) => r.json());
    const s = (await get('/api/state')).sessions[0];
    assert.deepEqual([s.status, s.queued, s.pid], ['idle', 0, null]);
    assert.match((await get('/api/sessions/s_old/messages'))[0].text, /Harness перезапущен/);
  } finally {
    await srv.close();
    rmrf(dataDir);
  }
});

test('stop: status is stopped at once and a late exit never overwrites it; the next message resumes', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: 'hi' })).body;
  await waitFor(async () => (await state()).sessions.find((x) => x.id === s.id && x.status === 'idle' && x.externalSessionId), { what: 'turn 1' });
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: '#slow' });
  await waitFor(async () => (await messages(s.id)).some((m) => m.kind === 'assistant' && m.text.includes('slow')), { what: 'slow output' });
  assert.equal((await h.api('POST', `/api/sessions/${s.id}/stop`)).body.status, 'stopped');
  await waitFor(async () => (await messages(s.id)).some((m) => m.text === 'Остановлено пользователем'), { what: 'process exit' });
  const after = (await state()).sessions.find((x) => x.id === s.id);
  assert.deepEqual([after.status, after.pid], ['stopped', null]);
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'continue' });
  await waitFor(async () => (await messages(s.id)).some((m) => m.kind === 'assistant' && /resumed .*turn 3/.test(m.text)), { what: 'resume after stop' });
});

test('non-JSON stdout lines become one system message; a chat without a repo gets its own folder; tokens add up', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', prompt: '#raw' })).body;
  assert.equal(s.cwd, path.join(h.dataDir, 'chats', s.id));
  assert.ok(fs.statSync(s.cwd).isDirectory());
  const sys = await waitFor(async () => (await messages(s.id)).find((m) => m.kind === 'system' && m.text.includes('plain line 1')), { what: 'raw lines' });
  assert.match(sys.text, /plain line 1\nplain line 2/);
  const done = await waitFor(async () => (await state()).sessions.find((x) => x.id === s.id && x.status === 'idle'));
  assert.deepEqual([done.tokensIn, done.tokensOut], [10, 5]);
});

test('ask with options reaches the parent as a user message with options', async () => {
  const coord = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', role: 'coordinator', cwd: repo })).body;
  const w = (await h.api('POST', '/api/agent/worker_start', { spec: 'quiet work', agent: 'mock' }, { 'x-harness-session': coord.id })).body;
  assert.equal(w.parentId, coord.id);
  const r = await h.api('POST', '/api/agent/ask', { question: 'Which port?', options: ['8080', '9090'] }, { 'x-harness-session': w.id });
  assert.equal(r.body.delivered, coord.id);
  const m = await waitFor(async () => (await messages(coord.id)).find((x) => x.kind === 'user' && x.from === w.id && x.text.includes('Which port?')), { what: 'question at parent' });
  assert.deepEqual(m.options, ['8080', '9090']);
});

test('websocket: frames after a client vanished do not break the server', async () => {
  const ws = new WebSocket(`${h.srv.url.replace('http', 'ws')}/ws?token=${h.srv.token}`);
  await new Promise((r) => ws.on('open', r));
  ws.terminate();
  for (let i = 0; i < 5; i++) await h.api('POST', '/api/tasks', { title: `burst ${i}` });
  const ws2 = new WebSocket(`${h.srv.url.replace('http', 'ws')}/ws?token=${h.srv.token}`);
  const frame = new Promise((r) => ws2.on('message', (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.t === 'task' && f.task.title === 'after') r(f);
  }));
  await new Promise((r) => ws2.on('open', r));
  await h.api('POST', '/api/tasks', { title: 'after' });
  assert.equal((await frame).task.title, 'after');
  ws2.close();
});

test('settings: read, validate, save to the local config file', async () => {
  const s = (await h.api('GET', '/api/settings')).body;
  assert.equal(s.agents.mock.approvalMode, 'auto');
  assert.equal(s.defaultAgent, 'mock');
  assert.equal((await h.api('PUT', '/api/settings', { agents: { mock: { approvalMode: 'yolo' } } })).status, 400);
  assert.equal((await h.api('PUT', '/api/settings', { agents: { mock: { taskPromptTemplate: 'do it' } } })).status, 400);
  assert.equal((await h.api('PUT', '/api/settings', { agents: { mock: { modelGrades: { turbo: 'x' } } } })).status, 400);
  const saved = (await h.api('PUT', '/api/settings', {
    agents: { mock: { approvalMode: 'plan', modelGrades: { default: 'm-big', fast: 'm-small' }, allowedGrades: ['default'], taskPromptTemplate: '/full-task-ui {taskUrl}{notes}' } },
    tasks: { refreshSec: 30 },
  })).body;
  assert.deepEqual(saved.agents.mock.modelGrades, { default: 'm-big', fast: 'm-small', review: 'GLM-5.3-Flash-262k', explore: 'Qwen3.6-35B-262k' });
  const local = JSON.parse(fs.readFileSync(h.configFile.replace(/\.json$/, '.local.json'), 'utf8'));
  assert.deepEqual(local.agents.mock, { approvalMode: 'plan', settings: { agents: { modelGrades: { default: 'm-big', fast: 'm-small' }, allowedGrades: ['default'] } }, taskPromptTemplate: '/full-task-ui {taskUrl}{notes}' });
  assert.equal(local.integrations.tasks.refreshSec, 30);
  const chat = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo })).body;
  // grades merge over the configured defaults; the allowed list is replaced
  assert.deepEqual(JSON.parse(fs.readFileSync(chat.settingsPath, 'utf8')).agents, { modelGrades: { default: 'm-big', fast: 'm-small', review: 'GLM-5.3-Flash-262k', explore: 'Qwen3.6-35B-262k' }, allowedGrades: ['default'] });
  await h.api('PUT', '/api/settings', { agents: { mock: { approvalMode: 'auto', taskPromptTemplate: null } } });
});

test('subagents registry route; board: manual status, hidden imported tasks, tracker-status 501', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo })).body;
  const reg = path.join(h.dataDir, 'runs', s.id, 'registry');
  fs.mkdirSync(path.join(reg, 'sub1'), { recursive: true });
  fs.writeFileSync(path.join(reg, 'sub1', 'agent.json'), JSON.stringify({ id: 'sub1', name: 'explorer', startedAt: Date.now(), state: 'working' }));
  fs.mkdirSync(path.join(reg, 'bad'));
  const sub = (await h.api('GET', `/api/sessions/${s.id}/subagents`)).body;
  assert.deepEqual(sub.items.map((i) => [i.id, i.state, i.tokensIn]), [['sub1', 'working', 0]]);
  assert.deepEqual(sub.problems.map((p) => p.agentId), ['bad']);

  const t = (await h.api('POST', '/api/tasks', { title: 'imported one' })).body;
  await h.api('PATCH', `/api/tasks/${t.id}`, { source: 'tracker', externalId: 'EXT-9' });
  assert.equal((await h.api('PATCH', `/api/tasks/${t.id}`, { status: 'review' })).body.statusManual, true);
  await h.api('DELETE', `/api/tasks/${t.id}`);
  const hidden = (await state()).tasks.find((x) => x.id === t.id);
  assert.equal(hidden.hidden, true);
  assert.equal((await h.api('POST', `/api/tasks/${t.id}/tracker-status`, { status: 'Done' })).status, 501);
});

test('run outcomes: silent exit 0 is an error, stderr at exit 0 is a warning, phase starting -> null', async () => {
  const quiet = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: '#nooutput' })).body;
  const err = await waitFor(async () => (await messages(quiet.id)).find((m) => m.kind === 'error'), { what: 'silent failure' });
  assert.match(err.text, /ничего не выведя[\s\S]*identities do not match/);
  assert.equal((await state()).sessions.find((x) => x.id === quiet.id).status, 'error');

  const warn = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: '#warn' })).body;
  const w = await waitFor(async () => (await messages(warn.id)).find((m) => m.kind === 'system' && m.text.startsWith('⚠')), { what: 'warning' });
  assert.match(w.text, /java-lsp/);
  assert.equal((await state()).sessions.find((x) => x.id === warn.id).status, 'idle');

  const slow = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: '#silent' })).body;
  await waitFor(async () => (await state()).sessions.find((x) => x.id === slow.id).phase === 'starting', { what: 'phase starting' });
  await h.api('POST', `/api/sessions/${slow.id}/stop`);
  await waitFor(async () => (await state()).sessions.find((x) => x.id === slow.id).pid === null, { what: 'stopped' });
  assert.equal((await state()).sessions.find((x) => x.id === slow.id).phase, null);
});

test('built-in sub-agent activity lands on the parent tool call, not in the main chat', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: '#subagent' })).body;
  await waitFor(async () => (await state()).sessions.find((x) => x.id === s.id && x.status === 'idle'));
  const msgs = await messages(s.id);
  const agentCall = msgs.find((m) => m.kind === 'tool' && m.tool.id === 'call_agent_1');
  assert.deepEqual(agentCall.tool.progress, ['Reviewing…', '→ grep_search {"pattern":"TODO"}', '✓ grep_search no matches']);
  assert.equal(agentCall.tool.output, 'APPROVED, 0 findings');
  // Level 1: the built-in sub-agent call is also a read-only chat nested under its parent
  const vid = `${s.id}~call_agent_1`;
  assert.equal(agentCall.tool.subSessionId, vid);
  const v = (await state()).sessions.find((x) => x.id === vid);
  assert.deepEqual([v.virtual, v.role, v.parentId, v.title, v.status, v.model], [true, 'subagent', s.id, 'java-reviewer · Review the diff', 'done', 'review']);
  const vm = await messages(vid);
  assert.deepEqual(vm.map((m) => [m.kind, m.kind === 'tool' ? m.tool.name : m.text]), [['user', 'Review the diff'], ['assistant', 'Reviewing…'], ['tool', 'grep_search'], ['assistant', 'APPROVED, 0 findings']]);
  assert.equal(vm[2].tool.output, 'no matches');
  const write = await h.api('POST', `/api/sessions/${vid}/messages`, { text: 'hi' });
  assert.equal(write.status, 409);
  assert.match(write.body.error, /внутренний субагент/);
  assert.ok(!msgs.some((m) => m.kind === 'assistant' && m.text.includes('Reviewing')));
  assert.ok(!msgs.some((m) => m.kind === 'tool' && m.tool.id === 'sub_grep'));
});

test('ops: one harness per data dir, a clear message for a busy port; models in state', async () => {
  const busy = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-lock-'));
  try {
    // a live harness answers /api/health as the pid in server.json: the data dir is taken
    const other = spawn(process.execPath, ['-e', "require('http').createServer((q, r) => r.end(JSON.stringify({ ok: true, pid: process.pid }))).listen(0, '127.0.0.1', function () { console.log(this.address().port) })"]);
    try {
      const port = await new Promise((resolve) => other.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
      fs.writeFileSync(path.join(busy, 'server.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: other.pid }));
      await assert.rejects(startServer({ dataDir: busy, port: 0, configOverrides: { mcpServersFrom: null, history: { adopt: false } } }), /уже работает с/);
    } finally {
      other.kill();
    }
    // a live pid that is no harness (reused pid, crashed harness): the stale lock is taken over
    fs.writeFileSync(path.join(busy, 'server.json'), JSON.stringify({ url: 'http://127.0.0.1:1', pid: process.ppid }));
    const taken = await startServer({ dataDir: busy, port: 0, configOverrides: { mcpServersFrom: null, history: { adopt: false }, agents: { mock: { modelsDiscovery: null } } } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(busy, 'server.json'), 'utf8')).pid, process.pid);
    await taken.close();
    fs.writeFileSync(path.join(busy, 'server.json'), JSON.stringify({ url: 'http://127.0.0.1:1', pid: 999999 }));
    await assert.rejects(startServer({ dataDir: busy, port: h.srv.port, configOverrides: { mcpServersFrom: null } }), (e) => e.code === 'EADDRINUSE' && new RegExp(`${h.srv.port}[\\s\\S]*(netstat|lsof)`).test(e.message));
  } finally {
    rmrf(busy);
  }
  const mock = (await state()).agents.find((a) => a.id === 'mock');
  assert.ok(mock.models.every((m) => typeof m.id === 'string' && 'available' in m), 'merged catalogue entries');
  const models = [{ id: 'm-1' }, { id: 'm-2', label: 'Model 2', context: '128k' }];
  assert.deepEqual((await h.api('PUT', '/api/settings', { agents: { mock: { models: [' m-1 ', { id: 'm-2', label: 'Model 2', context: '128k' }] } } })).body.agents.mock.models, models);
  assert.deepEqual((await state()).agents.find((a) => a.id === 'mock').models.slice(0, 2), models.map((m) => ({ ...m, available: null })), 'config entries first, availability unknown without discovery');
  assert.equal((await h.api('PUT', '/api/settings', { agents: { mock: { models: [{ label: 'no id' }] } } })).status, 400);
});

test('settings: model catalogue objects, labels, presets, timeouts, flags and tracker/PR integration fields', async () => {
  const s = (await h.api('GET', '/api/settings')).body;
  const giga = s.agents.gigacode;
  assert.ok(giga.models.every((m) => typeof m.id === 'string'), 'catalogue entries are objects');
  assert.equal(typeof giga.approvalModeLabels.auto, 'string');
  assert.ok(giga.taskPromptPresets.length > 0);
  assert.deepEqual([giga.firstEventTimeoutMs, giga.inheritUserMcp, giga.enabled], [120000, false, true]);
  assert.deepEqual(Object.keys(s.integrations.tasks).sort(), ['closedStatuses', 'enabled', 'onStartTransition', 'space', 'statusMap', 'urlTemplate']);
  // default "auto": off here (no console MCP server named sourcecontrol)
  assert.deepEqual(s.integrations.pr, { enabled: 'auto', active: false, me: null, limits: { titleBytes: 100, bodyBytes: 512 } });
  assert.ok(!JSON.stringify(s).match(/secret|token/i));

  const bad = (body) => h.api('PUT', '/api/settings', body).then((r) => r.status);
  assert.equal(await bad({ agents: { mock: { model: 42 } } }), 400);
  assert.equal(await bad({ agents: { mock: { modelGrades: { fast: 7 } } } }), 400);
  assert.equal(await bad({ agents: { mock: { firstEventTimeoutMs: 10 } } }), 400);
  assert.equal(await bad({ agents: { mock: { enabled: 'yes' } } }), 400);
  assert.equal(await bad({ agents: { mock: { taskPromptPresets: ['no task vars'] } } }), 400);
  assert.equal(await bad({ integrations: { tasks: { statusMap: { qa: 'testing' } } } }), 400);
  assert.equal(await bad({ integrations: { pr: { enabled: 1 } } }), 400);

  const saved = (await h.api('PUT', '/api/settings', {
    agents: { mock: { model: 'not-in-the-catalogue', modelGrades: { fast: 'm-x' }, approvalModeLabels: { auto: 'Всё сам' }, taskPromptPresets: ['/full-task {taskUrl}{notes}'], firstEventTimeoutMs: 60000, inheritUserMcp: true } },
    integrations: { tasks: { space: 'ABC', urlTemplate: 'https://t.example/{key}', statusMap: { qa: 'review' }, closedStatuses: ['done', 'won_t_do'] }, pr: { enabled: true } },
  })).body;
  assert.deepEqual([saved.agents.mock.model, saved.agents.mock.modelGrades.fast, saved.agents.mock.approvalModeLabels.auto], ['not-in-the-catalogue', 'm-x', 'Всё сам']);
  assert.deepEqual([saved.agents.mock.firstEventTimeoutMs, saved.agents.mock.inheritUserMcp], [60000, true]);
  assert.deepEqual([saved.integrations.tasks.space, saved.integrations.tasks.statusMap.qa, saved.integrations.pr.enabled], ['ABC', 'review', true]);
  assert.equal((await state()).integrations.pr, true);
  const local = JSON.parse(fs.readFileSync(h.configFile.replace(/\.json$/, '.local.json'), 'utf8'));
  assert.deepEqual(local.integrations.tasks.closedStatuses, ['done', 'won_t_do']);
  assert.equal(local.agents.mock.firstEventTimeoutMs, 60000);
  await h.api('PUT', '/api/settings', { agents: { mock: { inheritUserMcp: false, model: null } }, integrations: { pr: { enabled: false } } });
});
