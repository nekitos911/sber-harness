// Offline demo: seeds repositories and tasks once, tracker and PR service come from the fixture MCP stub.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { CODE_ROOT } from '../server/config.js';
import { tmpDir, rmrf, gitIn } from './helpers.js';

const root = tmpDir();
process.env.MOCK_AGENT_STATE_DIR = path.join(root, 'mock-state'); // the demo's model discovery runs the mock agent
after(() => rmrf(root));

test('--demo seeds repositories, workspaces and tasks once; tracker and PR status work offline', async () => {
  const dataDir = path.join(root, 'data demo');
  const configFile = path.join(root, 'harness.config.json');
  fs.copyFileSync(path.join(CODE_ROOT, 'harness.config.json'), configFile);
  const start = () => startServer({ demo: true, dataDir, configFile, port: 0 });
  let srv = await start();
  const api = (method, p, body) => fetch(srv.url + p, { method, headers: { 'x-harness-token': srv.token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const st = (await api('GET', '/api/state')).body;
    assert.equal(st.demo, true);
    assert.ok(st.features.includes('demo'));
    assert.deepEqual(st.workspaces.map((w) => w.name).sort(), ['demo-service', 'ledger-service']);
    assert.equal(st.tasks.length, 5);
    const hotfix = st.tasks.find((t) => t.title.startsWith('Хотфикс'));
    assert.deepEqual(hotfix.targets, ['develop', 'release/1.54.0']);
    const parent = st.tasks.find((t) => t.title.startsWith('Новый тип'));
    assert.equal(st.tasks.filter((t) => t.parentId === parent.id).length, 2);
    const svc = path.join(dataDir, 'demo-service');
    assert.match(gitIn(svc, 'branch', '--list', 'release/1.54.0'), /release\/1\.54\.0/);
    assert.equal(gitIn(svc, 'remote', 'get-url', 'origin'), 'ssh://git@code.example:7998/PROJ/demo-service.git');

    const sync = (await api('POST', '/api/tasks/sync')).body;
    assert.ok(sync.imported > 0, JSON.stringify(sync));
    const pr = (await api('GET', `/api/git/pr-status?cwd=${encodeURIComponent(svc)}`)).body;
    assert.deepEqual([pr.pr?.state, /\/PROJ\/demo-service\/pulls\/\d+$/.test(pr.pr?.url)], ['open', true], JSON.stringify(pr));
  } finally {
    await srv.close();
  }
  const commits = gitIn(path.join(dataDir, 'demo-service'), 'rev-list', '--all', '--count');
  srv = await start();
  try {
    const st = (await api('GET', '/api/state')).body;
    assert.equal(st.tasks.filter((t) => !t.source).length, 5, 'local demo tasks are not seeded twice');
    assert.equal(st.workspaces.length, 2);
    assert.equal(gitIn(path.join(dataDir, 'demo-service'), 'rev-list', '--all', '--count'), commits);
  } finally {
    await srv.close();
  }
});
