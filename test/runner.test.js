import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchers } from '../server/launchers.js';
import { runTurn, resolveCommand } from '../server/runner.js';
import { tmpDir, rmrf } from './helpers.js';

const dir = tmpDir();
process.env.MOCK_AGENT_STATE_DIR = path.join(dir, 'mock-state');
after(() => rmrf(dir));

const launcher = launchers.mock;
let runSeq = 0;
const files = () => {
  const n = ++runSeq;
  return { logFile: path.join(dir, 'stderr.log'), outFile: path.join(dir, `turn-${n}.out.ndjson`), errFile: path.join(dir, `turn-${n}.err.txt`) };
};
function turn(prompt, session = {}, firstEventTimeoutMs = 10000) {
  const s = { id: 's_test', externalSessionId: null, approvalMode: null, model: null, ...session };
  const ctx = { prompt, session: s, agentCfg: { approvalMode: 'yolo' }, settingsPath: path.join(dir, 'settings.json'), harnessMcp: {}, agentMcpServers: {} };
  const events = [];
  const handle = runTurn({
    launcher, ctx, command: launcher.defaults.command, cwd: dir, env: { ...process.env },
    firstEventTimeoutMs, ...files(), onEvent: (e) => events.push(e),
  });
  return { handle, events, done: handle.done.then((res) => ({ res, events })) };
}
const text = (events) => events.filter((e) => e.type === 'text').map((e) => e.text).join('');

test('captures the session id and resumes it on the next turn', async () => {
  const first = await turn('hello').done;
  assert.equal(first.res.code, 0);
  assert.equal(first.res.sawResult, true);
  const sid = first.events.find((e) => e.type === 'session')?.id;
  assert.ok(sid);
  assert.ok(first.events.some((e) => e.type === 'tool_call') && first.events.some((e) => e.type === 'tool_result'));

  const args = launcher.buildArgs({ prompt: 'again', session: { externalSessionId: sid }, agentCfg: { approvalMode: 'yolo' } });
  assert.deepEqual(args.slice(0, 2), ['--resume', sid]);
  const second = await turn('again', { externalSessionId: sid }).done;
  assert.match(text(second.events), new RegExp(`resumed ${sid}, turn 2`));
});

test('first-event timeout kills a silent agent', async () => {
  const t0 = Date.now();
  const { res } = await turn('#silent', {}, 700).done;
  assert.equal(res.timedOut, true);
  assert.ok(Date.now() - t0 < 8000);
});

test('crash reports exit code and stderr', async () => {
  const { res } = await turn('#crash').done;
  assert.equal(res.code, 1);
  assert.equal(res.sawResult, false);
  assert.match(res.stderrTail, /simulated crash/);
});

test('stop kills a running turn', async () => {
  const t = turn('#slow');
  await new Promise((r) => setTimeout(r, 600));
  t.handle.stop();
  const { res } = await t.done;
  assert.equal(res.stopped, true);
  assert.equal(res.sawResult, false);
});

test('resolveCommand: argv arrays, node, missing commands, .cmd shims', () => {
  assert.deepEqual(resolveCommand(['node', 'x.js']), { file: process.execPath, args: ['x.js'] });
  assert.throws(() => resolveCommand('definitely-not-a-command-xyz'), /массивом argv/);
  if (process.platform === 'win32') {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(path.join(bin, 'node_modules', 'tool'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'mytool.cmd'), '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\tool\\cli.js" %*\r\n');
    const r = resolveCommand('mytool', { PATH: bin, PATHEXT: '.EXE;.CMD' });
    assert.deepEqual(r, { file: process.execPath, args: [path.join(bin, 'node_modules', 'tool', 'cli.js')] });
  }
});

function scriptTurn(name, source, extra = {}) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  const s = { id: 's_x', externalSessionId: null, approvalMode: null, model: null };
  const ctx = { prompt: 'x', session: s, agentCfg: {}, settingsPath: path.join(dir, 'settings.json') };
  const events = [];
  return runTurn({
    launcher, ctx, command: [process.execPath, file], cwd: dir, env: { ...process.env }, firstEventTimeoutMs: 10000,
    ...files(), onEvent: (e) => events.push(e), ...extra,
  }).done.then((res) => ({ res, events }));
}

test('NDJSON split across chunks, non-JSON lines as raw events, stderr and exit code kept', async () => {
  const { res, events } = await scriptTurn('split-agent.js', String.raw`
    process.stdout.write('{"type":"init","session_id":"split-1"}\n{"type":"message","role":"assistant","con');
    setTimeout(() => {
      process.stdout.write('tent":"joined","delta":true}\nnot json 1\nnot json 2\n');
      process.stderr.write('boom: something failed\n');
      process.exitCode = 3;
    }, 150);
  `);
  assert.deepEqual(events, [
    { type: 'session', id: 'split-1' },
    { type: 'text', text: 'joined', delta: true },
    { type: 'raw', text: 'not json 1' },
    { type: 'raw', text: 'not json 2' },
  ]);
  assert.equal(res.code, 3);
  assert.match(res.stderrTail, /boom: something failed/);
});

test('over-long stdout lines are truncated with a marker; the stream continues', async () => {
  const { events } = await scriptTurn('long-agent.js', String.raw`
    process.stdout.write('x'.repeat(3000));
    setTimeout(() => process.stdout.write('y'.repeat(3000) + '\n{"type":"result","status":"success"}\n'), 100);
  `, { maxLine: 1000 });
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'raw');
  assert.ok(events[0].text.startsWith('x'.repeat(1000)) && events[0].text.endsWith('[line truncated by harness]'));
  assert.deepEqual(events[1], { type: 'result', text: null, isError: false });
});

test('spawn options: Windows children are never detached (DETACHED_PROCESS would void windowsHide), POSIX turns get a group', async () => {
  const { spawnOptions } = await import('../server/runner.js');
  assert.deepEqual(spawnOptions({ cwd: 'x' }, { group: true, platform: 'win32' }), { cwd: 'x', windowsHide: true, detached: false });
  assert.deepEqual(spawnOptions({}, { group: true, platform: 'linux' }), { windowsHide: true, detached: true });
  assert.deepEqual(spawnOptions({ detached: true }, { platform: 'linux' }), { windowsHide: true, detached: false }, 'only `group` decides');
});
