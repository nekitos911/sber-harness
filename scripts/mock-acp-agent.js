#!/usr/bin/env node
// Fake ACP agent (Agent Client Protocol over ndjson stdio) for tests: `mock-acp-agent.js --acp [...]`.
// Prompt directives: #perm (tool call that asks for permission, then writes out.txt via fs/write_text_file),
// #read <path> (fs/read_text_file), #slow (streams ~4 s, honours session/cancel), #die (exits mid-turn).
// loadSession: true; sessions live in MOCK_AGENT_STATE_DIR (acp-<id>.json), a load replays the history.
// MOCK_AGENT_ARGV_FILE: appends { acp: true, argv, mcpServers } on session/new|load.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const stateDir = process.env.MOCK_AGENT_STATE_DIR || path.join(os.tmpdir(), 'harness-mock-agent');
fs.mkdirSync(stateDir, { recursive: true });
const stateFile = (id) => path.join(stateDir, `acp-${id.replace(/[^\w-]/g, '_')}.json`);
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const pending = new Map();
const request = (method, params) => new Promise((resolve, reject) => {
  const id = `a${++seq}`;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const say = (sessionId, text) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const cancelled = new Set();
const loadedHere = new Set();
const record = (params) => {
  if (process.env.MOCK_AGENT_ARGV_FILE) fs.appendFileSync(process.env.MOCK_AGENT_ARGV_FILE, `${JSON.stringify({ acp: true, pid: process.pid, argv: process.argv.slice(2), mcpServers: params.mcpServers, env: { HARNESS_SESSION_ID: process.env.HARNESS_SESSION_ID } })}\n`);
};

async function prompt({ sessionId, prompt: parts }) {
  const text = parts.map((p) => p.text || '').join('\n');
  const st = JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8'));
  st.turns += 1;
  st.history.push(text);
  fs.writeFileSync(stateFile(sessionId), JSON.stringify(st));
  cancelled.delete(sessionId);
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'думаю' } });
  say(sessionId, `${loadedHere.has(sessionId) ? 'loaded, ' : ''}ACP mock, turn ${st.turns}.`);
  update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'ответить', status: 'in_progress', priority: 'high' }] });
  if (/#die\b/.test(text)) process.exit(3);
  if (/#slow\b/.test(text)) {
    for (let i = 0; i < 20; i++) {
      if (cancelled.has(sessionId)) return { stopReason: 'cancelled' };
      say(sessionId, ' slow');
      await sleep(200);
    }
  }
  const read = text.match(/#read\s+(\S+)/);
  if (read) {
    try {
      const r = await request('fs/read_text_file', { sessionId, path: read[1] });
      say(sessionId, ` прочитал: ${r.content}`);
    } catch (e) {
      say(sessionId, ` не прочитал: ${e.message}`);
    }
  }
  if (/#perm\b/.test(text)) {
    const file = path.join(st.cwd, 'out.txt');
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Запись out.txt', kind: 'edit', status: 'pending', rawInput: { path: file } });
    const answer = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 't1', title: 'Запись out.txt', kind: 'edit', rawInput: { path: file } },
      options: [{ optionId: 'allow', name: 'Разрешить', kind: 'allow_once' }, { optionId: 'reject', name: 'Запретить', kind: 'reject_once' }],
    });
    if (answer.outcome.outcome === 'cancelled') return { stopReason: 'cancelled' };
    if (answer.outcome.optionId === 'allow') {
      await request('fs/write_text_file', { sessionId, path: file, content: 'ok\n' });
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'diff', path: file, oldText: null, newText: 'ok' }] });
      say(sessionId, ' записано');
    } else {
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'отклонено пользователем' } }] });
      say(sessionId, ' отказано, иду другим путём');
    }
  }
  say(sessionId, ' Done.');
  return { stopReason: 'end_turn' };
}

const handlers = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }),
  'session/new': (params) => {
    record(params);
    const sessionId = randomUUID();
    fs.writeFileSync(stateFile(sessionId), JSON.stringify({ turns: 0, cwd: params.cwd, history: [] }));
    return { sessionId };
  },
  'session/load': async (params) => {
    record(params);
    const st = JSON.parse(fs.readFileSync(stateFile(params.sessionId), 'utf8'));
    for (const h of st.history) {
      update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: h } });
      say(params.sessionId, `(replay of: ${h})`);
    }
    loadedHere.add(params.sessionId);
    return null;
  },
  'session/prompt': prompt,
};

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'session/cancel') return void cancelled.add(msg.params.sessionId);
  if (!msg.method) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.reject(new Error(msg.error.message));
    else p?.resolve(msg.result);
    return;
  }
  try {
    const handler = handlers[msg.method];
    if (!handler) throw Object.assign(new Error(`unknown method ${msg.method}`), { code: -32601 });
    send({ id: msg.id, result: (await handler(msg.params || {})) ?? null });
  } catch (e) {
    send({ id: msg.id, error: { code: e.code || -32603, message: e.message } });
  }
});
