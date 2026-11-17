#!/usr/bin/env node
// Fake GigaCode-like CLI for tests and demos. Emits Gemini-style stream-json on stdout.
//   mock-agent.js [--resume <id>] -p <prompt> --output-format stream-json [--approval-mode <m>] [--model <id>]
// Prompt directives (ignored in messages delivered from other sessions, i.e. prompts starting "[harness] Message from"):
//   #spawn <spec>   worker_start({ spec })          #done <summary>  worker_done(done)   #fail  worker_done(failed)
//   #ask <q>        ask({ question })               #crash  exit 1 with stderr           #silent  sleep, no output
//   #slow           stream slowly for ~5 s
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

const delivered = prompt.startsWith('[harness] Message from');
const lines = delivered ? [] : prompt.split(/\r?\n/);
const has = (re) => lines.some((l) => re.test(l));

if (has(/#crash\b/)) {
  process.stderr.write('mock-agent: simulated crash (#crash)\n');
  process.exit(1);
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
try { mcpServers = Object.keys(JSON.parse(fs.readFileSync(process.env.MOCK_AGENT_SETTINGS_PATH, 'utf8')).mcpServers || {}); } catch {}

emit({ type: 'init', session_id: sessionId, model, mcp_servers: mcpServers });
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

if (delivered) await say(`Received: ${prompt.split('\n')[1]?.slice(0, 120) || ''}`);
if (has(/#slow\b/)) await say('slow '.repeat(20), 250);

const rest = [];
for (const l of lines) {
  const m = l.match(/#spawn\s+(.+)/);
  if (m) await harness('worker_start', { spec: m[1].trim() });
  else rest.push(l);
}
const restText = rest.join('\n');
const ask = restText.match(/#ask\s+(.+)/);
const done = restText.match(/#done\b([^\n]*)/);
if (ask) await harness('ask', { question: ask[1].trim() });
else if (/#fail\b/.test(restText)) await harness('worker_done', { summary: 'mock failure', status: 'failed' });
else if (done) await harness('worker_done', { summary: done[1].trim() || 'completed', status: 'done' });

await say(' Done.');
emit({ type: 'result', status: 'success', stats: { total_tokens: 0, tool_calls: toolSeq + 1 } });
