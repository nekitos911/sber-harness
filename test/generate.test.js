// Commit / PR messages written by the agent: POST /api/git/generate (one-off helper run of the mock agent).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, tmpDir, rmrf, makeRepo, gitIn } from './helpers.js';
import { firstJson } from '../server/generate.js';

const root = tmpDir();
const argvFile = path.join(root, 'argv.ndjson');
let h;
let repo;
let plain;
let task;

before(async () => {
  repo = makeRepo(path.join(root, 'сервис'));
  plain = makeRepo(path.join(root, 'без задачи'));
  gitIn(repo, 'switch', '-q', '-c', 'feature/лимиты');
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  h = await startTestServer({ agents: { mock: { quickArgs: ['--safe-mode'] } } });
  const ws = (await h.api('POST', '/api/workspaces', { path: repo })).body;
  await h.api('POST', '/api/workspaces', { path: plain });
  task = (await h.api('POST', '/api/tasks', { title: 'Лимиты', workspaceId: ws.id })).body;
  await h.api('PATCH', `/api/tasks/${task.id}`, { branch: 'feature/лимиты' });
});
after(async () => {
  delete process.env.MOCK_AGENT_ARGV_FILE;
  await h.close();
  rmrf(root);
});

const helperRuns = () => fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => r.argv[r.argv.indexOf('-p') + 1]?.startsWith('HARNESS_GENERATE_MESSAGE'));
const change = (dir, text) => fs.writeFileSync(path.join(dir, 'README.md'), `# изменено\n${text}\n`);
const generate = (cwd, kind, headers) => h.api('POST', '/api/git/generate', { cwd, kind }, headers);

test('commit message: the agent writes it (plan mode, quick args, no chat); the task key prefix is kept', async () => {
  change(repo, 'новая строка');
  const before = (await h.api('GET', '/api/state')).body.sessions.length;
  const r = await generate(repo, 'commit');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.title, r.body.body], [`${task.id} PROJ-1 Тестовое сообщение`, 'Что и зачем.']);
  assert.equal(typeof r.body.ms, 'number');
  assert.equal((await h.api('GET', '/api/state')).body.sessions.length, before, 'no chat appears');
  // its own settings: no CLI chat record (GigaCode records every headless run otherwise), cwd in the helper folder
  const settings = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'chats', 'helper', 'generate', 'mock', 'settings.json'), 'utf8'));
  assert.equal(settings.chatRecording, false);
  const run = helperRuns().at(-1);
  assert.ok(run.argv.includes('--safe-mode'));
  assert.equal(run.argv[run.argv.indexOf('--approval-mode') + 1], 'plan');
  const prompt = run.argv[run.argv.indexOf('-p') + 1];
  assert.match(prompt, /Задача: .+ — Лимиты/);
  assert.match(prompt, /Diff:\n[\s\S]*новая строка/);
  assert.match(prompt, /Последние коммиты репозитория:/);

  change(plain, 'без ключа');
  assert.equal((await generate(plain, 'commit')).body.title, 'PROJ-1 Тестовое сообщение', 'no key: the title as written');
});

test('limits: commit title ≤ 72 chars, PR title ≤ 100 bytes and body ≤ min(bodyBytes, 300 chars), the key stays', async () => {
  change(repo, '#genlong');
  const c = (await generate(repo, 'commit')).body;
  assert.ok(Array.from(c.title).length <= 72 && c.title.startsWith(`${task.id} PROJ-1 Очень`), c.title);
  const p = (await generate(repo, 'pr')).body;
  assert.ok(Buffer.byteLength(p.title) <= 100 && p.title.startsWith(`${task.id} `), p.title);
  assert.ok(Array.from(p.body).length <= 300 && Buffer.byteLength(p.body) <= 512, `${p.body.length} chars`);
  const prompt = helperRuns().at(-1).argv.find((a) => a.startsWith('HARNESS_GENERATE_MESSAGE'));
  assert.match(prompt, /pull request из ветки feature\/лимиты/);
});

test('quick args that make the CLI fail before any output: one retry without them, remembered', async () => {
  change(plain, '#genfail');
  const n = helperRuns().length;
  const r = await generate(plain, 'commit');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const runs = helperRuns().slice(n);
  assert.deepEqual(runs.map((x) => x.argv.includes('--safe-mode')), [true, false]);
  await generate(plain, 'commit');
  assert.equal(helperRuns().at(-1).argv.includes('--safe-mode'), false, 'quickArgsBroken: not tried again');
});

test('an answer that is not JSON → 502 with the reason; nothing to commit → 400; suggest without a key is empty', async () => {
  change(plain, '#gengarbage');
  const r = await generate(plain, 'commit');
  assert.equal(r.status, 502);
  assert.match(r.body.error, /не написал сообщение: ответ не JSON: Не могу/);
  gitIn(plain, 'checkout', '--', '.');
  assert.equal((await generate(plain, 'commit')).status, 400);
  change(plain, 'что-то');
  const s = (await h.api('GET', `/api/git/suggest?cwd=${encodeURIComponent(plain)}`)).body;
  assert.deepEqual([s.key, s.commit.title, s.commit.body], [null, '', '']);
  assert.equal((await generate(plain, 'other')).status, 400);
  assert.deepEqual(firstJson('ok {"a": "}"} {"b":1}'), { a: '}' });
});
