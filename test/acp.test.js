// ACP transport (agents.<id>.transport "acp"): a long-lived agent process per session over JSON-RPC; permission
// requests held until the user answers; Stop cancels; a dead process or a harness restart resumes via session/load.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { CODE_ROOT } from '../server/config.js';
import { acpEvents, acpMcpServers } from '../server/acp.js';
import { tmpDir, rmrf, waitFor, waitPidGone } from './helpers.js';

const root = tmpDir();
const cwd = path.join(root, 'проект');
const dataDir = path.join(root, 'данные');
const argvFile = path.join(root, 'acp.ndjson');
const configFile = path.join(root, 'config.json');
fs.mkdirSync(cwd);
fs.writeFileSync(path.join(cwd, 'inside.txt'), 'внутри');
fs.writeFileSync(path.join(root, 'outside.txt'), 'снаружи');
fs.copyFileSync(path.join(CODE_ROOT, 'harness.config.json'), configFile);
let h;

async function harness() {
  const srv = await startServer({
    dataDir, configFile, port: 0,
    configOverrides: {
      defaultAgent: 'mock', mcpServersFrom: null, history: { adopt: false }, agents: {
        mock: { modelsDiscovery: null },
        acpmock: { launcher: 'mock', label: 'ACP mock', transport: 'acp', command: [process.execPath, path.join(CODE_ROOT, 'scripts', 'mock-acp-agent.js')], approvalMode: 'auto', approvalModes: ['default', 'auto'], modelsDiscovery: { prompt: '/models', maxAgeHours: 24 } },
        // the same mock, unloaded after 0.4 s idle
        acpidle: { launcher: 'mock', label: 'ACP idle', transport: 'acp', acpIdleMin: 0.4 / 60, command: [process.execPath, path.join(CODE_ROOT, 'scripts', 'mock-acp-agent.js')], approvalMode: 'auto', approvalModes: ['default', 'auto'] },
      },
    },
  });
  const api = async (method, p, body) => {
    const res = await fetch(srv.url + p, { method, headers: { 'x-harness-token': srv.token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { srv, api };
}
const session = async (id) => (await h.api('GET', '/api/state')).body.sessions.find((s) => s.id === id);
const messages = async (id) => (await h.api('GET', `/api/sessions/${id}/messages`)).body;
const idle = (id) => waitFor(async () => (await session(id)).status === 'idle', { what: `${id} idle` });
const send = (id, text) => h.api('POST', `/api/sessions/${id}/messages`, { text });
const said = async (id) => (await messages(id)).filter((m) => m.kind === 'assistant').map((m) => m.text);
const records = () => fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let chat;

before(async () => {
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  process.env.MOCK_AGENT_STATE_DIR = path.join(root, 'mock-state');
  h = await harness();
  chat = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpmock', cwd, prompt: 'привет' })).body;
});
after(async () => {
  delete process.env.MOCK_AGENT_ARGV_FILE;
  await h.srv.close();
  for (const { pid } of records()) await waitPidGone(pid); // the agent's cwd is inside root
  rmrf(root);
});

test('mapping helpers: session/update -> events, MCP servers in ACP shape', () => {
  assert.deepEqual(acpEvents({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', content: [{ type: 'diff', path: 'a.txt', oldText: 'x', newText: 'y' }] }),
    [{ type: 'tool_result', id: 't', output: '--- a.txt\n+++ a.txt\n-x\n+y', isError: false }]);
  assert.deepEqual(acpEvents({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old' } }), []);
  assert.deepEqual(acpMcpServers({ command: 'node', args: ['h.js'], env: { A: '1' } }, { web: { url: 'http://x', headers: { K: 'v' } } }),
    [{ type: 'http', name: 'web', url: 'http://x', headers: [{ name: 'K', value: 'v' }] }, { name: 'harness', command: 'node', args: ['h.js'], env: [{ name: 'A', value: '1' }] }]);
});

test('a prompt streams text, thought and plan; the next message reuses the same agent session', async () => {
  await idle(chat.id);
  const s = await session(chat.id);
  assert.ok(s.externalSessionId);
  const msgs = await messages(chat.id);
  assert.ok(msgs.some((m) => m.kind === 'thought' && m.text === 'думаю'));
  assert.ok(msgs.some((m) => m.kind === 'system' && /^План:\n… ответить$/.test(m.text)));
  assert.deepEqual(await said(chat.id), ['ACP mock, turn 1. Done.']);
  const [rec] = records();
  assert.deepEqual(rec.argv, ['--acp', '--approval-mode', 'auto']);
  const harnessMcp = rec.mcpServers.find((m) => m.name === 'harness');
  assert.deepEqual([harnessMcp.command, harnessMcp.args], [process.execPath, [path.join(CODE_ROOT, 'mcp', 'harness-mcp.js')]]);
  assert.ok(harnessMcp.env.some((e) => e.name === 'HARNESS_SESSION_ID' && e.value === chat.id));
  await send(chat.id, 'ещё');
  await waitFor(async () => (await said(chat.id)).includes('ACP mock, turn 2. Done.'), { what: 'turn 2' });
  await idle(chat.id);
  assert.equal(records().length, 1, 'one process, one session/new');
});

test('a call announced with rawInput {} gets its input from the later tool_call_update (card and sub-agent chat)', async () => {
  const lines = fs.readFileSync(path.join(CODE_ROOT, 'test', 'fixtures', 'gigacode.acp-late-input.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const evs = lines.flatMap(acpEvents);
  assert.deepEqual(evs.filter((e) => e.type === 'tool_input').map((e) => e.id), ['toolu_01', 'toolu_02']);
  assert.equal(evs.find((e) => e.type === 'tool_call').input && JSON.stringify(evs.find((e) => e.type === 'tool_call').input), '{}');

  await send(chat.id, '#late');
  const tool = await waitFor(async () => (await messages(chat.id)).find((m) => m.tool?.id === 'toolu_01' && m.tool.status === 'ok'), { what: 'ToolSearch done' });
  assert.deepEqual(tool.tool.input, { query: 'harness', max_results: 5 });
  const agent = (await messages(chat.id)).find((m) => m.tool?.id === 'toolu_02');
  assert.equal(agent.tool.input.subagent_type, 'general-purpose');
  const sub = await session(agent.tool.subSessionId);
  assert.equal(sub.title, 'general-purpose · Проверка оркестрации');
  const first = (await messages(sub.id)).find((m) => m.kind === 'user');
  assert.equal(first.text, 'Проверь, что инструменты harness видны, и ответь одной строкой.');
  await idle(chat.id);
});

test('an error stop reason (max_tokens) is shown although the turn closes at its result', async () => {
  await send(chat.id, '#maxtokens');
  const err = await waitFor(async () => (await messages(chat.id)).find((m) => m.kind === 'error' && /max_tokens/.test(m.text)), { what: 'stop reason error' });
  assert.equal(err.text, 'Агент остановился: max_tokens');
  await waitFor(async () => { const s = await session(chat.id); return s.status === 'error' && !s.turnClosing; }, { what: 'error status' });
});

test('permission request: held until answered (allow writes the file, reject is reported), the card shows the answer', async () => {
  await send(chat.id, '#perm');
  const card = await waitFor(async () => (await messages(chat.id)).find((m) => m.kind === 'permission' && !m.permission.resolved), { what: 'permission card' });
  assert.deepEqual([card.permission.transport, card.permission.tool, card.permission.options.map((o) => o.id)], ['acp', 'Запись out.txt', ['allow', 'reject']]);
  const s = await session(chat.id);
  assert.deepEqual([s.status, s.waitingFor], ['running', 'permission']);
  assert.equal((await h.api('POST', `/api/sessions/${chat.id}/permission`, { permissionId: card.permission.id, optionId: 'allow' })).status, 200);
  await idle(chat.id);
  assert.equal(fs.readFileSync(path.join(cwd, 'out.txt'), 'utf8'), 'ok\n', 'written through fs/write_text_file');
  const tool = (await messages(chat.id)).find((m) => m.kind === 'tool' && m.tool.id === 't1');
  assert.deepEqual([tool.tool.status, /\+ok$/.test(tool.tool.output)], ['ok', true]);
  assert.ok((await said(chat.id)).at(-1).includes('записано'));
  assert.equal((await session(chat.id)).waitingFor, null);

  await send(chat.id, '#perm');
  const second = await waitFor(async () => (await messages(chat.id)).find((m) => m.kind === 'permission' && !m.permission.resolved), { what: 'second card' });
  await h.api('POST', `/api/sessions/${chat.id}/permission`, { permissionId: second.permission.id, optionId: 'reject' });
  await idle(chat.id);
  assert.ok((await said(chat.id)).at(-1).includes('отказано, иду другим путём'));
  assert.equal((await messages(chat.id)).find((m) => m.permission?.id === second.permission.id).permission.resolved, 'reject');
});

test('Stop cancels: a held permission is answered "cancelled", a streaming turn ends; fs reads stay inside the folders', async () => {
  await send(chat.id, '#perm');
  const card = await waitFor(async () => (await messages(chat.id)).find((m) => m.kind === 'permission' && !m.permission.resolved), { what: 'card' });
  await h.api('POST', `/api/sessions/${chat.id}/stop`);
  await waitFor(async () => (await session(chat.id)).status === 'stopped' && !(await messages(chat.id)).some((m) => m.kind === 'permission' && !m.permission.resolved), { what: 'cancelled' });
  assert.equal((await messages(chat.id)).find((m) => m.permission?.id === card.permission.id).permission.resolved, 'cancelled');
  assert.equal((await h.api('POST', `/api/sessions/${chat.id}/permission`, { permissionId: card.permission.id, optionId: 'allow' })).status, 409);

  await send(chat.id, '#slow');
  await waitFor(async () => (await said(chat.id)).at(-1)?.includes('slow'), { what: 'streaming' });
  await h.api('POST', `/api/sessions/${chat.id}/stop`);
  await waitFor(async () => (await session(chat.id)).status === 'stopped', { what: 'stopped' });
  assert.ok(!(await said(chat.id)).at(-1).includes('Done.'));

  await send(chat.id, `#read inside.txt`);
  await idle(chat.id);
  assert.ok((await said(chat.id)).at(-1).includes('прочитал: внутри'));
  await send(chat.id, `#read ${path.join(root, 'outside.txt')}`);
  await idle(chat.id);
  assert.match((await said(chat.id)).at(-1), /не прочитал: путь вне папки сессии/);
});

test('a dead agent process restarts on the next message with session/load; so does a harness restart', async () => {
  const before = records().length;
  await send(chat.id, '#die');
  await waitFor(async () => (await session(chat.id)).status === 'error', { what: 'process death reported' });
  assert.ok((await messages(chat.id)).some((m) => m.kind === 'error' && /Процесс ACP-агента завершился/.test(m.text)));
  await send(chat.id, 'снова');
  await waitFor(async () => (await said(chat.id)).some((t) => /^loaded, ACP mock, turn \d+\. Done\.$/.test(t)), { what: 'loaded after death' });
  await idle(chat.id);
  assert.equal(records().length, before + 1);
  assert.ok(!(await said(chat.id)).some((t) => t.includes('(replay of')), 'load replays are not shown again');

  await h.srv.close();
  h = await harness();
  assert.equal((await session(chat.id)).status, 'idle');
  const turnsBefore = (await said(chat.id)).length;
  await send(chat.id, 'после перезапуска');
  await waitFor(async () => (await said(chat.id)).length > turnsBefore, { what: 'answer after restart' });
  await idle(chat.id);
  assert.match((await said(chat.id)).at(-1), /^loaded, ACP mock, turn \d+\. Done\.$/);
  assert.equal(records().length, before + 2, 'session/load after the harness restart');
});

test('an idle ACP process is unloaded (warm false) and reloaded with session/load on the next message', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpidle', cwd, prompt: 'привет' })).body;
  await idle(s.id);
  await waitFor(async () => (await session(s.id)).warm === false, { what: 'unloaded after idle' });
  const before = records().length;
  await send(s.id, 'снова');
  await waitFor(async () => (await said(s.id)).some((t) => /^loaded, ACP mock, turn 2\. Done\.$/.test(t)), { what: 'reloaded' });
  assert.equal(records().length, before + 1, 'one session/load');
  assert.ok(!(await messages(s.id)).some((m) => m.kind === 'system' && /ACP:/.test(m.text)), 'no note when the load works');
  await idle(s.id);
});

test('model discovery asks a warm ACP process in a hidden session (no headless cold start)', async () => {
  assert.equal((await session(chat.id)).warm, true);
  const r = (await h.api('POST', '/api/agents/acpmock/models/refresh')).body;
  assert.ok(r.models.some((m) => m.id === 'GLM-5.3-Flash-262k' && m.available), JSON.stringify(r));
  // (a headless run of this ACP-only mock could not answer: the catalogue came from the warm process)
  assert.ok(!(await said(chat.id)).some((t) => t.includes('GLM-5.3-Flash')), 'the helper session stays out of the chat');
});
