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
  const repos = {};
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

test('scope=tracked: PRs of task branches and worktrees, whoever opened them', async () => {
  writePulls([
    pull(580, 'demo-service', `feature/${task.id}`, 'petrov'),
    pull(581, 'demo-service', 'feature/просто', 'ivanov'),
  ]);
  const r = (await h.api('GET', '/api/prs?scope=tracked&refresh=1')).body;
  assert.deepEqual(r.items.map((i) => [i.index, i.taskId]), [[580, task.id]]);
  assert.equal((await h.api('GET', '/api/prs?scope=все')).status, 400);
});
