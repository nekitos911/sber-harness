// Session manager: chat sessions (one CLI process per turn, queue of deliveries that wakes the session),
// terminal sessions (PTY), statuses, transcripts. Orchestration plugs in through hooks (preamble, turnEnded).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CODE_ROOT } from './config.js';
import { launchers } from './launchers.js';
import { runTurn } from './runner.js';
import { secretEnv } from './mcp-client.js';
import { readRegistry } from './registry.js';
import * as git from './git.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const newId = (prefix, bytes = 4) => `${prefix}_${randomBytes(bytes).toString('hex')}`;
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const insideDir = (dir, p) => { const r = path.relative(dir, p); return !r.startsWith('..') && !path.isAbsolute(r); };
const tail = (text) => (text ? `\n\nstderr:\n${text.slice(-2000).trim()}` : '');
const fence = (lines) => `\`\`\`text\n${lines.join('\n')}\n\`\`\``;
const REGISTRY_POLL_MS = 2000;

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
  if (!ptyModule) fail(501, `Terminals are unavailable: cannot load @lydell/node-pty (${ptyError})`);
  return ptyModule;
}

export function createSessions({ config, store, bus, getUrl }) {
  const db = store.db;
  const rt = new Map(); // sid -> runtime state (not persisted)
  const hooks = { preamble: () => '', turnEnded: () => {} };

  const find = (sid) => db.sessions.find((s) => s.id === sid);
  const get = (sid) => find(sid) || fail(404, `session ${sid} not found`);
  const runDir = (sid) => path.join(store.dataDir, 'runs', sid);
  const registryDir = (sid) => path.join(runDir(sid), 'registry');

  function runtime(sid) {
    if (!rt.has(sid)) {
      const turn = store.messages(sid).reduce((m, x) => Math.max(m, x.turn || 0), 0);
      rt.set(sid, { queue: [], running: false, handle: null, turn, flags: {}, cur: null, pty: null, previewAt: 0, registrySig: '' });
    }
    return rt.get(sid);
  }

  function emit(s) {
    store.save();
    bus.send({ t: 'session', session: s });
    return s;
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

  const harnessEnv = (s) => ({ HARNESS_URL: getUrl(), HARNESS_TOKEN: store.token, HARNESS_SESSION_ID: s.id });

  /** Agent config + launcher + executable for an agent id; throws 400 with a clear message (fail fast). */
  function resolveAgent(agent, launcherId) {
    const agentCfg = config.agents[agent] || fail(400, `unknown agent "${agent}"`);
    if (agentCfg.enabled === false) fail(400, `agent "${agent}" is disabled in the config`);
    if (launcherId && agentCfg.launcher !== launcherId) {
      fail(409, `agent "${agent}" now uses launcher "${agentCfg.launcher}" but this session was started with "${launcherId}"; a session never switches CLI, start a new chat`);
    }
    const launcher = launchers[agentCfg.launcher] || fail(400, `agent "${agent}" has unknown launcher "${agentCfg.launcher}"`);
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
      fail(400, `approval mode "${mode}" is not one of ${agentCfg.approvalModes.join(', ')}`);
    }
  }

  function turnCtx(s, agentCfg, prompt) {
    return {
      prompt,
      session: s,
      agentCfg,
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

  // ---- startup recovery ----
  for (const s of db.sessions) {
    s.queued = 0;
    s.pid = null;
    s.tokensIn ??= 0;
    s.tokensOut ??= 0;
    s.phase = null;
    if (s.kind === 'chat' && s.status === 'running') {
      s.status = 'idle';
      addMessage(s, { kind: 'system', text: 'harness restarted, the turn was interrupted; send a message to continue (context is kept by --resume)' });
    } else if (s.kind === 'terminal' && s.status !== 'exited') {
      s.status = 'exited';
      store.appendTermLog(s.id, '\r\n[harness restarted]\r\n');
    }
  }
  store.save();

  // ---- chat turns ----

  /** Built-in sub-agent activity (parent_tool_use_id) -> compact lines on the parent tool call, not the main chat. */
  function subagentProgress(s, c, ev) {
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
    if (s.phase !== 'streaming') {
      s.phase = 'streaming';
      emit(s);
    }
    if (ev.parentToolId) return subagentProgress(s, c, ev);
    if (ev.type !== 'raw') c.raw = null;
    switch (ev.type) {
      case 'init': {
        const mcp = ev.mcpServers.map((m) => `${m.name} ${/^connected$/i.test(m.status) ? '✓' : '✗'}`).join(', ');
        const note = [ev.model && `Model: ${ev.model}`, mcp && `MCP: ${mcp}`].filter(Boolean).join(' · ');
        // once per session (again only when it changes, e.g. an MCP server went down)
        if (note && !store.messages(s.id).some((m) => m.kind === 'system' && m.text === note)) addMessage(s, { kind: 'system', text: note });
        // what the CLI reported about itself, for GET /api/agents/:id/info (models seen accumulate, newest first)
        const prev = db.agentMeta[s.agent];
        db.agentMeta[s.agent] = {
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
      case 'tool_call':
        c.assistant = c.thought = null;
        c.tools.set(ev.id, addMessage(s, { kind: 'tool', text: ev.name, tool: { id: ev.id, name: ev.name, input: ev.input, output: null, status: 'running' } }));
        break;
      case 'tool_result': {
        c.assistant = c.thought = null;
        const m = c.tools.get(ev.id);
        const status = ev.isError ? 'error' : 'ok';
        if (m) {
          m.tool = { ...m.tool, output: ev.output, status };
          updateMessage(s, m);
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
        if (ev.isError) addMessage(s, { kind: 'error', text: ev.text || 'The agent reported an error' });
        else if (ev.text && !c.gotText) {
          addMessage(s, { kind: 'assistant', text: ev.text });
          s.preview = ev.text.slice(-200);
        }
        emit(s);
        break;
    }
  }

  async function startTurn(s) {
    const r = runtime(s.id);
    if (r.running || !r.queue.length) return;
    const items = r.queue.splice(0);
    r.running = true;
    r.turn += 1;
    r.flags = {};
    r.cur = { assistant: null, thought: null, raw: null, tools: new Map(), subTools: new Map(), gotText: false };
    for (const it of items) addMessage(s, { kind: 'user', text: it.text, from: it.from, ...(it.options ? { options: it.options } : {}) });
    Object.assign(s, { status: 'running', queued: 0, lastActivityAt: Date.now() });
    emit(s);

    let res;
    try {
      const { agentCfg, launcher, exe } = resolveAgent(s.agent, s.launcherId);
      checkMode(agentCfg, s.approvalMode || agentCfg.approvalMode);
      let prompt = items.map((i) => i.text).join('\n\n');
      if (!s.externalSessionId) {
        const pre = hooks.preamble(s);
        // a slash command only works as the first word of the prompt; the rest becomes its $ARGUMENTS
        if (pre) prompt = prompt.startsWith('/') ? `${prompt}\n\n${pre}` : `${pre}\n\n${prompt}`;
      }
      const ctx = turnCtx(s, agentCfg, prompt);
      fs.mkdirSync(runDir(s.id), { recursive: true });
      launcher.prepare(ctx);
      r.registryTimer = setInterval(() => pollRegistry(s), REGISTRY_POLL_MS);
      const handle = runTurn({
        launcher,
        ctx,
        command: exe,
        cwd: s.cwd,
        env: { ...process.env, ...agentCfg.env, ...secretEnv(config), ...exe.env, ...launcher.env(ctx), ...ctx.harnessMcp.env },
        firstEventTimeoutMs: agentCfg.firstEventTimeoutMs || launcher.defaults.firstEventTimeoutMs || 30000,
        logFile: path.join(runDir(s.id), 'stderr.log'),
        onEvent: (ev) => applyEvent(s, ev),
      });
      r.handle = handle;
      if (r.stopRequested) handle.stop();
      s.pid = handle.pid;
      s.phase = 'starting'; // spawned, no output yet (GigaCode may need a minute to start its MCP servers)
      emit(s);
      res = await handle.done;
    } catch (e) {
      res = { error: e.message };
    }
    finishTurn(s, res);
  }

  function finishTurn(s, res) {
    const r = runtime(s.id);
    clearInterval(r.registryTimer);
    r.running = false;
    r.handle = null;
    const stopped = res.stopped || r.stopRequested;
    r.stopRequested = false;
    if (!find(s.id)) return; // deleted while running
    pollRegistry(s);
    let status = r.flags.reported && (s.status === 'done' || s.status === 'failed') ? s.status : 'idle';
    if (stopped) {
      status = 'stopped'; // already set by stop(); a late exit never overwrites it
      addMessage(s, { kind: 'system', text: 'Stopped by user' });
    } else if (res.error) {
      addMessage(s, { kind: 'error', text: `${res.error}${tail(res.stderrTail)}` });
      status = 'error';
    } else if (res.timedOut) {
      const ms = config.agents[s.agent]?.firstEventTimeoutMs || launchers[s.launcherId]?.defaults.firstEventTimeoutMs;
      addMessage(s, { kind: 'error', text: `No output from the agent within ${Math.round(ms / 1000)} s; the process was killed.${tail(res.stderrTail)}` });
      status = 'error';
    } else if (!res.sawResult && res.code !== 0) {
      // a fatal CLI error leaves stdout empty and the whole story in stderr: lead with it
      const why = res.stderrTail.trim();
      addMessage(s, { kind: 'error', text: `The agent failed (exit code ${res.code}${res.signal ? `, ${res.signal}` : ''})${why ? `:\n${why.slice(-2000)}` : '.'}` });
      if (!res.eventCount) status = 'error';
    } else if (!res.eventCount) {
      // exit 0 without a single event: e.g. GigaCode's identity check fails silently (message only on stderr)
      addMessage(s, { kind: 'error', text: `The agent exited without any output.${tail(res.stderrTail)}` });
      status = 'error';
    } else if (res.stderrTail.trim()) {
      addMessage(s, { kind: 'system', text: `⚠ ${res.stderrTail.trim().slice(-2000)}` });
    }
    Object.assign(s, { status, pid: null, phase: null, lastActivityAt: Date.now() });
    emit(s);
    try {
      hooks.turnEnded(s, { ...r.flags, stopped, queueEmpty: r.queue.length === 0 });
    } catch (e) {
      console.error('[sessions] turnEnded hook failed:', e);
    }
    if (r.queue.length) startTurn(s);
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

  function spawnPty(s, pty) {
    const r = runtime(s.id);
    const p = pty.spawn(config.shell.command, config.shell.args, {
      name: 'xterm-256color',
      cols: r.cols || 120,
      rows: r.rows || 30,
      cwd: s.cwd,
      env: { ...process.env, ...secretEnv(config), ...agentEnv(s), ...harnessEnv(s) },
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
    if (s.command) p.write(`${s.command}\r`);
  }

  /** argv -> a command line for the configured shell (PowerShell needs `&` before a quoted path). */
  function shellLine(argv) {
    const shell = path.basename(config.shell.command).toLowerCase();
    if (/^(pwsh|powershell)/.test(shell)) return `& ${argv.map((a) => `'${a.replace(/'/g, "''")}'`).join(' ')}`;
    if (/^cmd(\.exe)?$/.test(shell)) return argv.map((a) => (/[\s&()^|<>]/.test(a) ? `"${a}"` : a)).join(' ');
    return argv.map((a) => (/^[\w./=:-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ');
  }

  /** Interactive CLI of an agent (no -p): the launcher's resolved executable + identity env. */
  function interactive(agentCfg) {
    let exe;
    try {
      exe = launchers[agentCfg.launcher]?.resolve(agentCfg);
    } catch (e) {
      fail(400, e.message);
    }
    if (!exe) return { command: null, env: {} };
    return { command: shellLine([exe.file, ...exe.args]), env: exe.env || {} };
  }

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
    subagents: (sid) => (get(sid), readRegistry(registryDir(sid), { idleWindowSec: config.session.idleWindowSec })),
    /** orchestration marks what happened during the current turn: 'reported' | 'communicated' */
    flag(sid, name) {
      runtime(sid).flags[name] = true;
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
      if (!['chat', 'terminal'].includes(kind)) fail(400, 'kind must be "chat" or "terminal"');
      const role = o.role || 'solo';
      if (!['solo', 'coordinator', 'worker'].includes(role)) fail(400, 'role must be solo, coordinator or worker');
      for (const k of ['agent', 'cwd', 'workspaceId', 'title', 'prompt', 'approvalMode', 'model', 'command', 'branch']) {
        if (o[k] != null && typeof o[k] !== 'string') fail(400, `${k} must be a string`);
      }
      const ws = o.workspaceId ? db.workspaces.find((w) => w.id === o.workspaceId) || fail(404, `workspace ${o.workspaceId} not found`) : null;
      const id = newId('s');
      let cwd = o.cwd || ws?.path ? path.resolve(o.cwd || ws.path) : null;
      if (cwd && !isDir(cwd)) fail(400, `cwd is not a directory: ${cwd}`);

      let agent = o.agent || null;
      let agentCfg = null;
      if (kind === 'chat' || (agent && agent !== 'shell')) {
        agent ||= config.defaultAgent;
        if (kind === 'chat') ({ agentCfg } = resolveAgent(agent));
        else {
          agentCfg = config.agents[agent] || fail(400, `unknown agent "${agent}"`);
          if (agentCfg.enabled === false) fail(400, `agent "${agent}" is disabled in the config`);
        }
        checkMode(agentCfg, o.approvalMode);
      }
      const pty = kind === 'terminal' ? await loadPty() : null;
      if (!cwd) {
        // a chat without a repository gets its own folder (survives restarts); terminals start in the harness root
        cwd = kind === 'chat' ? path.join(store.dataDir, 'chats', id) : config.root;
        fs.mkdirSync(cwd, { recursive: true });
      }

      const now = Date.now();
      const command = kind === 'terminal' ? o.command ?? (agentCfg ? interactive(agentCfg).command : null) : null;
      const s = {
        id,
        kind,
        title: o.title || (kind === 'chat' ? agentCfg.label || agent : command || path.basename(config.shell.command)),
        agent: kind === 'chat' ? agent : agent || 'shell',
        launcherId: kind === 'chat' ? agentCfg.launcher : null,
        cwd,
        workspaceId: ws?.id ?? db.workspaces.find((w) => insideDir(w.path, cwd))?.id ?? null,
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
        pid: null,
        tokensIn: 0,
        tokensOut: 0,
        phase: null,
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
          fail(500, `Cannot write the session settings (${s.settingsPath}): ${e.message}`);
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
          fail(500, `Cannot start terminal: ${e.message}`);
        }
      } else if (o.prompt) {
        api.deliver(id, { from: 'user', text: o.prompt });
      }
      return s;
    },

    /** Queue a message for a chat session (starts a turn if idle) or type it into a terminal. */
    deliver(sid, { from = 'user', text, options }) {
      const s = get(sid);
      if (typeof text !== 'string' || !text.trim()) fail(400, 'text is required');
      const r = runtime(sid);
      if (s.kind === 'terminal') {
        if (!r.pty) fail(409, 'terminal is not running');
        r.pty.write(`${text}\r`);
        return { queued: false };
      }
      r.queue.push({ from, text, options });
      if (!r.running) {
        startTurn(s);
        return { queued: false };
      }
      s.queued = r.queue.length;
      emit(s);
      return { queued: true };
    },

    stop(sid) {
      const s = get(sid);
      const r = runtime(sid);
      if (s.kind === 'terminal') {
        r.pty?.kill();
        return s;
      }
      r.queue = [];
      s.queued = 0;
      if (r.running) {
        r.stopRequested = true;
        r.handle?.stop();
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
        old?.kill();
        spawnPty(s, pty);
      } else if (!r.running) {
        s.status = 'idle';
        emit(s);
      }
      return s;
    },

    remove(sid) {
      const s = get(sid);
      const r = runtime(sid);
      r.queue = [];
      clearInterval(r.registryTimer);
      r.handle?.stop();
      const p = r.pty;
      r.pty = null;
      p?.kill();
      db.sessions = db.sessions.filter((x) => x.id !== sid);
      rt.delete(sid);
      store.removeSessionFiles(sid);
      // the process may still hold stderr.log for a moment; settings.json goes first
      for (const f of ['settings.json', 'mcp.json']) fs.rmSync(path.join(runDir(sid), f), { force: true });
      git.removeDir(runDir(sid));
      store.save();
      bus.send({ t: 'session.del', id: s.id });
    },

    patch(sid, p) {
      const s = get(sid);
      for (const k of ['title', 'approvalMode', 'model']) if (k in p && p[k] !== null && typeof p[k] !== 'string') fail(400, `${k} must be a string`);
      if ('autoReport' in p && typeof p.autoReport !== 'boolean') fail(400, 'autoReport must be a boolean');
      if (p.approvalMode && config.agents[s.agent]) checkMode(config.agents[s.agent], p.approvalMode);
      if (p.title?.trim()) s.title = p.title.trim();
      if ('approvalMode' in p) s.approvalMode = p.approvalMode || null;
      if ('model' in p) s.model = p.model || null;
      if ('autoReport' in p) s.autoReport = p.autoReport;
      return emit(s);
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

    close() {
      for (const r of rt.values()) {
        r.queue = [];
        clearInterval(r.registryTimer);
        r.handle?.stop();
        const p = r.pty;
        r.pty = null;
        try { p?.kill(); } catch {}
      }
    },
  };
  return api;
}
