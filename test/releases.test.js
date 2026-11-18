// «релиз 54» / «1.54.1» / «rel154» / «только в релиз 54» → release branches of the repositories; the task's targets and
// the agent's note follow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, tmpDir, rmrf, makeRepo, gitIn, waitFor } from './helpers.js';

const root = tmpDir();
const projects = path.join(root, 'проекты');
let h;
let repo;
let ws;

before(async () => {
  repo = makeRepo(path.join(projects, 'сервис'));
  for (const b of ['release/1.53.0', 'release/1.54.0', 'release/1.54.1']) gitIn(repo, 'branch', b);
  h = await startTestServer({ workspaces: { root: projects }, git: { defaultBase: 'develop' } });
  ws = (await h.api('POST', '/api/workspaces', { path: repo })).body;
});
after(async () => {
  await h.close();
  rmrf(root);
});

const resolve = async (text, wsId) => (await h.api('GET', `/api/releases/resolve?text=${encodeURIComponent(text)}${wsId ? `&workspaceId=${wsId}` : ''}`)).body;
const firstUser = (sid) => waitFor(async () => (await h.api('GET', `/api/sessions/${sid}/messages`)).body.find((m) => m.kind === 'user'), { what: 'first message' });
const settle = (sid) => waitFor(async () => { const s = (await h.api('GET', '/api/state')).body.sessions.find((x) => x.id === sid); return !s.pid && s.status !== 'running' && !s.turnClosing; }, { what: 'settled' });

test('resolve: «релиз 54» = the newest 1.54.x, an exact version, rel154, «только в релиз», unknown → null', async () => {
  const r = await resolve('поправь в релиз 54', ws.id);
  assert.deepEqual(r.refs.map((x) => [x.phrase, x.version, x.branch, x.candidates]), [['релиз 54', '54', 'release/1.54.1', ['release/1.54.1', 'release/1.54.0']]]);
  assert.deepEqual(r.refs[0].repos, [ws.name]);
  assert.equal((await resolve('release 1.54.0')).refs[0].branch, 'release/1.54.0', 'exact; every repository when no workspace');
  assert.deepEqual([(await resolve('rel154')).refs[0].version, (await resolve('rel154')).refs[0].branch], ['1.54', 'release/1.54.1']);
  assert.equal((await resolve('только в релиз 54')).onlyRelease, true);
  assert.equal((await resolve('релиз 99')).refs[0].branch, null);
  assert.deepEqual((await resolve('без релиза')).refs, []);
});

test('start with «в релиз 54»: targets develop + the release, the agent gets the targets line; unknown release → warning', async () => {
  const t = (await h.api('POST', '/api/tasks', { title: 'Хотфикс', workspaceId: ws.id })).body;
  const s = (await h.api('POST', `/api/tasks/${t.id}/start`, { agent: 'mock', notes: 'нужно и в релиз 54' })).body;
  assert.deepEqual((await h.api('GET', '/api/state')).body.tasks.find((x) => x.id === t.id).targets, ['develop', 'release/1.54.1']);
  const first = (await firstUser(s.id)).text;
  assert.match(first, /Целевые ветки: develop и release\/1\.54\.1 \(из «релиз 54»\)\. Изменения нужны в обе: основная работа в develop, перенос в релиз — отдельной веткой feature\/.+-rel154 → PR в release\/1\.54\.1\./);
  await settle(s.id);

  const t2 = (await h.api('POST', '/api/tasks', { title: 'Другая', workspaceId: ws.id })).body;
  const s2 = (await h.api('POST', `/api/tasks/${t2.id}/start`, { agent: 'mock', notes: 'в релиз 99' })).body;
  assert.equal(s2.releaseWarning, 'ветка релиза 99 не найдена');
  assert.deepEqual((await h.api('GET', '/api/state')).body.tasks.find((x) => x.id === t2.id).targets, ['develop']);
  await settle(s2.id);
});

test('handoff: «только в релиз 54» → only the release line; explicit targets override the text', async () => {
  const r = (await h.api('POST', '/api/handoff', { input: 'поправь расчёт, только в релиз 54' })).body;
  assert.match((await firstUser(r.session.id)).text, /Целевая ветка: release\/1\.54\.1 \(из «релиз 54»\)\. Изменения нужны только в релиз\./);
  await settle(r.session.id);
  const e = (await h.api('POST', '/api/handoff', { input: 'поправь в релиз 54', targets: ['develop', 'release/1.53.0'] })).body;
  assert.match((await firstUser(e.session.id)).text, /Целевые ветки: develop и release\/1\.53\.0\. /);
  await settle(e.session.id);
});

test('GET /api/releases: release branches newest first, deduped across repositories, limited', async () => {
  const other = makeRepo(path.join(projects, 'второй'));
  gitIn(other, 'branch', 'release/1.54.1');
  await h.api('POST', '/api/workspaces', { path: other });
  const all = (await h.api('GET', '/api/releases')).body;
  assert.deepEqual(all.map((r) => [r.branch, r.version]), [['release/1.54.1', '1.54.1'], ['release/1.54.0', '1.54.0'], ['release/1.53.0', '1.53.0']]);
  assert.deepEqual(all[0].repos.sort(), [ws.name, 'второй'].sort());
  assert.deepEqual((await h.api('GET', `/api/releases?workspaceId=${ws.id}&limit=2`)).body.map((r) => r.branch), ['release/1.54.1', 'release/1.54.0']);
  assert.equal((await h.api('GET', '/api/releases?limit=0')).status, 400);
});
