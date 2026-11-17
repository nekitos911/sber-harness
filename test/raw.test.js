// Images for chat thumbnails (GET /api/fs/raw) and large tool outputs (truncated list, full text on demand).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, tmpDir, rmrf, waitFor } from './helpers.js';

const root = tmpDir();
const cwd = path.join(root, 'чат');
const extra = path.join(root, 'доп');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
let h;
let s;

before(async () => {
  fs.mkdirSync(path.join(cwd, 'img'), { recursive: true });
  fs.mkdirSync(extra);
  fs.writeFileSync(path.join(cwd, 'img', 'скрин 1.png'), PNG);
  fs.writeFileSync(path.join(cwd, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'text');
  fs.writeFileSync(path.join(extra, 'diagram.png'), PNG);
  fs.writeFileSync(path.join(root, 'outside.png'), PNG);
  h = await startTestServer();
  s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd, includeDirs: [extra], prompt: '#bigoutput' })).body;
});
after(async () => {
  await h.close();
  rmrf(root);
});

const raw = (p, headers = {}, token = h.srv.token) => fetch(`${h.srv.url}/api/fs/raw?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(p)}${token ? `&token=${token}` : ''}`, { headers });

test('fs/raw: images inside the session folder or its extra folders, ?token= auth, cache validation, svg sandboxed', async () => {
  const r = await raw('img/скрин 1.png');
  assert.equal(r.status, 200);
  assert.deepEqual([r.headers.get('content-type'), r.headers.get('x-content-type-options')], ['image/png', 'nosniff']);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
  const again = await raw('img/скрин 1.png', { 'if-none-match': r.headers.get('etag') });
  assert.equal(again.status, 304);

  const svg = await raw('logo.svg');
  assert.deepEqual([svg.status, svg.headers.get('content-type'), svg.headers.get('content-security-policy')], [200, 'image/svg+xml', 'sandbox']);
  assert.equal((await raw(path.join(extra, 'diagram.png'))).status, 200, 'absolute path inside includeDirs');

  assert.equal((await raw('notes.txt')).status, 400, 'not an image type');
  assert.equal((await raw('../outside.png')).status, 400, 'outside the folders');
  assert.equal((await raw(path.join(root, 'outside.png'))).status, 400, 'absolute path outside');
  assert.equal((await raw('img/нет.png')).status, 404);
  assert.equal((await raw('img/скрин 1.png', {}, '')).status, 401);
});

test('a tool output over 64 KB is truncated in the message list; the full text comes from /output', async () => {
  const msg = await waitFor(async () => (await h.api('GET', `/api/sessions/${s.id}/messages`)).body.find((m) => m.kind === 'tool' && m.tool.id === 'big_1' && m.tool.status === 'ok'), { what: 'big tool output' });
  assert.equal(msg.tool.outputTruncated, true);
  assert.equal(msg.tool.output.length, 64 * 1024);
  const full = (await h.api('GET', `/api/sessions/${s.id}/messages/${msg.id}/output`)).body.output;
  assert.ok(full.endsWith('КОНЕЦ') && full.length > 64 * 1024);
  const small = (await h.api('GET', `/api/sessions/${s.id}/messages`)).body.find((m) => m.kind === 'tool' && m.tool.id === 'fake_1');
  assert.equal(small.tool.outputTruncated, undefined);
  assert.equal((await h.api('GET', `/api/sessions/${s.id}/messages/m_nope/output`)).status, 404);
});
