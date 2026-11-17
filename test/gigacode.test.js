// GigaCode launcher: shim resolution + identity guard, exact argv, exact settings.json, fail-fast before a worktree.
// A fake install (gigacode.cmd + lib/cli-entry.js = scripts/mock-agent.js) lives under a Cyrillic path with spaces.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODE_ROOT } from '../server/config.js';
import { shimIdentity, resolveGigacode, parseShim } from '../server/launchers.js';
import { SUBAGENT_CONTEXT } from '../server/orchestration.js';
import { startTestServer, makeRepo, tmpDir, rmrf, gitIn, waitFor, waitPidGone } from './helpers.js';

const IDENTITY = 'ab'.repeat(32);
const root = tmpDir();
// the real layout (docs/GIGACODE-FACTS.md): ROOT\bin\gigacode.cmd, ROOT\runtime\node\node.exe, ROOT\lib\cli-entry.js
const ROOT = path.join(root, 'Program Files тест', '.gigacode');
const bin = path.join(ROOT, 'bin');
const shim = path.join(bin, 'gigacode.cmd');
const bundledNode = path.join(ROOT, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const bundledEntry = path.join(ROOT, 'lib', 'cli-entry.js');
const entry = path.join(root, 'cli', 'cli-entry.js'); // runnable copy of the mock agent for the e2e (explicit pair)
const badShim = path.join(bin, 'no-identity.cmd');
const argvFile = path.join(root, 'argv.jsonl');
const shimText = (identity) => [
  '@echo off',
  'setlocal',
  'set "ROOT=%~dp0.."',
  ...(identity ? [`set "GIGACODE_PACKAGE_IDENTITY=${identity}"`] : []),
  'set "GIGACODE_PACKAGE_LAUNCHER=%~f0"',
  '"%ROOT%\\runtime\\node\\node.exe" --max-old-space-size=6144 "%ROOT%\\lib\\cli-entry.js" %*',
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n');
const MODES = ['plan', 'default', 'auto-edit', 'auto'];
const giga = (command, extra = {}) => ({
  launcher: 'gigacode', label: 'GigaCode (fake)', command, node: null, cliEntry: null, nodeArgs: ['--max-old-space-size=6144'],
  approvalMode: 'auto', approvalModes: MODES, settingsEnv: 'GIGACODE_SYSTEM_SETTINGS_PATH', firstEventTimeoutMs: 15000,
  settings: { agents: { modelGrades: {}, allowedGrades: [] }, chatRecording: true, permissions: { allow: ['everything'] } },
  ...extra,
});

let h;
let repo;
before(async () => {
  for (const p of [bundledNode, bundledEntry]) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'placeholder');
  }
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.copyFileSync(path.join(CODE_ROOT, 'scripts', 'mock-agent.js'), entry);
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(shim, shimText(IDENTITY));
  fs.writeFileSync(badShim, shimText(null));
  repo = makeRepo(path.join(root, 'репо'));
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  h = await startTestServer({
    agents: { giga: giga(shim, { node: process.execPath, cliEntry: entry }), gigabad: giga(badShim) },
    integrations: { tasks: { enabled: true, server: 'nope', tools: { find: 'x' } } },
  });
});
after(async () => {
  delete process.env.MOCK_AGENT_ARGV_FILE;
  await h.close();
  rmrf(root);
});

const runs = () => fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const state = async () => (await h.api('GET', '/api/state')).body;

test('shim parsing: ROOT=%~dp0.. resolves to the bundled node + cli-entry next to bin; identity; explicit pair wins', () => {
  assert.equal(shimIdentity(shimText(IDENTITY)), IDENTITY);
  assert.equal(shimIdentity(shimText(null)), null);
  assert.deepEqual(parseShim(shim, shimText(IDENTITY)), { node: path.resolve(ROOT, 'runtime', 'node', 'node.exe'), entry: bundledEntry });
  const env = { GIGACODE_PACKAGE_IDENTITY: IDENTITY, GIGACODE_PACKAGE_LAUNCHER: shim };
  if (process.platform === 'win32') {
    assert.deepEqual(resolveGigacode(giga(shim)), { file: bundledNode, args: ['--max-old-space-size=6144', bundledEntry], env });
  }
  // a shim without ROOT/call line: <shimDir>/../runtime + <shimDir>/../lib
  const plain = path.join(bin, 'plain.cmd');
  fs.writeFileSync(plain, `@echo off\r\nset "GIGACODE_PACKAGE_IDENTITY=${IDENTITY}"\r\n`);
  assert.deepEqual(resolveGigacode(giga(plain)).args, ['--max-old-space-size=6144', bundledEntry]);
  assert.equal(resolveGigacode(giga(plain)).file, bundledNode);
  assert.deepEqual(resolveGigacode(giga(shim, { node: process.execPath, cliEntry: entry })), { file: process.execPath, args: ['--max-old-space-size=6144', entry], env });

  assert.throws(() => resolveGigacode(giga(badShim)), /GIGACODE_PACKAGE_IDENTITY not found/);
  assert.throws(() => resolveGigacode(giga(path.join(bin, 'missing.cmd'))), /launcher not found/);
  assert.throws(() => resolveGigacode(giga(shim, { node: process.execPath })), /must be set together/);
  assert.throws(() => resolveGigacode(giga(shim, { node: process.execPath, cliEntry: path.join(bin, 'nope.js') })), /cliEntry does not exist/);
  // no bundled runtime anywhere: a clear error, never the system node
  const lonely = path.join(root, 'elsewhere', 'bin', 'gigacode.cmd');
  fs.mkdirSync(path.dirname(lonely), { recursive: true });
  fs.writeFileSync(lonely, shimText(IDENTITY));
  assert.throws(() => resolveGigacode(giga(lonely)), /bundled node \+ cli-entry\.js/);
});

test('exact argv on new and resumed turns; settings.json without permissions; identity env', async () => {
  const s = (await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'giga', cwd: repo, prompt: 'hello' })).body;
  assert.ok(s.id, JSON.stringify(s));
  await waitFor(async () => (await state()).sessions.find((x) => x.id === s.id && x.status === 'idle' && x.externalSessionId), { what: 'turn 1' });
  const ext = (await state()).sessions.find((x) => x.id === s.id).externalSessionId;
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: 'again' });
  await waitFor(async () => (await h.api('GET', `/api/sessions/${s.id}/messages`)).body.some((m) => m.kind === 'assistant' && m.text.includes(`resumed ${ext}, turn 2`)), { what: 'turn 2' });

  const [first, second] = runs().filter((r) => r.env.HARNESS_SESSION_ID === s.id);
  const tail = ['--approval-mode', 'auto', '--output-format', 'stream-json'];
  // orchestration.subagents "harness" (default): the sub-agent context block leads the first prompt of a CLI session
  assert.deepEqual(first.argv, ['--max-old-space-size=6144', entry, '-p', `${SUBAGENT_CONTEXT}\n\nhello`, ...tail]);
  assert.deepEqual(second.argv, ['--max-old-space-size=6144', entry, '--resume', ext, '-p', 'again', ...tail]);
  assert.deepEqual(first.env, {
    GIGACODE_PACKAGE_IDENTITY: IDENTITY,
    GIGACODE_PACKAGE_LAUNCHER: shim,
    GIGACODE_SYSTEM_SETTINGS_PATH: s.settingsPath,
    HARNESS_SESSION_ID: s.id,
  });
  assert.equal(second.env.GIGACODE_SYSTEM_SETTINGS_PATH, s.settingsPath, 'same settings path on resume');

  const settings = JSON.parse(fs.readFileSync(s.settingsPath, 'utf8'));
  assert.deepEqual(settings, {
    agents: { modelGrades: {}, allowedGrades: [] },
    chatRecording: true,
    mcpServers: {
      harness: {
        command: process.execPath,
        args: [path.join(CODE_ROOT, 'mcp', 'harness-mcp.js')],
        env: { HARNESS_URL: h.srv.url, HARNESS_TOKEN: h.srv.token, HARNESS_SESSION_ID: s.id },
        trust: true,
        timeout: 3600000,
      },
    },
  });
  assert.ok(!('permissions' in settings));
  const tokens = (await state()).sessions.find((x) => x.id === s.id);
  assert.deepEqual([tokens.tokensIn, tokens.tokensOut], [20, 10]);

  assert.equal((await h.api('PATCH', `/api/sessions/${s.id}`, { approvalMode: 'yolo' })).status, 400);
  assert.equal((await h.api('POST', '/api/sessions', { kind: 'chat', agent: 'giga', cwd: repo, approvalMode: 'yolo' })).status, 400);
  await h.api('DELETE', `/api/sessions/${s.id}`);
  assert.equal(fs.existsSync(s.settingsPath), false, 'settings removed with the session');
});

test('a broken launcher fails before any worktree or session is created', async () => {
  const ws = (await h.api('POST', '/api/workspaces', { path: repo })).body;
  const t = (await h.api('POST', '/api/tasks', { title: 'X', workspaceId: ws.id })).body;
  const before = gitIn(repo, 'worktree', 'list');
  const sessionsBefore = (await state()).sessions.length;
  const r = await h.api('POST', `/api/tasks/${t.id}/start`, { agent: 'gigabad' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /GIGACODE_PACKAGE_IDENTITY/);
  assert.equal(gitIn(repo, 'worktree', 'list'), before);
  assert.equal((await state()).sessions.length, sessionsBefore);
  assert.equal(gitIn(repo, 'branch', '--list', `feature/${t.id}`), '');
});

test('interactive terminal of an agent types its resolved CLI; state has defaultAgent; sync failure becomes tasksProblem', async (t) => {
  const st = await state();
  assert.equal(st.defaultAgent, 'mock');
  assert.equal((await h.api('POST', '/api/tasks/sync')).status, 404);
  assert.match((await state()).integrations.tasksProblem.error, /not configured/);

  const res = await h.api('POST', '/api/sessions', { kind: 'terminal', agent: 'giga', cwd: os.tmpdir() }); // the PTY host can hold its cwd briefly after kill
  if (res.status === 501) return t.skip(res.body.error);
  assert.ok(res.body.command.includes('cli-entry.js') && !res.body.command.includes('-p'), res.body.command);
  await h.api('DELETE', `/api/sessions/${res.body.id}`);
  await waitPidGone(res.body.pid);
});

test('agent info: launcher resolution (identity as a boolean only) and what the CLI reported at init', async () => {
  const info = (await h.api('GET', '/api/agents/giga/info')).body;
  assert.deepEqual(info.resolved, { ok: true, command: shim, node: process.execPath, entry, identity: true });
  assert.ok(!JSON.stringify(info).includes(IDENTITY), 'the identity value is never returned');
  assert.equal(info.auth, 'ok');
  const { at, auth, ...seen } = info.seen;
  assert.ok(at > 0);
  assert.deepEqual(seen, {
    models: ['Mock-Model-1-128k'], // the copied mock has no fixture next to it: its built-in catalogue
    slashCommands: ['clear', 'full-task'],
    mcpServers: [{ name: 'harness', status: 'connected' }],
    agents: ['general-purpose'],
    version: 'mock-1.0',
  });
  const bad = (await h.api('GET', '/api/agents/gigabad/info')).body;
  assert.deepEqual([bad.resolved.ok, bad.resolved.identity, bad.seen], [false, false, null]);
  assert.match(bad.resolved.error, /GIGACODE_PACKAGE_IDENTITY/);
  assert.equal((await h.api('GET', '/api/agents/nope/info')).status, 404);
});
