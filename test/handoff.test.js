// «Передать агенту»: one input — a tracker link/key starts that task at the projects root, free text opens a chat there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ROOT } from '../server/config.js';
import { startTestServer, tmpDir, rmrf, waitFor, makeRepo, gitIn } from './helpers.js';

const root = tmpDir();
const projects = path.join(root, 'проекты');
// the tracker's fixtures, and PROJ-99001 that it does not have (its real «not found» answer)
const fixtures = path.join(root, 'fixtures');
fs.cpSync(path.join(CODE_ROOT, 'test', 'fixtures'), fixtures, { recursive: true });
fs.copyFileSync(path.join(fixtures, 'onework.tool-error.json'), path.join(fixtures, 'onework.sbertrack_getIssue.PROJ-99001.json'));
const stub = (server) => ({ transport: 'stdio', command: process.execPath, args: [path.join(CODE_ROOT, 'scripts', 'mock-mcp.js'), '--fixtures', fixtures, '--server', server] });
let h;

before(async () => {
  fs.mkdirSync(projects);
  gitIn(makeRepo(path.join(projects, 'сервис')), 'branch', 'release/1.54.0');
  h = await startTestServer({
    workspaces: { root: projects, repos: [path.join(projects, 'сервис')] },
    git: { defaultBase: 'develop' },
    mcpServers: { onework: stub('onework') },
    integrations: { tasks: { enabled: true, space: 'PROJ', urlTemplate: 'https://tracker.example/swtr/units/all/unit/{key}' } },
    agents: { mock: { taskPromptTemplate: '/full-task {taskUrl}{notes}', freePromptTemplate: '/full-task {text}{notes}' } },
  });
});
after(async () => {
  await h.close();
  rmrf(root);
});

const firstUser = async (sid) => waitFor(async () => (await h.api('GET', `/api/sessions/${sid}/messages`)).body.find((m) => m.kind === 'user'), { what: 'first message' });
const settle = (sid) => waitFor(async () => { const s = (await h.api('GET', '/api/state')).body.sessions.find((x) => x.id === sid); return !s.pid && s.status !== 'running' && !s.turnClosing; }, { what: 'settled' });

test('a tracker link: the task is imported and its worker starts at the projects root with "/full-task <url>"; again = jumped', async () => {
  const link = 'https://tracker.example/swtr/units/all/unit/PROJ-14904';
  const r = await h.api('POST', '/api/handoff', { input: `${link} и проверь кеш` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { session, task } = r.body;
  assert.deepEqual([task.externalId, task.location, session.taskId, path.resolve(session.cwd)], ['PROJ-14904', 'root', task.id, path.resolve(projects)]);
  assert.equal((await firstUser(session.id)).text, `/full-task ${link} и проверь кеш`);
  const again = (await h.api('POST', '/api/handoff', { input: 'PROJ-14904' })).body;
  assert.deepEqual([again.session.id, again.session.jumped], [session.id, true]);
  await settle(session.id);
});

test('the task\'s main agent hands a repository to a developer: the task\'s worktree there, the reviewer in the same one, linked to the task', async () => {
  const { session, task } = (await h.api('POST', '/api/handoff', { input: 'PROJ-14904' })).body; // the worker of the first test
  const call = (args) => h.api('POST', '/api/agent/agent', args, { 'x-harness-session': session.id });
  const dev = await call({ subagent_type: 'backend-engineer', workspace: 'сервис', prompt: 'сделай правку #done ок' });
  assert.equal(dev.status, 200, JSON.stringify(dev.body));
  const state = async () => (await h.api('GET', '/api/state')).body;
  const devS = (await state()).sessions.find((s) => s.id === dev.body.sessionId);
  assert.equal(path.resolve(devS.cwd), path.resolve(projects, 'сервис-worktrees', 'PROJ-14904'), 'the task\'s worktree, named by its key');
  assert.match(devS.branch, /PROJ-14904/);
  const rev = (await call({ subagent_type: 'java-reviewer', workspace: 'сервис', prompt: 'проверь #done ок' })).body;
  assert.equal(path.resolve((await state()).sessions.find((s) => s.id === rev.sessionId).cwd), path.resolve(devS.cwd), 'the reviewer reads the same worktree');
  const linked = (await state()).tasks.find((t) => t.id === task.id).worktrees;
  assert.deepEqual(linked.map((w) => path.resolve(w.path)), [path.resolve(devS.cwd)], 'the task knows its worktree once');
  for (const id of [dev.body.sessionId, rev.sessionId, session.id]) await settle(id);
});

test('the tracker does not give the task: still a task (by its key) and its worker — never a chat titled with the link', async () => {
  const link = 'https://tracker.example/swtr/units/all/unit/PROJ-99001'; // not in the tracker fixture: the import fails
  const r = await h.api('POST', '/api/handoff', { input: link });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { session, task, trackerError } = r.body;
  assert.ok(trackerError, 'the person hears that the tracker failed');
  assert.deepEqual([task.externalId, task.externalUrl, session.taskId, session.role], ['PROJ-99001', link, task.id, 'worker']);
  assert.match(session.title, /PROJ-99001/);
  assert.doesNotMatch(session.title, /https?:/);
  await settle(session.id);
  // again (the board's «Передать агенту» sends the link): the same task, its chat
  const again = (await h.api('POST', '/api/handoff', { input: link })).body;
  assert.deepEqual([again.task.id, again.session.id], [task.id, session.id]);
});

test('free text: a chat at the projects root named after the text, its prompt from freePromptTemplate', async () => {
  const r = await h.api('POST', '/api/handoff', { input: 'сделай X', notes: 'быстро' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { session, task } = r.body;
  assert.equal(task, null);
  assert.deepEqual([session.title, session.role, session.atRoot, path.resolve(session.cwd)], ['сделай X', 'solo', true, path.resolve(projects)]);
  assert.equal((await firstUser(session.id)).text, '/full-task сделай X быстро');
  await settle(session.id);
});

test('no projects folder: nothing open → 400; one project → the agent starts in it', async () => {
  const bare = await startTestServer();
  try {
    const r = await bare.api('POST', '/api/handoff', { input: 'сделай X' });
    assert.deepEqual([r.status, r.body.error], [400, 'Откройте проект или укажите папку с проектами']);
  } finally {
    await bare.close();
  }
  const one = await startTestServer({ workspaces: { repos: [path.join(projects, 'сервис')] } });
  try {
    assert.equal((await one.api('POST', '/api/handoff', { input: 'X', dryRun: true })).body.location, 'repo');
    const r = await one.api('POST', '/api/handoff', { input: 'сделай Y' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([!!r.body.session.atRoot, path.resolve(r.body.session.cwd)], [false, path.resolve(projects, 'сервис')]);
    await waitFor(async () => { const s = (await one.api('GET', '/api/state')).body.sessions.find((x) => x.id === r.body.session.id); return !s.pid && s.status !== 'running' && !s.turnClosing; }, { what: 'settled' });
  } finally {
    await one.close();
  }
});

test('integrations check: the tracker\'s server answers with the tools the harness calls; a code host that is not there says so; servers are editable', async () => {
  const r = (await h.api('GET', '/api/integrations/check')).body;
  assert.deepEqual([r.tasks.server, r.tasks.found, r.tasks.ok, r.tasks.missing], ['onework', true, true, []]);
  assert.deepEqual([r.pr.server, r.pr.found, r.pr.ok], ['sourcecontrol', false, false]);
  assert.ok(r.servers.includes('onework'));
  assert.equal((await h.api('PUT', '/api/settings', { integrations: { pr: { server: 'onework' } } })).status, 200);
  const again = (await h.api('GET', '/api/integrations/check')).body.pr;
  assert.deepEqual([again.server, again.found, again.ok, again.missing], ['onework', true, false, ['git_create_pull_request']], 'answers, but it is not a code host');
  assert.equal((await h.api('PUT', '/api/settings', { integrations: { pr: { server: ' ' } } })).status, 400);
  await h.api('PUT', '/api/settings', { integrations: { pr: { server: 'sourcecontrol' } } });
});

test('dryRun: the exact first message (slash first, no preamble), targets and the warning — nothing imported or created', async () => {
  const before = (await h.api('GET', '/api/state')).body;
  const link = 'https://tracker.example/swtr/units/all/unit/PROJ-15430';
  const r = await h.api('POST', '/api/handoff', { input: `${link} поправь кеш в релиз 54`, notes: 'срочно', dryRun: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.taskKey, r.body.targets, r.body.releaseWarning, r.body.location, r.body.agent], ['PROJ-15430', ['develop', 'release/1.54.0'], null, 'root', 'mock']);
  const [first, second] = r.body.prompt.split('\n');
  assert.equal(first, `/full-task ${link} поправь кеш в релиз 54 срочно`);
  assert.match(second, /^Целевые ветки: develop и release\/1\.54\.0 \(из «релиз 54»\)\. .*feature\/PROJ-15430-rel154 → PR в release\/1\.54\.0\.$/);
  const after = (await h.api('GET', '/api/state')).body;
  assert.deepEqual([after.sessions.length, after.tasks.length], [before.sessions.length, before.tasks.length]);
  const real = (await h.api('POST', '/api/handoff', { input: `${link} поправь кеш в релиз 54`, notes: 'срочно' })).body;
  assert.equal((await firstUser(real.session.id)).text, r.body.prompt, 'preview == the sent text');
  await settle(real.session.id);
  const free = (await h.api('POST', '/api/handoff', { input: 'сделай Y', dryRun: true })).body;
  assert.deepEqual([free.prompt, free.taskKey, free.targets], ['/full-task сделай Y', null, null]);
});
