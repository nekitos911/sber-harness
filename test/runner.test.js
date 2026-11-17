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
function turn(prompt, session = {}, firstEventTimeoutMs = 10000) {
  const s = { id: 's_test', externalSessionId: null, approvalMode: null, model: null, ...session };
  const ctx = { prompt, session: s, agentCfg: { approvalMode: 'yolo' }, settingsPath: path.join(dir, 'settings.json'), harnessMcp: {}, agentMcpServers: {} };
  const events = [];
  const handle = runTurn({
    launcher, ctx, command: launcher.defaults.command, cwd: dir, env: { ...process.env },
    firstEventTimeoutMs, logFile: path.join(dir, 'stderr.log'), onEvent: (e) => events.push(e),
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
  assert.throws(() => resolveCommand('definitely-not-a-command-xyz'), /argv array/);
  if (process.platform === 'win32') {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(path.join(bin, 'node_modules', 'tool'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'mytool.cmd'), '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\tool\\cli.js" %*\r\n');
    const r = resolveCommand('mytool', { PATH: bin, PATHEXT: '.EXE;.CMD' });
    assert.deepEqual(r, { file: process.execPath, args: [path.join(bin, 'node_modules', 'tool', 'cli.js')] });
  }
});
