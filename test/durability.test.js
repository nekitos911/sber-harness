// "Nothing is lost on restart": persisted queue, identity-checked re-attach, worker_run waits and review loop across a
// restart, respawned terminals, db/transcript backups.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { CODE_ROOT } from '../server/config.js';
import { createStore } from '../server/store.js';
import { sameProcess, processStartTime, parseWmicDate } from '../server/runner.js';
import { tmpDir, rmrf, makeRepo, waitFor, waitPidGone } from './helpers.js';

const root = tmpDir();
const repo = path.join(root, 'репо');
const folder = path.join(root, 'папка чата');
fs.mkdirSync(folder);
makeRepo(repo);
process.env.MOCK_AGENT_STATE_DIR = path.join(root, 'mock-state');
const configFile = path.join(root, 'config.json');
fs.copyFileSync(path.join(CODE_ROOT, 'harness.config.json'), configFile);
after(() => rmrf(root));

const SLOW = 'slow '.repeat(20);
const overrides = {
  defaultAgent: 'mock', mcpServersFrom: null, worktreeRoot: null, history: { adopt: false },
  agents: { mock: { modelsDiscovery: null, agentsDir: path.join(root, 'профили') } },
  orchestration: { reviewMode: 'harness', review: { promptTemplate: '#slow #reviewer round={round} approve-at=1' } },
};

async function harness(dataDir) {
  const srv = await startServer({ dataDir, configFile, port: 0, configOverrides: overrides });
  const api = async (method, p, body) => {
    const res = await fetch(srv.url + p, { method, headers: { 'x-harness-token': srv.token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return res.json();
  };
  const state = () => api('GET', '/api/state');
  const session = async (id) => (await state()).sessions.find((s) => s.id === id);
  const messages = (id) => api('GET', `/api/sessions/${id}/messages`);
  return { srv, api, state, session, messages };
}

test('a restart in the middle of everything: turn, queue, worker_run wait, review loop and terminal all continue', async () => {
  const dataDir = path.join(root, 'данные 1');
  let h = await harness(dataDir);
  let finished = false;
  try {
    // (d) a review loop in progress: the worker reported, the reviewer is streaming slowly
    const ws = await h.api('POST', '/api/workspaces', { path: repo });
    const task = await h.api('POST', '/api/tasks', { title: 'Надёжность #done сделано', workspaceId: ws.id });
    await h.api('POST', `/api/tasks/${task.id}/start`, { agent: 'mock' });
    const reviewing = await waitFor(async () => {
      const t = (await h.state()).tasks.find((x) => x.id === task.id);
      return t.review?.state === 'reviewing' && t.review.reviewerSessionId && t;
    }, { what: 'review started' });
    const reviewerId = reviewing.review.reviewerSessionId;

    // (c) a worker_run caller waiting for its sub-agent
    const caller = await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: folder, prompt: '#run helper #slow #done готово' });
    await waitFor(async () => (await h.state()).sessions.find((s) => s.parentId === caller.id && s.waiter && s.status === 'running'), { what: 'sub-agent running' });

    // (a) a running slow turn + (b) two queued messages
    const chat = await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: folder, prompt: '#slow' });
    await waitFor(async () => (await h.messages(chat.id)).some((m) => m.kind === 'assistant' && m.text.includes('slow slow')), { what: 'slow output' });
    await h.api('POST', `/api/sessions/${chat.id}/messages`, { text: 'первое' });
    await h.api('POST', `/api/sessions/${chat.id}/messages`, { text: 'второе' });

    // (e) a terminal
    const term = await h.api('POST', '/api/sessions', { kind: 'terminal', cwd: os.tmpdir() });
    assert.equal(term.status, 'idle', JSON.stringify(term));

    await h.srv.close();
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
    assert.deepEqual(saved.sessions.find((s) => s.id === chat.id).queue.map((q) => q.text), ['первое', 'второе'], 'the queue is on disk');
    assert.ok(saved.sessions.find((s) => s.id === chat.id).pidStartedAt > 0);
    assert.ok(fs.existsSync(path.join(dataDir, 'db.json.bak')), 'previous db copy kept');

    h = await harness(dataDir);
    // (a) + (b): the turn completes with its whole text, then the queue drains in order (resumed CLI session)
    await waitFor(async () => {
      const msgs = await h.messages(chat.id);
      return msgs.some((m) => m.kind === 'assistant' && /resumed .*turn 2/.test(m.text)) && (await h.session(chat.id)).status === 'idle';
    }, { timeout: 30000, what: 'queued turn after the restart' });
    const msgs = await h.messages(chat.id);
    const slow = msgs.findIndex((m) => m.kind === 'assistant' && m.text.startsWith(SLOW) && m.text.endsWith('Done.'));
    assert.ok(slow >= 0, JSON.stringify(msgs.filter((m) => m.kind === 'assistant').map((m) => m.text)));
    const users = msgs.map((m, i) => [m, i]).filter(([m]) => m.kind === 'user' && ['первое', 'второе'].includes(m.text));
    assert.deepEqual(users.map(([m]) => m.text), ['первое', 'второе']);
    assert.ok(users[0][1] > slow, 'queued messages go after the re-attached turn');
    assert.ok(!msgs.some((m) => m.kind === 'error'), JSON.stringify(msgs.filter((m) => m.kind === 'error')));

    // (c) the worker_run caller gets its sub-agent's result although the harness restarted in between
    await waitFor(async () => (await h.messages(caller.id)).some((m) => m.kind === 'assistant' && m.text.includes('worker_run result: готово')), { timeout: 30000, what: 'worker_run result' });

    // (d) the review loop proceeds to its verdict
    await waitFor(async () => (await h.state()).tasks.find((x) => x.id === task.id).review.state === 'approved', { timeout: 30000, what: 'review verdict' });
    assert.equal((await h.session(reviewerId)).report.summary, 'Замечаний нет.\nVERDICT: APPROVED');

    // (e) the terminal is alive again in the same cwd, with the marker line in its history
    const log = await waitFor(async () => {
      const text = (await h.api('GET', `/api/sessions/${term.id}/log`)).text ?? '';
      return text.includes('— перезапуск harness: новая сессия терминала —') && text;
    }, { what: 'terminal respawned' });
    assert.ok(log, 'marker line in the terminal history');
    const t2 = await h.session(term.id);
    assert.equal(t2.status, 'idle', 'alive again (an exited PTY would be "exited")');
    await h.api('DELETE', `/api/sessions/${term.id}`);
    await waitPidGone(t2.pid);
    finished = true;
  } finally {
    if (!finished) for (const s of (await h.state().catch(() => ({ sessions: [] }))).sessions) if (s.pid) await h.api('POST', `/api/sessions/${s.id}/stop`).catch(() => {});
    await h.srv.close();
  }
});

test('a saved pid that is alive but started at another time is neither adopted nor killed', async () => {
  assert.equal(await sameProcess(process.pid, Date.now() - 3600000), false);
  assert.equal(await sameProcess(process.pid, await processStartTime(process.pid)), true);
  assert.equal(await sameProcess(999999, Date.now()), false);
  assert.equal(parseWmicDate('CreationDate=20261117224144.123456+180'), Date.UTC(2026, 10, 17, 19, 41, 44, 123));

  const dataDir = path.join(root, 'данные 2');
  fs.mkdirSync(path.join(dataDir, 'runs', 's_reused'), { recursive: true });
  // the old turn's output so far: one line of text, no result
  fs.writeFileSync(path.join(dataDir, 'runs', 's_reused', 'turn-1.out.ndjson'), `${JSON.stringify({ type: 'message', role: 'assistant', content: 'частичный ответ', delta: true })}\n`);
  const s = {
    id: 's_reused', kind: 'chat', title: 'old', agent: 'mock', launcherId: 'mock', cwd: folder, workspaceId: null, branch: null, role: 'solo',
    parentId: null, taskId: null, status: 'running', externalSessionId: 'x', settingsPath: null, model: null, approvalMode: null, autoReport: false,
    queued: 0, queue: [], preview: '', command: null, pid: process.pid, pidStartedAt: Date.now() - 3600000, turnOffset: 0, createdAt: 1, lastActivityAt: 1,
  };
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ seq: { task: 0 }, tasks: [], workspaces: [], notifications: [], sessions: [s] }));
  const h = await harness(dataDir);
  try {
    await waitFor(async () => (await h.session('s_reused')).status === 'idle', { what: 'finalized from the file' });
    const msgs = await h.messages('s_reused');
    assert.ok(msgs.some((m) => m.kind === 'assistant' && m.text === 'частичный ответ'), 'what the file had is shown');
    assert.ok(msgs.some((m) => m.kind === 'system' && /Harness перезапущен, ход прерван/.test(m.text)));
    assert.ok(!msgs.some((m) => m.text === 'переподключено после перезапуска'));
    assert.equal((await h.session('s_reused')).pid, null);
  } finally {
    await h.srv.close();
  }
  // this very process played the "reused pid": it is still here
});

test('a corrupt db.json and transcript are restored from their .bak with a notification', () => {
  const dir = tmpDir();
  try {
    let store = createStore(dir);
    store.db.tasks.push({ id: 'T-1', title: 'первая версия' });
    store.save();
    store.putMessage('s_1', { id: 'm1', text: 'привет' });
    store.flush();
    store.db.tasks.push({ id: 'T-2', title: 'вторая версия' });
    store.save();
    store.putMessage('s_1', { id: 'm2', text: 'ещё' });
    store.flush(); // .bak = the first version
    store.close();
    fs.writeFileSync(path.join(dir, 'db.json'), '{"tasks": [');
    fs.writeFileSync(path.join(dir, 'transcripts', 's_1.json'), '');

    store = createStore(dir);
    assert.deepEqual(store.db.tasks.map((t) => t.id), ['T-1']);
    assert.deepEqual(store.messages('s_1').map((m) => m.id), ['m1']);
    const texts = store.db.notifications.map((n) => n.text);
    assert.ok(texts.some((t) => /db\.json .*восстановлено из резервной копии/.test(t)), texts.join('\n'));
    assert.ok(texts.some((t) => /s_1\.json .*восстановлено из резервной копии/.test(t)), texts.join('\n'));
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('db.json.corrupt-')), 'the broken file is kept aside');
    store.close();
  } finally {
    rmrf(dir);
  }
});

test('streaming appends only what changed to a journal: a crash keeps it, the turn end folds it into the transcript', async () => {
  const dir = path.join(root, 'журнал');
  let st = createStore(dir);
  const t = path.join(dir, 'transcripts', 's1.json');
  const j = path.join(dir, 'transcripts', 's1.jsonl');
  st.putMessage('s1', { id: 'm1', kind: 'user', text: 'привет' });
  st.flush(); // the first write is whole
  st.putMessage('s1', { id: 'm2', kind: 'assistant', text: 'пишу' });
  st.putMessage('s1', { id: 'm2', kind: 'assistant', text: 'пишу дальше' });
  st.appendTermLog('t1', 'строка 1\n');
  await new Promise((r) => setTimeout(r, 400)); // the timer: a journal line, not the whole file again
  assert.equal(JSON.parse(fs.readFileSync(t, 'utf8')).length, 1);
  assert.equal(fs.readFileSync(j, 'utf8').trim().split('\n').length, 1, 'the newest version of a message once');
  st.appendTermLog('t1', 'строка 2\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.readFileSync(path.join(dir, 'terms', 't1.log'), 'utf8'), 'строка 1\nстрока 2\n', 'terminal output appended');
  fs.appendFileSync(j, '{"id":"m3","kind":"assist'); // a crash in the middle of a line
  const crashed = path.join(root, 'журнал после сбоя');
  fs.cpSync(dir, crashed, { recursive: true }); // the files as a crash leaves them (close() would fold the journal)
  st.close();
  st = createStore(crashed);
  assert.deepEqual(st.messages('s1').map((m) => m.text), ['привет', 'пишу дальше'], 'restored from the journal, the cut line skipped');
  st.putMessage('s1', { id: 'm3', kind: 'assistant', text: 'готово' });
  st.flush(); // turn end
  assert.equal(fs.existsSync(path.join(crashed, 'transcripts', 's1.jsonl')), false, 'folded into the transcript');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(crashed, 'transcripts', 's1.json'), 'utf8')).map((m) => m.text), ['привет', 'пишу дальше', 'готово']);
  st.close();
});

test('a review whose reviewer chat is deleted ends as «ревью прервано», not «ревью…» forever', async () => {
  const h = await harness(path.join(root, 'данные ревью'));
  try {
    const ws = await h.api('POST', '/api/workspaces', { path: repo });
    const task = await h.api('POST', '/api/tasks', { title: 'Ревьюер пропал #done сделано', workspaceId: ws.id });
    await h.api('POST', `/api/tasks/${task.id}/start`, { agent: 'mock' });
    const reviewing = await waitFor(async () => {
      const t = (await h.state()).tasks.find((x) => x.id === task.id);
      return t.review?.state === 'reviewing' && t.review.reviewerSessionId && t;
    }, { what: 'review started' });
    await fetch(`${h.srv.url}/api/sessions/${reviewing.review.reviewerSessionId}?force=1`, { method: 'DELETE', headers: { 'x-harness-token': h.srv.token } });
    const t = await waitFor(async () => { const x = (await h.state()).tasks.find((y) => y.id === task.id); return x.review?.state === 'review_stopped' && x; }, { what: 'review stopped' });
    assert.equal(t.agentState, 'review_stopped');
    assert.match(t.review.stoppedReason, /удалён/);
  } finally {
    await h.srv.close();
  }
});
