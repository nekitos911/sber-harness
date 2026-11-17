// MCP client (stdio + streamable HTTP) and the tracker/PR integration seams, against scripts/mock-mcp.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CODE_ROOT } from '../server/config.js';
import { createMcpManager, toolResultValue } from '../server/mcp-client.js';
import { createStore } from '../server/store.js';
import { createBus } from '../server/bus.js';
import { createTasks } from '../server/tasks.js';
import { importTasks } from '../server/integrations/tasks.js';
import { createPullRequest } from '../server/integrations/pr.js';
import { tmpDir, rmrf } from './helpers.js';

const dir = tmpDir();
const managers = [];
after(() => {
  for (const m of managers) m.close();
  rmrf(dir);
});

const baseConfig = (extra = {}) => ({
  root: CODE_ROOT,
  dataDir: dir,
  mcpServers: { tracker: { transport: 'stdio', command: 'node', args: ['scripts/mock-mcp.js'], timeoutMs: 10000 } },
  integrations: {
    tasks: {
      enabled: true, server: 'tracker', tool: 'list_issues', args: {}, itemsPath: 'issues',
      map: { externalId: 'key', title: 'summary', description: 'description', externalUrl: 'url', status: 'status', priority: 'priority' },
      statusMap: { Open: 'todo', 'In Progress': 'in_progress', Review: 'review', Done: 'done' },
    },
    pr: {
      enabled: true, server: 'tracker', tool: 'create_pull_request',
      args: { repo: '{repo}', source: '{branch}', target: '{base}', title: '{title}', description: '{body}' }, urlPath: 'url',
    },
  },
  git: { defaultBase: 'develop' },
  ...extra,
});
const manager = (config) => {
  const m = createMcpManager(config);
  managers.push(m);
  return m;
};

test('stdio client: list and call tools on mock-mcp', async () => {
  const mcp = manager(baseConfig());
  const tools = await mcp.listTools('tracker');
  assert.deepEqual(tools.map((t) => t.name), ['list_issues', 'create_pull_request']);
  const value = toolResultValue(await mcp.callTool('tracker', 'list_issues', {}));
  assert.equal(value.issues.length, 3);
  await assert.rejects(mcp.callTool('tracker', 'create_pull_request', {}), /repo is required/);
  const status = await mcp.status();
  assert.equal(status[0].ok, true);
  assert.equal(status[0].tools.length, 2);
});

test('toolResultValue prefers structuredContent, then JSON text, then text', () => {
  assert.deepEqual(toolResultValue({ structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"a":2}' }] }), { a: 1 });
  assert.deepEqual(toolResultValue({ content: [{ type: 'text', text: '{"a":2}' }] }), { a: 2 });
  assert.equal(toolResultValue({ content: [{ type: 'text', text: 'plain' }] }), 'plain');
});

test('http client: SSE responses, Mcp-Session-Id, secrets headers', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method !== 'POST') return res.end();
      const msg = JSON.parse(body);
      seen.push({ method: msg.method, session: req.headers['mcp-session-id'], auth: req.headers.authorization });
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
  fs.writeFileSync(secrets, JSON.stringify({ remote: { headers: { authorization: 'Bearer s3cret' } } }));
  try {
    const mcp = manager(baseConfig({
      mcpSecretsFile: secrets,
      mcpServers: { remote: { transport: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`, timeoutMs: 5000 } },
    }));
    assert.deepEqual((await mcp.listTools('remote')).map((t) => t.name), ['echo']);
    assert.deepEqual(toolResultValue(await mcp.callTool('remote', 'echo', { x: 1 })), { echoed: { x: 1 } });
    assert.deepEqual(seen.map((s) => s.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.equal(seen[0].session, undefined);
    assert.ok(seen.slice(1).every((s) => s.session === 'sess-1' && s.auth === 'Bearer s3cret'));
  } finally {
    server.close();
  }
});

test('importTasks maps, dedupes and updates; createPullRequest fills templates', async () => {
  const config = baseConfig();
  const mcp = manager(config);
  const store = createStore(path.join(dir, 'data'));
  const tasks = createTasks({ store, bus: createBus(), defaultBase: 'develop' });

  assert.deepEqual(await importTasks({ config, mcp, tasks }), { imported: 3, updated: 0 });
  const t1 = tasks.all().find((t) => t.externalId === 'DEMO-1');
  assert.equal(t1.source, 'tracker');
  assert.equal(t1.title, 'Add health endpoint');
  assert.equal(t1.externalUrl, 'http://tracker.local/DEMO-1');
  assert.deepEqual(tasks.all().map((t) => [t.status, t.priority]), [['todo', 'high'], ['in_progress', 'medium'], ['done', 'low']]);
  assert.equal(tasks.key(t1), 'DEMO-1');
  tasks.update(t1.id, { title: 'local edit' });
  assert.deepEqual(await importTasks({ config, mcp, tasks }), { imported: 0, updated: 3 });
  assert.equal(tasks.all().length, 3);
  assert.equal(tasks.find(t1.id).title, 'Add health endpoint');

  const pr = await createPullRequest({ config, mcp, cwd: dir, branch: 'feature/DEMO-1', base: '', title: 'DEMO-1: x', body: 'b', repo: 'team/svc' });
  assert.match(pr.url, /^http:\/\/pr\.local\/team\/svc\/\d+$/);

  const off = { ...config, integrations: { tasks: { enabled: false }, pr: { enabled: false } } };
  await assert.rejects(importTasks({ config: off, mcp, tasks }), (e) => e.status === 501);
  await assert.rejects(createPullRequest({ config: off, mcp, cwd: dir, branch: 'b', title: 't', body: '', repo: 'r' }), (e) => e.status === 501);
  store.close();
});
