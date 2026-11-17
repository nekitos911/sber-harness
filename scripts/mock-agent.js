#!/usr/bin/env node
// Fake GigaCode-like CLI for tests and demos. Emits Gemini-style stream-json on stdout.
//   mock-agent.js [--resume <id>] -p <prompt> --approval-mode <m> --output-format stream-json [--model <id>]  (GigaCode argv)
// Prompt directives (ignored in messages delivered from other sessions, i.e. prompts starting "[harness] Message from"):
//   #spawn <spec>   worker_start({ spec })          #done <summary>  worker_done(done)   #fail  worker_done(failed)
//   #ask <q> | <option> | ...   ask({ question, options })   #crash  exit 1 with stderr   #silent  sleep, no output
//   #slow           stream slowly for ~5 s          #raw   print two non-JSON lines
//   #nooutput       stderr only, exit 0 (silent failure)   #warn  stderr warning on a normal run
//   #auth           login link on stderr, ~2 s wait, then a normal run
// MOCK_AGENT_ARGV_FILE: appends { argv (incl. node flags), env (GIGACODE_*, settings path, MCP_SECRET_*) } per run.
// Harness API from env: HARNESS_URL, HARNESS_TOKEN, HARNESS_SESSION_ID. Turn counts per session id live in
// MOCK_AGENT_STATE_DIR (default <tmp>/harness-mock-agent), so --resume answers "resumed <id>, turn N".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const opt = (...names) => {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i >= 0) return argv[i + 1];
  }
  return undefined;
};
const prompt = (opt('-p', '--prompt') ?? '').trim();
const resume = opt('--resume');
const model = opt('--model') || 'mock-model';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => process.stdout.write(`${JSON.stringify({ ...o, timestamp: new Date().toISOString() })}\n`);

// tests: record exactly what the harness passed (argv, settings/identity env), like a real GigaCode run would see it
if (process.env.MOCK_AGENT_ARGV_FILE) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(GIGACODE_|MOCK_AGENT_SETTINGS|MCP_SECRET_|HARNESS_SESSION_ID)/.test(k)));
  fs.appendFileSync(process.env.MOCK_AGENT_ARGV_FILE, `${JSON.stringify({ argv: [...process.execArgv, ...process.argv.slice(1)], env })}\n`);
}

const delivered = prompt.startsWith('[harness] Message from');
const lines = delivered ? [] : prompt.split(/\r?\n/);
const has = (re) => lines.some((l) => re.test(l));

if (has(/#crash\b/)) {
  process.stderr.write('mock-agent: simulated crash (#crash)\n');
  process.exit(1);
}
if (has(/#nooutput\b/)) {
  // what GigaCode does when the package identity env is missing: stderr only, exit 0, no stdout
  process.stderr.write('GigaCode launcher error: the public launcher and standalone payload identities do not match\n');
  process.exit(0);
}
if (has(/#warn\b/)) process.stderr.write('Warning: MCP server(s) failed to start: java-lsp. Continuing with built-in tools\n');
if (has(/#auth\b/)) {
  // first run on a machine: the CLI asks for a browser login, waits, then starts normally
  process.stderr.write('Please open https://auth.example/device?code=ABCD-EFGH to sign in\n');
  await sleep(2000);
}
if (has(/#silent\b/)) {
  await sleep(120000);
  process.exit(0);
}

const stateDir = process.env.MOCK_AGENT_STATE_DIR || path.join(os.tmpdir(), 'harness-mock-agent');
fs.mkdirSync(stateDir, { recursive: true });
const sessionId = resume || randomUUID();
const stateFile = path.join(stateDir, `${sessionId.replace(/[^\w-]/g, '_')}.json`);
let turn = 1;
try { turn = JSON.parse(fs.readFileSync(stateFile, 'utf8')).turns + 1; } catch {}
fs.writeFileSync(stateFile, JSON.stringify({ turns: turn }));

let mcpServers = [];
const settingsFile = process.env.MOCK_AGENT_SETTINGS_PATH || process.env.GIGACODE_SYSTEM_SETTINGS_PATH;
try { mcpServers = Object.keys(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).mcpServers || {}); } catch {}

emit({ type: 'init', session_id: sessionId, model });
// GigaCode's real init (Qwen-Code style): what the harness records as the agent's "seen" info
emit({
  type: 'system', subtype: 'init', session_id: sessionId, model,
  mcp_servers: mcpServers.map((name) => ({ name, status: 'connected' })),
  slash_commands: ['clear', 'full-task'], agents: ['general-purpose'], qwen_code_version: 'mock-1.0',
});
emit({ type: 'message', role: 'user', content: prompt });

async function say(text, delayMs = 0) {
  for (const chunk of text.match(/\S+\s*/g) || [text]) {
    emit({ type: 'message', role: 'assistant', content: chunk, delta: true });
    if (delayMs) await sleep(delayMs);
  }
}

let toolSeq = 0;
async function harness(tool, args) {
  const id = `call_${++toolSeq}`;
  emit({ type: 'tool_use', tool_name: `harness.${tool}`, tool_id: id, parameters: args });
  try {
    const res = await fetch(`${process.env.HARNESS_URL}/api/agent/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-harness-token': process.env.HARNESS_TOKEN || '', 'x-harness-session': process.env.HARNESS_SESSION_ID || '' },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    emit({ type: 'tool_result', tool_id: id, status: res.ok ? 'success' : 'error', output: text });
    return res.ok;
  } catch (e) {
    emit({ type: 'tool_result', tool_id: id, status: 'error', output: e.message });
    return false;
  }
}

await say(resume ? `resumed ${sessionId}, turn ${turn}. ` : `Hello from mock agent, turn ${turn}. `);
emit({ type: 'tool_use', tool_name: 'read_file', tool_id: 'fake_1', parameters: { path: 'README.md' } });
emit({ type: 'tool_result', tool_id: 'fake_1', status: 'success', output: '# fake file content' });
if (has(/#subagent\b/)) {
  // a built-in sub-agent (GigaCode `agent` tool), Claude/Qwen-style events tagged with parent_tool_use_id
  const p = 'call_agent_1';
  emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: p, name: 'agent', input: { subagent_type: 'java-reviewer' } }] } });
  emit({ type: 'assistant', parent_tool_use_id: p, message: { content: [{ type: 'text', text: 'Reviewing…' }, { type: 'tool_use', id: 'sub_grep', name: 'grep_search', input: { pattern: 'TODO' } }] } });
  emit({ type: 'user', parent_tool_use_id: p, message: { content: [{ type: 'tool_result', tool_use_id: 'sub_grep', is_error: false, content: 'no matches' }] } });
  emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: p, is_error: false, content: 'APPROVED' }] } });
}

if (delivered) await say(`Received: ${prompt.split('\n')[1]?.slice(0, 120) || ''}`);
if (has(/#raw\b/)) process.stdout.write('plain line 1\nplain line 2\n');
if (has(/#slow\b/)) await say('slow '.repeat(20), 250);

const rest = [];
for (const l of lines) {
  const m = l.match(/#spawn\s+(.+)/);
  if (m) await harness('worker_start', { spec: m[1].trim() });
  else rest.push(l);
}
const restText = rest.join('\n');
// the last occurrence wins: a worker preamble echoes the task title before the prompt itself
const last = (re) => [...restText.matchAll(re)].pop();
const ask = last(/#ask\s+([^\n]+)/g);
const done = last(/#done\b([^\n]*)/g);
if (ask) {
  const [question, ...options] = ask[1].split('|').map((x) => x.trim());
  await harness('ask', { question, ...(options.length ? { options } : {}) });
}
else if (/#fail\b/.test(restText)) await harness('worker_done', { summary: 'mock failure', status: 'failed' });
else if (done) await harness('worker_done', { summary: done[1].trim() || 'completed', status: 'done' });

await say(' Done.');
emit({ type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 5, tool_calls: toolSeq + 1 } });
