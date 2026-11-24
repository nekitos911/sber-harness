// Console MCP client (stdio + streamable HTTP, secrets, server merge), the tracker/PR seams, scripts/mcp-call.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { Agent } from 'undici';
import { CODE_ROOT } from '../server/config.js';
import { createMcpManager, toolResultValue, loadSecrets, secretEnv, serverDefs, setSecret, deleteSecret, secretsSource, customServers, tlsDispatcher, systemRootCertificates } from '../server/mcp-client.js';
import { createStore } from '../server/store.js';
import { createBus } from '../server/bus.js';
import { createTasks } from '../server/tasks.js';
import { importTasks, transitionTask } from '../server/integrations/tasks.js';
import { createPullRequest } from '../server/integrations/pr.js';
import { startTestServer, tmpDir, rmrf } from './helpers.js';

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

test('https server without configured roots keeps undici\'s own trust', async () => {
  // an explicit ca array replaces Node's bundle in undici: no dispatcher is what a host verified by Node itself needs
  assert.equal(tlsDispatcher({}, {}), undefined);
  assert.equal(tlsDispatcher({ rejectUnauthorized: true }, { mcpCa: [] }), undefined);
  const optOut = tlsDispatcher({ rejectUnauthorized: false }, {});
  assert.ok(optOut instanceof Agent, 'the opt-out needs a dispatcher');
  await optOut.close();
});

test('a configured root comes with the OS store and Node\'s bundle, never alone', async () => {
  // SberCA Root Ext lives in the Windows store only: an added root that replaces the store breaks every bank host
  const file = path.join(dir, 'bank-root.pem');
  fs.writeFileSync(file, tls.rootCertificates[3] + '\n');
  const store = systemRootCertificates();
  const agent = tlsDispatcher({}, { mcpCaFile: file });
  assert.ok(agent instanceof Agent);
  await agent.close();
  // the store is a real source on Node 22.9+: the rebuilt trust is wider than Node's own bundle alone
  assert.ok(Array.isArray(store));
  assert.ok(new Set([...store, ...tls.rootCertificates]).size > tls.rootCertificates.length);
});

test('stdio passes a scoped value or an environment binding and can omit an inherited variable', async (t) => {
  const variable = 'HARNESS_TEST_STDIO_ACCESS';
  const previous = process.env[variable];
  process.env[variable] = 'from-environment';
  t.after(() => { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; });
  const file = path.join(dir, 'stdio-auth.json');
  fs.writeFileSync(file, JSON.stringify({ ['local/' + variable]: 'from-file' }));
  const probe = `require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    if (m.id != null) console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id,
      result: m.method === 'tools/list' ? { tools: [{ name: process.env.${variable} ?? 'omitted' }] } : {} }));
  });`;
  for (const [ref, expected] of [['$secret:local/' + variable, 'from-file'], ['${env:' + variable + '}', 'from-environment'], [null, 'omitted']]) {
    const config = baseConfig({ mcpSecretsFile: file, mcpServers: { local: {
      managed: true, command: process.execPath, args: ['-e', probe], env: { [variable]: ref },
    } } });
    assert.equal((await createMcpManager(config).listTools('local'))[0].name, expected);
  }
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

test('settings: a secret written or removed keeps the file format, a broken JSON file is left alone', () => {
  const file = path.join(dir, 'editable-secrets.txt');
  const cfg = baseConfig({ mcpSecretsFile: file });
  assert.equal(secretsSource(cfg), 'config:mcpSecretsFile');
  fs.writeFileSync(file, '# mine\nremote/Authorization=old\n');
  assert.equal(setSecret(cfg, 'remote/Authorization', 'Bearer new'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), '# mine\nremote/Authorization=Bearer new\n');
  setSecret(cfg, 'other/token', 't1');
  assert.deepEqual([...loadSecrets(cfg).values()].map((s) => s.name), ['remote/Authorization', 'other/token']);
  deleteSecret(cfg, 'remote/Authorization');
  assert.deepEqual([...loadSecrets(cfg).values()], [{ name: 'other/token', value: 't1' }]);
  fs.writeFileSync(file, '{ "a": "b" }');
  setSecret(cfg, 'c/d', 'x');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 'b', 'c/d': 'x' });
  fs.writeFileSync(file, '{ broken');
  assert.equal(setSecret(cfg, 'c/d', 'x'), false);
  deleteSecret(cfg, 'c/d');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
  assert.throws(() => setSecret(cfg, 'bad name', 'x'), /имя секрета/);
  assert.throws(() => setSecret(cfg, 'c/d', '  '), /пустое/);
});

test('settings: the server list keeps the switch of a server from the settings file and its own servers apart', () => {
  const from = path.join(dir, 'servers.json');
  fs.writeFileSync(from, JSON.stringify({ mcpServers: { remote: { url: 'http://x/mcp' }, local: { command: 'npx', args: ['-y', 'cli'] } } }));
  const list = customServers({
    root: CODE_ROOT,
    mcpServersFrom: from,
    mcpServers: { remote: { enabled: false }, own: { transport: 'stdio', command: 'node', args: ['m.js'] } },
  });
  const byName = Object.fromEntries(list.map((s) => [s.name, s]));
  assert.deepEqual([byName.remote.enabled, byName.remote.fromFile, byName.remote.url], [false, true, 'http://x/mcp']);
  assert.equal(byName.own.fromFile, undefined);
  assert.deepEqual(byName.own.args, ['m.js']);
});

test('settings: the MCP timeouts go out and back in, a bad value is refused', async () => {
  const h = await startTestServer();
  try {
    const s = (await h.api('GET', '/api/settings')).body;
    assert.deepEqual(s.mcp, { acpStartTimeoutMs: 30000, harnessTimeoutMs: 3600000 }, 'the UI edits these two rows');
    const bad = (body) => h.api('PUT', '/api/settings', { mcp: body }).then((r) => r.status);
    assert.equal(await bad({ acpStartTimeoutMs: 999 }), 400);
    assert.equal(await bad({ harnessTimeoutMs: 1.5 }), 400);
    assert.equal(await bad({ somethingElse: 5000 }), 400);
    const saved = (await h.api('PUT', '/api/settings', { mcp: { acpStartTimeoutMs: 5000 } })).body;
    assert.deepEqual(saved.mcp, { acpStartTimeoutMs: 5000, harnessTimeoutMs: 3600000 }, 'only the key given changes');
    assert.deepEqual((await h.api('GET', '/api/settings')).body.mcp, saved.mcp);
  } finally {
    await h.close();
  }
});

test('missing secret: that server reports a problem, the others keep working', async () => {
  const mcp = createMcpManager(baseConfig({ mcpServers: { tracker: { ...MOCK }, broken: { ...MOCK, env: { TOKEN: '$secret:broken/token' } } } }));
  const rows = Object.fromEntries((await mcp.status()).map((r) => [r.name, r]));
  assert.equal(rows.tracker.ok, true, rows.tracker.error);
  assert.equal(rows.broken.ok, false);
  assert.match(rows.broken.problem, /нет секрета broken\/token/);
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
      seen.push({ method: msg.method, session: req.headers['mcp-session-id'], auth: req.headers.authorization, foreign: req.headers['other/authorization'], legacy: req.headers['other_token'], team: req.headers['x-team'] });
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
  fs.writeFileSync(secrets, JSON.stringify({ 'remote/Authorization': 'Bearer s3cret', 'remote_other_TOKEN': 'another', 'remote_other/Authorization': 'private' }));
  process.env.HARNESS_TEST_TEAM = 'core';
  try {
    const mcp = createMcpManager(baseConfig({
      mcpSecretsFile: secrets,
      mcpServers: { remote_other: { enabled: false }, remote: { url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { 'x-team': '${env:HARNESS_TEST_TEAM}' }, timeoutMs: 5000 } },
    }));
    assert.deepEqual((await mcp.listTools('remote')).map((t) => t.name), ['echo']);
    assert.deepEqual(toolResultValue(await mcp.callTool('remote', 'echo', { x: 1 })), { echoed: { x: 1 } });
    assert.deepEqual(seen.map((s) => s.method), ['initialize', 'notifications/initialized', 'tools/list', 'initialize', 'notifications/initialized', 'tools/call']);
    assert.ok(seen.filter((s) => s.method === 'initialize').every((s) => s.session === undefined));
    assert.ok(seen.filter((s) => s.method !== 'initialize').every((s) => s.session === 'sess-1'));
    assert.ok(seen.every((s) => s.auth === 'Bearer s3cret' && s.team === 'core' && !s.foreign && !s.legacy));
    for (const [reference, expected] of [['Bearer ${env:HARNESS_TEST_TEAM}', 'Bearer core'], [null, undefined]]) {
      const cfg = baseConfig({ mcpSecretsFile: secrets, mcpServers: { remote: {
        url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { authorization: reference },
      }, remote_other: { enabled: false } } });
      await createMcpManager(cfg).listTools('remote');
      assert.equal(seen.at(-1).auth, expected);
    }
  } finally {
    server.close();
  }
});

test('http client: a network failure names the reason and the address, not a bare «fetch failed»', async () => {
  const server = http.createServer((req, res) => res.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  await new Promise((r) => server.close(r)); // nothing listens there any more: connect is refused
  const mcp = createMcpManager(baseConfig({ mcpServers: { remote: { url, timeoutMs: 5000 } } }));
  const err = await mcp.listTools('remote').then(() => null, (e) => e);
  assert.ok(err, 'the call fails');
  assert.equal(err.status, 502);
  assert.match(err.message, /MCP remote: сеть — /);
  assert.ok(err.message.includes(url), 'the address that did not answer is in the message');
  assert.doesNotMatch(err.message, /^MCP remote: fetch failed$/, 'the bare fetch message is gone');
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

test('status probes only the servers the harness calls (integrations, its own config), not the rest of the user\'s', async () => {
  const from = path.join(dir, 'gigacode settings.json');
  // java-lsp from the user's GigaCode settings: an agents' server the harness never calls — must not be started
  fs.writeFileSync(from, JSON.stringify({ mcpServers: { 'java-lsp': { command: 'definitely-not-a-command-xyz' } } }));
  const mcp = createMcpManager(baseConfig({ mcpServersFrom: from }));
  assert.deepEqual((await mcp.status()).map((r) => r.name), ['tracker']);
  assert.ok('java-lsp' in serverDefs(baseConfig({ mcpServersFrom: from })), 'still known for scripts/mcp-call.js');
});

test('standalone MCP setup persists, keeps credentials write-only, and reconnects one service', async (t) => {
  const secrets = path.join(dir, 'setup-secrets');
  const source = path.join(dir, 'imported-servers.json');
  const previous = { ...process.env };
  process.env.HARNESS_MCP_SECRETS = secrets;
  process.env.CONSOLE_MCP_SETTINGS = source;
  t.after(() => {
    for (const key of ['HARNESS_MCP_SECRETS', 'CONSOLE_MCP_SETTINGS']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const original = JSON.stringify({ mcpServers: { imported: { command: 'missing-command', env: { Token: 'original-value' } } } });
  fs.writeFileSync(source, original);
  fs.writeFileSync(secrets, '# keep this comment\nonework/Authorization=existing');
  const h = await startTestServer({ mcpServersFrom: source, mcpSecretsFile: secrets });
  try {
    const create = (body) => h.api('POST', '/api/mcp/servers', body);
    const add = { name: 'own', ...MOCK };
    assert.equal((await create(add)).status, 200);
    assert.equal((await create(add)).status, 409);
    assert.equal((await create({ ...add, name: 'imported' })).status, 409);
    assert.equal((await create({ ...add, name: 'constructor' })).status, 400);
    assert.equal((await create({ name: 'bad', transport: 'http', url: 'https://user:password@example.org' })).status, 400);
    assert.equal((await create({ name: 'remote', transport: 'http', url: 'https://example.invalid/mcp' })).status, 200);
    const secret = { key: 'Token', value: 'demo-credential' };
    assert.equal((await h.api('PUT', '/api/mcp/secrets/imported', secret)).status, 200);
    assert.equal((await h.api('PUT', '/api/mcp/secrets/imported', { ...secret, value: 'bad\ninjection' })).status, 400);
    assert.equal(loadSecrets({ mcpSecretsFile: secrets, root: dir }).get('imported_token').value, secret.value);
    assert.match(fs.readFileSync(secrets, 'utf8'), /# keep this comment\nonework\/Authorization=existing/);
    const meta = (await h.api('GET', '/api/mcp/config')).body;
    assert.deepEqual(meta.servers.find((c) => c.name === 'own'), { name: 'own', local: true, editable: true, enabled: true, transport: 'stdio', credentials: [] });
    const bind = (body) => h.api('PUT', '/api/mcp/secrets/imported', { key: 'Token', ...body });
    assert.equal((await bind({ source: 'env', variable: 'NOT A NAME' })).status, 400);
    const local = fs.readFileSync(h.configFile.replace('.json', '.local.json'), 'utf8');
    assert.doesNotMatch(JSON.stringify(meta) + local, /demo-credential|original-value/);
    assert.equal(JSON.parse(local).mcpServers.imported.env.Token, '$secret:imported/Token');
    assert.equal((await bind({ source: 'env', variable: 'HARNESS_TEST_TEAM' })).status, 200);
    const bindings = async () => (await h.api('GET', '/api/mcp/config')).body.servers.find((c) => c.name === 'imported').credentials;
    assert.deepEqual(await bindings(), [{ key: 'Token', variable: 'HARNESS_TEST_TEAM', bearer: false }]);
    assert.equal((await bind({ source: 'none' })).status, 200);
    assert.deepEqual(await bindings(), []);
    assert.equal(fs.readFileSync(source, 'utf8'), original);
    assert.equal((await h.api('PUT', '/api/mcp/servers/imported', MOCK)).status, 400);
    assert.equal((await h.api('PUT', '/api/mcp/servers/own', MOCK)).status, 200);
    const connect = () => h.api('POST', '/api/mcp/servers/own/reconnect');
    assert.equal((await connect()).body.tools.length, 3);
    await h.api('PUT', '/api/mcp/servers/own', { enabled: false });
    const off = await connect();
    assert.equal(off.status, 400, 'a switched-off service is not connected again');
    assert.match(off.body.error, /выключен/);
    assert.equal((await h.api('POST', '/api/mcp/servers/unknown/reconnect')).status, 404);
  } finally { await h.close(); }
});
