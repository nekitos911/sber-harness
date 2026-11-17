// "Maximum auto-fill": task.suggestedWorkspaceId and typed, human task log entries.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startTestServer, makeRepo, tmpDir, rmrf, waitFor } from './helpers.js';

const root = tmpDir();
const payments = path.join(root, 'payments-service');
const ledger = path.join(root, 'ledger');
let h;

before(async () => {
  makeRepo(payments);
  makeRepo(ledger);
  h = await startTestServer();
});
after(async () => {
  await h.close();
  rmrf(root);
});

const task = async (id) => (await h.api('GET', '/api/state')).body.tasks.find((t) => t.id === id);
const create = async (fields) => (await h.api('POST', '/api/tasks', fields)).body;

test('suggestedWorkspaceId: the only repository, then name / -service stem matches, then the last repo of the space', async () => {
  const p = (await h.api('POST', '/api/workspaces', { path: payments })).body;
  const only = await create({ title: 'что-то' });
  assert.equal(only.suggestedWorkspaceId, p.id, 'one repository: it');
  assert.deepEqual(only.log.map((l) => [l.type, l.text]), [['created', 'Создана']]);

  const l = (await h.api('POST', '/api/workspaces', { path: ledger })).body;
  assert.equal((await create({ title: 'Ошибка в payments при возврате' })).suggestedWorkspaceId, p.id, 'stem of payments-service');
  assert.equal((await create({ title: 'ledger-service: отчёт' })).suggestedWorkspaceId, l.id, 'ledger-service -> ledger');
  assert.equal((await create({ title: 'Сверка', description: 'Расхождения в ledger за ноябрь' })).suggestedWorkspaceId, l.id, 'exact name in the description');
  const none = await create({ title: 'Обновить документацию' });
  assert.equal(none.suggestedWorkspaceId, null);
  const set = (await h.api('PATCH', `/api/tasks/${none.id}`, { workspaceId: l.id })).body;
  assert.equal(set.suggestedWorkspaceId, null, 'only while workspaceId is empty');

  // a task of space PROJ taken into work in payments-service -> the next PROJ task without a match suggests it
  const tracker = (t, key) => h.api('PATCH', `/api/tasks/${t.id}`, { externalId: key, source: 'onework' }).then((r) => r.body);
  const first = await tracker(await create({ title: 'Первая', workspaceId: p.id }), 'PROJ-1');
  const w = (await h.api('POST', `/api/tasks/${first.id}/start`, { agent: 'mock' })).body;
  assert.ok(w.id, JSON.stringify(w));
  const next = await tracker(await create({ title: 'Вторая' }), 'PROJ-2');
  assert.equal(next.suggestedWorkspaceId, p.id);

  // start without a workspace takes the suggestion and records it
  const s = (await h.api('POST', `/api/tasks/${next.id}/start`, { agent: 'mock' })).body;
  assert.equal(s.role, 'worker', JSON.stringify(s));
  const after = await task(next.id);
  assert.deepEqual([after.workspaceId, after.suggestedWorkspaceId], [p.id, null]);
  const started = after.log.find((x) => x.type === 'started');
  assert.match(started.text, /^Взята в работу: Mock agent \(demo\), ветка feature\/PROJ-2$/);
  assert.ok(!/s_[0-9a-f]{8}|[\\/]/.test(started.text.replace('feature/PROJ-2', '')), 'no session ids or paths in the text');
  for (const id of [w.id, s.id]) await h.api('POST', `/api/sessions/${id}/stop`);
  await waitFor(async () => (await h.api('GET', '/api/state')).body.sessions.every((x) => !x.pid), { what: 'stopped' });
});
