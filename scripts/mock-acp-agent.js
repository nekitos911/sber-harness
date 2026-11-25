#!/usr/bin/env node
// Fake ACP agent (Agent Client Protocol over ndjson stdio) for tests: `mock-acp-agent.js --acp [...]`.
// Prompt directives: #perm (tool call that asks for permission, then writes out.txt via fs/write_text_file),
// #mcp (a harness MCP tool behind GigaCode's ToolCall wrapper asking for permission), #late (the fixture's tool-call
// stream), #read <path> (fs/read_text_file), #slow (streams ~4 s, honours session/cancel), #die (exits mid-turn), #diealways
// (this and every later turn of the session exit mid-turn),
// #maxtokens (ends with stopReason max_tokens), #hooktimeout (fails like GigaCode whose hooks never answer, unless the
// run settings say disableAllHooks). Env MOCK_ACP_NEW_HOOKTIMEOUT=<file>: the first session/new fails that way once.
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
const hooksOff = () => {
  try {
    return !!JSON.parse(fs.readFileSync(process.env.MOCK_AGENT_SETTINGS_PATH || process.env.GIGACODE_SYSTEM_SETTINGS_PATH || '', 'utf8')).disableAllHooks;
  } catch {
    return false;
  }
};
const loadedHere = new Set();
// the catalogue `/models` prints: the table's first column, minus the header and the rule
const MODELS = fs.readFileSync(new URL('../test/fixtures/gigacode.models.txt', import.meta.url), 'utf8').split('\n')
  .map((l) => l.match(/^\|\s*([^|]+?)\s*\|/)?.[1]).filter((id) => id && id !== 'ID' && !/^-+$/.test(id));
let clientFs = false; // initialize: does the client (the harness) offer to read and write files for us?
const record = (params) => {
  if (process.env.MOCK_AGENT_ARGV_FILE) fs.appendFileSync(process.env.MOCK_AGENT_ARGV_FILE, `${JSON.stringify({ acp: true, pid: process.pid, argv: process.argv.slice(2), mcpServers: params.mcpServers, clientFs, env: { HARNESS_SESSION_ID: process.env.HARNESS_SESSION_ID } })}\n`);
};

async function prompt({ sessionId, prompt: parts }) {
  const text = parts.map((p) => p.text || '').join('\n');
  // the harness's recap for a session that would not load: say it arrived (and what the chat was about)
  if (text.includes('[harness] Твоя прежняя сессия не загрузилась')) say(sessionId, `(запись чата: ${/Первое сообщение \(задача\):\n([^\n]*)/.exec(text)?.[1] ?? '?'}) `);
  if (text.trim() === '/models') {
    // like the headless mock: the catalogue from the fixture, in a (hidden) helper session
    say(sessionId, fs.readFileSync(new URL('../test/fixtures/gigacode.models.txt', import.meta.url), 'utf8'));
    return { stopReason: 'end_turn' };
  }
  if (/#hooktimeout\b/.test(text) && !hooksOff()) {
    throw Object.assign(new Error('Internal error'), { code: -32603, data: { details: 'Request timed out waiting for hook-execution-response' } });
  }
  const st = JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8'));
  st.turns += 1;
  st.history.push(text);
  if (/#diealways\b/.test(text.split('\n\n').at(-1))) st.dieAlways = true; // this and every later turn die mid-turn
  fs.writeFileSync(stateFile(sessionId), JSON.stringify(st));
  cancelled.delete(sessionId);
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'думаю' } });
  const on = st.model ? ` [${st.model}]` : ''; // session/set_model: which model the turn really runs on
  say(sessionId, `${loadedHere.has(sessionId) ? 'loaded, ' : ''}ACP mock, turn ${st.turns}.${on}`);
  update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'ответить', status: 'in_progress', priority: 'high' }] });
  // the message itself, not the harness's record of the chat before it (that one repeats old directives)
  if (/#die\b/.test(text.split('\n\n').at(-1)) || st.dieAlways) process.exit(3);
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
      const r = clientFs ? await request('fs/read_text_file', { sessionId, path: read[1] }) : { content: fs.readFileSync(path.resolve(st.cwd, read[1]), 'utf8') };
      say(sessionId, ` прочитал: ${r.content}`);
    } catch (e) {
      say(sessionId, ` не прочитал: ${e.message}`);
    }
  }
  if (/#perm\b/.test(text)) {
    const file = path.join(st.cwd, 'out.txt');
    // like GigaCode's ToolCall wrapper: announced with {}, the arguments only in the permission request
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Запись out.txt', kind: 'edit', status: 'pending', rawInput: {}, _meta: { toolName: 'write_file' } });
    const answer = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 't1', title: 'Запись out.txt', kind: 'edit', rawInput: { path: file }, _meta: { toolName: 'write_file' } },
      options: [{ optionId: 'allow', name: 'Разрешить', kind: 'allow_once' }, { optionId: 'reject', name: 'Запретить', kind: 'reject_once' }],
    });
    if (answer.outcome.outcome === 'cancelled') return { stopReason: 'cancelled' };
    if (answer.outcome.optionId === 'allow') {
      if (clientFs) await request('fs/write_text_file', { sessionId, path: file, content: 'ok\n' });
      else fs.writeFileSync(file, 'ok\n');
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'diff', path: file, oldText: null, newText: 'ok' }] });
      say(sessionId, ' записано');
    } else {
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'отклонено пользователем' } }] });
      say(sessionId, ' отказано, иду другим путём');
    }
  }
  if (/#ask\b/.test(text)) {
    // GigaCode's own question over ACP (seen on the target): a tool call, then a permission request carrying the questions
    const input = { questions: [{ header: 'Объект', question: 'Что проверяем?', options: [{ label: 'Конфиг' }, { label: 'Код' }] }] };
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'q1', title: 'AskUserQuestion', kind: 'other', status: 'pending', rawInput: {} });
    const answer = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'q1', title: 'Ask user 1 question', kind: 'other', rawInput: input },
      options: [{ optionId: 'submit', name: 'Submit', kind: 'allow_once' }, { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' }],
    });
    if (answer.outcome.outcome === 'cancelled') return { stopReason: 'cancelled' };
    say(sessionId, ` вопрос: ${answer.outcome.optionId}`);
    for (let i = 0; i < 20 && !cancelled.has(sessionId); i++) await sleep(100); // goes on unless the client cancels
    if (cancelled.has(sessionId)) return { stopReason: 'cancelled' };
  }
  if (/#mcp\b/.test(text)) {
    // a harness tool behind the same wrapper; the harness pre-allows its own tools in every mode
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'ToolCall', kind: 'other', status: 'pending', rawInput: {}, _meta: { toolName: 'tool_call' } });
    const answer = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 't2', kind: 'other', title: '{"question":"Куда коммитить?"}', rawInput: { question: 'Куда коммитить?' }, _meta: { toolName: 'mcp__harness__ask' } },
      options: [{ optionId: 'always', name: 'Always Allow', kind: 'allow_always' }, { optionId: 'once', name: 'Allow', kind: 'allow_once' }],
    });
    const allowed = answer.outcome.outcome === 'selected';
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: allowed ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: allowed ? `разрешено: ${answer.outcome.optionId}` : 'cancelled' } }] });
    say(sessionId, allowed ? ' спросил harness' : ' не спросил');
  }
  if (/#late\b/.test(text)) {
    // tool calls announced with rawInput {} whose input arrives in a later tool_call_update. The permission the wrapper
    // asks for is answered like the real CLI's own wrapper does: the harness pre-allows its MCP tools in every mode
    const lines = fs.readFileSync(new URL('../test/fixtures/gigacode.acp-late-input.ndjson', import.meta.url), 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      const u = JSON.parse(l);
      update(sessionId, u);
      if (u.sessionUpdate === 'session/request_permission') await request('session/request_permission', { ...u, sessionId });
    }
  }
  say(sessionId, ' Done.');
  return { stopReason: /#maxtokens\b/.test(text) ? 'max_tokens' : 'end_turn' };
}

const handlers = {
  initialize: (params) => { clientFs = !!params?.clientCapabilities?.fs?.readTextFile; return { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }; },
  'session/new': (params) => {
    // MOCK_ACP_NEW_HOOKTIMEOUT=<file>: the first session/new times out on a SessionStart hook (the file marks it done)
    const once = process.env.MOCK_ACP_NEW_HOOKTIMEOUT;
    if (once && !fs.existsSync(once)) {
      fs.writeFileSync(once, '1');
      throw Object.assign(new Error('Internal error'), { code: -32603, data: { details: 'Request timed out waiting for hook-execution-response' } });
    }
    record(params);
    const sessionId = randomUUID();
    fs.writeFileSync(stateFile(sessionId), JSON.stringify({ turns: 0, cwd: params.cwd, history: [] }));
    // like GigaCode: the session names this account's catalogue and which model it runs with; the model is switched over
    // the session (session/set_model), not by the process argv
    return { sessionId, models: { currentModelId: MODELS[0], availableModels: MODELS.map((id) => ({ modelId: id, name: id })) } };
  },
  // the real agent takes an id this account has: one that left the catalogue is an error the harness has to handle
  'session/set_model': (params) => {
    if (!MODELS.includes(params.modelId)) throw Object.assign(new Error(`unknown model ${params.modelId}`), { code: -32602 });
    const st = JSON.parse(fs.readFileSync(stateFile(params.sessionId), 'utf8'));
    fs.writeFileSync(stateFile(params.sessionId), JSON.stringify({ ...st, model: params.modelId }));
    return null;
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
    send({ id: msg.id, error: { code: e.code || -32603, message: e.message, ...(e.data ? { data: e.data } : {}) } });
  }
});
