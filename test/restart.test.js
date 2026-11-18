// Agent turns run detached with stdout/stderr in files, so they survive a harness restart and are re-attached.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { CODE_ROOT } from '../server/config.js';
import { isAlive, killTree } from '../server/runner.js';
import { tmpDir, rmrf, waitFor, makeRepo } from './helpers.js';

const root = tmpDir();
const cwd = path.join(root, 'рабочая папка');
fs.mkdirSync(cwd);
process.env.MOCK_AGENT_STATE_DIR = path.join(root, 'mock-state');
after(() => rmrf(root));

const SLOW = 'slow '.repeat(20);

async function harness(name) {
  const dataDir = path.join(root, `data ${name}`);
  const configFile = path.join(root, `config ${name}.json`);
  if (!fs.existsSync(configFile)) fs.copyFileSync(path.join(CODE_ROOT, 'harness.config.json'), configFile);
  const srv = await startServer({ dataDir, configFile, port: 0, configOverrides: { defaultAgent: 'mock', mcpServersFrom: null, history: { adopt: false }, agents: { mock: { modelsDiscovery: null } } } });
  const api = async (method, p, body) => {
    const res = await fetch(srv.url + p, { method, headers: { 'x-harness-token': srv.token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return res.json();
  };
  const session = async (id) => (await api('GET', '/api/state')).sessions.find((s) => s.id === id);
  const messages = (id) => api('GET', `/api/sessions/${id}/messages`);
  return { srv, api, session, messages, dataDir };
}

async function startSlowTurn(h) {
  const s = await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd, prompt: '#slow' });
  await waitFor(async () => (await h.messages(s.id)).some((m) => m.kind === 'assistant' && m.text.includes('slow slow')), { what: 'slow output' });
  return s;
}

test('a running turn keeps running across srv.close() and is re-attached by the next harness', async () => {
  let h = await harness('a');
  const s = await startSlowTurn(h);
  await h.srv.close(); // must not kill the agent
  const saved = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'db.json'), 'utf8')).sessions.find((x) => x.id === s.id);
  assert.equal(saved.status, 'running');
  assert.ok(saved.turnOffset > 0, 'read offset persisted');
  assert.ok(isAlive(saved.pid), 'the agent survived the harness shutdown');

  h = await harness('a');
  try {
    assert.equal((await h.session(s.id)).status, 'running');
    await waitFor(async () => (await h.session(s.id)).status === 'idle', { timeout: 20000, what: 're-attached turn to finish' });
    const msgs = await h.messages(s.id);
    assert.ok(msgs.some((m) => m.kind === 'system' && m.text === 'переподключено после перезапуска'));
    const text = msgs.filter((m) => m.kind === 'assistant').map((m) => m.text);
    assert.ok(text.some((t) => t.startsWith(SLOW) && t.endsWith('Done.')), `one message with the whole stream: ${JSON.stringify(text)}`);
    assert.ok(!msgs.some((m) => m.kind === 'error'), JSON.stringify(msgs.filter((m) => m.kind === 'error')));
    const after = await h.session(s.id);
    assert.deepEqual([after.pid, after.turnOffset, after.tokensIn], [null, null, 10]);
  } finally {
    await h.srv.close();
  }
});

test('a turn that finished while the harness was down is drained from its file on start', async () => {
  let h = await harness('b');
  const s = await startSlowTurn(h);
  await h.srv.close();
  const { pid } = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'db.json'), 'utf8')).sessions.find((x) => x.id === s.id);
  await waitFor(() => !isAlive(pid), { timeout: 15000, what: 'agent to exit on its own' });

  h = await harness('b');
  try {
    await waitFor(async () => (await h.session(s.id)).status === 'idle', { what: 'drained turn to finish' });
    const msgs = await h.messages(s.id);
    assert.ok(!msgs.some((m) => m.text === 'переподключено после перезапуска'), 'nothing to re-attach to');
    assert.ok(msgs.some((m) => m.kind === 'assistant' && m.text.startsWith(SLOW) && m.text.endsWith('Done.')));
    assert.ok(!msgs.some((m) => m.kind === 'error'));
    await h.api('DELETE', `/api/sessions/${s.id}`);
    await waitFor(() => !fs.existsSync(path.join(h.dataDir, 'runs', s.id)), { what: 'turn files removed with the session' });
  } finally {
    await h.srv.close();
  }
});

test('on start, sessions saved under a containing folder move to the repository that owns their worktree', async () => {
  const repo = path.join(root, 'репо c');
  makeRepo(repo);
  let h = await harness('c');
  const wsRepo = await h.api('POST', '/api/workspaces', { path: repo });
  const wt = await h.api('POST', `/api/workspaces/${wsRepo.id}/worktrees`, { name: 'feature/old-data' });
  const folder = await h.api('POST', '/api/workspaces', { path: root, kind: 'folder' });
  const chat = await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: wt.path });
  assert.equal(chat.workspaceId, wsRepo.id, 'new sessions already follow the repo-first rule');
  await h.srv.close();
  // data written before the rule: attached to the folder that merely contains the worktree
  const dbFile = path.join(h.dataDir, 'db.json');
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  db.sessions.find((s) => s.id === chat.id).workspaceId = folder.id;
  fs.writeFileSync(dbFile, JSON.stringify(db));
  h = await harness('c');
  try {
    assert.equal((await h.session(chat.id)).workspaceId, wsRepo.id);
  } finally {
    await h.srv.close();
  }
});

test('turnClosing never survives a restart; the next turn does not start out "closing"', async () => {
  let h = await harness('d');
  const s = await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd, prompt: '#linger' });
  const closing = await waitFor(async () => { const x = await h.session(s.id); return x.turnClosing && x.pid ? x : null; }, { what: 'lingering' });
  await h.srv.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dataDir, 'db.json'), 'utf8')).sessions.find((x) => x.id === s.id).turnClosing, true);
  h = await harness('d');
  try {
    const after1 = await h.session(s.id);
    assert.deepEqual([after1.status, after1.turnClosing, after1.pid], ['idle', false, null]);
    await h.api('POST', `/api/sessions/${s.id}/messages`, { text: '#slow' });
    const during = await waitFor(async () => { const x = await h.session(s.id); return x.status === 'running' ? x : null; }, { what: 'running' });
    assert.equal(during.turnClosing, false);
    await h.api('POST', `/api/sessions/${s.id}/stop`);
    await waitFor(async () => !(await h.session(s.id)).pid, { what: 'stopped' });
  } finally {
    killTree(closing.pid); // the lingering process of the first harness (not followed after the restart)
    await h.srv.close();
  }
});
