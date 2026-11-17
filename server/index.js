// HTTP server: security (Host + token), REST router, WebSocket, static web/dist (or Vite middleware with --dev).
// Usage: node server/index.js [--dev] [--print-config]
// Programmatic: startServer({ root, configOverrides, configFile, dataDir, port, dev })
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadConfig, CODE_ROOT, deepMerge, readJsonFile, findLiteralSecrets, expandHome } from './config.js';
import { createStore, writeAtomic } from './store.js';
import { createBus } from './bus.js';
import { createTasks } from './tasks.js';
import { createSessions, newId } from './sessions.js';
import { createOrchestration } from './orchestration.js';
import * as git from './git.js';
import * as wfs from './fs.js';
import { createMcpManager, loadSecrets, secretsFile, serverDefs } from './mcp-client.js';
import { launchers } from './launchers.js';
import { importTasks, transitionTask } from './integrations/tasks.js';
import { createPullRequest } from './integrations/pr.js';

const MAX_BODY = 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
};
const NO_BUILD_HTML = '<!doctype html><meta charset="utf-8"><title>Harness</title><body style="font-family:sans-serif;padding:2rem"><h1>UI is not built</h1><p>Run <code>npm run build</code> (or start with <code>npm run dev</code>) and reload.</p></body>';
const GRADES = ['default', 'fast', 'review', 'explore'];
const GIT_KEYS = ['defaultBase', 'branchTemplate', 'portBranchTemplate', 'commitTitleTemplate', 'prTitleTemplate'];

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const samePath = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/** Validates `obj` against { field: 'string' | 'string?' | 'boolean?' | 'number?' | 'array?' }. */
function check(obj, spec) {
  for (const [k, t] of Object.entries(spec)) {
    const optional = t.endsWith('?');
    const type = optional ? t.slice(0, -1) : t;
    const v = obj[k];
    if (v === undefined || v === null) {
      if (!optional) fail(400, `${k} is required`);
      continue;
    }
    const ok = type === 'array' ? Array.isArray(v) && v.every((x) => typeof x === 'string') : typeof v === type;
    if (!ok) fail(400, `${k} must be ${type === 'array' ? 'an array of strings' : `a ${type}`}`);
  }
  return obj;
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) return reject(Object.assign(new Error('request body too large'), { status: 413 }));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        const body = JSON.parse(text);
        if (!isObj(body)) throw new Error();
        resolve(body);
      } catch {
        reject(Object.assign(new Error('body must be a JSON object'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data ?? { ok: true });
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

export async function startServer(opts = {}) {
  const root = opts.root || CODE_ROOT;
  const config = loadConfig({ root, overrides: opts.configOverrides, dataDir: opts.dataDir, configFile: opts.configFile });
  const literal = findLiteralSecrets(config);
  if (literal.length) {
    console.warn(`\n!!! WARNING: config values look like literal credentials: ${literal.join(', ')}\n!!! Move them to the secrets file (${secretsFile(config)}) and reference them as $secret:<scope>/<name>.\n`);
  }
  const store = createStore(config.dataDir);
  const db = store.db;
  const bus = createBus();
  let url = '';
  const tasks = createTasks({ store, bus, defaultBase: config.git.defaultBase });
  const sessions = createSessions({ config, store, bus, getUrl: () => url });
  const orch = createOrchestration({ config, store, bus, tasks, sessions });
  const mcp = createMcpManager(config);
  const tokenBuf = Buffer.from(store.token);
  const tokenOk = (t) => typeof t === 'string' && t.length === store.token.length && timingSafeEqual(Buffer.from(t), tokenBuf);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });

  // ---- tracker sync ----
  let tasksProblem = null;
  let syncing = null;
  let syncTimer = null;
  function runSync() {
    syncing ||= importTasks({ config, mcp, tasks })
      .then((r) => {
        tasksProblem = null;
        return r;
      }, (e) => {
        if (e.status !== 501) tasksProblem = { error: e.message, at: Date.now() };
        throw e;
      })
      .finally(() => { syncing = null; });
    return syncing;
  }
  function scheduleSync() {
    clearInterval(syncTimer);
    const cfg = config.integrations.tasks;
    const sec = Number(cfg?.refreshSec) || 0;
    if (!cfg?.enabled || sec <= 0) return;
    // only while a UI is connected; importTasks updates (and so broadcasts) changed tasks only
    syncTimer = setInterval(() => { if (wss.clients.size > 0) runSync().catch(() => {}); }, Math.max(sec, 10) * 1000);
    syncTimer.unref?.();
  }

  // ---- settings: GET/PUT /api/settings, saved into harness.config.local.json ----
  function settingsView() {
    return {
      agents: Object.fromEntries(Object.entries(config.agents).map(([id, a]) => [id, {
        approvalMode: a.approvalMode ?? null,
        approvalModes: a.approvalModes || [],
        model: a.model ?? null,
        modelGrades: a.settings?.agents?.modelGrades || {},
        allowedGrades: a.settings?.agents?.allowedGrades || [],
        taskPromptTemplate: a.taskPromptTemplate ?? null,
      }])),
      defaultAgent: config.defaultAgent,
      git: pick(config.git, GIT_KEYS),
      tasks: { refreshSec: config.integrations.tasks?.refreshSec ?? 0 },
    };
  }

  function agentPatch(id, a) {
    const cur = config.agents[id] || fail(400, `unknown agent "${id}"`);
    if (!isObj(a)) fail(400, `agents.${id} must be an object`);
    const p = {};
    if ('approvalMode' in a) {
      if (typeof a.approvalMode !== 'string' || (cur.approvalModes?.length && !cur.approvalModes.includes(a.approvalMode))) {
        fail(400, `agents.${id}.approvalMode must be one of ${(cur.approvalModes || []).join(', ')}`);
      }
      p.approvalMode = a.approvalMode;
    }
    if ('model' in a) {
      if (a.model !== null && typeof a.model !== 'string') fail(400, `agents.${id}.model must be a string or null`);
      p.model = a.model || null;
    }
    if ('taskPromptTemplate' in a) {
      if (a.taskPromptTemplate !== null && typeof a.taskPromptTemplate !== 'string') fail(400, `agents.${id}.taskPromptTemplate must be a string or null`);
      p.taskPromptTemplate = a.taskPromptTemplate || null;
    }
    if ('modelGrades' in a) {
      if (!isObj(a.modelGrades) || Object.entries(a.modelGrades).some(([g, v]) => !GRADES.includes(g) || (v !== null && typeof v !== 'string'))) {
        fail(400, `agents.${id}.modelGrades: keys ${GRADES.join('/')}, string values`);
      }
      (p.settings ||= { agents: {} }).agents.modelGrades = a.modelGrades;
    }
    if ('allowedGrades' in a) {
      check(a, { allowedGrades: 'array' });
      (p.settings ||= { agents: {} }).agents.allowedGrades = a.allowedGrades;
    }
    return p;
  }

  function saveSettings(body) {
    const patch = {};
    if (body.agents !== undefined) {
      if (!isObj(body.agents)) fail(400, 'agents must be an object');
      patch.agents = Object.fromEntries(Object.entries(body.agents).map(([id, a]) => [id, agentPatch(id, a)]));
    }
    if (body.defaultAgent !== undefined) {
      if (!config.agents[body.defaultAgent]) fail(400, `unknown agent "${body.defaultAgent}"`);
      patch.defaultAgent = body.defaultAgent;
    }
    if (body.git !== undefined) {
      if (!isObj(body.git) || Object.entries(body.git).some(([k, v]) => !GIT_KEYS.includes(k) || typeof v !== 'string' || !v.trim())) {
        fail(400, `git accepts non-empty strings for ${GIT_KEYS.join(', ')}`);
      }
      patch.git = body.git;
    }
    if (body.tasks !== undefined) {
      const sec = body.tasks?.refreshSec;
      if (!Number.isInteger(sec) || sec < 0) fail(400, 'tasks.refreshSec must be an integer >= 0 (0 = off, minimum 10)');
      patch.integrations = { tasks: { refreshSec: sec } };
    }
    const next = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, deepMerge(config[k], v)]));
    for (const [id, a] of Object.entries(next.agents || {})) {
      const tpl = a.taskPromptTemplate;
      if (tpl && !['{taskUrl}', '{key}', '{id}', '{description}'].some((v) => tpl.includes(v))) {
        fail(400, `agents.${id}.taskPromptTemplate must contain one of {taskUrl} {key} {id} {description}`);
      }
    }
    writeAtomic(config.localConfigFile, `${JSON.stringify(deepMerge(readJsonFile(config.localConfigFile), patch), null, 2)}\n`);
    Object.assign(config, next);
    scheduleSync();
    return settingsView();
  }

  // ---- routes ----
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

  const getWs = (id) => db.workspaces.find((w) => w.id === id) || fail(404, `workspace ${id} not found`);
  const emitWorkspaces = () => {
    store.save();
    bus.send({ t: 'workspaces', workspaces: db.workspaces });
  };
  const cwdOf = (q) => check(q, { cwd: 'string' }).cwd;
  function refreshBranch(cwd, branch) {
    for (const s of db.sessions) if (samePath(s.cwd, cwd) && s.branch !== branch) sessions.update(s.id, { branch });
  }

  route('GET', '/api/state', () => ({
    tasks: db.tasks,
    workspaces: db.workspaces,
    sessions: db.sessions,
    notifications: db.notifications,
    agents: Object.entries(config.agents).map(([id, a]) => ({
      id, label: a.label || id, launcher: a.launcher, approvalModes: a.approvalModes || [], approvalMode: a.approvalMode || null, enabled: a.enabled !== false,
    })),
    defaultAgent: config.agents[config.defaultAgent] && config.agents[config.defaultAgent].enabled !== false
      ? config.defaultAgent
      : Object.keys(config.agents).find((id) => config.agents[id].enabled !== false) ?? null,
    shell: { command: config.shell.command },
    integrations: { tasks: !!config.integrations.tasks?.enabled, pr: !!config.integrations.pr?.enabled, tasksProblem },
  }));
  route('GET', '/api/settings', () => settingsView());
  route('PUT', '/api/settings', ({ body }) => saveSettings(body));

  // workspaces
  async function addWorkspace(rawPath, name) {
    const p = path.resolve(rawPath);
    if (!path.isAbsolute(rawPath) || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) fail(400, `not an existing absolute directory: ${rawPath}`);
    const existing = db.workspaces.find((w) => samePath(w.path, p));
    if (existing) return existing;
    const ws = { id: newId('w', 3), name: name?.trim() || path.basename(p), path: p, isGit: await git.isRepo(p) };
    db.workspaces.push(ws);
    emitWorkspaces();
    return ws;
  }
  route('POST', '/api/workspaces', ({ body }) => {
    check(body, { path: 'string', name: 'string?' });
    return addWorkspace(body.path, body.name);
  });
  // config.workspaces: { root, repos } — repos are names under root (or absolute paths); empty repos = every git repo directly under root
  {
    const { root = null, repos = [] } = config.workspaces || {};
    const list = repos.length ? repos.map((r) => (path.isAbsolute(r) ? r : path.join(root || '', r)))
      : root && fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, '.git'))).map((d) => path.join(root, d.name))
        : [];
    for (const p of list) await addWorkspace(p).catch((e) => console.warn(`workspaces: skip ${p}: ${e.message}`));
  }
  route('DELETE', '/api/workspaces/:id', ({ params }) => {
    getWs(params.id);
    db.workspaces = db.workspaces.filter((w) => w.id !== params.id);
    emitWorkspaces();
  });
  route('GET', '/api/workspaces/:id/worktrees', ({ params }) => git.worktrees(getWs(params.id).path));
  route('POST', '/api/workspaces/:id/worktrees', async ({ params, body }) => {
    const ws = getWs(params.id);
    check(body, { name: 'string', base: 'string?' });
    const start = body.base ? (await git.startPoint(ws.path, body.base)) || body.base : null;
    return git.addWorktree(ws.path, { branch: git.sanitizeBranch(body.name), start, worktreeRoot: config.worktreeRoot });
  });
  route('DELETE', '/api/workspaces/:id/worktrees', async ({ params, body }) => {
    const ws = getWs(params.id);
    check(body, { path: 'string', force: 'boolean?' });
    await git.removeWorktree(ws.path, body.path);
  });

  // tasks
  route('POST', '/api/tasks/sync', () => runSync());
  route('POST', '/api/tasks', ({ body }) => tasks.create(pick(body, ['title', 'description', 'status', 'priority', 'deps', 'labels', 'workspaceId', 'parentId', 'targets'])));
  // a human editing the status pins the column: tracker sync no longer moves the card
  route('PATCH', '/api/tasks/:id', ({ params, body }) => tasks.update(params.id, 'status' in body ? { ...body, statusManual: true } : body));
  route('DELETE', '/api/tasks/:id', ({ params }) => tasks.remove(params.id));
  route('POST', '/api/tasks/:id/move', ({ params, body }) => {
    check(body, { status: 'string', beforeId: 'string?' });
    return tasks.move(params.id, body.status, body.beforeId || null);
  });
  route('POST', '/api/tasks/:id/assign', ({ params, body }) => {
    check(body, { agent: 'string?', workspaceId: 'string?', cwd: 'string?', worktree: 'string?', sessionId: 'string?' });
    return orch.assign(params.id, body);
  });
  route('POST', '/api/tasks/:id/start', ({ params, body }) => orch.start(params.id, check(body, { agent: 'string?', notes: 'string?' })));
  route('POST', '/api/tasks/:id/port', ({ params, body }) => {
    check(body, { target: 'string', agent: 'string?' });
    return orch.port(params.id, body.target, { agent: body.agent });
  });
  route('POST', '/api/tasks/:id/tracker-status', ({ params, body }) => {
    check(body, { status: 'string', comment: 'string?' });
    return transitionTask({ config, mcp, tasks, task: tasks.get(params.id), status: body.status, comment: body.comment || '' });
  });

  // sessions
  route('POST', '/api/sessions', ({ body }) => sessions.create(pick(body, ['kind', 'agent', 'cwd', 'workspaceId', 'title', 'prompt', 'role', 'approvalMode', 'model', 'command'])));
  route('PATCH', '/api/sessions/:id', ({ params, body }) => sessions.patch(params.id, body));
  route('DELETE', '/api/sessions/:id', ({ params }) => sessions.remove(params.id));
  route('GET', '/api/sessions/:id/messages', ({ params }) => sessions.messages(params.id));
  route('POST', '/api/sessions/:id/messages', ({ params, body }) => sessions.deliver(params.id, { from: 'user', text: check(body, { text: 'string' }).text }));
  route('POST', '/api/sessions/:id/stop', ({ params }) => sessions.stop(params.id));
  route('POST', '/api/sessions/:id/restart', ({ params }) => sessions.restart(params.id));
  route('GET', '/api/sessions/:id/log', ({ params }) => sessions.logTail(params.id));
  route('GET', '/api/sessions/:id/subagents', ({ params }) => sessions.subagents(params.id));

  // git
  route('GET', '/api/git/status', async ({ query }) => {
    const st = await git.status(cwdOf(query));
    refreshBranch(query.cwd, st.branch);
    return st;
  });
  route('GET', '/api/git/diff', ({ query }) => git.diff(cwdOf(query), query.path || undefined));
  route('GET', '/api/git/log', ({ query }) => git.log(cwdOf(query), Math.min(Math.max(Number(query.n) || 50, 1), 1000)));
  route('GET', '/api/git/suggest', ({ query }) => orch.gitSuggest(cwdOf(query)));
  route('POST', '/api/git/commit', ({ body }) => {
    check(body, { cwd: 'string', message: 'string', paths: 'array?' });
    return git.commit(body.cwd, body.message, body.paths);
  });
  route('POST', '/api/git/push', ({ body }) => git.push(check(body, { cwd: 'string' }).cwd));
  route('POST', '/api/git/pr', async ({ body }) => {
    check(body, { cwd: 'string', title: 'string', body: 'string?', base: 'string?' });
    if (!config.integrations.pr?.enabled) fail(501, 'PR creation is disabled (integrations.pr.enabled)');
    const branch = (await git.currentBranch(body.cwd)) || fail(400, 'cwd is not on a branch');
    return createPullRequest({
      config, mcp, cwd: body.cwd, branch, base: body.base || config.git.defaultBase,
      title: body.title, body: body.body || '', repo: await git.repoName(body.cwd),
    });
  });

  // files
  route('GET', '/api/fs/list', ({ query }) => wfs.list(cwdOf(query), query.path || ''));
  route('GET', '/api/fs/file', ({ query }) => wfs.readFile(cwdOf(query), check(query, { path: 'string' }).path));
  route('PUT', '/api/fs/file', ({ body }) => {
    check(body, { cwd: 'string', path: 'string', content: 'string' });
    return wfs.writeFile(body.cwd, body.path, body.content);
  });

  // mcp, notifications
  route('GET', '/api/mcp/servers', () => mcp.status());
  route('POST', '/api/notifications/read-all', () => {
    for (const n of db.notifications) {
      if (!n.read) {
        n.read = true;
        bus.send({ t: 'notify', n });
      }
    }
    store.save();
  });
  route('POST', '/api/notifications/:id/read', ({ params }) => {
    const n = db.notifications.find((x) => x.id === params.id) || fail(404, `notification ${params.id} not found`);
    n.read = true;
    store.save();
    bus.send({ t: 'notify', n });
    return n;
  });

  // agent-facing orchestration API
  route('GET', '/api/agent/tools', () => orch.tools);
  route('POST', '/api/agent/:tool', ({ params, body, req }) => orch.call(params.tool, body, req.headers['x-harness-session'] || null));

  // ---- http ----
  let vite = null;
  const distDir = path.join(root, 'web', 'dist');
  const injectToken = (html) => html.replace('</head>', `<meta name="harness-token" content="${store.token}"></head>`);

  function sendHtml(res, html) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  async function serveIndex(res, pathname) {
    if (vite) {
      const html = await vite.transformIndexHtml(pathname, fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8'));
      return sendHtml(res, injectToken(html));
    }
    const index = path.join(distDir, 'index.html');
    sendHtml(res, fs.existsSync(index) ? injectToken(fs.readFileSync(index, 'utf8')) : NO_BUILD_HTML);
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    let file;
    try {
      file = path.join(distDir, decodeURIComponent(pathname));
    } catch {
      return sendJson(res, 400, { error: 'bad path' });
    }
    const rel = path.relative(distDir, file);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && rel !== 'index.html' && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
      return fs.createReadStream(file).pipe(res);
    }
    if (path.extname(pathname) && pathname !== '/index.html') return sendJson(res, 404, { error: 'not found' });
    return serveIndex(res, pathname);
  }

  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (!allowed.includes(String(req.headers.host).toLowerCase())) return sendJson(res, 403, { error: 'forbidden host' });
    let u;
    try {
      u = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'bad url' });
    }
    try {
      if (u.pathname === '/api' || u.pathname.startsWith('/api/')) {
        if (!tokenOk(req.headers['x-harness-token'])) return sendJson(res, 401, { error: 'missing or invalid x-harness-token' });
        const candidates = routes.map((r) => ({ r, m: u.pathname.match(r.re) })).filter((x) => x.m);
        if (!candidates.length) return sendJson(res, 404, { error: `no route ${u.pathname}` });
        const hit = candidates.find((x) => x.r.method === req.method);
        if (!hit) return sendJson(res, 405, { error: 'method not allowed' });
        const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);
        const params = Object.fromEntries(Object.entries(hit.m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
        const result = await hit.r.handler({ req, body, params, query: Object.fromEntries(u.searchParams) });
        return sendJson(res, 200, result);
      }
      if (vite) {
        return vite.middlewares(req, res, (err) => (err ? sendJson(res, 500, { error: err.message }) : serveIndex(res, u.pathname).catch((e) => sendJson(res, 500, { error: e.message }))));
      }
      return serveStatic(req, res, u.pathname);
    } catch (e) {
      const status = Number.isInteger(e.status) ? e.status : 500;
      if (!Number.isInteger(e.status)) console.error(`[harness] ${req.method} ${u.pathname}:`, e);
      if (!res.headersSent) sendJson(res, status, { error: e.message || String(e) });
      else res.end();
    }
  });

  // ---- websocket ----
  server.on('upgrade', (req, socket, head) => {
    let u;
    try {
      u = new URL(req.url, 'http://localhost');
    } catch {
      return socket.destroy();
    }
    if (u.pathname !== '/ws') {
      if (!vite) socket.destroy(); // with --dev, Vite's HMR server handles its own upgrade requests
      return;
    }
    const port = server.address()?.port;
    const host = String(req.headers.host).toLowerCase();
    const hostOk = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);
    let originOk = true;
    if (req.headers.origin) {
      try { originOk = new URL(req.headers.origin).host.toLowerCase() === host; } catch { originOk = false; }
    }
    if (!hostOk || !originOk || !tokenOk(u.searchParams.get('token'))) {
      socket.write(`HTTP/1.1 ${hostOk && originOk ? '401 Unauthorized' : '403 Forbidden'}\r\nConnection: close\r\n\r\n`);
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    const attached = new Set();
    const send = (frame) => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        ws.send(JSON.stringify(frame));
      } catch {} // a socket closing mid-send must not break the broadcast to the others
    };
    const unsubscribe = bus.subscribe((frame) => {
      if (frame.t === 'term' && !attached.has(frame.id)) return;
      send(frame);
    });
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!m || typeof m.id !== 'string' || !sessions.find(m.id)) return;
      if (m.t === 'term.attach') {
        attached.add(m.id);
        send({ t: 'term.replay', id: m.id, data: sessions.termReplay(m.id) });
      } else if (m.t === 'term.detach') attached.delete(m.id);
      else if (m.t === 'term.in') sessions.termInput(m.id, m.data);
      else if (m.t === 'term.resize') sessions.termResize(m.id, m.cols, m.rows);
    });
    ws.on('close', unsubscribe);
    ws.on('error', () => {});
  });

  if (opts.dev) {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.js'),
      root: path.join(root, 'web'),
      server: { middlewareMode: true, hmr: { server } },
      appType: 'custom',
    });
  }

  const port = opts.port ?? config.port ?? 4777;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  url = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${actualPort}`;
  const serverJson = path.join(config.dataDir, 'server.json');
  writeAtomic(serverJson, JSON.stringify({ url, pid: process.pid }));
  scheduleSync();

  let closed = false;
  return {
    url,
    port: actualPort,
    token: store.token,
    config,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(syncTimer);
      sessions.close();
      mcp.close();
      for (const c of wss.clients) c.terminate();
      wss.close();
      await vite?.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      store.close();
      try {
        if (JSON.parse(fs.readFileSync(serverJson, 'utf8')).pid === process.pid) fs.rmSync(serverJson, { force: true });
      } catch {}
    },
  };
}

/** Resolved config for humans: paths and whether they exist, modes, refresh, secret NAMES (never values). */
export function describeConfig(config) {
  const ex = (p) => (p ? { path: p, exists: fs.existsSync(p) } : null);
  const from = process.env.CONSOLE_MCP_SETTINGS || config.mcpServersFrom;
  return {
    configFile: ex(config.configFile),
    localConfigFile: ex(config.localConfigFile),
    dataDir: ex(config.dataDir),
    worktreeRoot: config.worktreeRoot ?? null,
    defaultAgent: config.defaultAgent,
    agents: Object.fromEntries(Object.entries(config.agents).map(([id, a]) => {
      let resolved;
      try {
        const r = launchers[a.launcher]?.resolve(a);
        resolved = r ? { file: ex(r.file), args: r.args } : { error: `unknown launcher "${a.launcher}"` };
      } catch (e) {
        resolved = { error: e.message };
      }
      return [id, { launcher: a.launcher, enabled: a.enabled !== false, approvalMode: a.approvalMode ?? null, approvalModes: a.approvalModes || [], resolved }];
    })),
    tasks: { enabled: !!config.integrations.tasks?.enabled, server: config.integrations.tasks?.server ?? null, refreshSec: config.integrations.tasks?.refreshSec ?? 0 },
    mcpServersFrom: from ? ex(path.resolve(config.root, expandHome(from))) : null,
    mcpServers: Object.keys(serverDefs(config)),
    secretsFile: ex(secretsFile(config)),
    secretNames: [...loadSecrets(config).values()].map((x) => x.name),
    literalSecretWarnings: findLiteralSecrets(config),
  };
}

const isMain = process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1]);
if (isMain && process.argv.includes('--print-config')) {
  console.log(JSON.stringify(describeConfig(loadConfig()), null, 2));
} else if (isMain) {
  const dev = process.argv.includes('--dev');
  startServer({ dev }).then((srv) => {
    console.log(`Harness running at ${srv.url}${dev ? ' (dev, Vite middleware)' : ''}`);
    const shutdown = () => srv.close().finally(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }, (e) => {
    console.error(`Harness failed to start: ${e.message}`);
    process.exit(1);
  });
}
