// Where a chat runs: the projects folder (auto-detected), any folder (directory browser), extra directories per session.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, makeRepo, tmpDir, rmrf, gitIn, waitFor } from './helpers.js';

const root = tmpDir();
const repoA = path.join(root, 'платежи');
const repoB = path.join(root, 'леджер');
const extra1 = path.join(root, 'доп 1');
const extra2 = path.join(root, 'доп 2');
const argvFile = path.join(root, 'argv.ndjson');
let h;

before(async () => {
  makeRepo(repoA);
  makeRepo(repoB);
  for (const d of [extra1, extra2, path.join(root, 'дерево', 'видимая'), path.join(root, 'дерево', '.скрытая')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'дерево', 'файл.txt'), 'x');
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  h = await startTestServer();
});
after(async () => {
  delete process.env.MOCK_AGENT_ARGV_FILE;
  await h.close();
  rmrf(root);
});

const state = async () => (await h.api('GET', '/api/state')).body;
const runsOf = (sid) => {
  try {
    return fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.env.HARNESS_SESSION_ID === sid);
  } catch {
    return [];
  }
};
const dirsOf = (argv) => argv.flatMap((a, i) => (a === '--include-directories' ? [argv[i + 1]] : []));

test('projects folder: auto-detected from two repositories, listed first; a chat belongs to the deepest folder', async () => {
  const a = (await h.api('POST', '/api/workspaces', { path: repoA })).body;
  assert.equal((await state()).workspaces.some((w) => w.kind === 'root'), false, 'one repository: no projects folder yet');
  await h.api('POST', '/api/workspaces', { path: repoB });
  const [first] = (await state()).workspaces;
  assert.deepEqual([first.kind, first.path, first.isGit, first.name], ['root', root, false, path.basename(root)]);
  const inRepo = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repoA })).body;
  const atRoot = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root })).body;
  assert.deepEqual([inRepo.workspaceId, atRoot.workspaceId], [a.id, first.id]);
  assert.equal((await state()).recentFolders[0], root);
});

test('folder browser: directories only, hidden ones on request, parent and roots; any folder as a workspace', async () => {
  const tree = path.join(root, 'дерево');
  const r = (await h.api('GET', `/api/fs/dirs?path=${encodeURIComponent(tree)}`)).body;
  assert.deepEqual([r.path, r.parent], [tree, root]);
  assert.deepEqual(r.entries, [{ name: 'видимая', path: path.join(tree, 'видимая') }]);
  assert.ok(r.roots.length > 0);
  const all = (await h.api('GET', `/api/fs/dirs?path=${encodeURIComponent(tree)}&hidden=1`)).body;
  assert.deepEqual(all.entries.map((e) => e.name).sort(), ['.скрытая', 'видимая'].sort());
  assert.equal((await h.api('GET', '/api/fs/dirs?path=relative')).status, 400);
  assert.equal((await h.api('GET', `/api/fs/dirs?path=${encodeURIComponent(path.join(root, 'нет'))}`)).status, 404);
  const home = (await h.api('GET', '/api/fs/dirs')).body;
  assert.ok(path.isAbsolute(home.path));

  const folder = (await h.api('POST', '/api/workspaces', { path: extra1, kind: 'folder' })).body;
  assert.deepEqual([folder.kind, folder.isGit], ['folder', false]);
  assert.equal((await state()).recentFolders[0], extra1);
  assert.equal((await h.api('POST', '/api/workspaces', { path: extra1, kind: 'weird' })).status, 400);
});

test('includeDirs: one --include-directories per folder in order, every turn; PATCH applies from the next turn', async () => {
  assert.equal((await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repoA, includeDirs: ['relative'] })).status, 400);
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repoA, includeDirs: [extra1, extra2, extra1, root], prompt: 'один' })).body;
  assert.deepEqual(s.includeDirs, [extra1, extra2], 'deduplicated, the cwd ancestor dropped');
  await waitFor(async () => runsOf(s.id).length === 1 && (await state()).sessions.find((x) => x.id === s.id).status === 'idle', { what: 'turn 1' });
  assert.deepEqual(dirsOf(runsOf(s.id)[0].argv), [extra1, extra2]);
  assert.deepEqual((await h.api('PATCH', `/api/sessions/${s.id}`, { includeDirs: [extra2] })).body.includeDirs, [extra2]);
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'два' });
  await waitFor(() => runsOf(s.id).length === 2, { what: 'turn 2' });
  assert.deepEqual(dirsOf(runsOf(s.id)[1].argv), [extra2]);
  assert.equal((await h.api('PATCH', `/api/sessions/${s.id}`, { includeDirs: 'x' })).status, 400);
});

test('a subtask worker sees the other subtasks\' repositories (their task worktree when it exists)', async () => {
  const st = await state();
  const wa = st.workspaces.find((w) => w.path === repoA);
  const wb = st.workspaces.find((w) => w.path === repoB);
  const parent = (await h.api('POST', '/api/tasks', { title: 'Общая фича' })).body;
  await h.api('PATCH', `/api/tasks/${parent.id}`, { includeDirs: [extra2] });
  const ta = (await h.api('POST', '/api/tasks', { title: 'Часть A', workspaceId: wa.id, parentId: parent.id })).body;
  const tb = (await h.api('POST', '/api/tasks', { title: 'Часть B', workspaceId: wb.id, parentId: parent.id })).body;
  // B already has its task worktree
  const wtB = (await h.api('POST', `/api/workspaces/${wb.id}/worktrees`, { name: 'feature/b-part' })).body;
  await h.api('PATCH', `/api/tasks/${tb.id}`, { branch: 'feature/b-part' });
  const worker = (await h.api('POST', `/api/tasks/${ta.id}/start`, { agent: 'mock' })).body;
  assert.ok(worker.id, JSON.stringify(worker));
  const s =(await state()).sessions.find((x) => x.id === worker.id);
  assert.deepEqual(s.includeDirs, [wtB.path, extra2]);
  await waitFor(() => runsOf(s.id).length === 1, { what: 'worker turn' });
  assert.deepEqual(dirsOf(runsOf(s.id)[0].argv), [wtB.path, extra2]);
  await h.api('POST', `/api/sessions/${s.id}/stop`);
  gitIn(repoB, 'worktree', 'list'); // the repo is still healthy
});

test('settings: workspaces { root, repos } with the resolved projects folder; saving moves it and broadcasts', async () => {
  const s = (await h.api('GET', '/api/settings')).body.workspaces;
  assert.deepEqual(s, { root: null, repos: [], rootResolved: root, rootAuto: true });
  assert.equal((await h.api('PUT', '/api/settings', { workspaces: { root: 'relative' } })).status, 400);
  assert.equal((await h.api('PUT', '/api/settings', { workspaces: { root: path.join(root, 'нет') } })).status, 400);
  assert.equal((await h.api('PUT', '/api/settings', { workspaces: { repos: 'x' } })).status, 400);
  const set = (await h.api('PUT', '/api/settings', { workspaces: { root: extra1 } })).body.workspaces;
  assert.deepEqual([set.root, set.rootResolved, set.rootAuto], [extra1, extra1, false]);
  assert.deepEqual((await state()).workspaces.filter((w) => w.kind === 'root').map((w) => w.path), [extra1]);
  const auto = (await h.api('PUT', '/api/settings', { workspaces: { root: null } })).body.workspaces;
  assert.deepEqual([auto.root, auto.rootResolved, auto.rootAuto], [null, root, true]);
  assert.equal((await state()).workspaces[0].path, root);
});

test('grouping: a chat in a sub-folder of a worktree belongs to that worktree; chats in the harness data folder are system', async () => {
  const wa = (await state()).workspaces.find((w) => w.path === repoA);
  const wt = (await h.api('POST', `/api/workspaces/${wa.id}/worktrees`, { name: 'feature/sub-dir' })).body;
  const sub = path.join(wt.path, 'sub', 'dir');
  fs.mkdirSync(sub, { recursive: true });
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: sub })).body;
  assert.deepEqual([s.worktreePath, s.workspaceId, s.system], [wt.path, wa.id, false]);
  const main = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: path.join(repoA) })).body;
  assert.deepEqual([main.worktreePath, main.workspaceId], [repoA, wa.id], 'the main worktree too');
  const own = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock' })).body; // <dataDir>/chats/<sid>
  assert.deepEqual([own.system, own.workspaceId, own.worktreePath], [true, null, null]);
  assert.ok((await state()).sessions.find((x) => x.id === own.id).system);
});
