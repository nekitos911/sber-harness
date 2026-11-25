// ACP transport (agents.<id>.transport "acp"): a long-lived agent process per session over JSON-RPC; permission
// requests held until the user answers; Stop cancels; a dead process or a harness restart resumes via session/load.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { CODE_ROOT } from '../server/config.js';
import { acpEvents, acpMcpServers, patientRequest, createAcp } from '../server/acp.js';
import { tmpDir, rmrf, waitFor, waitPidGone } from './helpers.js';

const root = tmpDir();
const cwd = path.join(root, 'проект');
const dataDir = path.join(root, 'данные');
const argvFile = path.join(root, 'acp.ndjson');
const configFile = path.join(root, 'config.json');
fs.mkdirSync(cwd);
fs.writeFileSync(path.join(cwd, 'inside.txt'), 'внутри');
fs.writeFileSync(path.join(root, 'outside.txt'), 'снаружи');
// an «agent» that never answers initialize and says nothing on stderr
const deadAgent = path.join(root, 'dead-agent.js');
fs.writeFileSync(deadAgent, 'setInterval(() => {}, 1000);\n');
// one that never answers initialize but keeps writing to stderr (MCP warnings): its start is waited for patiently
const chattyAgent = path.join(root, 'chatty-agent.js');
fs.writeFileSync(chattyAgent, "setInterval(() => process.stderr.write('Warning: MCP server still starting\\n'), 200);\n");
fs.copyFileSync(path.join(CODE_ROOT, 'harness.config.json'), configFile);
let h;

async function harness() {
  const srv = await startServer({
    dataDir, configFile, port: 0,
    configOverrides: {
      // the mock connects no MCP: a turn past 3 s says so (the «#slow» ones)
      defaultAgent: 'mock', mcpServersFrom: null, history: { adopt: false }, session: { mcpGraceSec: 3 }, agents: {
        mock: { modelsDiscovery: null },
        acpmock: { launcher: 'mock', label: 'ACP mock', transport: 'acp', acpClientFs: true, command: [process.execPath, path.join(CODE_ROOT, 'scripts', 'mock-acp-agent.js')], approvalMode: 'auto', approvalModes: ['default', 'auto'], modelsDiscovery: { prompt: '/models', maxAgeHours: 24 } },
        // the same mock: its hooks never answer until the run settings turn them off
        acphooks: { launcher: 'mock', label: 'ACP hooks', transport: 'acp', command: [process.execPath, path.join(CODE_ROOT, 'scripts', 'mock-acp-agent.js')], approvalMode: 'auto', approvalModes: ['default', 'auto'] },
        acpnohooks: { launcher: 'mock', label: 'ACP no hooks', transport: 'acp', userHooks: false, command: [process.execPath, path.join(CODE_ROOT, 'scripts', 'mock-acp-agent.js')], approvalMode: 'auto', approvalModes: ['default', 'auto'] },
        // a process that never answers initialize (and says nothing on stderr)
        acpdead: { launcher: 'mock', label: 'ACP dead', transport: 'acp', firstEventTimeoutMs: 1500, command: [process.execPath, deadAgent], approvalMode: 'auto', approvalModes: ['default', 'auto'] },
        // the same mock, unloaded after 0.4 s idle
        // the first session/new times out on a SessionStart hook, the next one works
        acpnewhook: { launcher: 'mock', label: 'ACP new hook', transport: 'acp', env: { MOCK_ACP_NEW_HOOKTIMEOUT: path.join(root, 'newhook.flag') }, command: [process.execPath, path.join(CODE_ROOT, 'scripts', 'mock-acp-agent.js')], approvalMode: 'auto', approvalModes: ['default', 'auto'] },
        acpchatty: { launcher: 'mock', label: 'ACP chatty', transport: 'acp', firstEventTimeoutMs: 1500, command: [process.execPath, chattyAgent], approvalMode: 'auto', approvalModes: ['default', 'auto'] },
        acpidle: { launcher: 'mock', label: 'ACP idle', transport: 'acp', acpIdleMin: 0.4 / 60, command: [process.execPath, path.join(CODE_ROOT, 'scripts', 'mock-acp-agent.js')], approvalMode: 'auto', approvalModes: ['default', 'auto'] },
      },
    },
  });
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(srv.url + p, { method, headers: { 'x-harness-token': srv.token, 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
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
/** The `update` objects of a sanitized ACP fixture: bare updates or whole JSON-RPC session/update lines; requests are skipped. */
const fixture = (name) => fs.readFileSync(path.join(CODE_ROOT, 'test', 'fixtures', name), 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).filter((m) => !m.method || m.method === 'session/update').map((m) => m.params?.update ?? m);
const tools = (evs) => evs.filter((e) => e.type === 'tool_call').map((e) => [e.id, e.name, e.input]);
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
  // the per-step usage rides in _meta of the agent's own chunks: it becomes the ring's «последний ход»
  assert.deepEqual(acpEvents({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' }, _meta: { usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 4 } } }),
    [{ type: 'usage', contextTokens: 12, input: 10, output: 2, cacheRead: 4 }, { type: 'text', text: 'x', delta: true }]);
  // only the harness server: a chat's own MCP list is the CLI's settings.json, and the agent waits for every server it
  // is given before it answers session/new; `timeoutMs` (mcp.acpStartTimeoutMs) is where a dead one gives way
  assert.deepEqual(acpMcpServers({ command: 'node', args: ['h.js'], env: { A: '1' } }, { timeoutMs: 5000 }),
    [{ name: 'harness', command: 'node', args: ['h.js'], env: [{ name: 'A', value: '1' }], timeoutMs: 5000 }]);
  assert.equal(acpMcpServers({ command: 'node' })[0].timeoutMs, 30000, 'a server that does not start gives way after 30 s');
});

test('a prompt streams text, thought and plan; the next message reuses the same agent session', async () => {
  await idle(chat.id);
  const s = await session(chat.id);
  assert.ok(s.externalSessionId);
  const msgs = await messages(chat.id);
  assert.ok(msgs.some((m) => m.kind === 'thought' && m.text === 'думаю'));
  // the plan message is kept current: the step was in progress, the turn's end closed it
  assert.ok(msgs.some((m) => m.kind === 'system' && /^План:\n✓ ответить$/.test(m.text)));
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

test('tool cards carry the real tool and its arguments: «2 searches» announced as `Glob`/`Поиск` with {}, the ToolCall wrapper as the harness tool', () => {
  const evs = fixture('gigacode.acp-toolcall.ndjson').flatMap(acpEvents);
  assert.deepEqual(tools(evs).slice(0, 3), [
    ['call_glob1', 'glob', null], // announced before the pattern was known: the name is there at once, the input follows
    ['call_glob2', 'glob', null],
    ['call_search3', 'search', null],
  ]);
  assert.deepEqual(evs.filter((e) => e.type === 'tool_input').slice(0, 3).map((e) => [e.id, e.input.pattern]),
    [['call_glob1', '**/harness/**/*.md'], ['call_glob2', '.gigacode/agents/**/*.md'], ['call_search3', '**/harness/**/*.md']]);
  assert.deepEqual(evs.find((e) => e.type === 'tool_input' && e.id === 'call_shell4').input, { command: 'git rev-parse --short HEAD', description: 'Show the short HEAD hash' });
  // a wrapper whose call is not named yet (its JSON is in the title, the tool is not): the card waits for the update,
  // and «tool» is the name the turn keeps until then
  assert.deepEqual(tools(evs).find(([id]) => id === 'call_wrapper6'), ['call_wrapper6', 'tool', null], 'no card of the wrapper while the name is on its way');
  const agentCall = evs.find((e) => e.type === 'tool_input' && e.id === 'call_wrapper6');
  assert.deepEqual([agentCall.name, agentCall.input.subagent_type], ['mcp__harness__agent', 'general-purpose']);
  assert.deepEqual(tools(evs).find(([id]) => id === 'call_ask7').slice(0, 2), ['call_ask7', 'AskUserQuestion'], 'a question is its own tool: the card says so at once');
  assert.deepEqual(tools(evs).find(([id]) => id === 'call_search5').slice(0, 2), ['call_search5', 'tool_search']);
  assert.deepEqual(tools(evs).find(([id]) => id === 'call_edit8').slice(0, 2), ['call_edit8', 'write_file']);
  assert.deepEqual(evs.filter((e) => e.type === 'tool_result').map((e) => [e.id, e.isError]),
    [['call_glob1', false], ['call_glob2', false], ['call_search3', false], ['call_shell4', false], ['call_search5', false], ['call_wrapper6', false], ['call_ask7', false]]);
});

test('a call announced with rawInput {} gets its input from the later tool_call_update (card and sub-agent chat)', async () => {
  const lines = fixture('gigacode.acp-late-input.ndjson');
  const evs = lines.flatMap(acpEvents);
  assert.deepEqual([...new Set(evs.filter((e) => e.type === 'tool_input').map((e) => e.id))], ['toolu_01', 'toolu_02']);
  // both are announced as a wrapper being prepared: «tool_search» is the wrapper's own tool name (known at once), and
  // the card of the wrapped call appears with the update that names it
  assert.deepEqual(evs.filter((e) => e.type === 'tool_call').map((e) => [e.name, e.input]), [['tool_search', null], ['tool', null]], 'no card of the wrapper while the name is on its way');

  await send(chat.id, '#late');
  // the wrapper's own call is finished before its tool is named; the sub-agent chat is opened by the next update
  const agent = await waitFor(async () => (await messages(chat.id)).find((m) => m.tool?.id === 'toolu_02' && m.tool.subSessionId), { what: 'sub-agent chat' });
  const tool = await waitFor(async () => (await messages(chat.id)).find((m) => m.tool?.id === 'toolu_01' && m.tool.status === 'ok'), { what: 'ToolSearch done' });
  assert.deepEqual(tool.tool.input, { query: 'harness', max_results: 5 });
  assert.deepEqual([agent.tool.name, agent.tool.input.subagent_type], ['mcp__harness__agent', 'general-purpose']);
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

test('the model is set over the ACP session: one the catalogue names, or a note and the agent\'s own default', async () => {
  const fit = async (model) => {
    const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpmock', cwd, model, prompt: 'привет' })).body;
    await idle(s.id);
    return messages(s.id);
  };
  // the catalogue's ids keep the context suffix the backend does not take in argv: the session gets the very id
  assert.ok((await fit('GLM-5.3-Flash-262k')).some((m) => m.kind === 'assistant' && m.text.includes('ACP mock') && m.text.includes('[GLM-5.3-Flash-262k]')));
  const gone = await fit('Nope-1.0-262k');
  assert.ok(gone.some((m) => m.kind === 'system' && /Модели «Nope-1.0-262k» нет в каталоге сервера/.test(m.text)), JSON.stringify(gone.filter((m) => m.kind === 'system')));
  assert.ok(gone.some((m) => m.kind === 'assistant' && m.text.includes('ACP mock') && !m.text.includes('[')), 'the turn ran with the agent\'s own default');
});

test('«Полный доступ»: a permission request is allowed once by the harness, no card; the CLI\'s question is ONE card that pauses the turn', async () => {
  const full = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpmock', cwd, approvalMode: 'auto', prompt: '#perm' })).body;
  await idle(full.id);
  const msgs = await messages(full.id);
  assert.ok(!msgs.some((m) => m.kind === 'permission'), 'no permission card in full access');
  assert.ok((await said(full.id)).at(-1).includes('записано'));
  fs.rmSync(path.join(cwd, 'out.txt'), { force: true });

  await send(full.id, '#ask');
  const q = await waitFor(async () => (await messages(full.id)).find((m) => m.kind === 'question' && !m.question.answered), { what: 'question card' });
  assert.deepEqual(q.question.options?.map((o) => (typeof o === 'string' ? o : o.label)), ['Конфиг', 'Код']);
  assert.ok(!(await messages(full.id)).some((m) => m.kind === 'permission'), 'not a second card for the same question');
  // the card is written a moment before waitingFor: wait for the state instead of reading it at once (a flake under load)
  await waitFor(async () => { const x = await session(full.id); return x.status === 'running' && x.waitingFor === 'answer'; }, { what: 'the agent really waits' });
  await send(full.id, 'Ответ на вопрос «Что проверяем?»: Код, и ещё тесты');
  await waitFor(async () => (await said(full.id)).some((t) => t.includes('turn 3')), { what: 'the answer as the next turn' });
  await idle(full.id);
  const after = await messages(full.id);
  assert.ok(!after.some((m) => m.text === 'Остановлено пользователем'), 'paused for the answer, not «stopped»');
  assert.ok(!after.some((m) => m.text?.includes('вопрос: submit')), 'the question was not «submitted» with a default');
  assert.equal((await session(full.id)).status, 'idle');
});

test('a harness MCP tool is allowed without a card in the default mode too: the agent asking «may I?» never waits', async () => {
  const plain = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpmock', cwd, approvalMode: 'default', prompt: '#mcp' })).body;
  await idle(plain.id);
  const msgs = await messages(plain.id);
  assert.ok(!msgs.some((m) => m.kind === 'permission'), 'no card for the harness tool');
  assert.ok(msgs.some((m) => m.kind === 'system' && m.text === 'Разрешено автоматически: mcp__harness__ask {"question":"Куда коммитить?"}'), JSON.stringify(msgs.filter((m) => m.kind === 'system')));
  assert.ok((await said(plain.id)).at(-1).includes('спросил harness'));
  const call = msgs.find((m) => m.tool?.id === 't2');
  assert.deepEqual([call.tool.name, call.tool.input], ['mcp__harness__ask', { question: 'Куда коммитить?' }], 'the card names the wrapped tool, not ToolCall');
  assert.equal((await session(plain.id)).waitingFor ?? null, null);
});

test('«Полный доступ» leaves a line instead of a card: every permission request is answered by the harness', async () => {
  const full = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpmock', cwd, approvalMode: 'auto', prompt: '#mcp' })).body;
  await idle(full.id);
  const msgs = await messages(full.id);
  assert.ok(!msgs.some((m) => m.kind === 'permission'), 'no card in full access');
  const line = msgs.find((m) => m.kind === 'system' && m.text.startsWith('Разрешено автоматически:'));
  assert.match(line.text, /^Разрешено автоматически: mcp__harness__ask /);
  assert.ok((await said(full.id)).some((t) => t.includes('спросил harness')), JSON.stringify(await said(full.id)));
});

test('permission request: held until answered (allow writes the file, reject is reported), the card shows the answer', async () => {
  await h.api('PATCH', `/api/sessions/${chat.id}`, { approvalMode: 'default' }); // asks (not «Полный доступ»)
  await waitFor(async () => (await session(chat.id)).approvalMode === 'default', { what: 'default mode' });
  await send(chat.id, '#perm');
  const card = await waitFor(async () => (await messages(chat.id)).find((m) => m.kind === 'permission' && !m.permission.resolved), { what: 'permission card' });
  assert.deepEqual([card.permission.transport, card.permission.tool, card.permission.options.map((o) => o.id)], ['acp', 'Запись out.txt', ['allow', 'reject']]);
  const call = (await messages(chat.id)).find((m) => m.tool?.id === 't1');
  assert.match(String(call.tool.input?.path), /out\.txt$/, 'the call announced with {} gets its arguments from the permission request');
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

test('an ACP process whose MCP servers never connected is named in the chat; one that asked for the harness tools is not', async () => {
  const lone = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpmock', cwd, prompt: '#slow' })).body; // the mock connects no MCP
  await idle(lone.id);
  assert.ok((await messages(lone.id)).some((m) => m.kind === 'system' && /не подключились MCP-серверы/.test(m.text)));
  const ok = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpmock', cwd, prompt: '#slow' })).body;
  await waitFor(async () => (await session(ok.id)).warm, { what: 'process up' });
  await h.api('GET', '/api/agent/tools', undefined, { 'x-harness-session': ok.id }); // what harness-mcp does when GigaCode connects it
  await idle(ok.id);
  assert.ok(!(await messages(ok.id)).some((m) => /не подключились MCP-серверы/.test(m.text)));
});

test('a session that will not load: a few tries, then a new one that gets the harness\'s record of the chat', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpmock', cwd, prompt: 'задача: поправь кеш' })).body;
  await idle(s.id);
  const ext = (await session(s.id)).externalSessionId;
  await send(s.id, '#die');
  await waitFor(async () => (await session(s.id)).status === 'error', { what: 'process death' });
  fs.rmSync(path.join(root, 'mock-state', `acp-${ext.replace(/[^\w-]/g, '_')}.json`)); // the CLI lost it: its load fails
  await send(s.id, 'что дальше?');
  await waitFor(async () => (await said(s.id)).some((t) => t.includes('(запись чата: задача: поправь кеш)')), { timeout: 30000, what: 'the recap reached the new session' });
  assert.ok((await messages(s.id)).some((m) => /не удалось загрузить сессию агента .* харнесс передал ей правила и краткую запись/.test(m.text)));
  assert.notEqual((await session(s.id)).externalSessionId, ext, 'a new CLI session');
  await idle(s.id);
  // the lost session's record is still this chat: never adopted as a «CLI chat» of its own
  await waitFor(() => (JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')).cliIgnored || []).includes(ext), { what: 'the old record ignored' });
});

test('an idle ACP process is unloaded (warm false) and reloaded with session/load on the next message', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpidle', cwd, prompt: 'привет' })).body;
  await idle(s.id);
  await waitFor(async () => (await session(s.id)).warm === false, { what: 'unloaded after idle' });
  // by default the agent keeps its own file system (GigaCode's «read before edit» guard sees its reads)
  assert.equal(records().find((r) => r.env.HARNESS_SESSION_ID === s.id).clientFs, false);
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

test('a GigaCode hook that never answers (hook-execution-response): said so, one retry on a fresh process, hooks stay on', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acphooks', cwd, prompt: 'сделай #hooktimeout' })).body;
  const err = await waitFor(async () => (await messages(s.id)).find((m) => m.kind === 'error'), { timeout: 30000, what: 'the retry failed too' });
  const ms = await messages(s.id);
  assert.equal(ms.filter((m) => m.kind === 'system' && /Хук ACP hooks не ответил вовремя .*Повторяю ход на новом процессе/.test(m.text)).length, 1, JSON.stringify(ms.map((m) => m.text)));
  assert.match(err.text, /Хук ACP hooks не ответил вовремя .*~\/\.gigacode\/settings\.json .*userHooks: false/s);
  assert.ok(!ms.some((m) => /disableAllHooks/.test(m.text)), 'nothing switched off by itself');
});

test('agents.<id>.userHooks: false — the harness runs go without the hooks (disableAllHooks in the run settings)', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpnohooks', cwd, prompt: 'сделай #hooktimeout' })).body;
  await waitFor(async () => (await said(s.id)).some((t) => /ACP mock, turn 1/.test(t)), { timeout: 30000, what: 'the turn ran without hooks' });
  assert.ok(!(await messages(s.id)).some((m) => m.kind === 'error'));
  await idle(s.id);
});

test('an ACP agent that never answers initialize: the start is retried by itself, the messages wait in the queue', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpdead', cwd, prompt: 'привет' })).body;
  const err = await waitFor(async () => (await messages(s.id)).find((m) => m.kind === 'error'), { timeout: 30000, what: 'the start failed' });
  assert.match(err.text, /ACP initialize: нет ответа за \d+ с/);
  assert.match(err.text, /Повторю запуск сам через 20 с \(попытка 2 из 4\)/);
  const x = await session(s.id);
  assert.equal(x.queue.length, 1);
  assert.ok(x.startRetryAt > Date.now());
  await h.api('POST', `/api/sessions/${s.id}/stop`);
  assert.equal((await session(s.id)).startRetryAt, null, 'Stop cancels the retry and its countdown');
});

test('patientRequest: waits while the agent writes to stderr, fails after a silence', async () => {
  const errFile = path.join(root, 'patient.err.txt');
  fs.writeFileSync(errFile, '');
  const never = { request: () => new Promise(() => {}) };
  const started = Date.now();
  const writer = setInterval(() => fs.appendFileSync(errFile, '[perf] acp agent event loop stall\n'), 100);
  const p = patientRequest(never, 'initialize', {}, { idleMs: 400, errFile, pollMs: 50 });
  await assert.rejects(p, /ACP initialize: нет ответа/);
  clearInterval(writer);
  const took = Date.now() - started;
  // past the 400 ms silence limit while stderr grew, but never past 2 × the limit: a start that keeps writing is not forever
  assert.ok(took >= 700 && took < 1500, `took ${took} ms`);
  const answered = await patientRequest({ request: async () => 'ok' }, 'initialize', {}, { idleMs: 400, errFile });
  assert.equal(answered, 'ok');
});

test('«Переподключить MCP»: a new agent process on the same CLI session (session/load), the chat keeps its context', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpmock', cwd, prompt: 'привет' })).body;
  await idle(s.id);
  const ext = (await session(s.id)).externalSessionId;
  const pid = records().filter((r) => r.env.HARNESS_SESSION_ID === s.id).at(-1).pid;
  assert.equal((await h.api('POST', `/api/sessions/${s.id}/restart`, { keepContext: true })).status, 200);
  await waitFor(async () => (await session(s.id)).warm === false, { what: 'the old process unloaded' });
  await send(s.id, 'дальше');
  await waitFor(async () => (await said(s.id)).some((t) => /^loaded, ACP mock, turn 2\./.test(t)), { what: 'the same CLI session, loaded by a new process' });
  assert.equal((await session(s.id)).externalSessionId, ext);
  assert.notEqual(records().filter((r) => r.env.HARNESS_SESSION_ID === s.id).at(-1).pid, pid, 'a new process');
  assert.ok((await messages(s.id)).some((m) => m.kind === 'system' && /Агент перезапущен: MCP-серверы подключаются заново/.test(m.text)));
  await idle(s.id);
});

test('a hook timeout while the session starts (session/new): the messages wait in the queue once, never run twice', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpnewhook', cwd, prompt: 'первое' })).body;
  const err = await waitFor(async () => (await messages(s.id)).find((m) => m.kind === 'error'), { timeout: 30000, what: 'the start failed' });
  assert.match(err.text, /Хук ACP new hook не ответил вовремя/);
  assert.match(err.text, /Повторю запуск сам через 20 с/);
  // the person does not wait for the automatic retry: the queue goes with the next message, in one turn
  await send(s.id, 'второе');
  await waitFor(async () => (await said(s.id)).some((t) => /ACP mock, turn 1\./.test(t)), { timeout: 20000, what: 'the turn ran' });
  await idle(s.id);
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(!(await said(s.id)).some((t) => /turn 2/.test(t)), JSON.stringify(await said(s.id)));
  assert.equal((await session(s.id)).queue.length, 0);
});

test('a sub-agent whose turn the harness retries (hook timeout) is not reported «no_report» to its caller before the retry', async () => {
  const caller = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acphooks', cwd, prompt: 'привет' })).body;
  await idle(caller.id);
  const r = await h.api('POST', '/api/agent/worker_run', { spec: 'сделай #hooktimeout', background: true }, { 'x-harness-session': caller.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.sessionId;
  // the hook retry ran (and failed too): the harness goes on continuing it by itself
  await waitFor(async () => (await messages(id)).some((m) => m.kind === 'error'), { timeout: 30000, what: 'the retry failed' });
  await new Promise((r) => setTimeout(r, 500));
  const child = await session(id);
  assert.equal(child.report ?? null, null, `the caller was told ${JSON.stringify(child.report)} while the harness still retries`);
  assert.ok(!child.archived);
  await h.api('POST', `/api/sessions/${id}/stop`);
});

test('Stop during a long ACP start (the agent writes to stderr, initialize not answered yet) ends the turn at once', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpchatty', cwd, prompt: 'привет' })).body;
  await new Promise((r) => setTimeout(r, 700));
  const at = Date.now();
  await h.api('POST', `/api/sessions/${s.id}/stop`);
  const x = await waitFor(async () => { const y = await session(s.id); return y.status === 'stopped' && !y.phase && !y.warm && y; }, { timeout: 10000, what: 'the turn ended' });
  assert.ok(Date.now() - at < 3000, `stopped after ${Date.now() - at} ms`);
  assert.equal(x.queue.length, 0);
  assert.ok(!(await messages(s.id)).some((m) => m.kind === 'error'), 'a stop is not an error');
});

test('an idle ACP process that was busy with a helper prompt when its idle time ran out is still unloaded after it', async () => {
  const warm = new Map();
  const acp = createAcp({ onWarm: (sid, w) => warm.set(sid, w) });
  const o = {
    sid: 'idle-helper', agent: 'idlehelper', launcher: { acpArgs: () => ['--acp'] }, ctx: { harnessMcp: { url: 'http://127.0.0.1:9/mcp' } },
    command: { file: process.execPath, args: [path.join(CODE_ROOT, 'scripts', 'mock-acp-agent.js')] }, cwd, env: process.env,
    logFile: path.join(root, 'idle-helper.log'), roots: [cwd], idleMs: 300, prompt: 'привет', onEvent: () => {},
  };
  try {
    assert.equal((await acp.turn(o).done).sawResult, true);
    const helper = acp.helperPrompt('idlehelper', '#slow'); // ~4 s: the idle time runs out meanwhile
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(acp.warm('idle-helper'), true, 'not unloaded under a running helper');
    await helper;
    await waitFor(() => !acp.warm('idle-helper'), { timeout: 3000, what: 'unloaded after the helper' });
    assert.equal(warm.get('idle-helper'), false);
  } finally {
    acp.close();
  }
});

test('a sub-agent whose start is retried later by itself is not reported «failed» to its caller meanwhile', async () => {
  const flag = path.join(root, 'newhook.flag');
  fs.writeFileSync(flag, '1'); // the caller starts normally
  const caller = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpnewhook', cwd, prompt: 'привет' })).body;
  await idle(caller.id);
  fs.rmSync(flag); // ...its sub-agent's first session/new times out
  const r = await h.api('POST', '/api/agent/worker_run', { spec: 'посмотри', background: true }, { 'x-harness-session': caller.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.sessionId;
  const err = await waitFor(async () => (await messages(id)).find((m) => m.kind === 'error'), { timeout: 30000, what: 'the start failed' });
  assert.match(err.text, /Повторю запуск сам через 20 с/);
  await new Promise((r) => setTimeout(r, 500));
  const child = await session(id);
  assert.equal(child.report ?? null, null, `the caller was told ${JSON.stringify(child.report)} before the retry`);
  assert.equal(child.queue.length, 1);
  await h.api('POST', `/api/sessions/${id}/stop`);
});

test('plan check: a top-level agent that ends with open plan steps is asked once; the same open steps are not asked again', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpmock', cwd, prompt: 'сделай #planopen' })).body;
  const nudge = await waitFor(async () => (await messages(s.id)).find((m) => m.kind === 'user' && /В твоём плане не закрыты пункты: «прогнать тесты»/.test(m.text)), { timeout: 30000, what: 'asked about the open step' });
  assert.equal(nudge.from, 'harness');
  await idle(s.id);
  // its answer closed the plan: nothing more; and the open step never brings a second reminder
  assert.equal((await messages(s.id)).filter((m) => /В твоём плане не закрыты пункты/.test(m.text)).length, 1);
  await send(s.id, 'ещё раз #planopen');
  await idle(s.id);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await messages(s.id)).filter((m) => /В твоём плане не закрыты пункты/.test(m.text)).length, 1, 'the same open steps: no second reminder');
});

test('plan check off (orchestration.planCheck: false): nothing is asked', async () => {
  assert.equal((await h.api('PUT', '/api/settings', { orchestration: { planCheck: false } })).body.orchestration.planCheck, false);
  try {
    const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'acpmock', cwd, prompt: 'сделай #planopen' })).body;
    await idle(s.id);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!(await messages(s.id)).some((m) => /В твоём плане не закрыты пункты/.test(m.text)));
  } finally {
    await h.api('PUT', '/api/settings', { orchestration: { planCheck: true } });
  }
});
