// «Передать агенту»: one input — a tracker link/key starts that task at the projects root, free text opens a chat there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ROOT } from '../server/config.js';
import { startTestServer, tmpDir, rmrf, waitFor } from './helpers.js';

const root = tmpDir();
const projects = path.join(root, 'проекты');
const stub = (server) => ({ transport: 'stdio', command: process.execPath, args: [path.join(CODE_ROOT, 'scripts', 'mock-mcp.js'), '--fixtures', path.join(CODE_ROOT, 'test', 'fixtures'), '--server', server] });
let h;

before(async () => {
  fs.mkdirSync(projects);
  h = await startTestServer({
    workspaces: { root: projects },
    mcpServers: { onework: stub('onework') },
    integrations: { tasks: { enabled: true, space: 'PROJ', urlTemplate: 'https://tracker.example/swtr/units/all/unit/{key}' } },
    agents: { mock: { taskPromptTemplate: '/full-task {taskUrl}{notes}', freePromptTemplate: '/full-task {text}{notes}' } },
  });
});
after(async () => {
  await h.close();
  rmrf(root);
});

const firstUser = async (sid) => waitFor(async () => (await h.api('GET', `/api/sessions/${sid}/messages`)).body.find((m) => m.kind === 'user'), { what: 'first message' });
const settle = (sid) => waitFor(async () => { const s = (await h.api('GET', '/api/state')).body.sessions.find((x) => x.id === sid); return !s.pid && s.status !== 'running' && !s.turnClosing; }, { what: 'settled' });

test('a tracker link: the task is imported and its worker starts at the projects root with "/full-task <url>"; again = jumped', async () => {
  const link = 'https://tracker.example/swtr/units/all/unit/PROJ-14904';
  const r = await h.api('POST', '/api/handoff', { input: `${link} и проверь кеш` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { session, task } = r.body;
  assert.deepEqual([task.externalId, task.location, session.taskId, path.resolve(session.cwd)], ['PROJ-14904', 'root', task.id, path.resolve(projects)]);
  assert.equal((await firstUser(session.id)).text, `/full-task ${link} и проверь кеш`);
  const again = (await h.api('POST', '/api/handoff', { input: 'PROJ-14904' })).body;
  assert.deepEqual([again.session.id, again.session.jumped], [session.id, true]);
  await settle(session.id);
});

test('free text: a chat at the projects root named after the text, its prompt from freePromptTemplate', async () => {
  const r = await h.api('POST', '/api/handoff', { input: 'сделай X', notes: 'быстро' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { session, task } = r.body;
  assert.equal(task, null);
  assert.deepEqual([session.title, session.role, session.atRoot, path.resolve(session.cwd)], ['сделай X', 'solo', true, path.resolve(projects)]);
  assert.equal((await firstUser(session.id)).text, '/full-task сделай X быстро');
  await settle(session.id);
});

test('no projects folder → 400', async () => {
  const bare = await startTestServer();
  try {
    const r = await bare.api('POST', '/api/handoff', { input: 'сделай X' });
    assert.deepEqual([r.status, r.body.error], [400, 'Укажите папку с проектами в Настройках']);
  } finally {
    await bare.close();
  }
});
