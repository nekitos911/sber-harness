// Commit / push / PR through the agent (git.via "agent"): the agent runs git (the mock really does), the harness
// keeps the job open until that turn ends and checks the effect itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { startTestServer, tmpDir, rmrf, makeRepo, gitIn, waitFor } from './helpers.js';

const root = tmpDir();
let h;
let repo;
let sock;
const frames = [];

before(async () => {
  repo = makeRepo(path.join(root, 'сервис'));
  const bare = path.join(root, 'origin.git');
  fs.mkdirSync(bare);
  gitIn(bare, 'init', '-q', '--bare');
  gitIn(repo, 'remote', 'add', 'origin', bare.split(path.sep).join('/'));
  gitIn(repo, 'switch', '-q', '-c', 'feature/агент');
  h = await startTestServer();
  sock = new WebSocket(`${h.srv.url.replace('http', 'ws')}/ws?token=${h.srv.token}`);
  sock.on('message', (raw) => { const f = JSON.parse(raw); if (f.t === 'job') frames.push(f); });
  await new Promise((r) => sock.once('open', r));
});
after(async () => {
  sock.close();
  await h.close();
  rmrf(root);
});

let jobSeq = 0;
/** POST with a job id; → { body, end } where end resolves with the job's final frame. */
async function viaAgent(p, body) {
  const id = `job-git-agent-${String(++jobSeq).padStart(4, '0')}`;
  const r = await h.api('POST', p, { ...body, via: 'agent' }, { 'x-job-id': id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const end = waitFor(() => frames.find((f) => f.id === id && f.done), { timeout: 20000, what: `job ${id}` });
  return { body: r.body, end };
}
const head = () => gitIn(repo, 'rev-parse', 'HEAD');

test('commit through the agent: a «Коммит · <branch>» chat runs git with the exact message; the job ends with the hash', async () => {
  fs.writeFileSync(path.join(repo, 'a.txt'), 'один\n');
  const message = 'Добавлен файл a\n\nЗачем: проверка коммита через агента.';
  const { body, end } = await viaAgent('/api/git/commit', { cwd: repo, message });
  assert.equal(body.via, 'agent');
  assert.ok(body.job && body.sessionId);
  const done = await end;
  assert.equal(done.error, undefined, done.error);
  assert.deepEqual([done.result.ok, done.result.hash], [true, head()]);
  assert.equal(gitIn(repo, 'log', '-1', '--format=%B'), message);
  const chat = (await h.api('GET', '/api/state')).body.sessions.find((s) => s.id === body.sessionId);
  assert.deepEqual([chat.title, chat.gitChat], ['Коммит · feature/агент', true]);
  const asked = (await h.api('GET', `/api/sessions/${chat.id}/messages`)).body.find((m) => m.kind === 'user');
  assert.match(asked.text, /^Пользователь явно просит закоммитить изменения этого рабочего дерева\. Сообщение коммита \(утверждено пользователем, не меняй\):\nДобавлен файл a/);
  assert.match(asked.text, /RESULT: <хэш коммита> или RESULT: ERROR <причина>\.$/);

  fs.writeFileSync(path.join(repo, 'b.txt'), 'два\n');
  const again = await viaAgent('/api/git/commit', { cwd: repo, message: 'Второй коммит' });
  assert.equal(again.body.sessionId, body.sessionId, 'the same commit chat is reused');
  assert.equal((await again.end).result.hash, head());
});

test('push through the agent sets the upstream; the job ends with the branch', async () => {
  const { end } = await viaAgent('/api/git/push', { cwd: repo });
  const done = await end;
  assert.deepEqual([done.result.ok, done.result.branch], [true, 'origin/feature/агент']);
  assert.equal(gitIn(repo, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/feature/агент');
});

test('a failure ends the job with the error and notifies; via harness is unchanged', async () => {
  fs.writeFileSync(path.join(repo, 'c.txt'), 'три\n');
  const before = head();
  const { body, end } = await viaAgent('/api/git/commit', { cwd: repo, message: 'не выйдет #gitfail' });
  const done = await end;
  assert.match(done.error, /отказано/);
  assert.equal(head(), before);
  const n = await waitFor(async () => (await h.api('GET', '/api/state')).body.notifications.find((x) => x.kind === 'error' && x.sessionId === body.sessionId));
  assert.match(n.text, /^Коммит через агента не выполнен: /);

  const direct = await h.api('POST', '/api/git/commit', { cwd: repo, message: 'напрямую', via: 'harness' });
  assert.match(direct.body.hash, /^[0-9a-f]{40}$/);
  assert.equal((await h.api('POST', '/api/git/commit', { cwd: repo, message: 'x', via: 'кто-то' })).status, 400);
});

test("the task's worker in that folder gets the request (not a new chat)", async () => {
  const t = (await h.api('POST', '/api/tasks', { title: 'задача агента' })).body;
  const w = (await h.api('POST', `/api/tasks/${t.id}/assign`, { agent: 'mock', cwd: repo })).body;
  await waitFor(async () => { const s = (await h.api('GET', '/api/state')).body.sessions.find((x) => x.id === w.id); return s.status !== 'running' && !s.pid; }, { what: 'worker idle' });
  fs.writeFileSync(path.join(repo, 'd.txt'), 'четыре\n');
  const { body, end } = await viaAgent('/api/git/commit', { cwd: repo, message: `${t.id} работа агента` });
  assert.equal(body.sessionId, w.id);
  assert.equal((await end).result.hash, head());
});
