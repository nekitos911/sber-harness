// «Доработка»: POST /api/tasks/:id/rework continues the task's worker (same CLI session) or starts one in the task's
// existing worktree/branch; the card goes back to in_progress.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, makeRepo, tmpDir, rmrf, waitFor } from './helpers.js';

const root = tmpDir();
const repo = path.join(root, 'сервис');
const argvFile = path.join(root, 'argv.ndjson');
let h;
let ws;

before(async () => {
  makeRepo(repo);
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  h = await startTestServer();
  ws = (await h.api('POST', '/api/workspaces', { path: repo })).body;
});
after(async () => {
  delete process.env.MOCK_AGENT_ARGV_FILE;
  await h.close();
  rmrf(root);
});

const state = async () => (await h.api('GET', '/api/state')).body;
const session = async (id) => (await state()).sessions.find((s) => s.id === id);
const runs = (sid) => fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.env.HARNESS_SESSION_ID === sid);
const promptOf = (run) => run.argv[run.argv.indexOf('-p') + 1];
const idle = (id) => waitFor(async () => (await session(id))?.status === 'idle', { what: `${id} idle` });

test('rework into the idle worker: same session, --resume, the rendered prompt (special characters kept as typed)', async () => {
  const task = (await h.api('POST', '/api/tasks', { title: 'Лимиты', workspaceId: ws.id })).body;
  const w = (await h.api('POST', `/api/tasks/${task.id}/start`, { agent: 'mock' })).body;
  await idle(w.id);
  await h.api('POST', `/api/tasks/${task.id}/move`, { status: 'review' });
  const notes = 'Поправь {key} и $& «кавычки» \\ C:\\path';
  const r = await h.api('POST', `/api/tasks/${task.id}/rework`, { notes });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.id, w.id, 'the same worker session');
  await waitFor(() => runs(w.id).length === 2, { what: 'rework turn' });
  const [, second] = runs(w.id);
  assert.ok(second.argv.includes('--resume'), 'continues the CLI session');
  assert.equal(promptOf(second), `${task.id} Лимиты: нужны правки: ${notes}`);
  const t = (await state()).tasks.find((x) => x.id === task.id);
  assert.equal(t.status, 'in_progress');
  assert.ok(t.log.some((l) => l.text === `Доработка: ${notes}`), JSON.stringify(t.log.map((l) => l.text)));
  await idle(w.id);

  // the configured template (the user's /full-task follow-up form)
  await h.api('PUT', '/api/settings', { agents: { mock: { reworkPromptTemplate: '/full-task {taskUrl} Задача готова, но нужны правки: {notes}' } } });
  await h.api('POST', `/api/tasks/${task.id}/rework`, { notes: 'ещё тест' });
  await waitFor(() => runs(w.id).length === 3, { what: 'second rework turn' });
  assert.equal(promptOf(runs(w.id)[2]), `/full-task ${task.id} Задача готова, но нужны правки: ещё тест`);
  assert.equal((await h.api('PUT', '/api/settings', { agents: { mock: { reworkPromptTemplate: 'без заметок' } } })).status, 400);
  await h.api('PUT', '/api/settings', { agents: { mock: { reworkPromptTemplate: null } } });
  await idle(w.id);
});

test('rework without a worker: a new worker in the task worktree on the same branch, the rework prompt first', async () => {
  const task = (await h.api('POST', '/api/tasks', { title: 'Отчёт', workspaceId: ws.id })).body;
  const w = (await h.api('POST', `/api/tasks/${task.id}/start`, { agent: 'mock' })).body;
  await idle(w.id);
  const first = await session(w.id);
  await h.api('DELETE', `/api/sessions/${w.id}`);
  const r = await h.api('POST', `/api/tasks/${task.id}/rework`, { notes: 'добавь итог' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual(r.body.id, w.id);
  assert.deepEqual([r.body.cwd, r.body.branch], [first.cwd, first.branch], 'the existing worktree and branch');
  await waitFor(() => runs(r.body.id).length === 1, { what: 'new worker turn' });
  assert.ok(promptOf(runs(r.body.id)[0]).includes(`${task.id} Отчёт: нужны правки: добавь итог`));
  await idle(r.body.id);
});

test('rework needs notes and a task that was taken into work', async () => {
  const task = (await h.api('POST', '/api/tasks', { title: 'Новая', workspaceId: ws.id })).body;
  assert.equal((await h.api('POST', `/api/tasks/${task.id}/rework`, { notes: '  ' })).status, 400);
  assert.equal((await h.api('POST', `/api/tasks/${task.id}/rework`, { notes: 'x' })).status, 409);
});
