// Source control panel: line totals, staged flags, stage / unstage / discard, staged-only commit, commit + push.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, tmpDir, rmrf, makeRepo, gitIn, waitFor } from './helpers.js';

const root = tmpDir();
let h;
let repo;

before(async () => {
  repo = makeRepo(path.join(root, 'сервис'));
  const bare = path.join(root, 'origin.git');
  fs.mkdirSync(bare);
  gitIn(bare, 'init', '-q', '--bare');
  gitIn(repo, 'remote', 'add', 'origin', bare.split(path.sep).join('/'));
  h = await startTestServer({ integrations: { pr: { webUrlTemplate: 'https://code.example/sc/{project}/{repository}' } } });
});
after(async () => {
  await h.close();
  rmrf(root);
});

const status = async (cwd = repo) => (await h.api('GET', `/api/git/status?cwd=${encodeURIComponent(cwd)}`)).body;
const file = (st, p) => st.files.find((f) => f.path === p);
const post = (p, body) => h.api('POST', p, { cwd: repo, ...body });

test('status: added/removed per file (untracked lines count as added), totals, staged flags, webUrl', async () => {
  fs.writeFileSync(path.join(repo, 'README.md'), 'line 1\nновая\nещё\nline 3\n'); // +2 −1
  fs.writeFileSync(path.join(repo, 'новый файл.txt'), 'a\nb\nc\n');
  const st = await status();
  assert.deepEqual([file(st, 'README.md').added, file(st, 'README.md').removed, file(st, 'README.md').staged], [2, 1, false]);
  assert.deepEqual([file(st, 'новый файл.txt').added, file(st, 'новый файл.txt').removed, file(st, 'новый файл.txt').staged], [3, 0, false]);
  assert.deepEqual(st.totals, { added: 5, removed: 1 });
  assert.equal(st.webUrl, null, 'a local origin has no code host page');

  const web = makeRepo(path.join(root, 'веб'));
  gitIn(web, 'remote', 'add', 'origin', 'ssh://git@code.example:7998/PROJ/svc.git');
  assert.equal((await status(web)).webUrl, 'https://code.example/sc/PROJ/svc');
});

test('stage / unstage paths or all; a staged-only commit leaves the rest', async () => {
  assert.equal((await post('/api/git/stage', { paths: ['README.md'] })).status, 200);
  assert.equal(file(await status(), 'README.md').staged, true);
  assert.equal((await post('/api/git/unstage', { paths: ['README.md'] })).status, 200);
  assert.equal(file(await status(), 'README.md').staged, false);
  await post('/api/git/stage', { all: true });
  assert.ok((await status()).files.every((f) => f.staged));
  await post('/api/git/unstage', { all: true });
  assert.ok((await status()).files.every((f) => !f.staged));
  assert.equal((await post('/api/git/stage', { paths: ['../вне'] })).status, 400, 'outside cwd');
  assert.equal((await post('/api/git/stage', { paths: [] })).status, 400);

  await post('/api/git/stage', { paths: ['README.md'] });
  const r = await post('/api/git/commit', { message: 'только индекс', staged: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(gitIn(repo, 'show', '--name-only', '--format=', 'HEAD'), 'README.md');
  assert.deepEqual((await status()).files.map((f) => f.path), ['новый файл.txt'], 'the untracked file is not committed');
  assert.equal((await post('/api/git/commit', { message: 'пусто', staged: true })).status, 400, 'nothing staged');
});

test('discard: needs confirm; tracked back to HEAD, untracked and just-added files deleted; refused while an agent works there', async () => {
  fs.writeFileSync(path.join(repo, 'README.md'), 'испорчено\n');
  fs.writeFileSync(path.join(repo, 'добавлен.txt'), 'x\n');
  await post('/api/git/stage', { paths: ['добавлен.txt'] });
  const paths = ['README.md', 'новый файл.txt', 'добавлен.txt'];
  assert.equal((await post('/api/git/discard', { paths })).status, 400);
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: '#slow' })).body;
  await waitFor(async () => (await h.api('GET', '/api/state')).body.sessions.find((x) => x.id === s.id).status === 'running', { what: 'running' });
  assert.equal((await post('/api/git/discard', { paths, confirm: true })).status, 409);
  await h.api('POST', `/api/sessions/${s.id}/stop`);
  await waitFor(async () => !(await h.api('GET', '/api/state')).body.sessions.find((x) => x.id === s.id).pid, { what: 'stopped' });

  assert.equal((await post('/api/git/discard', { paths, confirm: true })).status, 200);
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), 'line 1\nновая\nещё\nline 3\n');
  assert.ok(!fs.existsSync(path.join(repo, 'новый файл.txt')) && !fs.existsSync(path.join(repo, 'добавлен.txt')));
  assert.deepEqual((await status()).files, []);
});

test('commit + push (harness): the commit, then the push to origin', async () => {
  fs.writeFileSync(path.join(repo, 'push.txt'), 'p\n');
  const r = await post('/api/git/commit', { message: 'с отправкой', push: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.hash, gitIn(repo, 'rev-parse', 'HEAD'));
  assert.equal(r.body.push.summary, 'Новая ветка develop в origin');
  assert.equal(gitIn(repo, 'rev-parse', '@{u}'), r.body.hash);
});
