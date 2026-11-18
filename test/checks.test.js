// «Проверка перед готово»: the project's own command, run by the harness in the worker's worktree after worker_done.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startTestServer, tmpDir, rmrf, waitFor, makeRepo } from './helpers.js';
import { runCheck, suggestCheck } from '../server/checks.js';

const root = tmpDir();
let h;
let ws;
before(async () => {
  h = await startTestServer();
  ws = (await h.api('POST', '/api/workspaces', { path: makeRepo(path.join(root, 'сервис')) })).body;
});
after(async () => {
  await h.close();
  rmrf(root);
});

const state = async () => (await h.api('GET', '/api/state')).body;
const taskOf = async (id) => (await state()).tasks.find((t) => t.id === id);
const messages = async (id) => (await h.api('GET', `/api/sessions/${id}/messages`)).body;
const setCheck = (command, extra = {}) => h.api('PUT', '/api/settings', { checks: { byWorkspace: { [ws.id]: command }, ...extra } });
const start = async (title) => {
  const t = (await h.api('POST', '/api/tasks', { title, workspaceId: ws.id })).body;
  await h.api('POST', `/api/tasks/${t.id}/start`, { agent: 'mock' });
  return t;
};

test('runCheck: exit code, output tail, a timeout stops it; suggestions come from the repo files', async () => {
  const ok = await runCheck({ cwd: root, command: 'node -e "console.log(\'всё хорошо\')"' });
  assert.deepEqual([ok.ok, ok.code, ok.output.trim()], [true, 0, 'всё хорошо']);
  const bad = await runCheck({ cwd: root, command: 'node -e "console.error(\'упал тест\'); process.exit(3)"' });
  assert.deepEqual([bad.ok, bad.code], [false, 3]);
  assert.match(bad.output, /упал тест/);
  const slow = await runCheck({ cwd: root, command: 'node -e "setTimeout(() => {}, 60000)"', timeoutMs: 500 });
  assert.deepEqual([slow.ok, slow.timedOut], [false, true]);
  assert.equal(suggestCheck(root), null);
});

test('a passing check: the task goes on as done, the log and the chat say so', async () => {
  await setCheck('node -e "0"', { maxRounds: 2 });
  const t = await start('Проверка проходит #done сделано');
  const done = await waitFor(async () => { const x = await taskOf(t.id); return x.checks?.state === 'passed' && x; }, { timeout: 30000, what: 'checks passed' });
  assert.equal(done.agentState, 'done');
  assert.ok(done.log.some((e) => e.type === 'checks' && e.data.ok === true && e.text === 'Проверка, раунд 1: пройдена'));
  assert.ok((await messages(done.assigneeSessionId)).some((m) => m.kind === 'system' && m.text.startsWith('Проверка пройдена')));
  assert.ok((await state()).notifications.some((n) => n.taskId === t.id && n.kind === 'done'));
});

test('a failing check goes back to the worker with its output; after the last round — a notification, the task «failed»', async () => {
  await setCheck('node -e "console.error(\'2 tests failed\'); process.exit(1)"', { maxRounds: 2 });
  const t = await start('Проверка падает #done сделано');
  const back = await waitFor(async () => {
    const x = await taskOf(t.id);
    return x?.assigneeSessionId && (await messages(x.assigneeSessionId)).find((m) => m.kind === 'user' && /Проверка проекта не прошла \(раунд 1 из 2\)/.test(m.text));
  }, { timeout: 30000, what: 'failure delivered' });
  assert.match(back.text, /2 tests failed/);
  assert.match(back.text, /снова вызови worker_done/);

  await setCheck('node -e "process.exit(1)"', { maxRounds: 1 });
  const t2 = await start('Проверка падает один раз #done сделано');
  const failed = await waitFor(async () => { const x = await taskOf(t2.id); return x.checks?.state === 'failed' && x.agentState === 'failed' && x; }, { timeout: 30000, what: 'checks failed' });
  assert.ok((await state()).notifications.some((n) => n.taskId === t2.id && n.kind === 'failed' && /проверка проекта не прошла за 1 раунд/.test(n.text)));
  assert.ok(failed.log.some((e) => e.type === 'checks' && e.data.ok === false));
});

test('settings: the command per project, rounds and time; bad values are refused', async () => {
  const s = (await setCheck('npm test', { maxRounds: 3, timeoutMin: 20 })).body;
  assert.deepEqual([s.checks.byWorkspace[ws.id], s.checks.maxRounds, s.checks.timeoutMin], ['npm test', 3, 20]);
  assert.equal((await setCheck(null)).body.checks.byWorkspace[ws.id], undefined, 'null removes it');
  assert.equal((await h.api('PUT', '/api/settings', { checks: { maxRounds: 9 } })).status, 400);
  assert.equal((await h.api('PUT', '/api/settings', { checks: { byWorkspace: { нет: 'x' } } })).status, 400);
  const run = (await h.api('POST', '/api/checks/run', { workspaceId: ws.id, command: 'node -e "process.exit(2)"' })).body;
  assert.deepEqual([run.ok, run.code], [false, 2]);
});
