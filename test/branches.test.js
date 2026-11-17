// GET /api/git/branches + POST /api/git/checkout with real git (temp dirs with Cyrillic letters and spaces).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, makeRepo, tmpDir, rmrf, gitIn, waitFor } from './helpers.js';

const root = tmpDir();
const repo = path.join(root, 'сервис репо');
const elsewhere = path.join(root, 'другой worktree');
let h;

const commit = (cwd, file, text, msg) => {
  fs.writeFileSync(path.join(cwd, file), text);
  gitIn(cwd, 'add', '-A');
  gitIn(cwd, 'commit', '-q', '-m', msg);
};

before(async () => {
  makeRepo(repo);
  const origin = path.join(root, 'origin.git');
  gitIn(root, 'init', '-q', '--bare', origin);
  gitIn(repo, 'remote', 'add', 'origin', origin);
  gitIn(repo, 'push', '-q', '-u', 'origin', 'develop');
  gitIn(repo, 'switch', '-q', '-c', 'feature/remote-only');
  commit(repo, 'remote.txt', 'r\n', 'remote work');
  gitIn(repo, 'push', '-q', 'origin', 'feature/remote-only');
  gitIn(repo, 'switch', '-q', 'develop');
  gitIn(repo, 'branch', '-q', '-D', 'feature/remote-only');
  gitIn(repo, 'switch', '-q', '-c', 'feature/local');
  commit(repo, 'local.txt', 'l\n', 'local work');
  gitIn(repo, 'switch', '-q', '-c', 'feature/conflict', 'develop');
  commit(repo, 'README.md', 'other\n', 'conflicting readme');
  gitIn(repo, 'switch', '-q', 'develop');
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'feature/elsewhere', elsewhere);
  h = await startTestServer();
});
after(async () => {
  await h.close();
  rmrf(root);
});

const q = encodeURIComponent(repo);
const state = async () => (await h.api('GET', '/api/state')).body;

test('branches: local first with upstream and worktree, then origin-only ones', async () => {
  const { current, branches } = (await h.api('GET', `/api/git/branches?cwd=${q}`)).body;
  assert.equal(current, 'develop');
  const by = Object.fromEntries(branches.map((b) => [b.name, b]));
  assert.deepEqual(Object.keys(by).sort(), ['develop', 'feature/conflict', 'feature/elsewhere', 'feature/local', 'feature/remote-only']);
  assert.deepEqual([by.develop.current, by.develop.remote, by.develop.upstream], [true, false, 'origin/develop']);
  assert.equal(path.resolve(by.develop.worktree), path.resolve(repo));
  assert.equal(path.resolve(by['feature/elsewhere'].worktree), path.resolve(elsewhere));
  assert.deepEqual([by['feature/remote-only'].remote, by['feature/remote-only'].upstream, by['feature/remote-only'].worktree], [true, 'origin/feature/remote-only', null]);
  assert.equal(branches.at(-1).name, 'feature/remote-only', 'remote-only branches come last');
  assert.ok(by['feature/local'].lastCommitAt > 0);
});

test('checkout: create from, track a remote-only branch, refuse busy branches/folders, git errors as 400', async () => {
  const chat = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo })).body;

  const created = await h.api('POST', '/api/git/checkout', { cwd: repo, branch: 'feature/new', create: true, from: 'feature/local' });
  assert.deepEqual(created.body, { branch: 'feature/new' });
  assert.equal(gitIn(repo, 'rev-parse', 'HEAD'), gitIn(repo, 'rev-parse', 'feature/local'));
  await waitFor(async () => (await state()).sessions.find((s) => s.id === chat.id).branch === 'feature/new', { what: 'session.branch refreshed' });

  assert.deepEqual((await h.api('POST', '/api/git/checkout', { cwd: repo, branch: 'origin/feature/remote-only' })).body, { branch: 'feature/remote-only' });
  assert.equal(gitIn(repo, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/feature/remote-only');

  const taken = await h.api('POST', '/api/git/checkout', { cwd: repo, branch: 'feature/elsewhere' });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /another worktree/);

  assert.equal((await h.api('POST', '/api/git/checkout', { cwd: repo, branch: 'develop' })).status, 200);
  fs.writeFileSync(path.join(repo, 'README.md'), 'dirty change\n');
  const dirty = await h.api('POST', '/api/git/checkout', { cwd: repo, branch: 'feature/conflict' });
  assert.equal(dirty.status, 400);
  assert.match(dirty.body.error, /overwritten|README\.md/);
  gitIn(repo, 'checkout', '--', 'README.md');

  assert.equal((await h.api('POST', '/api/git/checkout', { cwd: repo, branch: 'nope/missing' })).status, 404);
  assert.equal((await h.api('POST', '/api/git/checkout', { cwd: repo, branch: 'bad..name' })).status, 400);

  await h.api('POST', `/api/sessions/${chat.id}/messages`, { text: '#silent' });
  await waitFor(async () => (await state()).sessions.find((s) => s.id === chat.id).status === 'running');
  const busy = await h.api('POST', '/api/git/checkout', { cwd: repo, branch: 'feature/local' });
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /agent is working/);
  await h.api('POST', `/api/sessions/${chat.id}/stop`);
  await waitFor(async () => (await state()).sessions.find((s) => s.id === chat.id).pid === null);
});
