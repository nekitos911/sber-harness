#!/usr/bin/env node
// Fake GigaCode-like CLI for tests and demos. Emits Gemini-style stream-json on stdout.
//   mock-agent.js [--resume <id>] -p <prompt> --approval-mode <m> --output-format stream-json [--model <id>]  (GigaCode argv)
// Prompt directives (ignored in messages delivered from other sessions, i.e. prompts starting "[harness] Message from"):
//   #spawn <spec>   worker_start({ spec, task: true })          #done <summary>  worker_done(done)   #fail  worker_done(failed)
//   #ask <q> | <option> | ...   ask({ question, options })   #crash  exit 1 with stderr   #silent  sleep, no output
//   #slow           stream slowly for ~5 s          #raw   print two non-JSON lines
//   #nooutput       stderr only, exit 0 (silent failure)   #warn  stderr warning on a normal run
//   #auth [ms]      login link on stderr, a wait (default 2000 ms), then a normal run
//   #run <profile> <spec>   worker_run (a sub-agent in its own chat); waits, then says "worker_run result: <summary>"
//   #runwt <profile> <spec> the same in a new worktree (a persistent child)
//   #usage          an assistant step with usage   #deny <tool>    a tool call the CLI denies in headless mode   #question <q> | <option> | ...   its own question tool
// "/models" answers with test/fixtures/gigacode.models.txt; --model outside that list fails like GigaCode (stderr, exit 1).
// MOCK_AGENT_ARGV_FILE: appends { argv (incl. node flags), env (GIGACODE_*, settings path, MCP_SECRET_*) } per run.
// Harness API through mcp/harness-mcp.js (env HARNESS_*; retries while the harness restarts). Turn counts per session id live in
// MOCK_AGENT_STATE_DIR (default <tmp>/harness-mock-agent), so --resume answers "resumed <id>, turn N".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { api, askAndWait, runAndWait } from '../mcp/harness-mcp.js';

const argv = process.argv.slice(2);
const opt = (...names) => {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i >= 0) return argv[i + 1];
  }
  return undefined;
};
let prompt = (opt('-p', '--prompt') ?? '').trim();
const fileRef = prompt.match(/^Полный текст сообщения: (.+)$/m);
if (fileRef) {
  // a long message comes as a file; like GigaCode's read_file, only the workspace dirs (cwd + --include-directories) are readable
  const dirs = [process.cwd(), ...argv.flatMap((a, i) => (a === '--include-directories' ? [argv[i + 1]] : []))];
  const rel = (d) => path.relative(path.resolve(d), path.resolve(fileRef[1].trim()));
  if (!dirs.some((d) => !rel(d).startsWith('..') && !path.isAbsolute(rel(d)))) {
    process.stderr.write(`Error: File path must be within one of the workspace directories: ${fileRef[1]}\n`);
    process.exit(1);
  }
  prompt = fs.readFileSync(fileRef[1].trim(), 'utf8').trim();
}
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
// harness preamble lines (they may quote chat titles, i.e. other prompts) are not directives
const lines = delivered ? [] : prompt.split(/\r?\n/).filter((l) => !l.startsWith('[harness]'));
const has = (re) => lines.some((l) => re.test(l));

// like GigaCode: /models lists «X-262k», the CLI takes «X» (the listed id itself is accepted too, for older tests)
if (opt('--model') && catalogue.length && !catalogue.some((c) => c === model || c.replace(/-\d+[km]$/i, '') === model)) {
  // GigaCode's fatal error for a renamed/removed model: nothing on stdout, exit 1
  process.stderr.write(`An unexpected critical error occurred:\nError: The selected model '${model}' is not present in the current backend catalogue\n`);
  process.exit(1);
}
if (has(/#toolerror\b/)) {
  // an MCP tool error that quotes its arguments — words like «permission», «запрещён» inside are not a CLI denial
  emit({ type: 'tool_use', tool_name: 'mcp__harness__agent', tool_id: 'err_1', parameters: { prompt: 'Права MCP: есть ли разрешения; если доступ запрещён — отметь' } });
  emit({ type: 'tool_result', tool_id: 'err_1', status: 'error', output: 'MCP tool \'agent\' reported tool error: {"prompt":"Права MCP: есть ли разрешения (permission); если доступ запрещён — отметь"} with response: {"error":"boom"}' });
}
if (has(/#notoolresult\b/)) {
  // a built-in sub-agent call whose result never comes before the turn ends (seen on the target: cards spinning forever)
  emit({ type: 'tool_use', tool_name: 'agent', tool_id: 'lost_1', parameters: { subagent_type: 'general-purpose', prompt: 'проверка' } });
}
if (has(/#sandboxtool\b/)) {
  // the run starts, but a command inside the sandbox fails (seen on the target: Windows, hardlink ACLs unsupported)
  emit({ type: 'tool_use', tool_name: 'run_shell_command', tool_id: 'sbt_1', parameters: { command: 'git status' } });
  emit({ type: 'tool_result', tool_id: 'sbt_1', status: 'error', output: 'GigaCode sandbox: acl-object-hardlink (Win32 50)' });
}
if (has(/#sandboxfail\b/)) {
  let sandbox = null;
  try { sandbox = JSON.parse(fs.readFileSync(process.env.MOCK_AGENT_SETTINGS_PATH || '', 'utf8')).tools?.sandbox ?? null; } catch {}
  if (sandbox) {
    process.stderr.write(`Error: Failed to start the action sandbox '${sandbox}': sandbox runtime is not available on this machine\n`);
    process.exit(1);
  }
}
// commit/PR message requests (first line HARNESS_GENERATE_MESSAGE): #genfail in the changes = the CLI rejects
// --safe-mode before any output (the harness retries without it); #gengarbage = an answer that is not JSON
const generate = prompt.split(/\r?\n/)[0].trim() === 'HARNESS_GENERATE_MESSAGE';
if (generate && prompt.includes('#genfail') && argv.includes('--safe-mode')) {
  process.stderr.write('Error: unknown option --safe-mode\n');
  process.exit(1);
}
if (has(/#nopartial\b/) && argv.includes('--include-partial-messages')) {
  // an older CLI: yargs strict mode rejects the flag before any output
  process.stderr.write('Unknown argument: include-partial-messages\n');
  process.exit(1);
}
// #crashalways: this and every later turn of the session crash (the harness's automatic continuation gives up)
const stickyDir = process.env.MOCK_AGENT_STATE_DIR || path.join(os.tmpdir(), 'harness-mock-agent');
const sticky = resume && path.join(stickyDir, `${resume.replace(/[^\w-]/g, '_')}.crash`);
if (sticky && has(/#crashalways\b/)) { fs.mkdirSync(stickyDir, { recursive: true }); fs.writeFileSync(sticky, '1'); }
// #busy <name> <n>: the first n starts collide (ExtensionStoreBusyError); #busylock: GigaCode's stale-lock error instead
const busy = lines.map((l) => l.match(/^\s*#busy(lock)?\s+(\S+)\s+(\d+)/)).find(Boolean);
if (busy) {
  const counter = path.join(stickyDir, `busy-${busy[2]}`);
  fs.mkdirSync(stickyDir, { recursive: true });
  const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0);
  if (n < Number(busy[3])) {
    fs.writeFileSync(counter, String(n + 1));
    if (busy[1]) process.stderr.write('Error: Unable to update lock within the stale threshold\n    at file:///C:/Program%20Files/.gigacode/lib/chunks/c-TD633MIT.js:4:12738\n    at FSReqCallback.oncomplete (node:fs:196:5)\n');
    else process.stderr.write('An unexpected critical error occurred:\nExtensionStoreBusyError: Extension store is busy at C:\\Users\\u\\.gigacode\\extension-store.\n');
    process.exit(1);
  }
}
if (has(/#crash\b/) || (sticky && fs.existsSync(sticky))) {
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
  const ms = lines.map((l) => l.match(/#auth\s+(\d+)/)).find(Boolean)?.[1];
  await sleep(Number(ms ?? 2000)); // `#auth <ms>`: how long the login takes
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
  // #noharness: the harness server failed to start in the CLI (no harness tools for the agent)
  mcp_servers: mcpServers.map((name) => ({ name, status: name === 'harness' && has(/#noharness\b/) ? 'failed' : 'connected' })),
  slash_commands: ['clear', 'full-task'], agents: ['general-purpose'], qwen_code_version: 'mock-1.0',
});
emit({ type: 'message', role: 'user', content: prompt });
if (generate) {
  const long = prompt.includes('#genlong') && JSON.stringify({ title: `PROJ-1 ${'Очень длинный заголовок '.repeat(10)}`, body: 'Длинное описание. '.repeat(100) });
  const answer = prompt.includes('#gengarbage') ? 'Не могу написать сообщение.' : long || 'Готово: {"title":"PROJ-1 Тестовое сообщение","body":"Что и зачем."}';
  emit({ type: 'message', role: 'assistant', content: answer, delta: true });
  emit({ type: 'result', status: 'success', result: answer, stats: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
}
// the harness's commit / push request («Пользователь явно просит …»): really run git in the cwd, answer RESULT
// (#gitfail in the request = RESULT: ERROR without touching anything)
if (prompt.includes('Пользователь явно просит')) {
  const run = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  let line;
  try {
    if (prompt.includes('#gitfail')) throw new Error('mock: отказано (#gitfail)');
    if (prompt.includes('закоммитить')) {
      const message = prompt.match(/не меняй\):\n([\s\S]*?)\nВыполни:/)[1].trim();
      const only = prompt.match(/закоммить только эти файлы: git add -- (.+?), затем/)?.[1].match(/"[^"]+"|\S+/g).map((p) => p.replace(/^"|"$/g, ''));
      if (only) run('add', '--', ...only);
      else if (!prompt.includes('только проиндексированные')) run('add', '-A');
      execFileSync('git', ['commit', '-q', '-F', '-', ...(only ? ['--', ...only] : [])], { input: message, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const hash = run('rev-parse', 'HEAD');
      if (prompt.includes('git push -u origin HEAD')) run('push', '-q', '-u', 'origin', 'HEAD');
      line = prompt.includes('git push -u origin HEAD') ? `RESULT: ${hash} ${run('rev-parse', '--abbrev-ref', 'HEAD')}` : `RESULT: ${hash}`;
    } else if (prompt.includes('отправить ветку')) {
      run('push', '-q', '-u', 'origin', 'HEAD');
      line = `RESULT: OK ${run('rev-parse', '--abbrev-ref', 'HEAD')}`;
    } else line = 'RESULT: ERROR в демо агент не создаёт PR — нажмите «Сделать напрямую»';
  } catch (e) {
    line = `RESULT: ERROR ${String(e.message).split('\n')[0]}`;
  }
  emit({ type: 'message', role: 'assistant', content: `Сделано.\n${line}`, delta: true });
  emit({ type: 'result', status: 'success', result: `Сделано.\n${line}`, stats: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
}
// MOCK_AGENT_MCP_WARNING: GigaCode's stderr warning when one of its MCP servers did not start (exit 0, not an error)
if (process.env.MOCK_AGENT_MCP_WARNING) process.stderr.write('Warning: MCP server(s) failed to start: java-lsp. Continuing with built-in tools and any servers that did connect.\n');
// MOCK_AGENT_SAFE_NO_SLASH: a CLI whose --safe-mode has no slash commands (answers nothing useful)
if (prompt === '/models' && process.env.MOCK_AGENT_SAFE_NO_SLASH && argv.includes('--safe-mode')) {
  emit({ type: 'result', status: 'success', result: 'Unknown command', stats: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
}
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
    const data = tool === 'ask' ? await askAndWait(args) : await api('POST', `/api/agent/${tool}`, args); // ask waits for the answer, as through MCP
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
const denialText = (tool) => `GigaCode requires permission to use "${tool}", but that permission was declined (non-interactive mode cannot prompt for confirmation).`;
const allowed = argv.flatMap((a, i) => (a === '--allowed-tools' ? [argv[i + 1]] : []));
const deny = lines.map((l) => l.match(/#deny\s+(\S+)(?:\s+(.+))?/)).filter(Boolean).pop();
if (deny) {
  // headless -p cannot ask for a confirmation: the CLI denies the call unless it is on --allowed-tools
  const command = deny[2]?.trim() || 'rm -rf build';
  const word = command.split('&&').map((x) => x.trim()).find((x) => !/^cd\s/i.test(x))?.split(/\s+/)[0];
  emit({ type: 'tool_use', tool_name: deny[1], tool_id: 'deny_1', parameters: { command } });
  if (allowed.includes(deny[1]) || allowed.includes(`${deny[1]}(${word})`)) emit({ type: 'tool_result', tool_id: 'deny_1', status: 'success', output: 'ok' });
  else emit({ type: 'tool_result', tool_id: 'deny_1', status: 'error', output: denialText(deny[1]) });
}
if (has(/#subdeny\b/)) {
  // a built-in sub-agent whose shell call is denied (its events carry parent_tool_use_id)
  emit({ type: 'tool_use', tool_name: 'agent', tool_id: 'sa_1', parameters: { subagent_type: 'java-reviewer', prompt: 'проверь' } });
  emit({ type: 'tool_use', tool_name: 'run_shell_command', tool_id: 'sa_c1', parameters: { command: 'mvn -q test' }, parent_tool_use_id: 'sa_1' });
  emit({ type: 'tool_result', tool_id: 'sa_c1', status: 'error', output: denialText('run_shell_command'), parent_tool_use_id: 'sa_1' });
  emit({ type: 'tool_result', tool_id: 'sa_1', status: 'success', output: 'sub-agent done' });
}
const question = lines.map((l) => l.match(/#question\s+(.+)/)).filter(Boolean).pop();
if (question) {
  const [q, ...options] = question[1].split('|').map((x) => x.trim());
  emit({ type: 'tool_use', tool_name: 'ask_user_question', tool_id: 'q_1', parameters: { questions: [{ question: q, options: options.map((label) => ({ label })), multiSelect: false }] } });
  emit({ type: 'tool_result', tool_id: 'q_1', status: 'error', output: 'question tool is not available in non-interactive mode' });
}
// GigaCode reports usage per model step on its assistant events (input includes the cached part)
if (has(/#usage\b/)) emit({ type: 'assistant', message: { role: 'assistant', content: [], usage: { input_tokens: 120000, output_tokens: 500, cache_read_input_tokens: 100000, total_tokens: 120500 } } });
if (has(/#raw\b/)) process.stdout.write('plain line 1\nplain line 2\n');
if (has(/#slow\b/)) await say('slow '.repeat(20), 250);

const rest = [];
async function runSubagent(profile, spec, extra = {}) {
  // exactly what the harness MCP bridge does for worker_run: start, then long-poll (across harness restarts)
  const id = `run_${++toolSeq}`;
  emit({ type: 'tool_use', tool_name: 'harness.worker_run', tool_id: id, parameters: { profile, spec, ...extra } });
  try {
    const r = await runAndWait('worker_run', { profile, spec, ...extra });
    emit({ type: 'tool_result', tool_id: id, status: 'success', output: JSON.stringify(r) });
    return say(` worker_run result: ${r.summary}`);
  } catch (e) {
    emit({ type: 'tool_result', tool_id: id, status: 'error', output: e.message });
    return say(` worker_run failed: ${e.message}`);
  }
}

/** #cutagent <type> <prompt>: the same call, cut by the CLI before the sub-agent ends («Request timed out», as seen live). */
async function cutAgentTool(type, prompt) {
  const id = `agent_${++toolSeq}`;
  const args = { subagent_type: type, description: 'probe', prompt };
  emit({ type: 'tool_use', tool_name: 'agent', tool_id: id, parameters: args });
  await api('POST', '/api/agent/agent', args); // started and waited for (awaitedBy) — then the CLI gives up on the call
  emit({ type: 'tool_result', tool_id: id, status: 'error', output: 'Request timed out' });
  return say(' agent call timed out');
}

/** #agentlate <type> <prompt>: the same tool, ACP-style — the harness gets the call first, the stream line comes later and without arguments. */
async function lateAgentTool(type, prompt) {
  const id = `agent_${++toolSeq}`;
  const r = await api('POST', '/api/agent/agent', { subagent_type: type, description: 'probe', prompt, run_in_background: true });
  emit({ type: 'tool_use', tool_name: 'agent', tool_id: id, parameters: {} });
  emit({ type: 'tool_result', tool_id: id, status: 'success', output: JSON.stringify(r) });
  return say(' agent started late');
}

/** #agentmcp <type> <prompt>: the harness's `agent` MCP tool, its call reaching the stream under the bare name «agent». */
async function runAgentTool(type, prompt) {
  const id = `agent_${++toolSeq}`;
  const args = { subagent_type: type, description: 'probe', prompt };
  emit({ type: 'tool_use', tool_name: 'agent', tool_id: id, parameters: args });
  try {
    const r = await runAndWait('agent', args);
    emit({ type: 'tool_result', tool_id: id, status: 'success', output: JSON.stringify(r) });
    return say(` agent result: ${r.summary}`);
  } catch (e) {
    emit({ type: 'tool_result', tool_id: id, status: 'error', output: e.message });
    return say(` agent failed: ${e.message}`);
  }
}

for (const l of lines) {
  const am = l.match(/#agentmcp\s+(\S+)\s+(.+)/);
  if (am) { await runAgentTool(am[1], am[2].trim()); continue; }
  const late = l.match(/#agentlate\s+(\S+)\s+(.+)/);
  if (late) { await lateAgentTool(late[1], late[2].trim()); continue; }
  const cut = l.match(/#cutagent\s+(\S+)\s+(.+)/);
  if (cut) { await cutAgentTool(cut[1], cut[2].trim()); continue; }
  const m = l.match(/#spawn\s+(.+)/);
  const run = l.match(/#run\s+(\S+)\s+(.+)/);
  const runwt = l.match(/#runwt\s+(\S+)\s+(.+)/); // a sub-agent in a new worktree (persistent)
  if (m) await harness('worker_start', { spec: m[1].trim(), task: true });
  else if (runwt) await runSubagent(runwt[1], runwt[2].trim(), { worktree: 'new' });
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
