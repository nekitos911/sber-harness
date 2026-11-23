// CLI session history: chats the agent CLI recorded itself are listed for a folder (by projectHash = sha256 of the path),
// shown read-only and continued as a harness chat that resumes the same CLI session.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { globDirs, parseHistoryFile, createHistory } from '../server/history.js';
import { WORKTREE_RULE } from '../server/orchestration.js';
import { startTestServer, makeRepo, tmpDir, rmrf, waitFor } from './helpers.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'history', 'HASH', 'chats');
const root = tmpDir();
const repo = path.join(root, 'лимиты');
const store = path.join(root, '.gigacode', 'tmp');
const argvFile = path.join(root, 'argv.ndjson');
const ID = '3f2a9c1e-7b4d-4e2a-9a51-0c6d2e8b1f00';
let h;

before(async () => {
  makeRepo(repo);
  // the fixture under <tmp>/<sha256(repo)>/chats, as the CLI would record it for this project
  const hash = createHash('sha256').update(path.resolve(repo)).digest('hex');
  const chats = path.join(store, hash, 'chats');
  fs.mkdirSync(chats, { recursive: true });
  for (const f of fs.readdirSync(FIX)) fs.writeFileSync(path.join(chats, f), fs.readFileSync(path.join(FIX, f), 'utf8').replace(/"HASH"/g, `"${hash}"`));
  fs.writeFileSync(path.join(chats, 'session-broken.json'), '{"something": "else"}');
  const other = path.join(store, 'f'.repeat(64), 'chats');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'session-other.jsonl'), `${JSON.stringify({ sessionId: 'other-1', type: 'user', content: 'чужой проект' })}\n`);
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  h = await startTestServer({ agents: { mock: { history: { dirs: [path.join(store, '*', 'chats')], command: null } } } });
});
after(async () => {
  delete process.env.MOCK_AGENT_ARGV_FILE;
  await h.close();
  rmrf(root);
});

test('reader: glob with * in a folder segment, JSON record, JSONL lines, unknown shape as raw', () => {
  assert.equal(globDirs(path.join(store, '*', 'chats')).length, 2);
  const jsonl = parseHistoryFile('x/abc/chats/s.jsonl', '{"sessionId":"s1","type":"user","content":"привет"}\n{"type":"gemini","content":"ответ"}\n');
  assert.deepEqual([jsonl.id, jsonl.messages.length], ['s1', 2]);
  const raw = parseHistoryFile('x/abc/chats/odd.json', 'not json at all {');
  assert.deepEqual([raw.raw, raw.id, raw.projectHash], [true, 'odd', 'abc']);
});

test('GET /api/history lists this folder\'s CLI sessions (projectHash = sha256 of the path), not other projects\'', async () => {
  const list = (await h.api('GET', `/api/history?cwd=${encodeURIComponent(repo)}`)).body;
  const rec = list.find((x) => x.id === ID);
  assert.deepEqual([rec.agent, rec.messages, rec.model, rec.linkedSessionId], ['mock', 3, 'Qwen3.8-Flash-Next', null]);
  assert.equal(rec.title, 'Почини расчёт лимитов в LimitService: N+1 запрос к справочнику');
  assert.equal(rec.updatedAt, Date.parse('2026-11-17T09:14:41.877Z'));
  assert.ok(list.some((x) => x.raw && x.id === 'session-broken'), 'an unknown shape is listed raw');
  assert.ok(!list.some((x) => x.id === 'other-1'));
});

test('messages map to transcript shapes: user, thought, assistant, tool (CLI info events skipped)', async () => {
  const msgs = (await h.api('GET', `/api/history/mock/${ID}/messages`)).body;
  assert.deepEqual(msgs.map((m) => m.kind), ['user', 'thought', 'assistant', 'tool']);
  assert.equal(msgs[1].text, 'Где цикл: calculate() вызывает dictionary.get() для каждой строки');
  assert.deepEqual([msgs[3].tool.name, msgs[3].tool.input, msgs[3].tool.output, msgs[3].tool.status], ['ReadFile', { absolute_path: 'src/main/java/demo/limits/LimitService.java' }, 'class LimitService { ... }', 'ok']);
  const raw = (await h.api('GET', '/api/history/mock/session-broken/messages')).body;
  assert.match(raw[0].text, /^Нераспознанный формат истории/);
  assert.equal((await h.api('GET', '/api/history/mock/nope/messages')).status, 404);
});

test('continue: a harness chat with the imported transcript; the next message resumes that CLI session', async () => {
  const s = (await h.api('POST', `/api/history/mock/${ID}/continue`, { cwd: repo })).body;
  assert.deepEqual([s.externalSessionId, s.cwd, s.agent], [ID, repo, 'mock']);
  const past = (await h.api('GET', `/api/sessions/${s.id}/messages`)).body;
  assert.ok(past.length >= 4 && past.every((m) => m.imported));
  assert.equal((await h.api('POST', `/api/history/mock/${ID}/continue`, { cwd: repo })).body.id, s.id, 'the linked chat is reused');
  assert.equal((await h.api('GET', `/api/history?cwd=${encodeURIComponent(repo)}`)).body.find((x) => x.id === ID).linkedSessionId, s.id);

  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'продолжай' });
  await waitFor(async () => (await h.api('GET', `/api/sessions/${s.id}/messages`)).body.some((m) => m.kind === 'assistant' && m.text.includes(`resumed ${ID}`)), { what: 'resumed turn' });
  const run = fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.env.HARNESS_SESSION_ID === s.id);
  assert.deepEqual(run.argv.slice(run.argv.indexOf('--resume'), run.argv.indexOf('--resume') + 4), ['--resume', ID, '-p', `продолжай\n\n${WORKTREE_RULE}`]);
  await waitFor(async () => (await h.api('GET', '/api/state')).body.sessions.find((x) => x.id === s.id).status === 'idle', { what: 'idle' });
});

test('listing reads only this project\'s chats folders (others: an mtime-cached index), asynchronously', async () => {
  const history = createHistory({ agents: { mock: { history: { dirs: [path.join(store, '*', 'chats')] } } } });
  const reads = [];
  const orig = fs.promises.readFile;
  fs.promises.readFile = (file, ...rest) => { reads.push(path.basename(String(file))); return orig(file, ...rest); };
  try {
    const first = await history.list([path.resolve(repo)], () => null);
    assert.ok(first.some((x) => x.id === ID));
    reads.length = 0;
    // another project's chat changes (its folder mtime does not): not read again for this project
    const other = path.join(store, 'f'.repeat(64), 'chats', 'session-other.jsonl');
    fs.writeFileSync(other, `${JSON.stringify({ sessionId: 'other-1', type: 'user', content: 'чужой проект, ещё' })}\n`);
    fs.utimesSync(other, new Date(), new Date(Date.now() + 5000));
    await history.list([path.resolve(repo)], () => null);
    assert.ok(!reads.includes('session-other.jsonl'), reads.join(', '));
  } finally {
    fs.promises.readFile = orig;
  }
});
