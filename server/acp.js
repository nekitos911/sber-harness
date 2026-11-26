// ACP transport (agents.<id>.transport: "acp"): one long-lived `<cli> --acp` process per session, JSON-RPC 2.0 over
// ndjson stdio (Agent Client Protocol). The harness is the client: it answers fs/* and session/request_permission
// (held until the user answers in the UI) and turns session/update notifications into the same events as headless.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { endChild, readTail, spawnOptions } from './runner.js';
import { resolveInside } from './fs.js';

const PROTOCOL_VERSION = 1;
/** The managed-launch dead end, in the words the chat shows (START_FATAL in sessions.js: no retries). */
export const CREDENTIALS_WANTED = 'GigaCode в режиме ACP ждёт вход от GigaCode Desktop (session/requestCredentialsRefresh): '
  + 'с версии 26.11 любой запуск с --acp считается запуском из Desktop, а такой вход харнесу недоступен. '
  + 'Настройки → Агенты → «Запуск»: «На каждое сообщение» — так GigaCode входит сам, как в консоли.';
const ACP_INIT_TIMEOUT_MS = 120000;
const MCP_START_TIMEOUT_MS = 30000; // how long the agent may start one MCP server (mcpServers.<name>.timeoutMs)
const LOAD_ATTEMPTS = 3; // session/load: tries before a new session
const LOAD_RETRY_MS = 3000;

/** JSON-RPC 2.0 over a child's stdio (newline-delimited JSON). */
function connect(child, { onRequest, onNotify, log }) {
  let seq = 0;
  const pending = new Map(); // id -> { resolve, reject }
  const write = (msg) => child.stdin.writable && child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log(`[acp] non-JSON stdout: ${line.slice(0, 500)}\n`);
        continue;
      }
      if (msg.method && msg.id !== undefined) {
        // a request from the agent: answer it (possibly much later, e.g. a held permission)
        Promise.resolve()
          .then(() => onRequest(msg.method, msg.params || {}))
          .then((result) => write({ id: msg.id, result: result ?? null }), (e) => write({ id: msg.id, error: { code: e.code || -32603, message: e.message } }));
      } else if (msg.method) {
        onNotify(msg.method, msg.params || {});
      } else if (pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        // GigaCode puts the real reason in data.details («Request timed out waiting for hook-execution-response»)
        const details = typeof msg.error?.data?.details === 'string' ? msg.error.data.details : '';
        if (msg.error) p.reject(Object.assign(new Error([msg.error.message || 'ACP error', details].filter(Boolean).join(': ')), { code: msg.error.code }));
        else p.resolve(msg.result);
      }
    }
  });
  return {
    request(method, params, timeoutMs = 0) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = timeoutMs ? setTimeout(() => { pending.delete(id); reject(new Error(`ACP ${method}: нет ответа за ${Math.round(timeoutMs / 1000)} с`)); }, timeoutMs) : null;
        pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        write({ id, method, params });
      });
    },
    notify: (method, params) => write({ method, params }),
    failAll(err) {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    },
  };
}

const sizeOf = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
};

/**
 * A start request (initialize, session/new) that waits as long as the agent shows signs of life: GigaCode answers only
 * after its MCP servers are up, and on a loaded machine that took longer than any fixed limit while its stderr kept
 * growing (MCP warnings, «event loop stall»). It fails after `idleMs` of silence, or after PATIENCE × idleMs in all.
 */
export function patientRequest(rpc, method, params, { idleMs, errFile, pollMs = 2000 }) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let size = sizeOf(errFile);
    let last = started;
    const tick = setInterval(() => {
      const now = Date.now();
      const cur = sizeOf(errFile);
      if (cur !== size) {
        size = cur;
        last = now;
      }
      if (now - last >= idleMs || now - started >= idleMs * PATIENCE) {
        clearInterval(tick);
        reject(new Error(`ACP ${method}: нет ответа за ${Math.round((now - started) / 1000)} с`));
      }
    }, Math.min(pollMs, idleMs));
    tick.unref?.();
    rpc.request(method, params).then((v) => { clearInterval(tick); resolve(v); }, (e) => { clearInterval(tick); reject(e); });
  });
}
const PATIENCE = 2; // a start that keeps writing still gives up after 2 × the limit: waiting longer only hid a dead start

/**
 * The MCP servers an ACP session gets, in ACP shape (MCP SDK schema): stdio { name, command, args, env: [{ name, value }] },
 * http { type: 'http', name, url, headers: [{ name, value }], enabled: true }. An extra key inside a server object is
 * fine; an extra key in session/new params is not — the agent parses them strictly and rejects the whole request.
 *
 * Only the harness server: the servers set up in the harness are for its own task and PR work, while a chat starts the
 * agent's own list from its settings.json. The agent waits for every server it is given before it answers session/new,
 * so a chat would hang on a tracker or documentation server it never uses.
 *
 * `timeoutMs` comes from the config (mcpServers.<name>.timeoutMs, harness's own harnessMcp.timeout): the agent gives up
 * on a server that does not start after it and goes on with the rest (VERIFY: field name in the ACP schema).
 */
export function acpMcpServers(harnessMcp, { timeoutMs = MCP_START_TIMEOUT_MS } = {}) {
  const pairs = (obj) => Object.entries(obj || {}).map(([name, value]) => ({ name, value: String(value) }));
  return [{ name: 'harness', ...(harnessMcp.command
    ? { command: harnessMcp.command, args: harnessMcp.args || [], env: pairs(harnessMcp.env) }
    : { type: 'http', url: harnessMcp.url || harnessMcp.httpUrl, headers: pairs(harnessMcp.headers), enabled: true }),
  timeoutMs }];
}

const textOf = (content) => (Array.isArray(content) ? content : [content]).filter(Boolean).map((c) => {
  if (c.type === 'diff') {
    // shortcut: whole-file before/after, not a minimal hunk; the UI shows it as a diff block
    const lines = (t, sign) => (t ? String(t).split('\n').map((l) => `${sign}${l}`) : []);
    return [`--- ${c.path}`, `+++ ${c.path}`, ...lines(c.oldText, '-'), ...lines(c.newText, '+')].join('\n');
  }
  const inner = c.type === 'content' ? c.content : c;
  return inner?.type === 'text' ? inner.text : inner ? JSON.stringify(inner) : '';
}).join('\n');

/** The step's token usage as a harness 'usage' event; GigaCode reports it in the chunk's _meta, not in the prompt response. */
function usageFrom(update) {
  const u = update?._meta?.usage;
  return u && Number.isFinite(u.inputTokens)
    ? [{ type: 'usage', contextTokens: (u.inputTokens || 0) + (u.outputTokens || 0), input: u.inputTokens || 0, output: u.outputTokens || 0, cacheRead: u.cachedReadTokens || 0 }]
    : [];
}

const isEmptyInput = (v) => v == null || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

/**
 * An ACP tool call as the harness sees it: `{ name, input }`. GigaCode's `title` is its own card title (`Shell: git
 * status (…)`), so the tool name comes from `_meta.toolName` and the arguments from `rawInput` or, for the ToolCall /
 * ToolSearch wrappers, from the wrapper's own arguments (`{"prompt": …}` after `agent (harness MCP Server): `, the
 * pattern after `Поиск `).
 */
export function acpToolCall(tc = {}, { label = false } = {}) {
  const meta = tc._meta || {};
  const title = String(tc.title ?? '');
  const raw = isEmptyInput(tc.rawInput) ? null : tc.rawInput;
  // the call the wrapper names is still being prepared: its title is the wrapper's (`ToolCall`, `ToolSearch: harness`),
  // so a card under that name would hang for a minute, and the query in it is not the wrapped tool's name either — the
  // card appears with the next update. `tool_search` is the wrapper's own tool and is never replaced.
  const wrapper = String(meta.toolName ?? '');
  if (/^(tool_call|toolsearch)$/i.test(wrapper) && !wrapperName(title, '')) return { name: wrapper === 'tool_call' ? 'tool' : wrapper, input: null };
  const input = raw ?? wrapperInput(title);
  // a bare `update` names nothing: the harness keeps the tool it announced (null = keep it)
  if (!meta.toolName) return { name: tc.title ? title : null, kind: tc.kind ?? null, input };
  const name = String(meta.toolName);
  // a permission card names the call the way the agent titled it (`Запись out.txt`) — the person answers that, not `write_file`
  const shown = label && tc.title ? title : name;
  // `glob` / `search` / `run_shell_command`: the tool itself; `Glob: '**\/*.md'` is only its card title, and an
  // announced call may carry nothing at all: the pattern is still readable from the title
  if (!/^(tool_call|toolsearch)$/i.test(name)) return { name: shown, input: raw ?? fromTitle(name, title, tc.kind) };
  const inner = wrapperName(title, name);
  // the wrapper's own arguments (`agent (harness MCP Server): {…}`) are the wrapped call's; `ToolSearch: harness` is a query
  if (inner !== name) return { name: label && tc.title ? title : inner, input: raw ?? toolArguments(title) };
  // the wrapper is still on its own title (`ToolCall` / `ToolSearch: harness agent`): the call it wraps is not named yet
  return { name: 'tool', input: null };
}

/** Arguments an empty call still spells out in its title: the pattern after `Поиск: `, the command after `Shell: `. */
function fromTitle(name, title, kind) {
  const sep = title.indexOf(': ');
  if (sep < 0) return null;
  const text = title.slice(sep + 2).trim();
  if (!text) return null;
  if (/shell|bash|command/i.test(name) || kind === 'execute') return { command: text.replace(/\s+\([^(]*\)$/, '') };
  return { pattern: text.replace(/^'(.*)'$/, '$1') };
}

/** The wrapped tool's arguments: the JSON after `: ` if it is an object (`select:mcp__harness__ask` → its name only). */
function toolArguments(title) {
  const input = wrapperInput(title);
  return input && typeof input === 'object' && !/^select:/i.test(title.slice(title.indexOf(':') + 1).trim()) ? input : null;
}

/** The wrapper's tool: `agent (harness MCP Server): {…}` → `mcp__harness__agent`; `select:mcp__harness__ask` → itself. */
function wrapperName(title, fallback) {
  const server = title.match(/^(\S+) \(([^)]*) MCP Server\)/i);
  if (server) {
    const id = server[2].match(/[a-z0-9-]+$/i)?.[0];
    return id ? `mcp__${id}__${server[1]}` : server[1];
  }
  const selected = title.match(/^\S*:\s*(mcp__\w+)/);
  if (selected) return selected[1];
  const tool = title.match(/^([a-zA-Z_][\w.]{1,60})(?::|$)/);
  return tool && !/^tool_?call$/i.test(tool[1]) ? tool[1] : fallback;
}

/** The wrapper's arguments: JSON after `: `, else `<Verb>: <arg>` (`Поиск **\/*.md` → `{ search: '**\/*.md' }`). */
function wrapperInput(title) {
  const json = title.match(/:\s*(\{[\s\S]*\})\s*$/)?.[1];
  if (json) {
    try {
      return JSON.parse(json);
    } catch {}
  }
  const sep = title.indexOf(': ');
  return sep < 0 ? null : { [title.slice(0, sep).trim().toLowerCase()]: title.slice(sep + 2).trim() };
}

/** session/update -> the normalized events headless turns produce (plus 'plan'). Replays during session/load are skipped by the caller. */
export function acpEvents(update) {
  const usage = usageFrom(update);
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content?.type === 'text' ? [...usage, { type: 'text', text: update.content.text, delta: true }] : usage;
    case 'agent_thought_chunk':
      return update.content?.type === 'text' ? [{ type: 'thought', text: update.content.text, delta: true }] : [];
    case 'tool_call': {
      const { name, input } = acpToolCall(update);
      // a wrapper that has not named its tool yet: the card is «инструмент», not a call of ToolCall that hangs
      const known = name && name !== 'tool';
      return [{ type: 'tool_call', id: update.toolCallId, name: name || update.kind || 'tool', input: known ? input : null }];
    }
    case 'tool_call_update': {
      // the call came with rawInput {} (announced before the model finished it); the real input follows in an update
      const call = acpToolCall(update);
      const out = call.input != null ? [{ type: 'tool_input', id: update.toolCallId, input: call.input, name: call.name && call.name !== 'tool' ? call.name : null }] : [];
      if (update.status === 'completed' || update.status === 'failed') {
        out.push({ type: 'tool_result', id: update.toolCallId, output: textOf(update.content) || (update.rawOutput != null ? JSON.stringify(update.rawOutput) : ''), isError: update.status === 'failed' });
      }
      return out;
    }
    case 'plan':
      return [{ type: 'plan', entries: update.entries || [], text: `План:\n${(update.entries || []).map((e) => `${e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '…' : '·'} ${e.content}`).join('\n')}` }];
    default:
      return []; // user_message_chunk, available_commands_update, current_mode_update, ...
  }
}

/**
 * Whether a permission request is answered by the harness itself, and with which option: the harness's own MCP tools
 * (server `harness` in `_meta.serverId`) are pre-allowed in every mode, and in «Полный доступ» (`turn.fullAccess`)
 * everything is; a question is never — it waits for the person. null = the user answers the card.
 */
export function autoApprove({ toolCall, options } = {}) {
  // a question waits for the person in every mode: pre-allowing «may I ask?» would answer the question itself
  const asks = Array.isArray(toolCall?.rawInput?.questions);
  if (asks) return null;
  const mine = toolCall?._meta?.serverId === 'harness' || /^mcp__harness__/.test(String(toolCall?._meta?.toolName ?? ''));
  if (!mine && !toolCall?.fullAccess) return null;
  const list = options || [];
  const pick = ['allow_always', 'allow_once'].map((kind) => list.find((o) => o.kind === kind)).find(Boolean);
  if (!pick) return null;
  return { optionId: pick.optionId, why: mine ? 'инструмент harness' : 'Полный доступ — вопросы не задаются' };
}

/**
 * Per-session ACP connections of one harness. `onWarm(sid, warm)` reports a process loaded / unloaded (session.warm).
 * An idle process (no prompt, no held permission) is unloaded after `idleMs` and reloaded with session/load on the next
 * message.
 */
export function createAcp({ onWarm = () => {} } = {}) {
  const conns = new Map(); // sid -> connection state
  const idleTimers = new Map(); // sid -> timer

  function armIdle(c, idleMs) {
    clearTimeout(idleTimers.get(c.sid));
    if (!(idleMs > 0)) return;
    const t = setTimeout(() => {
      // still idle: unload, the next message reloads — not while a background sub-agent of the CLI works inside it
      if (!c.turn && !c.held.size && !c.helpers?.size && !c.keepAlive?.()) drop(c.sid);
      else if (!c.dead && conns.get(c.sid) === c) armIdle(c, idleMs); // busy (e.g. a helper prompt): looked at again later
    }, idleMs);
    t.unref?.();
    idleTimers.set(c.sid, t);
  }

  function drop(sid) {
    clearTimeout(idleTimers.get(sid));
    idleTimers.delete(sid);
    const c = conns.get(sid);
    if (!c) return;
    conns.delete(sid);
    onWarm(sid, false);
    c.dead = true;
    for (const resolve of c.held.values()) resolve({ outcome: { outcome: 'cancelled' } });
    c.held.clear();
    endChild(c.child);
  }

  /** Starts (or reuses) the agent process + ACP session. `externalSessionId` -> session/load when supported. */
  async function ensure(o) {
    const cur = conns.get(o.sid);
    if (cur && !cur.dead) return cur;
    const log = (t) => {
      try {
        fs.appendFileSync(o.logFile, t);
      } catch {} // the session (and its run folder) may be gone by the time the process exits
    };
    const args = [...o.command.args, ...o.launcher.acpArgs(o.ctx)];
    log(`\n=== ${new Date().toISOString()} ACP ${o.command.file} ${args.join(' ')}\n`);
    const errFile = path.join(path.dirname(o.logFile), 'acp.err.txt');
    const err = fs.openSync(errFile, 'a');
    let child;
    try {
      child = spawn(o.command.file, args, spawnOptions({ cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', err] }, { group: true }));
    } finally {
      fs.closeSync(err);
    }
    const c = { sid: o.sid, agent: o.agent ?? null, keepAlive: o.keepAlive ?? null, cwd: o.cwd, mcp: acpMcpServers(o.ctx.harnessMcp, { timeoutMs: o.ctx.mcpTimeoutMs }), child, held: new Map(), helpers: new Map(), loading: false, turn: null, dead: false, errFile, sessionId: null };
    conns.set(o.sid, c);
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    child.on('error', (e) => log(`[acp] ${e.message}\n`));
    exited.then(({ code, signal }) => {
      c.dead = true;
      if (conns.get(o.sid) === c) {
        conns.delete(o.sid);
        onWarm(o.sid, false);
      }
      log(`=== ACP process exited code=${code} signal=${signal}\n`);
      c.rpc.failAll(Object.assign(new Error(`Процесс ACP-агента завершился (код ${code}${signal ? `, ${signal}` : ''})`), { exited: true }));
      for (const resolve of c.held.values()) resolve({ outcome: { outcome: 'cancelled' } });
      c.held.clear();
    });
    const roots = () => c.turn?.roots || o.roots;
    const guard = (p) => {
      for (const base of roots()) {
        try {
          return resolveInside(base, p).abs;
        } catch {}
      }
      throw Object.assign(new Error(`путь вне папки сессии и её дополнительных папок: ${p}`), { code: -32602 });
    };
    c.rpc = connect(child, {
      log,
      onNotify(method, params) {
        if (method === 'session/requestCredentialsRefresh') {
          // GigaCode 26.11+ treats every --acp launch as «managed» (Desktop app, IDE plugin) and parks until the client
          // publishes its credentials (session/updateCredentials) — the harness has none: say so now, not after 120 s
          log('[acp] session/requestCredentialsRefresh: агент ждёт учётные данные от клиента\n');
          c.rpc.failAll(Object.assign(new Error(CREDENTIALS_WANTED), { credentials: true }));
          drop(o.sid);
          return;
        }
        if (method !== 'session/update' || c.loading) return; // load replays the transcript we already have
        const helper = c.helpers.get(params.sessionId);
        if (helper) { // a hidden helper session (e.g. /models) on this warm process
          if (params.update?.sessionUpdate === 'agent_message_chunk' && params.update.content?.type === 'text') helper.text += params.update.content.text;
          return;
        }
        if (!c.turn) return;
        if (c.turn.usage) c.turn.usage.push(...usageFrom(params.update));
        for (const ev of acpEvents(params.update)) c.turn.emit(ev);
      },
      async onRequest(method, params) {
        if (method === 'session/request_permission') {
          if (!c.turn) return { outcome: { outcome: 'cancelled' } };
          const call = acpToolCall(params.toolCall);
          // the card's own title: the person decides on «Запись out.txt», while the event line keeps the tool's name
          const labelled = acpToolCall(params.toolCall, { label: true });
          // the ToolCall wrapper announces {} and carries the real arguments only here: the card may still be pending
          if (params.toolCall?.toolCallId && call.input != null) c.turn.emit({ type: 'tool_input', id: params.toolCall.toolCallId, input: call.input, name: call.name });
          const yes = autoApprove({ ...params, toolCall: { ...params.toolCall, fullAccess: !!c.turn.fullAccess } });
          if (yes) {
            c.turn.emit({ type: 'permission_auto', tool: call.name, input: call.input, why: yes.why });
            return { outcome: { outcome: 'selected', optionId: yes.optionId } };
          }
          const id = `p_${randomBytes(4).toString('hex')}`;
          const answer = new Promise((resolve) => c.held.set(id, resolve));
          c.turn.emit({
            type: 'permission', id, toolId: params.toolCall?.toolCallId ?? null, tool: labelled.name,
            input: call.input, options: (params.options || []).map((x) => ({ id: x.optionId, label: x.name, kind: x.kind })),
          });
          return answer;
        }
        if (method === 'fs/read_text_file') {
          const text = fs.readFileSync(guard(params.path), 'utf8');
          if (!params.line && !params.limit) return { content: text };
          const lines = text.split('\n');
          const from = Math.max((params.line || 1) - 1, 0);
          return { content: lines.slice(from, params.limit ? from + params.limit : undefined).join('\n') };
        }
        if (method === 'fs/write_text_file') {
          const file = guard(params.path);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, String(params.content ?? ''));
          return null;
        }
        throw Object.assign(new Error(`harness не поддерживает метод ${method}`), { code: -32601 });
      },
    });
    try {
      const init = await Promise.race([
        // files stay the agent's own business by default: with the harness as its file system, GigaCode's «read before
        // edit» guard never saw the reads and refused every edit (agents.<id>.acpClientFs: true brings it back)
        patientRequest(c.rpc, 'initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: !!o.clientFs, writeTextFile: !!o.clientFs }, terminal: false } }, { idleMs: o.initTimeoutMs || ACP_INIT_TIMEOUT_MS, errFile }),
        exited.then(({ code }) => { throw new Error(`ACP-агент завершился при запуске (код ${code})`); }),
      ]);
      const mcpServers = acpMcpServers(o.ctx.harnessMcp, { timeoutMs: o.ctx.mcpTimeoutMs });
      c.note = null;
      if (o.externalSessionId && init?.agentCapabilities?.loadSession) {
        c.loading = true;
        try {
          // a load right after «extension store busy» failed with «Internal error» once and worked a moment later
          for (let n = 1; ; n++) {
            try {
              await c.rpc.request('session/load', { sessionId: o.externalSessionId, cwd: o.cwd, mcpServers });
              c.sessionId = o.externalSessionId;
              break;
            } catch (e) {
              if (n >= LOAD_ATTEMPTS) throw e;
              await new Promise((r) => setTimeout(r, LOAD_RETRY_MS));
            }
          }
        } catch (e) {
          c.note = `ACP: не удалось загрузить сессию агента (${e.message}) — начата новая; харнесс передал ей правила и краткую запись этого чата.`;
          c.lostContext = true;
        } finally {
          c.loading = false;
        }
      } else if (o.externalSessionId) {
        c.note = 'ACP: агент не умеет загружать сессии — начата новая; харнесс передал ей правила и краткую запись этого чата.';
        c.lostContext = true;
      }
      // session/new can be long (the agent cold-starts the MCP servers); the child dying is the only other outcome
      if (!c.sessionId) {
        const created = await Promise.race([
          patientRequest(c.rpc, 'session/new', { cwd: o.cwd, mcpServers }, { idleMs: o.initTimeoutMs || ACP_INIT_TIMEOUT_MS, errFile }),
          exited.then(({ code }) => { throw new Error(`ACP-агент завершился при создании сессии (код ${code})`); }),
        ]);
        c.sessionId = created.sessionId;
        c.models = created.models || null;
      }
      onWarm(o.sid, true);
    } catch (e) {
      drop(o.sid);
      throw Object.assign(e, { stderrTail: readTail(errFile) });
    }
    return c;
  }

  /**
   * One prompt as a turn; returns the same handle shape as runner.runTurn ({ pid, startedAt, stop, detach, done }).
   * o = { sid, launcher, ctx, command, cwd, env, logFile, roots, externalSessionId, prompt, onEvent, initTimeoutMs, clientFs,
   *       fullAccess: the chat runs in «Полный доступ» — permission requests are answered without a card }
   */
  /**
   * Puts the session on the asked model when this account really has it: `session/new` answers with its own catalogue
   * (`models.currentModelId` / `availableModels`), so an id that left the catalogue gets a note in the chat instead of a
   * failed turn. Best effort: an agent without `session/set_model` keeps whatever it chose.
   */
  async function fitModel(o, c) {
    const wanted = o.ctx.acpWantedModel ?? null;
    const models = c.models;
    if (!wanted || !models || c.fittedModel === wanted) return;
    const available = Array.isArray(models.availableModels) ? models.availableModels : [];
    const ids = available.map((m) => m?.modelId ?? m?.id).filter(Boolean);
    const base = (id) => String(id).toLowerCase().replace(/-\d+[km]$/i, '');
    const hit = ids.find((id) => id === wanted) ?? ids.find((id) => base(id) === base(wanted)) ?? null;
    const current = models.currentModelId ?? null;
    if (!hit) {
      c.fittedModel = wanted;
      o.onEvent({ type: 'note', text: `⚠ Модели «${wanted}» нет в каталоге сервера — ход идёт с моделью по умолчанию` });
      return;
    }
    if (hit !== current) {
      try {
        await c.rpc.request('session/set_model', { sessionId: c.sessionId, modelId: hit }, o.initTimeoutMs / 4 || 30000);
        c.models = { ...models, currentModelId: hit };
      } catch (e) {
        o.onEvent({ type: 'note', text: `⚠ Не удалось переключить сессию на «${hit}» (${e.message}) — ход идёт с моделью по умолчанию` });
      }
    }
    c.fittedModel = current === hit ? wanted : hit;
  }

  function turn(o) {
    const res = { code: null, signal: null, sawResult: false, timedOut: false, stopped: false, detached: false, error: null, stderrTail: '', eventCount: 0, priorOutput: false };
    let c = null;
    let stop = false;
    let settle;
    const usage = []; // per-step usage from the chunk _meta: the turn's totals for the counter
    const done = new Promise((resolve) => { settle = resolve; });
    const emit = (ev) => {
      res.eventCount++;
      try {
        o.onEvent(ev);
      } catch {}
    };
    (async () => {
      try {
        c = await ensure(o);
        clearTimeout(idleTimers.get(o.sid));
        c.turn = { emit, roots: o.roots, usage, fullAccess: !!o.fullAccess };
        // the model lives in the session: session/new has already told us what this account can run, so a stale id is
        // switched (or dropped to the agent's own default) HERE, without a respawn
        await fitModel(o, c).catch(() => {});
        if (c.sessionId) emit({ type: 'session', id: c.sessionId });
        if (c.note) {
          emit({ type: 'note', text: c.note });
          c.note = null;
        }
        if (stop) throw Object.assign(new Error('stopped'), { stopped: true });
        // a new session in place of one that would not load: the recap goes with this prompt (a slash command stays first)
        let text = o.prompt;
        const recap = c.lostContext && o.recap ? o.recap() : '';
        c.lostContext = false;
        if (recap) text = text.startsWith('/') ? `${text}\n\n${recap}` : `${recap}\n\n${text}`;
        const r = await c.rpc.request('session/prompt', { sessionId: c.sessionId, prompt: [{ type: 'text', text }] });
        res.code = 0;
        res.sawResult = true;
        // before the result event: the turn closes at result, an error stop reason must already be known then
        if (r?.stopReason === 'cancelled') res.stopped = true;
        else if (r?.stopReason && !['end_turn', 'max_turn_requests'].includes(r.stopReason)) res.error = `Агент остановился: ${r.stopReason}`;
        // GigaCode puts the step's usage in the chunk _meta (already emitted as 'usage'); other agents answer it here
        if (r?.usage && Number.isFinite(r.usage.inputTokens)) {
          emit({ type: 'usage', contextTokens: (r.usage.inputTokens || 0) + (r.usage.outputTokens || 0), input: r.usage.inputTokens || 0, output: r.usage.outputTokens || 0, cacheRead: r.usage.cachedReadTokens || 0 });
        }
        const total = [...usage].pop();
        emit({ type: 'result', tokensIn: total?.input ?? 0, tokensOut: total?.output ?? 0 });
      } catch (e) {
        if (stop || e.stopped) res.stopped = true;
        else {
          res.error = e.message;
          res.stderrTail = e.stderrTail ?? (c ? readTail(c.errFile) : '');
        }
      } finally {
        if (c) {
          c.turn = null;
          if (!c.dead) armIdle(c, o.idleMs);
        }
        settle(res);
      }
    })();
    return {
      get pid() { return c?.child.pid ?? null; },
      startedAt: null, // not re-attachable: the process cannot outlive the harness (stdio pipes)
      stop() {
        stop = true;
        res.stopped = true;
        if (!c || c.dead) return;
        c.rpc.notify('session/cancel', { sessionId: c.sessionId });
        for (const resolve of c.held.values()) resolve({ outcome: { outcome: 'cancelled' } });
        c.held.clear();
        o.onEvent({ type: 'permission_cancelled' });
      },
      detach() {
        res.detached = true;
        drop(o.sid);
        settle(res);
      },
      done,
    };
  }

  return {
    turn,
    /** The user's answer to a held session/request_permission; false when nothing waits for it any more. */
    answer(sid, permissionId, optionId) {
      const c = conns.get(sid);
      const resolve = c?.held.get(permissionId);
      if (!resolve) return false;
      c.held.delete(permissionId);
      resolve({ outcome: { outcome: 'selected', optionId } });
      return true;
    },
    pid: (sid) => conns.get(sid)?.child.pid ?? null,
    warm: (sid) => !!conns.get(sid) && !conns.get(sid).dead,
    /**
     * A prompt in a hidden extra session on a warm process of `agent` (e.g. /models without another cold start);
     * null when no process of that agent is warm.
     */
    async helperPrompt(agent, text, timeoutMs = 120000) {
      const c = [...conns.values()].find((x) => x.agent === agent && !x.dead && x.sessionId);
      if (!c) return null;
      const { sessionId } = await c.rpc.request('session/new', { cwd: c.cwd, mcpServers: c.mcp }, timeoutMs);
      const helper = { text: '' };
      c.helpers.set(sessionId, helper);
      try {
        await c.rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs);
        return helper.text;
      } finally {
        c.helpers.delete(sessionId);
      }
    },
    drop,
    close() {
      for (const sid of [...conns.keys()]) drop(sid);
    },
  };
}
