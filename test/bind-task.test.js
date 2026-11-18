// «Поправь X в сервисе» first, the tracker task later: the chat's own worktrees are linked to it, then «Привязать
// задачу» gives the task the worktree, renames the branch (not pushed yet) and the commit title carries the key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, tmpDir, rmrf, waitFor, makeRepo, gitIn } from './helpers.js';

const root = tmpDir();
const projects = path.join(root, 'проекты');
let h;
let svc;
before(async () => {
  fs.mkdirSync(projects);
  svc = makeRepo(path.join(projects, 'svc'));
  h = await startTestServer({ workspaces: { root: projects, repos: [] }, agents: { mock: { freePromptTemplate: '{text}{notes}' } } });
});
after(async () => {
  await h.close();
  rmrf(root);
});

const state = async () => (await h.api('GET', '/api/state')).body;

test('a projects-folder chat without a task: the worktree its agent made is its own; a task bound later gets it, the branch and the key', async () => {
  const chat = (await h.api('POST', '/api/handoff', { input: 'поправь кеш в svc' })).body.session;
  assert.equal(chat.atRoot, true);
  const wt = path.join(projects, 'svc-worktrees', 'fix-cache');
  gitIn(svc, 'worktree', 'add', '-q', '-b', 'fix-cache', wt); // what the agent did by itself
  const ws = (await state()).workspaces.find((w) => w.name === 'svc');
  await h.api('GET', `/api/workspaces/${ws.id}/worktrees`); // a list refresh links new worktrees
  const listed = (await h.api('GET', `/api/workspaces/${ws.id}/worktrees`)).body.find((w) => path.resolve(w.path) === path.resolve(wt));
  assert.equal(listed.meta?.createdBySession, chat.id, 'linked to the chat that made it');

  const bound = await h.api('POST', `/api/sessions/${chat.id}/task`, { ref: 'https://tracker.example/unit/PROJ-77' });
  assert.equal(bound.status, 200, JSON.stringify(bound.body));
  const { task, renamed } = bound.body;
  assert.equal(task.externalId, 'PROJ-77');
  assert.deepEqual(renamed, ['fix-cache → feature/PROJ-77']);
  assert.equal(path.resolve(task.worktrees[0].path), path.resolve(wt));
  assert.equal((await state()).sessions.find((s) => s.id === chat.id).taskId, task.id);
  const sug = (await h.api('GET', `/api/git/suggest?cwd=${encodeURIComponent(wt)}`)).body;
  assert.equal(sug.key, 'PROJ-77');
  assert.match(sug.commit.title, /^PROJ-77 /, 'the commit starts with the task key');
  await waitFor(async () => { const s = (await state()).sessions.find((x) => x.id === chat.id); return !s.pid && s.status !== 'running'; }, { what: 'settled' });
});

test('binding needs a key; a pushed branch keeps its name', async () => {
  const chat = (await h.api('POST', '/api/handoff', { input: 'ещё одна правка' })).body.session;
  assert.equal((await h.api('POST', `/api/sessions/${chat.id}/task`, { ref: 'без ключа' })).status, 400);
  await waitFor(async () => { const s = (await state()).sessions.find((x) => x.id === chat.id); return !s.pid && s.status !== 'running'; }, { what: 'settled' });
});

test('a task naming an API path: the harness finds it in the code and tells the projects-folder agent where to start', async () => {
  const { needlesOf, codeHints } = await import('../server/hints.js');
  assert.deepEqual(needlesOf('Ручка post /api/task/api/v1/templates/employee и GET /orders/{id}'), ['templates/employee', 'orders']);
  const repo = makeRepo(path.join(projects, 'task-service'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'TemplateController.java'), 'class C {\n  @PostMapping("/api/v1/templates/employee")\n  void x() {}\n}\n');
  gitIn(repo, 'add', '.');
  gitIn(repo, 'commit', '-q', '-m', 'controller');
  const hints = await codeHints('Ручка для получения шаблонов post /api/task/api/v1/templates/employee', [{ name: 'svc', path: svc }, { name: 'task-service', path: repo }]);
  assert.deepEqual(hints, [{ repo: 'task-service', needle: 'templates/employee', hits: ['src/TemplateController.java:2'] }]);

  await h.api('POST', '/api/workspaces', { path: repo });
  const chat = (await h.api('POST', '/api/handoff', { input: 'добавь поле valueDisplayOnTile в ручку post /api/task/api/v1/templates/employee' })).body.session;
  const s = (await state()).sessions.find((x) => x.id === chat.id);
  assert.deepEqual(s.repoHints?.map((x) => x.repo), ['task-service']);
  await waitFor(async () => { const x = (await state()).sessions.find((y) => y.id === chat.id); return !x.pid && x.status !== 'running'; }, { what: 'settled' });
});
