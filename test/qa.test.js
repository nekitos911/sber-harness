// QA pass: system folders, escalations to the user, error kinds, ad-hoc workers without board tasks, chat titles from
// the first message, per-project allow rules, the rework preview.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, tmpDir, rmrf, waitFor, makeRepo } from './helpers.js';
import { signedCode, titleFrom } from '../server/sessions.js';

let h;
const root = tmpDir();
const argvFile = path.join(root, 'argv.ndjson');
const repo = path.join(root, 'репо');
let ws;
before(async () => {
  makeRepo(repo);
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  h = await startTestServer();
  ws = (await h.api('POST', '/api/workspaces', { path: repo })).body;
});
after(async () => {
  delete process.env.MOCK_AGENT_ARGV_FILE;
  await h.close();
  rmrf(root);
});

const state = async () => (await h.api('GET', '/api/state')).body;
const session = async (id) => (await state()).sessions.find((s) => s.id === id);
const messages = async (id) => (await h.api('GET', `/api/sessions/${id}/messages`)).body;
const settled = (id) => waitFor(async () => { const s = await session(id); return !s.pid && !s.turnClosing && s.status !== 'running' && s; }, { what: `${id} settled` });
const runsOf = (sid) => fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.env.HARNESS_SESSION_ID === sid);
const allowedIn = (argv) => argv.flatMap((a, i) => (a === '--allowed-tools' ? [argv[i + 1]] : []));

test('only <dataDir>/chats, terms, runs are system; a projects folder inside the data dir is not', async () => {
  const plain = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock' })).body; // default folder: <dataDir>/chats/<id>
  assert.equal(plain.system, true);
  const proj = path.join(h.dataDir, 'projects', 'сервис');
  fs.mkdirSync(proj, { recursive: true });
  const inProjects = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: proj })).body;
  assert.equal(inProjects.system, false);
});

test('escalations: one open per session (count/time updated), plain text with actions; the user\'s own follow-up never escalates', async () => {
  const t = (await h.api('POST', '/api/tasks', { title: 'тихий агент', workspaceId: ws.id })).body;
  const key = (await state()).tasks.find((x) => x.id === t.id).key ?? null;
  const w = (await h.api('POST', `/api/tasks/${t.id}/assign`, { agent: 'mock', cwd: repo })).body;
  const esc = () => state().then((st) => st.notifications.filter((n) => n.kind === 'escalation' && n.sessionId === w.id));
  await waitFor(async () => (await esc()).length === 1, { what: 'escalation' });
  const [n1] = await esc();
  assert.match(n1.text, /^Агент .+ закончил ход без отчёта — откройте чат, чтобы продолжить или принять результат$/);
  if (key) assert.ok(n1.text.includes(key));
  assert.ok(!/worker_inspect|send_message/.test(n1.text), 'no agent-oriented hint for the user');
  assert.deepEqual(n1.actions, ['open', 'rework', 'accept']);
  await settled(w.id);

  await h.api('POST', `/api/sessions/${w.id}/messages`, { text: 'ещё немного' }); // the user's own follow-up
  await waitFor(async () => (await messages(w.id)).filter((m) => m.kind === 'user').length === 2, { what: 'follow-up' });
  await settled(w.id);
  assert.deepEqual((await esc()).map((n) => [n.id, n.count ?? 1]), [[n1.id, 1]]);

  const other = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo })).body;
  await h.api('POST', '/api/agent/send_message', { to: w.id, body: 'как дела?' }, { 'x-harness-session': other.id });
  await waitFor(async () => (await esc())[0]?.count === 2, { what: 'escalation updated' });
  assert.equal((await esc()).length, 1, 'still one open escalation');
  await settled(w.id);
});

test('error kinds: «not started» only before any output; signed exit codes; titles from the first message', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, prompt: '#crash' })).body;
  await waitFor(async () => (await session(s.id)).status === 'error', { what: 'first error' });
  assert.equal((await session(s.id)).errorKind, 'not_started');
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'нормально' });
  await waitFor(async () => (await session(s.id)).status === 'idle', { what: 'a normal turn' });
  assert.equal((await session(s.id)).errorKind, null);
  await settled(s.id);
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: '#crash' });
  await waitFor(async () => (await session(s.id)).status === 'error', { what: 'second error' });
  assert.equal((await session(s.id)).errorKind, 'turn');
  assert.deepEqual([signedCode(4294967295), signedCode(1), signedCode(null)], [-1, 1, null]);

  assert.equal(s.title, '#crash', 'the first message names the chat');
  assert.equal(titleFrom('/full-task PROJ-1 сделай\nподробности'), 'full-task PROJ-1 сделай');
  const named = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, title: 'Моё имя', prompt: 'текст' })).body;
  assert.equal(named.title, 'Моё имя');
  const empty = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo })).body;
  await h.api('POST', `/api/sessions/${empty.id}/messages`, { text: `  \n/full-task ${'x'.repeat(80)}` });
  assert.equal((await session(empty.id)).title, `full-task ${'x'.repeat(50)}`);
  await h.api('POST', `/api/sessions/${empty.id}/messages`, { text: 'второе' });
  assert.equal((await session(empty.id)).title, `full-task ${'x'.repeat(50)}`, 'only the first message');
  for (const id of [named.id, empty.id]) await settled(id);
});

test('worker_start with a spec and no task_id: no board task, a persistent child of the caller (task: true opts in)', async () => {
  const coord = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, role: 'coordinator' })).body;
  const before = (await state()).tasks.length;
  const w = (await h.api('POST', '/api/agent/worker_start', { spec: 'проверь логи #done ок' }, { 'x-harness-session': coord.id })).body;
  assert.deepEqual([w.taskId, w.parentId, w.persistent, w.title], [null, coord.id, true, 'проверь логи #done ок']);
  assert.equal((await state()).tasks.length, before, 'no board task');
  await settled(w.id);
  assert.equal((await session(w.id)).report?.status, 'done');
  const withTask = (await h.api('POST', '/api/agent/worker_start', { spec: 'с карточкой', task: true }, { 'x-harness-session': coord.id })).body;
  assert.ok(withTask.taskId);
  assert.equal((await state()).tasks.length, before + 1);
  await settled(withTask.id);
});

test('allow_project: a grant for every session of the project, on every turn; editable in /api/settings', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, approvalMode: 'auto', prompt: '#deny run_shell_command mvn test' })).body;
  await settled(s.id);
  const card = (await messages(s.id)).find((m) => m.kind === 'permission');
  assert.ok(card.permission.options.some((o) => o.id === 'allow_project'));
  await h.api('POST', `/api/sessions/${s.id}/permission`, { permissionId: card.permission.id, optionId: 'allow_project' });
  await settled(s.id);
  const st = (await h.api('GET', '/api/settings')).body;
  assert.deepEqual(st.permissions.allowedToolsByWorkspace[ws.id], ['run_shell_command(mvn)']);
  const other = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: repo, approvalMode: 'auto', prompt: 'другая сессия' })).body;
  await settled(other.id);
  assert.ok(allowedIn(runsOf(other.id)[0].argv).includes('run_shell_command(mvn)'), 'another session of the project gets it');
  assert.equal((await h.api('PUT', '/api/settings', { permissions: { allowedToolsByWorkspace: { [ws.id]: [] } } })).status, 200);
  assert.deepEqual((await h.api('GET', '/api/settings')).body.permissions.allowedToolsByWorkspace, {});
  assert.equal((await h.api('PUT', '/api/settings', { permissions: { allowedToolsByWorkspace: { нет: ['x'] } } })).status, 400);
  const outside = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', prompt: '#deny run_shell_command mvn test' })).body;
  await settled(outside.id);
  const card2 = (await messages(outside.id)).find((m) => m.kind === 'permission');
  assert.ok(!card2.permission.options.some((o) => o.id === 'allow_project'), 'no project: no project option');
});

test('rework preview: exactly the text the rework sends', async () => {
  const t = (await h.api('POST', '/api/tasks', { title: 'доработать', workspaceId: ws.id })).body;
  const w = (await h.api('POST', `/api/tasks/${t.id}/assign`, { agent: 'mock', cwd: repo })).body;
  await settled(w.id);
  const notes = 'поправь {title} и 100%';
  const preview = (await h.api('GET', `/api/tasks/${t.id}/rework-preview?notes=${encodeURIComponent(notes)}`)).body;
  assert.equal(preview.sessionId, w.id);
  await h.api('POST', `/api/tasks/${t.id}/rework`, { notes });
  await waitFor(async () => (await messages(w.id)).some((m) => m.kind === 'user' && m.text === preview.text), { what: 'the same text delivered' });
  await settled(w.id);
});
