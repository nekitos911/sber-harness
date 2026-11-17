// «Взять в работу» without a sure repository starts in the projects folder: the agent (/full-task) picks the repos and
// creates the worktrees itself; the harness links those worktrees to the task by the key in their branch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, makeRepo, tmpDir, rmrf, gitIn, waitFor } from './helpers.js';

const root = tmpDir();
const payments = path.join(root, 'payments-service');
const ledger = path.join(root, 'ledger');
const argvFile = path.join(root, 'argv.ndjson');
let h;
let wp;
let wl;

before(async () => {
  makeRepo(payments);
  makeRepo(ledger);
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  h = await startTestServer();
  wp = (await h.api('POST', '/api/workspaces', { path: payments })).body;
  wl = (await h.api('POST', '/api/workspaces', { path: ledger })).body;
});
after(async () => {
  delete process.env.MOCK_AGENT_ARGV_FILE;
  await h.close();
  rmrf(root);
});

const state = async () => (await h.api('GET', '/api/state')).body;
const task = async (id) => (await state()).tasks.find((t) => t.id === id);
const stopAll = async () => {
  for (const s of (await state()).sessions) if (s.pid) await h.api('POST', `/api/sessions/${s.id}/stop`);
  await waitFor(async () => (await state()).sessions.every((x) => !x.pid), { what: 'stopped' });
};

test('the repository named in the task (high confidence) gets the worktree', async () => {
  const t = (await h.api('POST', '/api/tasks', { title: 'Отчёт', description: 'Поправить выгрузку в ledger за ноябрь' })).body;
  assert.deepEqual([t.suggestedWorkspace.id, t.suggestedWorkspace.confidence], [wl.id, 'high']);
  const s = (await h.api('POST', `/api/tasks/${t.id}/start`, { agent: 'mock' })).body;
  assert.ok(s.cwd.includes('ledger-worktrees'), s.cwd);
  assert.deepEqual([(await task(t.id)).workspaceId, (await task(t.id)).branch], [wl.id, `feature/${t.id}`]);
  await stopAll();
});

test('no sure repository: the projects folder, no worktree; worktrees the agent creates later are linked by the key', async () => {
  const t = (await h.api('POST', '/api/tasks', { title: 'Общая доработка расчёта' })).body;
  assert.equal(t.suggestedWorkspace, null);
  const s = (await h.api('POST', `/api/tasks/${t.id}/start`, { agent: 'mock' })).body;
  assert.deepEqual([s.cwd, s.atRoot, s.role], [root, true, 'worker']);
  const started = await task(t.id);
  assert.deepEqual([started.status, started.branch, started.workspaceId, started.location], ['in_progress', null, null, 'root']);
  const run = await waitFor(() => {
    try {
      return fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.env.HARNESS_SESSION_ID === s.id);
    } catch {
      return null;
    }
  }, { what: 'root turn' });
  const prompt = run.argv[run.argv.indexOf('-p') + 1];
  assert.match(prompt, new RegExp(`Ты в папке со всеми проектами \\(${root.replace(/[\\.()]/g, '\\$&')}\\)`));
  assert.match(prompt, new RegExp(`<repo>-worktrees.${t.id}, ветка feature/${t.id} от develop`));
  assert.ok(!prompt.includes('Stay on your branch'), 'the agent creates branches itself here');
  await stopAll();

  // the agent (outside the harness) makes its worktree by its own rules
  const wtPath = path.join(root, 'payments-service-worktrees', t.id);
  gitIn(payments, 'worktree', 'add', '-q', '-b', `feature/${t.id}`, wtPath);
  gitIn(payments, 'worktree', 'add', '-q', '-b', `feature/${t.id}0-other`, path.join(root, 'payments-service-worktrees', 'other'));
  await h.api('GET', `/api/workspaces/${wp.id}/worktrees`); // a list refresh links it
  const linked = await task(t.id);
  assert.deepEqual(linked.worktrees, [{ workspaceId: wp.id, path: wtPath, branch: `feature/${t.id}` }], 'whole-word key match only');
  assert.deepEqual([linked.branch, linked.workspaceId], [`feature/${t.id}`, wp.id]);
  assert.ok(linked.log.some((l) => l.type === 'worktree' && l.text === `Агент создал рабочее дерево: payments-service · feature/${t.id}`));

  await h.api('GET', `/api/workspaces/${wp.id}/worktrees`);
  assert.equal((await task(t.id)).worktrees.length, 1, 'linked once');
});

test('location root is honoured even with a sure repository; an explicit workspaceId wins over everything', async () => {
  const t = (await h.api('POST', '/api/tasks', { title: 'ledger: сверка' })).body;
  const s = (await h.api('POST', `/api/tasks/${t.id}/start`, { agent: 'mock', location: 'root' })).body;
  assert.equal(s.cwd, root);
  await stopAll();
  const u = (await h.api('POST', '/api/tasks', { title: 'ledger: ещё' })).body;
  const w = (await h.api('POST', `/api/tasks/${u.id}/start`, { agent: 'mock', workspaceId: wp.id })).body;
  assert.ok(w.cwd.includes('payments-service-worktrees'), w.cwd);
  assert.equal((await h.api('POST', `/api/tasks/${u.id}/start`, { location: 'elsewhere' })).status, 400);
  await stopAll();
});
