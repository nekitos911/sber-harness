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

test('--demo seeds repositories (projects folder, bare origin), workspaces and tasks once; tracker and PRs work offline', async () => {
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
    assert.deepEqual(st.workspaces.filter((w) => !w.kind).map((w) => w.name).sort(), ['demo-service', 'ledger-service']);
    assert.equal(st.tasks.length, 5);
    const hotfix = st.tasks.find((t) => t.title.startsWith('Хотфикс'));
    assert.deepEqual(hotfix.targets, ['develop', 'release/1.54.0']);
    const parent = st.tasks.find((t) => t.title.startsWith('Новый тип'));
    assert.equal(st.tasks.filter((t) => t.parentId === parent.id).length, 2);
    const projects = path.join(dataDir, 'projects');
    const svc = path.join(projects, 'demo-service');
    assert.match(gitIn(svc, 'branch', '--list', 'release/1.54.0'), /release\/1\.54\.0/);
    const bare = path.join(dataDir, 'remotes', 'PROJ', 'demo-service.git');
    assert.equal(path.resolve(gitIn(svc, 'remote', 'get-url', 'origin')), path.resolve(bare));
    assert.equal(path.resolve(st.workspaces.find((w) => w.kind === 'root').path), path.resolve(projects), 'the projects folder is the root');
    // a chat in a demo repository belongs to its project, not to «Служебное» (the data dir holds the projects folder)
    const chat = (await api('POST', '/api/sessions', { kind: 'chat', agent: 'mock', cwd: svc })).body;
    assert.deepEqual([chat.system, chat.workspaceId], [false, st.workspaces.find((w) => w.name === 'demo-service').id]);

    const sync = (await api('POST', '/api/tasks/sync')).body;
    assert.ok(sync.imported > 0, JSON.stringify(sync));
    // the tracker answers for the asked key, not with the fixture's PROJ-14904 for everything
    const other = (await api('GET', '/api/state')).body.tasks.find((t) => t.externalId === 'PROJ-15430');
    const ext = (await api('GET', `/api/tasks/${other.id}/external`)).body;
    assert.deepEqual([ext.key, ext.title], ['PROJ-15430', 'valueDisplayOnTile добавить в получение шаблона']);
    assert.ok(ext.links.every((l) => l.from === 'PROJ-15430' || l.to === 'PROJ-15430'), JSON.stringify(ext.links));

    // no PR is invented for a branch; push goes to the bare origin; a created PR is listed for its branch only
    const prOf = async () => (await api('GET', `/api/git/pr-status?cwd=${encodeURIComponent(svc)}`)).body.pr;
    assert.equal(await prOf(), null);
    gitIn(svc, 'switch', '-q', '-c', 'feature/PROJ-2-demo');
    fs.writeFileSync(path.join(svc, 'demo.txt'), 'x\n');
    gitIn(svc, 'add', '-A');
    gitIn(svc, 'commit', '-q', '-m', 'PROJ-2 демо');
    const pushed = await api('POST', '/api/git/push', { cwd: svc, via: 'harness' });
    assert.deepEqual([pushed.status, pushed.body.summary], [200, 'Новая ветка feature/PROJ-2-demo в origin']);
    assert.match(pushed.body.output, /feature\/PROJ-2-demo/, 'the raw git output is kept');
    assert.equal((await api('POST', '/api/git/push', { cwd: svc, via: 'harness' })).body.summary, 'Уже в origin/feature/PROJ-2-demo — нечего отправлять');
    fs.writeFileSync(path.join(svc, 'demo2.txt'), 'y\n');
    gitIn(svc, 'add', '-A');
    gitIn(svc, 'commit', '-q', '-m', 'PROJ-2 ещё');
    assert.equal((await api('POST', '/api/git/push', { cwd: svc, via: 'harness' })).body.summary, 'Отправлено в origin/feature/PROJ-2-demo');
    assert.match(gitIn(bare, 'branch', '--list', 'feature/PROJ-2-demo'), /feature\/PROJ-2-demo/);
    const made = await api('POST', '/api/git/pr', { cwd: svc, title: 'PROJ-2 демо', base: 'develop', via: 'harness' });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.match(made.body.url, /\/PROJ\/demo-service\/pulls\/\d+$/);
    assert.deepEqual([(await prOf())?.state, (await prOf())?.url], ['open', made.body.url]);
    gitIn(svc, 'switch', '-q', 'develop');
    assert.equal(await prOf(), null, 'develop has no PR');
  } finally {
    await srv.close();
  }
  const commits = gitIn(path.join(dataDir, 'projects', 'demo-service'), 'rev-list', '--all', '--count');
  srv = await start();
  try {
    const st = (await api('GET', '/api/state')).body;
    assert.equal(st.tasks.filter((t) => !t.source).length, 5, 'local demo tasks are not seeded twice');
    assert.equal(st.workspaces.filter((w) => !w.kind).length, 2);
    assert.equal(gitIn(path.join(dataDir, 'projects', 'demo-service'), 'rev-list', '--all', '--count'), commits);
  } finally {
    await srv.close();
  }
});

test('--demo takes dataDir and port from HARNESS_CONFIG (or --data-dir / --port)', async () => {
  const hcData = path.join(root, 'данные из конфига');
  const hc = path.join(root, 'свой конфиг.json');
  fs.writeFileSync(hc, JSON.stringify({ dataDir: hcData, port: 0 }));
  process.env.HARNESS_CONFIG = hc;
  let srv;
  try {
    const configFile = path.join(root, 'harness.config.json');
    if (!fs.existsSync(configFile)) fs.copyFileSync(path.join(CODE_ROOT, 'harness.config.json'), configFile);
    srv = await startServer({ demo: true, configFile });
    assert.ok(fs.existsSync(path.join(hcData, 'projects', 'demo-service', '.git')));
    assert.notEqual(new URL(srv.url).port, '4778');
  } finally {
    delete process.env.HARNESS_CONFIG;
    await srv?.close();
  }
});
