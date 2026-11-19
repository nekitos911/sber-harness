// Session manager: chat sessions (one CLI process per turn, queue of deliveries that wakes the session),
// terminal sessions (PTY), statuses, transcripts. Orchestration plugs in through hooks (preamble, turnEnded).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CODE_ROOT } from './config.js';
import { launchers } from './launchers.js';
import { runTurn, isAlive, sameProcess } from './runner.js';
import { baseId } from './models.js';
import { secretEnv } from './mcp-client.js';
import { readRegistry } from './registry.js';
import { createAcp } from './acp.js';
import * as git from './git.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// Windows caps a whole command line at 32767 UTF-16 units (Linux one argument at 128 KiB): a longer prompt goes in a file
const ARGV_PROMPT_MAX = 24000;
export const newId = (prefix, bytes = 4) => `${prefix}_${randomBytes(bytes).toString('hex')}`;
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const insideDir = (dir, p) => { const r = path.relative(dir, p); return !r.startsWith('..') && !path.isAbsolute(r); };
const samePath = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const sameDir = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/**
 * session.includeDirs: absolute existing folders, de-duplicated, without cwd and its ancestors (the CLI sees those
 * anyway). `strict` (API input) rejects a bad entry; auto-filled lists just drop it.
 */
export function normalizeIncludeDirs(dirs, cwd, strict = true) {
  if (dirs == null) return [];
  if (!Array.isArray(dirs) || dirs.some((d) => typeof d !== 'string')) fail(400, 'includeDirs: нужен массив путей к папкам');
  const out = [];
  for (const d of dirs) {
    const ok = path.isAbsolute(d) && isDir(d);
    if (!ok) {
      if (strict) fail(400, `includeDirs: не существующая абсолютная папка: ${d}`);
      continue;
    }
    const p = path.resolve(d);
    if (cwd && insideDir(p, cwd)) continue;
    if (!out.some((x) => sameDir(x, p))) out.push(p);
  }
  return out;
}
const tail = (text) => (text ? `\n\nstderr:\n${text.slice(-2000).trim()}` : '');
const fence = (lines) => `\`\`\`text\n${lines.join('\n')}\n\`\`\``;
const REGISTRY_POLL_MS = 2000;
const QUESTION_TOOLS = ['ask_user_question', 'ask_user', 'AskUserQuestion']; // VERIFY the real GigaCode name
export const FULL_ACCESS_MODES = new Set(['auto', 'yolo', 'bypassPermissions']); // «Полный доступ» (as web/src/lib/agents.ts)
// confirmed: `GigaCode requires permission to use "run_shell_command", but that permission was declined (...)`
// What a CLI writes when it refused a call for lack of permission (GigaCode: «requires permission to use "X", but that
// permission was declined (non-interactive mode cannot prompt for confirmation)»). Never bare words such as «permission»
// or «запрещён»: an ordinary tool error that quotes its arguments (a sub-agent's prompt) is not a denial.
const DENIAL_RE = /(requires permission to use|permission (was|has been) (declined|denied)|cannot prompt for confirmation|haven't granted it yet)/i;
const EDIT_TOOLS = /^(write_file|replace|edit|edit_file|write|apply_patch|create_file)$/i;

/** The allow-list entry for a denied call: run_shell_command(<first non-cd command word>), else the tool name. */
export function permissionPattern(tool, input) {
  if (!/shell|bash|command/i.test(tool) || typeof input?.command !== 'string') return tool;
  const first = input.command.split(/&&|\|\||;|\|/).map((x) => x.trim()).find((x) => x && !/^cd(\s|$)/i.test(x));
  const word = first?.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  const name = word ? (word[1] ?? word[2] ?? word[3]).split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '') : null;
  return name ? `${tool}(${name})` : tool;
}

/** A denied tool_result -> { tool, reason } or null (agents.<id>.denialPattern overrides the default). */
function denialOf(agentCfg, ev, fallbackTool) {
  const text = String(ev.output ?? '');
  if (!ev.isError || !(agentCfg?.denialPattern ? new RegExp(agentCfg.denialPattern, 'i') : DENIAL_RE).test(text)) return null;
  return { tool: text.match(/requires permission to use "(.+?)"/i)?.[1] || fallbackTool || 'tool', reason: text.slice(0, 2000) };
}
export const PERMISSION_OPTIONS = [
  { id: 'allow_once', label: 'Разрешить один раз' },
  { id: 'allow_session', label: 'Разрешать в этой сессии' },
  { id: 'allow_project', label: 'Разрешать всегда в этом проекте' }, // only for a session in a project (workspaceId)
  { id: 'reject', label: 'Запретить' },
];
/** First line of the first message as a chat title: ≤ 60 chars, a leading slash dropped («/full-task PROJ-1» → «full-task PROJ-1»). */
export const titleFrom = (text) => String(text).split('\n').map((l) => l.trim()).find(Boolean)?.replace(/^\//, '').replace(/\s+/g, ' ').slice(0, 60) || null;
/** «<profile> · <first line of the assignment, ≤ 50>» for a sub-agent's chat. */
export const subagentTitle = (profile, spec) => [profile, titleFrom(spec || '')?.slice(0, 50)].filter(Boolean).join(' · ');
/** "262k" → 262000, "1M" → 1000000, "128000" → 128000; null when not a size. */
export const contextSize = (v) => {
  const m = String(v ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/);
  return m ? Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[m[2]?.toLowerCase()] ?? 1)) : null;
};
/** Exit codes as signed numbers: Windows reports a forced end as 4294967295 (= -1). */
/** A tool call whose turn ended without its result (stopped, crashed, the harness restarted): never «running» again. */
export const UNFINISHED_TOOL = 'Ход закончился без результата этого вызова.';

/**
 * The queued messages as one prompt. A slash command («/full-task …») works only as the prompt's first word: queued
 * behind a helper's report it went in as plain text and the command never ran. It goes first, the rest after it.
 */
export function promptOf(items) {
  const at = items.findIndex((i) => i.text.trimStart().startsWith('/'));
  const ordered = at > 0 ? [items[at], ...items.filter((_, n) => n !== at)] : items;
  return ordered.map((i, n) => (n === 0 && at >= 0 ? i.text.trimStart() : i.text)).join('\n\n');
}

const EDIT_TOOL = /^(edit|replace|write_file|writefile|write|multiedit|apply_patch|create_file|str_replace\w*)$/i;
/**
 * What this chat was about, from the harness's own transcript, for an agent whose CLI session could not be loaded (a new
 * one has none of it): the task, the person's messages, the agent's latest answers, the files it changed. Turns before
 * `beforeTurn` only (the current turn's message goes as itself). '' when there is nothing before.
 */
export function recapText(messages, beforeTurn, max = 9000) {
  const past = messages.filter((m) => (m.turn ?? 0) < beforeTurn);
  if (!past.some((m) => m.kind === 'user' || m.kind === 'assistant')) return '';
  const cut = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);
  const first = past.find((m) => m.kind === 'user');
  const edited = [...new Set(past.filter((m) => m.kind === 'tool' && m.tool && EDIT_TOOL.test(m.tool.name) && m.tool.status !== 'error')
    .map((m) => m.tool.input?.file_path ?? m.tool.input?.absolute_path ?? m.tool.input?.path).filter((p) => typeof p === 'string'))];
  const lines = past.filter((m) => m !== first && (m.kind === 'user' || m.kind === 'assistant') && m.text?.trim())
    .map((m) => `${m.kind === 'user' ? 'Человек' : 'Ты'}: ${cut(m.text.trim(), m.kind === 'user' ? 800 : 600)}`);
  const head = [
    '[harness] Твоя прежняя сессия не загрузилась (ошибка CLI), это новая — без прежнего контекста. Ниже — запись этого чата в харнессе:',
    'продолжай с того места, где остановился; не начинай заново и не переделывай сделанное (проверь по файлам и git).',
    first ? `\nПервое сообщение (задача):\n${cut(first.text.trim(), 1500)}` : '',
    edited.length ? `\nФайлы, которые ты уже менял: ${edited.slice(0, 40).join(', ')}` : '',
  ].filter(Boolean).join('\n');
  // the latest exchanges matter most: keep from the end while it fits
  const tail = [];
  let size = head.length;
  for (const l of lines.reverse()) {
    if (size + l.length > max) break;
    tail.unshift(l);
    size += l.length + 1;
  }
  return [head, tail.length ? `\nПоследнее в чате:\n${tail.join('\n')}` : ''].filter(Boolean).join('\n');
}
export const settledTool = (tool) => ({ ...tool, status: 'error', output: tool.output ?? UNFINISHED_TOOL });

export const signedCode = (code) => (Number.isInteger(code) && code > 0x7fffffff ? code - 0x100000000 : code);

/** A structured question tool call -> { text, options: [{label, description?}], multiSelect } (tolerant of shapes). */
export function parseQuestion(input = {}) {
  const one = (q, outer = {}) => {
    const opts = Array.isArray(q.options) ? q.options : Array.isArray(outer.options) ? outer.options : [];
    return {
      text: String(q.question ?? q.text ?? q.prompt ?? outer.question ?? ''),
      options: opts.map((o) => (typeof o === 'string' ? { label: o } : { label: String(o?.label ?? o?.text ?? o?.value ?? ''), ...(o?.description ? { description: String(o.description) } : {}) })).filter((o) => o.label),
      multiSelect: !!(q.multiSelect ?? outer.multiSelect),
    };
  };
  const list = Array.isArray(input?.questions) ? input.questions.filter((q) => q && typeof q === 'object') : [];
  if (list.length < 2) return one(list[0] || input || {}, input || {});
  // several questions in one call: all of them in one card (the text lists them for the inbox), answered together
  const parts = list.map((q) => ({ ...one(q), ...(q.header ? { header: String(q.header) } : {}) }));
  return { text: parts.map((p, i) => `${i + 1}. ${p.text}`).join('\n'), options: [], multiSelect: false, parts };
}

/**
 * Working folder of a session created without cwd/workspace: a chat gets its own folder (survives restarts), an agent
 * terminal (the interactive CLI, e.g. the one-time GigaCode login) starts in <dataDir>/chats/login, a shell in the root.
 */
export function defaultCwd({ kind, agentTerminal, dataDir, id, root }) {
  if (kind === 'chat') return path.join(dataDir, 'chats', id);
  return agentTerminal ? path.join(dataDir, 'chats', 'login') : root;
}

let ptyModule; // undefined = not tried, null = failed
let ptyError = '';
async function loadPty() {
  if (ptyModule === undefined) {
    try {
      const m = await import('@lydell/node-pty');
      ptyModule = m.default ?? m;
    } catch (e) {
      ptyModule = null;
      ptyError = e.message;
    }
  }
  if (!ptyModule) fail(501, `Терминалы недоступны: не загружается @lydell/node-pty (${ptyError})`);
  return ptyModule;
}

/** Why a running turn could not be continued: the machine rebooted after it started, the harness crashed, or a restart. */
export function interruptReason({ startedAt, bootTime, crashed }) {
  if (startedAt && bootTime > startedAt) return 'reboot';
  return crashed ? 'crash' : 'harness_restart';
}

/** POSIX terminals: a UTF-8 locale when the harness itself runs without one (Cyrillic output). */
const utf8Locale = () => (process.platform !== 'win32' && !process.env.LANG && !process.env.LC_ALL ? { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } : {});

/**
 * node-pty's Windows kill() asks a forked helper for the console's processes and, when that fails because the shell is
 * already gone, process.kill()s the shell's pid ~5 s later - a pid Windows may have given to another process by then
 * (it killed agents and git runs of other sessions). Closing the pseudoconsole ends the attached processes anyway.
 */
function killPty(p) {
  if (!p) return;
  // shortcut: patches a private node-pty field (WindowsPtyAgent._getConsoleProcessList); re-check on a node-pty upgrade
  if (process.platform === 'win32' && p._agent) p._agent._getConsoleProcessList = () => Promise.resolve([]);
  try { p.kill(); } catch {}
}

const brief = (input) => {
  if (input == null) return '';
  const text = String(typeof input === 'string' ? input : input.command ?? input.file_path ?? input.path ?? JSON.stringify(input));
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
};

export function createSessions({ config, store, bus, getUrl, catalog = null, crashed = false }) {
  const db = store.db;
  const rt = new Map(); // sid -> runtime state (not persisted)
  store.keepLoaded = (sid) => !!rt.get(sid)?.running; // a streaming turn keeps its transcript in memory
  // agents.<id>.transport "acp": long-lived agent processes; session.warm = its process is loaded
  const acp = createAcp({
    onWarm(sid, warm) {
      const s = find(sid);
      if (s && !!s.warm !== warm) {
        s.warm = warm;
        emit(s);
      }
    },
  });
  const hooks = { preamble: () => '', turnEnded: () => {} };

  const find = (sid) => db.sessions.find((s) => s.id === sid);
  const get = (sid) => find(sid) || fail(404, `сессия ${sid} не найдена`);
  const runDir = (sid) => path.join(store.dataDir, 'runs', sid);
  const registryDir = (sid) => path.join(runDir(sid), 'registry');
  const attachmentsDir = (sid) => path.join(runDir(sid), 'attachments'); // pasted screenshots (POST /api/sessions/:id/attachments)

  function runtime(sid) {
    if (!rt.has(sid)) {
      const s = find(sid);
      // s.turnCount: no transcript load just for the number (sessions from before it: once, then kept)
      const turn = s?.turnCount ?? store.messages(sid).reduce((m, x) => Math.max(m, x.turn || 0), 0);
      if (s) s.turnCount = turn;
      rt.set(sid, { queue: [], running: false, handle: null, turn, flags: {}, cur: null, pty: null, previewAt: 0, registrySig: '' });
    }
    return rt.get(sid);
  }

  function emit(s) {
    store.save();
    bus.send({ t: 'session', session: s });
    try {
      hooks.sessionChanged?.(s); // e.g. the agent badge of the session's task
    } catch (e) {
      console.error('[sessions] sessionChanged hook failed:', e);
    }
    return s;
  }

  /** waitingFor: 'answer' (ask / a question card) | 'permission' | 'auth' | null; any delivery clears answer/permission. */
  function setWaiting(s, what) {
    if (s.waitingFor === what) return;
    s.waitingFor = what;
    emit(s);
  }

  function addMessage(s, fields) {
    const msg = { id: newId('m', 5), sessionId: s.id, at: Date.now(), kind: 'system', text: '', from: null, tool: null, turn: runtime(s.id).turn, ...fields };
    store.putMessage(s.id, msg);
    bus.send({ t: 'msg', sessionId: s.id, msg });
    return msg;
  }

  function updateMessage(s, msg) {
    store.putMessage(s.id, msg);
    bus.send({ t: 'msg', sessionId: s.id, msg });
  }

  // HARNESS_SERVER_JSON: harness-mcp finds a restarted harness there (its URL may change) and retries meanwhile
  const harnessEnv = (s) => ({ HARNESS_URL: getUrl(), HARNESS_TOKEN: store.token, HARNESS_SESSION_ID: s.id, HARNESS_SERVER_JSON: path.join(store.dataDir, 'server.json') });

  /** Agent config + launcher + executable for an agent id; throws 400 with a clear message (fail fast). */
  function resolveAgent(agent, launcherId) {
    const agentCfg = config.agents[agent] || fail(400, `неизвестный агент «${agent}»`);
    if (agentCfg.enabled === false) fail(400, `агент «${agent}» выключен в настройках`);
    if (launcherId && agentCfg.launcher !== launcherId) {
      fail(409, `агент «${agent}» теперь использует лаунчер «${agentCfg.launcher}», а сессия начата с «${launcherId}»; сессия не меняет CLI — начните новый чат`);
    }
    const launcher = launchers[agentCfg.launcher] || fail(400, `у агента «${agent}» неизвестный лаунчер «${agentCfg.launcher}»`);
    let exe;
    try {
      exe = launcher.resolve(agentCfg);
    } catch (e) {
      fail(400, e.message);
    }
    return { agentCfg, launcher, exe };
  }

  function checkMode(agentCfg, mode) {
    if (mode && agentCfg.approvalModes?.length && !agentCfg.approvalModes.includes(mode)) {
      fail(400, `режим подтверждений «${mode}» не из списка: ${agentCfg.approvalModes.join(', ')}`);
    }
  }

  /** Grades whose model a fresh discovery no longer lists are left out (the CLI then uses its default model). */
  function droppedGrades(s) {
    const gone = catalog?.unavailable(s.agent) ?? { has: () => false };
    const grades = config.agents[s.agent]?.settings?.agents?.modelGrades || {};
    return Object.entries(grades).filter(([, id]) => gone.has(id));
  }

  /**
   * The agent config a turn runs with: the launcher's autoSandbox default resolved, and — once the sandbox proved
   * unavailable on this machine (agentMeta.sandboxBroken) — no sandbox and auto -> auto-edit.
   */
  function sandboxed(s, cfg) {
    const defaults = launchers[cfg.launcher]?.defaults || {};
    const agentCfg = db.agentMeta[s.agent]?.partialUnsupported ? { ...cfg, partialMessagesFlag: null } : cfg; // the CLI rejected it once
    const sandbox = agentCfg.autoSandbox === undefined ? defaults.autoSandbox ?? null : agentCfg.autoSandbox;
    if (!db.agentMeta[s.agent]?.sandboxBroken) return sandbox === agentCfg.autoSandbox ? agentCfg : { ...agentCfg, autoSandbox: sandbox };
    return { ...agentCfg, autoSandbox: null, approvalModeMap: { ...(agentCfg.approvalModeMap ?? defaults.approvalModeMap ?? {}), auto: 'auto-edit' } };
  }

  function runConfig(s, cfg) {
    const agentCfg = sandboxed(s, cfg);
    const dropped = droppedGrades(s);
    if (!dropped.length) return agentCfg;
    const names = new Set(dropped.map(([g]) => g));
    const agents = agentCfg.settings?.agents || {};
    return {
      ...agentCfg,
      settings: {
        ...agentCfg.settings,
        agents: {
          ...agents,
          modelGrades: Object.fromEntries(Object.entries(agents.modelGrades || {}).filter(([g]) => !names.has(g))),
          allowedGrades: (agents.allowedGrades || []).filter((g) => !names.has(g)),
        },
      },
    };
  }

  function turnCtx(s, agentCfg, prompt) {
    return {
      prompt,
      session: s,
      agentCfg: runConfig(s, agentCfg),
      settingsPath: s.settingsPath,
      mcpConfigPath: path.join(runDir(s.id), 'mcp.json'),
      harnessMcp: { command: process.execPath, args: [path.join(CODE_ROOT, 'mcp', 'harness-mcp.js')], env: harnessEnv(s) },
      agentMcpServers: config.agentMcpServers || {},
    };
  }

  function pollRegistry(s) {
    const r = runtime(s.id);
    const dir = registryDir(s.id);
    if (!fs.existsSync(dir)) return;
    const { items } = readRegistry(dir, { idleWindowSec: config.session.idleWindowSec });
    const sig = JSON.stringify(items);
    if (sig === r.registrySig) return;
    r.registrySig = sig;
    bus.send({ t: 'subagents', sessionId: s.id, items });
  }

  /** Output file of the newest turn of a session (runs/<sid>/turn-<n>.out.ndjson), or null. */
  function latestTurnFile(sid) {
    let best = null;
    try {
      for (const name of fs.readdirSync(runDir(sid))) {
        const m = name.match(/^turn-(\d+)\.out\.ndjson$/);
        if (m && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), file: path.join(runDir(sid), name) };
      }
    } catch {}
    return best?.file ?? null;
  }

  // ---- startup recovery ----
  const toReattach = []; // turns that kept running (or finished) while the harness was down
  const toRespawn = []; // terminals that were alive: PTYs cannot outlive the server
  const startupAt = Date.now();
  /** session.interrupted { at, reason, lastActivity }: listed by GET /api/recovery until resumed or dismissed. */
  function markInterrupted(s) {
    const msgs = store.messages(s.id);
    const tool = msgs.findLast((m) => m.kind === 'tool' && m.tool);
    const said = msgs.findLast((m) => m.kind === 'assistant' && m.text);
    const lastActivity = tool ? `${tool.tool.name} ${brief(tool.tool.input)}`.trim() : said ? brief(said.text) : null;
    s.interrupted = { at: Date.now(), reason: interruptReason({ startedAt: s.pidStartedAt || s.lastActivityAt, bootTime: Date.now() - os.uptime() * 1000, crashed }), lastActivity };
    addMessage(s, { kind: 'system', text: INTERRUPTED });
  }
  const INTERRUPTED = 'Harness перезапущен, ход прерван — отправьте сообщение, чтобы продолжить (контекст сохраняется через --resume)';
  for (const s of db.sessions) {
    if (s.kind === 'chat') {
      s.queue = Array.isArray(s.queue) ? s.queue : []; // persisted deliveries survive a restart
      if ('runResult' in s) { // db from before `report`
        s.report ??= s.runResult && { ...s.runResult, at: s.lastActivityAt };
        delete s.runResult;
      }
    }
    s.queued = s.queue?.length ?? 0;
    if (s.warm) s.warm = false; // ACP processes do not survive a restart (reloaded on the next message)
    s.tokensIn ??= 0;
    s.tokensOut ??= 0;
    s.phase = null;
    if (s.kind === 'chat' && s.everStarted === undefined && (s.externalSessionId || s.tokensIn)) s.everStarted = true; // db from before the flag
    const closing = s.turnClosing; // the turn's result was in, only its process was still closing
    s.turnClosing = false; // a lingering process is not followed across a restart (re-attach sets it again at result)
    if (s.virtual) continue; // settled below, once we know which parents are re-attached
    if (s.kind === 'chat' && s.status === 'running' && s.pid && latestTurnFile(s.id)) {
      toReattach.push(s);
      runtime(s.id).running = true; // no new turn until resumeRuns() has decided about this one
      continue;
    }
    s.pid = null;
    if (s.kind === 'chat' && s.status === 'running') {
      s.status = 'idle';
      if (!closing) markInterrupted(s); // an answered turn was not cut: no «прервана», nothing to resume
    } else if (s.kind === 'terminal' && s.status !== 'exited') {
      if (config.terminal?.autoRespawn !== false) toRespawn.push(s);
      else {
        s.status = 'exited';
        store.appendTermLog(s.id, '\r\n[harness restarted]\r\n');
      }
    }
  }
  // a built-in sub-agent chat whose parent turn did not survive the restart will never get its result
  for (const v of db.sessions.filter((x) => x.virtual && x.status === 'running')) {
    if (!toReattach.some((p) => p.id === v.parentId)) v.status = 'failed';
  }
  store.save();

  // ---- chat turns ----

  /** Built-in sub-agent activity (parent_tool_use_id) -> compact lines on the parent tool call, not the main chat. */
  const SUBAGENT_TOOLS = /^(agent|fork)$/i;
  // harness `agent` calls whose stream line has not come yet: parent id -> [{ prompt, workerId, at }] (see adoptVirtual)
  const adopted = new Map();
  function takeAdopted(parentId, prompt) {
    const list = (adopted.get(parentId) || []).filter((x) => Date.now() - x.at < 10 * 60000);
    const i = list.findIndex((x) => x.prompt === prompt);
    const hit = i >= 0 ? list.splice(i, 1)[0] : null;
    if (list.length) adopted.set(parentId, list); else adopted.delete(parentId);
    return hit?.workerId ?? null;
  }
  /** The copy goes; the parent's tool line opens the real chat (in place: the running turn writes this message again). */
  function replaceCopy(v, workerId) {
    const line = [...(runtime(v.parentId).cur?.tools?.values() ?? []), ...store.messages(v.parentId)].find((m) => m.tool?.subSessionId === v.id);
    if (line) { line.tool.subSessionId = workerId; updateMessage(get(v.parentId), line); }
    api.remove(v.id, { force: true });
  }
  const virtualId = (sid, toolId) => `${sid}~${toolId}`;

  /** Level 1: a built-in sub-agent call (agent/fork tool) becomes a read-only chat nested under its parent. */
  /** Title, model and first message of a sub-agent chat, from the agent/fork call's input. */
  function virtualInfo(name, raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const kind = input.subagent_type || (name.toLowerCase() === 'fork' ? 'fork' : 'agent');
    return {
      title: subagentTitle(kind, input.description || input.prompt),
      model: typeof input.model === 'string' ? input.model : null,
      prompt: typeof input.prompt === 'string' ? input.prompt : JSON.stringify(input),
    };
  }

  function openVirtual(s, ev, c) {
    const id = virtualId(s.id, ev.id);
    const now = Date.now();
    const info = virtualInfo(ev.name, ev.input);
    const real = takeAdopted(s.id, info.prompt);
    if (real) return real;
    const v = find(id) || {
      id, kind: 'chat', virtual: true, title: info.title, agent: s.agent, launcherId: null,
      cwd: s.cwd, workspaceId: s.workspaceId, worktreePath: s.worktreePath ?? null, system: !!s.system, branch: s.branch, role: 'subagent', parentId: s.id, taskId: s.taskId, status: 'running',
      externalSessionId: null, settingsPath: null, model: info.model, approvalMode: null,
      autoReport: false, queued: 0, preview: '', command: null, pid: null, tokensIn: 0, tokensOut: 0, phase: null, turnOffset: null,
      createdAt: now, lastActivityAt: now,
    };
    if (!find(id)) db.sessions.push(v);
    Object.assign(v, { status: 'running', lastActivityAt: now });
    emit(v);
    (c.virtualPrompts ||= new Map()).set(id, addMessage(v, { kind: 'user', text: info.prompt, from: s.id }));
    return id;
  }

  /** The real input arrived after the call (ACP): redo the chat's title, model and task message. */
  function fillVirtual(c, id, name, input) {
    const v = find(id);
    if (!v?.virtual) return;
    const info = virtualInfo(name, input);
    const real = takeAdopted(v.parentId, info.prompt);
    if (real) return replaceCopy(v, real);
    Object.assign(v, { title: info.title, model: info.model ?? v.model });
    emit(v);
    const first = c.virtualPrompts?.get(id);
    if (first) {
      first.text = info.prompt;
      updateMessage(v, first);
    }
  }

  /** Events of a built-in sub-agent (parentToolId) go into its virtual chat with the usual message shapes. */
  function applyVirtual(s, c, ev) {
    const v = find(virtualId(s.id, ev.parentToolId));
    if (!v) return;
    const vc = (c.virtual ||= new Map()).get(v.id) || { assistant: null, thought: null, tools: new Map() };
    c.virtual.set(v.id, vc);
    v.lastActivityAt = Date.now();
    if (ev.type === 'text' || ev.type === 'thought') {
      const kind = ev.type === 'text' ? 'assistant' : 'thought';
      vc[kind === 'assistant' ? 'thought' : 'assistant'] = null;
      if (ev.delta && vc[kind]) {
        vc[kind].text += ev.text;
        updateMessage(v, vc[kind]);
      } else {
        const m = addMessage(v, { kind, text: ev.text });
        vc[kind] = ev.delta ? m : null;
      }
      if (kind === 'assistant') v.preview = (vc.assistant?.text ?? ev.text).slice(-200);
    } else if (ev.type === 'tool_call') {
      vc.assistant = vc.thought = null;
      vc.tools.set(ev.id, addMessage(v, { kind: 'tool', text: ev.name, tool: { id: ev.id, name: ev.name, input: ev.input, output: null, status: 'running' } }));
    } else if (ev.type === 'tool_result') {
      vc.assistant = vc.thought = null;
      const m = vc.tools.get(ev.id);
      if (m) {
        m.tool = { ...m.tool, output: ev.output, status: ev.isError ? 'error' : 'ok' };
        updateMessage(v, m);
      }
    } else if (ev.type === 'error') addMessage(v, { kind: 'error', text: ev.text });
  }

  /** The parent's tool_result of the sub-agent call: its final answer and status. */
  function closeVirtual(s, ev) {
    const v = find(virtualId(s.id, ev.id));
    if (!v?.virtual) return;
    addMessage(v, { kind: ev.isError ? 'error' : 'assistant', text: ev.output || '(no output)' });
    Object.assign(v, { status: ev.isError ? 'failed' : 'done', preview: (ev.output || '').slice(-200), lastActivityAt: Date.now() });
    emit(v); // stays beside its parent until the parent's turn ends (settleVirtuals), like Orca
  }

  /** A headless permission card (in the PARENT for a sub-agent's denial: it is the parent's next turn that retries). */
  function permissionCard(s, { toolId, tool, input, reason, sub = null }) {
    addMessage(s, {
      kind: 'permission', text: sub ? `субагент ${sub.type}: ${tool}` : '', ...(sub ? { from: sub.id } : {}),
      permission: { id: newId('p'), toolId, tool, input, reason, pattern: permissionPattern(tool, input), transport: 'headless', options: PERMISSION_OPTIONS.filter((o) => o.id !== 'allow_project' || s.workspaceId), resolved: null, answered: false, ...(sub ? { fromSubSessionId: sub.id } : {}) },
    });
    setWaiting(s, 'permission');
  }

  /**
   * A tool failed inside GigaCode's sandbox (e.g. «GigaCode sandbox: acl-object-hardlink (Win32 50)»): the sandbox does not
   * work on this machine. Same as a run that fails on it: agentMeta.sandboxBroken, the next turns run without it.
   */
  function sandboxToolFailure(s, ev) {
    if (ev.type !== 'tool_result' || !ev.isError || !/GigaCode sandbox:/i.test(ev.output || '')) return;
    if (db.agentMeta[s.agent]?.sandboxBroken || !sandboxed(s, config.agents[s.agent] || {}).autoSandbox) return;
    const why = (ev.output.split('\n').find((l) => /GigaCode sandbox:/i.test(l)) || ev.output).trim().slice(0, 300);
    db.agentMeta[s.agent] = { ...db.agentMeta[s.agent], sandboxBroken: { at: Date.now(), error: why } };
    store.save();
    addMessage(s, { kind: 'system', text: `⚠ Песочница GigaCode не работает на этой машине: ${why}. Следующие ходы — без песочницы («Полный доступ» = «Авто-правки» + разрешённые команды).` });
  }

  function subagentProgress(s, c, ev) {
    sandboxToolFailure(s, ev);
    applyVirtual(s, c, ev);
    if (ev.type === 'tool_call') (c.subInputs ||= new Map()).set(ev.id, ev.input);
    if (ev.type === 'tool_result') {
      const denied = denialOf(config.agents[s.agent], ev, c.subTools.get(ev.id));
      const v = find(virtualId(s.id, ev.parentToolId));
      if (denied) permissionCard(s, { toolId: ev.id, tool: denied.tool, input: c.subInputs?.get(ev.id) ?? null, reason: denied.reason, sub: { id: v?.id ?? null, type: v?.title?.split(' · ')[0] || 'agent' } });
    }
    const parent = c.tools.get(ev.parentToolId);
    if (!parent) return;
    const short = (v, n = 160) => {
      const t = (typeof v === 'string' ? v : JSON.stringify(v) ?? '').replace(/\s+/g, ' ').trim();
      return t.length > n ? `${t.slice(0, n)}…` : t;
    };
    let line = null;
    if (ev.type === 'text') line = short(ev.text, 200);
    else if (ev.type === 'tool_call') {
      c.subTools.set(ev.id, ev.name);
      line = `→ ${ev.name} ${short(ev.input, 120)}`;
    } else if (ev.type === 'tool_result') line = `${ev.isError ? '✗' : '✓'} ${c.subTools.get(ev.id) || 'tool'} ${short(ev.output, 120)}`;
    else if (ev.type === 'error') line = `✗ ${short(ev.text)}`;
    if (!line) return;
    parent.tool = { ...parent.tool, progress: [...(parent.tool.progress || []), line].slice(-50) };
    updateMessage(s, parent);
  }

  function applyEvent(s, ev) {
    if (!find(s.id)) return; // deleted while running
    const r = runtime(s.id);
    const c = r.cur;
    s.lastActivityAt = Date.now();
    if (ev.type !== 'auth') {
      s.lastEventAt = s.lastActivityAt;
      s.everStarted ||= true; // some turn of this session produced output: an error later is not «не запустился»
    }
    const kind = { text: ev.delta ? 'text_delta' : 'assistant_final', thought: 'thought', tool_call: 'tool_running', tool_result: 'tool_done', result: 'result' }[ev.type];
    if (kind && s.lastEventKind !== kind) {
      s.lastEventKind = kind; // «Пишет ответ» vs «Завершает ход…» in the UI
      emit(s);
    }
    if (s.stalled) {
      s.stalled = false;
      emit(s);
    }
    if (ev.type === 'auth') {
      s.waitingFor = 'auth';
      // the CLI waits for a browser login (first run on this machine); it continues by itself afterwards
      const label = config.agents[s.agent]?.label || s.agent;
      const text = `🔑 ${label} ждёт авторизацию…${ev.code ? ` Код: ${ev.code}` : ''}`;
      s.phase = 'auth';
      emit(s);
      addMessage(s, { kind: 'system', text, link: ev.url });
      hooks.notify?.({ kind: 'info', sessionId: s.id, taskId: s.taskId, text: `${s.title}: ${text}`, link: ev.url });
      db.agentMeta[s.agent] = { ...db.agentMeta[s.agent], auth: 'required' };
      store.save();
      return;
    }
    if (s.phase !== 'streaming' && !(s.phase === 'auth' && ev.type === 'raw')) {
      s.phase = 'streaming';
      if (s.waitingFor === 'auth') s.waitingFor = null;
      emit(s);
    }
    if (ev.parentToolId) return subagentProgress(s, c, ev);
    if (ev.type !== 'raw') c.raw = null;
    switch (ev.type) {
      case 'init': {
        s.mcpStatus = ev.mcpServers.map((m) => ({ name: m.name, status: m.status }));
        if (ev.model) s.cliModel = ev.model; // what the CLI really runs (for the context limit)
        s.contextLimit = contextLimit(s);
        const mcp = ev.mcpServers.map((m) => `${m.name} ${/^connected$/i.test(m.status) ? '✓' : '✗'}`).join(', ');
        const note = [ev.model && `Модель: ${ev.model}`, mcp && `MCP: ${mcp}`].filter(Boolean).join(' · ');
        // once per session (again only when it changes, e.g. an MCP server went down)
        if (note && !store.messages(s.id).some((m) => m.kind === 'system' && m.text === note)) addMessage(s, { kind: 'system', text: note });
        // the harness's own server missing or down: the agent cannot start harness sub-agents or ask — say it plainly
        const hm = ev.mcpServers.find((m) => m.name === 'harness');
        if (ev.mcpServers.length && !s.virtual && (!hm || !/^connected$/i.test(hm.status))) {
          const warn = `⚠ MCP-сервер harness ${hm ? `не подключился (${hm.status})` : 'агент не загрузил'}: субагенты отдельными чатами и вопросы через harness в этом чате не работают. Проверьте Настройки → GigaCode → MCP-серверы.`;
          if (!store.messages(s.id).some((m) => m.text === warn)) addMessage(s, { kind: 'system', text: warn });
        }
        // what the CLI reported about itself, for GET /api/agents/:id/info (models seen accumulate, newest first)
        const prev = db.agentMeta[s.agent];
        db.agentMeta[s.agent] = {
          ...prev,
          auth: 'ok',
          models: [...new Set([ev.model, ...(prev?.models || [])].filter(Boolean))].slice(0, 50),
          slashCommands: ev.slashCommands || [],
          mcpServers: ev.mcpServers,
          agents: ev.agents || [],
          version: ev.version ?? null,
          at: Date.now(),
        };
        store.save();
        break;
      }
      case 'usage': {
        // the context after the latest step (overwritten per step); the session frame is throttled to 1/s
        s.context = { tokens: ev.contextTokens, at: Date.now(), lastTurn: { input: ev.input, output: ev.output, cacheRead: ev.cacheRead } };
        s.contextLimit ??= contextLimit(s);
        if (Date.now() - (r.contextAt || 0) >= 1000) {
          r.contextAt = Date.now();
          emit(s);
        } else store.save();
        break;
      }
      case 'note': // ACP: e.g. the agent's previous session could not be loaded
        addMessage(s, { kind: 'system', text: ev.text });
        break;
      case 'plan': // ACP plan updates: one message per turn, kept current
        if (c.plan) {
          c.plan.text = ev.text;
          updateMessage(s, c.plan);
        } else c.plan = addMessage(s, { kind: 'system', text: ev.text });
        break;
      case 'permission': { // ACP session/request_permission: the agent waits for this answer
        const asked = c.questions?.get(ev.toolId);
        if (asked || Array.isArray(ev.input?.questions)) {
          // the CLI's own question waits on this request: ONE card (the question). The request stays held — the agent
          // really waits — and the answer pauses the turn and goes as the next message (deliver).
          if (!asked) (c.questions ||= new Map()).set(ev.toolId ?? ev.id, addMessage(s, { kind: 'question', text: '', question: { id: ev.toolId ?? ev.id, ...parseQuestion(ev.input) } }));
          c.heldQuestion = { id: ev.id, reject: ev.options.find((o) => /reject|deny|cancel/i.test(`${o.id} ${o.kind ?? ''}`))?.id ?? null };
          setWaiting(s, 'answer');
          break;
        }
        if (FULL_ACCESS_MODES.has(s.approvalMode || config.agents[s.agent]?.approvalMode)) {
          // «Полный доступ»: the person chose not to be asked — allowed once, no card (never «always»: that writes CLI settings)
          const allow = ev.options.find((o) => /allow_once/i.test(o.kind ?? ''))
            ?? ev.options.find((o) => /^allow$/i.test(o.kind ?? o.id))
            ?? ev.options.find((o) => !/reject|deny|cancel|always/i.test(`${o.id} ${o.kind ?? ''}`));
          if (allow && acp.answer(s.id, ev.id, allow.id)) break;
        }
        addMessage(s, { kind: 'permission', text: '', permission: { id: ev.id, toolId: ev.toolId, tool: ev.tool, input: ev.input, reason: '', transport: 'acp', options: ev.options, resolved: null } });
        setWaiting(s, 'permission');
        break;
      }
      case 'permission_cancelled': // Stop: held requests were answered "cancelled"
        for (const m of store.messages(s.id)) {
          if (m.kind === 'permission' && m.permission.transport === 'acp' && !m.permission.resolved) {
            m.permission = { ...m.permission, resolved: 'cancelled', resolvedAt: Date.now(), answered: true };
            updateMessage(s, m);
          }
        }
        if (s.waitingFor === 'permission') setWaiting(s, null);
        break;
      case 'session':
        if (s.externalSessionId !== ev.id) {
          s.externalSessionId = ev.id;
          emit(s);
        }
        break;
      case 'raw': // consecutive non-JSON stdout lines -> one system message
        if (c.raw) {
          c.raw.lines.push(ev.text);
          c.raw.msg.text = fence(c.raw.lines);
          updateMessage(s, c.raw.msg);
        } else {
          c.assistant = c.thought = null;
          c.raw = { lines: [ev.text], msg: addMessage(s, { kind: 'system', text: fence([ev.text]) }) };
        }
        break;
      case 'text':
      case 'thought': {
        const kind = ev.type === 'text' ? 'assistant' : 'thought';
        c[kind === 'assistant' ? 'thought' : 'assistant'] = null;
        let m = c[kind];
        if (ev.delta && m) {
          m.text += ev.text;
          updateMessage(s, m);
        } else {
          m = addMessage(s, { kind, text: ev.text });
          c[kind] = ev.delta ? m : null;
        }
        if (kind === 'assistant') {
          c.gotText = true;
          s.preview = m.text.slice(-200);
          if (Date.now() - r.previewAt > 500) {
            r.previewAt = Date.now();
            emit(s);
          }
        }
        break;
      }
      case 'tool_call': {
        c.assistant = c.thought = null;
        const qTools = config.agents[s.agent]?.questionTools ?? QUESTION_TOOLS;
        if (qTools.includes(String(ev.name).replace(/^.*[.:]/, ''))) {
          // the CLI's own question: a card the user answers; whatever headless returns for the call stays hidden
          (c.questions ||= new Map()).set(ev.id, addMessage(s, { kind: 'question', text: '', question: { id: ev.id, ...parseQuestion(ev.input) } }));
          setWaiting(s, 'answer');
          break;
        }
        const sub = SUBAGENT_TOOLS.test(ev.name) ? openVirtual(s, ev, c) : null;
        c.tools.set(ev.id, addMessage(s, { kind: 'tool', text: ev.name, tool: { id: ev.id, name: ev.name, input: ev.input, output: null, status: 'running', ...(sub ? { subSessionId: sub } : {}) } }));
        break;
      }
      case 'tool_input': {
        // ACP announces a call with an empty rawInput and sends the real one in a later tool_call_update
        const q = c.questions?.get(ev.id);
        if (q) {
          const p = parseQuestion(ev.input);
          // an empty (or partial) input never wipes what an earlier one already said
          if (p.text) q.question = { ...q.question, ...p, options: p.options.length || p.parts ? p.options : q.question.options };
          updateMessage(s, q);
          break;
        }
        const m = c.tools.get(ev.id);
        if (!m) break;
        m.tool = { ...m.tool, input: ev.input };
        updateMessage(s, m);
        if (m.tool.subSessionId) fillVirtual(c, m.tool.subSessionId, m.tool.name, ev.input);
        break;
      }
      case 'tool_result': {
        sandboxToolFailure(s, ev);
        c.assistant = c.thought = null;
        if (c.questions?.has(ev.id)) break;
        const m = c.tools.get(ev.id);
        const status = ev.isError ? 'error' : 'ok';
        const denied = denialOf(config.agents[s.agent], ev, m?.tool?.name);
        // headless -p cannot wait for a confirmation, so the CLI denied: ask the user instead
        if (denied) permissionCard(s, { toolId: ev.id, tool: denied.tool, input: m?.tool?.input ?? null, reason: denied.reason });
        if (m) {
          m.tool = { ...m.tool, output: ev.output, status };
          updateMessage(s, m);
          if (m.tool.subSessionId) closeVirtual(s, ev);
        } else {
          addMessage(s, { kind: 'tool', text: 'tool', tool: { id: ev.id, name: 'tool', input: null, output: ev.output, status } });
        }
        break;
      }
      case 'error':
        c.assistant = c.thought = null;
        addMessage(s, { kind: 'error', text: ev.text });
        break;
      case 'result':
        s.tokensIn += ev.tokensIn || 0;
        s.tokensOut += ev.tokensOut || 0;
        if (ev.isError) addMessage(s, { kind: 'error', text: ev.text || 'Агент сообщил об ошибке' });
        else if (ev.text && !c.gotText) {
          addMessage(s, { kind: 'assistant', text: ev.text });
          s.preview = ev.text.slice(-200);
        }
        emit(s);
        closeAtResult(s);
        break;
    }
  }

  /** A stderr warning once per session: a repeat (same text, numbers ignored) only increments `count` on it. */
  function warnOnce(s, raw) {
    const text = `⚠ ${raw.trim().slice(-2000)}`;
    const key = text.replace(/\d+/g, '#').replace(/\s+/g, ' ');
    const prev = store.messages(s.id).find((m) => m.kind === 'system' && m.warnKey === key);
    if (!prev) return addMessage(s, { kind: 'system', text, warnKey: key, count: 1 });
    prev.count = (prev.count || 1) + 1;
    prev.at = Date.now();
    updateMessage(s, prev);
  }

  function runTurnEnded(s, r, stopped, reviving = false) {
    if (s.origin === 'cli') s.cliSyncAfter = Date.now() + 15000; // the CLI records this turn too: not «CLI-side activity»
    try {
      // the user's own follow-up (not the first turn, every message from the user): no escalation to the user
      const userFollowUp = r.turn > 1 && !!r.lastItems?.length && r.lastItems.every((it) => it.from === 'user');
      hooks.turnEnded(s, { ...r.flags, stopped, reviving, queueEmpty: !s.queue.length, userFollowUp });
    } catch (e) {
      console.error('[sessions] turnEnded hook failed:', e);
    }
  }

  /** The turn is over: its calls still «running» (no result came) end too — their cards stop spinning. */
  function settleTools(s) {
    for (const m of runtime(s.id).cur?.tools?.values() ?? []) {
      if (m.tool?.status !== 'running') continue;
      m.tool = settledTool(m.tool);
      updateMessage(s, m);
    }
  }

  /** The parent's turn is over: a sub-agent still running failed with it; all of them are archived now. */
  function settleVirtuals(s) {
    settleTools(s);
    for (const v of db.sessions.filter((x) => x.virtual && x.parentId === s.id && !x.archived)) {
      if (v.status === 'running') {
        Object.assign(v, { status: 'failed', lastActivityAt: Date.now() });
        emit(v);
      }
      retireVirtual(v);
    }
  }

  /** Questions / permission requests of a session that is archived never stay open (its cards in the parent do). */
  function cancelPending(x) {
    // only cards inside x: a sub-agent's card re-emitted in the parent stays open (granted there, it applies to the
    // parent's next turn)
    for (const m of store.messages(x.id)) {
      const open = (m.kind === 'permission' && !m.permission?.resolved) || (m.kind === 'question' && !m.question?.answered);
      if (!open) continue;
      if (m.kind === 'permission') m.permission = { ...m.permission, resolved: 'cancelled', resolvedAt: Date.now(), answered: true };
      else m.question = { ...m.question, answered: true, resolved: 'cancelled' };
      updateMessage(x, m);
    }
    if (x.waitingFor) x.waitingFor = null;
  }

  /**
   * A chat archived or deleted is never adopted (again) from the CLI history (db.cliIgnored): an adopted one, and a harness
   * chat too — its CLI session is recorded like any, and once the chat is deleted nothing owns that record any more.
   */
  function ignoreCli(s) {
    if (!s.externalSessionId) return;
    db.cliIgnored = [...new Set([...(db.cliIgnored || []), s.externalSessionId])];
    store.save();
  }

  /** A built-in sub-agent's chat is archived once it settles (orchestration.subagentRetention "archive"). */
  function retireVirtual(v) {
    if (config.orchestration?.subagentRetention !== 'keep' && !v.archived) api.archive(v.id, true);
  }

  /**
   * `result` arrived: the turn is over for the user now, although the CLI may linger for many seconds (MCP servers
   * shutting down, chat recording, telemetry). The process stays tracked (turnClosing) and the next turn waits for it.
   */
  function closeAtResult(s) {
    const r = runtime(s.id);
    if (!r.running || r.closedEarly || r.stopRequested) return;
    r.closedEarly = true;
    r.resultAt = Date.now();
    const status = r.flags.reported && (s.status === 'done' || s.status === 'failed') ? s.status : 'idle';
    Object.assign(s, { status, phase: null, lastActivityAt: Date.now(), stalled: false, turnClosing: true });
    if (s.revive) s.revive = null; // a turn that reached its result went well: the automatic attempts start over
    if (s.waitingFor === 'auth') s.waitingFor = null;
    settleVirtuals(s);
    emit(s);
    runTurnEnded(s, r, false);
    store.flush();
    armLinger(s);
  }

  /** The process may linger after result (a queued message waits for it) at most agents.<id>.exitGraceMs. */
  function armLinger(s) {
    const r = runtime(s.id);
    if (!r.closedEarly || r.lingerTimer) return;
    const grace = config.agents[s.agent]?.exitGraceMs ?? 8000;
    r.lingerTimer = setTimeout(() => r.handle?.terminate?.('post_result_linger'), Math.max(0, grace - (Date.now() - r.resultAt)));
  }

  const spawnAt = new Map(); // agent -> when its next process may start
  /** Several processes of one agent started at the same moment collide on its own files (GigaCode: «Extension store is busy»). */
  async function spawnSlot(agent, r) {
    const gap = config.agents[agent]?.spawnGapMs ?? 1200;
    const at = Math.max(Date.now(), (spawnAt.get(agent) || 0) + gap);
    spawnAt.set(agent, at);
    // Stop while waiting: wake at once (the turn then ends as stopped, nothing is spawned)
    if (at > Date.now()) await new Promise((res) => { const t = setTimeout(res, at - Date.now()); r.slotWake = () => { clearTimeout(t); res(); }; });
    r.slotWake = null;
  }
  const START_BUSY = /ExtensionStoreBusyError|store is busy|EBUSY|resource busy or locked/i;

  async function startTurn(s) {
    const r = runtime(s.id);
    if (r.running || (!s.queue?.length && !r.retryItems)) return;
    // a turn retried without the sandbox runs the same messages again (they are in the transcript already)
    const retry = r.retryItems;
    r.retryItems = null;
    const items = retry || s.queue.splice(0);
    r.lastItems = items;
    r.running = true;
    r.turn += 1;
    s.turnCount = r.turn;
    r.flags = {};
    s.turnFlags = {};
    r.cur = { assistant: null, thought: null, raw: null, tools: new Map(), subTools: new Map(), gotText: false };
    // re-queued items (their process never started) are in the transcript already
    const userMsgs = retry ? [] : items.filter((it) => !it.recorded).map((it) => addMessage(s, { kind: 'user', text: it.text, from: it.from, ...(it.options ? { options: it.options } : {}) }));
    Object.assign(s, { status: 'running', errorKind: null, queued: 0, lastActivityAt: Date.now(), lastEventAt: null, stalled: false, turnClosing: false });
    if (s.origin === 'cli' && !s.cliImportedAt) s.cliImportedAt = Date.now(); // an adopted CLI chat: the harness took over
    hooks.turnStarted?.(s);
    const approvalOnce = s.approvalOnce; // an edit tool allowed once in plan/default mode: this turn only
    delete s.approvalOnce;
    const grantsOnce = s.grantsOnce || []; // «Разрешить один раз»: allow-list entries for this turn only
    delete s.grantsOnce;
    emit(s);

    let res;
    let handle;
    try {
      const { agentCfg, launcher, exe } = resolveAgent(s.agent, s.launcherId);
      checkMode(agentCfg, s.approvalMode || agentCfg.approvalMode);
      const model = s.model || agentCfg.model;
      if (model && catalog?.unavailable(s.agent).has(model)) {
        // only when a fresh discovery says so; with a stale catalogue the run is attempted
        throw Object.assign(new Error(`Модели «${model}» нет в каталоге сервера (проверено ${new Date(catalog.info(s.agent).at).toLocaleString('ru-RU')}). Выберите другую модель — сообщение уйдёт с ней.`), { action: 'pick-model' });
      }
      const dropped = droppedGrades(s);
      const note = dropped.length && `⚠ Недоступные модели убраны из грейдов, CLI возьмёт модель по умолчанию: ${dropped.map(([g, id]) => `${g} → ${id}`).join(', ')}`;
      if (note && !store.messages(s.id).some((m) => m.text === note)) addMessage(s, { kind: 'system', text: note });
      let prompt = promptOf(items);
      if (!s.externalSessionId) {
        const pre = hooks.preamble(s);
        // a slash command only works as the first word of the prompt; the rest becomes its $ARGUMENTS
        if (pre) prompt = prompt.startsWith('/') ? `${prompt}\n\n${pre}` : `${pre}\n\n${prompt}`;
      }
      // the project's allow rules (allow_project) join the session's own on every turn
      const projectTools = (s.workspaceId && db.prefs?.allowedToolsByWorkspace?.[s.workspaceId]) || [];
      const turnSession = { ...s, ...(approvalOnce ? { approvalMode: approvalOnce } : {}), grantsOnce, ...(projectTools.length ? { allowedTools: [...new Set([...(s.allowedTools || []), ...projectTools])] } : {}) };
      if (agentCfg.transport !== 'acp' && prompt.length + (prompt.match(/["\\]/g)?.length ?? 0) > ARGV_PROMPT_MAX) {
        // the CLI reads files only inside its workspace dirs: the prompt's own folder joins them for this turn
        const dir = path.join(runDir(s.id), 'prompts');
        const file = path.join(dir, `prompt-${r.turn}.md`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, prompt);
        // a slash command only works as the first word of the prompt: its line stays in argv
        const slash = prompt.startsWith('/') ? `${prompt.split('\n', 1)[0].slice(0, 2000)}\n\n` : '';
        prompt = `${slash}Полный текст сообщения: ${file}\n(${prompt.length} символов — прочитай файл целиком и выполни его как сообщение пользователя)`;
        turnSession.includeDirs = [...(s.includeDirs || []), dir];
      }
      // a pasted screenshot lives in the harness's folder: the CLI may read it on the turn that mentions it
      if (items.some((i) => i.text.includes(attachmentsDir(s.id)))) turnSession.includeDirs = [...(turnSession.includeDirs || []), attachmentsDir(s.id)];
      const ctx = turnCtx(turnSession, agentCfg, prompt);
      // the session keeps its chosen mode; the UI shows what the CLI really got (e.g. auto -> auto-edit)
      s.effectiveApprovalMode = launcher.effectiveMode?.(ctx) ?? (ctx.session.approvalMode || agentCfg.approvalMode || null);
      // «Как запущен агент»: what this turn really ran with, on its user message
      const runInfo = {
        cliMode: s.effectiveApprovalMode, sandbox: ctx.agentCfg.autoSandbox || null, allowedTools: launcher.allowed?.(ctx) ?? [],
        model: s.model || agentCfg.model || null, transport: agentCfg.transport || 'headless', includeDirs: s.includeDirs || [],
      };
      const carrier = userMsgs.at(-1) || store.messages(s.id).findLast((m) => m.kind === 'user');
      if (carrier) updateMessage(s, Object.assign(carrier, { runInfo }));
      fs.mkdirSync(runDir(s.id), { recursive: true });
      if (!(agentCfg.transport === 'acp' && s.warm)) await spawnSlot(s.agent, r); // a warm ACP process starts nothing
      if (r.stopRequested) throw Object.assign(new Error('stopped before start'), { beforeStart: true }); // stopped while waiting for its slot
      launcher.prepare(ctx);
      r.registryTimer = setInterval(() => pollRegistry(s), REGISTRY_POLL_MS);
      const env = { ...process.env, ...agentCfg.env, ...secretEnv(config), ...exe.env, ...launcher.env(ctx), ...ctx.harnessMcp.env };
      const firstEventTimeoutMs = agentCfg.firstEventTimeoutMs || launcher.defaults.firstEventTimeoutMs || 30000;
      if (agentCfg.transport === 'acp') {
        if (!launcher.acpArgs) throw new Error(`у лаунчера «${launcher.id}» нет режима ACP; укажите agents.${s.agent}.transport = "headless"`);
        handle = acp.turn({
          sid: s.id, agent: s.agent, launcher, ctx, command: exe, cwd: s.cwd, env, logFile: turnFiles(s, r.turn).logFile, roots: [s.cwd, ...(s.includeDirs || []), attachmentsDir(s.id)],
          idleMs: (agentCfg.acpIdleMin ?? agentCfg.acpIdleTimeoutMin ?? 30) * 60000,
          externalSessionId: s.externalSessionId, prompt, initTimeoutMs: firstEventTimeoutMs, onEvent: (ev) => applyEvent(s, ev), clientFs: !!agentCfg.acpClientFs,
          // its CLI session would not load: the new one gets the harness's rules and what this chat was about
          recap: () => [hooks.preamble(s), recapText(store.messages(s.id), r.turn)].filter(Boolean).join('\n\n'),
        });
      } else {
        handle = runTurn({
          launcher,
          ctx,
          command: exe,
          cwd: s.cwd,
          env,
          firstEventTimeoutMs,
          authTimeoutMs: agentCfg.authTimeoutMs || 600000,
          ...turnFiles(s, r.turn),
          onEvent: (ev) => applyEvent(s, ev),
          onOffset: (off) => saveOffset(s, off),
        });
      }
      r.handle = handle;
      if (r.stopRequested) handle.stop();
      s.pid = handle.pid;
      s.pidStartedAt = handle.startedAt; // identity check before a re-attach after a restart
      s.turnOffset = 0;
      s.phase = 'starting'; // spawned, no output yet (GigaCode may need a minute to start its MCP servers)
      emit(s);
      res = await handle.done;
    } catch (e) {
      res = e.beforeStart ? { stopped: true, stderrTail: '', eventCount: 0 } : { error: e.message, action: e.action };
    }
    // the start collided with another process of the agent («Extension store is busy»): the same messages again in a few
    // seconds — not «Агент не запустился»
    const busy = (`${res.error || ''} ${res.stderrTail || ''}`.match(START_BUSY) || [])[0];
    if (busy && !res.eventCount && !res.sawResult && !r.stopRequested && find(s.id) && (r.startRetries || 0) < 4) {
      const n = r.startRetries || 0;
      r.startRetries = n + 1;
      const sec = 2 + Math.round(Math.random() * 3) + n * 2; // spread: the others retry at other moments
      s.queue.unshift(...items.map((it) => ({ ...it, recorded: true })));
      clearInterval(r.registryTimer);
      Object.assign(r, { running: false, handle: null });
      Object.assign(s, { status: 'idle', pid: null, pidStartedAt: null, phase: null, turnOffset: null, queued: s.queue.length });
      addMessage(s, { kind: 'system', text: `Агент был занят другим запуском (${busy}) — повторяю через ${sec} с (попытка ${n + 1} из 4)` });
      emit(s);
      const t = setTimeout(() => { if (find(s.id) && !runtime(s.id).running && s.queue.length) startTurn(s); }, sec * 1000);
      t.unref?.();
      return;
    }
    if (res.error && !res.eventCount && !res.sawResult && !handle?.pid && !r.stopRequested && find(s.id)) {
      // the process never started (spawn error, config, unknown model): the messages wait in the queue, not lost
      s.queue.unshift(...items.map((it) => ({ ...it, recorded: true })));
      s.queued = s.queue.length;
      r.requeued = true;
      res.error += `\nСообщений в очереди: ${s.queue.length} — уйдут со следующим сообщением или после смены модели.`;
    }
    if (res.eventCount) r.startRetries = 0; // it started: the next collision gets its retries again
    if (!res.detached) finishTurn(s, res);
  }

  /** The model's context size from the merged catalogue: session model, else what the CLI reported, else the agent default. */
  function contextLimit(s) {
    const model = s.model || s.cliModel || config.agents[s.agent]?.model;
    if (!model || !catalog) return null;
    const entry = catalog.merged(s.agent).find((e) => baseId(e.id) === baseId(model));
    return contextSize(entry?.context ?? String(model).match(/-(\d+[km])$/i)?.[1]);
  }

  function turnFiles(s, n) {
    const dir = runDir(s.id);
    return { logFile: path.join(dir, 'stderr.log'), outFile: path.join(dir, `turn-${n}.out.ndjson`), errFile: path.join(dir, `turn-${n}.err.txt`) };
  }

  function saveOffset(s, off) {
    s.turnOffset = off;
    const r = runtime(s.id);
    // shortcut: a crash may re-read <= 2 s of events on re-attach; persist offsets elsewhere if that ever matters
    if (Date.now() - (r.offsetSavedAt || 0) < 2000) return;
    r.offsetSavedAt = Date.now();
    store.save(); // debounced; no WS frame for this
  }

  /**
   * Follows a turn that kept running while the harness was down (or drains the output of one that ended).
   * `ours` = the saved pid still is that process (pid + start time); otherwise only the file is read, the pid is
   * neither followed nor ever killed.
   */
  function reattach(s, ours) {
    const r = runtime(s.id);
    const launcher = launchers[s.launcherId];
    const outFile = latestTurnFile(s.id);
    if (!launcher || !outFile) {
      r.running = false;
      Object.assign(s, { status: 'idle', pid: null });
      markInterrupted(s);
      emit(s);
      startTurn(s);
      return null;
    }
    r.running = true;
    r.unadopted = !ours;
    r.flags = { ...s.turnFlags }; // what orchestration already handled in this turn (e.g. worker_done)
    r.cur = { assistant: null, thought: null, raw: null, tools: new Map(), subTools: new Map(), gotText: false };
    for (const m of store.messages(s.id)) if (m.turn === r.turn && m.kind === 'tool' && m.tool) r.cur.tools.set(m.tool.id, m);
    const last = store.messages(s.id).at(-1);
    if (last?.kind === 'assistant' && last.turn === r.turn) {
      r.cur.assistant = last; // keep streaming into the same message
      r.cur.gotText = true;
    }
    if (ours) addMessage(s, { kind: 'system', text: 'переподключено после перезапуска' });
    s.phase = s.turnOffset ? 'streaming' : 'starting';
    emit(s);
    const n = Number(outFile.match(/turn-(\d+)\.out\.ndjson$/)[1]);
    r.registryTimer = setInterval(() => pollRegistry(s), REGISTRY_POLL_MS);
    const handle = runTurn({
      launcher,
      ...turnFiles(s, n),
      reattach: { pid: ours ? s.pid : null, offset: s.turnOffset || 0, startedAt: s.pidStartedAt ?? null },
      onEvent: (ev) => applyEvent(s, ev),
      onOffset: (off) => saveOffset(s, off),
    });
    r.handle = handle;
    if (r.stopRequested) handle.stop();
    return handle.done.then((res) => { if (!res.detached) finishTurn(s, res); });
  }

  function finishTurn(s, res) {
    const r = runtime(s.id);
    if (r.closedEarly) return finishLingered(s, r, res);
    clearInterval(r.registryTimer);
    r.running = false;
    r.handle = null;
    const paused = r.pausedForAnswer; // ended by answering the CLI's question (ACP), not by Stop
    r.pausedForAnswer = false;
    const woken = r.reviveKill; // stopped by the harness to wake a silent turn, not by the person
    r.reviveKill = null;
    const stopped = (res.stopped || r.stopRequested) && !paused && !woken;
    const unadopted = r.unadopted;
    r.stopRequested = false;
    r.unadopted = false;
    if (!find(s.id)) return; // deleted while running
    pollRegistry(s);
    let status = r.flags.reported && (s.status === 'done' || s.status === 'failed') ? s.status : 'idle';
    if (stopped) {
      status = 'stopped'; // already set by stop(); a late exit never overwrites it
      addMessage(s, { kind: 'system', text: 'Остановлено пользователем' });
    } else if (woken) {
      status = 'idle';
    } else if (unadopted && !res.sawResult) {
      // the saved pid is gone or now belongs to another process: what the file had is shown, the rest is lost
      markInterrupted(s);
    } else if (res.error) {
      addMessage(s, { kind: 'error', text: `${res.error}${tail(res.stderrTail)}`, ...(res.action ? { action: res.action } : {}) });
      status = 'error';
    } else if (res.authTimedOut) {
      const min = Math.round((config.agents[s.agent]?.authTimeoutMs || 600000) / 60000);
      addMessage(s, { kind: 'error', text: `Вход не выполнен за ${min} мин — процесс остановлен. Откройте ссылку выше и войдите (или один раз через Настройки → интерактивный терминал), затем отправьте сообщение снова.${tail(res.stderrTail)}` });
      status = 'error';
    } else if (res.timedOut) {
      const ms = config.agents[s.agent]?.firstEventTimeoutMs || launchers[s.launcherId]?.defaults.firstEventTimeoutMs;
      addMessage(s, { kind: 'error', text: `Нет вывода за ${Math.round(ms / 1000)} с — ход остановлен.${tail(res.stderrTail)}` });
      status = 'error';
    } else if (!res.sawResult && !res.eventCount && /include-partial-messages/i.test(res.stderrTail) && !db.agentMeta[s.agent]?.partialUnsupported && r.lastItems) {
      // an older CLI without live deltas: remember, and run the same turn again without the flag (never loops)
      db.agentMeta[s.agent] = { ...db.agentMeta[s.agent], partialUnsupported: { at: Date.now() } };
      store.save();
      addMessage(s, { kind: 'system', text: '⚠ Этот CLI не отдаёт мысли по ходу (--include-partial-messages) — они появятся целиком после шага. Повторяю ход.' });
      r.retryItems = r.lastItems;
    } else if (!res.sawResult && res.code !== 0 && !res.eventCount && /sandbox/i.test(res.stderrTail) && sandboxed(s, config.agents[s.agent] || {}).autoSandbox && r.lastItems) {
      const why = res.stderrTail.trim().split('\n').find((l) => /sandbox/i.test(l)) || res.stderrTail.trim().split('\n')[0];
      db.agentMeta[s.agent] = { ...db.agentMeta[s.agent], sandboxBroken: { at: Date.now(), error: why.slice(0, 500) } };
      store.save();
      const text = `Песочница GigaCode недоступна: ${why.slice(0, 300)}. «Полный доступ» работает как «Авто-правки» + разрешённые команды.`;
      hooks.notify?.({ kind: 'error', sessionId: s.id, taskId: s.taskId, text });
      addMessage(s, { kind: 'system', text: `⚠ ${text} Повторяю ход без песочницы.` });
      r.retryItems = r.lastItems; // the same turn once more (sandboxBroken now: never loops)
    } else if (!res.sawResult && res.code !== 0) {
      // a fatal CLI error leaves stdout empty and the whole story in stderr: lead with it
      const why = res.stderrTail.trim();
      const code = signedCode(res.code);
      const how = code == null ? 'Процесс агента завершился без результата'
        : code === -1 ? 'Процесс агента завершён принудительно (код -1)'
          : `Агент завершился с ошибкой (код ${code}${res.signal ? `, ${res.signal}` : ''})`;
      const md = config.agents[s.agent]?.modelsDiscovery;
      const modelGone = /not present in the current backend catalogue/i.test(why) || (!!md?.missingPattern && new RegExp(md.missingPattern, 'i').test(why));
      addMessage(s, { kind: 'error', text: `${how}${why ? `:\n${why.slice(-2000)}` : '.'}`, ...(modelGone ? { action: 'pick-model' } : {}) });
      if (modelGone && md?.prompt) catalog?.discover(s.agent).catch(() => {}); // the catalogue changed: learn the new ids
      if (!res.eventCount && !res.priorOutput) status = 'error';
    } else if (!res.eventCount && !res.priorOutput) {
      // exit 0 without a single event: e.g. GigaCode's identity check fails silently (message only on stderr)
      addMessage(s, { kind: 'error', text: `Агент завершился, ничего не выведя.${tail(res.stderrTail)}` });
      status = 'error';
    } else if (res.stderrTail.trim()) {
      warnOnce(s, res.stderrTail);
    }
    // errorKind: 'not_started' = no turn of this session ever produced output (check the command); 'turn' = this turn failed
    const errorKind = status === 'error' ? (s.everStarted ? 'turn' : 'not_started') : null;
    Object.assign(s, { status, errorKind, pid: null, pidStartedAt: null, phase: null, turnOffset: null, lastActivityAt: Date.now(), stalled: false, turnClosing: false });
    if (s.waitingFor === 'auth') s.waitingFor = null;
    settleVirtuals(s);
    // broke (not the person's stop, not a login, not a missing executable or model) or woken: continue by itself
    const broke = status === 'error' && errorKind === 'turn' && !res.authTimedOut && !/Не удалось запустить агента/.test(res.error || '') && store.messages(s.id).findLast((m) => m.kind === 'error')?.action !== 'pick-model';
    const reason = woken || (broke ? (store.messages(s.id).findLast((m) => m.kind === 'error')?.text.split('\n')[0] || 'ошибка хода').slice(0, 200) : null);
    const reviving = !!reason && !stopped && revivable(s) && !s.queue.length && scheduleRevive(s, reason);
    if (!reason && status !== 'error' && s.revive) s.revive = null; // a turn that went well: the count starts over
    emit(s);
    runTurnEnded(s, r, stopped, reviving);
    store.flush(); // a finished turn is never lost to a crash right after it
    if (s.archiveOnSettle && !s.archived) return api.archive(s.id, true); // a settled helper (subagentRetention)
    if (r.requeued) r.requeued = false; // no retry loop: the next message (or a model change) sends them
    else if (r.retryItems || s.queue.length) startTurn(s);
  }

  /** The process of a turn already closed at `result` has exited (by itself or killed after exitGraceMs). */
  function finishLingered(s, r, res) {
    clearTimeout(r.lingerTimer);
    clearInterval(r.registryTimer);
    Object.assign(r, { lingerTimer: null, closedEarly: false, running: false, handle: null, stopRequested: false, unadopted: false });
    if (!find(s.id)) return;
    const killed = res.killReason === 'post_result_linger';
    try {
      fs.appendFileSync(turnFiles(s, r.turn).logFile, `[harness] process exited ${Date.now() - r.resultAt} ms after result${killed ? ' (killed after exitGraceMs)' : ''}\n`);
    } catch {}
    if (res.stderrTail.trim() && !res.killReason && !res.error) warnOnce(s, res.stderrTail);
    if (res.error && !res.stopped) {
      addMessage(s, { kind: 'error', text: `${res.error}${tail(res.stderrTail)}` });
      Object.assign(s, { status: 'error', errorKind: 'turn' });
    }
    Object.assign(s, { pid: null, pidStartedAt: null, turnOffset: null, turnClosing: false });
    emit(s);
    store.flush();
    if (s.archiveOnSettle && !s.archived) return api.archive(s.id, true);
    if (s.queue.length) startTurn(s);
  }

  // ---- terminals ----

  /** Env an agent's interactive CLI needs (e.g. GigaCode's package identity); {} for plain shells. */
  function agentEnv(s) {
    const agentCfg = s.agent !== 'shell' && config.agents[s.agent];
    if (!agentCfg) return {};
    try {
      return launchers[agentCfg.launcher]?.resolve(agentCfg).env || {};
    } catch {
      return {};
    }
  }

  function spawnPty(s, pty, command = s.command) {
    const r = runtime(s.id);
    const p = pty.spawn(config.shell.command, config.shell.args, {
      name: 'xterm-256color',
      cols: r.cols || 120,
      rows: r.rows || 30,
      cwd: s.cwd,
      env: { ...process.env, ...utf8Locale(), ...secretEnv(config), ...agentEnv(s), ...harnessEnv(s) },
    });
    r.pty = p;
    p.onData((data) => {
      if (r.pty !== p) return; // killed or replaced
      store.appendTermLog(s.id, data);
      bus.send({ t: 'term', id: s.id, data });
    });
    p.onExit(({ exitCode }) => {
      if (r.pty !== p) return;
      r.pty = null;
      const data = `\r\n[process exited with code ${exitCode}]\r\n`;
      store.appendTermLog(s.id, data);
      bus.send({ t: 'term', id: s.id, data });
      if (find(s.id)) {
        Object.assign(s, { status: 'exited', pid: null, lastActivityAt: Date.now() });
        emit(s);
      }
    });
    Object.assign(s, { status: 'idle', pid: p.pid, lastActivityAt: Date.now() });
    emit(s);
    if (command) p.write(`${command}\r`);
  }

  /** After a restart: a fresh shell in the same cwd; an agent CLI terminal resumes its conversation (continueArgs). */
  async function respawnTerminal(s) {
    try {
      const pty = await loadPty();
      const agentCfg = s.agent !== 'shell' && config.agents[s.agent];
      const cont = agentCfg && (agentCfg.continueArgs ?? launchers[agentCfg.launcher]?.defaults.continueArgs);
      let command = null; // a plain shell's initial command is not re-run (it may have side effects)
      if (agentCfg) {
        const exe = launchers[agentCfg.launcher]?.resolve(agentCfg);
        command = exe ? shellLine([exe.file, ...exe.args, ...(cont || [])]) : null;
      }
      store.appendTermLog(s.id, '\r\n— перезапуск harness: новая сессия терминала —\r\n');
      spawnPty(s, pty, command);
    } catch (e) {
      Object.assign(s, { status: 'exited', pid: null });
      store.appendTermLog(s.id, `\r\n[harness restarted; the terminal could not be restarted: ${e.message}]\r\n`);
      emit(s);
    }
  }

  /** argv -> a command line for the configured shell (PowerShell needs `&` before a quoted path). */
  function shellLine(argv) {
    const shell = path.basename(config.shell.command).toLowerCase();
    if (/^(pwsh|powershell)/.test(shell)) return `& ${argv.map((a) => `'${a.replace(/'/g, "''")}'`).join(' ')}`;
    if (/^cmd(\.exe)?$/.test(shell)) return argv.map((a) => (/[\s&()^|<>]/.test(a) ? `"${a}"` : a)).join(' ');
    return argv.map((a) => (/^[\w./=:-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ');
  }

  /** Interactive CLI of an agent (no -p): the launcher's resolved executable + identity env. */
  function interactive(agentCfg, includeDirs = []) {
    let exe;
    try {
      exe = launchers[agentCfg.launcher]?.resolve(agentCfg);
    } catch (e) {
      fail(400, e.message);
    }
    if (!exe) return { command: null, env: {} };
    const flag = launchers[agentCfg.launcher]?.dirFlag;
    return { command: shellLine([exe.file, ...exe.args, ...(flag ? includeDirs.flatMap((d) => [flag, d]) : [])]), env: exe.env || {} };
  }

  // ---- revive: a turn that broke (an error, a dropped connection) or went silent is continued, not dropped ----
  // A few attempts with growing pauses (--resume keeps the context, the worktree keeps the files), then a notification
  // with «Повторить». session.revive = { count, reason, due } | { …, gaveUp } until a turn goes well.
  const reviveCfg = () => ({ attempts: 3, delaysSec: [30, 120, 300], stallWakeMin: 15, ...config.session?.revive });
  const CONTINUE = (reason) => `[harness] Предыдущий ход оборвался (${reason}). Продолжи с того места, где остановился: проверь, что уже сделано в рабочем дереве, и доведи задачу до конца.`;
  const isContinue = (q) => q.from === 'harness' && q.text.startsWith('[harness] Предыдущий ход оборвался');
  /** «Продолжи» once: a turn that did not even start puts its messages back, and a second «Повторить» must not add another. */
  function continueTurn(s, reason) {
    if (!(s.queue || []).some(isContinue)) return api.deliver(s.id, { from: 'harness', text: CONTINUE(reason) });
    s.interrupted = null; // continued, as a delivered message would say
    if (!runtime(s.id).running) startTurn(s);
    return { queued: false };
  }
  const delayText = (sec) => (sec < 60 ? `${sec} с` : `${Math.round(sec / 60)} мин`);
  /** Worth continuing by itself: a chat of the person or a worker, not one that waits for someone or cannot start at all. */
  const revivable = (s) => s.kind === 'chat' && !s.virtual && !s.archived && !s.waitingFor && s.phase !== 'auth' && !!s.everStarted && reviveCfg().attempts > 0;
  function scheduleRevive(s, reason) {
    const cfg = reviveCfg();
    const n = s.revive?.gaveUp ? 0 : s.revive?.count || 0;
    if (n >= cfg.attempts) {
      s.revive = { count: n, reason, gaveUp: true };
      addMessage(s, { kind: 'system', text: `⚠ Агент не продолжил работу и после ${n} повтор(ов): ${reason}. «Повторить» — здесь или во «Входящих».` });
      hooks.notify?.({ kind: 'escalation', sessionId: s.id, taskId: s.taskId ?? null, text: `${s.title}: агент обрывается и после ${n} повторов — ${reason}`, actions: ['retry', 'open'] });
      return false;
    }
    const sec = cfg.delaysSec[Math.min(n, cfg.delaysSec.length - 1)];
    const due = Date.now() + sec * 1000;
    s.revive = { count: n + 1, reason, due };
    addMessage(s, { kind: 'system', text: `${reason} — продолжу сам через ${delayText(sec)} (попытка ${n + 1} из ${cfg.attempts})` });
    const t = setTimeout(() => {
      const x = find(s.id);
      // the person (or the agent) moved on meanwhile: a new message, a stop, an archive — nothing to continue
      if (!x || x.archived || x.revive?.due !== due || runtime(s.id).running || x.status === 'running' || x.status === 'stopped' || x.waitingFor) return;
      continueTurn(x, reason);
    }, sec * 1000);
    t.unref?.();
    return true;
  }

  // ---- stalled: running, not logging in, no event for session.stallSec while the pid is alive ----
  const stallTimer = setInterval(() => {
    const limit = (Number(config.session?.stallSec) || 300) * 1000;
    for (const s of db.sessions) {
      if (s.kind !== 'chat' || s.virtual) continue;
      const stalled = s.status === 'running' && s.phase !== 'auth' && !s.waitingFor && !!s.pid && Date.now() - (s.lastEventAt || s.lastActivityAt) > limit && isAlive(s.pid);
      if (!!s.stalled !== stalled) {
        s.stalled = stalled;
        emit(s);
      }
      // silent and not inside a tool (a long build is a normal silence): stop it and continue the same session
      const wake = reviveCfg().stallWakeMin;
      const r = rt.get(s.id);
      if (stalled && wake && r?.running && !r.reviveKill && revivable(s) && Date.now() - (s.lastEventAt || s.lastActivityAt) > wake * 60000
        && ![...(r.cur?.tools?.values() ?? [])].some((m) => m.tool?.status === 'running')) {
        r.reviveKill = `нет вывода ${wake} мин`;
        r.handle?.stop();
      }
    }
  }, (Number(config.session?.stallCheckSec) || 15) * 1000);
  stallTimer.unref?.();

  /** One approval mode more permissive than the session's (approvalModes order), or the last one. */
  function nextMode(s) {
    const modes = config.agents[s.agent]?.approvalModes || [];
    const cur = s.approvalMode || config.agents[s.agent]?.approvalMode;
    return modes[Math.min(modes.indexOf(cur) + 1, modes.length - 1)] ?? cur ?? null;
  }

  const inputSummary = (input) => {
    if (input == null) return '';
    const text = typeof input === 'string' ? input : input.command ?? input.file_path ?? input.path ?? JSON.stringify(input);
    return String(text).length > 300 ? `${String(text).slice(0, 300)}…` : String(text);
  };

  const wtLists = new Map(); // repo path -> { at, list } (git worktree list, 30 s)
  async function worktreesOf(repo, fresh = false) {
    const hit = wtLists.get(repo);
    if (!fresh && hit && Date.now() - hit.at < 30000) return hit.list;
    const list = await git.worktrees(repo).catch(() => []);
    wtLists.set(repo, { at: Date.now(), list });
    return list;
  }

  /**
   * The workspace a cwd belongs to: the git repository one of whose worktrees contains it (worktrees usually live
   * outside the repo folder), else the deepest registered folder containing it (a projects folder is the last resort).
   */
  async function workspaceFor(cwd, fresh = false, retry = true) {
    return (await placeFor(cwd, fresh, retry)).workspaceId;
  }

  /**
   * Where a session lives for grouping: { workspaceId, worktreePath, system }. Anything under the harness's own data
   * folder (login terminal, model discovery, default chat folders) is `system` and belongs to no project; otherwise the
   * worktree whose root contains the cwd (longest prefix, a sub-folder included) and its repository; otherwise the
   * deepest registered folder.
   */
  async function placeFor(cwd, fresh = false, retry = true) {
    // the harness's own folders (default chat folders, login terminal, model discovery, run files); a projects
    // folder inside the data dir (the demo's <dataDir>/projects) is an ordinary place
    if (['chats', 'terms', 'runs'].some((d) => insideDir(path.join(store.dataDir, d), cwd))) return { workspaceId: null, worktreePath: null, system: true };
    let best = null;
    // all repos at once: one git process each, never one after another (17 repos × a slow git on Windows = seconds)
    const lists = await Promise.all(db.workspaces.filter((x) => x.isGit).map(async (w) => [w, await worktreesOf(w.path, fresh)]));
    for (const [w, list] of lists) {
      for (const t of list) {
        if (insideDir(t.path, cwd) && (!best || t.path.length > best.path.length)) best = { id: w.id, path: t.path };
      }
    }
    // a worktree created in the last 30 s is not in the cache yet — but a registered non-git folder (the projects folder,
    // a plain folder) is never inside a worktree, so a chat there never pays for a fresh scan of every repo
    const knownFolder = db.workspaces.some((w) => !w.isGit && samePath(w.path, cwd));
    if (!best && !fresh && retry && !knownFolder) return placeFor(cwd, true);
    if (best) return { workspaceId: best.id, worktreePath: best.path, system: false };
    const folder = db.workspaces.filter((w) => insideDir(w.path, cwd)).sort((a, b) => b.path.length - a.path.length)[0];
    return { workspaceId: folder?.id ?? null, worktreePath: null, system: false };
  }

  const archiveTimer = setInterval(() => api.autoArchive(), 3600000); // hourly; also once on startup (index.js)
  archiveTimer.unref?.();

  // ---- public API ----

  const api = {
    hooks,
    find,
    get,
    resolveAgent,
    registryDir,
    list: () => db.sessions,
    messages: (sid) => (get(sid), store.messages(sid)),
    children: (sid) => db.sessions.filter((s) => s.parentId === sid),
    isRunning: (sid) => runtime(sid).running,
    attachmentsDir: (sid) => (get(sid), attachmentsDir(sid)),
    subagents: (sid) => (get(sid), readRegistry(registryDir(sid), { idleWindowSec: config.session.idleWindowSec })),
    /** An informational line in a chat that does not wake the agent. */
    note(sid, text) {
      return addMessage(get(sid), { kind: 'system', text });
    },
    /** Models a fresh discovery says are gone for this agent. */
    unavailableModels: (agent) => catalog?.unavailable(agent) ?? { has: () => false },
    /** orchestration marks what happened during the current turn: 'reported' | 'communicated' */
    flag(sid, name) {
      runtime(sid).flags[name] = true;
      const s = get(sid);
      s.turnFlags = { ...s.turnFlags, [name]: true }; // persisted: a turn re-attached after a restart is not reported twice
      store.save();
    },
    setStatus(sid, status) {
      const s = get(sid);
      Object.assign(s, { status, lastActivityAt: Date.now() });
      emit(s);
    },
    update(sid, patch) {
      const s = get(sid);
      Object.assign(s, patch);
      return emit(s);
    },

    async create(o = {}) {
      const kind = o.kind || 'chat';
      if (!['chat', 'terminal'].includes(kind)) fail(400, 'kind: "chat" или "terminal"');
      const role = o.role || 'solo';
      if (!['solo', 'coordinator', 'worker', 'reviewer'].includes(role)) fail(400, 'role: solo, coordinator, worker или reviewer');
      for (const k of ['agent', 'cwd', 'workspaceId', 'title', 'prompt', 'approvalMode', 'model', 'command', 'branch']) {
        if (o[k] != null && typeof o[k] !== 'string') fail(400, `${k}: нужна строка`);
      }
      const ws = o.workspaceId ? db.workspaces.find((w) => w.id === o.workspaceId) || fail(404, `рабочая папка ${o.workspaceId} не найдена`) : null;
      const id = newId('s');
      let cwd = o.cwd || ws?.path ? path.resolve(o.cwd || ws.path) : null;
      if (cwd && !isDir(cwd)) fail(400, `cwd — не папка: ${cwd}`);

      let agent = o.agent || null;
      let agentCfg = null;
      if (kind === 'chat' || (agent && agent !== 'shell')) {
        agent ||= config.defaultAgent;
        if (kind === 'chat') ({ agentCfg } = resolveAgent(agent));
        else {
          agentCfg = config.agents[agent] || fail(400, `неизвестный агент «${agent}»`);
          if (agentCfg.enabled === false) fail(400, `агент «${agent}» выключен в настройках`);
        }
        checkMode(agentCfg, o.approvalMode);
      }
      const pty = kind === 'terminal' ? await loadPty() : null;
      if (!cwd) {
        cwd = defaultCwd({ kind, agentTerminal: !!agentCfg, dataDir: store.dataDir, id, root: config.root });
        fs.mkdirSync(cwd, { recursive: true });
      }

      const now = Date.now();
      const includeDirs = normalizeIncludeDirs(o.includeDirs, cwd, o.autoIncludeDirs !== true);
      const command = kind === 'terminal' ? o.command ?? (agentCfg ? interactive(agentCfg, includeDirs).command : null) : null;
      const s = {
        id,
        kind,
        title: o.title || (kind === 'chat' ? agentCfg.label || agent : command || path.basename(config.shell.command)),
        agent: kind === 'chat' ? agent : agent || 'shell',
        launcherId: kind === 'chat' ? agentCfg.launcher : null,
        cwd,
        ...(await (async () => {
          const place = await placeFor(cwd);
          return { workspaceId: place.system ? null : ws?.id ?? place.workspaceId, worktreePath: place.worktreePath, system: place.system };
        })()),
        branch: o.branch ?? null,
        role,
        parentId: o.parentId ?? null,
        taskId: o.taskId ?? null,
        status: 'idle',
        externalSessionId: null,
        settingsPath: kind === 'chat' ? path.join(runDir(id), 'settings.json') : null,
        model: o.model || null,
        approvalMode: o.approvalMode || null,
        autoReport: typeof o.autoReport === 'boolean' ? o.autoReport : role === 'worker',
        queued: 0,
        preview: '',
        command,
        includeDirs,
        pid: null,
        tokensIn: 0,
        tokensOut: 0,
        phase: null,
        turnOffset: null,
        ...(kind === 'chat' ? { queue: [] } : {}),
        // worker_run child: its caller long-polls worker_wait until `report` is set (stateless, survives restarts)
        ...(o.ephemeral ? { ephemeral: true, waiter: true, report: null } : {}),
        ...(o.inWorktree === true ? { inWorktree: true } : {}), // a worker started inside its task's linked worktree
        ...(o.atRoot === true ? { atRoot: true } : {}), // a task worker started in the projects folder: it picks the repos
        ...(Array.isArray(o.repoHints) && o.repoHints.length ? { repoHints: o.repoHints } : {}), // where the task's API paths are in the code
        ...(o.persistent === true ? { persistent: true } : {}), // a child in its own worktree/repo: kept, own depth
        ...(kind === 'chat' && !o.title ? { autoTitle: true } : {}), // the first user message names the chat
        createdAt: now,
        lastActivityAt: now,
      };
      if (kind === 'chat') {
        // settings are written now so a write failure is reported before anything starts
        try {
          fs.mkdirSync(registryDir(id), { recursive: true });
          launchers[s.launcherId].prepare(turnCtx(s, agentCfg, ''));
        } catch (e) {
          fs.rmSync(runDir(id), { recursive: true, force: true });
          fail(500, `Не удалось записать настройки сессии (${s.settingsPath}): ${e.message}`);
        }
      }
      db.sessions.push(s);
      emit(s);
      if (!s.branch) {
        git.currentBranch(cwd).then((b) => {
          if (b && find(id)) {
            s.branch = b;
            emit(s);
          }
        });
      }
      if (kind === 'terminal') {
        try {
          spawnPty(s, pty);
        } catch (e) {
          Object.assign(s, { status: 'error' });
          emit(s);
          fail(500, `Не удалось запустить терминал: ${e.message}`);
        }
      } else if (o.prompt) {
        api.deliver(id, { from: 'user', text: o.prompt });
      }
      return s;
    },

    /**
     * Answer to a permission card (headless: the CLI already denied, so the answer is a new message):
     * allow_once = next turn one approval mode more permissive, allow_session = the session keeps that mode, reject.
     */
    permission(sid, { permissionId, optionId, note } = {}) {
      const s = get(sid);
      if (typeof permissionId !== 'string' || typeof optionId !== 'string') fail(400, 'нужны permissionId и optionId');
      if (note != null && typeof note !== 'string') fail(400, 'note: нужна строка');
      const msg = store.messages(sid).find((m) => m.kind === 'permission' && m.permission?.id === permissionId) || fail(404, `запрос разрешения ${permissionId} не найден`);
      const p = msg.permission;
      if (p.resolved) fail(409, `уже отвечено: ${p.resolved}`);
      if (!p.options.some((o) => o.id === optionId)) fail(400, `optionId — один из: ${p.options.map((o) => o.id).join(', ')}`);
      if (p.transport === 'acp') {
        // the agent holds its session/request_permission until this answer
        if (!acp.answer(sid, permissionId, optionId)) fail(409, 'агент больше не ждёт этого ответа');
        msg.permission = { ...p, resolved: optionId, choice: optionId, resolvedAt: Date.now(), answered: true };
        updateMessage(s, msg);
        setWaiting(s, null);
        return s;
      }
      msg.permission = { ...p, resolved: optionId, choice: optionId, resolvedAt: Date.now(), answered: true };
      updateMessage(s, msg);
      const what = `${p.tool}${p.input != null ? ` ${inputSummary(p.input)}` : ''}`;
      let text;
      if (optionId === 'reject') text = `Не выполняй это (${p.tool}); найди другой путь или спроси.`;
      else {
        // the denied call goes on the allow-list (--allowed-tools): once = the next turn only, session = this chat
        const pattern = p.pattern || permissionPattern(p.tool, p.input);
        if (optionId === 'allow_session') s.allowedTools = [...new Set([...(s.allowedTools || []), pattern])];
        else if (optionId === 'allow_project') {
          // every turn of every session in this project (db.prefs.allowedToolsByWorkspace)
          db.prefs ||= {};
          const all = db.prefs.allowedToolsByWorkspace ||= {};
          all[s.workspaceId] = [...new Set([...(all[s.workspaceId] || []), pattern])];
          store.save();
        } else s.grantsOnce = [...new Set([...(s.grantsOnce || []), pattern])];
        // an edit tool in plan/default mode also needs a more permissive mode (auto-edit allows edits, never shell)
        const cur = s.approvalMode || config.agents[s.agent]?.approvalMode;
        if (EDIT_TOOLS.test(p.tool) && ['plan', 'default'].includes(cur)) {
          if (optionId !== 'allow_once') s.approvalMode = nextMode(s);
          else s.approvalOnce = nextMode(s);
        }
        text = `Разрешено: повтори ${what}`;
      }
      return api.deliver(sid, { from: 'user', text: note?.trim() ? `${text}

${note.trim()}` : text });
    },

    /** Queue a message for a chat session (starts a turn if idle) or type it into a terminal. */
    /** «Повторить»: continue a broken chat now (the automatic attempts start over). */
    revive(sid) {
      const s = get(sid);
      if (s.kind !== 'chat' || s.virtual) fail(400, 'продолжить можно только чат');
      if (runtime(sid).running) fail(409, 'агент уже работает');
      const reason = s.revive?.reason || 'повтор вручную';
      s.revive = null;
      return continueTurn(s, reason);
    },

    deliver(sid, { from = 'user', text, options, report = false }) {
      const s = get(sid);
      if (s.virtual) fail(409, 'внутренний субагент — писать можно только в родительский чат');
      if (typeof text !== 'string' || !text.trim()) fail(400, 'нужен текст сообщения');
      const r = runtime(sid);
      if (s.kind === 'terminal') {
        if (!r.pty) fail(409, 'терминал не запущен');
        r.pty.write(`${text}\r`);
        return { queued: false };
      }
      const asked = s.waitingFor === 'answer';
      if (asked || s.waitingFor === 'permission') s.waitingFor = null; // answered (by anyone)
      // the open question card of the CLI gets the answer (the Inbox tells answered from cancelled by it)
      const q = store.messages(sid).findLast((m) => m.kind === 'question' && !m.question?.answered);
      if (q) {
        q.question = { ...q.question, answered: true, answer: text.replace(/^Ответ на вопрос «.*?»: /s, '').replace(/^Ответы на вопросы:\n/, '').trim(), answeredAt: Date.now() };
        updateMessage(s, q);
      }
      if (q || asked) hooks.questionAnswered?.(s); // its notification is answered (and read) too
      const held = r.cur?.heldQuestion;
      if (held && r.running) {
        // ACP: the CLI's question still holds its request — decline it and end this turn quietly; the answer (queued
        // below) starts the next one, so the agent reads exactly what the person wrote
        r.cur.heldQuestion = null;
        r.pausedForAnswer = true;
        if (held.reject) acp.answer(sid, held.id, held.reject);
        r.handle?.stop();
      }
      if (r.running && !held && hooks.takeAnswer?.(s, { from, text })) {
        // its `ask` call waits for exactly this: the agent gets it as that call's result, in the same turn
        addMessage(s, { kind: 'user', text, from });
        emit(s);
        return { queued: false, answered: true };
      }
      if (s.interrupted) s.interrupted = null; // continued
      if (s.autoTitle && from === 'user') {
        s.title = titleFrom(text) || s.title;
        delete s.autoTitle;
      }
      if (report) s.queue = s.queue.filter((q) => !(q.report && q.from === from)); // its newer report says it all
      s.queue.push({ id: newId('q'), from, text, at: Date.now(), ...(options ? { options } : {}), ...(report ? { report: true } : {}) });
      if (!r.running) {
        startTurn(s);
        return { queued: false };
      }
      s.queued = s.queue.length;
      if (r.closedEarly) armLinger(s);
      emit(s);
      return { queued: true };
    },

    /** A queued message taken back before the agent got it (DELETE /api/sessions/:id/queue/:qid). */
    unqueue(sid, qid) {
      const s = get(sid);
      const i = (s.queue || []).findIndex((q) => q.id === qid);
      if (i < 0) fail(404, 'этого сообщения уже нет в очереди — агент его получил');
      s.queue.splice(i, 1);
      s.queued = s.queue.length;
      return emit(s);
    },

    /**
     * The queue goes now (POST /api/sessions/:id/queue/send): after a failed turn without a new message; with `interrupt`
     * the running turn is stopped and the queue starts the next one at once (the context stays: --resume).
     */
    sendQueue(sid, { interrupt = false } = {}) {
      const s = get(sid);
      if (!s.queue?.length) fail(409, 'очередь пуста');
      if (runtime(sid).running) {
        if (!interrupt) return emit(s); // it goes by itself after the current step
        const keep = s.queue.slice();
        api.stop(sid); // clears the queue: it is put back and goes when the stopped turn ends
        s.queue = keep;
        s.queued = keep.length;
        return emit(s);
      }
      startTurn(s);
      return emit(s);
    },

    stop(sid) {
      const s = get(sid);
      if (s.virtual) fail(409, 'внутренний субагент останавливается вместе с родительским чатом');
      const r = runtime(sid);
      if (s.kind === 'terminal') {
        killPty(r.pty);
        return s;
      }
      s.queue = [];
      s.queued = 0;
      if (r.running && r.closedEarly) {
        r.handle?.terminate?.('post_result_linger');
        return emit(s);
      }
      if (r.running) {
        r.stopRequested = true;
        r.handle?.stop();
        r.slotWake?.();
        s.status = 'stopped';
      }
      return emit(s);
    },

    async restart(sid) {
      const s = get(sid);
      const r = runtime(sid);
      if (s.kind === 'terminal') {
        const pty = await loadPty();
        const old = r.pty;
        r.pty = null; // detach the old onExit handler before killing
        killPty(old);
        spawnPty(s, pty);
      } else if (!r.running) {
        s.status = 'idle';
        emit(s);
      }
      return s;
    },

    /** Archive (hide; transcript kept) or unarchive; a working session only with stop: its virtual sub-agents follow. */
    archive(sid, archived = true, { stop = false } = {}) {
      const s = get(sid);
      const r = runtime(sid);
      const live = (r.running && !r.closedEarly) || !!r.pty;
      if (archived && live && !stop) fail(409, 'сессия работает — остановите её или передайте stop: true');
      if (archived && (live || r.closedEarly)) api.stop(sid); // a process lingering after result is ended
      for (const x of [s, ...db.sessions.filter((v) => v.virtual && v.parentId === sid)]) {
        if (!!x.archived === archived) continue;
        Object.assign(x, { archived, archivedAt: archived ? Date.now() : null });
        if (archived) cancelPending(x);
        if (archived) hooks.sessionGone?.(x, 'archived');
        if (archived) ignoreCli(x);
        emit(x);
      }
      return s;
    },

    /**
     * sessions.autoArchiveDays (0 = off): idle chats with nothing pending and exited terminals older than N days are
     * archived; never one that runs, waits for an answer, was interrupted, owns an in-progress task or leads live workers.
     */
    autoArchive(now = Date.now()) {
      const days = Number(config.sessions?.autoArchiveDays ?? 7);
      if (!(days > 0)) return 0;
      const cutoff = now - days * 86400000;
      const liveChild = (s) => db.sessions.some((c) => c.parentId === s.id && !c.virtual && !c.archived && ['running', 'idle'].includes(c.status));
      const ownsWork = (s) => db.tasks.some((t) => t.assigneeSessionId === s.id && t.status === 'in_progress');
      let n = 0;
      for (const s of db.sessions.filter((x) => !x.archived && !x.virtual && (x.lastActivityAt || 0) < cutoff)) {
        const r = runtime(s.id);
        const idle = s.kind === 'terminal' ? s.status === 'exited' && !r.pty : !r.running && s.status !== 'running';
        if (!idle || s.waitingFor || s.interrupted || ownsWork(s) || liveChild(s)) continue;
        api.archive(s.id, true);
        n++;
      }
      if (n) console.log(`[harness] auto-archived ${n} inactive session(s)`);
      return n;
    },

    /**
     * The harness's own `agent` tool (worker_run with the built-in tool's arguments) can reach the stream as a call named
     * «agent» (ACP shows the bare MCP tool name): it opened a read-only copy as if it were the built-in sub-agent while
     * the harness started the real chat. The copy of that call goes; its tool line opens the real chat. → adopted?
     */
    adoptVirtual(parentId, workerId, prompt) {
      const promptOf = (v) => store.messages(v.id).find((m) => m.kind === 'user')?.text ?? '';
      const copies = db.sessions.filter((x) => x.virtual && x.parentId === parentId && x.status === 'running');
      // the same task; else a copy whose arguments have not come (ACP may never send them): the same call, by order
      const v = copies.find((x) => promptOf(x) === prompt) || copies.find((x) => ['{}', 'null', ''].includes(promptOf(x).trim()));
      if (v) return replaceCopy(v, workerId);
      // not in the stream yet (or its arguments are not): matched when they come (openVirtual / fillVirtual)
      adopted.set(parentId, [...(adopted.get(parentId) || []), { prompt, workerId, at: Date.now() }]);
    },

    remove(sid, { force = false } = {}) {
      const s = get(sid);
      const r0 = runtime(sid);
      if (!force && ((r0.running && !r0.closedEarly) || r0.pty)) fail(409, 'сессия работает — остановите её или удалите с ?force=1');
      for (const v of db.sessions.filter((x) => x.virtual && x.parentId === sid)) api.remove(v.id, { force: true });
      hooks.sessionGone?.(s, 'removed');
      ignoreCli(s);
      const r = runtime(sid);
      clearInterval(r.registryTimer);
      r.handle?.stop();
      const p = r.pty;
      r.pty = null;
      killPty(p);
      acp.drop(sid);
      db.sessions = db.sessions.filter((x) => x.id !== sid);
      rt.delete(sid);
      store.removeSessionFiles(sid);
      // the process may still hold stderr.log for a moment; settings.json goes first
      for (const f of ['settings.json', 'mcp.json']) fs.rmSync(path.join(runDir(sid), f), { force: true });
      git.removeDir(runDir(sid));
      store.save();
      bus.send({ t: 'session.del', id: s.id });
    },

    /** strict false (internal callers): an includeDirs entry that no longer exists is dropped, not a 400. */
    patch(sid, p, { strict = true } = {}) {
      const s = get(sid);
      for (const k of ['title', 'approvalMode', 'model']) if (k in p && p[k] !== null && typeof p[k] !== 'string') fail(400, `${k}: нужна строка`);
      for (const k of ['autoReport', 'archived', 'stop', 'dismissed']) if (k in p && typeof p[k] !== 'boolean') fail(400, `${k}: нужно true или false`);
      // «Убрать из «Ждут вас»»: its error / cut turn is seen; a newer one brings it back (lastActivityAt moves past it)
      if ('dismissed' in p) s.dismissedAt = p.dismissed ? Date.now() : null;
      if ('archived' in p) api.archive(sid, p.archived, { stop: p.stop === true });
      if (p.approvalMode && config.agents[s.agent]) checkMode(config.agents[s.agent], p.approvalMode);
      if (p.title?.trim()) {
        s.title = p.title.trim();
        delete s.autoTitle;
      }
      if ('approvalMode' in p) s.approvalMode = p.approvalMode || null;
      if ('model' in p) {
        s.model = p.model || null;
        s.contextLimit = contextLimit(s);
      }
      if ('autoReport' in p) s.autoReport = p.autoReport;
      if ('includeDirs' in p) s.includeDirs = normalizeIncludeDirs(p.includeDirs, s.cwd, strict); // applies from the next turn
      if ('allowedTools' in p) {
        if (!Array.isArray(p.allowedTools) || p.allowedTools.some((x) => typeof x !== 'string' || !x.trim())) fail(400, 'allowedTools: нужен массив непустых строк');
        s.allowedTools = [...new Set(p.allowedTools.map((x) => x.trim()))];
      }
      emit(s);
      // messages left queued by a turn that could not start (e.g. unknown model) go once another model is picked
      if ('model' in p && s.kind === 'chat' && s.queue?.length && !runtime(sid).running) startTurn(s);
      return s;
    },

    logTail(sid) {
      const s = get(sid);
      if (s.kind === 'terminal') return { text: store.termLog(sid).slice(-64 * 1024) };
      try {
        const file = path.join(runDir(sid), 'stderr.log');
        const size = fs.statSync(file).size;
        const fd = fs.openSync(file, 'r');
        const len = Math.min(size, 64 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        fs.closeSync(fd);
        return { text: buf.toString('utf8') };
      } catch {
        return { text: '' };
      }
    },

    termInput(sid, data) {
      if (typeof data === 'string') runtime(sid).pty?.write(data);
    },
    termResize(sid, cols, rows) {
      const r = runtime(sid);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return;
      r.cols = cols;
      r.rows = rows;
      try { r.pty?.resize(cols, rows); } catch {}
    },
    termReplay: (sid) => store.termLog(sid),

    /**
     * After a restart (once hooks are installed): re-attach turns whose pid is still the same process, drain the
     * others from their files, send persisted deliveries of idle chats, respawn terminals.
     */
    async resumeRuns() {
      const runs = toReattach.splice(0);
      const ours = await Promise.all(runs.map((s) => sameProcess(s.pid, s.pidStartedAt).catch(() => false)));
      const drains = runs.map((s, i) => (find(s.id) ? reattach(s, ours[i]) : null));
      await Promise.all(drains.filter((d, i) => d && !ours[i])); // not adopted: only the file is read, at once
      const cut = db.sessions.filter((s) => s.interrupted && s.interrupted.at >= startupAt);
      if (cut.length) {
        hooks.notify?.({ kind: 'recovery', text: `Прервано сессий: ${cut.length}` });
        if (config.recovery?.autoResume) api.recoveryResume(cut.map((s) => s.id));
      }
      for (const s of db.sessions) if (s.kind === 'chat' && !s.virtual && s.queue?.length && !runtime(s.id).running) startTurn(s);
      await Promise.all(toRespawn.splice(0).filter((s) => find(s.id)).map(respawnTerminal));
    },

    /** A prompt on a warm ACP process of `agent` in a hidden session (null when none is warm). */
    acpPrompt: (agent, text) => acp.helperPrompt(agent, text),

    /** A CLI history transcript as the past of a harness chat (marked imported; turn 0). */
    importMessages(sid, msgs, turn = 0) {
      get(sid);
      for (const m of msgs) store.putMessage(sid, { from: null, tool: null, ...m, sessionId: sid, turn, imported: true });
    },

    /**
     * Startup, one pass over the cached worktree lists: sessions saved before the repo-first rule that sit in a
     * repository's worktree but are attached to a folder workspace merely containing it move to that repository.
     */
    async reresolveWorkspaces() {
      let moved = 0;
      for (const s of db.sessions.filter((x) => !x.virtual && x.cwd)) {
        const place = await placeFor(s.cwd, false, false);
        const cur = db.workspaces.find((w) => w.id === s.workspaceId);
        // a repository found for the worktree wins; a session outside any worktree keeps the folder it had
        const workspaceId = place.system ? null : place.worktreePath ? place.workspaceId : cur ? s.workspaceId : place.workspaceId;
        if (s.workspaceId !== workspaceId || (s.worktreePath ?? null) !== place.worktreePath || !!s.system !== place.system) {
          Object.assign(s, { workspaceId, worktreePath: place.worktreePath, system: place.system });
          moved++;
        }
      }
      for (const v of db.sessions.filter((x) => x.virtual)) {
        const p = find(v.parentId);
        if (p) Object.assign(v, { workspaceId: p.workspaceId, worktreePath: p.worktreePath ?? null, system: !!p.system });
      }
      if (moved) {
        store.save();
        console.log(`[harness] ${moved} session(s) re-grouped (worktree / repository / harness system folder)`);
      }
      return moved;
    },

    // ---- recovery after a restart ----
    recoveryList() {
      return {
        sessions: db.sessions.filter((s) => s.interrupted).map((s) => ({
          id: s.id, title: s.title, cwd: s.cwd, taskId: s.taskId, role: s.role, reason: s.interrupted.reason, at: s.interrupted.at, lastActivity: s.interrupted.lastActivity,
        })),
        message: config.recovery?.message || '',
      };
    },
    /** Sends the message to each interrupted session (workers/reviewers before their coordinators). */
    recoveryResume(ids, message) {
      if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) fail(400, 'sessionIds: нужен массив id сессий');
      const text = (typeof message === 'string' && message.trim()) || config.recovery?.message;
      if (!text) fail(400, 'нужен текст сообщения (recovery.message пуст)');
      const list = ids.map(get).filter((s) => s.interrupted).sort((a, b) => (a.role === 'coordinator') - (b.role === 'coordinator'));
      for (const s of list) api.deliver(s.id, { from: 'user', text });
      return { resumed: list.map((s) => s.id) };
    },
    recoveryDismiss(ids) {
      if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) fail(400, 'sessionIds: нужен массив id сессий');
      const list = ids.map(get).filter((s) => s.interrupted);
      for (const s of list) {
        s.interrupted = null;
        emit(s);
      }
      return { dismissed: list.map((s) => s.id) };
    },

    /** Harness shutdown: agent turns keep running (re-attached on the next start); terminals are closed. */
    close() {
      clearInterval(stallTimer);
      clearInterval(archiveTimer);
      acp.close();
      for (const r of rt.values()) {
        clearInterval(r.registryTimer);
        r.handle?.detach();
        const p = r.pty;
        r.pty = null;
        killPty(p);
      }
    },
  };
  return api;
}
