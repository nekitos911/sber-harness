// Console-level MCP client: the harness itself calls MCP servers (task tracker, PR service).
// Servers: config.mcpServers merged over the mcpServers of config.mcpServersFrom (~/.gigacode/settings.json,
// env CONSOLE_MCP_SETTINGS). Transports: stdio (newline-delimited JSON-RPC) and streamable HTTP (POST; JSON or
// SSE response; Mcp-Session-Id). Every call connects, initializes, calls and closes (per-call timeout).
// Secrets (docs/ARCHITECTURE.md "Console MCP"): resolved at call time, never logged or returned by an API.
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Agent } from 'undici';
import { deepMerge, expandHome } from './config.js';
import { resolveCommand, endChild, spawnOptions } from './runner.js';

const PROTOCOL = '2025-06-18';
const CLIENT_INFO = { name: 'sber-harness', version: '0.1.0' };
const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };

/** fetch() throws a bare «fetch failed»; the reason (refused, DNS, reset, proxy, expired certificate) is only in `cause`. */
export function networkReason(e) {
  for (let c = e?.cause, depth = 0; c && depth < 4; c = c.cause, depth++) {
    if (typeof c.code === 'string') return c.code === 'CERT_HAS_EXPIRED' ? 'срок сертификата сервера истёк' : c.code;
    const inner = c.errors?.find?.((x) => x?.code || x?.message);
    if (inner) return inner.code || inner.message;
    if (c.message) return c.message;
  }
  return e?.message || String(e);
}

/**
 * The machine's own trust, for a root that is not in Node's bundle: `mcpCa` / `mcpCaFile` (PEM text or a file, one per
 * server or for all) and `rejectUnauthorized` on a server definition (the explicit opt-out). The OS store is trusted by
 * default when it has roots Node's bundle lacks (a corporate root installed by policy — SberCA Root Ext): no PEM file to
 * configure. Returns undefined only when nothing adds to the bundle: plain fetch follows it — passing an explicit `ca`
 * array REPLACES that bundle in undici, so the bundle always comes along with whatever is added.
 */
export function tlsDispatcher(cfg = {}, config = {}, { store = systemRootCertificates() } = {}) {
  const files = [config.mcpCaFile, cfg.caFile].filter(Boolean).map((f) => path.resolve(config.root || process.cwd(), expandHome(f)));
  const pems = [config.mcpCa, cfg.ca].flat().filter((p) => typeof p === 'string' && p.trim());
  const rejectUnauthorized = cfg.rejectUnauthorized !== false;
  const bundle = tlsRootCertificates();
  // the OS store trusts more than Node's bundle (a corporate root installed by policy, like a bank's): trust it by
  // default, as a browser does — no PEM file to hand out to every new user
  const own = new Set(bundle);
  const wider = store.some((c) => !own.has(c));
  if (rejectUnauthorized && !files.length && !pems.length && !wider) return undefined;
  // an explicit ca list replaces undici's trust: the bundle always comes along with the store
  const ca = [...new Set([...store, ...bundle])];
  for (const f of files) {
    const pem = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
    if (!pem.includes('-----BEGIN CERTIFICATE-----')) fail(500, `MCP TLS: в ${f} нет PEM-сертификата`);
    ca.push(pem);
  }
  ca.push(...pems);
  return new Agent({ connect: { ca, rejectUnauthorized } });
}

/** Root certificates Node trusts by itself ({@link tls.rootCertificates}); node:https does not export them. */
export const tlsRootCertificates = () => tls.rootCertificates || [];

/** Roots from the OS store (Windows, macOS, Linux). Node 22.9+ has them; before that the platform store is invisible. */
export const systemRootCertificates = () => {
  try {
    return tls.getCACertificates?.('system') || [];
  } catch {
    return [];
  }
};

/** Tool result -> value: structuredContent, else JSON of the first text content, else that text. */
export function toolResultValue(result) {
  if (result?.structuredContent !== undefined) return unwrapTextEnvelope(result.structuredContent);
  const text = Array.isArray(result?.content) ? result.content.find((c) => c.type === 'text')?.text : undefined;
  if (text === undefined) return result;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  return unwrapTextEnvelope(value);
}

/**
 * Some HTTP servers (onework) report a markdown answer TWICE: as content[{type:"text",text}] and as structuredContent
 * {"result":[{...}]}. The envelope is not data the callers can map, so the inner text (or its JSON) is returned instead;
 * otherwise every markdown parser sees a JSON wrapper and comes out empty.
 */
function unwrapTextEnvelope(value) {
  const inner = Array.isArray(value?.result) && value.result.every((c) => c?.type === 'text') && !Array.isArray(value.content)
    ? value.result.find((c) => typeof c?.text === 'string')?.text
    : undefined;
  if (typeof inner !== 'string') return value;
  try {
    return JSON.parse(inner);
  } catch {
    return inner;
  }
}

// ---- secrets ----

export function secretsFile(config) {
  const fromEnv = process.env.HARNESS_MCP_SECRETS || process.env.CONSOLE_MCP_SECRETS;
  if (fromEnv) return path.resolve(expandHome(fromEnv));
  if (config.mcpSecretsFile) return path.resolve(config.root, expandHome(config.mcpSecretsFile));
  return path.join(config.dataDir, 'mcp-secrets.json');
}

/** Where the secrets file path comes from: an env var wins over the config key, which wins over the default. */
export function secretsSource(config) {
  if (process.env.HARNESS_MCP_SECRETS) return 'env:HARNESS_MCP_SECRETS';
  if (process.env.CONSOLE_MCP_SECRETS) return 'env:CONSOLE_MCP_SECRETS';
  if (config.mcpSecretsFile) return 'config:mcpSecretsFile';
  return 'default';
}

const canon = (name) => String(name).replace(/\//g, '_').toLowerCase();

function scopedSecrets(secrets, owners, server) {
  const own = Object.create(null);
  for (const { name, value } of secrets.values()) {
    const slash = name.indexOf('/');
    const owner = slash >= 0 ? name.slice(0, slash) : owners.find((n) => name.toLowerCase().startsWith(n.toLowerCase() + '_'));
    if (owner?.toLowerCase() === server.toLowerCase()) own[name.slice(owner.length + 1)] = value;
  }
  return own;
}

export function connectionList(config) {
  const defs = serverDefs(config);
  const owners = Object.keys(defs).sort((a, b) => b.length - a.length);
  const secrets = loadSecrets(config);
  return Object.entries(defs).filter(([name]) => name !== 'harness').map(([name, def]) => {
    const fields = def.transport === 'http' ? def.headers : def.env;
    const keys = mergedFields(def.transport, scopedSecrets(secrets, owners, name), fields);
    const credentials = Object.entries(keys).filter(([, v]) => v !== null).map(([key]) => {
      const ref = /^(Bearer )?\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(fields?.[key] ?? '');
      return ref ? { key, variable: ref[2], bearer: !!ref[1] } : { key };
    });
    return { name, enabled: def.enabled, transport: def.transport, local: Object.hasOwn(config.mcpServers, name), editable: config.mcpServers[name]?.managed === true, credentials };
  });
}

function mergedFields(transport, own, configured) {
  // HTTP field names ignore case. Keep the configured spelling and its precedence.
  const fields = new Map();
  for (const [key, value] of Object.entries({ ...own, ...configured })) {
    fields.set(transport === 'http' ? key.toLowerCase() : key, [key, value]);
  }
  return Object.fromEntries(fields.values());
}

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

/** Update one scoped credential without returning values or replacing unrelated entries. */
export function saveServerSecret(config, name, key, value) {
  if (!Object.hasOwn(serverDefs(config), name) || name in Object.prototype || name === 'harness' || !/^[\w.-]+$/.test(name)) fail(404, 'Сервер не найден');
  if (typeof key !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,100}$/.test(key) || key in Object.prototype ||
      typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) fail(400, 'Укажите имя и значение секрета в одну строку');
  const file = secretsFile(config);
  let source = '';
  try { source = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const scoped = name + '/' + key;
  let output;
  if (source.trimStart().startsWith('{')) {
    let map;
    try { map = JSON.parse(source); } catch { fail(400, 'Исправьте JSON в существующем файле секретов'); }
    for (const old of Object.keys(map)) if (canon(old) === canon(scoped)) delete map[old];
    map[scoped] = value;
    output = JSON.stringify(map, null, 2);
  } else {
    const lines = source.trimEnd().split(/\r?\n/);
    const entries = lines.filter((line) => line.trim() && !line.trimStart().startsWith('#'));
    if (entries.length === 1 && !entries[0].includes('=')) lines[lines.indexOf(entries[0])] = 'onework/Authorization=' + entries[0].trim();
    else if (entries.some((line) => line.indexOf('=') <= 0)) fail(400, 'Исправьте строку без имени или значения в файле секретов');
    const kept = lines.filter((line) => !line.includes('=') || canon(line.slice(0, line.indexOf('=')).trim()) !== canon(scoped));
    output = [...kept, scoped + '=' + value].join('\n').trimStart();
  }
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, output + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

/** A new local connection has its own name, so it cannot inherit credentials from a namesake. */
export function connectionDefinition(config, name, body, edit = false) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(name) || name in Object.prototype || name === 'harness') fail(400, 'Имя сервера может содержать буквы латиницы, цифры, точку и дефис');
  if (edit && !config.mcpServers[name]?.managed) fail(400, 'Этот сервер задан во внешней конфигурации');
  if (!edit && Object.keys(serverDefs(config)).some((n) => n.toLowerCase() === name.toLowerCase())) fail(409, 'Сервер с таким именем уже существует');
  if (body.transport === 'http') {
    let url;
    try { url = new URL(body.url); } catch { fail(400, 'Введите полный HTTP(S)-адрес MCP'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /\$/.test(url.href)) fail(400, 'Укажите HTTP(S)-адрес без учётных данных, параметров и фрагмента');
    return { transport: 'http', url: url.href };
  }
  if (body.transport !== 'stdio' || typeof body.command !== 'string' || !body.command.trim() || !Array.isArray(body.args) || !body.args.every((arg) => typeof arg === 'string')) fail(400, 'Укажите команду и аргументы для stdio');
  return { transport: 'stdio', command: body.command.trim(), args: body.args };
}

/** Every secret as MCP_SECRET_<NAME> ("/" -> "_"), for stdio MCP children and agent processes. */
export function secretEnv(config) {
  const env = {};
  for (const { name, value } of loadSecrets(config).values()) env[`MCP_SECRET_${name.replace(/\//g, '_')}`] = value;
  return env;
}

const SECRET_NAME = /^[\w.\-/]{1,80}$/;

/**
 * Adds or replaces one secret in the secrets file, keeping the file's format: a JSON map stays JSON, `name=value`
 * lines stay lines. Returns false when the file is JSON but broken — such a file is never overwritten.
 */
export function setSecret(config, name, value) {
  const clean = String(name).trim();
  if (!SECRET_NAME.test(clean)) fail(400, 'имя секрета: буквы, цифры и . - _ / (например sourcecontrol/Authorization)');
  if (typeof value !== 'string' || !value.trim()) fail(400, 'значение секрета пустое');
  const file = secretsFile(config);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch {}
  let next;
  if (text.trim().startsWith('{')) {
    let map;
    try { map = JSON.parse(text); } catch { return false; }
    next = `${JSON.stringify({ ...map, [clean]: value }, null, 2)}\n`;
  } else {
    const kept = text.split(/\r?\n/).filter((l) => l.trim() && l.split('=')[0].trim() !== clean);
    next = `${[...kept, `${clean}=${value}`].join('\n')}\n`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, { encoding: 'utf8', mode: 0o600 });
  return true;
}

/** Removes one secret by name, keeping the file's format. Missing file or broken JSON: nothing to do. */
export function deleteSecret(config, name) {
  const clean = String(name).trim();
  const file = secretsFile(config);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return; }
  if (text.trim().startsWith('{')) {
    let map;
    try { map = JSON.parse(text); } catch { return; }
    delete map[clean];
    fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    return;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && l.split('=')[0].trim() !== clean);
  fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
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
  const { servers: fromFile } = serversFromFile(config);
  const defs = {};
  for (const name of new Set([...Object.keys(fromFile), ...Object.keys(config.mcpServers || {})])) {
    const cfg = deepMerge(fromFile[name] || {}, config.mcpServers?.[name] || {});
    // gemini/qwen settings format: { type: "http", url, headers } | { httpUrl } | { command, args, env }
    const http = cfg.transport ? cfg.transport === 'http' : /^(http|streamable-http|sse)$/i.test(cfg.type || '') || !!cfg.httpUrl || (!!cfg.url && !cfg.command);
    defs[name] = { ...cfg, name, transport: http ? 'http' : 'stdio', url: cfg.url || cfg.httpUrl, enabled: cfg.enabled !== false };
  }
  return defs;
}

/** `mcpServers` of the agent's own settings file (mcpServersFrom); `error` when that file exists but cannot be read. */
export function serversFromFile(config) {
  const from = process.env.CONSOLE_MCP_SETTINGS || config.mcpServersFrom;
  if (!from) return { path: null, servers: {}, error: null };
  const file = path.resolve(config.root, expandHome(from));
  try {
    return { path: file, servers: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).mcpServers || {}, error: null };
  } catch (e) {
    if (e.code === 'ENOENT') return { path: file, servers: {}, error: null };
    console.error(`[mcp] cannot read mcpServersFrom ${from}: ${e.message}`);
    return { path: file, servers: {}, error: `не читается ${from}: ${e.message}` };
  }
}

/** Servers the person added in the settings screen (config.mcpServers), with their `$secret:` refs left as written. */
export function customServers(config) {
  const fromFile = serversFromFile(config).servers;
  return Object.entries(config.mcpServers || {}).map(([name, cfg]) => {
    // the switch of a server the settings file defines; that file keeps the rest of its setup
    const own = { enabled: cfg.enabled !== false, args: cfg.args || [], headers: cfg.headers || {}, env: cfg.env || {}, ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}) };
    const full = { transport: cfg.transport === 'http' ? 'http' : 'stdio', url: cfg.url || '', command: cfg.command || '', ...own };
    if (!fromFile[name]) return { name, ...full };
    const known = serverDefs(config)[name];
    const local = { ...(cfg.command ? { command: cfg.command } : {}), ...(cfg.url ? { url: cfg.url } : {}), ...(cfg.transport ? { transport: cfg.transport } : {}) };
    return { name, transport: known?.transport || full.transport, url: known?.url || '', command: known?.command || '', ...own, ...local, fromFile: true };
  });
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

  const send = (msg, done) => child.stdin.write(`${JSON.stringify(msg)}\n`, done);
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
    notify: (method, params) => new Promise((resolve) => send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, resolve)),
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

/** Streamable HTTP transport; `getHeaders` lets a not yet saved server be checked with its own headers. */
function httpTransport(name, cfg, getHeaders = () => cfg.headers) {
  let sessionId = null;
  let initialized = false;
  let seq = 0;
  const dispatcher = cfg.dispatcher;

  async function post(body, ms) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...getHeaders() };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (initialized) headers['mcp-protocol-version'] = PROTOCOL;
    let res;
    try {
      res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(ms), ...(dispatcher ? { dispatcher } : {}) });
    } catch (e) {
      // a bare «fetch failed» says nothing about what to fix: name the reason and the address that did not answer
      if (e.name === 'TimeoutError') throw timeoutError(name, body.method, ms);
      throw Object.assign(new Error(`MCP ${name}: сеть — ${networkReason(e)} (${cfg.url})`), { status: 502, network: true });
    }
    sessionId = res.headers.get('mcp-session-id') || sessionId;
    if (!res.ok) {
      await res.body?.cancel();
      throw rpcError(name, { message: `HTTP ${res.status}` });
    }
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
      if (sessionId) fetch(cfg.url, { method: 'DELETE', headers: { 'mcp-session-id': sessionId, ...cfg.headers }, ...(dispatcher ? { dispatcher } : {}) }).catch(() => {});
    },
  };
}

// ---- manager ----

export function createMcpManager(config) {
  /** Server config with secrets applied; throws { problem: true } when a referenced secret is missing. */
  function prepared(name) {
    const defs = serverDefs(config);
    const def = defs[name] || fail(404, `MCP-сервер «${name}» не настроен (mcpServers)`);
    if (!def.enabled) fail(400, `MCP-сервер «${name}» выключен (mcpServers.${name}.enabled)`);
    const secrets = loadSecrets(config);
    // Legacy server_KEY entries use the longest matching server name. A slash gives the owner explicitly.
    const owners = Object.keys(defs).sort((a, b) => b.length - a.length);
    const own = scopedSecrets(secrets, owners, name);
    const resolved = resolveRefs({ env: def.env || {}, headers: def.headers || {}, args: def.args || [], url: def.url || '' }, secrets);
    const http = def.transport === 'http';
    const merged = mergedFields(def.transport, own, http ? resolved.headers : resolved.env);
    // Undefined masks inherited variables when Node constructs the child's environment.
    const injected = Object.fromEntries(Object.entries(merged).filter(([, v]) => !http || v !== null).map(([k, v]) => [k, v ?? undefined]));
    return {
      ...def,
      ...resolved,
      headers: http ? injected : resolved.headers,
      env: http ? resolved.env : { ...(def.managed ? {} : secretEnv(config)), ...injected },
      ...(http ? { dispatcher: tlsDispatcher(def, config) } : {}),
    };
  }

  async function withClient(name, fn) {
    const cfg = prepared(name);
    return await talk(name, cfg, fn);
  }

  /** Connects with an already resolved server config (secrets applied), initializes and closes. */
  async function talk(name, cfg, fn) {
    const ms = cfg.timeoutMs || 15000;
    const t = cfg.transport === 'http' ? httpTransport(name, cfg) : stdioTransport(name, cfg, config.root);
    try {
      await t.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO }, ms);
      await t.notify('notifications/initialized');
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
    /** Connects a definition that is not saved yet (the settings form): same secret scoping and TLS as a saved server. */
    async probe(def) {
      const secrets = loadSecrets(config);
      const owners = Object.keys({ ...serverDefs(config), [def.name]: def }).sort((a, b) => b.length - a.length);
      const own = scopedSecrets(secrets, owners, def.name);
      const http = def.transport === 'http';
      const resolved = resolveRefs({ env: def.env || {}, headers: def.headers || {}, args: def.args || [], url: def.url || '' }, secrets);
      const injected = mergedFields(def.transport, own, http ? resolved.headers : resolved.env);
      const cfg = {
        ...def,
        ...resolved,
        url: resolved.url,
        headers: http ? injected : resolved.headers,
        env: http ? resolved.env : { ...(def.managed ? {} : secretEnv(config)), ...injected },
        ...(http ? { dispatcher: tlsDispatcher(def, config) } : {}),
      };
      const tools = await talk(def.name, cfg, async (request) => {
        const list = [];
        let cursor;
        do {
          const r = await request('tools/list', cursor ? { cursor } : {});
          list.push(...(r?.tools || []));
          cursor = r?.nextCursor;
        } while (cursor);
        return list;
      });
      return tools.map((t) => ({ name: t.name, description: t.description || '' }));
    },
    async status(onlyName) {
      // the harness calls only its integrations' servers and the ones in its own config; the rest of the user's GigaCode
      // servers (mcpServersFrom: java-lsp, …) are the agents' business — not started here on every page load
      const used = new Set([config.integrations?.tasks?.server, config.integrations?.pr?.server, ...Object.keys(config.mcpServers || {})].filter(Boolean));
      const defs = serverDefs(config);
      if (onlyName && (!Object.hasOwn(defs, onlyName) || !used.has(onlyName))) fail(404, 'Сервис не найден');
      return Promise.all(Object.entries(defs).filter(([name]) => used.has(name) && (!onlyName || name === onlyName)).map(async ([name, def]) => {
        const roles = ['tasks', 'pr'].filter((kind) => config.integrations?.[kind]?.server === name);
        const row = { name, roles, enabled: def.enabled, transport: def.transport, ok: false, tools: [] };
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
