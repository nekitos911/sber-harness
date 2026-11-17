// "Nothing looks frozen": git never waits for a prompt or a dead remote, long operations report progress (x-job-id),
// transcript flushes stay cheap.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { createStore } from '../server/store.js';
import { startTestServer, makeRepo, tmpDir, rmrf, gitIn, waitFor } from './helpers.js';

const root = tmpDir();
const repo = path.join(root, 'репо');
let h;
const servers = [];
const sockets = []; // every connection to the fake remotes, destroyed on teardown even if a test fails

before(async () => {
  makeRepo(repo);
  gitIn(repo, 'config', 'credential.helper', ''); // no credential manager of this machine in the test
  h = await startTestServer({ git: { networkTimeoutSec: 2 } });
});
after(async () => {
  for (const s of sockets) s.destroy();
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
  await h.close();
  rmrf(root);
});

const listen = (srv) => new Promise((resolve) => {
  srv.on('connection', (s) => { s.on('error', () => {}); sockets.push(s); });
  srv.listen(0, '127.0.0.1', () => { servers.push(srv); resolve(srv.address().port); });
});

test('push to a remote that never answers fails after git.networkTimeoutSec with a clear message', async () => {
  const port = await listen(net.createServer(() => {})); // accepts, never answers
  gitIn(repo, 'remote', 'add', 'origin', `http://127.0.0.1:${port}/repo.git`);
  const t0 = Date.now();
  const r = await h.api('POST', '/api/git/push', { cwd: repo });
  assert.deepEqual([r.status, r.body.error], [504, 'Нет ответа от удалённого репозитория за 2 с']);
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
  gitIn(repo, 'remote', 'remove', 'origin');
});

test('push that needs credentials fails at once instead of waiting for a prompt', async () => {
  const port = await listen(http.createServer((req, res) => {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' });
    res.end();
  }));
  gitIn(repo, 'remote', 'add', 'origin', `http://127.0.0.1:${port}/repo.git`);
  const r = await h.api('POST', '/api/git/push', { cwd: repo });
  assert.equal(r.status, 401, JSON.stringify(r.body));
  assert.match(r.body.error, /^Git требует авторизацию — выполните push в терминале этого рабочего дерева/);
  gitIn(repo, 'remote', 'remove', 'origin');
});

test('x-job-id: taking a task into work reports its steps over WS and ends with done', async () => {
  const ws = (await h.api('POST', '/api/workspaces', { path: repo })).body;
  const task = (await h.api('POST', '/api/tasks', { title: 'Прогресс', workspaceId: ws.id })).body;
  const sock = new WebSocket(`${h.srv.url.replace('http', 'ws')}/ws?token=${h.srv.token}`);
  const frames = [];
  sock.on('message', (raw) => { const f = JSON.parse(raw); if (f.t === 'job') frames.push(f); });
  await new Promise((r) => sock.once('open', r));
  try {
    const r = await h.api('POST', `/api/tasks/${task.id}/start`, { agent: 'mock' }, { 'x-job-id': 'job-start-0001' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitFor(() => frames.some((f) => f.done), { what: 'final job frame' });
    assert.ok(frames.every((f) => f.id === 'job-start-0001' && f.title === 'Взять в работу'));
    assert.deepEqual(frames.filter((f) => f.step).map((f) => f.step), ['Проверка агента', 'Создание worktree', 'Запуск сессии']);
    assert.equal(frames.at(-1).error, undefined);
    const bad = await h.api('POST', '/api/tasks/T-404/start', {}, { 'x-job-id': 'job-start-0002' });
    assert.equal(bad.status, 404);
    await waitFor(() => frames.some((f) => f.id === 'job-start-0002' && f.done && f.error), { what: 'failed job frame' });
    await h.api('POST', `/api/sessions/${r.body.id}/stop`);
  } finally {
    sock.close();
  }
});

test('perf: flushing a 5k-message transcript after one more message stays cheap', () => {
  const dir = tmpDir();
  try {
    const store = createStore(dir);
    for (let i = 0; i < 5000; i++) store.putMessage('s_big', { id: `m${i}`, kind: i % 2 ? 'assistant' : 'user', text: `сообщение ${i} `.repeat(20), at: i });
    store.flush();
    const times = [];
    for (let i = 0; i < 5; i++) {
      const msg = { id: `extra${i}`, kind: 'assistant', text: 'x', at: Date.now() };
      store.putMessage('s_big', msg);
      msg.text += ' streaming';
      store.putMessage('s_big', msg);
      const t0 = performance.now();
      store.flush();
      times.push(performance.now() - t0);
    }
    const worst = Math.max(...times);
    console.log(`transcript flush (5k messages): ${times.map((t) => t.toFixed(1)).join(' / ')} ms`);
    assert.ok(worst < 500, `flush took ${worst} ms`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'transcripts', 's_big.json'), 'utf8')).length, 5005);
    store.close();
  } finally {
    rmrf(dir);
  }
});
