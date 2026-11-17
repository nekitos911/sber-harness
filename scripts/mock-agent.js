#!/usr/bin/env node
// Fake GigaCode-like CLI for tests and demos. Emits Gemini-style stream-json on stdout.
//   mock-agent.js [--resume <id>] -p <prompt> --approval-mode <m> --output-format stream-json [--model <id>]  (GigaCode argv)
// Prompt directives (ignored in messages delivered from other sessions, i.e. prompts starting "[harness] Message from"):
//   #spawn <spec>   worker_start({ spec })          #done <summary>  worker_done(done)   #fail  worker_done(failed)
//   #ask <q> | <option> | ...   ask({ question, options })   #crash  exit 1 with stderr   #silent  sleep, no output
//   #slow           stream slowly for ~5 s          #raw   print two non-JSON lines
//   #nooutput       stderr only, exit 0 (silent failure)   #warn  stderr warning on a normal run
//   #auth           login link on stderr, ~2 s wait, then a normal run
//   #run <profile> <spec>   worker_run (a sub-agent in its own chat); waits, then says "worker_run result: <summary>"
//   #deny <tool>    a tool call the CLI denies in headless mode   #question <q> | <option> | ...   its own question tool
// "/models" answers with test/fixtures/gigacode.models.txt; --model outside that list fails like GigaCode (stderr, exit 1).
// MOCK_AGENT_ARGV_FILE: appends { argv (incl. node flags), env (GIGACODE_*, settings path, MCP_SECRET_*) } per run.
// Harness API through mcp/harness-mcp.js (env HARNESS_*; retries while the harness restarts). Turn counts per session id live in
// MOCK_AGENT_STATE_DIR (default <tmp>/harness-mock-agent), so --resume answers "resumed <id>, turn N".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { api, runAndWait } from '../mcp/harness-mcp.js';

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
// the backend catalogue, as GigaCode's /models prints it (shared with the parser test)
const MODELS_FILE = process.env.MOCK_AGENT_MODELS_FILE || new URL('../test/fixtures/gigacode.models.txt', import.meta.url);
let modelsText = '| ID | context |\n|----|---------|\n| Mock-Model-1-128k | 128k |\n';
try { modelsText = fs.readFileSync(MODELS_FILE, 'utf8'); } catch {}
const catalogue = [...modelsText.matchAll(/^\|\s*([A-Za-z0-9][\w.-]*-[\w.-]*)\s*\|/gm)].map((m) => m[1]);
const model = opt('--model') || catalogue[0] || 'mock-model';
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

if (opt('--model') && catalogue.length && !catalogue.includes(model)) {
  // GigaCode's fatal error for a renamed/removed model: nothing on stdout, exit 1
  process.stderr.write(`An unexpected critical error occurred:\nError: The selected model '${model}' is not present in the current backend catalogue\n`);
  process.exit(1);
}
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
if (prompt === '/models') {
  emit({ type: 'message', role: 'assistant', content: modelsText, delta: true });
  emit({ type: 'result', status: 'success', result: modelsText, stats: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
}

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
    const data = await api('POST', `/api/agent/${tool}`, args);
    emit({ type: 'tool_result', tool_id: id, status: 'success', output: JSON.stringify(data) });
    return true;
  } catch (e) {
    emit({ type: 'tool_result', tool_id: id, status: 'error', output: e.message });
    return false;
  }
}

await say(resume ? `resumed ${sessionId}, turn ${turn}. ` : `Hello from mock agent, turn ${turn}. `);
emit({ type: 'tool_use', tool_name: 'read_file', tool_id: 'fake_1', parameters: { path: 'README.md' } });
emit({ type: 'tool_result', tool_id: 'fake_1', status: 'success', output: '# fake file content' });
if (has(/#subagent\b/)) {
  // a built-in sub-agent (GigaCode `agent` tool): replay the reconstructed capture (its own session id and result dropped)
  const capture = new URL('../test/fixtures/gigacode.subagent.ndjson', import.meta.url);
  for (const line of fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean)) {
    const { session_id, uuid, ...ev } = JSON.parse(line);
    if (ev.type !== 'result') emit(ev);
  }
}

if (delivered) await say(`Received: ${prompt.split('\n')[1]?.slice(0, 120) || ''}`);
if (has(/#bigoutput\b/)) {
  emit({ type: 'tool_use', tool_name: 'run_shell_command', tool_id: 'big_1', parameters: { command: 'cat big.log' } });
  emit({ type: 'tool_result', tool_id: 'big_1', status: 'success', output: `${'строка лога\n'.repeat(10000)}КОНЕЦ` });
}
const deny = lines.map((l) => l.match(/#deny\s+(\S+)/)).filter(Boolean).pop();
if (deny) {
  // headless -p cannot ask for a confirmation: the CLI denies the call
  emit({ type: 'tool_use', tool_name: deny[1], tool_id: 'deny_1', parameters: { command: 'rm -rf build' } });
  emit({ type: 'tool_result', tool_id: 'deny_1', status: 'error', output: `Tool "${deny[1]}" requires user approval in non-interactive mode (approval mode ${opt('--approval-mode')})` });
}
const question = lines.map((l) => l.match(/#question\s+(.+)/)).filter(Boolean).pop();
if (question) {
  const [q, ...options] = question[1].split('|').map((x) => x.trim());
  emit({ type: 'tool_use', tool_name: 'ask_user_question', tool_id: 'q_1', parameters: { questions: [{ question: q, options: options.map((label) => ({ label })), multiSelect: false }] } });
  emit({ type: 'tool_result', tool_id: 'q_1', status: 'error', output: 'question tool is not available in non-interactive mode' });
}
if (has(/#raw\b/)) process.stdout.write('plain line 1\nplain line 2\n');
if (has(/#slow\b/)) await say('slow '.repeat(20), 250);

const rest = [];
async function runSubagent(profile, spec) {
  // exactly what the harness MCP bridge does for worker_run: start, then long-poll (across harness restarts)
  const id = `run_${++toolSeq}`;
  emit({ type: 'tool_use', tool_name: 'harness.worker_run', tool_id: id, parameters: { profile, spec } });
  try {
    const r = await runAndWait('worker_run', { profile, spec });
    emit({ type: 'tool_result', tool_id: id, status: 'success', output: JSON.stringify(r) });
    return say(` worker_run result: ${r.summary}`);
  } catch (e) {
    emit({ type: 'tool_result', tool_id: id, status: 'error', output: e.message });
    return say(` worker_run failed: ${e.message}`);
  }
}

for (const l of lines) {
  const m = l.match(/#spawn\s+(.+)/);
  const run = l.match(/#run\s+(\S+)\s+(.+)/);
  if (m) await harness('worker_start', { spec: m[1].trim() });
  else if (run) await runSubagent(run[1], run[2].trim());
  else rest.push(l);
}
const restText = rest.join('\n');
// the last occurrence wins: a worker preamble echoes the task title before the prompt itself
const last = (re) => [...restText.matchAll(re)].pop();
const ask = last(/#ask\s+([^\n]+)/g);
const done = last(/#done\b([^\n]*)/g);
// harness review loop: a reviewer answers by round (approve from round M on); a worker "fixes" findings and reports again
const review = last(/#reviewer round=(\d+) approve-at=(\d+)/g);
if (review) {
  const approved = Number(review[1]) >= Number(review[2]);
  await harness('worker_done', {
    status: 'done',
    summary: approved ? 'Замечаний нет.\nVERDICT: APPROVED' : `HIGH: нет проверки на null (раунд ${review[1]}).\nVERDICT: CHANGES_REQUESTED`,
  });
} else if (/снова вызови worker_done/.test(restText)) {
  await harness('worker_done', { summary: 'исправлено по замечаниям ревью', status: 'done' });
} else if (ask) {
  const [question, ...options] = ask[1].split('|').map((x) => x.trim());
  await harness('ask', { question, ...(options.length ? { options } : {}) });
}
else if (/#fail\b/.test(restText)) await harness('worker_done', { summary: 'mock failure', status: 'failed' });
else if (done) await harness('worker_done', { summary: done[1].trim() || 'completed', status: 'done' });

await say(' Done.');
emit({ type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 5, tool_calls: toolSeq + 1 } });
// GigaCode lingers after result (MCP servers shutting down, chat recording, telemetry)
if (has(/#linger\b/)) await sleep(20000);
