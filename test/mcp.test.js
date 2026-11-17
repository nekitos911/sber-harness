// Console MCP client (stdio + streamable HTTP, secrets, server merge), the tracker/PR seams, scripts/mcp-call.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CODE_ROOT } from '../server/config.js';
import { createMcpManager, toolResultValue, loadSecrets, secretEnv, serverDefs } from '../server/mcp-client.js';
import { createStore } from '../server/store.js';
import { createBus } from '../server/bus.js';
import { createTasks } from '../server/tasks.js';
import { importTasks, transitionTask } from '../server/integrations/tasks.js';
import { createPullRequest } from '../server/integrations/pr.js';
import { tmpDir, rmrf } from './helpers.js';

const dir = tmpDir();
after(() => rmrf(dir));
const MOCK = { transport: 'stdio', command: 'node', args: ['scripts/mock-mcp.js'], timeoutMs: 10000 };

const baseConfig = (extra = {}) => ({
  root: CODE_ROOT,
  dataDir: dir,
  mcpServersFrom: null,
  mcpSecretsFile: path.join(dir, 'no-secrets.json'),
  mcpServers: { tracker: { ...MOCK } },
  integrations: {
    tasks: {
      enabled: true, server: 'tracker', tools: { find: 'list_issues', transition: 'update_issue_status' }, args: {}, limit: 10, itemsPath: 'issues',
      map: { externalId: 'key', title: 'summary', description: 'description', externalUrl: 'url', status: 'status', priority: 'priority' },
      statusMap: { Open: 'todo', 'In Progress': 'in_progress', Review: 'review', Done: 'done' },
      closedStatuses: ['Closed'],
      transition: { args: { key: '{key}', status: '{status}', comment: '{comment}' } },
    },
    pr: {
      enabled: true, server: 'tracker', tool: 'create_pull_request',
      args: { repo: '{repo}', source: '{branch}', target: '{base}', title: '{title}', description: '{body}' }, urlPath: 'url',
    },
  },
  git: { defaultBase: 'develop' },
  ...extra,
});

test('stdio client: list and call tools on mock-mcp', async () => {
  const mcp = createMcpManager(baseConfig());
  assert.deepEqual((await mcp.listTools('tracker')).map((t) => t.name), ['list_issues', 'update_issue_status', 'create_pull_request']);
  assert.equal(toolResultValue(await mcp.callTool('tracker', 'list_issues', {})).issues.length, 4);
  await assert.rejects(mcp.callTool('tracker', 'create_pull_request', {}), /repo is required/);
  const [row] = await mcp.status();
  assert.deepEqual([row.ok, row.tools.length], [true, 3]);
});

test('toolResultValue prefers structuredContent, then JSON text, then text', () => {
  assert.deepEqual(toolResultValue({ structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"a":2}' }] }), { a: 1 });
  assert.deepEqual(toolResultValue({ content: [{ type: 'text', text: '{"a":2}' }] }), { a: 2 });
  assert.equal(toolResultValue({ content: [{ type: 'text', text: 'plain' }] }), 'plain');
});

test('secrets: JSON map, name=value lines, a bare value; MCP_SECRET_ env names', () => {
  const file = path.join(dir, 'secrets.txt');
  const cfg = baseConfig({ mcpSecretsFile: file });
  fs.writeFileSync(file, '# comment\nonework/Authorization=Bearer abc\nsourcecontrol_token = t0k=en\n');
  assert.deepEqual([...loadSecrets(cfg).values()], [{ name: 'onework/Authorization', value: 'Bearer abc' }, { name: 'sourcecontrol_token', value: 't0k=en' }]);
  assert.deepEqual(secretEnv(cfg), { MCP_SECRET_onework_Authorization: 'Bearer abc', MCP_SECRET_sourcecontrol_token: 't0k=en' });
  fs.writeFileSync(file, 'just-a-token\n');
  assert.deepEqual([...loadSecrets(cfg).values()], [{ name: 'onework/Authorization', value: 'just-a-token' }]);
  fs.writeFileSync(file, '{ "remote/Authorization": "Bearer x" }');
  assert.equal(loadSecrets(cfg).get('remote_authorization').value, 'Bearer x');
});

test('servers: config.mcpServers merged over mcpServersFrom', () => {
  const from = path.join(dir, 'user settings.json');
  fs.writeFileSync(from, JSON.stringify({ mcpServers: { onework: { httpUrl: 'http://x/mcp', headers: { a: '1' } }, tracker: { command: 'other', timeoutMs: 1 } } }));
  const defs = serverDefs(baseConfig({ mcpServersFrom: from }));
  assert.deepEqual(Object.keys(defs).sort(), ['onework', 'tracker']);
  assert.equal(defs.onework.transport, 'http');
  assert.equal(defs.onework.url, 'http://x/mcp');
  assert.equal(defs.tracker.command, 'node');
  assert.equal(defs.tracker.timeoutMs, 10000);
});

test('missing secret: that server reports a problem, the others keep working', async () => {
  const mcp = createMcpManager(baseConfig({ mcpServers: { tracker: { ...MOCK }, broken: { ...MOCK, env: { TOKEN: '$secret:broken/token' } } } }));
  const rows = Object.fromEntries((await mcp.status()).map((r) => [r.name, r]));
  assert.equal(rows.tracker.ok, true);
  assert.equal(rows.broken.ok, false);
  assert.match(rows.broken.problem, /missing secret broken\/token/);
  assert.ok(!JSON.stringify(rows).includes('Bearer'));
});

test('http client: SSE responses, Mcp-Session-Id, secret headers and ${env:} refs, per-call connections', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method !== 'POST') return res.end();
      const msg = JSON.parse(body);
      seen.push({ method: msg.method, session: req.headers['mcp-session-id'], auth: req.headers.authorization, team: req.headers['x-team'] });
      if (msg.id == null) return res.writeHead(202).end();
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'h', version: '1' } } }));
      }
      const result = msg.method === 'tools/list'
        ? { tools: [{ name: 'echo', description: 'echo' }] }
        : { content: [{ type: 'text', text: JSON.stringify({ echoed: msg.params.arguments }) }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const secrets = path.join(dir, 'secrets.json');
  fs.writeFileSync(secrets, JSON.stringify({ 'remote/Authorization': 'Bearer s3cret' }));
  process.env.HARNESS_TEST_TEAM = 'core';
  try {
    const mcp = createMcpManager(baseConfig({
      mcpSecretsFile: secrets,
      mcpServers: { remote: { url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { 'x-team': '${env:HARNESS_TEST_TEAM}' }, timeoutMs: 5000 } },
    }));
    assert.deepEqual((await mcp.listTools('remote')).map((t) => t.name), ['echo']);
    assert.deepEqual(toolResultValue(await mcp.callTool('remote', 'echo', { x: 1 })), { echoed: { x: 1 } });
    assert.deepEqual(seen.map((s) => s.method), ['initialize', 'notifications/initialized', 'tools/list', 'initialize', 'notifications/initialized', 'tools/call']);
    assert.ok(seen.filter((s) => s.method === 'initialize').every((s) => s.session === undefined));
    assert.ok(seen.filter((s) => s.method !== 'initialize').every((s) => s.session === 'sess-1'));
    assert.ok(seen.every((s) => s.auth === 'Bearer s3cret' && s.team === 'core'));
  } finally {
    server.close();
  }
});

test('importTasks: closed skipped, dedupe, change-only updates, manual status and hidden kept; transition; PR', async () => {
  const issuesFile = path.join(dir, 'issues.json');
  const issues = JSON.parse(JSON.stringify([
    { key: 'DEMO-1', summary: 'Add health endpoint', description: 'd1', url: 'http://t/DEMO-1', status: 'Open', priority: 'High' },
    { key: 'DEMO-2', summary: 'Fix login', description: 'd2', url: 'http://t/DEMO-2', status: 'In Progress', priority: 'Medium' },
    { key: 'DEMO-3', summary: 'Update README', description: 'd3', url: 'http://t/DEMO-3', status: 'Done', priority: 'Low' },
    { key: 'DEMO-4', summary: 'Old idea', description: 'd4', url: 'http://t/DEMO-4', status: 'Closed', priority: 'Low' },
  ]));
  fs.writeFileSync(issuesFile, JSON.stringify(issues));
  const config = baseConfig({ mcpServers: { tracker: { ...MOCK, env: { MOCK_MCP_ISSUES: issuesFile } } } });
  const mcp = createMcpManager(config);
  const store = createStore(path.join(dir, 'data'));
  const sent = [];
  const bus = createBus();
  bus.subscribe((f) => sent.push(f));
  const tasks = createTasks({ store, bus, defaultBase: 'develop' });
  const byKey = (k) => tasks.all().find((t) => t.externalId === k);

  assert.deepEqual(await importTasks({ config, mcp, tasks }), { imported: 3, updated: 0 });
  assert.equal(byKey('DEMO-4'), undefined, 'closed issues are not added');
  assert.deepEqual(tasks.all().map((t) => [t.status, t.priority, t.externalStatus]), [['todo', 'high', 'Open'], ['in_progress', 'medium', 'In Progress'], ['done', 'low', 'Done']]);
  assert.equal(tasks.key(byKey('DEMO-1')), 'DEMO-1');

  tasks.move(byKey('DEMO-1').id, 'review'); // human move -> statusManual
  tasks.remove(byKey('DEMO-3').id); // imported -> hidden, not deleted
  assert.equal(byKey('DEMO-3').hidden, true);
  issues[0].status = 'In Progress';
  issues[1].summary = 'Fix login redirect';
  issues[2].status = 'Closed';
  fs.writeFileSync(issuesFile, JSON.stringify(issues));
  sent.length = 0;
  assert.deepEqual(await importTasks({ config, mcp, tasks }), { imported: 0, updated: 3 });
  assert.deepEqual([byKey('DEMO-1').status, byKey('DEMO-1').externalStatus], ['review', 'In Progress']);
  assert.equal(byKey('DEMO-2').title, 'Fix login redirect');
  assert.deepEqual([byKey('DEMO-3').hidden, byKey('DEMO-3').externalStatus], [true, 'Closed']);
  assert.equal(await importTasks({ config, mcp, tasks }).then((r) => r.updated), 0, 'unchanged tasks are not touched');
  assert.ok(sent.every((f) => f.t === 'task'));

  const t2 = await transitionTask({ config, mcp, tasks, task: byKey('DEMO-2'), status: 'Review', comment: 'ready' });
  assert.deepEqual([t2.externalStatus, t2.status], ['Review', 'review']);
  const off = { ...config, integrations: { tasks: { enabled: true, server: 'tracker', tools: { find: 'list_issues' } }, pr: { enabled: false } } };
  await assert.rejects(transitionTask({ config: off, mcp, tasks, task: byKey('DEMO-2'), status: 'Done' }), (e) => e.status === 501);
  await assert.rejects(importTasks({ config: { ...off, integrations: { tasks: { enabled: false } } }, mcp, tasks }), (e) => e.status === 501);

  const pr = await createPullRequest({ config, mcp, cwd: dir, branch: 'feature/DEMO-1', base: '', title: 'DEMO-1: x', body: 'b', repo: 'team/svc' });
  assert.match(pr.url, /^http:\/\/pr\.local\/team\/svc\/\d+$/);
  await assert.rejects(createPullRequest({ config: off, mcp, cwd: dir, branch: 'b', title: 't', body: '', repo: 'r' }), (e) => e.status === 501);
  store.close();
});

test('scripts/mcp-call.js lists tools, calls a tool, fails clearly', async () => {
  const cfgFile = path.join(dir, 'cli config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ dataDir: dir, mcpServersFrom: null, mcpServers: { tracker: { ...MOCK, enabled: false } } }));
  const run = (...args) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(CODE_ROOT, 'scripts', 'mcp-call.js'), ...args], { cwd: CODE_ROOT, env: { ...process.env, HARNESS_CONFIG: cfgFile } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
  const list = await run('tracker', '--list');
  assert.equal(list.code, 0, list.stderr);
  const tools = JSON.parse(list.stdout);
  assert.ok(tools.some((t) => t.name === 'list_issues' && t.inputSchema?.type === 'object'));
  const call = await run('tracker', 'list_issues', '{"limit":1}');
  assert.equal(JSON.parse(call.stdout).issues.length, 1);
  const bad = await run('nope', '--list');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /not configured/);
});
