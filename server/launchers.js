/**
 * ============================================================================================
 *  AGENT LAUNCHERS — the ONLY file in the harness with knowledge of concrete agent CLIs.
 * ============================================================================================
 *
 *  A launcher turns one chat turn into an argv + env for a headless CLI run, writes the per-session
 *  config files the CLI needs, and normalizes the CLI's stdout (NDJSON, one object per line) into
 *  NormalizedEvent objects (see docs/ARCHITECTURE.md "Agent launchers"). runner.js spawns the
 *  process (never through a shell; the prompt is ONE argv element); sessions.js applies the events.
 *
 *  Shape:
 *    { id, defaults: { command, settingsEnv?, firstEventTimeoutMs },
 *      buildArgs(ctx) -> string[]       argv after the executable
 *      env(ctx) -> {}                    extra env vars (e.g. path of the per-session settings.json)
 *      prepare(ctx)                      write runs/<sid>/settings.json or mcp.json (idempotent, every turn)
 *      parse(obj, state) -> events[]     one parsed stdout line -> 0..n NormalizedEvents }
 *  ctx = { prompt, session, agentCfg, settingsPath, mcpConfigPath, harnessMcp, agentMcpServers }
 *
 *  HOW TO ADD A LAUNCHER: write an object of the shape above (reuse `geminiFamily(...)` if the CLI
 *  is a Gemini-CLI fork), add it to `launchers` at the bottom, then reference it from
 *  harness.config.json: "agents": { "<agentId>": { "launcher": "<launcherId>", "command": ... } }.
 *  `command` may be a string (looked up in PATH; Windows npm .cmd shims are unwrapped to
 *  `node <entry.js>`) or an argv array such as ["node", "C:/path/to/cli.js"].
 *
 *  GigaCode (target CLI, not installed on the dev machine) — VERIFY on the target machine:
 *   1. The env var that points the CLI at a settings file: agents.gigacode.settingsEnv in config
 *      (currently GIGACODE_CLI_SYSTEM_SETTINGS_PATH, a guess modeled on GEMINI_CLI_SYSTEM_SETTINGS_PATH).
 *      Check: run one turn, then confirm the `harness` MCP tools are visible to the agent.
 *   2. The stream-json event shapes. `test/fixtures/gigacode.stream.ndjson` holds the ASSUMED
 *      (Gemini-CLI style) shape. Replace it with a real capture:
 *        gigacode -p "list files, then say hi" --output-format stream-json --approval-mode yolo > test/fixtures/gigacode.stream.ndjson
 *      and fix `normalize()` + test/normalizer.test.js until the test passes. Lines the
 *      normalizer does not understand become `meta` events and are written to runs/<sid>/stderr.log.
 *   3. Approval mode names (agents.gigacode.approvalModes) and that `--resume <id>` takes the
 *      session id from the stream (requires settings `chatRecording: true`; the CLI finds the
 *      transcript by cwd, so cwd + settings path are frozen per session).
 *   4. How built-in sub-agents are disabled (put the CLI's tool-exclude setting into
 *      agents.gigacode.settings, e.g. { "tools": { "exclude": [...] } } — exact key unknown).
 * ============================================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ROOT, deepMerge, expandHome } from './config.js';
import { writeAtomic } from './store.js';

// ---------------------------------------------------------------------------------------------
// Tolerant stream-json normalizer: Gemini-CLI style and Claude-Code style (Qwen Code uses the latter).
// ---------------------------------------------------------------------------------------------

const asText = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

function contentText(c) {
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return asText(c);
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
      out.push({ type: 'result', text, isError });
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

function readUserMcp(file) {
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(expandHome(file), 'utf8')).mcpServers || {};
  } catch {
    return {};
  }
}

/** Gemini-CLI argv family: gigacode, qwen, gemini, mock. They differ only by defaults. */
function geminiFamily(id, defaults) {
  return {
    id,
    defaults,
    buildArgs({ prompt, session, agentCfg }) {
      const args = [];
      if (session.externalSessionId) args.push('--resume', session.externalSessionId);
      args.push('-p', argPrompt(prompt), '--output-format', 'stream-json');
      const mode = session.approvalMode || agentCfg.approvalMode;
      if (mode) args.push('--approval-mode', mode);
      const model = session.model || agentCfg.model;
      if (model) args.push('--model', model);
      return args;
    },
    env({ agentCfg, settingsPath }) {
      const name = agentCfg.settingsEnv || defaults.settingsEnv;
      return name ? { [name]: settingsPath } : {};
    },
    prepare({ agentCfg, settingsPath, harnessMcp, agentMcpServers }) {
      const settings = deepMerge({}, agentCfg.settings || {});
      settings.mcpServers = {
        ...readUserMcp(agentCfg.inheritUserMcpFrom),
        ...settings.mcpServers,
        ...agentMcpServers,
        harness: { ...harnessMcp, trust: true },
      };
      writeAtomic(settingsPath, JSON.stringify(settings, null, 2));
    },
    parse: normalize,
  };
}

const claude = {
  id: 'claude',
  defaults: { command: 'claude', firstEventTimeoutMs: 60000 },
  buildArgs({ prompt, session, agentCfg, mcpConfigPath }) {
    const args = ['-p', argPrompt(prompt), '--output-format', 'stream-json', '--verbose'];
    const mode = session.approvalMode || agentCfg.approvalMode;
    if (mode) args.push('--permission-mode', mode);
    const model = session.model || agentCfg.model;
    if (model) args.push('--model', model);
    if (session.externalSessionId) args.push('--resume', session.externalSessionId);
    // Variadic flags go last so they cannot swallow other arguments.
    args.push('--mcp-config', mcpConfigPath, '--disallowedTools', 'Task', 'Agent');
    return args;
  },
  env: () => ({}),
  prepare({ mcpConfigPath, harnessMcp, agentMcpServers }) {
    writeAtomic(mcpConfigPath, JSON.stringify({ mcpServers: { ...agentMcpServers, harness: harnessMcp } }, null, 2));
  },
  parse: normalize,
};

export const launchers = {
  gigacode: geminiFamily('gigacode', { command: 'gigacode', settingsEnv: 'GIGACODE_CLI_SYSTEM_SETTINGS_PATH', firstEventTimeoutMs: 30000 }),
  qwen: geminiFamily('qwen', { command: 'qwen', settingsEnv: 'QWEN_CODE_SYSTEM_SETTINGS_PATH', firstEventTimeoutMs: 30000 }),
  gemini: geminiFamily('gemini', { command: 'gemini', settingsEnv: 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', firstEventTimeoutMs: 30000 }),
  claude,
  mock: geminiFamily('mock', {
    command: [process.execPath, path.join(CODE_ROOT, 'scripts', 'mock-agent.js')],
    settingsEnv: 'MOCK_AGENT_SETTINGS_PATH',
    firstEventTimeoutMs: 15000,
  }),
};
