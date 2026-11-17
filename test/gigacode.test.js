// GigaCode launcher: shim resolution + identity guard, exact argv, exact settings.json, fail-fast before a worktree.
// A fake install (gigacode.cmd + lib/cli-entry.js = scripts/mock-agent.js) lives under a Cyrillic path with spaces.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODE_ROOT } from '../server/config.js';
import { shimIdentity, resolveGigacode } from '../server/launchers.js';
import { startTestServer, makeRepo, tmpDir, rmrf, gitIn, waitFor, waitPidGone } from './helpers.js';

const IDENTITY = 'ab'.repeat(32);
const root = tmpDir();
const bin = path.join(root, 'Program Files тест', '.gigacode', 'bin');
const shim = path.join(bin, 'gigacode.cmd');
const entry = path.join(bin, 'lib', 'cli-entry.js');
const badShim = path.join(bin, 'no-identity.cmd');
const argvFile = path.join(root, 'argv.jsonl');
const shimText = (identity) => [
  '@ECHO off',
  'SETLOCAL',
  ...(identity ? [`set "GIGACODE_PACKAGE_IDENTITY=${identity}"`] : []),
  'set "GIGACODE_PACKAGE_LAUNCHER=%~f0"',
  '"%~dp0runtime\\node\\node.exe" --max-old-space-size=6144 "%~dp0lib\\cli-entry.js" %*',
  '',
].join('\r\n');
const MODES = ['plan', 'default', 'auto-edit', 'auto'];
const giga = (command) => ({
  launcher: 'gigacode', label: 'GigaCode (fake)', command, node: null, cliEntry: null, nodeArgs: ['--max-old-space-size=6144'],
  approvalMode: 'auto', approvalModes: MODES, settingsEnv: 'GIGACODE_SYSTEM_SETTINGS_PATH', firstEventTimeoutMs: 15000,
  settings: { agents: { modelGrades: {}, allowedGrades: [] }, chatRecording: true, permissions: { allow: ['everything'] } },
});

let h;
let repo;
before(async () => {
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.copyFileSync(path.join(CODE_ROOT, 'scripts', 'mock-agent.js'), entry);
  fs.writeFileSync(shim, shimText(IDENTITY));
  fs.writeFileSync(badShim, shimText(null));
  repo = makeRepo(path.join(root, 'репо'));
  process.env.MOCK_AGENT_ARGV_FILE = argvFile;
  h = await startTestServer({
    agents: { giga: giga(shim), gigabad: giga(badShim) },
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

test('shim parsing: identity, bundled entry, explicit node+cliEntry pair', () => {
  assert.equal(shimIdentity(shimText(IDENTITY)), IDENTITY);
  assert.equal(shimIdentity(shimText(null)), null);
  const r = resolveGigacode(giga(shim));
  assert.deepEqual(r, { file: process.execPath, args: ['--max-old-space-size=6144', entry], env: { GIGACODE_PACKAGE_IDENTITY: IDENTITY, GIGACODE_PACKAGE_LAUNCHER: shim } });
  assert.throws(() => resolveGigacode(giga(badShim)), /GIGACODE_PACKAGE_IDENTITY not found/);
  assert.throws(() => resolveGigacode(giga(path.join(bin, 'missing.cmd'))), /launcher not found/);
  assert.throws(() => resolveGigacode({ ...giga(shim), node: process.execPath }), /must be set together/);
  assert.throws(() => resolveGigacode({ ...giga(shim), node: process.execPath, cliEntry: path.join(bin, 'nope.js') }), /cliEntry does not exist/);
  assert.equal(resolveGigacode({ ...giga(shim), node: process.execPath, cliEntry: entry }).args.at(-1), entry);
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
  assert.deepEqual(first.argv, ['--max-old-space-size=6144', entry, '-p', 'hello', ...tail]);
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
