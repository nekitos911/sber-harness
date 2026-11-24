// POST /api/mcp/servers/:name/reconnect: a fresh connect by the server's own config (the CLI's /mcp), row or error back.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { startTestServer } from './helpers.js';

const h = await startTestServer({
  mcpServers: {
    tracker: { enabled: true, transport: 'stdio', command: process.execPath, args: ['scripts/mock-mcp.js'], timeoutMs: 15000 },
  },
});

after(() => h.close());

test('reconnect lists the tools the server answers with', async () => {
  const r = await h.api('POST', '/api/mcp/servers/tracker/reconnect');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.enabled, true);
  assert.ok(r.body.tools.length > 0, 'tools listed');
  assert.ok(r.body.tools.some((t) => t.name === 'list_issues'));
});

test('a server that cannot start: the row comes back with the error, not with a failure status', async () => {
  await h.api('PUT', '/api/settings', { mcpServers: [{ name: 'broken', transport: 'stdio', command: 'definitely-not-a-command-xyz' }] });
  const r = await h.api('POST', '/api/mcp/servers/broken/reconnect');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, false);
  assert.ok(String(r.body.error), 'the reason is shown');
});

test('an unknown server is a 404, a switched-off one asks to be switched on', async () => {
  assert.equal((await h.api('POST', '/api/mcp/servers/nope/reconnect')).status, 404);
  await h.api('PUT', '/api/settings', { mcpServers: [{ name: 'off', transport: 'http', url: 'https://example.invalid/mcp', enabled: false }] });
  const r = await h.api('POST', '/api/mcp/servers/off/reconnect');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /выключен/);
});
