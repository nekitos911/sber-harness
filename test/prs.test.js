import os from 'node:os';
// «Пулл-реквесты»: every open PR of mine across the registered repositories (sourcecontrol through the fixture stub),
// linked to tasks and agents; the PR integration turns itself on when the console MCP server exists (enabled "auto").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ROOT } from '../server/config.js';
import { startTestServer, tmpDir, rmrf, makeRepo, gitIn } from './helpers.js';

const root = tmpDir();
const fixtures = path.join(root, 'fixtures');
let h;
let wsDemo;
let wsLedger;
let task;
const repos = {};

const pull = (index, repo, head, author, title = `PR ${index}`) => ({
  index, title, state: 'open', pr_creator: author, head: { name: head }, base: { name: 'develop' }, mergeable: true,
  reviewers: [{ username: 'reviewer', status: 'PENDING' }], html_url: `https://code.example/sc/PROJ/${repo}/pulls/${index}`,
  created_at: '2026-11-17T10:00:00Z', updated_at: `2026-11-17T1${index % 10}:00:00Z`,
});
const writePulls = (pulls) => fs.writeFileSync(path.join(fixtures, 'sourcecontrol.git_list_pull_requests.json'), JSON.stringify({ pulls }));

before(async () => {
  fs.mkdirSync(fixtures);
  for (const f of fs.readdirSync(path.join(CODE_ROOT, 'test', 'fixtures')).filter((n) => n.startsWith('sourcecontrol.'))) {
    fs.copyFileSync(path.join(CODE_ROOT, 'test', 'fixtures', f), path.join(fixtures, f));
  }
  fs.writeFileSync(path.join(fixtures, 'sourcecontrol.git_get_user.json'), JSON.stringify({ login: 'ivanov', name: 'Иван Иванов' }));
  writePulls([]);
  for (const name of ['demo-service', 'ledger-service']) {
    repos[name] = makeRepo(path.join(root, name));
    gitIn(repos[name], 'remote', 'add', 'origin', `ssh://git@code.example:7998/PROJ/${name}.git`);
  }
  h = await startTestServer({
    mcpServers: { sourcecontrol: { transport: 'stdio', command: process.execPath, args: [path.join(CODE_ROOT, 'scripts', 'mock-mcp.js'), '--fixtures', fixtures, '--server', 'sourcecontrol'] } },
  });
  wsDemo = (await h.api('POST', '/api/workspaces', { path: repos['demo-service'] })).body;
  wsLedger = (await h.api('POST', '/api/workspaces', { path: repos['ledger-service'] })).body;
  task = (await h.api('POST', '/api/tasks', { title: 'с PR', workspaceId: wsDemo.id })).body;
  await h.api('PATCH', `/api/tasks/${task.id}`, { branch: `feature/${task.id}` });
});
after(async () => {
  await h.close();
  rmrf(root);
});

test('enabled "auto": on because the sourcecontrol MCP server exists; settings show auto + active', async () => {
  const st = (await h.api('GET', '/api/state')).body;
  assert.equal(st.integrations.pr, true);
  assert.ok(st.features.includes('prs-mine'));
  const pr = (await h.api('GET', '/api/settings')).body.integrations.pr;
  assert.deepEqual([pr.enabled, pr.active], ['auto', true]);
});

test('GET /api/prs?scope=mine: my open PRs of every repository, linked to tasks; cached until refresh=1', async () => {
  writePulls([
    pull(561, 'demo-service', `feature/${task.id}`, 'ivanov', 'моя задача'),
    pull(570, 'demo-service', 'feature/чужая', 'petrov'),
    pull(12, 'ledger-service', 'bugfix/ledger', 'ivanov'),
  ]);
  const r = (await h.api('GET', '/api/prs?scope=mine&refresh=1')).body;
  assert.equal(r.me, 'ivanov');
  assert.equal(r.meSource, 'tool');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.items.map((i) => [i.repo, i.index]).sort(), [['PROJ/demo-service', 561], ['PROJ/ledger-service', 12]]);
  const linked = r.items.find((i) => i.index === 561);
  assert.deepEqual([linked.workspaceId, linked.taskId, linked.taskKey, linked.head, linked.base, linked.author, linked.url],
    [wsDemo.id, task.id, task.id, `feature/${task.id}`, 'develop', 'ivanov', 'https://code.example/sc/PROJ/demo-service/pulls/561']);
  assert.deepEqual(linked.reviewers, [{ name: 'reviewer', status: 'PENDING' }]);
  assert.equal(r.items.find((i) => i.index === 12).workspaceId, wsLedger.id);
  assert.deepEqual([linked.sessionId, linked.byAgent, r.items.find((i) => i.index === 12).byAgent], [null, false, false]);
  const agent = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root })).body;
  assert.equal((await h.api('PATCH', `/api/tasks/${task.id}`, { assigneeSessionId: agent.id })).status, 200);
  const withAgent = (await h.api('GET', '/api/prs?scope=mine&refresh=1')).body.items.find((i) => i.index === 561);
  assert.deepEqual([withAgent.sessionId, withAgent.byAgent], [agent.id, true], 'the assignee of the task is behind it');

  writePulls([]);
  assert.equal((await h.api('GET', '/api/prs?scope=mine')).body.items.length, 2, 'cached for 3 minutes');
  assert.equal((await h.api('GET', '/api/prs?scope=mine&refresh=1')).body.items.length, 0);
});

test('a repository registered twice (main checkout + worktree) lists each of its PRs once', async () => {
  writePulls([pull(600, 'demo-service', 'feature/дубль', 'ivanov')]);
  const wt = path.join(root, 'demo-service-BPMNT-1');
  gitIn(repos['demo-service'], 'worktree', 'add', '-b', 'BPMNT-1', wt);
  const copy = (await h.api('POST', '/api/workspaces', { path: wt })).body; // a worktree of the same repository, second registration
  assert.notEqual(copy.id, wsDemo.id);
  const r = (await h.api('GET', '/api/prs?scope=mine&refresh=1')).body;
  assert.deepEqual(r.items.map((i) => [i.repo, i.index, i.workspaceId]), [['PROJ/demo-service', 600, wsDemo.id]], 'the first registration keeps the row');
});

test('another clone of a repository (its origin in another case) and a PR through the agent never duplicate a PR', async () => {
  writePulls([pull(610, 'demo-service', 'feature/клон', 'ivanov')]);
  const clone = makeRepo(path.join(root, 'demo-service-clone'));
  gitIn(clone, 'remote', 'add', 'origin', 'https://code.example/scm/proj/demo-service.git'); // an https clone: lower-case project
  await h.api('POST', '/api/workspaces', { path: clone });
  const r = (await h.api('GET', '/api/prs?scope=mine&refresh=1')).body;
  assert.deepEqual(r.items.map((i) => [i.repo, i.index]), [['PROJ/demo-service', 610]], 'one row, under the first registration');

  // the agent's own MCP call would open a second PR next to the open one: the harness answers with that one, no agent turn
  gitIn(clone, 'switch', '-q', '-c', 'feature/клон');
  const made = await h.api('POST', '/api/git/pr', { cwd: clone, title: 'PR', base: 'develop', via: 'agent' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.deepEqual(made.body, { url: 'https://code.example/sc/PROJ/demo-service/pulls/610', existing: true });
});

test('scope=tracked: PRs of task branches and worktrees, whoever opened them', async () => {
  writePulls([
    pull(580, 'demo-service', `feature/${task.id}`, 'petrov'),
    pull(581, 'demo-service', 'feature/просто', 'ivanov'),
  ]);
  const r = (await h.api('GET', '/api/prs?scope=tracked&refresh=1')).body;
  assert.deepEqual(r.items.map((i) => [i.index, i.taskId]), [[580, task.id]]);
  assert.equal((await h.api('GET', '/api/prs?scope=все')).status, 400);
});

test('scope=review / all and state=merged|all: the status tabs and «На ревью» of the PR list', async () => {
  const mergedFile = path.join(fixtures, 'sourcecontrol.git_list_pull_requests.MERGED.json');
  writePulls([
    { ...pull(590, 'demo-service', 'feature/ревью', 'petrov'), reviewers: [{ username: 'IVANOV', status: 'PENDING' }] },
    pull(591, 'demo-service', 'feature/чужое', 'petrov'),
  ]);
  fs.writeFileSync(mergedFile, JSON.stringify({ pulls: [{ ...pull(592, 'demo-service', 'feature/влит', 'ivanov'), state: 'merged' }] }));
  try {
    const get = async (q) => (await h.api('GET', `/api/prs?${q}&refresh=1`)).body.items.map((i) => i.index).sort();
    assert.deepEqual(await get('scope=review'), [590], 'a reviewer login matches in any case');
    assert.deepEqual(await get('scope=all'), [590, 591]);
    assert.deepEqual(await get('scope=mine&state=merged'), [592]);
    assert.deepEqual(await get('scope=all&state=all'), [590, 591, 592]);
    assert.equal((await h.api('GET', '/api/prs?state=closed')).status, 400);
  } finally {
    fs.rmSync(mergedFile, { force: true });
  }
});

test('prMe: integrations.pr.me wins; a failing git_get_user falls back to the OS account name with a warning', async () => {
  const { prMe } = await import('../server/integrations/pr.js');
  const cfg = (pr) => ({ integrations: { pr: { meTool: 'git_get_user', ...pr } } });
  const failing = { callTool: async () => { throw new Error('no such tool'); } };
  assert.deepEqual(await prMe({ config: cfg({ server: 'sc-a', me: 'petrov' }), mcp: failing }), { login: 'petrov', source: 'config' });
  const who = await prMe({ config: cfg({ server: 'sc-b' }), mcp: failing });
  assert.deepEqual([who.login, who.source], [os.userInfo().username, 'os']);
  assert.match(who.warning, /no such tool .*integrations.pr.me/);
});

test('settings: integrations.pr.me is saved, validated and used by /api/prs', async () => {
  assert.equal((await h.api('PUT', '/api/settings', { integrations: { pr: { me: 42 } } })).status, 400);
  assert.equal((await h.api('PUT', '/api/settings', { integrations: { pr: { me: ' petrov ' } } })).status, 200);
  assert.equal((await h.api('GET', '/api/settings')).body.integrations.pr.me, 'petrov');
  const r = (await h.api('GET', '/api/prs?scope=mine&refresh=1')).body;
  assert.deepEqual([r.me, r.meSource], ['petrov', 'config']);
  assert.equal((await h.api('PUT', '/api/settings', { integrations: { pr: { me: null } } })).status, 200);
});
