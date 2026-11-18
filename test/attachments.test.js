// A screenshot pasted into the composer is saved in the chat's own folder and readable by the CLI on the turn that
// mentions it; the folder picker can list files too («Файл с диска…»).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, makeRepo, tmpDir, rmrf, waitFor } from './helpers.js';

const root = tmpDir();
after(() => rmrf(root));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('paste a screenshot: saved for the chat, its folder joins the turn that mentions it, shown as a thumbnail', async () => {
  const repo = makeRepo(path.join(root, 'репо'));
  const argvFile = path.join(root, 'argv.ndjson');
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  const h = await startTestServer();
  try {
    const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: 'привет' })).body;
    await waitFor(async () => (await h.api('GET', '/api/state')).body.sessions.find((x) => x.id === s.id).status === 'idle', { what: 'idle' });
    const upload = (type, body) => fetch(`${h.srv.url}/api/sessions/${s.id}/attachments`, { method: 'POST', headers: { 'x-harness-token': h.srv.token, 'content-type': type }, body });

    const r = await upload('image/png', PNG);
    assert.equal(r.status, 200);
    const { path: shot } = await r.json();
    assert.ok(path.isAbsolute(shot) && shot.endsWith('.png') && fs.readFileSync(shot).equals(PNG));
    assert.ok(!shot.startsWith(repo), 'not inside the repository');
    assert.equal((await upload('text/plain', 'hi')).status, 415);
    assert.equal((await fetch(`${h.srv.url}/api/sessions/${s.id}/attachments`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG })).status, 401);
    assert.equal((await upload('image/png', PNG.subarray(0, 0))).status, 400);

    await h.api('POST', `/api/sessions/${s.id}/messages`, { text: `что на скриншоте? ${shot}` });
    const run = await waitFor(() => fs.existsSync(argvFile) && fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.env.HARNESS_SESSION_ID === s.id)[1], { what: 'second run' });
    const dirs = run.argv.flatMap((a, i) => (a === '--include-directories' ? [run.argv[i + 1]] : []));
    assert.ok(dirs.includes(path.dirname(shot)), `the attachments folder is readable: ${dirs}`);

    const raw = await fetch(`${h.srv.url}/api/fs/raw?cwd=${encodeURIComponent(repo)}&path=${encodeURIComponent(shot)}&token=${h.srv.token}`);
    assert.equal(raw.status, 200, 'its thumbnail is served');
  } finally {
    delete process.env.MOCK_AGENT_ARGV_FILE;
    await h.close();
  }
});

test('the folder picker lists files on request, folders first', async () => {
  const dir = path.join(root, 'выбор');
  fs.mkdirSync(path.join(dir, 'b-папка'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a-файл.txt'), 'x');
  const h = await startTestServer();
  try {
    const q = encodeURIComponent(dir);
    assert.deepEqual((await h.api('GET', `/api/fs/dirs?path=${q}`)).body.entries.map((e) => e.name), ['b-папка']);
    const withFiles = (await h.api('GET', `/api/fs/dirs?path=${q}&files=1`)).body.entries;
    assert.deepEqual(withFiles.map((e) => [e.name, !!e.file]), [['b-папка', false], ['a-файл.txt', true]]);
  } finally {
    await h.close();
  }
});
