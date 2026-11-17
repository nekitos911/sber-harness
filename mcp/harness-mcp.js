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

const SYNC_RUN_TOOLS = new Set(['worker_run', 'agent']);
const WAIT_SLICE_MS = 25000;

/**
 * worker_run / agent: the server answers { sessionId } at once; we wait here (long-poll) until the sub-agent reports,
 * sending notifications/progress so the caller's tool call does not time out, and return its result like the
 * built-in agent tool would.
 */
async function runAndWait(name, args, progressToken, notify) {
  const { sessionId } = await api('POST', `/api/agent/${encodeURIComponent(name)}`, args);
  const deadline = Date.now() + Math.max(Number(args.timeoutMin) || 60, 0) * 60000;
  for (let tick = 1; ; tick++) {
    const left = deadline - Date.now();
    if (left <= 0) return { status: 'timeout', sessionId };
    const r = await api('GET', `/api/agent/worker_wait?sessionId=${encodeURIComponent(sessionId)}&timeoutMs=${Math.min(WAIT_SLICE_MS, left)}`);
    if (r.done) return { status: r.status, summary: r.summary, sessionId };
    if (progressToken !== undefined) notify({ method: 'notifications/progress', params: { progressToken, progress: tick, message: `sub-agent ${sessionId}: ${r.status ?? 'running'}` } });
  }
}

async function handle(msg, notify = () => {}) {
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
        const args = msg.params?.arguments ?? {};
        const result = SYNC_RUN_TOOLS.has(name)
          ? await runAndWait(name, args, msg.params?._meta?.progressToken, notify)
          : await api('POST', `/api/agent/${encodeURIComponent(name)}`, args);
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
      write({ jsonrpc: '2.0', id: msg.id, result: await handle(msg, (n) => write({ jsonrpc: '2.0', ...n })) });
    } catch (e) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } });
    }
  });
}

const [cmd, tool, json] = process.argv.slice(2);
if (cmd === 'call') {
  try {
    if (!tool) throw new Error("usage: harness-mcp.js call <tool> '<json-args>'");
    const args = json ? JSON.parse(json) : {};
    const result = SYNC_RUN_TOOLS.has(tool) ? await runAndWait(tool, args, undefined, () => {}) : await api('POST', `/api/agent/${encodeURIComponent(tool)}`, args);
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
