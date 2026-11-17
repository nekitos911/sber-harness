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
 *      resolve?(agentCfg) -> { file, args, env }   executable (+ leading args, env); default: runner.resolveCommand
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
 *  GigaCode — facts from the target machine (docs/ARCHITECTURE.md "GigaCode launcher: known facts"):
 *   - command = the gigacode.cmd shim. It is resolved to <shimDir>/runtime/node/node.exe + <shimDir>/lib/cli-entry.js,
 *     else the js entry parsed from the shim text, else the explicit pair agents.gigacode.node + cliEntry.
 *   - cli-entry.js refuses to run unless env GIGACODE_PACKAGE_IDENTITY (64 hex, read from the shim's
 *     `set "GIGACODE_PACKAGE_IDENTITY=..."`) and GIGACODE_PACKAGE_LAUNCHER (the shim path) are set.
 *   - argv: [...nodeArgs, cliEntry, (--resume <id>)?, -p, <prompt>, --approval-mode, <mode>, --output-format, stream-json, (--model <m>)?]
 *   - settings: env GIGACODE_SYSTEM_SETTINGS_PATH -> runs/<sid>/settings.json =
 *     { agents: { modelGrades, allowedGrades }, chatRecording: true, mcpServers: { harness, ...agentMcpServers } }.
 *     Never `permissions` (the CLI layers this file over ~/.gigacode/settings.json, which owns them).
 *  STILL TO VERIFY on the target machine: the stream-json event shapes. test/fixtures/gigacode.stream.ndjson holds
 *  the ASSUMED (Gemini-CLI style) shape; replace it with a real capture
 *    gigacode -p "list files, then say hi" --approval-mode auto --output-format stream-json > test/fixtures/gigacode.stream.ndjson
 *  and fix normalize() + test/normalizer.test.js until green. Lines the normalizer does not understand become
 *  `meta` events (written to runs/<sid>/stderr.log); non-JSON lines are shown in the chat as a system message.
 * ============================================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ROOT } from './config.js';
import { writeAtomic } from './store.js';
import { locate, shimJsEntry, resolveCommand } from './runner.js';

// ---------------------------------------------------------------------------------------------
// Tolerant stream-json normalizer: Gemini-CLI style and Claude-Code style (Qwen Code uses the latter).
// ---------------------------------------------------------------------------------------------

const asText = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
const num = (...vals) => vals.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);

function contentText(c) {
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return asText(c);
}

/** Token counts from a result event: Claude `usage`, Gemini `stats` (several spellings). */
function tokens(o) {
  const u = o.usage || o.stats || {};
  const tokensIn = num(u.input_tokens, u.input_token_count, u.prompt_token_count, u.cache_read_input_tokens, u.cache_creation_input_tokens);
  const tokensOut = num(u.output_tokens, u.output_token_count, u.candidates_token_count);
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
  switch (o.type) {
    // --- Gemini style ---
    case 'message':
      if (o.role === 'assistant' || o.role === 'model') {
        const text = contentText(o.content);
        if (text) out.push({ type: 'text', text, delta: o.delta === true });
      }
      break;
    case 'thought':
    case 'thinking': {
      const text = contentText(o.content ?? o.text ?? [o.subject, o.description].filter(Boolean).join(': '));
      if (text) out.push({ type: 'thought', text, delta: o.delta === true });
      break;
    }
    case 'tool_use':
      out.push({ type: 'tool_call', id: String(o.tool_id ?? o.id ?? ''), name: String(o.tool_name ?? o.name ?? 'tool'), input: o.parameters ?? o.input ?? {} });
      break;
    case 'tool_result':
      out.push({
        type: 'tool_result',
        id: String(o.tool_id ?? o.tool_use_id ?? ''),
        output: contentText(o.output ?? o.content ?? o.error?.message ?? ''),
        isError: o.status === 'error' || o.is_error === true,
      });
      break;
    case 'error':
      out.push({ type: 'error', text: asText(o.message ?? o.error?.message ?? o.error ?? 'error') });
      break;
    // --- Claude style ---
    case 'assistant': {
      const blocks = Array.isArray(o.message?.content) ? o.message.content : [{ type: 'text', text: contentText(o.message?.content) }];
      for (const b of blocks) {
        if (b?.type === 'text' && b.text && !state.streamedText) out.push({ type: 'text', text: b.text, delta: false });
        else if (b?.type === 'thinking' && b.thinking && !state.streamedText) out.push({ type: 'thought', text: b.thinking, delta: false });
        else if (b?.type === 'tool_use') out.push({ type: 'tool_call', id: String(b.id ?? ''), name: String(b.name ?? 'tool'), input: b.input ?? {} });
      }
      break;
    }
    case 'user':
      for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (b?.type === 'tool_result') out.push({ type: 'tool_result', id: String(b.tool_use_id ?? ''), output: contentText(b.content), isError: b.is_error === true });
      }
      break;
    case 'stream_event': {
      // Only present with --include-partial-messages; the full `assistant` event that follows is then skipped.
      const e = o.event || {};
      if (e.type === 'message_start') state.streamedText = false;
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        state.streamedText = true;
        out.push({ type: 'text', text: e.delta.text, delta: true });
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') {
        state.streamedText = true;
        out.push({ type: 'thought', text: e.delta.thinking, delta: true });
      }
      break;
    }
    // --- both ---
    case 'result': {
      const isError = o.is_error === true || o.status === 'error' || (typeof o.subtype === 'string' && o.subtype.startsWith('error'));
      const text = typeof o.result === 'string' ? o.result : typeof o.response === 'string' ? o.response : isError && o.error ? asText(o.error.message ?? o.error) : null;
      out.push({ type: 'result', text, isError, ...tokens(o) });
      break;
    }
  }
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

/** Per-session settings.json for the Gemini-CLI family. Never contains `permissions`. */
export function sessionSettings({ agentCfg, harnessMcp, agentMcpServers }) {
  const { permissions, agents, mcpServers, ...rest } = agentCfg.settings || {};
  return {
    ...rest,
    agents: { ...agents, modelGrades: agents?.modelGrades || {}, allowedGrades: agents?.allowedGrades || [] },
    chatRecording: true,
    mcpServers: { ...agentMcpServers, harness: { ...harnessMcp, trust: true } },
  };
}

export function shimIdentity(text) {
  return text.match(/set\s+"GIGACODE_PACKAGE_IDENTITY=([0-9a-f]{64})"/i)?.[1] || null;
}

/** gigacode.cmd shim -> bundled node + cli-entry.js + identity env (see header). Throws a 400 with a clear message. */
export function resolveGigacode(agentCfg, defaultCommand = 'gigacode') {
  const command = agentCfg.command || defaultCommand;
  const shim = typeof command === 'string' ? locate(command) : null;
  if (!shim) fail(`GigaCode launcher not found: ${JSON.stringify(command)}. Set agents.gigacode.command to the path of gigacode.cmd.`);
  const text = fs.readFileSync(shim, 'utf8');
  const identity = shimIdentity(text);
  if (!identity) fail(`GIGACODE_PACKAGE_IDENTITY not found in ${shim}; the CLI refuses to start without it. Point agents.gigacode.command at the gigacode.cmd shim.`);
  let node;
  let entry;
  if (agentCfg.node || agentCfg.cliEntry) {
    if (!agentCfg.node || !agentCfg.cliEntry) fail('agents.gigacode.node and agents.gigacode.cliEntry must be set together (or both null).');
    for (const k of ['node', 'cliEntry']) if (!exists(agentCfg[k])) fail(`agents.gigacode.${k} does not exist: ${agentCfg[k]}`);
    node = agentCfg.node;
    entry = agentCfg.cliEntry;
  } else {
    const dir = path.dirname(shim);
    const bundledNode = path.join(dir, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
    const bundledEntry = path.join(dir, 'lib', 'cli-entry.js');
    entry = exists(bundledEntry) ? bundledEntry : shimJsEntry(shim, text);
    node = exists(bundledNode) ? bundledNode : process.execPath;
    if (!exists(entry)) fail(`Cannot find the GigaCode cli entry next to ${shim} (expected ${bundledEntry}). Set agents.gigacode.node and cliEntry.`);
  }
  return {
    file: node,
    args: [...(agentCfg.nodeArgs || []), entry],
    env: { GIGACODE_PACKAGE_IDENTITY: identity, GIGACODE_PACKAGE_LAUNCHER: shim },
  };
}

/** Gemini-CLI argv family: gigacode, qwen, gemini, mock. They differ only by defaults (and gigacode's resolve). */
function geminiFamily(id, defaults, resolve) {
  return {
    id,
    defaults,
    resolve: resolve || ((agentCfg) => ({ ...resolveCommand(agentCfg.command || defaults.command), env: {} })),
    buildArgs({ prompt, session, agentCfg }) {
      const args = [];
      if (session.externalSessionId) args.push('--resume', session.externalSessionId);
      args.push('-p', argPrompt(prompt));
      const mode = session.approvalMode || agentCfg.approvalMode;
      if (mode) args.push('--approval-mode', mode);
      args.push('--output-format', 'stream-json');
      const model = session.model || agentCfg.model;
      if (model) args.push('--model', model);
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
  defaults: { command: 'claude', firstEventTimeoutMs: 60000 },
  resolve: (agentCfg) => ({ ...resolveCommand(agentCfg.command || 'claude'), env: {} }),
  buildArgs({ prompt, session, agentCfg, mcpConfigPath }) {
    const args = ['-p', argPrompt(prompt), '--output-format', 'stream-json', '--verbose'];
    const mode = session.approvalMode || agentCfg.approvalMode;
    if (mode) args.push('--permission-mode', mode);
    const model = session.model || agentCfg.model;
    if (model) args.push('--model', model);
    if (session.externalSessionId) args.push('--resume', session.externalSessionId);
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
  gigacode: geminiFamily('gigacode', { command: 'gigacode', settingsEnv: 'GIGACODE_SYSTEM_SETTINGS_PATH', firstEventTimeoutMs: 30000 }, (cfg) => resolveGigacode(cfg)),
  qwen: geminiFamily('qwen', { command: 'qwen', settingsEnv: 'QWEN_CODE_SYSTEM_SETTINGS_PATH', firstEventTimeoutMs: 30000 }),
  gemini: geminiFamily('gemini', { command: 'gemini', settingsEnv: 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', firstEventTimeoutMs: 30000 }),
  claude,
  mock: geminiFamily('mock', {
    command: [process.execPath, path.join(CODE_ROOT, 'scripts', 'mock-agent.js')],
    settingsEnv: 'MOCK_AGENT_SETTINGS_PATH',
    firstEventTimeoutMs: 15000,
  }),
};
