#!/usr/bin/env node
// Harness orchestration tools for agents.
//   stdio MCP server (default):  node mcp/harness-mcp.js
//   CLI:                          node mcp/harness-mcp.js call <tool> '<json-args>'
// Connection: HARNESS_URL, HARNESS_TOKEN, HARNESS_SESSION_ID from env; falls back to <repo>/data/server.json + data/token.
// HARNESS_SERVER_JSON (set by the harness): the current URL is read from there on every call, so calls survive a harness
// restart - while it is down (no file, connection refused) calls are retried with backoff (HARNESS_RETRY_MS, default 2 min;
// worker_wait until the run's own timeout).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const PROTOCOL = '2025-06-18';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}

const DOWN = 'harness is not running (restarting?)';

function connection() {
  const dataDir = path.join(repo, 'data');
  let url = process.env.HARNESS_URL;
  if (process.env.HARNESS_SERVER_JSON) {
    // no file = the harness is down: never guess an old port (another process may own it by now)
    try { url = JSON.parse(readFile(process.env.HARNESS_SERVER_JSON)).url; } catch { throw Object.assign(new Error(DOWN), { down: true }); }
  } else if (!url) {
    try { url = JSON.parse(readFile(path.join(dataDir, 'server.json'))).url; } catch {}
  }
  // a server given by its URL and token directly (a test harness, a second instance) keeps its token: the data folder's
  // one belongs to whatever harness runs there, not to this one
  const token = process.env.HARNESS_TOKEN || readFile(path.join(dataDir, 'token'));
  if (!url || !token) throw new Error('Harness is not reachable: set HARNESS_URL and HARNESS_TOKEN or start the harness (data/server.json)');
  return { url: url.replace(/\/$/, ''), token, session: process.env.HARNESS_SESSION_ID || '' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One harness API call. Retried while the harness is down: always when the request never reached it (no server.json,
 * connection refused); with `idempotent`, also when the connection broke mid-request.
 */
export async function api(method, route, body, { idempotent = false, until = Date.now() + (Number(process.env.HARNESS_RETRY_MS) || 120000) } = {}) {
  for (let delay = 250; ; delay = Math.min(delay * 2, 4000)) {
    let res;
    try {
      const c = connection();
      const headers = { 'x-harness-token': c.token, 'content-type': 'application/json' };
      if (c.session) headers['x-harness-session'] = c.session;
      res = await fetch(`${c.url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      const unsent = e.down || e.cause?.code === 'ECONNREFUSED';
      if ((unsent || idempotent) && Date.now() + delay < until) {
        await sleep(delay);
        continue;
      }
      throw e.down ? e : new Error(`harness is not reachable: ${e.cause?.code || e.message}`);
    }
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
}

const SYNC_RUN_TOOLS = new Set(['worker_run', 'agent']);
const WAIT_SLICE_MS = 25000;
// a CLI gives up on a tool call after its own timeout (GigaCode over ACP: «Request timed out», the configured one not
// applied): past this the sub-agent goes to the background and its result comes as a message, never to a dead call
const SYNC_WAIT_MS = (Number(process.env.HARNESS_SYNC_WAIT_MIN) || 5) * 60000;

/**
 * worker_run / agent: the server answers { sessionId } at once; we wait here (long-poll) until the sub-agent reports,
 * sending notifications/progress so the caller's tool call does not time out, and return its result like the
 * built-in agent tool would.
 */
export async function runAndWait(name, args, progressToken, notify = () => {}) {
  const { sessionId } = await api('POST', `/api/agent/${encodeURIComponent(name)}`, args);
  // in the background: nothing to wait for here — the harness brings the result to the caller as a message
  if (args.run_in_background === true || args.background === true) {
    return { status: 'started', sessionId, note: 'The sub-agent works in the background in its own chat; its result will come to you as a message. Go on with your work or end your turn.' };
  }
  const deadline = Date.now() + Math.min(Math.max(Number(args.timeoutMin) || 60, 0) * 60000, SYNC_WAIT_MS);
  for (let tick = 1; ; tick++) {
    const left = deadline - Date.now();
    if (left <= 0) {
      // not «timeout» and a lost result: the harness hands it over (or returns it, if it just finished)
      const r = await api('GET', `/api/agent/worker_wait?sessionId=${encodeURIComponent(sessionId)}&timeoutMs=0&release=1`, undefined, { idempotent: true });
      return { status: r.status, summary: r.summary, sessionId };
    }
    // stateless on the server: after a harness restart the same poll simply continues. release=1: this call is over in
    // this same request — the sub-agent is taken off the waiter only now, so a message to it still ends the call
    const r = await api('GET', `/api/agent/worker_wait?sessionId=${encodeURIComponent(sessionId)}&timeoutMs=${Math.min(WAIT_SLICE_MS, left)}&release=1`, undefined, { idempotent: true, until: deadline });
    if (r.done) return { status: r.status, summary: r.summary, sessionId };
    if (progressToken !== undefined) notify({ method: 'notifications/progress', params: { progressToken, progress: tick, message: `sub-agent ${sessionId}: ${r.status ?? 'running'}` } });
  }
}

/**
 * ask: the question goes out at once; then this call waits (long-poll, progress so it does not time out) for the
 * answer, which the agent gets as the result. Models do not reliably «end the turn» after a question — they went on
 * without the answer. No answer within waitMs (or the turn ended): the old way, the answer comes as the next message.
 */
export async function askAndWait(args, progressToken, notify = () => {}) {
  const sent = await api('POST', '/api/agent/ask', args);
  if (!sent.waitMs) return sent;
  const deadline = Date.now() + sent.waitMs;
  for (let tick = 1; Date.now() < deadline; tick++) {
    const r = await api('GET', `/api/agent/ask_wait?timeoutMs=${Math.min(WAIT_SLICE_MS, deadline - Date.now())}`, undefined, { idempotent: true, until: deadline }).catch(() => ({ done: true }));
    if (r.answer != null) return { answer: r.answer, note: 'This is the answer to your question. Continue the task with it.' };
    if (r.done) break;
    if (progressToken !== undefined) notify({ method: 'notifications/progress', params: { progressToken, progress: tick, message: 'waiting for the answer' } });
  }
  return { delivered: sent.delivered, note: sent.note };
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
          : name === 'ask'
            ? await askAndWait(args, msg.params?._meta?.progressToken, notify)
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

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = !!process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url));
const [cmd, tool, json] = process.argv.slice(2);
if (!isMain) {
  // imported as a module (the mock agent uses api/runAndWait): no CLI, no stdio server
} else if (cmd === 'call') {
  try {
    if (!tool) throw new Error("usage: harness-mcp.js call <tool> '<json-args>'");
    const args = json ? JSON.parse(json) : {};
    const result = SYNC_RUN_TOOLS.has(tool) ? await runAndWait(tool, args, undefined, () => {}) : tool === 'ask' ? await askAndWait(args) : await api('POST', `/api/agent/${encodeURIComponent(tool)}`, args);
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
