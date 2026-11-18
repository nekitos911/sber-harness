// Worktree management: enriched list, meta (label/pin/sleeping), safe removal with archived sessions and optional
// branch deletion, open-in (file manager / IDE) with an injected spawner.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startTestServer, makeRepo, tmpDir, rmrf, gitIn, waitFor } from './helpers.js';

const root = tmpDir();
const repo = path.join(root, 'сервис');
const spawned = [];
let h;
let ws;

before(async () => {
  makeRepo(repo);
  h = await startTestServer({}, { openSpawner: (command, args, opts) => { spawned.push({ command, args, opts }); return { pid: 1, on() {}, unref() {} }; } });
  ws = (await h.api('POST', '/api/workspaces', { path: repo })).body;
});
after(async () => {
  await h.close();
  rmrf(root);
});

const list = async (enrich = true) => (await h.api('GET', `/api/workspaces/${ws.id}/worktrees${enrich ? '?enrich=1' : ''}`)).body;
const addWt = async (name) => (await h.api('POST', `/api/workspaces/${ws.id}/worktrees`, { name })).body;
const commit = (cwd, file) => {
  fs.writeFileSync(path.join(cwd, file), `${file}\n`);
  gitIn(cwd, 'add', '-A');
  gitIn(cwd, 'commit', '-q', '-m', `add ${file}`);
};

test('enriched worktree list: dirty, ahead, task, sessions, meta', async () => {
  const wt = await addWt('feature/T-wt');
  commit(wt.path, 'a.txt');
  fs.writeFileSync(path.join(wt.path, 'dirty.txt'), 'x');
  const t = (await h.api('POST', '/api/tasks', { title: 'wt task', workspaceId: ws.id })).body;
  await h.api('PATCH', `/api/tasks/${t.id}`, { branch: 'feature/T-wt' });
  const chat = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: wt.path })).body;
  await h.api('PATCH', '/api/worktrees/meta', { path: wt.path, label: 'Лимиты', pinned: true });
  const item = await waitFor(async () => (await list()).find((w) => w.path === wt.path && w.dirty === 1));
  assert.deepEqual([item.ahead, item.taskId, item.taskStatus, item.sessions, item.running, { ...item.meta, repo: undefined }, item.createdBy], [1, t.id, 'todo', 1, 0, { createdBy: 'user', label: 'Лимиты', pinned: true, repo: undefined }, 'user']);
  assert.equal(path.resolve(item.meta.repo), path.resolve(repo), 'meta remembers its repository');
  assert.ok(item.lastActivityAt >= chat.lastActivityAt, 'newest of session activity and the git dir mtime');
  const main = (await list()).find((w) => w.main);
  assert.deepEqual([main.dirty, main.ahead], [0, 0]);
  assert.equal((await h.api('PATCH', '/api/worktrees/meta', { path: path.join(root, 'elsewhere'), label: 'x' })).status, 400);
});

test('sleeping refuses running turns unless forced', async () => {
  const wt = await addWt('feature/sleepy');
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: wt.path, prompt: '#silent' })).body;
  await waitFor(async () => (await h.api('GET', '/api/state')).body.sessions.find((x) => x.id === s.id).status === 'running');
  const r = await h.api('PATCH', '/api/worktrees/meta', { path: wt.path, sleeping: true });
  assert.deepEqual([r.status, r.body.running], [409, 1]);
  assert.deepEqual((await h.api('PATCH', '/api/worktrees/meta', { path: wt.path, sleeping: true, force: true })).body, { createdBy: 'user', sleeping: true });
  await waitFor(async () => (await h.api('GET', '/api/state')).body.sessions.find((x) => x.id === s.id).pid === null, { what: 'turn stopped' });
});

test('removal: refuses dirty/unmerged without force, archives sessions, safe branch delete keeps unmerged work', async () => {
  const wt = await addWt('feature/unmerged');
  commit(wt.path, 'b.txt');
  const chat = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: wt.path })).body;
  const refused = await h.api('DELETE', `/api/workspaces/${ws.id}/worktrees`, { path: wt.path });
  assert.deepEqual([refused.status, refused.body.dirty, refused.body.ahead, refused.body.running], [409, 0, 1, 0]);
  const main = (await list()).find((w) => w.main);
  assert.equal((await h.api('DELETE', `/api/workspaces/${ws.id}/worktrees`, { path: main.path, force: true })).status, 400, 'never the main worktree');

  const r = (await h.api('DELETE', `/api/workspaces/${ws.id}/worktrees`, { path: wt.path, force: true, deleteBranch: 'safe' })).body;
  assert.deepEqual(r, { removed: true, branchDeleted: false, archivedSessions: 1 });
  assert.ok(!fs.existsSync(wt.path));
  assert.match(gitIn(repo, 'branch', '--list', 'feature/unmerged'), /feature\/unmerged/, 'unmerged branch kept by a safe delete');
  const archived = (await h.api('GET', '/api/state')).body.sessions.find((s) => s.id === chat.id);
  assert.equal(archived.archived, true);
  assert.ok((await h.api('GET', `/api/sessions/${chat.id}/messages`)).status === 200, 'transcript kept');

  const merged = await addWt('feature/merged');
  const r2 = (await h.api('DELETE', `/api/workspaces/${ws.id}/worktrees`, { path: merged.path, deleteBranch: 'safe' })).body;
  assert.deepEqual([r2.removed, r2.branchDeleted], [true, true]);
  assert.equal(gitIn(repo, 'branch', '--list', 'feature/merged'), '');
});

test('open in the file manager or the configured IDE, only for registered folders', async () => {
  assert.equal((await h.api('POST', '/api/open', { cwd: repo, target: 'explorer' })).status, 200);
  const fm = spawned.at(-1);
  assert.deepEqual([fm.args, fm.opts.windowsHide, fm.opts.shell], [[path.resolve(repo)], true, undefined]);
  assert.equal(fm.command, process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open');
  assert.equal((await h.api('POST', '/api/open', { cwd: root, target: 'explorer' })).status, 400, 'not a registered workspace');
  assert.equal((await h.api('POST', '/api/open', { cwd: repo, target: 'ide' })).status, 400, 'no IDE configured');
  assert.equal((await h.api('PUT', '/api/settings', { ide: { command: 'code', args: ['--goto', '{path}'] } })).status, 200);
  assert.equal((await h.api('POST', '/api/open', { cwd: repo, target: 'ide' })).status, 200);
  assert.deepEqual([spawned.at(-1).command, spawned.at(-1).args], ['code', ['--goto', path.resolve(repo)]]);
  assert.equal((await h.api('PUT', '/api/settings', { ide: { command: '' } })).status, 400);
});

test('a file from the chat: opened by its program, or shown in its folder; never a program, never outside', async () => {
  const doc = path.join(repo, 'спека.docx');
  fs.writeFileSync(doc, 'x');
  const fm = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const open = (body) => h.api('POST', '/api/open', body);
  assert.deepEqual((await open({ target: 'file', path: doc })).body, { ok: true, revealed: false });
  assert.deepEqual([spawned.at(-1).command, spawned.at(-1).args], [fm, [doc]]);
  assert.equal((await open({ target: 'reveal', cwd: repo, path: 'спека.docx' })).status, 200, 'relative to cwd');
  const select = process.platform === 'win32' ? ['/select,', doc] : process.platform === 'darwin' ? ['-R', doc] : [repo];
  assert.deepEqual(spawned.at(-1).args, select);
  const bat = path.join(repo, 'run.bat');
  fs.writeFileSync(bat, 'echo');
  assert.equal((await open({ target: 'file', path: bat })).body.revealed, true, 'a script is shown in its folder, not started');
  // a chat's attachment lives outside every project folder, still opens
  const att = path.join(h.dataDir, 'runs', 'чат1', 'attachments', 'a.png');
  fs.mkdirSync(path.dirname(att), { recursive: true });
  fs.writeFileSync(att, 'x');
  assert.equal((await open({ target: 'file', path: att })).status, 200);
  const n = spawned.length;
  assert.equal((await open({ target: 'file', path: path.join(h.dataDir, 'db.json') })).status, 400, 'the harness data is not a chat file');
  assert.equal((await open({ target: 'file', path: path.join(root, 'чужое.txt') })).status, 400, 'outside the projects');
  assert.equal((await open({ target: 'file', path: path.join(repo, 'нет.txt') })).status, 404);
  assert.equal((await open({ target: 'file', path: 'спека.docx' })).status, 400, 'relative without cwd');
  assert.equal(spawned.length, n, 'nothing was started for a refused path');
});

test('listing scales: 20 worktrees list without git per worktree; enrich and per-path info on demand', async () => {
  for (let i = 0; i < 20; i++) gitIn(repo, 'worktree', 'add', '-q', '-b', `bulk/w${i}`, path.join(root, 'много', `w${i}`));
  const t0 = performance.now();
  const cheap = await list(false);
  const ms = performance.now() - t0;
  console.log(`worktree list (${cheap.length} worktrees, no enrich): ${ms.toFixed(0)} ms`);
  assert.ok(ms < 300, `took ${ms} ms`);
  const bulk = cheap.filter((w) => w.branch?.startsWith('bulk/'));
  assert.equal(bulk.length, 20);
  assert.ok(bulk.every((w) => w.enriched === false && w.dirty === null && w.ahead === null && w.lastActivityAt > 0), 'no git status per worktree; activity from the git dir mtime');
  fs.writeFileSync(path.join(bulk[0].path, 'new.txt'), 'x');
  const info = (await h.api('GET', `/api/worktrees/info?path=${encodeURIComponent(bulk[0].path)}`)).body;
  assert.deepEqual([info.enriched, info.dirty, info.ahead], [true, 1, 0]);
  assert.equal((await list(false)).find((w) => w.path === bulk[0].path).dirty, 1, 'a fresh cache entry is reused by the cheap list');
  const rich = await list(true);
  assert.ok(rich.every((w) => w.enriched && Number.isInteger(w.dirty)));
  assert.equal((await h.api('GET', `/api/worktrees/info?path=${encodeURIComponent(path.join(root, 'нет'))}`)).status, 400);
});

test('reads never touch the index; an old worktree stays old after enrichment; a chat in a worktree belongs to its repo', async () => {
  const wt = await addWt('feature/old');
  const gitDir = gitIn(wt.path, 'rev-parse', '--absolute-git-dir');
  // a commit and a reflog from a month ago, an index from a month ago
  const month = new Date(Date.now() - 30 * 86400000);
  fs.writeFileSync(path.join(wt.path, 'old.txt'), 'old\n');
  gitIn(wt.path, 'add', 'old.txt');
  execFileSync('git', ['commit', '-q', '-m', 'old work'], { cwd: wt.path, env: { ...process.env, GIT_COMMITTER_DATE: month.toISOString(), GIT_AUTHOR_DATE: month.toISOString() } });
  for (const f of ['index', path.join('logs', 'HEAD'), 'HEAD']) fs.utimesSync(path.join(gitDir, f), month, month);
  fs.writeFileSync(path.join(wt.path, 'untracked.txt'), 'x'); // makes git status want to refresh the index
  const indexBefore = fs.statSync(path.join(gitDir, 'index')).mtimeMs;

  const item = (await list(true)).find((w) => w.path === wt.path);
  assert.equal(item.dirty, 1);
  assert.equal(fs.statSync(path.join(gitDir, 'index')).mtimeMs, indexBefore, 'GIT_OPTIONAL_LOCKS=0: status did not rewrite the index');
  assert.ok(item.lastActivityAt < Date.now() - 20 * 86400000, `not recent: ${new Date(item.lastActivityAt).toISOString()}`);

  // a projects folder that contains the worktree must not win over the repository that owns it
  const folder = (await h.api('POST', '/api/workspaces', { path: root, kind: 'folder' })).body;
  const chat = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: wt.path })).body;
  assert.deepEqual([chat.workspaceId === ws.id, chat.workspaceId === folder.id], [true, false]);
});
