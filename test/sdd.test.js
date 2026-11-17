// /full-task support: SDD ledger/verdict viewer (+ WS polling), git.excludeFromCommit, model references check.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { readSdd, parseVerdict } from '../server/sdd.js';
import { scanModelRefs } from '../server/models.js';
import { startTestServer, makeRepo, tmpDir, rmrf, gitIn, waitFor } from './helpers.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sdd');
const root = tmpDir();
const repo = path.join(root, 'сервис лимитов');
const refs = path.join(root, 'агенты');
let h;

before(async () => {
  makeRepo(repo);
  fs.mkdirSync(refs);
  h = await startTestServer({
    agents: { mock: { modelsDiscovery: { prompt: '/models', maxAgeHours: 24 }, modelRefsScan: [path.join(refs, '*.md'), path.join(root, 'нет такой', '*.md')] } },
  });
});
after(async () => {
  await h.close();
  rmrf(root);
});

const copyFixtures = (cwd) => fs.cpSync(FIXTURES, path.join(cwd, '.superpowers', 'sdd'), { recursive: true });

test('parser: ledger items, PASS verdict with models, FAIL verdict in bold/arrow form, unknown status kept raw', async () => {
  const dir = path.join(root, 'plain');
  copyFixtures(dir);
  const { plans } = await readSdd(dir);
  assert.equal(plans.length, 1);
  const p = plans[0];
  assert.equal(p.name, '2026-11-17-limits');
  assert.deepEqual(p.progress.items.map((i) => i.status), ['done', 'done', 'pending', 'in_progress']);
  assert.equal(p.progress.items[1].title, 'Task 2: Убрать N+1 запрос в расчёте');
  const [v1, v2] = p.verdicts;
  assert.deepEqual([v1.n, v1.status, v1.filesChanged.length, v1.openQuestions], [1, 'PASS', 2, null]);
  assert.deepEqual(v1.commands[1], { cmd: 'mvn -q verify', result: 'BUILD SUCCESS' });
  assert.deepEqual([v1.implementerModel, v1.reviewerModel, v1.secondReviewModel], ['Qwen3.8-Flash-Next-262k', 'GLM-5.3-Flash-262k', 'Qwen3.6-35B-262k']);
  assert.deepEqual([v2.n, v2.status, v2.filesChanged, v2.secondReviewModel], [2, 'FAIL', ['src/main/java/demo/limits/LimitService.java'], null]);
  assert.deepEqual(v2.commands, [{ cmd: 'mvn -q test -Dtest=LimitServiceTest', result: '1 failure (expected 3 queries, got 4)' }]);
  assert.equal(v2.openQuestions, 'нужен ли батч-запрос для архивных лимитов?');
  const odd = parseVerdict('Вердикт: всё хорошо\nstatus: maybe\n');
  assert.deepEqual([odd.status, odd.filesChanged, odd.raw], [null, [], 'Вердикт: всё хорошо\nstatus: maybe\n']);
  assert.deepEqual(await readSdd(path.join(root, 'нет')), { plans: [] });
});

test('GET /api/sdd and a WS broadcast while a session in that folder runs', async () => {
  const cwd = path.join(root, 'чат');
  fs.mkdirSync(cwd);
  assert.deepEqual((await h.api('GET', `/api/sdd?cwd=${encodeURIComponent(cwd)}`)).body, { plans: [] });
  assert.equal((await h.api('GET', '/api/sdd')).status, 400);
  const ws = new WebSocket(`${h.srv.url.replace('http', 'ws')}/ws?token=${h.srv.token}`);
  const frames = [];
  ws.on('message', (raw) => {
    const f = JSON.parse(raw);
    if (f.t === 'sdd') frames.push(f);
  });
  await new Promise((r) => ws.once('open', r));
  try {
    const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd, prompt: '#silent' })).body;
    await waitFor(async () => (await h.api('GET', '/api/state')).body.sessions.find((x) => x.id === s.id).status === 'running');
    copyFixtures(cwd);
    const f = await waitFor(() => frames.at(-1), { timeout: 10000, what: 'sdd frame' });
    assert.equal(f.cwd, cwd);
    assert.deepEqual(f.plans[0].verdicts.map((v) => v.status), ['PASS', 'FAIL']);
    const viaApi = (await h.api('GET', `/api/sdd?cwd=${encodeURIComponent(cwd)}`)).body;
    assert.deepEqual(viaApi, JSON.parse(JSON.stringify({ plans: f.plans })));
    await h.api('POST', `/api/sessions/${s.id}/stop`);
  } finally {
    ws.close();
  }
});

test('git.excludeFromCommit: status marks .superpowers files, suggest and commit-all skip them', async () => {
  copyFixtures(repo);
  fs.writeFileSync(path.join(repo, 'Limits.java'), 'class Limits {}\n');
  gitIn(repo, 'add', '.superpowers/sdd/2026-11-17-limits/progress.md'); // staged earlier by someone: still skipped
  const q = `cwd=${encodeURIComponent(repo)}`;
  const st = (await h.api('GET', `/api/git/status?${q}`)).body;
  const service = st.files.filter((f) => f.service).map((f) => f.path);
  assert.equal(service.length, 3);
  assert.ok(service.every((p) => p.startsWith('.superpowers/')));
  assert.deepEqual(st.files.filter((f) => !f.service).map((f) => f.path), ['Limits.java']);
  const sug = (await h.api('GET', `/api/git/suggest?${q}`)).body;
  assert.ok(!sug.commit.body.includes('.superpowers'), sug.commit.body);
  assert.match(sug.commit.body, /- Limits\.java/);

  assert.equal((await h.api('POST', '/api/git/commit', { cwd: repo, message: 'T-1 лимиты' })).status, 200);
  assert.equal(gitIn(repo, 'show', '--name-only', '--format=', 'HEAD'), 'Limits.java');
  assert.equal(gitIn(repo, 'ls-tree', '-r', '--name-only', 'HEAD', '.superpowers'), '');
  const only = await h.api('POST', '/api/git/commit', { cwd: repo, message: 'x', paths: [service[0]] });
  assert.equal(only.status, 400);
});

test('modelRefs: frontmatter model and catalogue-family tokens checked against the discovered catalogue', async () => {
  fs.writeFileSync(path.join(refs, 'java-reviewer.md'), '---\nname: java-reviewer\nmodel: GLM-5.3-Flash\n---\nReview with care. Fallback: Qwen3.5-Old-128k. UTF-8, ISO-8601, PROJ-14904.\n');
  fs.writeFileSync(path.join(refs, 'explorer.md'), '---\nmodel: inherit\n---\nRead-only.\n');
  fs.writeFileSync(path.join(refs, 'notes.txt'), 'Qwen9-Unknown\n');
  const unknown = scanModelRefs([path.join(refs, '*.md')], [{ id: 'GLM-5.3-Flash-262k', available: null }]);
  assert.deepEqual(unknown.map((r) => [r.model, r.available]), [['GLM-5.3-Flash', null]], 'not discovered: unknown; Qwen is not a catalogue family here');
  await h.api('POST', '/api/agents/mock/models/refresh');
  const got = (await h.api('GET', '/api/agents/mock/info')).body.modelRefs;
  const file = path.join(refs, 'java-reviewer.md');
  assert.deepEqual(got, [
    { file, model: 'GLM-5.3-Flash', available: true }, // "-262k" suffix tolerated
    { file, model: 'Qwen3.5-Old-128k', available: false },
  ]);
});
