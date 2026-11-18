// CLI chats are ordinary chats: records of the agent CLI become harness chats (origin cli), continued with --resume,
// never re-adopted once archived; helper runs, runtime files and harness-owned records are not adopted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startTestServer, tmpDir, rmrf, makeRepo, waitFor } from './helpers.js';
import { cliTitle, isServiceChat } from '../server/adopt.js';

const root = tmpDir();
const repo = path.join(root, 'репо');
const store = path.join(root, '.gigacode', 'tmp');
const argvFile = path.join(root, 'argv.ndjson');
let chats;
let h;
let ws;

const at = (min) => new Date(Date.now() - min * 60000).toISOString();
const record = (file, sessionId, messages, updatedMin = 5) => {
  const p = path.join(chats, file);
  fs.writeFileSync(p, JSON.stringify({ sessionId, projectHash: path.basename(path.dirname(chats)), startTime: at(60), lastUpdated: at(updatedMin), messages }));
  return p;
};
const user = (content, min = 30) => ({ id: `u${Math.random()}`, timestamp: at(min), type: 'user', content });
const answer = (content, min = 29) => ({ id: `g${Math.random()}`, timestamp: at(min), type: 'gemini', content });

before(async () => {
  makeRepo(repo);
  chats = path.join(store, createHash('sha256').update(path.resolve(repo)).digest('hex'), 'chats');
  fs.mkdirSync(chats, { recursive: true });
  record('session-cli.json', 'cli-chat-1', [user('[harness] старое вступление\nещё строка\n\nСделай отчёт по лимитам\nподробности'), answer('Готово')]);
  record('session-rt.runtime.json', 'rt-1', [user('состояние')]);
  record('session-owned.json', 'owned-1', [user('чат из harness'), answer('ок')]);
  record('session-models.json', 'helper-1', [user('/models'), answer('| ID |')]);
  record('session-clear.json', 'slash-1', [user('/clear')]);
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  h = await startTestServer({ history: { adopt: true }, agents: { mock: { history: { dirs: [path.join(store, '*', 'chats')] } } } });
  ws = (await h.api('POST', '/api/workspaces', { path: repo })).body;
});
after(async () => {
  delete process.env.MOCK_AGENT_ARGV_FILE;
  await h.close();
  rmrf(root);
});

const sessions = async () => (await h.api('GET', '/api/state')).body.sessions;
const messages = async (id) => (await h.api('GET', `/api/sessions/${id}/messages`)).body;

test('title and service filters', () => {
  assert.equal(cliTitle('Ты работаешь внутри harness. Субагентов…\n\n/full-task PROJ-1 поправь\nещё'), 'full-task PROJ-1 поправь');
  assert.deepEqual([isServiceChat(['/models']), isServiceChat(['/compress']), isServiceChat(['HARNESS_GENERATE_MESSAGE\n…']), isServiceChat(['/clear']), isServiceChat(['/clear', 'дальше']), isServiceChat(['привет'])],
    [true, true, true, true, false, false]);
});

test('only the real CLI chat is adopted: titled, grouped, transcript from the record (refreshed before a harness turn)', async () => {
  const owned = (await h.api('POST', '/api/history/mock/owned-1/continue', { cwd: repo })).body; // a harness chat owns it
  assert.equal(owned.externalSessionId, 'owned-1');
  const r = (await h.api('POST', '/api/history/adopt')).body;
  assert.equal(r.adopted, 1, JSON.stringify(r));
  const cli = (await sessions()).filter((s) => s.origin === 'cli');
  assert.equal(cli.length, 1);
  const [s] = cli;
  assert.deepEqual([s.externalSessionId, s.title, path.resolve(s.cwd), s.workspaceId, s.status, s.agent], ['cli-chat-1', 'Сделай отчёт по лимитам', path.resolve(repo), ws.id, 'idle', 'mock']);
  assert.deepEqual((await messages(s.id)).map((m) => m.kind), ['user', 'assistant']);
  assert.ok(Math.abs(s.createdAt - (Date.now() - 60 * 60000)) < 30000, 'created when the CLI chat started (sidebar order), not when adopted');
  assert.equal((await h.api('POST', '/api/history/adopt')).body.adopted, 0, 'once');

  // the user went on in the CLI before touching it in the UI
  record('session-cli.json', 'cli-chat-1', [user('[harness] старое вступление\n\nСделай отчёт по лимитам'), answer('Готово'), user('и ещё раздел', 3), answer('добавил', 2)], 1);
  assert.equal((await h.api('POST', '/api/history/adopt')).body.refreshed, 1);
  assert.deepEqual((await messages(s.id)).map((m) => m.text), [(await messages(s.id))[0].text, 'Готово', 'и ещё раздел', 'добавил']);
});

test('continuing in the UI resumes the CLI session; an archived adopted chat is never adopted again', async () => {
  const s = (await sessions()).find((x) => x.origin === 'cli');
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'продолжим' });
  const run = await waitFor(() => fs.existsSync(argvFile) && fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.env.HARNESS_SESSION_ID === s.id), { what: 'resumed run' });
  assert.equal(run.argv[run.argv.indexOf('--resume') + 1], 'cli-chat-1');
  await waitFor(async () => { const x = (await sessions()).find((y) => y.id === s.id); return x.status === 'idle' && !x.pid && !x.turnClosing; }, { what: 'turn' });
  assert.ok((await sessions()).find((x) => x.id === s.id).cliImportedAt);

  await h.api('PATCH', `/api/sessions/${s.id}`, { archived: true });
  fs.utimesSync(path.join(chats, 'session-cli.json'), new Date(), new Date(Date.now() + 1000));
  assert.equal((await h.api('POST', '/api/history/adopt')).body.adopted, 0);
  assert.equal((await sessions()).filter((x) => x.externalSessionId === 'cli-chat-1').length, 1);
});

test('a deleted harness chat does not come back from its CLI record as a «CLI chat»', async () => {
  const own = (await sessions()).find((x) => x.externalSessionId === 'owned-1');
  assert.ok(own && own.origin !== 'cli', 'a harness chat, not an adopted one');
  assert.equal((await h.api('DELETE', `/api/sessions/${own.id}?force=1`)).status, 200);
  assert.equal((await h.api('POST', '/api/history/adopt')).body.adopted, 0);
  assert.ok(!(await sessions()).some((x) => x.externalSessionId === 'owned-1'));
});
