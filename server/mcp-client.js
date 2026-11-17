// Console-level MCP client: the harness itself calls MCP servers (task tracker, PR service).
// Transports: stdio (newline-delimited JSON-RPC) and streamable HTTP (POST; JSON or SSE response; Mcp-Session-Id).
// Lazy connect, per-call timeout, secrets ({ "<server>": { env, headers } }) merged from the secrets file.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expandHome } from './config.js';
import { resolveCommand, killTree } from './runner.js';

const PROTOCOL = '2025-06-18';
const CLIENT_INFO = { name: 'sber-harness', version: '0.1.0' };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

/** Tool result -> value: structuredContent, else JSON of the first text content, else that text. */
export function toolResultValue(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = Array.isArray(result?.content) ? result.content.find((c) => c.type === 'text')?.text : undefined;
  if (text === undefined) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function secretsFile(config) {
  if (config.mcpSecretsFile) return path.resolve(config.root, expandHome(config.mcpSecretsFile));
  return process.env.HARNESS_MCP_SECRETS || path.join(config.dataDir, 'mcp-secrets.json');
}

function rpcError(name, err) {
  return Object.assign(new Error(`MCP ${name}: ${err.message || JSON.stringify(err)}`), { status: 502 });
}

function timeoutError(name, method, ms) {
  return Object.assign(new Error(`MCP ${name}: ${method} timed out after ${ms} ms`), { status: 504 });
}

function stdioTransport(name, cfg, root, onDead) {
  const { file, args } = resolveCommand(cfg.command);
  const child = spawn(file, [...args, ...(cfg.args || [])], {
    cwd: cfg.cwd ? path.resolve(root, cfg.cwd) : root,
    env: { ...process.env, ...cfg.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  let seq = 0;
  let buf = '';
  let stderr = '';
  let dead = false;

  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const die = (err) => {
    if (dead) return;
    dead = true;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    onDead();
  };

  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method && msg.id != null) {
        // server -> client request (ping, roots/list, ...): answer so the server does not hang
        send(msg.method === 'ping' ? { jsonrpc: '2.0', id: msg.id, result: {} } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } });
      } else if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(rpcError(name, msg.error));
        else p.resolve(msg.result);
      }
    }
  });
  child.stderr.setEncoding('utf8').on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  child.stdin.on('error', () => {});
  child.on('error', (e) => die(rpcError(name, e)));
  child.on('exit', (code) => die(rpcError(name, { message: `server exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}` })));

  return {
    request(method, params, ms) {
      if (dead) return Promise.reject(rpcError(name, { message: 'server is not running' }));
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(timeoutError(name, method, ms));
        }, ms);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify: (method, params) => send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }),
    close() {
      dead = true;
      child.stdin.end();
      killTree(child.pid);
    },
  };
}

function parseSse(text, id) {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try {
      const msg = JSON.parse(data);
      if (msg.id === id) return msg;
    } catch {}
  }
  return null;
}

function httpTransport(name, cfg) {
  let sessionId = null;
  let initialized = false;
  let seq = 0;

  async function post(body, ms) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...cfg.headers };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (initialized) headers['mcp-protocol-version'] = PROTOCOL;
    let res;
    try {
      res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    } catch (e) {
      throw e.name === 'TimeoutError' ? timeoutError(name, body.method, ms) : rpcError(name, e);
    }
    sessionId = res.headers.get('mcp-session-id') || sessionId;
    if (!res.ok) throw rpcError(name, { message: `HTTP ${res.status}: ${(await res.text()).slice(0, 500)}` });
    if (body.id == null) return null;
    // shortcut: an SSE response is read to its end; streamable-HTTP servers close it after the response.
    const msg = (res.headers.get('content-type') || '').includes('text/event-stream') ? parseSse(await res.text(), body.id) : await res.json();
    if (!msg) throw rpcError(name, { message: 'no JSON-RPC response in the event stream' });
    if (msg.error) throw rpcError(name, msg.error);
    return msg.result;
  }

  return {
    async request(method, params, ms) {
      const result = await post({ jsonrpc: '2.0', id: ++seq, method, params }, ms);
      if (method === 'initialize') initialized = true;
      return result;
    },
    notify: (method, params) => post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, 10000).catch(() => {}),
    close() {
      if (sessionId) fetch(cfg.url, { method: 'DELETE', headers: { 'mcp-session-id': sessionId, ...cfg.headers } }).catch(() => {});
    },
  };
}

function createClient(name, cfg, root) {
  const ms = cfg.timeoutMs || 15000;
  let transport = null;
  let ready = null;

  function connect() {
    const t = cfg.transport === 'http'
      ? httpTransport(name, cfg)
      : stdioTransport(name, cfg, root, () => { if (transport === t) { transport = null; ready = null; } });
    transport = t;
    return t.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO }, ms).then((init) => {
      t.notify('notifications/initialized');
      return t;
    });
  }

  const ensure = () => (ready ||= connect().catch((e) => {
    transport?.close();
    transport = null;
    ready = null;
    throw e;
  }));

  return {
    async listTools() {
      const t = await ensure();
      const tools = [];
      let cursor;
      do {
        const r = await t.request('tools/list', cursor ? { cursor } : {}, ms);
        tools.push(...(r?.tools || []));
        cursor = r?.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(tool, args = {}) {
      const t = await ensure();
      const result = await t.request('tools/call', { name: tool, arguments: args }, ms);
      if (result?.isError) throw rpcError(name, { message: `${tool} failed: ${JSON.stringify(toolResultValue(result))}` });
      return result;
    },
    close() {
      transport?.close();
      transport = null;
      ready = null;
    },
  };
}

/** One lazily-connected client per configured server in config.mcpServers. */
export function createMcpManager(config) {
  const clients = new Map();

  function get(name) {
    const cfg = config.mcpServers?.[name] || fail(404, `MCP server "${name}" is not configured (mcpServers)`);
    if (cfg.enabled === false) fail(400, `MCP server "${name}" is disabled (mcpServers.${name}.enabled)`);
    if (!clients.has(name)) {
      let secrets = {};
      try {
        secrets = JSON.parse(fs.readFileSync(secretsFile(config), 'utf8'))[name] || {};
      } catch {}
      const merged = { ...cfg, env: { ...cfg.env, ...secrets.env }, headers: { ...cfg.headers, ...secrets.headers } };
      clients.set(name, createClient(name, merged, config.root));
    }
    return clients.get(name);
  }

  return {
    get,
    listTools: (name) => get(name).listTools(),
    callTool: (name, tool, args) => get(name).callTool(tool, args),
    async status() {
      return Promise.all(Object.entries(config.mcpServers || {}).map(async ([name, cfg]) => {
        const row = { name, enabled: cfg.enabled !== false, transport: cfg.transport || 'stdio', ok: false, tools: [] };
        if (!row.enabled) return row;
        try {
          row.tools = (await get(name).listTools()).map((t) => ({ name: t.name, description: t.description || '' }));
          row.ok = true;
        } catch (e) {
          row.error = e.message;
        }
        return row;
      }));
    },
    close() {
      for (const c of clients.values()) c.close();
      clients.clear();
    },
  };
}
