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
const ACP_INIT_TIMEOUT_MS = 120000;

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
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'ACP error'), { code: msg.error.code }));
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

/** harness + agentMcpServers in ACP shape: stdio { name, command, args, env: [{ name, value }] }, http { type, name, url, headers }. */
export function acpMcpServers(harnessMcp, agentMcpServers = {}) {
  const pairs = (obj) => Object.entries(obj || {}).map(([name, value]) => ({ name, value: String(value) }));
  return Object.entries({ ...agentMcpServers, harness: harnessMcp }).map(([name, d]) => (d.command
    ? { name, command: d.command, args: d.args || [], env: pairs(d.env) }
    : { type: 'http', name, url: d.url || d.httpUrl, headers: pairs(d.headers) }));
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

/** session/update -> the normalized events headless turns produce (plus 'plan'). Replays during session/load are skipped by the caller. */
export function acpEvents(update) {
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content?.type === 'text' ? [{ type: 'text', text: update.content.text, delta: true }] : [];
    case 'agent_thought_chunk':
      return update.content?.type === 'text' ? [{ type: 'thought', text: update.content.text, delta: true }] : [];
    case 'tool_call':
      return [{ type: 'tool_call', id: update.toolCallId, name: update.title || update.kind || 'tool', input: update.rawInput ?? null }];
    case 'tool_call_update':
      if (update.status !== 'completed' && update.status !== 'failed') return [];
      return [{ type: 'tool_result', id: update.toolCallId, output: textOf(update.content) || (update.rawOutput != null ? JSON.stringify(update.rawOutput) : ''), isError: update.status === 'failed' }];
    case 'plan':
      return [{ type: 'plan', text: `План:\n${(update.entries || []).map((e) => `${e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '…' : '·'} ${e.content}`).join('\n')}` }];
    default:
      return []; // user_message_chunk, available_commands_update, current_mode_update, ...
  }
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
      if (!c.turn && !c.held.size && !c.helpers?.size) drop(c.sid); // still idle: unload, the next message reloads
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
    const c = { sid: o.sid, agent: o.agent ?? null, cwd: o.cwd, mcp: acpMcpServers(o.ctx.harnessMcp, o.ctx.agentMcpServers), child, held: new Map(), helpers: new Map(), loading: false, turn: null, dead: false, errFile, sessionId: null };
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
        if (method !== 'session/update' || c.loading) return; // load replays the transcript we already have
        const helper = c.helpers.get(params.sessionId);
        if (helper) { // a hidden helper session (e.g. /models) on this warm process
          if (params.update?.sessionUpdate === 'agent_message_chunk' && params.update.content?.type === 'text') helper.text += params.update.content.text;
          return;
        }
        if (!c.turn) return;
        for (const ev of acpEvents(params.update)) c.turn.emit(ev);
      },
      async onRequest(method, params) {
        if (method === 'session/request_permission') {
          if (!c.turn) return { outcome: { outcome: 'cancelled' } };
          const id = `p_${randomBytes(4).toString('hex')}`;
          const answer = new Promise((resolve) => c.held.set(id, resolve));
          c.turn.emit({
            type: 'permission', id, toolId: params.toolCall?.toolCallId ?? null, tool: params.toolCall?.title || params.toolCall?.kind || 'tool',
            input: params.toolCall?.rawInput ?? null, options: (params.options || []).map((x) => ({ id: x.optionId, label: x.name, kind: x.kind })),
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
        c.rpc.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } }, o.initTimeoutMs || ACP_INIT_TIMEOUT_MS),
        exited.then(({ code }) => { throw new Error(`ACP-агент завершился при запуске (код ${code})`); }),
      ]);
      const mcpServers = acpMcpServers(o.ctx.harnessMcp, o.ctx.agentMcpServers);
      c.note = null;
      if (o.externalSessionId && init?.agentCapabilities?.loadSession) {
        c.loading = true;
        try {
          await c.rpc.request('session/load', { sessionId: o.externalSessionId, cwd: o.cwd, mcpServers });
          c.sessionId = o.externalSessionId;
        } catch (e) {
          c.note = `ACP: не удалось загрузить сессию агента (${e.message}) — начата новая, прежний контекст агенту недоступен.`;
        } finally {
          c.loading = false;
        }
      } else if (o.externalSessionId) {
        c.note = 'ACP: агент не умеет загружать сессии — начата новая, прежний контекст агенту недоступен.';
      }
      if (!c.sessionId) c.sessionId = (await c.rpc.request('session/new', { cwd: o.cwd, mcpServers })).sessionId;
      onWarm(o.sid, true);
    } catch (e) {
      drop(o.sid);
      throw Object.assign(e, { stderrTail: readTail(errFile) });
    }
    return c;
  }

  /**
   * One prompt as a turn; returns the same handle shape as runner.runTurn ({ pid, startedAt, stop, detach, done }).
   * o = { sid, launcher, ctx, command, cwd, env, logFile, roots, externalSessionId, prompt, onEvent, initTimeoutMs }
   */
  function turn(o) {
    const res = { code: null, signal: null, sawResult: false, timedOut: false, stopped: false, detached: false, error: null, stderrTail: '', eventCount: 0, priorOutput: false };
    let c = null;
    let stop = false;
    let settle;
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
        c.turn = { emit, roots: o.roots };
        if (c.sessionId) emit({ type: 'session', id: c.sessionId });
        if (c.note) {
          emit({ type: 'note', text: c.note });
          c.note = null;
        }
        if (stop) throw Object.assign(new Error('stopped'), { stopped: true });
        const r = await c.rpc.request('session/prompt', { sessionId: c.sessionId, prompt: [{ type: 'text', text: o.prompt }] });
        res.code = 0;
        res.sawResult = true;
        emit({ type: 'result', tokensIn: r?.usage?.inputTokens || 0, tokensOut: r?.usage?.outputTokens || 0 });
        if (r?.stopReason === 'cancelled') res.stopped = true;
        else if (r?.stopReason && !['end_turn', 'max_turn_requests'].includes(r.stopReason)) res.error = `Агент остановился: ${r.stopReason}`;
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
