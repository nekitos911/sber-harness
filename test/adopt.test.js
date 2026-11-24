// CLI chats are ordinary chats: records of the agent CLI become harness chats (origin cli), continued with --resume,
// never re-adopted once archived; helper runs, runtime files and harness-owned records are not adopted. GigaCode writes
// no cwd into a record (the folder comes on the first user message, the path name is its sha256), Gemini names it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startTestServer, tmpDir, rmrf, makeRepo, waitFor } from './helpers.js';
import { cliTitle, isServiceChat } from '../server/adopt.js';

const root = tmpDir();
const repo = path.join(root, 'репо');
const store = path.join(root, '.gigacode', 'tmp');
const other = path.join(root, 'чужой');
const argvFile = path.join(root, 'argv.ndjson');
const sha = (p) => createHash('sha256').update(p).digest('hex');
const chats = path.join(store, sha(path.resolve(repo)), 'chats');
let h;
let ws;
let homeBefore;

const at = (min) => new Date(Date.now() - min * 60000).toISOString();
const record = (file, sessionId, messages, extra = {}) => {
  const p = path.join(chats, file);
  // <hash>/chats/<file>: the chats folder is named by the folder's sha256 (the record itself may not repeat it)
  fs.writeFileSync(p, JSON.stringify({ sessionId, projectHash: path.basename(path.dirname(path.dirname(p))), startTime: at(60), lastUpdated: at(5), ...extra, messages }));
  return p;
};
// GigaCode: the folder is the first line of the user message, the path name is its sha256
const gigacode = (content, min = 30) => ({ id: `u${Math.random()}`, timestamp: at(min), type: 'user', content: `${repo}\n${content}` });
const answer = (content, min = 29) => ({ id: `g${Math.random()}`, timestamp: at(min), type: 'gemini', content });

before(async () => {
  makeRepo(repo);
  fs.mkdirSync(other, { recursive: true });
  fs.mkdirSync(chats, { recursive: true });
  record('session-cli.json', 'cli-chat-1', [gigacode('Сделай отчёт по лимитам\nподробности'), answer('Готово')]);
  record('session-rt.runtime.json', 'rt-1', [gigacode('состояние')]);
  record('session-owned.json', 'owned-1', [gigacode('чат из harness'), answer('ок')]);
  record('session-models.json', 'helper-1', [gigacode('/models'), answer('| ID |')]);
  record('session-clear.json', 'slash-1', [gigacode('/clear')]);
  // a real CLI chat started just now: an earlier one is not refreshed into it before its own adoption
  record('session-cli.json', 'cli-chat-1', [gigacode('Сделай отчёт по лимитам\nподробности', 25), answer('Готово', 24)], { lastUpdated: at(25) });
  // a record whose named folder hashes to another path name: its folder is taken for what it says
  fs.mkdirSync(path.join(store, 'foreign', 'chats'), { recursive: true });
  fs.writeFileSync(path.join(store, 'foreign', 'chats', 'session-elsewhere.json'),
    JSON.stringify({ sessionId: 'elsewhere-1', startTime: at(60), lastUpdated: at(4), messages: [gigacode('чужой проект', 20)] }));
  // the home folder is emptied for this run: the real CLI records of this machine are not part of the test
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  const home = tmpDir('дом ');
  homeBefore = process.env.USERPROFILE;
  for (const key of ['USERPROFILE', 'HOME']) if (homeBefore && process.env[key]) process.env[key] = home;
  h = await startTestServer({ history: { adopt: true }, agents: { mock: { history: { dirs: [path.join(store, '*', 'chats')] } } } });
  ws = (await h.api('POST', '/api/workspaces', { path: repo })).body;
});
after(async () => {
  delete process.env.MOCK_AGENT_ARGV_FILE;
  if (homeBefore) { process.env.USERPROFILE = homeBefore; process.env.HOME = homeBefore; }
  await h.close();
  rmrf(root);
});

const sessions = async () => (await h.api('GET', '/api/state')).body.sessions;
const messages = async (id) => (await h.api('GET', `/api/sessions/${id}/messages`)).body;

test('title and service filters', () => {
  assert.equal(cliTitle('Ты работаешь внутри harness. Субагентов…\n\n/full-task PROJ-1 поправь\nещё'), 'full-task PROJ-1 поправь');
  // a helper the harness ran is not a CLI chat of the person (seen over ACP: two «Субагенты не з…» rows)
  assert.equal(isServiceChat(['Субагенты не запускают своих субагентов: выполни это сам.\n\n[harness] Ты — субагент (сессия s_1), запущенный X.\n\n## Задание\nпрочитай']), true);
  assert.equal(isServiceChat(['[harness] You are a WORKER session in a local multi-agent harness.\nTask: T-1']), true);
  assert.equal(isServiceChat(['Ты работаешь внутри harness. Субагентов…\n\nсделай X'], 1), false, 'a top-level chat of the harness may come back');
  assert.deepEqual([isServiceChat(['/models'], 1), isServiceChat(['/compress'], 1), isServiceChat(['HARNESS_GENERATE_MESSAGE\n…'], 1), isServiceChat(['/clear'], 0), isServiceChat(['/clear', 'дальше'], 1), isServiceChat(['привет'], 1)],
    [true, true, true, true, false, false]);
  assert.equal(isServiceChat(['привет'], 0), true, 'one message and nothing back a person would read: a probe');
});

test('only the real CLI chat is adopted: titled, grouped, transcript from the record (refreshed before a harness turn)', async () => {
  // a harness chat owns it: the record it continues is the chat's own, never adopted as a second one
  assert.equal((await h.api('POST', '/api/history/mock/owned-1/continue', { cwd: repo })).body.externalSessionId, 'owned-1');
  // every record ever written (`adoptDays: 0`): the server's own pass only looks at the configured window
  const r = (await h.api('POST', '/api/history/adopt')).body;
  // the adoption pass at server start (default window) may have taken records already: their timestamps still tell
  assert.ok(r.adopted <= 1, JSON.stringify(await sessions()));
  // the helper runs and the one-command probes wait for `refreshed`; the one real CLI chat and the continued one are here
  const cli = (await sessions()).filter((s) => s.origin === 'cli');
  // the records really written under the home folder (the agent's own configured folders) are not part of the test
  assert.deepEqual(cli.filter((x) => x.cwd === path.resolve(repo)).map((x) => x.externalSessionId).sort(), ['cli-chat-1', 'owned-1']);
  const s = cli.find((x) => x.externalSessionId === 'cli-chat-1');
  // the folder came from the record; the title is the first meaningful line, the folder line left out
  assert.deepEqual([s.externalSessionId, s.title, path.resolve(s.cwd), s.status, s.agent], ['cli-chat-1', 'Сделай отчёт по лимитам', path.resolve(repo), 'idle', 'mock']);
  // grouped by the repository, like the chat opened from a record (see `continuing in the UI` for the place itself)
  assert.equal(s.workspaceId, (await sessions()).find((x) => x.externalSessionId === 'owned-1').workspaceId);
  assert.deepEqual((await messages(s.id)).map((m) => m.kind), ['user', 'assistant']);
  assert.ok(Math.abs(s.createdAt - (Date.now() - 60 * 60000)) < 30000, 'created when the CLI chat started (sidebar order), not when adopted');
  assert.equal((await h.api('POST', '/api/history/adopt')).body.adopted, 0, 'once');

  // the user went on in the CLI before touching it in the UI
  record('session-cli.json', 'cli-chat-1', [gigacode('Сделай отчёт по лимитам'), answer('Готово'), gigacode('и ещё раздел', 3), answer('добавил', 2)]);
  assert.equal((await h.api('POST', '/api/history/adopt')).body.refreshed, 1);
  assert.deepEqual((await messages(s.id)).map((m) => m.text), [(await messages(s.id))[0].text, 'Готово', 'и ещё раздел', 'добавил']);
});

test('a record naming another folder is not taken for this project', async () => {
  const r = await h.api('POST', '/api/history/adopt');
  assert.ok((await sessions()).every((s) => s.externalSessionId !== 'elsewhere-1'), JSON.stringify(r.body));
});

test('«Сбросить статус» starts a fresh CLI session, not --resume: the next turn rereads settings and MCP servers', async () => {
  const s = (await sessions()).find((x) => x.externalSessionId === 'cli-chat-1');
  assert.ok(s, 'the adopted CLI chat');
  const runs = () => fs.existsSync(argvFile) ? fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.env.HARNESS_SESSION_ID === s.id) : [];
  const before = runs().length;
  const turn = async () => { await waitFor(async () => { const x = (await sessions()).find((y) => y.id === s.id); return x.status === 'idle' && !x.pid && !x.turnClosing; }, { what: 'turn' }); };
  // an ordinary turn continues the CLI session (--resume); the restart takes that away from the next one
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'продолжим' });
  const continued = await waitFor(() => runs()[before], { what: 'resumed run' });
  assert.equal(continued.argv[continued.argv.indexOf('--resume') + 1], 'cli-chat-1', 'an ordinary turn continues the CLI session');
  assert.ok((await sessions()).find((x) => x.id === s.id).cliImportedAt, 'the first harness turn took the chat over');
  await turn();

  assert.equal((await h.api('POST', `/api/sessions/${s.id}/restart`)).status, 200);
  assert.equal((await sessions()).find((x) => x.id === s.id).externalSessionId, null);
  const mark = runs().length;
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'с чистого листа' });
  const fresh = await waitFor(() => runs()[mark], { what: 'fresh run' });
  assert.ok(!fresh.argv.includes('--resume'), `no --resume: ${JSON.stringify(fresh.argv)}`);
  await turn(); // its own CLI session comes with the next turn's stream: the mock reports one, as the real CLI does
  const own = (await sessions()).find((x) => x.id === s.id);
  assert.notEqual(own.externalSessionId, 'cli-chat-1', 'no longer on the old CLI session');
});

test('an adopted chat whose restarted turn took a new CLI session stays one chat: the old record is not adopted again', async () => {
  const s = (await sessions()).find((x) => x.id && x.externalSessionId !== 'cli-chat-1' && x.cwd === path.resolve(repo) && x.title === 'Сделай отчёт по лимитам');
  assert.ok(s, `the chat of the record, now on a fresh CLI session: ${JSON.stringify((await sessions()).map((x) => [x.id, x.title, x.cwd, x.externalSessionId]))}`);
  // the old record of the chat is not adopted again as another chat of the same folder
  assert.equal((await h.api('POST', '/api/history/adopt')).body.adopted, 0);
  assert.equal((await sessions()).filter((x) => x.title === 'Сделай отчёт по лимитам').length, 1);

  await h.api('PATCH', `/api/sessions/${s.id}`, { archived: true });
  record('session-cli.json', 'cli-chat-1', [gigacode('Сделай отчёт по лимитам'), answer('Готово'), gigacode('и ещё раздел', 3), answer('добавил', 2)], { lastUpdated: at(1) });
  assert.equal((await h.api('POST', '/api/history/adopt')).body.adopted, 0);

  // a chat deleted from the harness while its record stays is not a record of the person to adopt: the record is never
  // adopted again as a «CLI chat» of the same or another folder
  const own = (await sessions()).find((x) => x.externalSessionId === 'owned-1');
  assert.ok(own, 'the harness chat opened from the record');
  assert.equal((await h.api('DELETE', `/api/sessions/${own.id}?force=1`)).status, 200);
  assert.equal((await h.api('POST', '/api/history/adopt')).body.adopted, 0);
  assert.ok(!(await sessions()).some((x) => x.externalSessionId === 'owned-1'));
});

test('a CLI chat GigaCode is writing to right now is read-only here: messages and delete wait, «Перехватить» forces', async () => {
  record('session-live.json', 'cli-live-1', [gigacode('Живой чат в терминале', 2), answer('работаю', 1)], { lastUpdated: new Date().toISOString() });
  const r = (await h.api('POST', '/api/history/adopt')).body;
  const s = (await sessions()).find((x) => x.externalSessionId === 'cli-live-1');
  assert.ok(s, JSON.stringify({ r, ids: (await sessions()).map((x) => [x.externalSessionId, x.origin, x.archived]) }));
  assert.ok(s.cliLiveAt > Date.now() - 60000, 'the CLI wrote to it just now');
  const sent = await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'вмешаюсь' });
  assert.equal(sent.status, 409);
  assert.match(sent.body.error, /ведёт GigaCode в терминале/);
  assert.equal((await h.api('DELETE', `/api/sessions/${s.id}`)).status, 409);
  assert.equal((await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'перехватываю', force: true })).status, 200);
  await waitFor(async () => { const x = (await sessions()).find((y) => y.id === s.id); return x.status === 'idle' && !x.pid && !x.cliLiveAt; }, { what: 'taken over' });
});
