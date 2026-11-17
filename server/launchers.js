/**
 * ============================================================================================
 *  AGENT LAUNCHERS — the ONLY file in the harness with knowledge of concrete agent CLIs.
 * ============================================================================================
 *
 *  A launcher turns one chat turn into an executable + argv + env for a headless CLI run, writes the
 *  per-session config files the CLI needs, and normalizes the CLI's stdout (NDJSON, one object per line)
 *  into NormalizedEvent objects (docs/ARCHITECTURE.md "Agent launchers"). runner.js spawns the process
 *  (never through a shell; the prompt is ONE argv element); sessions.js applies the events.
 *
 *  Shape:
 *    { id, defaults: { command, settingsEnv?, firstEventTimeoutMs },
 *      resolve(agentCfg) -> { file, args, env }    executable (+ leading args, env)
 *      buildArgs(ctx) -> string[]                   argv after resolve().args
 *      env(ctx) -> {}                               extra env vars (e.g. path of the per-session settings.json)
 *      prepare(ctx)                                 write runs/<sid>/settings.json or mcp.json (idempotent, every turn)
 *      parse(obj, state) -> events[]                one parsed stdout line -> 0..n NormalizedEvents }
 *  ctx = { prompt, session, agentCfg, settingsPath, mcpConfigPath, harnessMcp, agentMcpServers }
 *  resolve() runs before anything is created (worktree, session) so a broken install fails fast.
 *
 *  HOW TO ADD A LAUNCHER: write an object of the shape above (reuse `geminiFamily(...)` for Gemini-CLI forks),
 *  add it to `launchers` at the bottom and reference it from the config:
 *  "agents": { "<agentId>": { "launcher": "<launcherId>", "command": ... } }.
 *
 *  GigaCode — facts from the target machine (docs/GIGACODE-FACTS.md):
 *   - command = the gigacode.cmd shim (ROOT\bin\gigacode.cmd). The shim sets ROOT=%~dp0.. and runs
 *     "%ROOT%\runtime\node\node.exe" --max-old-space-size=6144 "%ROOT%\lib\cli-entry.js" %*. The .cmd itself cannot
 *     be spawned honestly, so we run the bundled node + cli-entry directly: explicit agents.gigacode.node + cliEntry
 *     if set, else parsed from the shim text, else <shimDir>/../runtime/node/node.exe + <shimDir>/../lib/cli-entry.js,
 *     else the same under <shimDir>. Never the system node (it is too old for cli-entry).
 *   - cli-entry.js needs env GIGACODE_PACKAGE_IDENTITY (64 hex, from the shim's `set "GIGACODE_PACKAGE_IDENTITY=..."`)
 *     and GIGACODE_PACKAGE_LAUNCHER (the shim path); without them it prints to stderr and exits 0 with no stdout.
 *   - argv: [...nodeArgs, cliEntry, (--resume <id>)?, -p, <prompt>, --approval-mode, <mode>, --output-format, stream-json, (--model <m>)?]
 *   - settings: env GIGACODE_SYSTEM_SETTINGS_PATH -> runs/<sid>/settings.json =
 *     { agents: { modelGrades, allowedGrades }, chatRecording: true, mcpServers: { harness, ...agentMcpServers } }.
 *     Never `permissions`. agents.gigacode.inheritUserMcp copies ~/.gigacode/settings.json mcpServers in as well
 *     (whether the CLI merges or replaces mcpServers is unconfirmed).
 *   - stream-json is Qwen-Code / Claude style (test/fixtures/gigacode.*.ndjson): system/init, assistant, user
 *     (tool results), stream_event (goal_state, ignored), result (usage = run total). Events with a non-null
 *     parent_tool_use_id belong to a built-in sub-agent and are tagged parentToolId (kept out of the main chat).
 * ============================================================================================
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODE_ROOT } from './config.js';
import { writeAtomic } from './store.js';
import { locate, resolveCommand } from './runner.js';

// ---------------------------------------------------------------------------------------------
// Tolerant stream-json normalizer: Claude-Code / Qwen-Code style (GigaCode, claude) and Gemini-CLI style.
// ---------------------------------------------------------------------------------------------

const asText = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
const num = (v) => (Number.isFinite(v) ? v : 0);

function contentText(c) {
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return asText(c);
}

/** Token counts of a whole run, from the result event only (per-step assistant usage does not add up to it). */
function tokens(o) {
  const u = o.usage || o.stats;
  if (!u) return {};
  // Qwen/GigaCode report input_tokens including the cached part (total_tokens = in + out); Claude reports cache separately.
  const cache = u.total_tokens == null ? num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) : 0;
  const tokensIn = num(u.input_tokens ?? u.input_token_count ?? u.prompt_token_count) + cache;
  const tokensOut = num(u.output_tokens ?? u.output_token_count ?? u.candidates_token_count);
  return tokensIn || tokensOut ? { tokensIn, tokensOut } : {};
}

/** @returns {Array<object>} NormalizedEvents for one parsed stdout object. `state` lives for one turn. */
export function normalize(o, state = {}) {
  if (!o || typeof o !== 'object') return [{ type: 'meta', raw: o }];
  const out = [];
  const sid = o.session_id ?? o.sessionId;
  if (typeof sid === 'string' && sid && sid !== state.sessionId) {
    state.sessionId = sid;
    out.push({ type: 'session', id: sid });
  }
  const body = [];
  switch (o.type) {
    // --- Claude / Qwen style ---
    case 'system':
      if (o.subtype === 'init') {
        const strings = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x?.name)).filter((x) => typeof x === 'string') : []);
        body.push({
          type: 'init',
          model: o.model ?? null,
          slashCommands: strings(o.slash_commands),
          mcpServers: Array.isArray(o.mcp_servers) ? o.mcp_servers.map((s) => ({ name: String(s.name), status: String(s.status) })) : [],
          agents: strings(o.agents),
          version: o.qwen_code_version ?? o.claude_code_version ?? o.version ?? null,
        });
      }
      break;
    case 'assistant': {
      const blocks = Array.isArray(o.message?.content) ? o.message.content : [{ type: 'text', text: contentText(o.message?.content) }];
      for (const b of blocks) {
        if (b?.type === 'text' && b.text && !state.streamedText) body.push({ type: 'text', text: b.text, delta: false });
        else if (b?.type === 'thinking' && b.thinking && !state.streamedText) body.push({ type: 'thought', text: b.thinking, delta: false });
        else if (b?.type === 'tool_use') body.push({ type: 'tool_call', id: String(b.id ?? ''), name: String(b.name ?? 'tool'), input: b.input ?? {} });
      }
      break;
    }
    case 'user':
      for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (b?.type === 'tool_result') body.push({ type: 'tool_result', id: String(b.tool_use_id ?? ''), output: contentText(b.content), isError: b.is_error === true });
      }
      break;
    case 'stream_event': {
      // Claude --include-partial-messages deltas (the full `assistant` event that follows is then skipped);
      // anything else (GigaCode goal_state) is ignored.
      const e = o.event || {};
      if (e.type === 'message_start') state.streamedText = false;
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        state.streamedText = true;
        body.push({ type: 'text', text: e.delta.text, delta: true });
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') {
        state.streamedText = true;
        body.push({ type: 'thought', text: e.delta.thinking, delta: true });
      }
      return out.concat(body);
    }
    // --- Gemini style (its `init` only carries the session id, handled above) ---
    case 'message':
      if (o.role === 'assistant' || o.role === 'model') {
        const text = contentText(o.content);
        if (text) body.push({ type: 'text', text, delta: o.delta === true });
      }
      break;
    case 'thought':
    case 'thinking': {
      const text = contentText(o.content ?? o.text ?? [o.subject, o.description].filter(Boolean).join(': '));
      if (text) body.push({ type: 'thought', text, delta: o.delta === true });
      break;
    }
    case 'tool_use':
      body.push({ type: 'tool_call', id: String(o.tool_id ?? o.id ?? ''), name: String(o.tool_name ?? o.name ?? 'tool'), input: o.parameters ?? o.input ?? {} });
      break;
    case 'tool_result':
      body.push({
        type: 'tool_result',
        id: String(o.tool_id ?? o.tool_use_id ?? ''),
        output: contentText(o.output ?? o.content ?? o.error?.message ?? ''),
        isError: o.status === 'error' || o.is_error === true,
      });
      break;
    case 'error':
      body.push({ type: 'error', text: asText(o.message ?? o.error?.message ?? o.error ?? 'error') });
      break;
    // --- both ---
    case 'result': {
      const isError = o.is_error === true || o.status === 'error' || (typeof o.subtype === 'string' && o.subtype.startsWith('error'));
      const text = typeof o.result === 'string' ? o.result : typeof o.response === 'string' ? o.response : isError && o.error ? asText(o.error.message ?? o.error) : null;
      body.push({ type: 'result', text, isError, ...tokens(o) });
      break;
    }
  }
  // events of a built-in sub-agent (started by the tool call parent_tool_use_id) stay out of the main chat
  const parent = o.parent_tool_use_id;
  if (parent && o.type !== 'result') for (const ev of body) ev.parentToolId = String(parent);
  out.push(...body);
  if (!out.length) out.push({ type: 'meta', raw: o });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Launchers
// ---------------------------------------------------------------------------------------------

// yargs/commander would read a prompt starting with "-" as a flag.
const argPrompt = (p) => (p.startsWith('-') ? ` ${p}` : p);
const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
const exists = (p) => !!p && fs.existsSync(p);
const USER_SETTINGS = path.join(os.homedir(), '.gigacode', 'settings.json');

function userMcpServers(file = USER_SETTINGS) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).mcpServers || {};
  } catch {
    return {};
  }
}

/** Per-session settings.json for the Gemini-CLI family. Never contains `permissions`. */
export function sessionSettings({ agentCfg, harnessMcp, agentMcpServers }) {
  const { permissions, agents, mcpServers, ...rest } = agentCfg.settings || {};
  return {
    ...rest,
    // opt-in: GigaCode allows a real `auto` only under an action sandbox (restricts tools to the workspace; VERIFY)
    ...(agentCfg.autoSandbox ? { tools: { ...rest.tools, sandbox: agentCfg.autoSandbox } } : {}),
    agents: { ...agents, modelGrades: agents?.modelGrades || {}, allowedGrades: agents?.allowedGrades || [] },
    chatRecording: true,
    mcpServers: {
      ...(agentCfg.inheritUserMcp ? userMcpServers(agentCfg.userSettingsPath) : {}),
      ...agentMcpServers,
      harness: { ...harnessMcp, trust: true, timeout: 3600000 }, // worker_run waits for a whole sub-agent run
    },
  };
}

export function shimIdentity(text) {
  // gigacode.cmd: set "GIGACODE_PACKAGE_IDENTITY=..."; an sh shim: export GIGACODE_PACKAGE_IDENTITY=...
  return text.match(/(?:set\s+"?|export\s+|^\s*)GIGACODE_PACKAGE_IDENTITY=["']?([0-9a-f]{64})/im)?.[1] || null;
}

/**
 * sh shim fallback (POSIX, when the shim cannot be executed itself): ROOT=... (literal, or relative to "$0"),
 * then a line with "$ROOT/runtime/node/bin/node" "$ROOT/lib/cli-entry.js". VERIFY the real Linux layout.
 */
export function parseShShim(shimPath, text) {
  const vars = {};
  const expand = (s) => s.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, name) => vars[name] ?? m);
  let node = null;
  let entry = null;
  for (const line of text.split(/\r?\n/)) {
    const set = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)=(.*)$/);
    if (set) {
      const raw = set[2].trim().replace(/^["']|["']$/g, '');
      if (/\$0|\$\{0\}|BASH_SOURCE/.test(raw)) {
        // ROOT="$(cd "$(dirname "$0")/.." && pwd)" and friends: the shim's folder plus the ../ steps after it
        const ups = (raw.match(/\/\.\./g) || []).length;
        vars[set[1]] = path.resolve(path.dirname(shimPath), ...Array(ups).fill('..'));
      } else vars[set[1]] = expand(raw);
      continue;
    }
    const quoted = [...line.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => expand(m[1] ?? m[2]));
    const n = quoted.find((q) => /\/node$/.test(q));
    const e = quoted.find((q) => /\.[cm]?js$/i.test(q));
    if (n && e) {
      node = path.resolve(n);
      entry = path.resolve(e);
    }
  }
  return { node, entry };
}

/** agents.gigacode.command null = auto: the Windows install, else gigacode on PATH, else ~/.gigacode/bin/gigacode. */
export function gigacodeCommand(agentCfg, platform = process.platform, env = process.env) {
  if (agentCfg.command) return { command: agentCfg.command, reason: 'configured' };
  if (platform === 'win32') {
    const pf = 'C:/Program Files/.gigacode/bin/gigacode.cmd';
    if (fs.existsSync(pf)) return { command: pf, reason: 'auto: the default Windows install' };
    const found = locate('gigacode', env);
    return found ? { command: found, reason: 'auto: gigacode on PATH' } : { command: pf, reason: 'auto: the default Windows install (not found)' };
  }
  const found = locate('gigacode', env);
  if (found) return { command: found, reason: 'auto: gigacode on PATH' };
  const home = path.join(os.homedir(), '.gigacode', 'bin', 'gigacode');
  return { command: home, reason: `auto: ~/.gigacode/bin/gigacode${fs.existsSync(home) ? '' : ' (not found)'}` };
}

const executable = (file) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Bundled node + cli-entry referenced by a gigacode.cmd shim: `set "ROOT=%~dp0.."` + the quoted call line.
 * Expands %~dp0, %~f0 and variables set earlier in the shim. Returns absolute paths (not checked for existence).
 */
export function parseShim(shimPath, text) {
  const vars = { '~dp0': path.dirname(shimPath) + path.sep, '~f0': shimPath };
  const expand = (s) => s.replace(/%(~dp0|~f0)|%([A-Za-z_][\w]*)%/gi, (m, special, name) => {
    if (special) return vars[special.toLowerCase()];
    const key = Object.keys(vars).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? vars[key] : m;
  });
  let node = null;
  let entry = null;
  for (const line of text.split(/\r?\n/)) {
    const set = line.match(/^\s*set\s+"?([A-Za-z_][\w]*)=([^"]*)"?\s*$/i);
    if (set) {
      vars[set[1]] = expand(set[2]);
      continue;
    }
    const quoted = [...line.matchAll(/"([^"]+)"/g)].map((m) => expand(m[1]));
    const n = quoted.find((q) => /[\\/]node(\.exe)?$/i.test(q));
    const e = quoted.find((q) => /\.[cm]?js$/i.test(q));
    if (n && e) {
      // .cmd text uses backslashes; '/' is a separator on every platform, '\' only on Windows
      node = path.resolve(n.replace(/\\/g, '/'));
      entry = path.resolve(e.replace(/\\/g, '/'));
    }
  }
  return { node, entry };
}

/** gigacode.cmd shim -> bundled node + cli-entry.js + identity env (see header). Throws a 400 with a clear message. */
export function resolveGigacode(agentCfg) {
  const { command } = gigacodeCommand(agentCfg);
  const shim = typeof command === 'string' ? locate(command) : null;
  if (!shim) fail(`Лаунчер GigaCode не найден: ${JSON.stringify(command)}. Укажите agents.gigacode.command — путь к gigacode.cmd (Windows) или к исполняемому gigacode.`);
  const explicit = !!(agentCfg.node || agentCfg.cliEntry);
  if (process.platform !== 'win32' && !explicit && !/\.(cmd|bat)$/i.test(shim)) {
    // POSIX: the launcher sets its own identity env and exit codes are honest: run it as is, same argv
    if (executable(shim)) return { file: shim, args: [], env: {} };
    const text = fs.readFileSync(shim, 'utf8');
    const pair = parseShShim(shim, text);
    if (!exists(pair.node) || !exists(pair.entry)) fail(`${shim} не исполняемый, и его node + cli-entry.js не найдены; сделайте chmod +x или задайте agents.gigacode.node и cliEntry.`);
    const identity = shimIdentity(text);
    return { file: pair.node, args: [...(agentCfg.nodeArgs || []), pair.entry], env: identity ? { GIGACODE_PACKAGE_IDENTITY: identity, GIGACODE_PACKAGE_LAUNCHER: shim } : {} };
  }
  const text = fs.readFileSync(shim, 'utf8');
  const identity = shimIdentity(text);
  if (!identity) fail(`В ${shim} нет GIGACODE_PACKAGE_IDENTITY, без него CLI не запустится. Укажите в agents.gigacode.command путь к gigacode.cmd.`);
  let pair;
  if (agentCfg.node || agentCfg.cliEntry) {
    if (!agentCfg.node || !agentCfg.cliEntry) fail('agents.gigacode.node и agents.gigacode.cliEntry задаются вместе (или оба null).');
    for (const k of ['node', 'cliEntry']) if (!exists(agentCfg[k])) fail(`agents.gigacode.${k} не существует: ${agentCfg[k]}`);
    pair = { node: agentCfg.node, entry: agentCfg.cliEntry };
  } else {
    const dir = path.dirname(shim);
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
    const candidates = [
      parseShim(shim, text),
      { node: path.join(dir, '..', 'runtime', 'node', nodeName), entry: path.join(dir, '..', 'lib', 'cli-entry.js') },
      { node: path.join(dir, 'runtime', 'node', nodeName), entry: path.join(dir, 'lib', 'cli-entry.js') },
    ].map((c) => ({ node: c.node && path.resolve(c.node), entry: c.entry && path.resolve(c.entry) }));
    pair = candidates.find((c) => exists(c.node) && exists(c.entry));
    if (!pair) {
      fail(`Не найдены встроенные в GigaCode node и cli-entry.js для ${shim} (проверено: ${candidates.map((c) => c.node).filter(Boolean).join(', ')}). Задайте agents.gigacode.node и agents.gigacode.cliEntry.`);
    }
  }
  return {
    file: pair.node,
    args: [...(agentCfg.nodeArgs || []), pair.entry],
    env: { GIGACODE_PACKAGE_IDENTITY: identity, GIGACODE_PACKAGE_LAUNCHER: shim },
  };
}

/** Gemini-CLI argv family: gigacode, qwen, gemini, mock. They differ only by defaults (and gigacode's resolve). */
const INCLUDE_FLAG = '--include-directories'; // the headless form of the interactive /dir add

/**
 * The approval mode the CLI is given. GigaCode headless rejects `auto` without an action sandbox ("Auto approval is
 * allowed only under an active action sandbox"), so approvalModeMap (gigacode/qwen default { auto: 'auto-edit' })
 * maps it, unless agents.<id>.autoSandbox is set (then the run settings enable the sandbox and `auto` is kept).
 */
export function cliApprovalMode(defaults, agentCfg, mode) {
  if (!mode || (agentCfg.autoSandbox && mode === 'auto')) return mode;
  return (agentCfg.approvalModeMap ?? defaults.approvalModeMap ?? {})[mode] ?? mode;
}

function geminiFamily(id, defaults, resolve) {
  return {
    id,
    defaults,
    dirFlag: INCLUDE_FLAG,
    /** what the CLI actually runs with this turn (session.effectiveApprovalMode) */
    effectiveMode: ({ session, agentCfg }) => cliApprovalMode(defaults, agentCfg, session.approvalMode || agentCfg.approvalMode) || null,
    resolve: resolve || ((agentCfg) => ({ ...resolveCommand(agentCfg.command || defaults.command), env: {} })),
    buildArgs({ prompt, session, agentCfg }) {
      const args = [];
      if (session.externalSessionId) args.push('--resume', session.externalSessionId);
      args.push('-p', argPrompt(prompt));
      const mode = cliApprovalMode(defaults, agentCfg, session.approvalMode || agentCfg.approvalMode);
      if (mode) args.push('--approval-mode', mode);
      args.push('--output-format', 'stream-json');
      const model = session.model || agentCfg.model;
      if (model) args.push('--model', model);
      for (const dir of session.includeDirs || []) args.push(INCLUDE_FLAG, dir); // every turn: a new process
      // headless cannot ask: what the user allowed goes in as an allow-list (VERIFY flag/pattern syntax)
      const allowed = [...new Set([...(agentCfg.allowedTools || []), ...(session.allowedTools || []), ...(session.grantsOnce || [])])];
      const flag = agentCfg.allowedToolsFlag ?? defaults.allowedToolsFlag;
      if (allowed.length && flag) {
        if ((agentCfg.allowedToolsJoin ?? 'repeat') === 'comma') args.push(flag, allowed.join(','));
        else for (const t of allowed) args.push(flag, t);
      }
      return args;
    },
    /** transport "acp": one long-lived process per session; the prompt goes over JSON-RPC, not argv. VERIFY GigaCode --acp. */
    acpArgs({ session, agentCfg }) {
      const args = ['--acp'];
      const mode = cliApprovalMode(defaults, agentCfg, session.approvalMode || agentCfg.approvalMode);
      if (mode) args.push('--approval-mode', mode);
      const model = session.model || agentCfg.model;
      if (model) args.push('--model', model);
      for (const dir of session.includeDirs || []) args.push(INCLUDE_FLAG, dir);
      return args;
    },
    env({ agentCfg, settingsPath }) {
      const name = agentCfg.settingsEnv || defaults.settingsEnv;
      return name ? { [name]: settingsPath } : {};
    },
    prepare(ctx) {
      writeAtomic(ctx.settingsPath, JSON.stringify(sessionSettings(ctx), null, 2));
    },
    parse: normalize,
  };
}

const claude = {
  id: 'claude',
  dirFlag: '--add-dir',
  defaults: { command: 'claude', firstEventTimeoutMs: 60000 },
  resolve: (agentCfg) => ({ ...resolveCommand(agentCfg.command || 'claude'), env: {} }),
  buildArgs({ prompt, session, agentCfg, mcpConfigPath }) {
    const args = ['-p', argPrompt(prompt), '--output-format', 'stream-json', '--verbose'];
    const mode = session.approvalMode || agentCfg.approvalMode;
    if (mode) args.push('--permission-mode', mode);
    const model = session.model || agentCfg.model;
    if (model) args.push('--model', model);
    if (session.externalSessionId) args.push('--resume', session.externalSessionId);
    for (const dir of session.includeDirs || []) args.push('--add-dir', dir);
    // Variadic flags go last so they cannot swallow other arguments. Harness tools are pre-allowed:
    // in -p mode a tool that needs permission is simply denied.
    args.push('--mcp-config', mcpConfigPath, '--allowedTools', 'mcp__harness', '--disallowedTools', 'Task', 'Agent');
    return args;
  },
  env: () => ({}),
  prepare({ mcpConfigPath, harnessMcp, agentMcpServers }) {
    writeAtomic(mcpConfigPath, JSON.stringify({ mcpServers: { ...agentMcpServers, harness: harnessMcp } }, null, 2));
  },
  parse: normalize,
};

export const launchers = {
  // cold start (hundreds of tools, ~9 MCP servers) can take 30-60 s before system/init
  gigacode: geminiFamily('gigacode', { command: 'gigacode', settingsEnv: 'GIGACODE_SYSTEM_SETTINGS_PATH', firstEventTimeoutMs: 120000, continueArgs: ['-c'], approvalModeMap: { auto: 'auto-edit' }, allowedToolsFlag: '--allowed-tools' }, (cfg) => resolveGigacode(cfg)),
  qwen: geminiFamily('qwen', { command: 'qwen', settingsEnv: 'QWEN_CODE_SYSTEM_SETTINGS_PATH', firstEventTimeoutMs: 30000, approvalModeMap: { auto: 'auto-edit' }, allowedToolsFlag: '--allowed-tools' }),
  gemini: geminiFamily('gemini', { command: 'gemini', settingsEnv: 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', firstEventTimeoutMs: 30000 }),
  claude,
  mock: geminiFamily('mock', {
    command: [process.execPath, path.join(CODE_ROOT, 'scripts', 'mock-agent.js')],
    settingsEnv: 'MOCK_AGENT_SETTINGS_PATH',
    firstEventTimeoutMs: 15000,
    allowedToolsFlag: '--allowed-tools', // the mock behaves like GigaCode
  }),
};
