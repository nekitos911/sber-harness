// HTTP server: security (Host + token), REST router, WebSocket, static web/dist (or Vite middleware with --dev).
// Usage: node server/index.js [--dev] [--print-config]
// Programmatic: startServer({ root, configOverrides, configFile, dataDir, port, dev })
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn as spawnProcess } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { loadConfig, CODE_ROOT, deepMerge, readJsonFile, findLiteralSecrets, expandHome, normalizeModels } from './config.js';
import { createStore, writeAtomic } from './store.js';
import { createBus } from './bus.js';
import { createTasks, STATUSES } from './tasks.js';
import { createSessions, newId } from './sessions.js';
import { createOrchestration, commonDir } from './orchestration.js';
import * as git from './git.js';
import * as wfs from './fs.js';
import { createMcpManager, loadSecrets, secretsFile, serverDefs } from './mcp-client.js';
import { launchers, gigacodeCommand } from './launchers.js';
import { isAlive } from './runner.js';
import { createModelCatalog, scanModelRefs } from './models.js';
import { readSdd } from './sdd.js';
import { createHistory, historyMessages } from './history.js';
import { runJob, jobStep, JOB_ID_RE } from './jobs.js';
import { DEMO_PORT, demoOverrides, seedDemoRepos, seedDemoTasks } from './demo.js';
import { importTasks, importIssue, transitionTask, getExternal, getTransitions, importChildren, syncColumn } from './integrations/tasks.js';
import { createPullRequest, prStatus, refreshTaskPr, declinePullRequest } from './integrations/pr.js';

const MAX_BODY = 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
};
const NO_BUILD_HTML = '<!doctype html><meta charset="utf-8"><title>Harness</title><body style="font-family:sans-serif;padding:2rem"><h1>UI is not built</h1><p>Run <code>npm run build</code> (or start with <code>npm run dev</code>) and reload.</p></body>';
const GRADES = ['default', 'fast', 'review', 'explore'];
// optional API groups this server implements (docs/ARCHITECTURE.md "Feature flags"); a flag ships with its route
export const FEATURES = ['branches', 'fs-search', 'pr-status', 'agent-info', 'models-refresh', 'tracker-links', 'board-columns', 'review-loop',
  'subagents', 'virtual-sessions', 'worker-run', 'skills-install', 'demo', 'worktree-meta', 'open', 'sdd', 'health', 'folders', 'include-dirs', 'questions', 'permissions', 'activity', 'rework', 'fs-raw', 'tracker-import', 'pr-decline', 'task-suggest', 'recovery', 'acp', 'worktree-lazy', 'cli-history'];
// titles of operations the UI may follow by sending x-job-id (WS { t: 'job' } frames)
const JOB_TITLES = {
  'POST /api/tasks/sync': 'Синхронизация с трекером',
  'POST /api/tasks/:id/start': 'Взять в работу',
  'POST /api/tasks/:id/rework': 'Доработка',
  'POST /api/tasks/:id/port': 'Перенос в другую ветку',
  'POST /api/tasks/:id/import-children': 'Импорт подзадач',
  'POST /api/git/pr': 'Создание PR',
  'POST /api/git/push': 'git push',
  'POST /api/git/checkout': 'Переключение ветки',
  'DELETE /api/workspaces/:id/worktrees': 'Удаление рабочего дерева',
  'POST /api/agents/:id/models/refresh': 'Обновление списка моделей',
};
const GIT_KEYS = ['defaultBase', 'branchTemplate', 'portBranchTemplate', 'commitTitleTemplate', 'prTitleTemplate'];
const TASK_VARS = ['{taskUrl}', '{key}', '{id}', '{description}'];
const hasTaskVar = (tpl) => TASK_VARS.some((v) => tpl.includes(v));

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

/** At most n async jobs at a time (git processes for many worktrees). */
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const samePath = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/** Validates `obj` against { field: 'string' | 'string?' | 'boolean?' | 'number?' | 'array?' }. */
function check(obj, spec) {
  for (const [k, t] of Object.entries(spec)) {
    const optional = t.endsWith('?');
    const type = optional ? t.slice(0, -1) : t;
    const v = obj[k];
    if (v === undefined || v === null) {
      if (!optional) fail(400, `нужен параметр ${k}`);
      continue;
    }
    const ok = type === 'array' ? Array.isArray(v) && v.every((x) => typeof x === 'string') : typeof v === type;
    if (!ok) fail(400, `${k}: нужен ${type === 'array' ? 'массив строк' : `тип ${type}`}`);
  }
  return obj;
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) return reject(Object.assign(new Error('слишком большой запрос'), { status: 413 }));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('слишком большой запрос'), { status: 413 }));
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
        reject(Object.assign(new Error('тело запроса должно быть JSON-объектом'), { status: 400 }));
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
  let overrides = opts.configOverrides;
  let dataDir = opts.dataDir;
  if (opts.demo) {
    // offline demo: its own data dir and port, mock agent + fixture MCP servers, seeded repositories and tasks
    dataDir = path.resolve(root, dataDir || 'data-demo');
    overrides = deepMerge(demoOverrides(root, dataDir), overrides || {});
    seedDemoRepos(dataDir);
  }
  const config = loadConfig({ root, overrides, dataDir, configFile: opts.configFile });
  const literal = findLiteralSecrets(config);
  if (literal.length) {
    console.warn(`\n!!! WARNING: config values look like literal credentials: ${literal.join(', ')}\n!!! Move them to the secrets file (${secretsFile(config)}) and reference them as $secret:<scope>/<name>.\n`);
  }
  const serverJson = path.join(config.dataDir, 'server.json');
  await assertSingleInstance(serverJson, config.dataDir);
  const crashed = fs.existsSync(serverJson); // a clean shutdown removes it
  const store = createStore(config.dataDir);
  const db = store.db;
  const bus = createBus();
  store.onNotice = (n) => bus.send({ t: 'notify', n }); // e.g. a transcript restored from its .bak
  let url = '';
  const tasks = createTasks({ store, bus, defaultBase: config.git.defaultBase });
  const catalog = createModelCatalog({ config, store, getUrl: () => url });
  const sessions = createSessions({ config, store, bus, getUrl: () => url, catalog, crashed });
  const orch = createOrchestration({ config, store, bus, tasks, sessions });
  const mcp = createMcpManager(config);
  const tokenBuf = Buffer.from(store.token);
  const tokenOk = (t) => typeof t === 'string' && t.length === store.token.length && timingSafeEqual(Buffer.from(t), tokenBuf);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });

  // ---- repository auto-fill: task.suggestedWorkspaceId while workspaceId is empty ----
  const tokensOf = (text) => new Set(String(text || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean));
  tasks.setSuggester((task) => {
    const repos = db.workspaces.filter((w) => !w.kind);
    if (!repos.length) return null;
    const f = task.externalFields || {};
    const attrs = ['Component', 'Компонент', 'Repository', 'Репозиторий', 'Сервис', 'Service'].map((k) => f[k]).filter(Boolean);
    const words = tokensOf([task.title, task.description, ...attrs].join(' '));
    const stem = (n) => n.replace(/-service$/, '');
    const names = (w) => [...new Set([w.name, path.basename(w.path)].map((n) => n.toLowerCase()))];
    // high: the repo name, or its -service stem, as a whole token in the tracker fields / title / description
    for (const w of repos) {
      const n = names(w).find((x) => words.has(x) || [...words].some((t) => t !== x && stem(t) === stem(x) && (t.endsWith('-service') || x.endsWith('-service'))));
      if (n) return { id: w.id, confidence: 'high', reason: `«${n}» в задаче` };
    }
    // low: a guess, shown but never used without the user
    const prefix = String(task.externalId || '').match(/^([A-Z][A-Z0-9_]*)-\d+$/)?.[1];
    const last = prefix && db.prefs?.lastWorkspaceBySpace?.[prefix];
    if (last && repos.some((w) => w.id === last)) return { id: last, confidence: 'low', reason: `последний репозиторий задач ${prefix}` };
    if (repos.length === 1) return { id: repos[0].id, confidence: 'low', reason: 'единственный репозиторий' };
    return null;
  });

  // worktrees an agent creates for a task started in the projects folder are linked to the task (every 30 s while such a
  // session runs; also on every worktree list refresh)
  const linkTimer = setInterval(() => {
    if (db.sessions.some((s) => s.atRoot && s.status === 'running')) orch.linkAgentWorktrees().catch(() => {});
  }, 30000);
  linkTimer.unref?.();

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

  /** Tracker writes are explicit and never silent: a failure keeps the board as is, logs ⚠ on the task and notifies. */
  async function trackerWrite(task, what, fn) {
    try {
      await fn();
    } catch (e) {
      tasks.addLog(task.id, 'harness', `⚠ Трекер: не удалось (${what}): ${e.message}`, 'tracker_transition', { error: e.message });
      orch.notify({ kind: 'error', taskId: task.id, text: `${tasks.key(task)}: трекер — не удалось (${what}): ${e.message}` });
    }
  }

  const tracksTracker = (task) => !!(config.integrations.tasks?.enabled && task?.externalId);

  /** "Take into work": integrations.tasks.onStartTransition (explicit id) or, with board.moveSyncsTracker, the in_progress column. */
  async function trackerOnStart(task) {
    if (!tracksTracker(task)) return;
    const transition = config.integrations.tasks.onStartTransition;
    if (transition) {
      return trackerWrite(task, `переход «${transition}»`, () => transitionTask({ config, mcp, tasks, task, transition, status: transition, comment: 'Взято в работу через harness' }));
    }
    if (config.board?.moveSyncsTracker) return trackerWrite(task, 'синхронизация в «in_progress»', () => syncColumn({ config, mcp, tasks, task, status: 'in_progress' }));
  }

  // ---- PR status of tasks (observe-only) ----
  let prTimer = null;
  let prRefreshing = false;
  async function refreshPrs() {
    if (prRefreshing) return;
    prRefreshing = true;
    try {
      for (const t of db.tasks) {
        const ws = t.branch && db.workspaces.find((w) => w.id === t.workspaceId);
        if (ws) await refreshTaskPr({ config, mcp, tasks, task: t, cwd: ws.path }).catch(() => {});
      }
    } finally {
      prRefreshing = false;
    }
  }
  function schedulePrs() {
    clearInterval(prTimer);
    const cfg = config.integrations.pr;
    const sec = Number(cfg?.refreshSec) || 0;
    if (!cfg?.enabled || !cfg.listTool || sec <= 0) return;
    prTimer = setInterval(() => { if (wss.clients.size > 0) refreshPrs(); }, Math.max(sec, 30) * 1000);
    prTimer.unref?.();
  }

  // ---- settings: GET/PUT /api/settings, saved into harness.config.local.json (never secrets) ----
  function settingsView() {
    const t = config.integrations.tasks || {};
    const pr = config.integrations.pr || {};
    return {
      agents: Object.fromEntries(Object.entries(config.agents).map(([id, a]) => [id, {
        approvalMode: a.approvalMode ?? null,
        approvalModes: a.approvalModes || [],
        approvalModeLabels: a.approvalModeLabels || {},
        approvalModeMap: a.approvalModeMap ?? launchers[a.launcher]?.defaults.approvalModeMap ?? {},
        autoSandbox: a.autoSandbox ?? null,
        allowedTools: a.allowedTools || [],
        model: a.model ?? null,
        models: a.models || [],
        modelGrades: a.settings?.agents?.modelGrades || {},
        allowedGrades: a.settings?.agents?.allowedGrades || [],
        taskPromptTemplate: a.taskPromptTemplate ?? null,
        reworkPromptTemplate: a.reworkPromptTemplate ?? null,
        taskPromptPresets: a.taskPromptPresets || [],
        firstEventTimeoutMs: a.firstEventTimeoutMs ?? launchers[a.launcher]?.defaults.firstEventTimeoutMs ?? null,
        authTimeoutMs: a.authTimeoutMs ?? 600000,
        inheritUserMcp: !!a.inheritUserMcp,
        enabled: a.enabled !== false,
        // paths, not secrets: null = auto per platform; `resolved` is what «Проверить» shows
        command: a.command ?? null,
        node: a.node ?? null,
        cliEntry: a.cliEntry ?? null,
        resolved: resolveAgentView(a),
      }])),
      defaultAgent: config.defaultAgent,
      git: pick(config.git, GIT_KEYS),
      tasks: { refreshSec: t.refreshSec ?? 0 },
      board: config.board,
      workspaces: {
        root: config.workspaces?.root ?? null,
        repos: config.workspaces?.repos || [],
        rootResolved: db.workspaces.find((w) => w.kind === 'root')?.path ?? null, // «Авто: <path>» when rootAuto
        rootAuto: !config.workspaces?.root,
      },
      session: { stallSec: config.session.stallSec },
      sessions: { autoArchiveDays: config.sessions.autoArchiveDays },
      recovery: { autoResume: !!config.recovery.autoResume, message: config.recovery.message },
      ide: config.ide ?? null,
      orchestration: { reviewMode: config.orchestration.reviewMode, subagents: config.orchestration.subagents, workerMayCommit: !!config.orchestration.workerMayCommit, review: config.orchestration.review },
      integrations: {
        tasks: { enabled: !!t.enabled, space: t.space ?? null, urlTemplate: t.urlTemplate ?? '', statusMap: t.statusMap || {}, closedStatuses: t.closedStatuses || [], onStartTransition: t.onStartTransition ?? null },
        pr: { enabled: !!pr.enabled, limits: pr.limits || null },
      },
    };
  }

  const isStrMap = (v) => isObj(v) && Object.values(v).every((x) => typeof x === 'string');
  const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

  function agentPatch(id, a) {
    const cur = config.agents[id] || fail(400, `неизвестный агент «${id}»`);
    if (!isObj(a)) fail(400, `agents.${id}: нужен объект`);
    const p = {};
    const where = (k) => `agents.${id}.${k}`;
    if ('approvalMode' in a) {
      if (typeof a.approvalMode !== 'string' || (cur.approvalModes?.length && !cur.approvalModes.includes(a.approvalMode))) {
        fail(400, `${where('approvalMode')} — одно из: ${(cur.approvalModes || []).join(', ')}`);
      }
      p.approvalMode = a.approvalMode;
    }
    // model ids are only checked to be strings: the catalogue may lag behind the backend
    if ('model' in a) {
      if (a.model !== null && typeof a.model !== 'string') fail(400, `${where('model')}: нужна строка или null`);
      p.model = a.model?.trim() || null;
    }
    if ('models' in a) p.models = normalizeModels(a.models);
    if ('approvalModeLabels' in a) {
      if (!isStrMap(a.approvalModeLabels)) fail(400, `${where('approvalModeLabels')}: нужен объект «режим → подпись»`);
      p.approvalModeLabels = a.approvalModeLabels;
    }
    if ('command' in a) {
      const c = a.command;
      const ok = c === null || (typeof c === 'string' && c.trim()) || (Array.isArray(c) && c.length && c.every((x) => typeof x === 'string' && x));
      if (!ok) fail(400, `${where('command')}: путь, массив argv или null (авто)`);
      p.command = typeof c === 'string' ? c.trim() : c;
    }
    if ('node' in a || 'cliEntry' in a) {
      const node = 'node' in a ? a.node : config.agents[id]?.node ?? null;
      const entry = 'cliEntry' in a ? a.cliEntry : config.agents[id]?.cliEntry ?? null;
      for (const [k, v] of [['node', node], ['cliEntry', entry]]) if (v !== null && (typeof v !== 'string' || !v.trim())) fail(400, `${where(k)}: путь или null`);
      if ((node === null) !== (entry === null)) fail(400, `${where('node')} и ${where('cliEntry')} задаются вместе (или оба null)`);
      p.node = node && node.trim();
      p.cliEntry = entry && entry.trim();
    }
    if ('approvalModeMap' in a) {
      const m = a.approvalModeMap;
      if (m !== null && (!isObj(m) || Object.values(m).some((v) => typeof v !== 'string' || !v))) fail(400, `${where('approvalModeMap')}: объект «режим → режим CLI» или null`);
      p.approvalModeMap = m;
    }
    if ('allowedTools' in a) {
      if (!isStrList(a.allowedTools) || a.allowedTools.some((x) => !x.trim())) fail(400, `${where('allowedTools')}: нужен массив непустых строк`);
      p.allowedTools = a.allowedTools.map((x) => x.trim());
    }
    if ('autoSandbox' in a) {
      if (![null, 'workspace', 'workspace-offline'].includes(a.autoSandbox)) fail(400, `${where('autoSandbox')}: null, "workspace" или "workspace-offline"`);
      p.autoSandbox = a.autoSandbox;
    }
    if ('reworkPromptTemplate' in a) {
      const t = a.reworkPromptTemplate;
      if (t !== null && (typeof t !== 'string' || !t.includes('{notes}'))) fail(400, `${where('reworkPromptTemplate')}: null или строка с {notes}`);
      p.reworkPromptTemplate = t || null;
    }
    if ('taskPromptTemplate' in a) {
      if (a.taskPromptTemplate !== null && typeof a.taskPromptTemplate !== 'string') fail(400, `${where('taskPromptTemplate')}: нужна строка или null`);
      if (a.taskPromptTemplate && !hasTaskVar(a.taskPromptTemplate)) fail(400, `${where('taskPromptTemplate')}: нужна хотя бы одна из переменных ${TASK_VARS.join(' ')}`);
      p.taskPromptTemplate = a.taskPromptTemplate || null;
    }
    if ('taskPromptPresets' in a) {
      if (!isStrList(a.taskPromptPresets) || a.taskPromptPresets.some((t) => !hasTaskVar(t))) fail(400, `${where('taskPromptPresets')}: в каждом шаблоне нужна одна из переменных ${TASK_VARS.join(' ')}`);
      p.taskPromptPresets = a.taskPromptPresets;
    }
    if ('authTimeoutMs' in a) {
      if (!Number.isInteger(a.authTimeoutMs) || a.authTimeoutMs < 10000 || a.authTimeoutMs > 3600000) fail(400, `${where('authTimeoutMs')}: целое число от 10000 до 3600000`);
      p.authTimeoutMs = a.authTimeoutMs;
    }
    if ('firstEventTimeoutMs' in a) {
      if (!Number.isInteger(a.firstEventTimeoutMs) || a.firstEventTimeoutMs < 1000 || a.firstEventTimeoutMs > 30 * 60000) fail(400, `${where('firstEventTimeoutMs')}: целое число от 1000 до 1800000`);
      p.firstEventTimeoutMs = a.firstEventTimeoutMs;
    }
    for (const k of ['inheritUserMcp', 'enabled']) {
      if (!(k in a)) continue;
      if (typeof a[k] !== 'boolean') fail(400, `${where(k)}: нужно true или false`);
      p[k] = a[k];
    }
    if ('modelGrades' in a) {
      if (!isObj(a.modelGrades) || Object.entries(a.modelGrades).some(([g, v]) => !GRADES.includes(g) || (v !== null && typeof v !== 'string'))) {
        fail(400, `${where('modelGrades')}: ключи ${GRADES.join('/')}, значения — строки`);
      }
      (p.settings ||= { agents: {} }).agents.modelGrades = a.modelGrades;
    }
    if ('allowedGrades' in a) {
      if (!isStrList(a.allowedGrades)) fail(400, `${where('allowedGrades')}: нужен массив строк`);
      (p.settings ||= { agents: {} }).agents.allowedGrades = a.allowedGrades;
    }
    return p;
  }

  function integrationsPatch(body) {
    const out = {};
    if (body.tasks !== undefined) {
      const sec = body.tasks?.refreshSec;
      if (!Number.isInteger(sec) || sec < 0) fail(400, 'tasks.refreshSec: целое число ≥ 0 (0 — выключено, минимум 10)');
      out.tasks = { refreshSec: sec };
    }
    const i = body.integrations;
    if (i === undefined) return out;
    if (!isObj(i)) fail(400, 'integrations: нужен объект');
    if (i.tasks !== undefined) {
      const t = i.tasks;
      if (!isObj(t)) fail(400, 'integrations.tasks: нужен объект');
      const p = {};
      if ('enabled' in t) {
        if (typeof t.enabled !== 'boolean') fail(400, 'integrations.tasks.enabled: нужно true или false');
        p.enabled = t.enabled;
      }
      if ('space' in t) {
        // one space or several (sync iterates all of them)
        const list = [t.space].flat();
        if (!list.length || list.some((x) => typeof x !== 'string' || !x.trim())) fail(400, 'integrations.tasks.space: код пространства или массив кодов');
        p.space = Array.isArray(t.space) ? t.space.map((x) => x.trim()) : t.space.trim();
      }
      for (const k of ['urlTemplate']) {
        if (!(k in t)) continue;
        if (typeof t[k] !== 'string') fail(400, `integrations.tasks.${k}: нужна строка`);
        p[k] = t[k].trim();
      }
      if ('statusMap' in t) {
        if (!isObj(t.statusMap) || Object.values(t.statusMap).some((v) => !STATUSES.includes(v))) fail(400, `integrations.tasks.statusMap: значения — из ${STATUSES.join(', ')}`);
        p.statusMap = t.statusMap;
      }
      if ('onStartTransition' in t) {
        if (t.onStartTransition !== null && typeof t.onStartTransition !== 'string') fail(400, 'integrations.tasks.onStartTransition: id перехода или null');
        p.onStartTransition = t.onStartTransition?.trim() || null;
      }
      if ('closedStatuses' in t) {
        if (!isStrList(t.closedStatuses)) fail(400, 'integrations.tasks.closedStatuses: нужен массив строк');
        p.closedStatuses = t.closedStatuses;
      }
      out.tasks = { ...out.tasks, ...p };
    }
    if (i.pr !== undefined) {
      if (!isObj(i.pr) || ('enabled' in i.pr && typeof i.pr.enabled !== 'boolean')) fail(400, 'integrations.pr.enabled: нужно true или false');
      if ('enabled' in i.pr) out.pr = { enabled: i.pr.enabled };
    }
    return out;
  }

  function boardPatch(b) {
    if (!isObj(b)) fail(400, 'board: нужен объект');
    const p = {};
    if ('columns' in b) {
      const cols = b.columns;
      if (!Array.isArray(cols) || !cols.length) fail(400, 'board.columns: нужна хотя бы одна колонка');
      const seen = new Set();
      p.columns = cols.map((c, i) => {
        if (!isObj(c) || !STATUSES.includes(c.status)) fail(400, `board.columns[${i}].status: одно из ${STATUSES.join(', ')}`);
        if (seen.has(c.status)) fail(400, `board.columns: статус «${c.status}» указан дважды`);
        seen.add(c.status);
        if (typeof c.label !== 'string' || !c.label.trim()) fail(400, `board.columns[${i}].label: нужна непустая строка`);
        if (c.trackerStatuses !== undefined && !isStrList(c.trackerStatuses)) fail(400, `board.columns[${i}].trackerStatuses: нужен массив строк`);
        return { status: c.status, label: c.label.trim(), trackerStatuses: c.trackerStatuses || [] };
      });
    }
    if ('onWorkerDone' in b) {
      if (!['stay', 'review'].includes(b.onWorkerDone)) fail(400, 'board.onWorkerDone: "stay" или "review"');
      p.onWorkerDone = b.onWorkerDone;
    }
    if ('moveSyncsTracker' in b) {
      if (typeof b.moveSyncsTracker !== 'boolean') fail(400, 'board.moveSyncsTracker: нужно true или false');
      p.moveSyncsTracker = b.moveSyncsTracker;
    }
    if ('columnTransitions' in b) {
      if (!isStrMap(b.columnTransitions) || Object.keys(b.columnTransitions).some((k) => !STATUSES.includes(k))) fail(400, 'board.columnTransitions: объект «статус → id перехода»');
      p.columnTransitions = b.columnTransitions;
    }
    return p;
  }

  function orchestrationPatch(o) {
    if (!isObj(o)) fail(400, 'orchestration: нужен объект');
    const p = {};
    if ('reviewMode' in o) {
      if (!['builtin', 'harness'].includes(o.reviewMode)) fail(400, 'orchestration.reviewMode: "builtin" или "harness"');
      p.reviewMode = o.reviewMode;
    }
    if ('subagents' in o) {
      if (!['harness', 'builtin'].includes(o.subagents)) fail(400, 'orchestration.subagents: "harness" или "builtin"');
      p.subagents = o.subagents;
    }
    if ('workerMayCommit' in o) {
      if (typeof o.workerMayCommit !== 'boolean') fail(400, 'orchestration.workerMayCommit: нужно true или false');
      p.workerMayCommit = o.workerMayCommit;
    }
    if ('review' in o) {
      const r = o.review;
      if (!isObj(r)) fail(400, 'orchestration.review: нужен объект');
      const rp = {};
      for (const k of ['grade', 'approvalMode', 'promptTemplate']) {
        if (!(k in r)) continue;
        if (typeof r[k] !== 'string' || !r[k].trim()) fail(400, `orchestration.review.${k}: нужна непустая строка`);
        rp[k] = r[k];
      }
      if ('maxRounds' in r) {
        if (!Number.isInteger(r.maxRounds) || r.maxRounds < 1 || r.maxRounds > 10) fail(400, 'orchestration.review.maxRounds: целое число 1..10');
        rp.maxRounds = r.maxRounds;
      }
      if ('agent' in r) {
        if (r.agent !== null && !config.agents[r.agent]) fail(400, `orchestration.review.agent: неизвестный агент «${r.agent}»`);
        rp.agent = r.agent;
      }
      p.review = rp;
    }
    return p;
  }

  async function saveSettings(body) {
    const patch = {};
    if (body.agents !== undefined) {
      if (!isObj(body.agents)) fail(400, 'agents: нужен объект');
      patch.agents = Object.fromEntries(Object.entries(body.agents).map(([id, a]) => [id, agentPatch(id, a)]));
    }
    if (body.defaultAgent !== undefined) {
      if (!config.agents[body.defaultAgent]) fail(400, `неизвестный агент «${body.defaultAgent}»`);
      patch.defaultAgent = body.defaultAgent;
    }
    if (body.git !== undefined) {
      if (!isObj(body.git) || Object.entries(body.git).some(([k, v]) => !GIT_KEYS.includes(k) || typeof v !== 'string' || !v.trim())) {
        fail(400, `git: непустые строки для ${GIT_KEYS.join(', ')}`);
      }
      patch.git = body.git;
    }
    if (body.board !== undefined) patch.board = boardPatch(body.board);
    if (body.recovery !== undefined) {
      const rc = body.recovery;
      if (!isObj(rc) || Object.keys(rc).some((k) => !['autoResume', 'message'].includes(k)) || ('autoResume' in rc && typeof rc.autoResume !== 'boolean') || ('message' in rc && (typeof rc.message !== 'string' || !rc.message.trim()))) {
        fail(400, 'recovery: { autoResume?: true/false, message?: непустая строка }');
      }
      patch.recovery = rc;
    }
    if (body.session !== undefined) {
      const sec = body.session?.stallSec;
      if (!isObj(body.session) || Object.keys(body.session).some((k) => k !== 'stallSec') || !Number.isInteger(sec) || sec < 30) fail(400, 'session: { stallSec: целое число ≥ 30 }');
      patch.session = { stallSec: sec };
    }
    if (body.sessions !== undefined) {
      const d = body.sessions?.autoArchiveDays;
      if (!isObj(body.sessions) || Object.keys(body.sessions).some((k) => k !== 'autoArchiveDays') || !Number.isInteger(d) || d < 0) fail(400, 'sessions: { autoArchiveDays: целое число ≥ 0 (0 — выключено) }');
      patch.sessions = { autoArchiveDays: d };
    }
    if (body.ide !== undefined) {
      const ide = body.ide;
      if (ide !== null && (!isObj(ide) || typeof ide.command !== 'string' || !ide.command.trim() || (ide.args !== undefined && !isStrList(ide.args)))) {
        fail(400, 'ide: null или { command: строка, args?: string[] } («{path}» заменяется на папку)');
      }
      patch.ide = ide && { command: ide.command.trim(), args: ide.args || ['{path}'] };
    }
    if (body.orchestration !== undefined) patch.orchestration = orchestrationPatch(body.orchestration);
    if (body.workspaces !== undefined) {
      const w = body.workspaces;
      const rootOk = (r) => r === null || (typeof r === 'string' && path.isAbsolute(expandHome(r)) && fs.existsSync(expandHome(r)) && fs.statSync(expandHome(r)).isDirectory());
      if (!isObj(w) || Object.keys(w).some((k) => !['root', 'repos'].includes(k)) || ('root' in w && !rootOk(w.root)) || ('repos' in w && !isStrList(w.repos))) {
        fail(400, 'workspaces: { root: существующая абсолютная папка или null (авто), repos: string[] }');
      }
      patch.workspaces = w;
    }
    const integrations = integrationsPatch(body);
    if (Object.keys(integrations).length) patch.integrations = integrations;
    const next = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, deepMerge(config[k], v)]));
    writeAtomic(config.localConfigFile, `${JSON.stringify(deepMerge(readJsonFile(config.localConfigFile), patch), null, 2)}\n`);
    Object.assign(config, next);
    scheduleSync();
    schedulePrs();
    if (patch.workspaces) {
      await registerConfiguredWorkspaces();
      syncRootWorkspace();
      emitWorkspaces(); // the projects folder may have moved
    }
    return settingsView();
  }

  // ---- shipped files the user may install into the agent's own folders (only on an explicit request) ----
  const SHIPPED = {
    commands: { 'full-task-harness': { from: path.join(CODE_ROOT, 'commands', 'full-task-harness.md'), dirKey: 'commandsDir', dir: '~/.gigacode/commands', to: (n) => `${n}.md` } },
    skills: { 'harness-orchestration': { from: path.join(CODE_ROOT, 'skills', 'harness-orchestration', 'SKILL.md'), dirKey: 'skillsDir', dir: '~/.gigacode/skills', to: (n) => path.join(n, 'SKILL.md') } },
  };
  function shippedTarget(agentCfg, kind, name) {
    const item = SHIPPED[kind][name] || fail(404, `неизвестный элемент «${name}»`);
    return { item, target: path.join(expandHome(agentCfg[item.dirKey] || item.dir), item.to(name)) };
  }
  function shippedStatus(agentCfg, kind) {
    return Object.fromEntries(Object.keys(SHIPPED[kind]).map((name) => {
      const { item, target } = shippedTarget(agentCfg, kind, name);
      if (!fs.existsSync(target)) return [name, 'missing'];
      return [name, fs.readFileSync(target, 'utf8') === fs.readFileSync(item.from, 'utf8') ? 'installed' : 'different'];
    }));
  }
  function installShipped(id, kind, name, force) {
    const agentCfg = config.agents[id] || fail(404, `агент ${id} не найден`);
    const { item, target } = shippedTarget(agentCfg, kind, name);
    const status = shippedStatus(agentCfg, kind)[name];
    if (status === 'different' && !force) fail(409, `${target} уже есть и отличается от версии harness; передайте force: true, чтобы перезаписать`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(item.from, target);
    return { name, path: target, status: 'installed' };
  }

  /** Launcher resolution of an agent, as --print-config shows it (no spawn; the identity value is never returned). */
  function agentInfo(id) {
    const a = config.agents[id] || fail(404, `агент ${id} не найден`);
    const meta = db.agentMeta?.[id] ?? null;
    catalog.ensureFresh(id);
    const { catalog: cat, ...seen } = meta || {};
    return {
      id, resolved: resolveAgentView(a), auth: meta?.auth ?? 'unknown', seen: meta ? seen : null, catalog: catalog.info(id), models: catalog.merged(id),
      commands: shippedStatus(a, 'commands'), skills: shippedStatus(a, 'skills'), identity: identityView(a),
      modelRefs: scanModelRefs(a.modelRefsScan, catalog.merged(id)), // read-only: the harness never edits these files
    };
  }

  // ---- worktree management ----
  const openSpawner = opts.openSpawner || spawnProcess; // tests inject a stub instead of launching a file manager
  const wtCache = new Map(); // path -> { at, data: Promise } — the git-heavy fields (dirty, ahead)
  const WT_CACHE_MS = 30000;
  const gitSlots = limiter(4); // ~10 repos x 10-20 worktrees: at most 4 enrichment git runs at a time
  const metaKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const sessionsIn = (p) => db.sessions.filter((s) => !s.virtual && samePath(s.cwd, p));
  const waitGone = async (pid) => {
    for (let i = 0; i < 50; i++) {
      try { process.kill(pid, 0); } catch { return; }
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  function taskOf(ws, wt) {
    return db.tasks.find((t) => wt.branch && t.branch === wt.branch && (!t.workspaceId || t.workspaceId === ws.id))
      || sessionsIn(wt.path).map((s) => s.taskId && tasks.find(s.taskId)).find(Boolean) || null;
  }

  /** git-heavy fields of one worktree (status + ahead of its base), cached 30 s, at most 4 computations at a time. */
  function worktreeGit(ws, wt, fresh = false) {
    const hit = wtCache.get(wt.path);
    if (!fresh && hit && Date.now() - hit.at < WT_CACHE_MS) return hit.data;
    const data = gitSlots(async () => {
      const task = taskOf(ws, wt);
      const base = task?.targets?.[0] || config.git.defaultBase;
      const [st, baseRef, ct] = await Promise.all([
        git.status(wt.path).catch(() => null),
        git.startPoint(ws.path, base).catch(() => null),
        wt.head ? git.git(wt.path, ['log', '-1', '--format=%ct', 'HEAD']).then((r) => Number(r.stdout.trim()) * 1000 || 0, () => 0) : 0,
      ]);
      const ahead = baseRef && wt.head ? ((await git.revList(wt.path, `${baseRef}..HEAD`).catch(() => null)) || []).length : 0;
      return { dirty: st ? st.files.length : 0, ahead, base, committedAt: ct || null };
    });
    wtCache.set(wt.path, { at: Date.now(), data });
    data.catch(() => wtCache.delete(wt.path));
    return data;
  }

  /**
   * mtime of the worktree's HEAD reflog (logs/HEAD: commit, checkout, reset), else of HEAD: one cheap stat. Never the
   * index - a read like `git status` could rewrite it without any activity.
   */
  function gitTouchedAt(wtPath) {
    let gitDir = path.join(wtPath, '.git');
    try {
      // a linked worktree has a .git FILE: "gitdir: <repo>/.git/worktrees/<name>"
      if (fs.statSync(gitDir).isFile()) gitDir = path.resolve(wtPath, fs.readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+)$/m)[1].trim());
    } catch {
      return 0;
    }
    for (const f of [path.join('logs', 'HEAD'), 'HEAD']) {
      try { return Math.floor(fs.statSync(path.join(gitDir, f)).mtimeMs); } catch {}
    }
    return 0;
  }

  /**
   * One `git worktree list` + meta + sessions + stats by default; dirty/ahead (git per worktree) only with `enrich`
   * (or from a fresh cache entry), so a repository with 20 worktrees lists instantly.
   */
  async function listWorktrees(ws, enrich = false) {
    const list = await git.worktrees(ws.path);
    await orch.linkAgentWorktrees([[ws, list]]).catch(() => {});
    return Promise.all(list.map((wt) => worktreeView(ws, wt, enrich)));
  }

  async function worktreeView(ws, wt, enrich) {
    const hit = wtCache.get(wt.path);
    const cached = hit && Date.now() - hit.at < WT_CACHE_MS ? hit.data : null;
    const info = enrich ? await worktreeGit(ws, wt) : cached ? await cached.catch(() => null) : null;
    const task = taskOf(ws, wt);
    const here = sessionsIn(wt.path).filter((s) => !s.archived);
    const last = Math.max(0, gitTouchedAt(wt.path), info?.committedAt || 0, ...here.map((s) => s.lastActivityAt || 0));
    return {
      ...wt,
      enriched: !!info,
      dirty: info?.dirty ?? null,
      ahead: info?.ahead ?? null,
      taskId: task?.id ?? null,
      taskStatus: task?.status ?? null,
      pr: task?.pr ? { state: task.pr.state, url: task.pr.url } : null,
      sessions: here.length,
      running: here.filter((s) => s.status === 'running').length,
      lastActivityAt: last || null,
      meta: db.worktreeMeta?.[metaKey(wt.path)] || {},
    };
  }

  /** A registered workspace or one of its worktrees (the only folders /api/open and worktree meta accept). */
  async function registeredFolder(p) {
    for (const ws of db.workspaces) {
      if (samePath(ws.path, p)) return ws;
      if (ws.isGit && (await git.worktrees(ws.path).catch(() => [])).some((w) => samePath(w.path, p))) return ws;
    }
    return null;
  }

  // ---- /full-task SDD artifacts: polled while a session in that folder runs, broadcast on change ----
  const sddSeen = new Map(); // folder key -> last JSON
  let sddBusy = false;
  const sddTimer = setInterval(async () => {
    if (!wss.clients.size || sddBusy) return;
    sddBusy = true;
    try {
      const cwds = new Map(db.sessions.filter((s) => s.status === 'running' && !s.virtual && s.cwd).map((s) => [metaKey(s.cwd), s.cwd]));
      for (const [k, cwd] of cwds) {
        const data = await readSdd(cwd);
        const json = JSON.stringify(data);
        if ((sddSeen.get(k) ?? '{"plans":[]}') !== json) bus.send({ t: 'sdd', cwd, ...data });
        sddSeen.set(k, json);
      }
    } finally {
      sddBusy = false;
    }
  }, 3000);
  sddTimer.unref?.();

  // ---- routes ----
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, title: JOB_TITLES[`${method} ${pattern}`] || `${method} ${pattern}` });

  const getWs = (id) => db.workspaces.find((w) => w.id === id) || fail(404, `рабочая папка ${id} не найдена`);
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
    agents: Object.entries(config.agents).map(([id, a]) => {
      catalog.ensureFresh(id); // background, never blocks
      return {
        id, label: a.label || id, launcher: a.launcher, approvalModes: a.approvalModes || [], approvalMode: a.approvalMode || null, enabled: a.enabled !== false,
        models: catalog.merged(id), model: a.model ?? null,
      };
    }),
    defaultAgent: config.agents[config.defaultAgent] && config.agents[config.defaultAgent].enabled !== false
      ? config.defaultAgent
      : Object.keys(config.agents).find((id) => config.agents[id].enabled !== false) ?? null,
    shell: { command: config.shell.command },
    features: FEATURES,
    recentFolders: db.prefs?.recentFolders || [],
    demo: !!opts.demo,
    integrations: { tasks: !!config.integrations.tasks?.enabled, pr: !!config.integrations.pr?.enabled, tasksProblem },
  }));
  route('GET', '/api/settings', () => settingsView());
  route('GET', '/api/recovery', () => sessions.recoveryList());
  route('POST', '/api/recovery/resume', ({ body }) => sessions.recoveryResume(body.sessionIds, check(body, { message: 'string?' }).message));
  route('POST', '/api/recovery/dismiss', ({ body }) => sessions.recoveryDismiss(body.sessionIds));
  route('GET', '/api/agents/:id/info', ({ params }) => agentInfo(params.id));
  route('POST', '/api/agents/:id/commands/install', ({ params, body }) => installShipped(params.id, 'commands', check(body, { name: 'string', force: 'boolean?' }).name, body.force));
  route('POST', '/api/agents/:id/skills/install', ({ params, body }) => installShipped(params.id, 'skills', body.name || 'harness-orchestration', check(body, { force: 'boolean?' }).force));
  route('POST', '/api/agents/:id/models/refresh', async ({ params }) => {
    if (!config.agents[params.id]) fail(404, `агент ${params.id} не найден`);
    if (!config.agents[params.id].modelsDiscovery?.prompt) fail(400, `не настроен agents.${params.id}.modelsDiscovery.prompt`);
    jobStep('Опрос /models');
    const c = await catalog.discover(params.id);
    return { models: catalog.merged(params.id), at: c?.at ?? null, ...(c?.error ? { error: c.error } : {}) };
  });
  route('PUT', '/api/settings', ({ body }) => saveSettings(body));

  // workspaces
  /** db.prefs.recentFolders: the last 10 folders a chat was started in or registered (newest first). */
  function rememberFolder(p) {
    db.prefs ||= {};
    db.prefs.recentFolders = [p, ...(db.prefs.recentFolders || []).filter((x) => !samePath(x, p))].slice(0, 10);
    store.save();
  }

  async function addWorkspace(rawPath, name, kind) {
    const p = path.resolve(rawPath);
    if (!path.isAbsolute(rawPath) || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) fail(400, `не существующая абсолютная папка: ${rawPath}`);
    const existing = db.workspaces.find((w) => samePath(w.path, p));
    if (existing) return existing;
    const ws = { id: newId('w', 3), name: name?.trim() || path.basename(p), path: p, isGit: await git.isRepo(p), ...(kind ? { kind } : {}) };
    db.workspaces.push(ws);
    emitWorkspaces();
    if (!kind) syncRootWorkspace();
    return ws;
  }

  /**
   * The projects folder as a folder workspace (kind 'root', listed first): workspaces.root, else the deepest common
   * parent of >= 2 registered repositories. A chat there sees every project under it.
   */
  function syncRootWorkspace() {
    const configured = config.workspaces?.root ? path.resolve(expandHome(config.workspaces.root)) : null;
    const repos = db.workspaces.filter((w) => !w.kind).map((w) => w.path);
    const rootPath = configured && fs.existsSync(configured) ? configured : repos.length >= 2 ? commonDir(repos) : null;
    const cur = db.workspaces.find((w) => w.kind === 'root');
    if (!rootPath) {
      if (cur) {
        db.workspaces = db.workspaces.filter((w) => w !== cur);
        emitWorkspaces();
      }
      return;
    }
    if (cur && samePath(cur.path, rootPath) && db.workspaces[0] === cur) return;
    const ws = cur ? Object.assign(cur, { path: rootPath, name: path.basename(rootPath) }) : { id: newId('w', 3), name: path.basename(rootPath), path: rootPath, isGit: false, kind: 'root' };
    db.workspaces = [ws, ...db.workspaces.filter((w) => w !== ws && !samePath(w.path, rootPath))];
    emitWorkspaces();
  }

  route('POST', '/api/workspaces', async ({ body }) => {
    check(body, { path: 'string', name: 'string?', kind: 'string?' });
    if (body.kind && body.kind !== 'folder') fail(400, 'kind: "folder" (или не указывать для репозитория)');
    const ws = await addWorkspace(body.path, body.name, body.kind);
    if (body.kind === 'folder') rememberFolder(ws.path);
    return ws;
  });
  // config.workspaces: { root, repos } — repos are names under root (or absolute paths); empty repos = every git repo directly under root
  async function registerConfiguredWorkspaces() {
    const { repos = [] } = config.workspaces || {};
    const root = expandHome(config.workspaces?.root ?? null);
    const list = repos.length ? repos.map((r) => (path.isAbsolute(r) ? r : path.join(root || '', r)))
      : root && fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, '.git'))).map((d) => path.join(root, d.name))
        : [];
    for (const p of list) await addWorkspace(p).catch((e) => console.warn(`workspaces: skip ${p}: ${e.message}`));
  }
  await registerConfiguredWorkspaces();
  syncRootWorkspace();
  await sessions.reresolveWorkspaces(); // data saved before the repo-first rule
  sessions.autoArchive();
  route('DELETE', '/api/workspaces/:id', ({ params }) => {
    getWs(params.id);
    db.workspaces = db.workspaces.filter((w) => w.id !== params.id);
    emitWorkspaces();
    syncRootWorkspace();
  });
  route('GET', '/api/workspaces/:id/worktrees', ({ params, query }) => listWorktrees(getWs(params.id), query.enrich === '1'));
  route('GET', '/api/worktrees/info', async ({ query }) => {
    const p = check(query, { path: 'string' }).path;
    const ws = (await registeredFolder(p)) || fail(400, `не зарегистрированная рабочая папка и не её рабочее дерево: ${p}`);
    const wt = ws.isGit && (await git.worktrees(ws.path)).find((w) => samePath(w.path, p)) || fail(404, `не рабочее дерево ${ws.name}: ${p}`);
    return worktreeView(ws, wt, true);
  });
  route('POST', '/api/workspaces/:id/worktrees', async ({ params, body }) => {
    const ws = getWs(params.id);
    check(body, { name: 'string', base: 'string?' });
    const start = body.base ? (await git.startPoint(ws.path, body.base)) || body.base : null;
    return git.addWorktree(ws.path, { branch: git.sanitizeBranch(body.name), start, worktreeRoot: config.worktreeRoot });
  });
  route('DELETE', '/api/workspaces/:id/worktrees', async ({ params, body }) => {
    const ws = getWs(params.id);
    check(body, { path: 'string', force: 'boolean?', deleteBranch: 'string?' });
    if (body.deleteBranch && !['no', 'safe', 'force'].includes(body.deleteBranch)) fail(400, 'deleteBranch: no, safe или force');
    const wt = (await git.worktrees(ws.path)).find((w) => samePath(w.path, body.path)) || fail(404, `не рабочее дерево ${ws.name}: ${body.path}`);
    if (wt.main) fail(400, 'основное рабочее дерево репозитория удалить нельзя');
    const [info] = await Promise.all([worktreeGit(ws, wt, true)]);
    const here = sessionsIn(wt.path);
    const running = here.filter((s) => s.status === 'running').length;
    if ((info.dirty || info.ahead || running) && !body.force) {
      throw Object.assign(new Error(`${wt.path}: незакоммиченных изменений — ${info.dirty}, коммитов не в ${info.base} — ${info.ahead}, идущих ходов — ${running}; передайте force, чтобы удалить всё равно`), { status: 409, details: { dirty: info.dirty, ahead: info.ahead, running } });
    }
    jobStep('Остановка сессий', { done: 0, total: here.length });
    for (const [i, s] of here.entries()) {
      jobStep('Остановка сессий', { done: i + 1, total: here.length });
      if (s.status === 'running' || s.kind === 'terminal') {
        try { sessions.stop(s.id); } catch {}
      }
      sessions.archive(s.id, true, { stop: true }); // hidden from the sidebar; transcripts kept
    }
    await Promise.all(here.filter((s) => s.pid).map((s) => waitGone(s.pid)));
    jobStep('git worktree remove');
    await git.removeWorktree(ws.path, wt.path);
    let branchDeleted = false;
    if (wt.branch && body.deleteBranch && body.deleteBranch !== 'no') {
      const r = await git.git(ws.path, ['branch', body.deleteBranch === 'force' ? '-D' : '-d', wt.branch], { ok: [0, 1] });
      branchDeleted = r.code === 0; // -d refuses an unmerged branch: kept
    }
    wtCache.delete(wt.path);
    return { removed: true, branchDeleted, archivedSessions: here.length };
  });
  route('PATCH', '/api/worktrees/meta', async ({ body }) => {
    check(body, { path: 'string', label: 'string?', note: 'string?', pinned: 'boolean?', sleeping: 'boolean?', force: 'boolean?' });
    const p = path.resolve(body.path);
    if (!(await registeredFolder(p))) fail(400, `не зарегистрированная рабочая папка и не её рабочее дерево: ${body.path}`);
    if (body.sleeping) {
      const here = sessionsIn(p);
      const running = here.filter((s) => s.kind === 'chat' && s.status === 'running');
      if (running.length && !body.force) {
        throw Object.assign(new Error(`в этом рабочем дереве идут ходы агентов (${running.length}); передайте force, чтобы остановить их`), { status: 409, details: { running: running.length } });
      }
      for (const s of here) if (s.kind === 'terminal' || s.status === 'running') try { sessions.stop(s.id); } catch {}
    }
    db.worktreeMeta ||= {};
    const key = metaKey(p);
    const meta = { ...db.worktreeMeta[key] };
    for (const k of ['label', 'note', 'pinned', 'sleeping']) if (k in body) meta[k] = body[k];
    db.worktreeMeta[key] = meta;
    store.save();
    return meta;
  });
  route('POST', '/api/open', async ({ body }) => {
    check(body, { cwd: 'string', target: 'string' });
    if (!['explorer', 'ide'].includes(body.target)) fail(400, 'target: "explorer" или "ide"');
    const p = path.resolve(body.cwd);
    if (!(await registeredFolder(p))) fail(400, `не зарегистрированная рабочая папка и не её рабочее дерево: ${body.cwd}`);
    let command;
    let args;
    if (body.target === 'ide') {
      if (!config.ide?.command) fail(400, 'IDE не настроена (config.ide)');
      command = config.ide.command;
      args = (config.ide.args || ['{path}']).map((a) => String(a).replace(/\{path\}/g, p));
    } else {
      command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      args = [p];
    }
    const child = openSpawner(command, args, { detached: true, stdio: 'ignore', shell: false });
    child.on?.('error', () => {});
    child.unref?.();
    return { ok: true };
  });

  // tasks
  route('POST', '/api/tasks/sync', () => runSync());
  route('POST', '/api/tasks/import', ({ body }) => importIssue({ config, mcp, tasks, ref: check(body, { ref: 'string' }).ref }));
  route('POST', '/api/tasks', ({ body }) => tasks.create(pick(body, ['title', 'description', 'status', 'priority', 'deps', 'labels', 'workspaceId', 'parentId', 'targets'])));
  // a human editing the status pins the column: tracker sync no longer moves the card
  route('PATCH', '/api/tasks/:id', ({ params, body }) => tasks.update(params.id, 'status' in body ? { ...body, statusManual: true } : body));
  route('DELETE', '/api/tasks/:id', ({ params }) => tasks.remove(params.id));
  route('POST', '/api/tasks/:id/move', ({ params, body }) => {
    check(body, { status: 'string', beforeId: 'string?' });
    const before = tasks.get(params.id).status;
    const task = tasks.move(params.id, body.status, body.beforeId || null);
    if (config.board?.moveSyncsTracker && before !== task.status && tracksTracker(task)) {
      trackerWrite(task, `синхронизация в «${task.status}»`, () => syncColumn({ config, mcp, tasks, task, status: task.status })); // background: the card is already moved
    }
    return task;
  });
  route('POST', '/api/tasks/:id/assign', ({ params, body }) => {
    check(body, { agent: 'string?', workspaceId: 'string?', cwd: 'string?', worktree: 'string?', sessionId: 'string?' });
    return orch.assign(params.id, body);
  });
  route('POST', '/api/tasks/:id/start', async ({ params, body }) => {
    check(body, { agent: 'string?', notes: 'string?', workspaceId: 'string?', location: 'string?' });
    if (body.location && body.location !== 'root') fail(400, 'location: "root" или не указывать');
    const s = await orch.start(params.id, body);
    if (!s.jumped) await trackerOnStart(tasks.get(params.id));
    return s;
  });
  route('POST', '/api/tasks/:id/rework', async ({ params, body }) => {
    check(body, { notes: 'string', agent: 'string?' });
    const before = tasks.get(params.id).status;
    const s = await orch.rework(params.id, body);
    const task = tasks.get(params.id);
    if (config.board?.moveSyncsTracker && before !== task.status && tracksTracker(task)) {
      trackerWrite(task, 'синхронизация в «in_progress»', () => syncColumn({ config, mcp, tasks, task, status: task.status })); // the normal move-sync
    }
    return s;
  });
  route('POST', '/api/tasks/:id/port', ({ params, body }) => {
    check(body, { target: 'string', agent: 'string?' });
    return orch.port(params.id, body.target, { agent: body.agent });
  });
  route('GET', '/api/tasks/:id/external', ({ params }) => getExternal({ config, mcp, tasks, task: tasks.get(params.id) }));
  route('GET', '/api/tasks/:id/transitions', ({ params }) => getTransitions({ config, mcp, tasks, task: tasks.get(params.id) }));
  route('POST', '/api/tasks/:id/import-children', ({ params }) => importChildren({ config, mcp, tasks, task: tasks.get(params.id) }));
  route('POST', '/api/tasks/:id/tracker-status', ({ params, body }) => {
    check(body, { transition: 'string?', status: 'string?', comment: 'string?' });
    return transitionTask({ config, mcp, tasks, task: tasks.get(params.id), transition: body.transition, status: body.status, comment: body.comment || '' });
  });

  // sessions
  route('POST', '/api/sessions', async ({ body }) => {
    const s = await sessions.create(pick(body, ['kind', 'agent', 'cwd', 'workspaceId', 'title', 'prompt', 'role', 'approvalMode', 'model', 'command', 'includeDirs']));
    if (typeof body.cwd === 'string') rememberFolder(s.cwd);
    return s;
  });
  route('PATCH', '/api/sessions/:id', ({ params, body }) => sessions.patch(params.id, body));
  route('DELETE', '/api/sessions/:id', ({ params, query }) => sessions.remove(params.id, { force: query.force === '1' }));
  // the transcript keeps every tool output whole; the list sends at most 64 KB of each (full text on demand)
  const OUTPUT_MAX = 64 * 1024;
  route('GET', '/api/sessions/:id/messages', ({ params }) => sessions.messages(params.id).map((m) => (
    m.kind === 'tool' && typeof m.tool?.output === 'string' && m.tool.output.length > OUTPUT_MAX
      ? { ...m, tool: { ...m.tool, output: m.tool.output.slice(0, OUTPUT_MAX), outputTruncated: true } }
      : m
  )));
  route('GET', '/api/sessions/:id/messages/:mid/output', ({ params }) => {
    const m = sessions.messages(params.id).find((x) => x.id === params.mid) || fail(404, `сообщение ${params.mid} не найдено`);
    return { output: m.tool?.output ?? null };
  });
  route('POST', '/api/sessions/:id/messages', ({ params, body }) => sessions.deliver(params.id, { from: 'user', text: check(body, { text: 'string' }).text }));
  route('POST', '/api/sessions/:id/permission', ({ params, body }) => sessions.permission(params.id, check(body, { permissionId: 'string', optionId: 'string', note: 'string?' })));
  route('POST', '/api/sessions/:id/stop', ({ params }) => sessions.stop(params.id));
  route('POST', '/api/sessions/:id/restart', ({ params }) => sessions.restart(params.id));
  route('GET', '/api/sessions/:id/log', ({ params }) => sessions.logTail(params.id));
  route('GET', '/api/sessions/:id/subagents', ({ params }) => sessions.subagents(params.id));

  // git
  route('GET', '/api/git/status', async ({ query }) => {
    const st = await git.status(cwdOf(query), config.git.excludeFromCommit);
    refreshBranch(query.cwd, st.branch);
    return st;
  });
  route('GET', '/api/git/diff', ({ query }) => git.diff(cwdOf(query), query.path || undefined));
  route('GET', '/api/git/log', ({ query }) => git.log(cwdOf(query), Math.min(Math.max(Number(query.n) || 50, 1), 1000)));
  route('GET', '/api/git/suggest', ({ query }) => orch.gitSuggest(cwdOf(query)));
  route('GET', '/api/git/branches', ({ query }) => git.branches(cwdOf(query)));
  route('GET', '/api/git/pr-status', async ({ query }) => {
    const cwd = cwdOf(query);
    if (!config.integrations.pr?.enabled) fail(501, 'интеграция PR выключена (integrations.pr.enabled)');
    const branch = await git.currentBranch(cwd);
    if (!branch) return { pr: null };
    try {
      return await prStatus({ config, mcp, branch, ...(await git.remoteInfo(cwd)) });
    } catch (e) {
      if (e.status === 501) throw e;
      return { pr: null, error: e.message }; // observe-only: the code host being down is not an API error
    }
  });
  route('POST', '/api/git/checkout', async ({ body }) => {
    check(body, { cwd: 'string', branch: 'string', create: 'boolean?', from: 'string?' });
    const busy = db.sessions.find((s) => s.kind === 'chat' && s.status === 'running' && samePath(s.cwd, body.cwd));
    if (busy) fail(409, `В этой папке сейчас работает агент (${busy.title}); остановите его или дождитесь окончания, прежде чем переключать ветку.`);
    jobStep(`git checkout ${body.branch}`);
    const r = await git.checkout(body.cwd, body);
    refreshBranch(body.cwd, r.branch);
    return r;
  });
  route('POST', '/api/git/commit', ({ body }) => {
    check(body, { cwd: 'string', message: 'string', paths: 'array?' });
    return git.commit(body.cwd, body.message, body.paths, config.git.excludeFromCommit);
  });
  route('POST', '/api/git/push', ({ body }) => {
    check(body, { cwd: 'string' });
    jobStep('git push');
    return git.push(body.cwd, { timeoutSec: config.git.networkTimeoutSec });
  });
  route('POST', '/api/git/pr', async ({ body }) => {
    check(body, { cwd: 'string', title: 'string', body: 'string?', base: 'string?' });
    if (!config.integrations.pr?.enabled) fail(501, 'создание PR выключено (integrations.pr.enabled)');
    const branch = (await git.currentBranch(body.cwd)) || fail(400, 'в cwd не выбрана ветка');
    const base = body.base || config.git.defaultBase;
    const r = await createPullRequest({
      config, mcp, cwd: body.cwd, branch, base,
      title: body.title, body: body.body || '', ...(await git.remoteInfo(body.cwd)),
    });
    const task = db.tasks.find((t) => t.branch === branch);
    if (task) {
      const n = String(r.url).match(/(\d+)\/?(?:overview)?$/)?.[1];
      tasks.addLog(task.id, 'user', r.existing ? `PR${n ? ` #${n}` : ''} в ${base} уже открыт` : `PR${n ? ` #${n}` : ''} в ${base} создан`, 'pr_created', { url: r.url, base, existing: !!r.existing });
    }
    return r;
  });
  route('POST', '/api/git/pr/decline', async ({ body }) => {
    check(body, { cwd: 'string' });
    const r = await declinePullRequest({ config, mcp, cwd: body.cwd, index: body.index });
    const branch = await git.currentBranch(body.cwd);
    const task = branch && db.tasks.find((t) => t.branch === branch);
    if (task) await refreshTaskPr({ config, mcp, tasks, task, cwd: body.cwd }).catch(() => {});
    return r;
  });

  // ---- the agent CLI's own recorded chats (sessions started outside the harness) ----
  const history = createHistory(config);
  const linkedFor = (agent, id) => db.sessions.find((s) => s.kind === 'chat' && !s.virtual && s.agent === agent && s.externalSessionId === id)?.id ?? null;
  const historyPaths = async (cwd) => [path.resolve(cwd), (await git.worktrees(cwd).catch(() => []))[0]?.path ?? null];
  route('GET', '/api/history', async ({ query }) => history.list(await historyPaths(cwdOf(query)), linkedFor));
  route('GET', '/api/history/:agent/:id/messages', ({ params }) => historyMessages(history.get(params.agent, params.id), params.agent));
  route('POST', '/api/history/:agent/:id/continue', async ({ params, body }) => {
    const { cwd } = check(body, { cwd: 'string' });
    const rec = history.get(params.agent, params.id);
    const linked = linkedFor(params.agent, rec.id);
    if (linked) return sessions.get(linked);
    const msgs = historyMessages(rec, params.agent);
    const title = msgs.find((m) => m.kind === 'user')?.text.replace(/\s+/g, ' ').trim().slice(0, 80) || `История ${rec.id}`;
    const s = await sessions.create({ kind: 'chat', agent: params.agent, cwd, title });
    sessions.importMessages(s.id, msgs);
    // the next message continues that CLI session (--resume <id>), so no harness preamble is added
    return sessions.update(s.id, { externalSessionId: rec.id, historyId: rec.id });
  });

  // files
  route('GET', '/api/sdd', ({ query }) => readSdd(path.resolve(cwdOf(query))));
  route('GET', '/api/fs/dirs', ({ query }) => wfs.listDirs(query.path || '', { hidden: query.hidden === '1' }));
  route('GET', '/api/fs/list', ({ query }) => wfs.list(cwdOf(query), query.path || ''));
  route('GET', '/api/fs/search', ({ query }) => wfs.searchFiles(cwdOf(query), query.q || '', query.limit));
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
    const n = db.notifications.find((x) => x.id === params.id) || fail(404, `уведомление ${params.id} не найдено`);
    n.read = true;
    store.save();
    bus.send({ t: 'notify', n });
    return n;
  });

  // agent-facing orchestration API
  route('GET', '/api/agent/tools', () => orch.tools);
  route('GET', '/api/agent/worker_wait', ({ query }) => orch.waitRun(check(query, { sessionId: 'string' }).sessionId, query.timeoutMs));
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
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'метод не поддерживается' });
    let file;
    try {
      file = path.join(distDir, decodeURIComponent(pathname));
    } catch {
      return sendJson(res, 400, { error: 'неверный путь' });
    }
    const rel = path.relative(distDir, file);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && rel !== 'index.html' && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
      return fs.createReadStream(file).pipe(res);
    }
    if (path.extname(pathname) && pathname !== '/index.html') return sendJson(res, 404, { error: 'не найдено' });
    return serveIndex(res, pathname);
  }

  /** GET /api/fs/raw?cwd=&path= — an image for a chat thumbnail; `?token=` works too (an <img src> sends no headers). */
  function serveRaw(req, res, u) {
    if (!tokenOk(req.headers['x-harness-token'] ?? u.searchParams.get('token') ?? undefined)) return sendJson(res, 401, { error: 'нет токена или он неверный' });
    const q = check(Object.fromEntries(u.searchParams), { cwd: 'string', path: 'string' });
    const extra = db.sessions.filter((s) => s.cwd && samePath(s.cwd, q.cwd)).flatMap((s) => s.includeDirs || []);
    const f = wfs.rawImage([q.cwd, ...extra], q.path);
    const etag = `"${f.size}-${Math.floor(f.mtimeMs)}"`;
    const headers = {
      'content-type': f.type, etag, 'last-modified': new Date(f.mtimeMs).toUTCString(), 'cache-control': 'private, no-cache',
      'x-content-type-options': 'nosniff', ...(f.type === 'image/svg+xml' ? { 'content-security-policy': 'sandbox' } : {}),
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'content-length': f.size });
    return fs.createReadStream(f.abs).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (!allowed.includes(String(req.headers.host).toLowerCase())) return sendJson(res, 403, { error: 'запрещённый Host' });
    let u;
    try {
      u = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'неверный адрес' });
    }
    try {
      // liveness for the single-instance lock: no token (it proves nothing secret), still behind the Host guard
      if (u.pathname === '/api/health') return sendJson(res, 200, { ok: true, pid: process.pid, dataDir: config.dataDir });
      if (u.pathname === '/api/fs/raw' && req.method === 'GET') return serveRaw(req, res, u);
      if (u.pathname === '/api' || u.pathname.startsWith('/api/')) {
        if (!tokenOk(req.headers['x-harness-token'])) return sendJson(res, 401, { error: 'нет x-harness-token или он неверный' });
        const candidates = routes.map((r) => ({ r, m: u.pathname.match(r.re) })).filter((x) => x.m);
        if (!candidates.length) return sendJson(res, 404, { error: `нет такого маршрута: ${u.pathname}` });
        const hit = candidates.find((x) => x.r.method === req.method);
        if (!hit) return sendJson(res, 405, { error: 'метод не поддерживается' });
        const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);
        const params = Object.fromEntries(Object.entries(hit.m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
        const call = () => hit.r.handler({ req, body, params, query: Object.fromEntries(u.searchParams) });
        const jobId = req.headers['x-job-id'];
        const result = typeof jobId === 'string' && JOB_ID_RE.test(jobId) ? await runJob({ id: jobId, title: hit.r.title, send: bus.send }, call) : await call();
        return sendJson(res, 200, result);
      }
      if (vite) {
        return vite.middlewares(req, res, (err) => (err ? sendJson(res, 500, { error: err.message }) : serveIndex(res, u.pathname).catch((e) => sendJson(res, 500, { error: e.message }))));
      }
      return serveStatic(req, res, u.pathname);
    } catch (e) {
      const status = Number.isInteger(e.status) ? e.status : 500;
      if (!Number.isInteger(e.status)) console.error(`[harness] ${req.method} ${u.pathname}:`, e);
      if (!res.headersSent) sendJson(res, status, { error: e.message || String(e), ...(e.details || {}) });
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

  if (opts.demo) seedDemoTasks({ db, tasks, store });
  const port = opts.port ?? (opts.demo ? DEMO_PORT : config.port ?? 4777);
  await new Promise((resolve, reject) => {
    server.once('error', (e) => {
      sessions.close();
      store.close();
      if (e.code !== 'EADDRINUSE') return reject(e);
      const hint = process.platform === 'win32' ? `netstat -ano | findstr :${port}` : `lsof -i :${port}`;
      reject(Object.assign(new Error(`Порт ${port} уже занят (старый harness?). Найдите процесс: ${hint} — или задайте "port" в harness.config.local.json.`), { code: 'EADDRINUSE' }));
    });
    server.listen(port, config.host, () => resolve());
  });
  const actualPort = server.address().port;
  url = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${actualPort}`;
  writeAtomic(serverJson, JSON.stringify({ url, pid: process.pid }));
  schedulePrs();
  // turns that kept running while the harness was down (needs the URL for follow-up turns), queues, terminals, reviews
  await sessions.resumeRuns();
  orch.resumeReviews();
  scheduleSync();
  // best-effort: folders renamed to *.stale-<ts> by earlier deletions (files held by antivirus/indexer)
  for (const dir of [config.dataDir, path.join(config.dataDir, 'runs'), ...db.workspaces.map((w) => git.worktreeRootFor(w.path, config.worktreeRoot))]) {
    git.sweepStale(dir);
  }

  let closed = false;
  return {
    url,
    port: actualPort,
    token: store.token,
    /** synchronous write of everything pending (signal handlers) */
    flush: () => store.flush(),
    config,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(syncTimer);
      clearInterval(prTimer);
      clearInterval(sddTimer);
      clearInterval(linkTimer);
      await catalog.close();
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

/**
 * One harness per data dir. A live pid in <dataDir>/server.json is a conflict only if that harness answers
 * /api/health as that pid within 1 s; otherwise the lock is stale (crash, reused pid) and is taken over.
 */
async function assertSingleInstance(serverJson, dataDir) {
  let other;
  try {
    other = JSON.parse(fs.readFileSync(serverJson, 'utf8'));
  } catch {
    return;
  }
  if (!other?.pid || other.pid === process.pid || !isAlive(other.pid) || typeof other.url !== 'string') return;
  let health = null;
  try {
    health = await (await fetch(`${other.url}/api/health`, { signal: AbortSignal.timeout(1000) })).json();
  } catch {}
  if (health?.ok !== true || health.pid !== other.pid) return;
  throw Object.assign(new Error(`Другой harness (pid ${other.pid}, ${other.url}) уже работает с ${dataDir}. Остановите его или используйте другой dataDir.`), { code: 'ELOCKED' });
}

/** Whether the launcher found the package identity and where (the shim); never the value itself. */
function identityView(a) {
  try {
    const env = launchers[a.launcher]?.resolve(a)?.env || {};
    return { found: !!env.GIGACODE_PACKAGE_IDENTITY, source: env.GIGACODE_PACKAGE_LAUNCHER ?? null };
  } catch {
    return { found: false, source: null };
  }
}

/** { ok, command, node, entry, identity: boolean } of an agent's launcher resolution, or { ok: false, error }. */
function resolveAgentView(a) {
  try {
    const r = launchers[a.launcher]?.resolve(a);
    if (!r) return { ok: false, identity: false, error: `неизвестный лаунчер «${a.launcher}»` };
    const entry = r.args.filter((x) => /\.[cm]?js$/i.test(x)).pop() ?? null;
    return {
      ok: true,
      command: r.env?.GIGACODE_PACKAGE_LAUNCHER || (entry ? null : r.file),
      node: entry ? r.file : null,
      entry,
      identity: !!r.env?.GIGACODE_PACKAGE_IDENTITY,
    };
  } catch (e) {
    return { ok: false, identity: false, error: e.message };
  }
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
    shell: config.shell,
    defaultAgent: config.defaultAgent,
    agents: Object.fromEntries(Object.entries(config.agents).map(([id, a]) => {
      let resolved;
      try {
        const r = launchers[a.launcher]?.resolve(a);
        resolved = r ? { file: ex(r.file), args: r.args } : { error: `неизвестный лаунчер «${a.launcher}»` };
      } catch (e) {
        resolved = { error: e.message };
      }
      const command = a.launcher === 'gigacode' ? gigacodeCommand(a) : { command: a.command ?? launchers[a.launcher]?.defaults.command ?? null, reason: a.command ? 'configured' : 'launcher default' };
      return [id, { launcher: a.launcher, enabled: a.enabled !== false, approvalMode: a.approvalMode ?? null, approvalModes: a.approvalModes || [], command, resolved, identity: identityView(a) }];
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
  const demo = process.argv.includes('--demo');
  startServer({ dev, demo }).then((srv) => {
    console.log(`Harness running at ${srv.url}${dev ? ' (dev, Vite middleware)' : ''}${demo ? ' (offline demo: mock agent, fixture tracker and PR service)' : ''}`);
    const shutdown = () => {
      srv.flush(); // synchronously first: the async close below may not finish before a second signal
      srv.close().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }, (e) => {
    console.error(`Harness failed to start: ${e.message}`);
    process.exit(1);
  });
}
