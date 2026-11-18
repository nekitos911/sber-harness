// Console-level MCP client: the harness itself calls MCP servers (task tracker, PR service).
// Servers: config.mcpServers merged over the mcpServers of config.mcpServersFrom (~/.gigacode/settings.json,
// env CONSOLE_MCP_SETTINGS). Transports: stdio (newline-delimited JSON-RPC) and streamable HTTP (POST; JSON or
// SSE response; Mcp-Session-Id). Every call connects, initializes, calls and closes (per-call timeout).
// Secrets (docs/ARCHITECTURE.md "Console MCP"): resolved at call time, never logged or returned by an API.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { deepMerge, expandHome } from './config.js';
import { resolveCommand, endChild, spawnOptions } from './runner.js';

const PROTOCOL = '2025-06-18';
const CLIENT_INFO = { name: 'sber-harness', version: '0.1.0' };
const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };

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

// ---- secrets ----

export function secretsFile(config) {
  const fromEnv = process.env.HARNESS_MCP_SECRETS || process.env.CONSOLE_MCP_SECRETS;
  if (fromEnv) return path.resolve(expandHome(fromEnv));
  if (config.mcpSecretsFile) return path.resolve(config.root, expandHome(config.mcpSecretsFile));
  return path.join(config.dataDir, 'mcp-secrets.json');
}

const canon = (name) => String(name).replace(/\//g, '_').toLowerCase();

/** Secrets file -> Map(canonical name -> { name, value }). JSON map, `name=value` lines, or one bare value. */
export function loadSecrets(config) {
  const secrets = new Map();
  let text = '';
  try { text = fs.readFileSync(secretsFile(config), 'utf8').replace(/^﻿/, '').trim(); } catch {}
  const add = (name, value) => {
    if (name && typeof value === 'string') secrets.set(canon(name), { name: name.trim(), value });
  };
  if (text.startsWith('{')) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(text))) add(k, v);
    } catch {
      console.error(`[mcp] secrets file ${secretsFile(config)} is not valid JSON`);
    }
    return secrets;
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (lines.length === 1 && !lines[0].includes('=')) add('onework/Authorization', lines[0]);
  else for (const l of lines) if (l.includes('=')) add(l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim());
  return secrets;
}

/** Every secret as MCP_SECRET_<NAME> ("/" -> "_"), for stdio MCP children and agent processes. */
export function secretEnv(config) {
  const env = {};
  for (const { name, value } of loadSecrets(config).values()) env[`MCP_SECRET_${name.replace(/\//g, '_')}`] = value;
  return env;
}

/** Replaces ${env:NAME}, ${secret:scope/header}, $secret:scope/header in every string of `value`. */
function resolveRefs(value, secrets) {
  if (typeof value === 'string') {
    return value.replace(/\$\{env:([^}]+)\}|\$\{secret:([^}]+)\}|\$secret:([\w.\-/]+)/g, (m, envName, s1, s2) => {
      const name = envName || s1 || s2;
      const v = envName && process.env[envName] !== undefined ? process.env[envName] : secrets.get(canon(name))?.value;
      if (v === undefined) fail(424, `нет секрета ${name}`, { problem: true });
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, secrets)]));
  return value;
}

// ---- server definitions ----

export function serverDefs(config) {
  const from = process.env.CONSOLE_MCP_SETTINGS || config.mcpServersFrom;
  let fromFile = {};
  if (from) {
    try {
      fromFile = JSON.parse(fs.readFileSync(path.resolve(config.root, expandHome(from)), 'utf8').replace(/^﻿/, '')).mcpServers || {};
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[mcp] cannot read mcpServersFrom ${from}: ${e.message}`);
    }
  }
  const defs = {};
  for (const name of new Set([...Object.keys(fromFile), ...Object.keys(config.mcpServers || {})])) {
    const cfg = deepMerge(fromFile[name] || {}, config.mcpServers?.[name] || {});
    // gemini/qwen settings format: { type: "http", url, headers } | { httpUrl } | { command, args, env }
    const http = cfg.transport ? cfg.transport === 'http' : /^(http|streamable-http|sse)$/i.test(cfg.type || '') || !!cfg.httpUrl || (!!cfg.url && !cfg.command);
    defs[name] = { ...cfg, transport: http ? 'http' : 'stdio', url: cfg.url || cfg.httpUrl, enabled: cfg.enabled !== false };
  }
  return defs;
}

// ---- transports ----

function rpcError(name, err) {
  return Object.assign(new Error(`MCP ${name}: ${err.message || JSON.stringify(err)}`), { status: 502 });
}

function timeoutError(name, method, ms) {
  return Object.assign(new Error(`MCP ${name}: ${method} — нет ответа за ${ms} мс`), { status: 504 });
}

function stdioTransport(name, cfg, root) {
  const { file, args } = resolveCommand(cfg.command);
  const child = spawn(file, [...args, ...(cfg.args || [])], spawnOptions({
    cwd: cfg.cwd ? path.resolve(root, cfg.cwd) : root,
    env: { ...process.env, ...cfg.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
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
  child.on('exit', (code) => die(rpcError(name, { message: `сервер завершился с кодом ${code}${stderr ? `: ${stderr.trim()}` : ''}` })));

  return {
    request(method, params, ms) {
      if (dead) return Promise.reject(rpcError(name, { message: 'сервер не запущен' }));
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
      endChild(child); // a late taskkill /T on a reused pid killed the next server we had just spawned
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
    if (!msg) throw rpcError(name, { message: 'в потоке событий нет ответа JSON-RPC' });
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

// ---- manager ----

export function createMcpManager(config) {
  /** Server config with secrets applied; throws { problem: true } when a referenced secret is missing. */
  function prepared(name) {
    const def = serverDefs(config)[name] || fail(404, `MCP-сервер «${name}» не настроен (mcpServers)`);
    if (!def.enabled) fail(400, `MCP-сервер «${name}» выключен (mcpServers.${name}.enabled)`);
    const secrets = loadSecrets(config);
    const own = {}; // "<server>/<Name>" secrets: headers of an http server, env of a stdio server
    const prefix = `${canon(name)}_`;
    for (const [key, { name: secretName, value }] of secrets) {
      if (key.startsWith(prefix)) own[secretName.slice(name.length + 1)] = value;
    }
    const resolved = resolveRefs({ env: def.env || {}, headers: def.headers || {}, args: def.args || [], url: def.url || '' }, secrets);
    const http = def.transport === 'http';
    return {
      ...def,
      ...resolved,
      headers: { ...(http ? own : {}), ...resolved.headers },
      env: { ...secretEnv(config), ...(http ? {} : own), ...resolved.env },
    };
  }

  async function withClient(name, fn) {
    const cfg = prepared(name);
    const ms = cfg.timeoutMs || 15000;
    const t = cfg.transport === 'http' ? httpTransport(name, cfg) : stdioTransport(name, cfg, config.root);
    try {
      await t.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO }, ms);
      t.notify('notifications/initialized');
      return await fn((method, params) => t.request(method, params, ms));
    } finally {
      t.close();
    }
  }

  const seen = new Map(); // server -> tool names of its last tools/list (integrations "auto" checks a tool exists)
  const listTools = (name) => withClient(name, async (request) => {
    const tools = [];
    let cursor;
    do {
      const r = await request('tools/list', cursor ? { cursor } : {});
      tools.push(...(r?.tools || []));
      cursor = r?.nextCursor;
    } while (cursor);
    seen.set(name, tools.map((t) => t.name));
    return tools;
  });

  const callTool = (name, tool, args = {}) => withClient(name, async (request) => {
    const result = await request('tools/call', { name: tool, arguments: args });
    if (result?.isError) throw rpcError(name, { message: `${tool} — ошибка: ${JSON.stringify(toolResultValue(result))}` });
    return result;
  });

  return {
    listTools,
    callTool,
    toolsSeen: (name) => seen.get(name) ?? null,
    async status() {
      return Promise.all(Object.entries(serverDefs(config)).map(async ([name, def]) => {
        const row = { name, enabled: def.enabled, transport: def.transport, ok: false, tools: [] };
        if (!row.enabled) return row;
        try {
          row.tools = (await listTools(name)).map((t) => ({ name: t.name, description: t.description || '' }));
          row.ok = true;
        } catch (e) {
          row.error = e.message;
          if (e.problem) row.problem = e.message;
        }
        return row;
      }));
    },
    close() {}, // connections are per call
  };
}
