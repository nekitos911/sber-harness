// Target-machine integrations against the reconstructed fixtures (test/fixtures/README.md), served by
// scripts/mock-mcp.js --fixtures: onework (markdown tracker), sourcecontrol (PRs), MCP config formats and secrets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ROOT } from '../server/config.js';
import { createMcpManager, serverDefs, toolResultValue } from '../server/mcp-client.js';
import { createStore } from '../server/store.js';
import { createBus } from '../server/bus.js';
import { createTasks } from '../server/tasks.js';
import { importTasks, importIssue, getExternal, getTransitions, transitionTask, importChildren, parseFindIssues, parseIssueMeta } from '../server/integrations/tasks.js';
import { createPullRequest, prStatus, refreshTaskPr, declinePullRequest, mergePullRequest } from '../server/integrations/pr.js';
import { sessionSettings } from '../server/launchers.js';
import * as git from '../server/git.js';
import { tmpDir, rmrf, makeRepo, gitIn, startTestServer } from './helpers.js';

const dir = tmpDir();
const fixtures = path.join(dir, 'fixtures');
const log = path.join(dir, 'mcp-calls.jsonl');
const FIX = path.join(CODE_ROOT, 'test', 'fixtures');
const committed = JSON.parse(fs.readFileSync(path.join(CODE_ROOT, 'harness.config.json'), 'utf8'));
const stub = (server) => ({ transport: 'stdio', command: 'node', args: ['scripts/mock-mcp.js', '--fixtures', fixtures, '--server', server], env: { MOCK_MCP_LOG: log }, timeoutMs: 10000 });
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const text = (t) => JSON.stringify({ content: [{ type: 'text', text: t }] });

function config(extraTasks = {}) {
  return {
    root: CODE_ROOT,
    dataDir: dir,
    mcpServersFrom: null,
    mcpSecretsFile: path.join(dir, 'none.txt'),
    mcpServers: { onework: stub('onework'), sourcecontrol: stub('sourcecontrol') },
    git: committed.git,
    integrations: {
      tasks: { ...committed.integrations.tasks, enabled: true, urlTemplate: 'https://tracker.example/swtr/units/all/unit/{key}', ...extraTasks },
      pr: { ...committed.integrations.pr, enabled: true },
    },
  };
}

let store;
let tasks;
before(() => {
  fs.mkdirSync(fixtures, { recursive: true });
  for (const f of fs.readdirSync(FIX)) if (/^(onework|sourcecontrol)\./.test(f)) fs.copyFileSync(path.join(FIX, f), path.join(fixtures, f));
  // page 0 is the committed fixture (has_next: True); page 1 ends the listing
  fs.renameSync(path.join(fixtures, 'onework.sbertrack_findIssues.json'), path.join(fixtures, 'onework.sbertrack_findIssues.0.json'));
  fs.writeFileSync(path.join(fixtures, 'onework.sbertrack_findIssues.1.json'), text([
    'Found 2 issues on this page (page 1, 100 per page, has_next: False)',
    '',
    '1. **PROJ-15001** — Новый отчёт [ift | high] @***',
    '2. **PROJ-15002** — Отменённая [cancelled | low] @***',
  ].join('\n')));
  fs.copyFileSync(path.join(FIX, 'onework.tool-error.json'), path.join(fixtures, 'onework.sbertrack_getIssue.PROJ-99001.json'));
  fs.writeFileSync(path.join(fixtures, 'onework.sbertrack_updateIssueStatus.json'), text('Status of PROJ-14904 changed: to_code_review'));
  store = createStore(path.join(dir, 'data'));
  tasks = createTasks({ store, bus: createBus(), defaultBase: 'develop' });
});
after(() => {
  store.close();
  rmrf(dir);
});

test('onework markdown parsers', () => {
  const page = parseFindIssues(JSON.parse(fs.readFileSync(path.join(FIX, 'onework.sbertrack_findIssues.json'), 'utf8')).content[0].text);
  assert.equal(page.hasNext, true);
  assert.deepEqual(page.items[0], { key: 'PROJ-13398', summary: 'SOWA. S50. Методы для справочников', status: 'done', priority: 'mid', assignee: '***' });
  assert.equal(page.items.length, 5);
  const meta = parseIssueMeta(JSON.parse(fs.readFileSync(path.join(FIX, 'onework.sbertrack_getIssueMeta.json'), 'utf8')).content[0].text);
  assert.equal(meta.current, 'development');
  assert.deepEqual(meta.transitions[0], { id: 'to_code_review', label: 'to_code_review', target: 'to_code_review' });
  assert.equal(meta.transitions.find((t) => t.target === 'qa').id, 'qa');
  assert.equal(meta.transitions.length, 8);
});

test('onework import: pages while has_next, closed skipped locally, statuses/priorities mapped, url from template', async () => {
  fs.rmSync(log, { force: true });
  const cfg = config();
  const mcp = createMcpManager(cfg);
  assert.deepEqual(await importTasks({ config: cfg, mcp, tasks }), { imported: 5, updated: 0 });
  assert.deepEqual(calls().map((c) => c.args), [
    { space_code: 'PROJ', assignee: 'me', page_size: 100, page_number: 0 },
    { space_code: 'PROJ', assignee: 'me', page_size: 100, page_number: 1 },
  ]);
  const byKey = Object.fromEntries(tasks.all().map((t) => [t.externalId, t]));
  assert.deepEqual(Object.keys(byKey).sort(), ['PROJ-14904', 'PROJ-14932', 'PROJ-14933', 'PROJ-15001', 'PROJ-15430']);
  assert.deepEqual([byKey['PROJ-14904'].status, byKey['PROJ-14904'].priority, byKey['PROJ-14904'].externalStatus], ['in_progress', 'low', 'development']);
  assert.deepEqual([byKey['PROJ-14933'].status, byKey['PROJ-14933'].priority], ['review', 'high']);
  assert.deepEqual([byKey['PROJ-15001'].status, byKey['PROJ-15001'].priority], ['review', 'high']);
  assert.equal(byKey['PROJ-15430'].externalUrl, 'https://tracker.example/swtr/units/all/unit/PROJ-15430');
  assert.equal(byKey['PROJ-14904'].title, 'BACK. S54. Оптимизация расчёта');
  assert.equal(tasks.key(byKey['PROJ-14904']), 'PROJ-14904');
  assert.deepEqual([byKey['PROJ-14904'].log[0].type, byKey['PROJ-14904'].log[0].text], ['imported', 'Импортирована из трекера']);

  fs.rmSync(log, { force: true });
  assert.deepEqual(await importTasks({ config: cfg, mcp, tasks }), { imported: 0, updated: 0 }, 'nothing changed');
  fs.rmSync(log, { force: true });
  const limited = config({ limit: 2 });
  await importTasks({ config: limited, mcp: createMcpManager(limited), tasks });
  assert.equal(calls().length, 1, 'limit stops paging');
});

test('several spaces: the sync walks each (assignee me) and merges the results', async () => {
  fs.writeFileSync(path.join(fixtures, 'onework.sbertrack_findIssues.OPS.0.json'), text([
    'Found 2 issues on this page (page 0, 100 per page, has_next: False)',
    '',
    '1. **OPS-7** — Ротация логов [todo | mid] @***',
    '2. **PROJ-14904** — BACK. S54. Оптимизация расчёта [development | low] @***',
  ].join('\n')));
  fs.rmSync(log, { force: true });
  const cfg = config({ space: ['PROJ', 'OPS'] });
  assert.deepEqual(await importTasks({ config: cfg, mcp: createMcpManager(cfg), tasks }), { imported: 1, updated: 0 });
  assert.deepEqual(calls().map((c) => [c.args.space_code, c.args.page_number, c.args.assignee]), [['PROJ', 0, 'me'], ['PROJ', 1, 'me'], ['OPS', 0, 'me']]);
  assert.equal(tasks.all().filter((t) => t.externalId === 'PROJ-14904').length, 1, 'merged by key');
  assert.equal(tasks.all().find((t) => t.externalId === 'OPS-7').title, 'Ротация логов');
});

test('import one issue by key or tracker link, even if not assigned to me; deduped', async () => {
  const cfg = config();
  const mcp = createMcpManager(cfg);
  const before = tasks.all().length;
  const byLink = await importIssue({ config: cfg, mcp, tasks, ref: ' https://tracker.example/swtr/units/all/unit/PROJ-14904?tab=info ' });
  assert.equal(tasks.all().length, before, 'already imported by the sync: the same task');
  assert.equal(byLink.externalId, 'PROJ-14904');
  assert.match(byLink.description, /кешировать справочник/);
  fs.copyFileSync(path.join(fixtures, 'onework.sbertrack_getIssue.json'), path.join(fixtures, 'onework.sbertrack_getIssue.PROJ-20001.json'));
  const fresh = await importIssue({ config: { ...cfg, integrations: { ...cfg.integrations, tasks: { ...cfg.integrations.tasks, urlTemplate: '' } } }, mcp, tasks, ref: 'https://other.example/unit/PROJ-20001' });
  assert.deepEqual([fresh.externalId, fresh.status, fresh.externalUrl, tasks.all().length], ['PROJ-20001', 'in_progress', 'https://other.example/unit/PROJ-20001', before + 1]);
  await assert.rejects(importIssue({ config: cfg, mcp, tasks, ref: 'нет ключа' }), (e) => e.status === 400);
});

test('onework details, transitions, status change; tool errors become errors', async () => {
  const cfg = config();
  const mcp = createMcpManager(cfg);
  const task = tasks.all().find((t) => t.externalId === 'PROJ-14904');
  const issue = await getExternal({ config: cfg, mcp, tasks, task });
  assert.equal(issue.key, 'PROJ-14904');
  assert.equal(issue.fields.Status, 'development');
  assert.equal(issue.fields.Labels, 'backend, s54');
  assert.match(issue.description, /^Нужно ускорить расчёт/);
  assert.equal(issue.attributes.Sprint, 'S54');
  assert.match(tasks.get(task.id).description, /Нужно ускорить расчёт/, 'description cached when empty');

  const tr = await getTransitions({ config: cfg, mcp, tasks, task });
  assert.equal(tr.current, 'development');
  fs.rmSync(log, { force: true });
  await transitionTask({ config: cfg, mcp, tasks, task, transition: 'to_code_review', comment: 'готово' });
  assert.deepEqual(calls()[0], { tool: 'sbertrack_updateIssueStatus', args: { key: 'PROJ-14904', transition: 'to_code_review', comment: 'готово' } });
  await assert.rejects(transitionTask({ config: cfg, mcp, tasks, task }), (e) => e.status === 400);
  // a status typed as text (the list did not load in the form): the transition into it, found by name
  fs.rmSync(log, { force: true });
  await transitionTask({ config: cfg, mcp, tasks, task, status: 'QA' });
  assert.equal(calls().find((c) => c.tool === 'sbertrack_updateIssueStatus').args.transition, 'qa');
  await assert.rejects(transitionTask({ config: cfg, mcp, tasks, task, status: 'на луну' }), (e) => e.status === 400 && /нет перехода в «на луну»\. Доступно: /.test(e.message));

  const missing = tasks.create({ title: 'ghost', externalId: 'PROJ-99001', source: 'onework' });
  await assert.rejects(getExternal({ config: cfg, mcp, tasks, task: missing }), (e) => e.status === 502 && /Issue PROJ-99001 not found \(404\)/.test(e.message));
});

test('sourcecontrol: project/repository from origin, an open PR with the same head+base is reused, byte limits', async () => {
  const repo = makeRepo(path.join(dir, 'demo-service'));
  gitIn(repo, 'remote', 'add', 'origin', 'ssh://git@code.example:7998/PROJ/demo-service.git');
  const info = await git.remoteInfo(repo);
  assert.deepEqual(info, { project: 'PROJ', repository: 'demo-service', repo: 'PROJ/demo-service' });
  for (const [url, want] of [['https://code.example/PROJ/demo-service.git', 'PROJ/demo-service'], ['git@code.example:PROJ/demo-service.git', 'PROJ/demo-service']]) {
    const p = git.parseRemote(url);
    assert.equal(`${p.project}/${p.repository}`, want);
  }
  const cfg = config();
  const mcp = createMcpManager(cfg);

  fs.rmSync(log, { force: true });
  const reused = await createPullRequest({ config: cfg, mcp, cwd: repo, branch: 'feature/PROJ-15311', base: 'develop', title: 'PROJ-15311 x', body: '', ...info });
  assert.deepEqual(reused, { url: 'https://code.example/sc/PROJ/demo-service/pulls/561', existing: true });
  assert.deepEqual(calls(), [{ tool: 'git_list_pull_requests', args: { project: 'PROJ', repository: 'demo-service', state: 'OPEN', page: 1, limit: 100 } }]);

  fs.rmSync(log, { force: true });
  const created = await createPullRequest({ config: cfg, mcp, cwd: repo, branch: 'feature/PROJ-14904', base: 'develop', title: 'PROJ-14904 Оптимизация расчёта', body: 'Кеш справочника', ...info });
  assert.deepEqual(created, { url: 'https://code.example/sc/PROJ/demo-service/pulls/562', existing: false });
  assert.deepEqual(calls()[1].args, { project: 'PROJ', repository: 'demo-service', head: 'feature/PROJ-14904', base: 'develop', title: 'PROJ-14904 Оптимизация расчёта', body: 'Кеш справочника' });

  const longTitle = `PROJ-14904 ${'щ'.repeat(45)}`; // 11 + 90 = 101 bytes
  await assert.rejects(createPullRequest({ config: cfg, mcp, cwd: repo, branch: 'b', base: 'develop', title: longTitle, body: '', ...info }), (e) => e.status === 400 && /101\/100/.test(e.message));
  await assert.rejects(createPullRequest({ config: cfg, mcp, cwd: repo, branch: 'b', base: 'develop', title: 'ok', body: 'ж'.repeat(300), ...info }), (e) => e.status === 400 && /600\/512/.test(e.message));
});

test('MCP servers from gemini/qwen settings; server/Name secrets go to that server (header or env)', async () => {
  const from = path.join(dir, 'user settings.json');
  const echo = path.join(dir, 'echo-env-mcp.js');
  fs.writeFileSync(echo, `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    rl.on('line', (l) => { const m = JSON.parse(l); if (m.id == null) return;
      if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'e', version: '1' } } });
      if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'env' }] } });
      send({ jsonrpc: '2.0', id: m.id, result: { structuredContent: { SC_TOKEN: process.env.SC_TOKEN, exported: process.env.MCP_SECRET_sourcecontrol_SC_TOKEN, other: process.env.Authorization ?? null }, content: [] } });
    });`);
  fs.renameSync(echo, echo.replace(/\.js$/, '.cjs'));
  fs.writeFileSync(from, JSON.stringify({ mcpServers: {
    onework: { type: 'http', url: 'http://onework.example/mcp', headers: { 'X-Client': 'harness' } },
    legacy: { httpUrl: 'http://legacy.example/mcp' },
    sourcecontrol: { command: 'node', args: [echo.replace(/\.js$/, '.cjs')], env: {} },
  } }));
  const secrets = path.join(dir, 'secrets.txt');
  fs.writeFileSync(secrets, '# console secrets\nonework/Authorization=Bearer abc\nsourcecontrol/SC_TOKEN=sc-123\n');
  const cfg = { root: CODE_ROOT, dataDir: dir, mcpServersFrom: from, mcpSecretsFile: secrets, mcpServers: {} };
  const defs = serverDefs(cfg);
  assert.deepEqual([defs.onework.transport, defs.legacy.transport, defs.sourcecontrol.transport], ['http', 'http', 'stdio']);
  const v = toolResultValue(await createMcpManager(cfg).callTool('sourcecontrol', 'env', {}));
  assert.deepEqual(v, { SC_TOKEN: 'sc-123', exported: 'sc-123', other: null });
});

test('inheritUserMcp copies the user mcpServers next to harness in the run settings', () => {
  const user = path.join(dir, 'gigacode settings.json');
  fs.writeFileSync(user, JSON.stringify({ mcpServers: { onework: { httpUrl: 'http://x' } }, permissions: { allow: ['x'] } }));
  const base = { harnessMcp: { command: 'node', args: ['h.js'], env: {} }, agentMcpServers: {} };
  assert.deepEqual(Object.keys(sessionSettings({ ...base, agentCfg: { settings: {} } }).mcpServers), ['harness']);
  const s = sessionSettings({ ...base, agentCfg: { settings: {}, inheritUserMcp: true, userSettingsPath: user } });
  assert.deepEqual(Object.keys(s.mcpServers), ['onework', 'harness']);
  assert.ok(!('permissions' in s));
});

test('PR status: open first, else the newest merged/declined for the branch; task.pr refreshed only on change', async () => {
  const pull = (index, head, state, updated) => ({ index, title: `${head} work`, state, head: { name: head }, base: { name: 'develop' }, mergeable: null, reviewers: [{ status: 'APPROVED' }], html_url: `https://code.example/sc/PROJ/demo-service/pulls/${index}`, updated_at: updated });
  fs.writeFileSync(path.join(fixtures, 'sourcecontrol.git_list_pull_requests.MERGED.json'), JSON.stringify({ pulls: [pull(540, 'feature/PROJ-14904', 'merged', '2026-11-10T10:00:00Z')] }));
  fs.writeFileSync(path.join(fixtures, 'sourcecontrol.git_list_pull_requests.DECLINED.json'), JSON.stringify({ pulls: [pull(530, 'feature/PROJ-14904', 'declined', '2026-11-01T10:00:00Z')] }));
  const cfg = config();
  const mcp = createMcpManager(cfg);
  const info = { project: 'PROJ', repository: 'demo-service', repo: 'PROJ/demo-service' };

  const open = await prStatus({ config: cfg, mcp, branch: 'feature/PROJ-15311', ...info });
  assert.deepEqual(open.pr, {
    index: 561, title: 'PROJ-15311 BACK. S55. Увеличение количества символов в текстовом поле до 3000', state: 'open',
    url: 'https://code.example/sc/PROJ/demo-service/pulls/561', mergeable: true, reviewers: [{ status: 'PENDING' }], base: 'develop',
    updatedAt: Date.parse('2026-11-17T14:36:21Z'),
  });
  assert.deepEqual([(await prStatus({ config: cfg, mcp, branch: 'feature/PROJ-14904', ...info })).pr.state, (await prStatus({ config: cfg, mcp, branch: 'feature/PROJ-14904', ...info })).pr.index], ['merged', 540]);
  assert.equal((await prStatus({ config: cfg, mcp, branch: 'feature/none', ...info })).pr, null);
  await assert.rejects(prStatus({ config: { ...cfg, integrations: { pr: { enabled: false } } }, mcp, branch: 'x', ...info }), (e) => e.status === 501);

  const repo = makeRepo(path.join(dir, 'pr repo'));
  gitIn(repo, 'remote', 'add', 'origin', 'https://code.example/PROJ/demo-service.git');
  const task = tasks.create({ title: 'with a PR', branch: 'feature/PROJ-15311' });
  assert.equal(await refreshTaskPr({ config: cfg, mcp, tasks, task, cwd: repo }), true);
  assert.deepEqual(tasks.get(task.id).pr, { index: 561, state: 'open', url: 'https://code.example/sc/PROJ/demo-service/pulls/561', updatedAt: Date.parse('2026-11-17T14:36:21Z') });
  assert.equal(await refreshTaskPr({ config: cfg, mcp, tasks, task: tasks.get(task.id), cwd: repo }), false, 'unchanged -> no update');
});

test('onework links on the external details; decomposition children imported as subtasks', async () => {
  fs.writeFileSync(path.join(fixtures, 'onework.sbertrack_getIssue.PROJ-15099.json'), text('# PROJ-15099 — Дочерняя: схема БД\n\n- **Status**: todo\n- **Priority**: high\n\nСоздать таблицы.\n'));
  fs.copyFileSync(path.join(FIX, 'onework.tool-error.json'), path.join(fixtures, 'onework.sbertrack_getIssue.PROJ-14438.json'));
  const cfg = config();
  const mcp = createMcpManager(cfg);
  const parent = tasks.all().find((t) => t.externalId === 'PROJ-14904');
  tasks.update(parent.id, { workspaceId: 'w_svc', targets: ['develop', 'release/1.54.0'] });

  const ext = await getExternal({ config: cfg, mcp, tasks, task: tasks.get(parent.id) });
  assert.deepEqual(ext.links, [
    { type: 'wiki_page_mention', from: 'PROJ-15384', to: 'PROJ-14904' },
    { type: 'decomposition', from: 'PROJ-14904', to: 'PROJ-15099' },
    { type: 'plain_connection', from: 'PROJ-14906', to: 'PROJ-14904' },
    { type: 'decomposition', from: 'PROJ-14904', to: 'PROJ-14438' },
  ]);

  const r = await importChildren({ config: cfg, mcp, tasks, task: tasks.get(parent.id) });
  assert.deepEqual([r.imported, r.updated, r.failed.map((x) => x.key)], [1, 0, ['PROJ-14438']]);
  assert.match(r.failed[0].error, /not found \(404\)/);
  const child = tasks.all().find((t) => t.externalId === 'PROJ-15099');
  assert.deepEqual([child.parentId, child.workspaceId, child.targets, child.title, child.status, child.priority], [parent.id, 'w_svc', ['develop', 'release/1.54.0'], 'Дочерняя: схема БД', 'todo', 'high']);
  assert.equal(child.description, 'Создать таблицы.');
  assert.equal(tasks.key(child), 'PROJ-14904', 'children share the root key');
  const again = await importChildren({ config: cfg, mcp, tasks, task: tasks.get(parent.id) });
  assert.deepEqual([again.imported, again.updated], [0, 0]);
});

test('routes: /api/git/pr-status for the current branch (501 when disabled), /api/fs/search', async () => {
  const repo = makeRepo(path.join(dir, 'route repo'));
  gitIn(repo, 'remote', 'add', 'origin', 'git@code.example:PROJ/demo-service.git');
  gitIn(repo, 'switch', '-q', '-c', 'feature/PROJ-15311');
  fs.mkdirSync(path.join(repo, 'src', 'components'), { recursive: true });
  for (const f of ['src/sessions.js', 'src/components/SessionList.tsx', 'src/store.js', 'notes.log']) fs.writeFileSync(path.join(repo, f), 'x\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.log\n');
  const plain = path.join(dir, 'plain folder');
  fs.mkdirSync(path.join(plain, 'deep', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'deep', 'sessions.md'), 'x');
  fs.writeFileSync(path.join(plain, 'deep', 'node_modules', 'sessions.js'), 'x');

  const h = await startTestServer({ mcpServers: { sourcecontrol: stub('sourcecontrol') }, integrations: { pr: { ...committed.integrations.pr, enabled: true } } });
  const off = await startTestServer();
  try {
    const st = (await h.api('GET', `/api/git/pr-status?cwd=${encodeURIComponent(repo)}`)).body;
    assert.deepEqual([st.pr.index, st.pr.state, st.pr.url], [561, 'open', 'https://code.example/sc/PROJ/demo-service/pulls/561']);
    assert.equal((await off.api('GET', `/api/git/pr-status?cwd=${encodeURIComponent(repo)}`)).status, 501);

    const found = (await h.api('GET', `/api/fs/search?cwd=${encodeURIComponent(repo)}&q=sesjs`)).body;
    assert.equal(found[0].path, 'src/sessions.js');
    assert.ok(found.every((x) => typeof x.score === 'number'));
    const all = (await h.api('GET', `/api/fs/search?cwd=${encodeURIComponent(repo)}&q=&limit=2`)).body;
    assert.equal(all.length, 2);
    assert.ok(!(await h.api('GET', `/api/fs/search?cwd=${encodeURIComponent(repo)}&q=log`)).body.some((x) => x.path === 'notes.log'), 'ignored files are not offered');
    const walked = (await h.api('GET', `/api/fs/search?cwd=${encodeURIComponent(plain)}&q=sessions`)).body;
    assert.deepEqual(walked.map((x) => x.path), ['deep/sessions.md'], 'walk fallback skips node_modules');
  } finally {
    await h.close();
    await off.close();
  }
});

test('onStartTransition: tracker transition after take-into-work, best effort', async () => {
  fs.copyFileSync(path.join(FIX, 'onework.tool-error.json'), path.join(fixtures, 'onework.sbertrack_updateIssueStatus.PROJ-99001.json'));
  const repo = makeRepo(path.join(dir, 'start repo'));
  const h = await startTestServer({
    mcpServers: { onework: stub('onework') },
    integrations: { tasks: { ...committed.integrations.tasks, enabled: true, onStartTransition: 'development' } },
  });
  try {
    const ws = (await h.api('POST', '/api/workspaces', { path: repo })).body;
    const mk = async (key) => {
      const t = (await h.api('POST', '/api/tasks', { title: key, workspaceId: ws.id })).body;
      await h.api('PATCH', `/api/tasks/${t.id}`, { externalId: key, source: 'onework' });
      return t;
    };
    const ok = await mk('PROJ-14904');
    fs.rmSync(log, { force: true });
    const s = (await h.api('POST', `/api/tasks/${ok.id}/start`, { agent: 'mock' })).body;
    assert.ok(s.id);
    assert.deepEqual(calls().find((c) => c.tool === 'sbertrack_updateIssueStatus').args, { key: 'PROJ-14904', transition: 'development', comment: 'Взято в работу через harness' });
    await h.api('POST', `/api/sessions/${s.id}/stop`);

    const bad = await mk('PROJ-99001');
    const r = await h.api('POST', `/api/tasks/${bad.id}/start`, { agent: 'mock' });
    assert.equal(r.status, 200, 'a tracker failure never fails the start');
    const st = (await h.api('GET', '/api/state')).body;
    assert.ok(st.tasks.find((t) => t.id === bad.id).log.some((l) => /^⚠ Трекер: не удалось \(переход «development»\): .*not found \(404\)/.test(l.text)));
    assert.ok(st.notifications.some((n) => n.taskId === bad.id && n.kind === 'error'));
    await h.api('POST', `/api/sessions/${r.body.id}/stop`);
  } finally {
    await h.close();
  }
});

test('decline a pull request through sourcecontrol (declineTool, {project, repository, pullRequestIndex})', async () => {
  const repo = makeRepo(path.join(dir, 'decline repo'));
  gitIn(repo, 'remote', 'add', 'origin', 'https://code.example/PROJ/demo-service.git');
  fs.writeFileSync(path.join(fixtures, 'sourcecontrol.git_decline_pull_request.json'), text('Pull request 562 declined'));
  fs.rmSync(log, { force: true });
  const cfg = config();
  const r = await declinePullRequest({ config: cfg, mcp: createMcpManager(cfg), cwd: repo, index: 562 });
  assert.deepEqual([r.ok, r.index, r.result], [true, 562, 'Pull request 562 declined']);
  const call = calls().find((c) => c.tool === 'git_decline_pull_request' || c.name === 'git_decline_pull_request');
  assert.deepEqual(call.args, { project: 'PROJ', repository: 'demo-service', pullRequestIndex: 562 });
  await assert.rejects(declinePullRequest({ config: cfg, mcp: createMcpManager(cfg), cwd: repo, index: 0 }), (e) => e.status === 400);
});

test('merge a pull request through sourcecontrol (mergeTool, by default the decline args)', async () => {
  const repo = makeRepo(path.join(dir, 'merge repo'));
  gitIn(repo, 'remote', 'add', 'origin', 'https://code.example/PROJ/demo-service.git');
  fs.writeFileSync(path.join(fixtures, 'sourcecontrol.git_merge_pull_request.json'), text('Pull request 561 merged'));
  fs.rmSync(log, { force: true });
  const cfg = config();
  const r = await mergePullRequest({ config: cfg, mcp: createMcpManager(cfg), cwd: repo, index: 561 });
  assert.deepEqual([r.ok, r.index, r.result], [true, 561, 'Pull request 561 merged']);
  const call = calls().find((c) => c.tool === 'git_merge_pull_request' || c.name === 'git_merge_pull_request');
  assert.deepEqual(call.args, { project: 'PROJ', repository: 'demo-service', pullRequestIndex: 561 });
  await assert.rejects(mergePullRequest({ config: cfg, mcp: createMcpManager(cfg), cwd: repo, index: -1 }), (e) => e.status === 400);
});

test('a pull request in detail: the host diff and its comments, whatever shape the comments come in', async () => {
  const { pullRequestDetail, prComments } = await import('../server/integrations/pr.js');
  assert.deepEqual(prComments({ comments: [{ author: { name: 'Иван' }, text: 'Поправь null', created_at: '2026-11-19T10:00:00Z', path: 'A.java', line: 12 }, { body: '  ' }] }),
    [{ author: 'Иван', text: 'Поправь null', at: Date.parse('2026-11-19T10:00:00Z'), path: 'A.java', line: 12 }]);
  assert.deepEqual(prComments([{ user: { username: 'u1' }, body: 'ok' }]).map((c) => [c.author, c.text]), [['u1', 'ok']]);
  assert.deepEqual(prComments('нет комментариев'), []);
  const repo = makeRepo(path.join(dir, 'detail repo'));
  gitIn(repo, 'remote', 'add', 'origin', 'https://code.example/PROJ/demo-service.git');
  fs.writeFileSync(path.join(fixtures, 'sourcecontrol.git_get_pull_request_diff.json'), text('diff --git a/A.java b/A.java\n--- a/A.java\n+++ b/A.java\n@@ -1 +1 @@\n-a\n+b\n'));
  fs.writeFileSync(path.join(fixtures, 'sourcecontrol.git_list_pull_request_comments.json'), JSON.stringify({ comments: [{ author: { name: 'Иван' }, text: 'Поправь null' }] }));
  const cfg = config();
  const d = await pullRequestDetail({ config: cfg, mcp: createMcpManager(cfg), cwd: repo, index: 561 });
  assert.match(d.diff.text, /\+b/);
  assert.deepEqual(d.comments.items.map((c) => c.text), ['Поправь null']);
});
