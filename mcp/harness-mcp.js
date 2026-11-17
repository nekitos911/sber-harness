#!/usr/bin/env node
// Harness orchestration tools for agents.
//   stdio MCP server (default):  node mcp/harness-mcp.js
//   CLI:                          node mcp/harness-mcp.js call <tool> '<json-args>'
// Connection: HARNESS_URL, HARNESS_TOKEN, HARNESS_SESSION_ID from env; falls back to <repo>/data/server.json + data/token.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const PROTOCOL = '2025-06-18';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}

function connection() {
  const dataDir = path.join(repo, 'data');
  let url = process.env.HARNESS_URL;
  if (!url) {
    try { url = JSON.parse(readFile(path.join(dataDir, 'server.json'))).url; } catch {}
  }
  const token = process.env.HARNESS_TOKEN || readFile(path.join(dataDir, 'token'));
  if (!url || !token) throw new Error('Harness is not reachable: set HARNESS_URL and HARNESS_TOKEN or start the harness (data/server.json)');
  return { url: url.replace(/\/$/, ''), token, session: process.env.HARNESS_SESSION_ID || '' };
}

async function api(method, route, body) {
  const c = connection();
  const headers = { 'x-harness-token': c.token, 'content-type': 'application/json' };
  if (c.session) headers['x-harness-session'] = c.session;
  const res = await fetch(`${c.url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      return { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'harness', version: '0.1.0' } };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: await api('GET', '/api/agent/tools') };
    case 'tools/call': {
      const name = msg.params?.name;
      try {
        const result = await api('POST', `/api/agent/${encodeURIComponent(name)}`, msg.params?.arguments ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false };
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
  }
}

function serveStdio() {
  const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (msg.id === undefined || msg.id === null) return; // notification (e.g. notifications/initialized)
    try {
      write({ jsonrpc: '2.0', id: msg.id, result: await handle(msg) });
    } catch (e) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } });
    }
  });
}

const [cmd, tool, json] = process.argv.slice(2);
if (cmd === 'call') {
  try {
    if (!tool) throw new Error("usage: harness-mcp.js call <tool> '<json-args>'");
    const result = await api('POST', `/api/agent/${encodeURIComponent(tool)}`, json ? JSON.parse(json) : {});
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
} else if (cmd === 'tools') {
  console.log(JSON.stringify(await api('GET', '/api/agent/tools'), null, 2));
} else {
  serveStdio();
}
