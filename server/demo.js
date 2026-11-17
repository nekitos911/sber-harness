// Offline demo (`npm run demo` = node server/index.js --demo): every flow without GigaCode, onework or sourcecontrol.
// The mock agent stands in for the CLI, scripts/mock-mcp.js serves test/fixtures for the tracker and the code host,
// and the data dir gets two small git repositories (<dataDir>/projects, the projects folder) with a local bare
// "origin" each (<dataDir>/remotes/PROJ/<name>.git: push works, the PR service sees project PROJ) and a few tasks on
// the first start (idempotent).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawnOptions } from './runner.js';

export const DEMO_PORT = 4778;

export const demoProjects = (dataDir) => path.join(dataDir, 'projects');

export function demoOverrides(root, dataDir) {
  // --state: the PRs the demo creates are remembered per data dir (listed for their branch only)
  const fixtures = (server) => ({ enabled: true, transport: 'stdio', command: 'node', args: ['scripts/mock-mcp.js', '--fixtures', 'test/fixtures', '--server', server, '--state', path.join(dataDir, `mock-${server}.json`)], timeoutMs: 15000 });
  return {
    defaultAgent: 'mock',
    mcpServersFrom: null,
    workspaces: { root: demoProjects(dataDir), repos: [] },
    mcpServers: { onework: fixtures('onework'), sourcecontrol: fixtures('sourcecontrol') },
    integrations: {
      tasks: { enabled: true, space: 'PROJ', urlTemplate: 'https://tracker.example/swtr/units/all/unit/{key}', limit: 5 },
      // the fixture stub synthesizes an open PR for whatever head it is asked about
      pr: { enabled: true, refreshSec: 60, listArgs: { project: '{project}', repository: '{repository}', state: 'OPEN', page: 1, limit: 100, head: '{branch}' } },
    },
  };
}

const run = (cwd, ...args) => execFileSync('git', args, spawnOptions({ cwd, stdio: 'ignore' }));

function repo(dir, name, commits) {
  if (fs.existsSync(path.join(dir, '.git'))) return false;
  fs.mkdirSync(dir, { recursive: true });
  run(dir, 'init', '-q', '-b', 'develop');
  run(dir, 'config', 'user.name', 'Demo');
  run(dir, 'config', 'user.email', 'demo@example.com');
  for (const [file, text, msg] of commits) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    run(dir, 'add', '-A');
    run(dir, 'commit', '-q', '-m', msg);
  }
  return true;
}

/** A local bare repository as origin (forward slashes: also a valid git URL on Windows); every branch pushed once. */
function bareOrigin(dir, dataDir, name) {
  const bare = path.join(dataDir, 'remotes', 'PROJ', `${name}.git`);
  fs.mkdirSync(bare, { recursive: true });
  run(bare, 'init', '-q', '--bare');
  run(dir, 'remote', 'add', 'origin', bare.split(path.sep).join('/'));
  run(dir, 'push', '-q', 'origin', '--all');
}

/** Git repositories of the demo (before the server registers workspaces from the data dir). */
export function seedDemoRepos(dataDir) {
  const projects = demoProjects(dataDir);
  const svc = path.join(projects, 'demo-service');
  if (repo(svc, 'demo-service', [
    ['README.md', '# demo-service\n\nСервис лимитов (демо).\n', 'PROJ-1 Начальная версия'],
    ['src/limits.js', 'export const limit = (a) => a * 2;\n', 'PROJ-2 Расчёт лимитов'],
  ])) {
    run(svc, 'branch', 'release/1.54.0', 'HEAD~1');
    run(svc, 'switch', '-q', 'release/1.54.0');
    fs.writeFileSync(path.join(svc, 'CHANGELOG.md'), '## 1.54.0\n- релиз\n');
    run(svc, 'add', '-A');
    run(svc, 'commit', '-q', '-m', 'PROJ-3 Релиз 1.54.0');
    run(svc, 'switch', '-q', 'develop');
    bareOrigin(svc, dataDir, 'demo-service');
  }
  const ledger = path.join(projects, 'ledger-service');
  if (repo(ledger, 'ledger-service', [
    ['README.md', '# ledger-service\n\nУчёт операций (демо).\n', 'PROJ-4 Начальная версия'],
  ])) bareOrigin(ledger, dataDir, 'ledger-service');
}

/** Board tasks of the demo, once per data dir. */
export function seedDemoTasks({ db, tasks, store }) {
  if (db.demoSeeded) return;
  const ws = (name) => db.workspaces.find((w) => w.name === name)?.id ?? null;
  tasks.create({
    title: 'Хотфикс расчёта лимитов', workspaceId: ws('demo-service'), targets: ['develop', 'release/1.54.0'], priority: 'high',
    description: 'Лимит считается вдвое. Исправить в develop и перенести в release/1.54.0. #done исправлено',
  }, 'harness');
  tasks.create({ title: 'Обновить README', workspaceId: ws('demo-service'), priority: 'low', description: 'Описать запуск сервиса. #done описано' }, 'harness');
  const parent = tasks.create({ title: 'Новый тип операций (два сервиса)', targets: ['develop'], priority: 'medium', description: 'API в demo-service, учёт в ledger-service.' }, 'harness');
  const api = tasks.create({ title: 'API нового типа операций', parentId: parent.id, workspaceId: ws('demo-service'), description: 'Добавить endpoint. #done готово' }, 'harness');
  tasks.create({ title: 'Учёт нового типа операций', parentId: parent.id, workspaceId: ws('ledger-service'), deps: [api.id], description: 'Проводки по новому типу. #done готово' }, 'harness');
  db.demoSeeded = true;
  store.save();
}
