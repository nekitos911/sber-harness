// What needs the user: waitingFor (ask, the CLI's question tool, headless permission denials), stalled turns.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseQuestion, permissionPattern } from '../server/sessions.js';
import { startTestServer, tmpDir, rmrf, waitFor } from './helpers.js';

const root = tmpDir();
const argvFile = path.join(root, 'argv.ndjson');
let h;

before(async () => {
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  h = await startTestServer({ session: { stallSec: 1, stallCheckSec: 0.2 } });
});
after(async () => {
  delete process.env.MOCK_AGENT_ARGV_FILE;
  await h.close();
  rmrf(root);
});

const session = async (id) => (await h.api('GET', '/api/state')).body.sessions.find((s) => s.id === id);
const messages = async (id) => (await h.api('GET', `/api/sessions/${id}/messages`)).body;
const idle = (id) => waitFor(async () => (await session(id)).status === 'idle', { what: `${id} idle` });
const runs = (sid) => fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.env.HARNESS_SESSION_ID === sid);
const modes = (sid) => runs(sid).map((r) => r.argv[r.argv.indexOf('--approval-mode') + 1]);
const allowedIn = (argv) => argv.flatMap((a, i) => (a === '--allowed-tools' ? [argv[i + 1]] : []));

test('ask: the session waits for an answer until something is delivered to it', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: '#ask Какой порт? | 8080 | 9090' })).body;
  await idle(s.id);
  assert.equal((await session(s.id)).waitingFor, 'answer');
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: '8080' });
  assert.equal((await session(s.id)).waitingFor, null);
  await idle(s.id);
});

test("the CLI's own question tool becomes a question card; its headless tool result stays hidden", async () => {
  assert.deepEqual(parseQuestion({ question: 'Да?', options: ['да', { label: 'нет', description: 'отказ' }] }),
    { text: 'Да?', options: [{ label: 'да' }, { label: 'нет', description: 'отказ' }], multiSelect: false });
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: '#question Какую БД? | Postgres | Oracle' })).body;
  await idle(s.id);
  const msgs = await messages(s.id);
  const q = msgs.find((m) => m.kind === 'question');
  assert.deepEqual(q.question, { id: 'q_1', text: 'Какую БД?', options: [{ label: 'Postgres' }, { label: 'Oracle' }], multiSelect: false });
  assert.ok(!msgs.some((m) => m.kind === 'tool' && m.tool.id === 'q_1'), 'no tool card for the question call');
  assert.equal((await session(s.id)).waitingFor, 'answer');
});

test('allow-list patterns from denied calls', () => {
  assert.equal(permissionPattern('run_shell_command', { command: 'cd /d C:\\x && git status' }), 'run_shell_command(git)');
  assert.equal(permissionPattern('run_shell_command', { command: '"C:/Program Files/Git/bin/git.exe" log' }), 'run_shell_command(git)');
  assert.equal(permissionPattern('run_shell_command', { command: 'npm.cmd test' }), 'run_shell_command(npm)');
  assert.equal(permissionPattern('write_file', { path: 'a' }), 'write_file');
});

test('headless denial: a card with the allow-list pattern; allow_once grants it for the next turn only; allow_session keeps it', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, approvalMode: 'auto', prompt: '#deny run_shell_command cd /d C:\\x && git status' })).body;
  await idle(s.id);
  const card = (await messages(s.id)).find((m) => m.kind === 'permission');
  assert.deepEqual([card.permission.tool, card.permission.pattern, card.permission.transport, card.permission.answered, card.permission.options.map((o) => o.id)],
    ['run_shell_command', 'run_shell_command(git)', 'headless', false, ['allow_once', 'allow_session', 'reject']]);
  assert.match(card.permission.reason, /requires permission to use "run_shell_command"/);
  assert.equal((await session(s.id)).waitingFor, 'permission');

  assert.equal((await h.api('POST', `/api/sessions/${s.id}/permission`, { permissionId: card.permission.id, optionId: 'maybe' })).status, 400);
  assert.equal((await h.api('POST', `/api/sessions/${s.id}/permission`, { permissionId: card.permission.id, optionId: 'allow_once' })).status, 200);
  assert.equal((await session(s.id)).waitingFor, null);
  await waitFor(async () => (await messages(s.id)).some((m) => m.kind === 'user' && m.text.startsWith('Разрешено: повтори run_shell_command cd /d')), { what: 'allow message' });
  await idle(s.id);
  const resolved = (await messages(s.id)).find((m) => m.kind === 'permission');
  assert.deepEqual([resolved.permission.resolved, resolved.permission.answered], ['allow_once', true]);
  assert.equal((await h.api('POST', `/api/sessions/${s.id}/permission`, { permissionId: card.permission.id, optionId: 'reject' })).status, 409);
  assert.deepEqual(allowedIn(runs(s.id)[1].argv), ['run_shell_command(git)'], 'the retry turn has the grant');
  assert.equal(modes(s.id)[1], modes(s.id)[0], 'no approval-mode escalation');

  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'дальше' });
  await waitFor(() => runs(s.id).length === 3, { what: 'turn 3' });
  await idle(s.id);
  assert.deepEqual(allowedIn(runs(s.id)[2].argv), [], 'a one-turn grant is gone afterwards');

  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: '#deny run_shell_command mvn -q test' });
  await idle(s.id);
  const second = (await messages(s.id)).filter((m) => m.kind === 'permission').at(-1);
  await h.api('POST', `/api/sessions/${s.id}/permission`, { permissionId: second.permission.id, optionId: 'allow_session' });
  await idle(s.id);
  assert.deepEqual((await session(s.id)).allowedTools, ['run_shell_command(mvn)']);
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'ещё' });
  await waitFor(() => runs(s.id).length === 6, { what: 'a later turn' });
  await idle(s.id);
  assert.deepEqual(allowedIn(runs(s.id)[5].argv), ['run_shell_command(mvn)'], 'a session grant stays');
  assert.deepEqual((await h.api('PATCH', `/api/sessions/${s.id}`, { allowedTools: [] })).body.allowedTools, []);

  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: '#deny edit' });
  await idle(s.id);
  const third = (await messages(s.id)).filter((m) => m.kind === 'permission').at(-1);
  await h.api('POST', `/api/sessions/${s.id}/permission`, { permissionId: third.permission.id, optionId: 'reject', note: 'лучше через git clean' });
  await waitFor(async () => (await messages(s.id)).some((m) => m.kind === 'user' && m.text === 'Не выполняй это (edit); найди другой путь или спроси.\n\nлучше через git clean'), { what: 'reject message' });
  await idle(s.id);
});

test('a sub-agent denial lands in the parent chat; a repeated stderr warning is one message with a count', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: '#subdeny #warn' })).body;
  await idle(s.id);
  const card = (await messages(s.id)).find((m) => m.kind === 'permission');
  const sub = (await h.api('GET', '/api/state')).body.sessions.find((x) => x.virtual && x.parentId === s.id);
  assert.deepEqual([card.permission.pattern, card.permission.fromSubSessionId, card.from], ['run_shell_command(mvn)', sub.id, sub.id]);
  assert.match(card.text, /^субагент java-reviewer: run_shell_command/);
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: '#warn' });
  await waitFor(async () => (await messages(s.id)).filter((m) => m.kind === 'user').length === 2, { what: 'turn 2' });
  await idle(s.id);
  const warns = (await messages(s.id)).filter((m) => m.kind === 'system' && m.text.startsWith('⚠ Warning: MCP server'));
  assert.deepEqual([warns.length, warns[0].count], [1, 2]);
});

test('stalled: a running turn without events past session.stallSec flips stalled, and back when it ends', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: root, prompt: '#silent' })).body;
  await waitFor(async () => (await session(s.id)).stalled === true, { what: 'stalled' });
  const st = await session(s.id);
  assert.deepEqual([st.status, st.lastEventAt], ['running', null]);
  await h.api('POST', `/api/sessions/${s.id}/stop`);
  await waitFor(async () => (await session(s.id)).pid === null, { what: 'stopped' });
  assert.equal((await session(s.id)).stalled, false);
});
