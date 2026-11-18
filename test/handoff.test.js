// «Передать агенту»: one input — a tracker link/key starts that task at the projects root, free text opens a chat there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ROOT } from '../server/config.js';
import { startTestServer, tmpDir, rmrf, waitFor, makeRepo, gitIn } from './helpers.js';

const root = tmpDir();
const projects = path.join(root, 'проекты');
const stub = (server) => ({ transport: 'stdio', command: process.execPath, args: [path.join(CODE_ROOT, 'scripts', 'mock-mcp.js'), '--fixtures', path.join(CODE_ROOT, 'test', 'fixtures'), '--server', server] });
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
