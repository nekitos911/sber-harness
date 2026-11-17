// Orca-style orchestration: worker placements (current / new-child / new-top-level) with named worktrees, the parent
// reading child worktrees, worker_inspect / worker_stop / worker_retry (+ circuit breaker), message groups,
// worktree createdBy / detached / lastError.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, makeRepo, tmpDir, rmrf, gitIn, waitFor } from './helpers.js';

const root = tmpDir();
const core = path.join(root, 'core');
const app = path.join(root, 'app-a');
let h;
let wsCore;
let coord;

before(async () => {
  makeRepo(core);
  makeRepo(app);
  h = await startTestServer();
  wsCore = (await h.api('POST', '/api/workspaces', { path: core })).body;
  await h.api('POST', '/api/workspaces', { path: app });
  coord = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: core, role: 'coordinator' })).body;
});
after(async () => {
  await h.close();
  rmrf(root);
});

const tool = (name, args, sid = coord.id) => h.api('POST', `/api/agent/${name}`, args, { 'x-harness-session': sid });
const state = async () => (await h.api('GET', '/api/state')).body;
const session = async (id) => (await state()).sessions.find((s) => s.id === id);
// settled = the turn and its process are over (worker_done flips the status to done mid-turn)
const idle = (id) => waitFor(async () => { const s = await session(id); return !s.pid && !s.turnClosing && s.status !== 'running' && s; }, { what: `${id} settled` });
const wtList = async (wsId) => (await h.api('GET', `/api/workspaces/${wsId}/worktrees`)).body;

test('placements: new-child = a named worktree of the caller repo nested under it; new-top-level needs a workspace', async () => {
  const w = (await tool('worker_start', { spec: 'ядро #done готово', worktree: 'new-child', name: 'ft-core-free' })).body;
  assert.equal(w.cwd, path.join(root, 'core-worktrees', 'ft-core-free'));
  assert.equal(w.persistent, true);
  const item = (await wtList(wsCore.id)).find((x) => x.path === w.cwd);
  assert.deepEqual([item.createdBy, item.meta.label, item.meta.parentWorktree, item.meta.createdBySession], ['agent', 'ft-core-free', core, coord.id]);
  assert.ok((await session(coord.id)).includeDirs.includes(w.cwd), 'the parent reads the child worktree from its next turn');

  assert.equal((await tool('worker_start', { spec: 'x', worktree: 'new-top-level' })).status, 400);
  const top = (await tool('worker_start', { spec: 'сервис #done ок', worktree: 'new-top-level', workspace: 'app-a', name: 'ft-app-a' })).body;
  assert.equal(top.cwd, path.join(root, 'app-a-worktrees', 'ft-app-a'));
  assert.equal((await tool('worker_start', { spec: 'x', worktree: 'new' })).status, 200, '`new` is new-child');
  await idle(w.id);
  await idle(top.id);
});

test('worker_inspect: diff stat, last answer, report; worker_list shows other worktrees; groups reach the right sessions', async () => {
  const w = (await tool('worker_start', { spec: 'инспекция #done сделал', worktree: 'new-child', name: 'ft-inspect' })).body;
  await idle(w.id);
  fs.writeFileSync(path.join(w.cwd, 'новый.txt'), 'x\n');
  const info = (await tool('worker_inspect', { session_id: w.id })).body;
  assert.equal(info.dirty, 1);
  assert.match(info.diffStat, /untracked: 1/);
  assert.match(info.lastAssistant, /Done\./);
  assert.deepEqual([info.report.status, info.report.summary], ['done', 'сделал']);
  const list = (await tool('worker_list', {})).body;
  assert.ok(list.some((x) => x.id === w.id && x.persistent && x.worktreePath === w.cwd));

  const other = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root })).body;
  assert.equal((await tool('worker_inspect', { session_id: w.id }, other.id)).status, 403, 'only own workers');
  const idleKids = (await tool('send_message', { to: '@idle', body: 'статус?' })).body.delivered;
  assert.ok(idleKids.includes(w.id));
  const inWt = (await tool('send_message', { to: `@worktree:${w.cwd}`, body: 'привет' })).body.delivered;
  assert.deepEqual(inWt, [w.id]);
  assert.equal((await tool('send_message', { to: '@nobody', body: 'x' })).status, 400);
  await idle(w.id);
});

test('worker_stop stops a running worker; worker_retry restarts it in the same placement; 3 failed starts break the circuit', async () => {
  const w = (await tool('worker_start', { spec: '#silent', worktree: 'current' })).body;
  await waitFor(async () => (await session(w.id)).status === 'running', { what: 'running' });
  assert.deepEqual((await tool('worker_stop', { session_id: w.id })).body, { stopped: true });
  await waitFor(async () => (await session(w.id)).pid === null, { what: 'stopped' });
  assert.equal((await tool('worker_stop', { session_id: w.id })).body.status, 'stop_unknown');

  const r1 = (await tool('worker_retry', { session_id: w.id })).body;
  assert.ok(r1.id && r1.id !== w.id);
  assert.equal((await session(r1.id)).retryOf, w.id);
  await waitFor(async () => (await session(r1.id)).status === 'running', { what: 'retry running' });
  await tool('worker_stop', { session_id: r1.id });
  await waitFor(async () => (await session(r1.id)).pid === null, { what: 'retry stopped' });
  const r2 = (await tool('worker_retry', { session_id: r1.id })).body;
  await waitFor(async () => (await session(r2.id)).status === 'running', { what: 'retry 2 running' });
  await tool('worker_stop', { session_id: r2.id });
  await waitFor(async () => (await session(r2.id)).pid === null, { what: 'retry 2 stopped' });
  const broken = await tool('worker_retry', { session_id: r2.id });
  assert.equal(broken.status, 409);
  assert.match(broken.body.error, /3 неудачных запуска — сообщи пользователю/);
  assert.ok((await state()).notifications.some((n) => /3 неудачных запуска/.test(n.text)));
});

test('worktree list: createdBy external for a worktree made outside the harness, detached flag; a failed create is kept as lastError', async () => {
  const ext = path.join(root, 'core-worktrees', 'cli-made');
  gitIn(core, 'worktree', 'add', '-q', '--detach', ext);
  const item = (await wtList(wsCore.id)).find((x) => x.path === ext);
  assert.deepEqual([item.createdBy, item.detached], ['external', true]);

  const bad = await h.api('POST', `/api/workspaces/${wsCore.id}/worktrees`, { name: 'feature/x', base: 'нет-такой-ветки' });
  assert.ok(bad.status >= 400);
  const mainItem = (await wtList(wsCore.id)).find((x) => x.main);
  assert.match(mainItem.meta.lastError.text, /^Не удалось создать рабочее дерево/);
  assert.equal((await h.api('POST', `/api/workspaces/${wsCore.id}/worktrees`, { name: 'feature/ok' })).status, 200);
  assert.equal((await wtList(wsCore.id)).find((x) => x.main).meta.lastError, undefined, 'cleared on the next success');
});
