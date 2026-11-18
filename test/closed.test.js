// Tracker statuses `created` / `closed` (onework on the target): created → «К работе», closed and never taken →
// hidden from the board, taken and then closed → done; the same rule on startup for tasks imported earlier.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ROOT } from '../server/config.js';
import { createMcpManager } from '../server/mcp-client.js';
import { createStore } from '../server/store.js';
import { createBus } from '../server/bus.js';
import { createTasks } from '../server/tasks.js';
import { importTasks, settleClosedTasks } from '../server/integrations/tasks.js';
import { tmpDir, rmrf } from './helpers.js';

const dir = tmpDir();
const fixtures = path.join(dir, 'fixtures');
const committed = JSON.parse(fs.readFileSync(path.join(CODE_ROOT, 'harness.config.json'), 'utf8'));
const config = {
  root: CODE_ROOT, dataDir: dir, mcpServersFrom: null, mcpSecretsFile: path.join(dir, 'none.txt'),
  mcpServers: { onework: { transport: 'stdio', command: 'node', args: ['scripts/mock-mcp.js', '--fixtures', fixtures, '--server', 'onework'], timeoutMs: 10000 } },
  board: committed.board,
  integrations: { tasks: { ...committed.integrations.tasks, enabled: true, space: 'PROJ', urlTemplate: '' } },
};
const listing = (rows) => fs.writeFileSync(path.join(fixtures, 'onework.sbertrack_findIssues.json'), JSON.stringify({ content: [{ type: 'text', text: [
  `Found ${rows.length} issues on this page (page 0, 100 per page, has_next: False)`, '',
  ...rows.map(([key, title, status], i) => `${i + 1}. **${key}** — ${title} [${status} | low] @***`),
].join('\n') }] }));

let store;
let tasks;
before(() => {
  fs.mkdirSync(fixtures, { recursive: true });
  store = createStore(path.join(dir, 'data'));
  tasks = createTasks({ store, bus: createBus(), defaultBase: 'develop' });
});
after(() => {
  store.close();
  rmrf(dir);
});

const byKey = (k) => tasks.all().find((t) => t.externalId === k);
const sync = () => importTasks({ config, mcp: createMcpManager(config), tasks });

test('created goes to «К работе»; a new closed issue is not imported', async () => {
  listing([['PROJ-1', 'Новая', 'created'], ['PROJ-2', 'Пока открыта', 'todo'], ['PROJ-3', 'Взята', 'development'], ['PROJ-4', 'Давно закрыта', 'closed']]);
  await sync();
  assert.deepEqual([byKey('PROJ-1').status, byKey('PROJ-2').status, byKey('PROJ-3').status], ['todo', 'todo', 'in_progress']);
  assert.equal(byKey('PROJ-4'), undefined);
});

test('closed later: never taken → hidden (once, logged); taken into work → done, not hidden', async () => {
  tasks.update(byKey('PROJ-3').id, { takenAt: Date.now(), status: 'review', statusManual: true }, 'harness'); // a hand-placed column
  listing([['PROJ-1', 'Новая', 'created'], ['PROJ-2', 'Пока открыта', 'closed'], ['PROJ-3', 'Взята', 'closed']]);
  await sync();
  const two = byKey('PROJ-2');
  const three = byKey('PROJ-3');
  assert.deepEqual([two.hidden, two.log.at(-1).text], [true, 'Закрыта в трекере — скрыта с доски']);
  assert.deepEqual([three.hidden, three.status, three.log.at(-1).text], [false, 'done', 'Закрыта в трекере — перенесена в «Готово»'], 'closing wins over a hand-placed column');
  const open = byKey('PROJ-1');
  tasks.update(open.id, { status: 'review', statusManual: true }, 'harness');
  await sync();
  assert.equal(byKey('PROJ-1').status, 'review', 'any other tracker status keeps the hand-placed column');
  const logs = two.log.length;
  await sync();
  assert.equal(byKey('PROJ-2').log.length, logs, 'hidden once');
});

test('startup pass: tasks imported before the rule are settled the same way', () => {
  const old = tasks.create({ title: 'старая закрытая', externalId: 'PROJ-9', source: 'onework', externalStatus: 'closed', status: 'todo' }, 'harness');
  const taken = tasks.create({ title: 'старая взятая', externalId: 'PROJ-10', source: 'onework', externalStatus: 'resolved', status: 'in_progress' }, 'harness');
  tasks.update(taken.id, { takenAt: Date.now() }, 'harness');
  assert.equal(settleClosedTasks(config, tasks), 2);
  assert.deepEqual([tasks.find(old.id).hidden, tasks.find(taken.id).status, tasks.find(taken.id).hidden], [true, 'done', false]);
  assert.equal(settleClosedTasks(config, tasks), 0, 'idempotent');
});
