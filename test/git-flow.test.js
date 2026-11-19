// git/fs endpoints, branch naming, task start, worktrees from targets[0], ports, commit/PR prefill.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SUBAGENT_CONTEXT, TEMP_FILES } from '../server/orchestration.js';
import { launchers } from '../server/launchers.js';
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
  assert.deepEqual([sugg.commit.title, sugg.commit.body], ['', ''], 'no task key: empty (the agent writes the message)');
  const { hash } = (await h.api('POST', '/api/git/commit', { cwd: plain, message: 'add new\n\nbody' })).body;
  assert.match(hash, /^[0-9a-f]{40}$/);
  assert.equal((await h.api('GET', `/api/git/log?${q(plain, '&n=1')}`)).body[0].subject, 'add new');
  // a commit's own changes (the commits list): all of them or one file; only a hash goes to git
  assert.match((await h.api('GET', `/api/git/diff?${q(plain, `&rev=${hash}`)}`)).body.diff, /^diff --git a\/src\/new\.txt[\s\S]*\+hi/m);
  assert.match((await h.api('GET', `/api/git/diff?${q(plain, `&rev=${hash.slice(0, 7)}&path=src/new.txt`)}`)).body.diff, /\+hi/);
  assert.equal((await h.api('GET', `/api/git/diff?${q(plain, '&rev=--output=x')}`)).status, 400);
  assert.equal((await h.api('GET', `/api/git/diff?${q(plain, '&rev=deadbeef')}`)).status, 404);
  assert.equal((await h.api('GET', `/api/git/status?${q(plain)}`)).body.files.length, 0);
  assert.equal((await h.api('POST', '/api/git/pr', { cwd: plain, title: 't' })).status, 501);
});

test('task start: worktree from targets[0], branch from the key, task prompt template', async () => {
  const t = (await h.api('POST', '/api/tasks', { title: 'Health', description: 'add /health', workspaceId: wsA.id, targets: ['release-1', 'develop'] })).body;
  const s = (await h.api('POST', `/api/tasks/${t.id}/start`, { agent: 'mock' })).body;
  assert.equal(s.branch, `feature/${t.id}`);
  assert.equal(s.cwd, path.join(`${repoA}-worktrees`, t.id));
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
  assert.equal(wA.cwd, path.join(`${repoA}-worktrees`, 'JIRA-77'));
  assert.equal(wB.cwd, path.join(`${repoB}-worktrees`, 'JIRA-77'));
  assert.equal((await h.api('POST', '/api/agent/whoami', {}, { 'x-harness-session': wA.id })).body.taskKey, 'JIRA-77');
  const first = await waitFor(async () => (await messages(wA.id)).find((m) => m.kind === 'user'));
  assert.match(first.text, /^\/full-task JIRA-77 on feature\/JIRA-77/);

  await h.api('POST', '/api/agent/worker_done', { summary: 'Added the A endpoint', status: 'done' }, { 'x-harness-session': wA.id });
  assert.deepEqual([(await task(subA.id)).status, (await task(subA.id)).agentState], ['in_progress', 'done'], 'board.onWorkerDone "stay": the card keeps its column');
  fs.writeFileSync(path.join(wA.cwd, 'a.txt'), 'a\n');
  gitIn(wA.cwd, 'add', 'a.txt');
  gitIn(wA.cwd, 'commit', '-q', '-m', 'JIRA-77 add a');
  fs.writeFileSync(path.join(wA.cwd, 'b.txt'), 'b\n');

  const sg = (await h.api('GET', `/api/git/suggest?${q(wA.cwd)}`)).body;
  assert.equal(sg.taskId, subA.id);
  assert.equal(sg.key, 'JIRA-77');
  assert.equal(sg.branch, 'feature/JIRA-77');
  assert.equal(sg.base, 'develop');
  assert.equal(sg.commit.title, 'JIRA-77 A part');
  assert.match(sg.commit.body, /Added the A endpoint[\s\S]*- b\.txt/);
  assert.equal(sg.pr.title, 'JIRA-77 A part');
  assert.match(sg.pr.body, /Target: develop[\s\S]*Added the A endpoint[\s\S]*JIRA-77 add a/);
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
  assert.equal(gitIn(repoA, 'worktree', 'list').split('\n').filter((l) => l.includes(`[feature/${t.id}]`)).length, 1);
  const first = await waitFor(async () => (await messages(a.body.id)).find((m) => m.kind === 'user'));
  assert.equal(first.text, `/full-task ${t.id} on feature/${t.id} -> develop, release-1`);

  const again = (await h.api('POST', `/api/tasks/${t.id}/start`, {})).body;
  assert.deepEqual([again.id, again.jumped], [a.body.id, true]);
  const taken = await task(t.id);
  assert.ok(taken.takenAt && taken.snapshot.title === 'Twice');

  const r = await h.api('POST', `/api/tasks/${t.id}/port`, { target: 'release-1' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /нет коммитов сверх develop/);

  const run = await waitFor(() => {
    try {
      return fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.env.HARNESS_SESSION_ID === a.body.id);
    } catch {
      return null;
    }
  }, { what: 'worker argv' });
  const prompt = run.argv[run.argv.indexOf('-p') + 1];
  // a slash command must be the first word: the rendered task prompt goes first, then «load the command first», the
  // preamble after them (its «find the harness tools first» once took the command's place)
  const hint = launchers.mock.defaults.commandHint('full-task');
  assert.match(hint, /первый шаг — загрузить её инструментом skill \(\{"skill":"full-task"\}\)/);
  assert.ok(prompt.startsWith(`/full-task ${t.id} on feature/${t.id} -> develop, release-1\n\n${hint}\n\n${SUBAGENT_CONTEXT}\n\n${TEMP_FILES}\n\n[harness] You are a WORKER`), prompt.slice(0, 120));
  assert.match(prompt, /Do NOT commit, push, merge/);
  assert.match(prompt, /commit message format: "T-\d+ <summary>"/);
  assert.match(prompt, /Registry dir: .*registry/);
  assert.match(prompt, /Helpers \(implementers, reviewers, exploration\) go through mcp__harness__agent/, 'harness mode: helpers in their own chats, never «the built-in agent is fine»');
  assert.match(prompt, /Base branch \(primary target\): develop/);
  // /full-task makes its own worktree unless told it is already in one
  assert.match(prompt, new RegExp(`Ты уже в рабочем дереве задачи \`[^\`]+\` \\(ветка \`feature/${t.id}\`\\) — это и есть worktree задачи; не создавай другой\\. Коммиты/пуш/PR/трекер — только пользователь из UI\\. После финального сообщения твоей команды вызови worker_done с тем же текстом\\.`));
  await h.api('POST', `/api/sessions/${a.body.id}/stop`);
});

test('worktrees: create from a base, remove a dirty one (force + prune + folder gone)', async () => {
  const wt = (await h.api('POST', `/api/workspaces/${wsA.id}/worktrees`, { name: 'tmp/remove me', base: 'release-1' })).body;
  assert.equal(wt.branch, 'tmp/remove-me');
  assert.equal(gitIn(wt.path, 'rev-parse', 'HEAD'), gitIn(repoA, 'rev-parse', 'release-1'));
  fs.writeFileSync(path.join(wt.path, 'dirty.txt'), 'uncommitted\n');
  const listed = (await h.api('GET', `/api/workspaces/${wsA.id}/worktrees`)).body;
  assert.ok(listed.some((w) => w.path === wt.path && !w.main));
  const refused = await h.api('DELETE', `/api/workspaces/${wsA.id}/worktrees`, { path: wt.path });
  assert.deepEqual([refused.status, refused.body.dirty, refused.body.running], [409, 1, 0], 'uncommitted changes need force');
  assert.equal((await h.api('DELETE', `/api/workspaces/${wsA.id}/worktrees`, { path: wt.path, force: true })).status, 200);
  assert.equal(fs.existsSync(wt.path), false);
  assert.ok(!gitIn(repoA, 'worktree', 'list').includes('remove-me'));
});

test('port to release/x.y.z: rel slug branch, only the commits the target lacks; PR suggestion within byte limits', async () => {
  // release/1.54.0 already got the first fix by hand (same patch, different commit)
  gitIn(repoA, 'branch', 'release/1.54.0', 'develop');
  const t = (await h.api('POST', '/api/tasks', { title: 'Двойной фикс для релиза и develop '.repeat(4).trim(), workspaceId: wsA.id, targets: ['develop', 'release/1.54.0'] })).body;
  const s = (await h.api('POST', `/api/tasks/${t.id}/start`, { agent: 'mock' })).body;
  await h.api('POST', `/api/sessions/${s.id}/stop`);
  fs.writeFileSync(path.join(s.cwd, 'one.txt'), 'one\n');
  gitIn(s.cwd, 'add', '-A');
  gitIn(s.cwd, 'commit', '-q', '-m', `${t.id} first`);
  fs.writeFileSync(path.join(s.cwd, 'two.txt'), 'two\n');
  gitIn(s.cwd, 'add', '-A');
  gitIn(s.cwd, 'commit', '-q', '-m', `${t.id} second`);
  const first = gitIn(s.cwd, 'rev-parse', 'HEAD~1');
  const rel = path.join(root, 'rel-wt');
  gitIn(repoA, 'worktree', 'add', '-q', rel, 'release/1.54.0');
  gitIn(rel, 'cherry-pick', first);
  gitIn(repoA, 'worktree', 'remove', '--force', rel);

  const p = (await h.api('POST', `/api/tasks/${t.id}/port`, { target: 'release/1.54.0' })).body;
  assert.equal(p.status, 'clean', JSON.stringify(p));
  assert.equal(p.branch, `feature/${t.id}-rel154`);
  assert.equal(p.cwd, path.join(`${repoA}-worktrees`, `${t.id}-rel154`));
  const picked = gitIn(p.cwd, 'log', '--format=%s', 'release/1.54.0..HEAD').split('\n');
  assert.deepEqual(picked, [`${t.id} second`], 'only the missing commit is cherry-picked');

  const sg = (await h.api('GET', `/api/git/suggest?${q(s.cwd)}`)).body;
  assert.ok(Buffer.byteLength(sg.pr.title) <= 100 && sg.pr.title.endsWith('…'), sg.pr.title);
  assert.ok(Buffer.byteLength(sg.pr.body) <= 512);
  assert.ok(!sg.pr.title.includes('�'));
});

test('take into work on a parent task starts a coordinator with the plan of its subtasks', async () => {
  const parent = (await h.api('POST', '/api/tasks', { title: 'Multi-repo feature', targets: ['develop'] })).body;
  const subA = (await h.api('POST', '/api/agent/task_create', { title: 'A side', parent_id: parent.id, workspace: 'svc-a' })).body;
  const subB = (await h.api('POST', '/api/agent/task_create', { title: 'B side', parent_id: parent.id, workspace: wsB.id, deps: [subA.id] })).body;
  const s = (await h.api('POST', `/api/tasks/${parent.id}/start`, { agent: 'mock' })).body;
  assert.equal(s.role, 'coordinator');
  assert.equal(s.taskId, parent.id);
  assert.equal(path.resolve(s.cwd), path.resolve(root), 'common parent folder of the subtask repositories');
  assert.equal(s.title, `${parent.id}: Multi-repo feature`);
  const t = await task(parent.id);
  assert.deepEqual([t.status, t.assigneeSessionId, !!t.takenAt], ['in_progress', s.id, true]);
  assert.deepEqual([(await h.api('POST', `/api/tasks/${parent.id}/start`, {})).body.id, (await h.api('POST', `/api/tasks/${parent.id}/start`, {})).body.jumped], [s.id, true]);

  const run = await waitFor(() => {
    try {
      return fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.env.HARNESS_SESSION_ID === s.id);
    } catch {
      return null;
    }
  }, { what: 'coordinator argv' });
  const prompt = run.argv[run.argv.indexOf('-p') + 1];
  assert.ok(prompt.startsWith(`/full-task ${parent.id} on  -> develop`), prompt.slice(0, 80));
  assert.match(prompt, /You are the COORDINATOR/);
  assert.match(prompt, new RegExp(`- ${subA.id} "A side" - workspace: svc-a - deps: none`));
  assert.match(prompt, new RegExp(`- ${subB.id} "B side" - workspace: svc-b - deps: ${subA.id}`));
  assert.match(prompt, new RegExp(`worker_start\\(\\{ task_id \\}\\) \\(placement automatic.*feature/${parent.id}`));
  await h.api('POST', `/api/sessions/${s.id}/stop`);

  const loose = (await h.api('POST', '/api/tasks', { title: 'No repo yet' })).body;
  const c2 = (await h.api('POST', `/api/tasks/${loose.id}/start`, { agent: 'mock' })).body;
  assert.deepEqual([c2.role, c2.atRoot], ['worker', true], 'no sure repository while several exist -> the projects folder');
  await h.api('POST', `/api/sessions/${c2.id}/stop`);
});
