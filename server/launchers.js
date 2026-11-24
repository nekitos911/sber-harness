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
 *     { chatRecording: true, mcpServers: { harness, ...agentMcpServers } }.
 *     Never `agents.modelGrades`/`allowedGrades`: the CLI validates those ids against its own catalogue and exits 1
 *     when one is missing; grades are the harness's own lookup (server/models.js).
 *     No `permissions` key: the allow-list travels as --allowed-tools. The CLI merges mcpServers from the run file
 *     with the user's ~/.gigacode/settings.json (verified live), same-name keys win; a `servers` key is ignored.
 *     agents.gigacode.inheritUserMcp additionally copies the user's servers into the run file (not needed for merging).
 *   - stream-json is Qwen-Code / Claude style (test/fixtures/gigacode.*.ndjson): system/init, assistant, user
 *     (tool results), stream_event (goal_state, ignored), result (usage = run total). Events with a non-null
 *     parent_tool_use_id belong to a built-in sub-agent and are tagged parentToolId (kept out of the main chat).
 * ============================================================================================
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODE_ROOT } from './config.js';
import { serverDefs } from './mcp-client.js';
import { writeAtomic } from './store.js';
import { locate, resolveCommand } from './runner.js';

// ---------------------------------------------------------------------------------------------
// Tolerant stream-json normalizer: Claude-Code / Qwen-Code style (GigaCode, claude) and Gemini-CLI style.
// ---------------------------------------------------------------------------------------------

const asText = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
const num = (v) => (Number.isFinite(v) ? v : 0);

const isEmptyInput = (v) => v == null || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

/**
 * A tool_use of GigaCode's ToolCall / ToolSearch wrappers as the harness shows it: `{ name, input }`. The wrapper only
 * means «call this tool»; the card is about the tool itself (`mcp__harness__agent`, `glob`), with its own arguments —
 * `input.toolName`/`input.tool_name` (or a server-qualified `input.description`, e.g. `agent (harness MCP Server)`),
 * `input.arguments`/`input.args`/`input.input`.
 */
export function unwrapToolCall(name, input) {
  const wrapper = String(name ?? '');
  if (!/^(tool_?call|tool_?search)$/i.test(wrapper)) return { name: wrapper || 'tool', input: input ?? null };
  const i = input && typeof input === 'object' ? input : {};
  const field = String(i.toolName ?? i.tool_name ?? i.name ?? i.tool ?? '').trim();
  const described = String(i.description ?? '').replace(/^(\S+) \(([^)]*) MCP Server\)$/i, (m, tool, server) => `${server}__${tool}`);
  const inner = field || described;
  if (!inner) return { name: wrapper, input: input ?? null };
  const args = i.arguments ?? i.args ?? i.input ?? null;
  return { name: /^tool_?search$/i.test(inner) ? 'tool_search' : inner, input: isEmptyInput(args) ? null : args };
}

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

/**
 * Context size after one model step, from that step's usage. OpenAI style (GigaCode/Qwen/Gemini: input_tokens already
 * contains the cached part): input + output; Anthropic style (claude: cache reported separately): input + cache_read +
 * cache_creation + output.
 */
export function contextUsage(u, anthropic = false) {
  const input = num(u.input_tokens ?? u.prompt_token_count);
  const output = num(u.output_tokens ?? u.candidates_token_count);
  const cacheRead = num(u.cache_read_input_tokens);
  const contextTokens = anthropic ? input + cacheRead + num(u.cache_creation_input_tokens) + output : input + output;
  return { type: 'usage', contextTokens, input, output, cacheRead };
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
        else if (b?.type === 'tool_use') {
          const call = unwrapToolCall(b.name, b.input);
          body.push({ type: 'tool_call', id: String(b.id ?? ''), name: call.name, input: call.input ?? {} });
        }
      }
      // the main agent's context after this step (a built-in sub-agent's steps are its own context)
      if (o.message?.usage && !o.parent_tool_use_id) body.push(contextUsage(o.message.usage, state.usageStyle === 'anthropic'));
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
    case 'tool_use': {
      const call = unwrapToolCall(o.tool_name ?? o.name, o.parameters ?? o.input);
      body.push({ type: 'tool_call', id: String(o.tool_id ?? o.id ?? ''), name: call.name, input: call.input ?? {} });
      break;
    }
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

/** Per-session settings.json for the Gemini-CLI family. Never contains the CLI's `permissions` block. */
/**
 * agents.<id>.mcpExclude under agents.<id>.mcpExcludeKey (default "excludeMCPServers", verified on the target
 * 2026-11-18: a one-shot run with it started no java-lsp and printed no MCP warning): servers the harness runs do not
 * start — GigaCode merges the user's settings.json, so a server missing from the run file still starts without it.
 */
function mcpExclusion(agentCfg, rest) {
  const list = (agentCfg.mcpExclude || []).filter((x) => x !== 'harness');
  if (!list.length) return {};
  const [head, ...tail] = (agentCfg.mcpExcludeKey || 'excludeMCPServers').split('.');
  if (!tail.length) return { [head]: list };
  const obj = { ...(rest[head] || {}) };
  let cur = obj;
  for (const k of tail.slice(0, -1)) cur = cur[k] = { ...(cur[k] || {}) };
  cur[tail.at(-1)] = list;
  return { [head]: obj };
}

/**
 * Servers the harness starts for an agent: config.agentMcpServers plus the enabled ones from mcpServersFrom
 * (~/.gigacode/settings.json), the way the CLI sees them; config.mcpDisabled (or the server's own enabled: false) removes
 * one. The names travel along as `name`: the run settings override the user's definition by name, and its arguments win.
 */
export function agentMcpServersFor(config) {
  const skip = new Set(config.mcpDisabled || []);
  const out = {};
  for (const [name, d] of Object.entries(serverDefs(config))) {
    if (name === 'harness' || skip.has(name) || !d.enabled) continue;
    const { name: _name, transport, url, enabled: _enabled, ...rest } = d;
    out[name] = { ...rest, name, ...(transport === 'http' ? { url } : {}) };
  }
  return { ...out, ...(config.agentMcpServers || {}) };
}

/** chatRecording false: the harness's own helper runs (model discovery, commit messages) leave no CLI chat record.
 * `harnessTimeoutMs` (mcp.harnessTimeoutMs) is how long the CLI waits for the harness server: `worker_run` waits for a
 * whole sub-agent run. */
export function sessionSettings({ agentCfg, harnessMcp, agentMcpServers, chatRecording = true, harnessTimeoutMs = 3600000 }) {
  // `agents` (modelGrades/allowedGrades) is the HARNESS's own grade table: the CLI would validate every id against
  // its account catalogue and refuse to start on a mismatch. The harness picks the sub-agent model itself.
  const { permissions: _own, agents: _grades, mcpServers, ...rest } = agentCfg.settings || {};
  // GigaCode merges `mcpServers` from the run file with the user's ~/.gigacode/settings.json; the same keys win, so the
  // harness entry is added on top. Never write a whole server list here: a `servers` sibling key is ignored by the CLI,
  // and `trust: true` on a stdio server denies every tool call headlessly.
  const harness = { ...harnessMcp };
  delete harness.trust;
  const exclusion = mcpExclusion(agentCfg, rest);
  return {
    ...rest,
    // opt-in: GigaCode allows a real `auto` only under an action sandbox (restricts tools to the workspace; VERIFY)
    ...(agentCfg.autoSandbox ? { tools: { ...rest.tools, sandbox: agentCfg.autoSandbox } } : {}),
    chatRecording,
    mcpServers: {
      ...(agentCfg.inheritUserMcp ? userMcpServers(agentCfg.userSettingsPath) : {}),
      ...agentMcpServers,
      harness: { ...harness, timeout: harnessTimeoutMs }, // worker_run waits for a whole sub-agent run
    },
    ...exclusion, // last: rest may already carry that top-level key (e.g. mcp.excluded) and must not win
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
 * The id the GigaCode CLI takes for `--model`: without the context suffix. `/models` and the CLI's own catalogue list
 * `DeepSeek-V4.1-Flash-1017-262k`, the backend knows the model as `DeepSeek-V4.1-Flash-1017`, and an id with the suffix
 * kills the process at start ("not present in the current backend catalogue") — headless turns and ACP alike.
 */
const cliModel = (defaults, model) => (model && defaults.stripModelSuffix ? String(model).replace(/-\d+[km]$/i, '') : model);

/**
 * The approval mode the CLI is given. GigaCode headless rejects `auto` without an action sandbox ("Auto approval is
 * allowed only under an active action sandbox"), so approvalModeMap (gigacode/qwen default { auto: 'auto-edit' })
 * maps it, unless agents.<id>.autoSandbox is set (then the run settings enable the sandbox and `auto` is kept).
 */
// routine commands never prompt (auto-edit/default turns; plan only reads) — users edit the list in Settings
export const DEFAULT_ALLOWED_TOOLS = ['git', 'mvn', 'mvnw', 'gradle', 'gradlew', 'npm', 'npx', 'node', 'java', 'python', 'py', 'pytest', 'dir', 'ls', 'type', 'cat', 'findstr', 'rg', 'where', 'echo']
  .map((c) => `run_shell_command(${c})`);

/** A read-only sub-agent (a «plan» profile, run as default because plan mode refuses the harness tools): looks, never changes. */
export const READ_ONLY_ALLOWED_TOOLS = ['git status', 'git diff', 'git log', 'git show', 'git branch', 'git ls-files', 'git rev-parse', 'git blame', 'dir', 'ls', 'type', 'cat', 'findstr', 'rg', 'where']
  .map((c) => `run_shell_command(${c})`); // VERIFY on the target: a «git status» pattern matches by prefix

export const FULL_ACCESS_MODES = ['auto', 'auto-full'];

/** The turn's allow-list: the agent's list (auto-edit/default turns) + the chat's + one-turn grants, deduplicated. */
function allowedList(defaults, { session, agentCfg }) {
  const mode = cliApprovalMode(defaults, agentCfg, session.approvalMode || agentCfg.approvalMode);
  const agentList = session.readOnly ? READ_ONLY_ALLOWED_TOOLS : agentCfg.allowedTools ?? defaults.allowedTools ?? [];
  // auto+sandbox needs none (the CLI asks nobody there), plan only reads. No `*` shorthand: whether GigaCode takes it is
  // unverified (docs/GIGACODE-FACTS.md, п. 13), and a list is what the CLI is known to accept.
  const base = ['auto-edit', 'default'].includes(mode) ? agentList : [];
  return [...new Set([...base, ...(session.allowedTools || []), ...(session.grantsOnce || [])])];
}

export function cliApprovalMode(defaults, agentCfg, mode) {
  const sandbox = agentCfg.autoSandbox === undefined ? defaults.autoSandbox : agentCfg.autoSandbox;
  if (!mode || (sandbox && mode === 'auto')) return mode;
  return (agentCfg.approvalModeMap ?? defaults.approvalModeMap ?? {})[mode] ?? mode;
}

/** The ACP process gets no sandbox (`tools.sandbox` is a run-file key), so a sandboxed `auto` must not become `auto-edit`. */
function acpApprovalMode(defaults, agentCfg, mode) {
  const unsandboxed = { ...defaults, autoSandbox: null };
  const unsandboxedAgent = { ...agentCfg, autoSandbox: null };
  return mode === 'auto' && cliApprovalMode(defaults, agentCfg, mode) !== 'auto'
    ? cliApprovalMode(unsandboxed, unsandboxedAgent, mode)
    : cliApprovalMode(defaults, agentCfg, mode);
}

function geminiFamily(id, defaults, resolve) {
  const base = {
    id,
    defaults,
    dirFlag: INCLUDE_FLAG,
    allowed: (ctx) => allowedList(defaults, ctx),
    /** what the CLI actually runs with this turn (session.effectiveApprovalMode) */
    effectiveMode: ({ session, agentCfg }) => cliApprovalMode(defaults, agentCfg, session.approvalMode || agentCfg.approvalMode) || null,
    expandCommand: (prompt, { cwd, agentCfg }) => expandCommand(prompt, { cwd, home: defaults.commandsHome ?? null, commandsDir: agentCfg.commandsDir ?? null }),
    resolve: resolve || ((agentCfg) => ({ ...resolveCommand(agentCfg.command || defaults.command), env: {} })),
    buildArgs({ prompt, session, agentCfg, extraArgs = [] }) {
      const args = [...extraArgs]; // a one-off helper run's quickArgs (e.g. --safe-mode)
      if (session.externalSessionId) args.push('--resume', session.externalSessionId);
      args.push('-p', argPrompt(prompt));
      const mode = cliApprovalMode(defaults, agentCfg, session.approvalMode || agentCfg.approvalMode);
      if (mode) args.push('--approval-mode', mode);
      args.push('--output-format', 'stream-json');
      // live thinking/text deltas (stream_event); off once the CLI rejected the flag (agentMeta.partialUnsupported)
      const partial = agentCfg.partialMessagesFlag === undefined ? defaults.partialMessagesFlag : agentCfg.partialMessagesFlag;
      if (partial) args.push(partial);
      const model = cliModel(defaults, session.model || agentCfg.model);
      if (model) args.push('--model', model);
      for (const dir of session.includeDirs || []) args.push(INCLUDE_FLAG, dir); // every turn: a new process
      // headless cannot ask: what the user allowed goes in as an allow-list (VERIFY flag/pattern syntax)
      const allowed = allowedList(defaults, { session, agentCfg });
      const flag = agentCfg.allowedToolsFlag ?? defaults.allowedToolsFlag;
      if (allowed.length && flag) {
        if ((agentCfg.allowedToolsJoin ?? 'repeat') === 'comma') args.push(flag, allowed.join(','));
        else for (const t of allowed) args.push(flag, t);
      }
      return args;
    },
    /** transport "acp": one long-lived process per session; the prompt goes over JSON-RPC, not argv. VERIFY GigaCode --acp. */
    acpArgs(ctx) {
      const { session, agentCfg } = ctx;
      const args = ['--acp'];
      const mode = acpApprovalMode(defaults, agentCfg, session.approvalMode || agentCfg.approvalMode);
      if (mode) args.push('--approval-mode', mode);
      // the session's own catalogue decides, not the argv (sessions.js fittingModel); when a checked id does go in, it
      // goes in the CLI's spelling — the catalogue lists «…-262k», the CLI takes «…» only
      const model = cliModel(defaults, ctx.acpModel ?? null);
      if (model) args.push('--model', model);
      for (const dir of session.includeDirs || []) args.push(INCLUDE_FLAG, dir);
      return args;
    },
    env({ agentCfg, settingsPath }) {
      const name = agentCfg.settingsEnv || defaults.settingsEnv;
      return name ? { [name]: settingsPath } : {};
    },
    envKeys: (ctx) => [ctx.agentCfg.settingsEnv || defaults.settingsEnv].filter(Boolean),
    prepare(ctx) {
      writeAtomic(ctx.settingsPath, JSON.stringify(sessionSettings(ctx), null, 2));
    },
    parse: normalize,
  };
  return base;
}

const claude = {
  id: 'claude',
  dirFlag: '--add-dir',
  defaults: { command: 'claude', firstEventTimeoutMs: 60000 },
  resolve: (agentCfg) => ({ ...resolveCommand(agentCfg.command || 'claude'), env: {} }),
  buildArgs({ prompt, session, agentCfg, mcpConfigPath, extraArgs = [] }) {
    const args = [...extraArgs, '-p', argPrompt(prompt), '--output-format', 'stream-json', '--verbose'];
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
  parse: (o, state = {}) => normalize(o, Object.assign(state, { usageStyle: 'anthropic' })),
};

/**
 * «/name args» the way the CLI's interactive mode sends it: the text of the command file — <cwd>/<home>/commands/<name>.md
 * (the project's own) first, then agents.<id>.commandsDir, then ~/<home>/commands — frontmatter dropped, {{args}} /
 * $ARGUMENTS replaced by the arguments; a command without them gets the arguments at its own «Задача:» line, or after the
 * text when it has no such line (VERIFY: GigaCode's own rule). «a:b» is <dir>/a/b.md. null = the CLI handles it itself: no
 * such file (a built-in command, a skill), a .toml one, or shell / file injections (!{…}, @{…}) the harness does not run.
 * → { name, file, text }
 */
export function expandCommand(prompt, { cwd, home = null, commandsDir = null }) {
  const m = /^\/([\w.:-]+)(?=\s|$)/.exec(prompt);
  if (!m) return null;
  const name = m[1];
  const args = prompt.slice(m[0].length).trim();
  const rel = `${name.split(':').join(path.sep)}.md`;
  // the project's own command first, then the agent's folder: a commandsDir set in the settings must not hide it
  const dirs = [cwd && home && path.join(cwd, home, 'commands'), commandsDir?.replace(/^~(?=[\\/]|$)/, os.homedir()), home && path.join(os.homedir(), home, 'commands')];
  const file = dirs.filter(Boolean).map((d) => path.join(d, rel)).find((f) => fs.existsSync(f));
  if (!file) return null;
  const body = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '');
  if (/!\{|@\{/.test(body)) return null;
  // {{args}} / $ARGUMENTS wherever they are; a command without them still has its own place for the task — the «Задача:»
  // line (full-task.md is 48 000 characters long: at the end the task would be the least visible part of it)
  const slot = /\{\{args\}\}|\$ARGUMENTS/g;
  const hasSlot = slot.test(body);
  const marked = !hasSlot && args ? body.replace(/^([ \t]*Задача:[ \t]*)(?:\r?\n|$)/m, (all, head) => `${head}\n${args}\n`) : null;
  const text = hasSlot ? body.replace(slot, () => args) : marked || (args ? `${body.trimEnd()}\n\n${prompt}` : body);
  return { name, file, text: text.replace(/^\s+|\s+$/gu, '') };
}

// A custom command reaches the model as text and the model loads it with the skill tool, first
// (test/fixtures/gigacode.slash.ndjson). The harness preamble behind it («find the harness tools first») once took that
// first step's place and the command never ran: this line goes between the command and the preamble.
const commandHint = (name) => `[harness] Это сообщение — команда /${name}. Если её инструкций ещё нет выше в твоём контексте, твой первый шаг — загрузить её инструментом skill ({"skill":"${name}"}) и дальше работать по ней. Справка харнеса ниже её не заменяет: инструменты harness ищи, когда они понадобятся.`;

const gigacodeLauncher = () => {
  const base = geminiFamily('gigacode', {
    quickArgs: ['--safe-mode'], compressCommand: '/compress', contextCommand: '/context', command: 'gigacode', settingsEnv: 'GIGACODE_SYSTEM_SETTINGS_PATH', firstEventTimeoutMs: 120000,
    continueArgs: ['-c'], approvalModeMap: { auto: 'auto-edit' }, allowedToolsFlag: '--allowed-tools', allowedTools: DEFAULT_ALLOWED_TOOLS, autoSandbox: null,
    partialMessagesFlag: null /* opt-in: on the target 2 of 3 tool calls then came without arguments (VERIFY) */, stripModelSuffix: true,
    // process env after the settings file: an agent gets its own data folder (extension store, secrets) under the run
    // folder. Two GigaCode processes on one ~/.gigacode lock each other out («store is busy», «protected storage is
    // unavailable») — the second one used to start anyway and lost its MCP servers. QWEN_HOME is the one the CLI reads.
    env: (ctx) => ({
      ...(ctx.agentCfg.settingsEnv || 'GIGACODE_SYSTEM_SETTINGS_PATH' ? { [ctx.agentCfg.settingsEnv || 'GIGACODE_SYSTEM_SETTINGS_PATH']: ctx.settingsPath } : {}),
      QWEN_HOME: path.join(path.dirname(ctx.settingsPath), 'home'),
    }),
    envKeys: () => ['GIGACODE_SYSTEM_SETTINGS_PATH', 'QWEN_HOME'],
    // an outside env may carry the agent's store of the harness itself (a test run, an agent terminal): the launcher's
    // own choice has to win over that leftover
    // its MCP tools are deferred: a call by a guessed name («harness_worker_done») is refused until tool_search registers them
    toolsHint: 'Инструменты harness здесь отложенные: перед первым вызовом найди их через tool_search по слову «harness»; точные имена — mcp__harness__worker_done, mcp__harness__ask, mcp__harness__agent, mcp__harness__send_message.', commandHint,
    commandsHome: '.gigacode',
  }, (cfg) => resolveGigacode(cfg));
  // a family launcher already has env/envKeys of its own: these replace them
  const own = { env: base.defaults.env, envKeys: base.defaults.envKeys };
  return Object.assign(base, own);
};

export const launchers = {
  // cold start (hundreds of tools, ~9 MCP servers) can take 30-60 s before system/init
  // quickArgs: one-off helper runs (commit/PR messages) start without MCP/skills/hooks (VERIFY --safe-mode on the target)
  gigacode: gigacodeLauncher(),
  qwen: geminiFamily('qwen', { command: 'qwen', settingsEnv: 'QWEN_CODE_SYSTEM_SETTINGS_PATH', firstEventTimeoutMs: 30000, approvalModeMap: { auto: 'auto-edit' }, allowedToolsFlag: '--allowed-tools', allowedTools: DEFAULT_ALLOWED_TOOLS }),
  gemini: geminiFamily('gemini', { command: 'gemini', settingsEnv: 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', firstEventTimeoutMs: 30000 }),
  claude,
  mock: geminiFamily('mock', {
    command: [process.execPath, path.join(CODE_ROOT, 'scripts', 'mock-agent.js')],
    settingsEnv: 'MOCK_AGENT_SETTINGS_PATH',
    firstEventTimeoutMs: 15000,
    contextCommand: '/context', // answers with a fixed breakdown, like GigaCode
    allowedToolsFlag: '--allowed-tools', // the mock behaves like GigaCode
    commandHint,
  }),
};
