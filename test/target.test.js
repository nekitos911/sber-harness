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
import { importTasks, getExternal, getTransitions, transitionTask, parseFindIssues, parseIssueMeta } from '../server/integrations/tasks.js';
import { createPullRequest } from '../server/integrations/pr.js';
import { sessionSettings } from '../server/launchers.js';
import * as git from '../server/git.js';
import { tmpDir, rmrf, makeRepo, gitIn } from './helpers.js';

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
  assert.deepEqual(meta.transitions[0], { id: 'to_code_review', label: 'to_code_review' });
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

  fs.rmSync(log, { force: true });
  assert.deepEqual(await importTasks({ config: cfg, mcp, tasks }), { imported: 0, updated: 0 }, 'nothing changed');
  fs.rmSync(log, { force: true });
  const limited = config({ limit: 2 });
  await importTasks({ config: limited, mcp: createMcpManager(limited), tasks });
  assert.equal(calls().length, 1, 'limit stops paging');
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
