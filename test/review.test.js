// Regressions from the independent review: long prompts, re-queue on spawn errors, stale includeDirs, worktree removal
// and orphan folders, path guard, store flush and LRU, IDE open, task move, settings contract.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { startTestServer, tmpDir, rmrf, waitFor, makeRepo, gitIn } from './helpers.js';
import * as git from '../server/git.js';
import * as wfs from '../server/fs.js';
import { createStore } from '../server/store.js';

let h;
const root = tmpDir();
const argvFile = path.join(root, 'argv.ndjson');
before(async () => {
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  h = await startTestServer();
});
after(async () => {
  delete process.env.MOCK_AGENT_ARGV_FILE;
  await h.close();
  rmrf(root);
});

const session = async (id) => (await h.api('GET', '/api/state')).body.sessions.find((s) => s.id === id);
const messages = async (id) => (await h.api('GET', `/api/sessions/${id}/messages`)).body;
const runsOf = (sid) => fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.env.HARNESS_SESSION_ID === sid);
const argOf = (run, flag) => run.argv[run.argv.indexOf(flag) + 1];

test('long prompts go through a file (argv stays short); the CLI may read it (its folder is a workspace dir)', async () => {
  const cwd = path.join(root, 'длинный промпт');
  fs.mkdirSync(cwd);
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd, prompt: '#slow' })).body;
  await waitFor(async () => (await session(s.id)).status === 'running', { what: 'running' });
  // three worker reports of ~15k chars each arrive while the coordinator works: one turn joins them
  for (let i = 0; i < 3; i++) await h.api('POST', `/api/sessions/${s.id}/messages`, { text: `Отчёт ${i}: ${'отчёт "кавычки" '.repeat(1000)}` });
  await waitFor(async () => { const x = await session(s.id); return x.status === 'idle' && !x.queued && !x.pid && runsOf(s.id).length === 2; }, { timeout: 30000, what: 'second turn' });
  const ms = await messages(s.id);
  assert.ok(!ms.some((m) => m.kind === 'error'), ms.filter((m) => m.kind === 'error').map((m) => m.text).join('\n'));
  const run = runsOf(s.id)[1];
  const p = argOf(run, '-p');
  assert.ok(p.length < 1000, `short -p (${p.length})`);
  const file = p.match(/^Полный текст сообщения: (.+)$/m)[1];
  assert.equal(path.basename(file), 'prompt-2.md');
  assert.ok(run.argv.includes(path.dirname(file)), 'the prompt folder is an --include-directories entry');
  const text = fs.readFileSync(file, 'utf8');
  for (let i = 0; i < 3; i++) assert.ok(text.includes(`Отчёт ${i}:`));
});

test('a slash command stays first in a long prompt', async () => {
  const cwd = path.join(root, 'слэш');
  fs.mkdirSync(cwd);
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd, prompt: `/full-task https://tracker.example/PROJ-1 ${'текст '.repeat(6000)}` })).body;
  await waitFor(async () => runsOf(s.id).length === 1 && (await session(s.id)).status === 'idle', { what: 'turn' });
  const p = argOf(runsOf(s.id)[0], '-p');
  assert.match(p, /^\/full-task https:\/\/tracker\.example\/PROJ-1 /);
  assert.match(p, /\n\nПолный текст сообщения: .+prompt-1\.md\n/);
  assert.ok(p.length < 3000);
});

test('a turn whose process never starts keeps its messages queued (no loop; they go with the next message)', async () => {
  const cwd = path.join(root, 'пропавшая папка');
  fs.mkdirSync(cwd);
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd, prompt: 'первое' })).body;
  await waitFor(async () => (await session(s.id)).status === 'idle' && runsOf(s.id).length === 1, { what: 'first turn' });
  rmrf(cwd);
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'второе' });
  await waitFor(async () => (await session(s.id)).status === 'error', { what: 'spawn error' });
  await new Promise((r) => setTimeout(r, 300));
  const x = await session(s.id);
  assert.equal(x.queued, 1);
  let ms = await messages(s.id);
  const errors = ms.filter((m) => m.kind === 'error');
  assert.equal(errors.length, 1, 'no retry loop');
  assert.match(errors[0].text, /Сообщений в очереди: 1/);
  fs.mkdirSync(cwd);
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'третье' });
  await waitFor(async () => { const y = await session(s.id); return y.status === 'idle' && !y.queued && runsOf(s.id).length === 2; }, { what: 'requeued turn' });
  const p = argOf(runsOf(s.id)[1], '-p');
  assert.match(p, /второе\n\nтретье/);
  ms = await messages(s.id);
  assert.equal(ms.filter((m) => m.kind === 'user' && m.text === 'второе').length, 1, 'the re-queued message is not repeated in the transcript');
});

test('a stale includeDirs entry of the caller never breaks worker_start (no orphan) or a worktree removal', async () => {
  const repo = makeRepo(path.join(root, 'репо'));
  const extra = path.join(root, 'дочернее дерево');
  fs.mkdirSync(extra);
  const ws = (await h.api('POST', '/api/workspaces', { path: repo })).body;
  const coord = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, role: 'coordinator', includeDirs: [extra] })).body;
  rmrf(extra); // e.g. a child worktree removed in a terminal
  const task = (await h.api('POST', '/api/tasks', { title: 'Задача', workspaceId: ws.id })).body;
  const r = await h.api('POST', '/api/agent/worker_start', { task_id: task.id, worktree: 'new' }, { 'x-harness-session': coord.id });
  assert.equal(r.status, 200, r.body?.error);
  const worker = (await h.api('GET', '/api/state')).body.sessions.find((s) => s.taskId === task.id);
  assert.deepEqual((await session(coord.id)).includeDirs, [worker.cwd], 'the stale entry dropped, the child worktree added');
  await waitFor(async () => (await session(worker.id)).status !== 'running', { what: 'worker turn' });
  // stale again at removal time: the caller's includeDirs are still cleaned up
  const extra2 = path.join(root, 'ещё папка');
  fs.mkdirSync(extra2);
  await h.api('PATCH', `/api/sessions/${coord.id}`, { includeDirs: [worker.cwd, extra2] });
  rmrf(extra2);
  const del = await h.api('DELETE', `/api/workspaces/${ws.id}/worktrees`, { path: worker.cwd, force: true });
  assert.equal(del.status, 200, del.body?.error);
  assert.deepEqual((await session(coord.id)).includeDirs, []);
});

test('worktree removal: a worktree git refuses to remove keeps its folder; a leftover folder is listed as orphan and removable', async () => {
  const repo = makeRepo(path.join(root, 'репо2'));
  const ws = (await h.api('POST', '/api/workspaces', { path: repo })).body;
  const wt = await git.addWorktree(repo, { branch: 'feature/T-1' });
  gitIn(repo, 'worktree', 'lock', wt.path, '--reason', 'held by tool');
  await assert.rejects(git.removeWorktree(repo, wt.path), /git не удалил рабочее дерево/);
  assert.ok(fs.existsSync(path.join(wt.path, 'README.md')), 'the folder is kept');
  assert.ok((await git.worktrees(repo)).some((w) => w.branch === 'feature/T-1'), 'still registered');
  gitIn(repo, 'worktree', 'unlock', wt.path);

  // a removal that failed part-way: git no longer lists it, the folder (and the harness meta) stay
  const made = (await h.api('POST', `/api/workspaces/${ws.id}/worktrees`, { name: 'feature/T-2' })).body;
  await h.api('GET', `/api/workspaces/${ws.id}/worktrees`); // tags the meta with its repository
  fs.rmSync(path.join(made.path, '.git'));
  gitIn(repo, 'worktree', 'prune', '--expire', 'now');
  const list = (await h.api('GET', `/api/workspaces/${ws.id}/worktrees`)).body;
  const orphan = list.find((w) => w.orphan);
  assert.deepEqual([orphan.path, orphan.branch, orphan.meta.createdBy], [made.path, null, 'user']);
  assert.equal((await h.api('DELETE', `/api/workspaces/${ws.id}/worktrees`, { path: made.path })).status, 404, 'not a git worktree any more');
  const del = await h.api('DELETE', `/api/workspaces/${ws.id}/worktrees`, { path: made.path, orphan: true });
  assert.equal(del.status, 200, del.body?.error);
  assert.ok(!fs.existsSync(made.path));
  assert.ok(!(await h.api('GET', `/api/workspaces/${ws.id}/worktrees`)).body.some((w) => w.orphan));
  assert.equal((await h.api('DELETE', `/api/workspaces/${ws.id}/worktrees`, { path: wt.path, orphan: true })).status, 404, 'a live worktree is no orphan');
});

test('worktree meta PATCH is broadcast; checkout refuses while an agent works in a subfolder of the worktree', async () => {
  const repo = makeRepo(path.join(root, 'репо3'));
  await h.api('POST', '/api/workspaces', { path: repo });
  const frames = [];
  const sock = new WebSocket(`${h.srv.url.replace('http', 'ws')}/ws?token=${h.srv.token}`);
  sock.on('message', (raw) => frames.push(JSON.parse(raw)));
  await new Promise((r) => sock.once('open', r));
  try {
    assert.equal((await h.api('PATCH', '/api/worktrees/meta', { path: repo, label: 'основной' })).status, 200);
    await waitFor(() => frames.some((f) => f.t === 'worktree.meta' && f.meta.label === 'основной'), { what: 'worktree.meta frame' });
  } finally {
    sock.close();
  }

  const sub = path.join(repo, 'модуль');
  fs.mkdirSync(sub);
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: sub, prompt: '#slow' })).body;
  await waitFor(async () => (await session(s.id)).status === 'running', { what: 'running' });
  const co = await h.api('POST', '/api/git/checkout', { cwd: repo, branch: 'feature/x', create: true });
  assert.equal(co.status, 409, 'the agent in a subfolder counts');
  await h.api('POST', `/api/sessions/${s.id}/stop`);
  await waitFor(async () => !(await session(s.id)).pid, { what: 'stopped' });
});

test('path guard: a junction/symlink below the folder cannot be written through, even with missing parts after it', () => {
  const base = path.join(root, 'junction');
  const ws = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(ws, 'link'), 'junction');
  for (const rel of ['link/x.txt', 'link/newdir/y.txt', 'link/a/b/c.txt']) {
    assert.throws(() => wfs.writeFile(ws, rel, 'x'), /выходит за пределы/, rel);
  }
  assert.deepEqual(fs.readdirSync(outside), []);
  wfs.writeFile(ws, 'inside/new/z.txt', 'ok'); // missing parts inside the folder are fine
  assert.equal(fs.readFileSync(path.join(ws, 'inside', 'new', 'z.txt'), 'utf8'), 'ok');
});

test('store: a failed write keeps its key dirty and is retried (a file held by an antivirus loses nothing)', async () => {
  const dir = path.join(root, 'хранилище');
  const store = createStore(dir);
  try {
    store.messages('s1');
    const file = path.join(dir, 'transcripts', 's1.json');
    fs.mkdirSync(file, { recursive: true }); // the rename onto it fails
    store.putMessage('s1', { id: 'm1', text: 'хвост' });
    store.flush();
    fs.rmSync(file, { recursive: true });
    await waitFor(() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).length === 1; } catch { return false; } }, { what: 'retried write' });
  } finally {
    store.close();
  }
});

test('transcripts: at most 50 stay loaded (LRU); the turn counter lives on the session', async () => {
  const dir = path.join(root, 'lru');
  const store = createStore(dir);
  try {
    for (let i = 0; i < 60; i++) store.putMessage(`s${i}`, { id: `m${i}`, text: String(i) });
    store.flush();
    assert.ok(store.loadedTranscripts() <= 50, `${store.loadedTranscripts()} loaded`);
    assert.equal(store.messages('s0')[0].text, '0', 'an evicted transcript reloads from disk');
  } finally {
    store.close();
  }
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: 'раз' })).body;
  await waitFor(async () => (await session(s.id)).status === 'idle', { what: 'turn' });
  assert.equal((await session(s.id)).turnCount, 1);
});

test('IDE open: a missing command is a 400 with the reason (not ok:true); task move validates beforeId first; bad %-encoding is a 400', async () => {
  const repo = makeRepo(path.join(root, 'репо4'));
  await h.api('POST', '/api/workspaces', { path: repo });
  assert.equal((await h.api('PUT', '/api/settings', { ide: { command: 'нет-такой-ide-xyz', args: ['{path}'] } })).status, 200);
  const r = await h.api('POST', '/api/open', { cwd: repo, target: 'ide' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Не удалось запустить «нет-такой-ide-xyz»/);

  const t = (await h.api('POST', '/api/tasks', { title: 'Карточка' })).body;
  const bad = await h.api('POST', `/api/tasks/${t.id}/move`, { status: 'done', beforeId: 'нет' });
  assert.equal(bad.status, 400);
  const now = (await h.api('GET', '/api/state')).body.tasks.find((x) => x.id === t.id);
  assert.deepEqual([now.status, !!now.statusManual, now.log.length], [t.status, !!t.statusManual, t.log.length], 'nothing changed');
  assert.equal((await h.api('GET', '/api/sessions/%E0%A4%A/messages')).status, 400);
});

test('contract: null switches autoArchiveDays / acpIdleMin off (stored as 0); rework presets start with the effective default', async () => {
  const put = await h.api('PUT', '/api/settings', { sessions: { autoArchiveDays: null }, agents: { mock: { acpIdleMin: null } } });
  assert.equal(put.status, 200, put.body?.error);
  const st = (await h.api('GET', '/api/settings')).body;
  assert.deepEqual([st.sessions.autoArchiveDays, st.agents.mock.acpIdleMin], [0, 0]);
  assert.equal(st.orchestration.maxSubagentDepth, 1);
  const full = '/full-task {taskUrl} Задача готова, но нужны правки: {notes}';
  assert.deepEqual([st.agents.gigacode.reworkPromptTemplate, st.agents.gigacode.reworkPromptPresets[0]], [full, full]);
  assert.deepEqual(st.agents.mock.reworkPromptPresets, ['{key} {title}: нужны правки: {notes}'], 'no task command: the generic template');
});
