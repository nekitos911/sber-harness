// Worktree management: enriched list, meta (label/pin/sleeping), safe removal with archived sessions and optional
// branch deletion, open-in (file manager / IDE) with an injected spawner.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, makeRepo, tmpDir, rmrf, gitIn, waitFor } from './helpers.js';

const root = tmpDir();
const repo = path.join(root, 'сервис');
const spawned = [];
let h;
let ws;

before(async () => {
  makeRepo(repo);
  h = await startTestServer({}, { openSpawner: (command, args, opts) => { spawned.push({ command, args, opts }); return { on() {}, unref() {} }; } });
  ws = (await h.api('POST', '/api/workspaces', { path: repo })).body;
});
after(async () => {
  await h.close();
  rmrf(root);
});

const list = async () => (await h.api('GET', `/api/workspaces/${ws.id}/worktrees`)).body;
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
  assert.deepEqual([item.ahead, item.taskId, item.taskStatus, item.sessions, item.running, item.meta], [1, t.id, 'todo', 1, 0, { label: 'Лимиты', pinned: true }]);
  assert.equal(item.lastActivityAt, chat.lastActivityAt);
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
  assert.deepEqual((await h.api('PATCH', '/api/worktrees/meta', { path: wt.path, sleeping: true, force: true })).body, { sleeping: true });
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
  assert.deepEqual([fm.args, fm.opts.detached, fm.opts.shell], [[path.resolve(repo)], true, false]);
  assert.equal(fm.command, process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open');
  assert.equal((await h.api('POST', '/api/open', { cwd: root, target: 'explorer' })).status, 400, 'not a registered workspace');
  assert.equal((await h.api('POST', '/api/open', { cwd: repo, target: 'ide' })).status, 400, 'no IDE configured');
  assert.equal((await h.api('PUT', '/api/settings', { ide: { command: 'code', args: ['--goto', '{path}'] } })).status, 200);
  assert.equal((await h.api('POST', '/api/open', { cwd: repo, target: 'ide' })).status, 200);
  assert.deepEqual([spawned.at(-1).command, spawned.at(-1).args], ['code', ['--goto', path.resolve(repo)]]);
  assert.equal((await h.api('PUT', '/api/settings', { ide: { command: '' } })).status, 400);
});
