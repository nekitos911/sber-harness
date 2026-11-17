// Team board columns (tracker mapping, agent badge, opt-in tracker sync on move) and the harness review loop.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ROOT } from '../server/config.js';
import { createMcpManager } from '../server/mcp-client.js';
import { createStore } from '../server/store.js';
import { createBus } from '../server/bus.js';
import { createTasks } from '../server/tasks.js';
import { importTasks } from '../server/integrations/tasks.js';
import { startTestServer, makeRepo, tmpDir, rmrf, waitFor } from './helpers.js';

const dir = tmpDir();
const fixtures = path.join(dir, 'fixtures');
const log = path.join(dir, 'mcp-calls.jsonl');
const FIX = path.join(CODE_ROOT, 'test', 'fixtures');
const committed = JSON.parse(fs.readFileSync(path.join(CODE_ROOT, 'harness.config.json'), 'utf8'));
const onework = { transport: 'stdio', command: 'node', args: ['scripts/mock-mcp.js', '--fixtures', fixtures, '--server', 'onework'], env: { MOCK_MCP_LOG: log }, timeoutMs: 10000 };
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const tracker = { ...committed.integrations.tasks, enabled: true };
let repo;

before(() => {
  fs.mkdirSync(fixtures, { recursive: true });
  for (const f of fs.readdirSync(FIX)) if (f.startsWith('onework.')) fs.copyFileSync(path.join(FIX, f), path.join(fixtures, f));
  fs.renameSync(path.join(fixtures, 'onework.sbertrack_findIssues.json'), path.join(fixtures, 'onework.sbertrack_findIssues.0.json'));
  fs.writeFileSync(path.join(fixtures, 'onework.sbertrack_findIssues.1.json'), JSON.stringify({ content: [{ type: 'text', text: 'Found 1 issues (page 1, has_next: False)\n\n1. **PROJ-15001** — Отчёт [ift | high] @***' }] }));
  fs.writeFileSync(path.join(fixtures, 'onework.sbertrack_updateIssueStatus.json'), JSON.stringify({ content: [{ type: 'text', text: 'Status changed' }] }));
  repo = makeRepo(path.join(dir, 'репо'));
});
after(() => rmrf(dir));

test('import: tracker statuses land in the configured columns (board columns win over statusMap)', async () => {
  const config = { root: CODE_ROOT, dataDir: dir, mcpServersFrom: null, mcpServers: { onework }, board: committed.board, integrations: { tasks: { ...tracker, statusMap: { qa: 'todo' } } } };
  const store = createStore(path.join(dir, 'data-import'));
  const tasks = createTasks({ store, bus: createBus(), defaultBase: 'develop' });
  await importTasks({ config, mcp: createMcpManager(config), tasks });
  const by = Object.fromEntries(tasks.all().map((t) => [t.externalId, t.status]));
  assert.deepEqual(by, { 'PROJ-15430': 'todo', 'PROJ-14904': 'in_progress', 'PROJ-14932': 'review', 'PROJ-14933': 'review', 'PROJ-15001': 'review' });
  store.close();
});

test('moving a card syncs the tracker when enabled: transition by target status, explicit override, failures notified', async () => {
  const h = await startTestServer({ mcpServers: { onework }, integrations: { tasks: tracker }, board: { moveSyncsTracker: true } });
  try {
    const mk = async (key) => {
      const t = (await h.api('POST', '/api/tasks', { title: key, status: 'in_progress' })).body;
      return (await h.api('PATCH', `/api/tasks/${t.id}`, { externalId: key, source: 'onework' })).body;
    };
    const a = await mk('PROJ-14904');
    fs.rmSync(log, { force: true });
    assert.equal((await h.api('POST', `/api/tasks/${a.id}/move`, { status: 'review' })).body.status, 'review');
    const call = await waitFor(() => calls().find((c) => c.tool === 'sbertrack_updateIssueStatus'), { what: 'tracker transition' });
    assert.deepEqual(call.args, { key: 'PROJ-14904', transition: 'qa' }, 'the first transition whose target is a Тестирование status');

    await h.api('PUT', '/api/settings', { board: { columnTransitions: { review: 'ready_for_ift' } } });
    const b = await mk('PROJ-14932');
    fs.rmSync(log, { force: true });
    await h.api('POST', `/api/tasks/${b.id}/move`, { status: 'review' });
    assert.equal((await waitFor(() => calls().find((c) => c.tool === 'sbertrack_updateIssueStatus'))).args.transition, 'ready_for_ift');

    // "К работе" has trackerStatuses ["todo"]; no available transition leads there
    const moved = (await h.api('POST', `/api/tasks/${a.id}/move`, { status: 'todo' })).body;
    assert.equal(moved.status, 'todo', 'the board move stays');
    const warn = await waitFor(async () => (await h.api('GET', '/api/state')).body.tasks.find((t) => t.id === a.id).log.find((l) => l.text.startsWith('⚠ Трекер: не удалось (синхронизация')), { what: '⚠ log line' });
    assert.match(warn.text, /ни один переход трекера .* «К работе»/);
    assert.ok((await h.api('GET', '/api/state')).body.notifications.some((n) => n.taskId === a.id && n.kind === 'error'));
  } finally {
    await h.close();
  }
});

test('settings: board and orchestration read/write with validation', async () => {
  const h = await startTestServer();
  try {
    const s = (await h.api('GET', '/api/settings')).body;
    assert.deepEqual(s.board.columns.map((c) => c.label), ['К работе', 'В работе', 'Тестирование']);
    assert.deepEqual([s.board.onWorkerDone, s.board.moveSyncsTracker, s.orchestration.reviewMode, s.orchestration.review.maxRounds], ['stay', false, 'builtin', 2]);
    const bad = (body) => h.api('PUT', '/api/settings', body).then((r) => r.status);
    assert.equal(await bad({ board: { columns: [] } }), 400);
    assert.equal(await bad({ board: { columns: [{ status: 'todo', label: 'A' }, { status: 'todo', label: 'B' }] } }), 400);
    assert.equal(await bad({ board: { columns: [{ status: 'later', label: 'A' }] } }), 400);
    assert.equal(await bad({ board: { columns: [{ status: 'todo', label: ' ' }] } }), 400);
    assert.equal(await bad({ board: { onWorkerDone: 'done' } }), 400);
    assert.equal(await bad({ orchestration: { reviewMode: 'robots' } }), 400);
    assert.equal(await bad({ orchestration: { review: { maxRounds: 0 } } }), 400);
    const saved = (await h.api('PUT', '/api/settings', { board: { columns: [{ status: 'todo', label: 'Сделать' }, { status: 'done', label: 'Готово', trackerStatuses: ['done'] }] }, orchestration: { reviewMode: 'harness', review: { maxRounds: 3 } } })).body;
    assert.deepEqual(saved.board.columns, [{ status: 'todo', label: 'Сделать', trackerStatuses: [] }, { status: 'done', label: 'Готово', trackerStatuses: ['done'] }]);
    assert.deepEqual([saved.orchestration.reviewMode, saved.orchestration.review.maxRounds, saved.orchestration.review.grade], ['harness', 3, 'review']);
  } finally {
    await h.close();
  }
});

async function reviewRun(approveAt) {
  const h = await startTestServer({ orchestration: { reviewMode: 'harness', review: { promptTemplate: `#reviewer round={round} approve-at=${approveAt}`, maxRounds: 2 } } });
  const ws = (await h.api('POST', '/api/workspaces', { path: repo })).body;
  const t = (await h.api('POST', '/api/tasks', { title: 'Фикс #done', workspaceId: ws.id })).body;
  const worker = (await h.api('POST', `/api/tasks/${t.id}/start`, { agent: 'mock' })).body;
  return { h, t, worker };
}

test('harness review: round 1 changes requested -> the worker fixes -> round 2 approved', async () => {
  const { h, t, worker } = await reviewRun(2);
  try {
    const task = await waitFor(async () => {
      const x = (await h.api('GET', '/api/state')).body.tasks.find((y) => y.id === t.id);
      return x.agentState === 'approved' ? x : null;
    }, { timeout: 20000, what: 'approved' });
    assert.equal(task.review.round, 2);
    assert.equal(task.status, 'in_progress');
    const st = (await h.api('GET', '/api/state')).body;
    const reviewer = st.sessions.find((s) => s.role === 'reviewer');
    assert.deepEqual([reviewer.parentId, reviewer.approvalMode, reviewer.model, reviewer.title], [worker.id, 'plan', 'GLM-5.3-Flash-262k', `Ревью ${t.id}`]);
    assert.equal(st.sessions.filter((s) => s.role === 'reviewer').length, 1, 'round 2 re-uses the same reviewer chat');
    const workerMsgs = (await h.api('GET', `/api/sessions/${worker.id}/messages`)).body;
    assert.ok(workerMsgs.some((m) => m.kind === 'user' && /Ревью, раунд 1: есть замечания[\s\S]*HIGH/.test(m.text)), 'findings delivered to the worker');
    assert.ok(workerMsgs.some((m) => m.kind === 'system' && /APPROVED/.test(m.text)), 'informational message on approval');
    assert.ok(st.notifications.some((n) => n.taskId === t.id && /ревью пройдено/.test(n.text)));
    assert.ok(!st.tasks.some((x) => x.title.startsWith('Ревью')), 'no board task for the reviewer');
  } finally {
    await h.close();
  }
});

test('harness review: rounds exhausted -> notification, changes_requested', async () => {
  const { h, t } = await reviewRun(99);
  try {
    const n = await waitFor(async () => (await h.api('GET', '/api/state')).body.notifications.find((x) => x.taskId === t.id && /ревью не сошлось за 2/.test(x.text)), { timeout: 20000, what: 'exhaustion notification' });
    assert.equal(n.kind, 'failed');
    assert.equal((await h.api('GET', '/api/state')).body.tasks.find((x) => x.id === t.id).agentState, 'changes_requested');
  } finally {
    await h.close();
  }
});
