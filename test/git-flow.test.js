// git/fs endpoints, branch naming, task start, worktrees from targets[0], ports, commit/PR prefill.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, makeRepo, tmpDir, rmrf, gitIn, waitFor } from './helpers.js';

let h;
const root = tmpDir();
const repoA = path.join(root, 'svc-a');
const repoB = path.join(root, 'svc-b');
const plain = path.join(root, 'plain');
const argvFile = path.join(root, 'argv.jsonl');
let wsA;
let wsB;

before(async () => {
  makeRepo(repoA);
  makeRepo(repoB);
  makeRepo(plain);
  // release-1 diverges from develop on README line 2 (for the conflict port) and has REL.md
  gitIn(repoA, 'checkout', '-q', '-b', 'release-1');
  fs.writeFileSync(path.join(repoA, 'README.md'), 'line 1\nrelease line 2\nline 3\n');
  fs.writeFileSync(path.join(repoA, 'REL.md'), 'release\n');
  gitIn(repoA, 'commit', '-q', '-am', 'release change');
  gitIn(repoA, 'add', 'REL.md');
  gitIn(repoA, 'commit', '-q', '-m', 'release file');
  gitIn(repoA, 'checkout', '-q', 'develop');
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  h = await startTestServer({ agents: { mock: { taskPromptTemplate: '/full-task {key} on {branch} -> {targets}' } } });
  wsA = (await h.api('POST', '/api/workspaces', { path: repoA })).body;
  wsB = (await h.api('POST', '/api/workspaces', { path: repoB, name: 'svc-b' })).body;
});
after(async () => {
  await h.close();
  rmrf(root);
});

const q = (cwd, extra = '') => `cwd=${encodeURIComponent(cwd)}${extra}`;
const messages = async (sid) => (await h.api('GET', `/api/sessions/${sid}/messages`)).body;
const task = async (id) => (await h.api('GET', '/api/state')).body.tasks.find((t) => t.id === id);

test('fs guard, git status/diff/commit/log', async () => {
  assert.equal(wsA.isGit, true);
  assert.equal((await h.api('PUT', '/api/fs/file', { cwd: plain, path: 'src/new.txt', content: 'hi\n' })).status, 200);
  const list = (await h.api('GET', `/api/fs/list?${q(plain)}`)).body;
  assert.deepEqual(list.map((e) => e.name), ['src', 'README.md']);
  assert.equal((await h.api('GET', `/api/fs/file?${q(plain, '&path=src/new.txt')}`)).body.content, 'hi\n');
  assert.equal((await h.api('GET', `/api/fs/list?${q(plain, '&path=..')}`)).status, 400);
  assert.equal((await h.api('GET', `/api/fs/file?${q(plain, `&path=${encodeURIComponent('../svc-a/README.md')}`)}`)).status, 400);
  assert.equal((await h.api('PUT', '/api/fs/file', { cwd: plain, path: '../evil.txt', content: 'x' })).status, 400);
  assert.equal(fs.existsSync(path.join(root, 'evil.txt')), false);

  const st = (await h.api('GET', `/api/git/status?${q(plain)}`)).body;
  assert.equal(st.branch, 'develop');
  assert.deepEqual(st.files.map((f) => [f.path, f.status]), [['src/new.txt', '?']]);
  const { diff } = (await h.api('GET', `/api/git/diff?${q(plain)}`)).body;
  assert.match(diff, /src\/new\.txt[\s\S]*\+hi/);
  const sugg = (await h.api('GET', `/api/git/suggest?${q(plain)}`)).body;
  assert.equal(sugg.taskId, null);
  assert.equal(sugg.commit.title, 'Update src/new.txt');
  const { hash } = (await h.api('POST', '/api/git/commit', { cwd: plain, message: 'add new\n\nbody' })).body;
  assert.match(hash, /^[0-9a-f]{40}$/);
  assert.equal((await h.api('GET', `/api/git/log?${q(plain, '&n=1')}`)).body[0].subject, 'add new');
  assert.equal((await h.api('GET', `/api/git/status?${q(plain)}`)).body.files.length, 0);
  assert.equal((await h.api('POST', '/api/git/pr', { cwd: plain, title: 't' })).status, 501);
});

test('task start: worktree from targets[0], branch from the key, task prompt template', async () => {
  const t = (await h.api('POST', '/api/tasks', { title: 'Health', description: 'add /health', workspaceId: wsA.id, targets: ['release-1', 'develop'] })).body;
  const s = (await h.api('POST', `/api/tasks/${t.id}/start`, { agent: 'mock' })).body;
  assert.equal(s.branch, `feature/${t.id}`);
  assert.equal(s.cwd, path.join(`${repoA}.worktrees`, `feature-${t.id}`));
  assert.equal(gitIn(s.cwd, 'rev-parse', 'HEAD'), gitIn(repoA, 'rev-parse', 'release-1'));
  assert.equal((await task(t.id)).branch, `feature/${t.id}`);
  const first = await waitFor(async () => (await messages(s.id)).find((m) => m.kind === 'user'), { what: 'first prompt' });
  assert.equal(first.text, `/full-task ${t.id} on feature/${t.id} -> release-1, develop`);
  await h.api('POST', `/api/sessions/${s.id}/stop`);
});

test('subtasks share the root key; branch gets a suffix when taken; suggest prefills from the task', async () => {
  const parent = (await h.api('POST', '/api/agent/task_create', { title: 'Multi', targets: ['develop'] })).body;
  await h.api('PATCH', `/api/tasks/${parent.id}`, { externalId: 'JIRA-77' });
  gitIn(repoB, 'branch', 'feature/JIRA-77');
  const subA = (await h.api('POST', '/api/agent/task_create', { title: 'A part', parent_id: parent.id, workspace: 'svc-a' })).body;
  const subB = (await h.api('POST', '/api/agent/task_create', { title: 'B part', parent_id: parent.id, workspace: wsB.id })).body;
  assert.deepEqual([subA.workspaceId, subB.workspaceId], [wsA.id, wsB.id]);
  assert.deepEqual(subB.targets, ['develop']);

  const wA = (await h.api('POST', '/api/agent/worker_start', { task_id: subA.id, worktree: 'new', agent: 'mock' })).body;
  const wB = (await h.api('POST', '/api/agent/worker_start', { task_id: subB.id, worktree: 'new', agent: 'mock' })).body;
  assert.equal(wA.branch, 'feature/JIRA-77');
  assert.equal(wB.branch, 'feature/JIRA-77-2');
  assert.ok(wA.cwd.startsWith(`${repoA}.worktrees`));
  assert.equal((await h.api('POST', '/api/agent/whoami', {}, { 'x-harness-session': wA.id })).body.taskKey, 'JIRA-77');
  const first = await waitFor(async () => (await messages(wA.id)).find((m) => m.kind === 'user'));
  assert.match(first.text, /^\/full-task JIRA-77 on feature\/JIRA-77/);

  await h.api('POST', '/api/agent/worker_done', { summary: 'Added the A endpoint', status: 'done' }, { 'x-harness-session': wA.id });
  assert.equal((await task(subA.id)).status, 'review');
  fs.writeFileSync(path.join(wA.cwd, 'a.txt'), 'a\n');
  gitIn(wA.cwd, 'add', 'a.txt');
  gitIn(wA.cwd, 'commit', '-q', '-m', 'JIRA-77: add a');
  fs.writeFileSync(path.join(wA.cwd, 'b.txt'), 'b\n');

  const sg = (await h.api('GET', `/api/git/suggest?${q(wA.cwd)}`)).body;
  assert.equal(sg.taskId, subA.id);
  assert.equal(sg.key, 'JIRA-77');
  assert.equal(sg.branch, 'feature/JIRA-77');
  assert.equal(sg.base, 'develop');
  assert.equal(sg.commit.title, 'JIRA-77: A part');
  assert.match(sg.commit.body, /Added the A endpoint[\s\S]*- b\.txt/);
  assert.equal(sg.pr.title, 'JIRA-77: A part');
  assert.match(sg.pr.body, /Target: develop[\s\S]*Added the A endpoint[\s\S]*JIRA-77: add a/);
  await h.api('POST', `/api/sessions/${wB.id}/stop`);
});

test('ports: clean cherry-pick and conflict that starts a resolver worker', async () => {
  const startTask = async (title, file, content) => {
    const t = (await h.api('POST', '/api/tasks', { title, workspaceId: wsA.id, targets: ['develop', 'release-1'] })).body;
    const s = (await h.api('POST', `/api/tasks/${t.id}/start`, { agent: 'mock' })).body;
    fs.writeFileSync(path.join(s.cwd, file), content);
    gitIn(s.cwd, 'add', '-A');
    gitIn(s.cwd, 'commit', '-q', '-m', `${t.id}: ${title}`);
    return t;
  };

  const clean = await startTask('Fix', 'fix.txt', 'fix\n');
  const p1 = (await h.api('POST', `/api/tasks/${clean.id}/port`, { target: 'release-1' })).body;
  assert.equal(p1.status, 'clean', JSON.stringify(p1));
  assert.equal(p1.branch, `feature/${clean.id}-release-1`);
  assert.ok(fs.existsSync(path.join(p1.cwd, 'fix.txt')) && fs.existsSync(path.join(p1.cwd, 'REL.md')));
  assert.match(gitIn(p1.cwd, 'log', '-1', '--format=%B'), /cherry picked from commit/);
  assert.deepEqual((await task(clean.id)).ports, [p1]);
  assert.equal((await h.api('GET', `/api/git/suggest?${q(p1.cwd)}`)).body.base, 'release-1');
  assert.equal((await h.api('POST', `/api/tasks/${clean.id}/port`, { target: 'develop' })).status, 400);

  const conflict = await startTask('Readme', 'README.md', 'line 1\ntask line 2\nline 3\n');
  const p2 = (await h.api('POST', `/api/tasks/${conflict.id}/port`, { target: 'release-1', agent: 'mock' })).body;
  assert.equal(p2.status, 'conflict', JSON.stringify(p2));
  const resolver = (await h.api('GET', '/api/state')).body.sessions.find((s) => s.id === p2.sessionId);
  assert.equal(resolver.role, 'worker');
  assert.equal(resolver.cwd, p2.cwd);
  assert.equal(resolver.taskId, conflict.id);
  assert.equal((await h.api('POST', `/api/tasks/${conflict.id}/port`, { target: 'release-1' })).status, 409);
  await h.api('POST', '/api/agent/worker_done', { summary: 'resolved', status: 'done' }, { 'x-harness-session': resolver.id });
  const after = await task(conflict.id);
  assert.equal(after.ports[0].status, 'done');
  assert.equal(after.status, 'in_progress', 'a port report does not move the task');
});

test('concurrent starts give one worker; a live task jumps to it; port needs commits; worker may not commit by default', async () => {
  const t = (await h.api('POST', '/api/tasks', { title: 'Twice', workspaceId: wsA.id, targets: ['develop', 'release-1'] })).body;
  const [a, b] = await Promise.all([
    h.api('POST', `/api/tasks/${t.id}/start`, { agent: 'mock', notes: 'be brief' }),
    h.api('POST', `/api/tasks/${t.id}/start`, { agent: 'mock' }),
  ]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(a.body.id, b.body.id);
  assert.equal([a.body.jumped, b.body.jumped].filter(Boolean).length, 1);
  const workers = (await h.api('GET', '/api/state')).body.sessions.filter((s) => s.taskId === t.id);
  assert.equal(workers.length, 1);
  assert.equal(gitIn(repoA, 'worktree', 'list').split('\n').filter((l) => l.includes(`feature-${t.id}`)).length, 1);
  const first = await waitFor(async () => (await messages(a.body.id)).find((m) => m.kind === 'user'));
  assert.equal(first.text, `/full-task ${t.id} on feature/${t.id} -> develop, release-1`);

  const again = (await h.api('POST', `/api/tasks/${t.id}/start`, {})).body;
  assert.deepEqual([again.id, again.jumped], [a.body.id, true]);
  const taken = await task(t.id);
  assert.ok(taken.takenAt && taken.snapshot.title === 'Twice');

  const r = await h.api('POST', `/api/tasks/${t.id}/port`, { target: 'release-1' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no commits ahead of develop/);

  const run = await waitFor(() => {
    try {
      return fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.env.HARNESS_SESSION_ID === a.body.id);
    } catch {
      return null;
    }
  }, { what: 'worker argv' });
  const prompt = run.argv[run.argv.indexOf('-p') + 1];
  assert.match(prompt, /Do NOT commit, push, merge/);
  assert.match(prompt, /Base branch \(primary target\): develop/);
  await h.api('POST', `/api/sessions/${a.body.id}/stop`);
});

test('worktrees: create from a base, remove a dirty one (force + prune + folder gone)', async () => {
  const wt = (await h.api('POST', `/api/workspaces/${wsA.id}/worktrees`, { name: 'tmp/remove me', base: 'release-1' })).body;
  assert.equal(wt.branch, 'tmp/remove-me');
  assert.equal(gitIn(wt.path, 'rev-parse', 'HEAD'), gitIn(repoA, 'rev-parse', 'release-1'));
  fs.writeFileSync(path.join(wt.path, 'dirty.txt'), 'uncommitted\n');
  const listed = (await h.api('GET', `/api/workspaces/${wsA.id}/worktrees`)).body;
  assert.ok(listed.some((w) => w.path === wt.path && !w.main));
  assert.equal((await h.api('DELETE', `/api/workspaces/${wsA.id}/worktrees`, { path: wt.path })).status, 200);
  assert.equal(fs.existsSync(wt.path), false);
  assert.ok(!gitIn(repoA, 'worktree', 'list').includes('remove-me'));
});
