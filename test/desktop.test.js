// The desktop shell (`npm run desktop`): the same server in a window instead of a browser tab.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CODE_ROOT } from '../server/config.js';
import { DESKTOP_FLAG, desktopArgv, electronArgs, electronBinary, isElectron, nodeCommand, npmArgs, runDesktop, sandboxSwitches } from '../scripts/desktop.js';
import { desktopDataDir, pickPort, startHarness, stopHarness } from '../scripts/desktop-app.js';
import { bundleScript, desktopEntry, infoPlist, makeShortcuts } from '../scripts/shortcut.js';
process.env.HARNESS_TEST_NO_REAL_CLI = '1'; // the harness these tests start never runs the real agent CLI by itself

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const scripts = { desktop: 'node scripts/ensure-bin.js && node scripts/desktop.js --ui', start: 'node server/index.js', demo: 'node server/index.js --demo' };
const defaultRequire = createRequire(new URL('../package.json', import.meta.url));

/** A stand-in for a child process: records what was started, reports exit when told. */
function fakeChild(pid = 4242) {
  const listeners = { exit: [], error: [] };
  return {
    pid,
    exitCode: null,
    signalCode: null,
    on: (event, fn) => listeners[event].push(fn),
    exit: (code = 0) => {
      for (const fn of listeners.exit) fn(code);
    },
  };
}

test('npm run desktop -- --demo keeps its flags, in front of the window, once', () => {
  // `--ui` names the terminal entry only: the window must never ask for another window
  assert.deepEqual(npmArgs('desktop', DESKTOP_FLAG, ['--demo', DESKTOP_FLAG], scripts), [DESKTOP_FLAG, '--demo']);
  assert.deepEqual(npmArgs('desktop', DESKTOP_FLAG, [], scripts), [DESKTOP_FLAG]); // the script's own flags are read, `--ui` is not one
  assert.deepEqual(npmArgs('desktop', DESKTOP_FLAG, ['--ui', '--demo'], scripts), [DESKTOP_FLAG, '--demo']); // said twice, kept once
  assert.deepEqual(npmArgs('start', DESKTOP_FLAG, ['--dev'], scripts), []); // a missing script must not invent arguments
  assert.deepEqual(npmArgs('desktop', DESKTOP_FLAG, []), [DESKTOP_FLAG]); // the real package.json's own script
});

test('the server runs under node, never under the Electron binary', () => {
  const npm = (exec) => ({ npm_node_execpath: exec });
  assert.equal(nodeCommand(npm(path.join(CODE_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'))), 'node');
  assert.equal(nodeCommand(npm(path.join(CODE_ROOT, 'node_modules', 'electron', 'dist', 'electron'))), 'node'); // Linux and macOS
  assert.equal(nodeCommand(npm(path.join(CODE_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'))), 'node');
  assert.equal(nodeCommand(npm('C:\\Program Files\\nodejs\\node.exe')), 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(nodeCommand(npm('/usr/bin/node')), '/usr/bin/node');
  assert.equal(nodeCommand({}), 'node');
});

test('the window takes the first free port from the configured one, without touching it', async () => {
  const free = (...taken) => async (port) => !taken.includes(port);
  assert.equal(await pickPort({ port: 4777 }, { free: free() }), 4777);
  assert.equal(await pickPort({}, { free: free(4777) }), 4778); // a running harness keeps its port; the window moves up
  assert.equal(await pickPort({ port: 4780 }, { free: free(4780, 4781) }), 4782);
  assert.equal(await pickPort({ port: 4990 }, { free: free(), scan: 5 }), 4990);
});

test('an idle data dir is used as is; a live one pushes the window to its own folder', () => {
  const baseDir = path.join('C:', 'repo', 'data');
  assert.equal(desktopDataDir({ baseDir, root: 'C:\\repo', port: 4777, running: null }), baseDir);
  const own = desktopDataDir({ baseDir, root: 'C:\\repo', port: 4778, running: 'http://127.0.0.1:4777' });
  assert.equal(path.dirname(own), baseDir);
  assert.match(path.basename(own), /^C-repo-4778$/); // one instance per root and port, never the live folder itself
});

test('the window is Electron with its own entry, the marker and the script flags', () => {
  const entry = path.join(CODE_ROOT, 'scripts', 'desktop-window.cjs');
  const argsFor = (...argv) => electronArgs(CODE_ROOT, ['node', 'scripts/desktop.js', ...argv], scripts, 'electron-binary')[1];
  // the entry leads: Electron would otherwise load a plain Node entry, and an ESM one never reaches app readiness
  assert.deepEqual(argsFor('--demo'), [entry, DESKTOP_FLAG, '--demo']);
  assert.deepEqual(argsFor(), [entry, DESKTOP_FLAG]); // `--ui` stayed with the terminal entry
  assert.deepEqual(argsFor('--port', '4790'), [entry, DESKTOP_FLAG, '--port', '4790']);
  assert.ok(!argsFor('--ui').includes('--ui'), 'the window must not start another window');
  assert.deepEqual(npmArgs('start', DESKTOP_FLAG, ['--dev'], scripts), []); // another script invents nothing
  // the window process keeps only the flags it reads: the marker stays with the shell
  assert.deepEqual(desktopArgv([DESKTOP_FLAG, '--demo']), ['--demo']);
});

test('the real package.json leads to the Electron binary, not a module object', () => {
  const electronDir = path.join(CODE_ROOT, 'node_modules', 'electron');
  const binary = electronBinary(CODE_ROOT); // Electron 45 downloads its binary on first require, not at npm install
  const installed = path.join(electronDir, 'dist', fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8'));
  assert.equal(typeof binary, 'string');
  assert.ok(fs.existsSync(binary), `electron binary exists: ${binary}`);
  // inside Electron there is no binary to start: the window entry is what the shell names
  assert.equal(electronBinary(CODE_ROOT, undefined, true), path.join(CODE_ROOT, 'scripts', 'desktop-window.cjs'));
  // and a module object instead of a path still falls back to the installed binary
  assert.equal(electronBinary(CODE_ROOT, () => ({ app: {} }), false), installed);
  const [, args] = electronArgs(CODE_ROOT, ['node', 'scripts/desktop.js', '--ui'], scripts, binary);
  assert.equal(args[0], path.join(CODE_ROOT, 'scripts', 'desktop-window.cjs'));
  assert.ok(args.includes(DESKTOP_FLAG), `the marker is passed: ${args.join(' ')}`);
});

test('the terminal entry starts Electron for the window and the server itself without `--ui`', async () => {
  const spawns = [];
  const exits = [];
  const realExit = process.exit;
  process.exit = (code) => {
    exits.push(code);
  };
  try {
    assert.equal(isElectron(), false);
    // `--ui` → Electron with the window entry and the flags; nothing here serves a port
    runDesktop(CODE_ROOT, ['node', path.join(CODE_ROOT, 'scripts', 'desktop.js'), '--ui', '--demo'], (cmd, args, opts) => {
      spawns.push({ cmd, args, opts });
      return fakeChild();
    }, 'electron-binary');
  } finally {
    process.exit = realExit;
  }
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].cmd, 'electron-binary');
  assert.deepEqual(spawns[0].args, [path.join(CODE_ROOT, 'scripts', 'desktop-window.cjs'), DESKTOP_FLAG, '--demo']);
  assert.equal(spawns[0].opts.cwd, CODE_ROOT);
  assert.deepEqual(exits, []);
});

test('the desktop path answers --check and --print-config without taking a live data dir', { timeout: 120000 }, async () => {
  const dataDir = tmp('harness-desktop-check-');
  // a running harness holds its data dir through server.json: reporting on this machine must not fight it for the lock
  fs.writeFileSync(path.join(dataDir, 'server.json'), JSON.stringify({ pid: process.pid, port: 4777 }));
  const run = (flag) => spawnSync(process.execPath, [path.join(CODE_ROOT, 'scripts', 'desktop.js'), flag, '--data-dir', dataDir], { cwd: CODE_ROOT, encoding: 'utf8', timeout: 60000 });
  try {
    const printed = run('--print-config');
    assert.equal(printed.status, 0, printed.stderr);
    assert.match(printed.stdout, /"dataDir"/);
    const checked = run('--check');
    assert.match(checked.stdout, /node: node \d+/);
    assert.match(checked.stdout, /web\/dist|Готово к запуску|FAIL/);
    assert.doesNotMatch(`${checked.stdout}${checked.stderr}`, /ELOCKED/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a failed start says why and leaves no lock or server process behind', { timeout: 120000 }, async () => {
  const dataDir = tmp('harness-desktop-fail-');
  // something else already answers on this port: the server must refuse it instead of taking the window down silently
  const other = spawn(process.execPath, ['-e', "require('http').createServer((q,s)=>s.end(JSON.stringify({ok:true,pid:process.pid}))).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve) => other.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  const harness = startHarness({ root: CODE_ROOT, node: process.execPath, flag: DESKTOP_FLAG, argv: ['--port', String(port)], dataDir });
  try {
    // the server exits on EADDRINUSE — the desktop shell shows its error page instead of a white window
    assert.equal(await harness.url, null);
    assert.equal(harness.child.exitCode !== null || harness.child.signalCode !== null, true, 'server is gone');
    assert.equal(fs.existsSync(path.join(dataDir, 'server.json')), false);
  } finally {
    other.kill();
    await stopHarness(harness.child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

/** A real harness through the desktop path, in its own temp data dir and on a free port. */
async function withHarness(fn) {
  const dataDir = tmp('harness-desktop-');
  const cfgDir = tmp('harness-desktop-cfg-');
  const configFile = path.join(cfgDir, 'harness.config.json');
  fs.copyFileSync(path.join(CODE_ROOT, 'harness.config.json'), configFile);
  const port = await pickPort({}, {});
  const harness = startHarness({ root: CODE_ROOT, node: process.execPath, flag: DESKTOP_FLAG, argv: ['--port', String(port)], dataDir, env: { ...process.env, HARNESS_CONFIG: configFile }, wait: () => new Promise((r) => setTimeout(r, 100)) });
  try {
    return await fn({ harness, url: await harness.url, dataDir });
  } finally {
    await stopHarness(harness.child, { graceMs: 10000 });
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
}

test('the window gets a live harness with a token-protected page', { timeout: 120000 }, async () => {
  await withHarness(async ({ url, dataDir }) => {
    assert.ok(url && /^http:\/\/127\.0\.0\.1:\d+$/.test(url), `url: ${url}`);
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf8')), { url, pid: health.pid });
    const page = await (await fetch(`${url}/`)).text();
    assert.match(page, /<meta name="harness-token" content="[^"]+">/); // what the UI reads instead of a browser's storage
    assert.equal((await fetch(`${url}/api/state`)).status, 401);
  });
});

test('stopHarness ends a running server and leaves nothing behind', { timeout: 90000 }, async () => {
  const dataDir = tmp('harness-desktop-stop-');
  const cfgDir = tmp('harness-desktop-stop-cfg-');
  const configFile = path.join(cfgDir, 'harness.config.json');
  fs.copyFileSync(path.join(CODE_ROOT, 'harness.config.json'), configFile);
  const port = await pickPort({}, {});
  try {
    const harness = startHarness({ root: CODE_ROOT, node: process.execPath, flag: DESKTOP_FLAG, argv: ['--port', String(port)], dataDir, env: { ...process.env, HARNESS_CONFIG: configFile } });
    const url = await harness.url;
    assert.ok(url);
    await stopHarness(harness.child);
    assert.ok(harness.child.exitCode !== null || harness.child.signalCode !== null, 'server exit code recorded');
    await assert.rejects(fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) }));
    const alive = spawnSync(process.execPath, ['-e', `try{process.kill(${harness.child.pid},0);console.log('alive')}catch{console.log('gone')}`]).stdout.toString().trim();
    assert.equal(alive, 'gone');
    // a clean shutdown removes its lock; a killed process may not get to say so — the port is what matters
    assert.ok(!fs.existsSync(path.join(dataDir, 'server.json')) || (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) }).then(() => false, () => true)));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

test('a stale lock record does not refuse the window its own server', { timeout: 90000 }, async () => {
  const dataDir = tmp('harness-desktop-stale-');
  const cfgDir = tmp('harness-desktop-stale-cfg-');
  const configFile = path.join(cfgDir, 'harness.config.json');
  fs.copyFileSync(path.join(CODE_ROOT, 'harness.config.json'), configFile);
  fs.writeFileSync(path.join(dataDir, 'server.json'), JSON.stringify({ url: 'http://127.0.0.1:9', pid: 999999 }));
  const port = await pickPort({}, {});
  const harness = startHarness({ root: CODE_ROOT, node: process.execPath, flag: DESKTOP_FLAG, argv: ['--port', String(port)], dataDir, env: { ...process.env, HARNESS_CONFIG: configFile } });
  try {
    assert.ok(await harness.url);
  } finally {
    await stopHarness(harness.child);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

test('the Linux shortcut is a runnable .desktop entry with the app icon, in the menu and on the desktop', () => {
  const home = tmp('harness-home-');
  try {
    const entry = desktopEntry({ exec: '/opt/my apps/start-harness.sh', icon: '/opt/my apps/build/app-icon.png', workDir: '/opt/my apps' });
    assert.match(entry, /^\[Desktop Entry\]\n/);
    assert.match(entry, /^Exec=\/bin\/sh "\/opt\/my apps\/start-harness\.sh"$/m); // a quoted path keeps its spaces whole, no run bit needed
    assert.match(entry, /^StartupWMClass=sber-harness$/m);
    assert.match(entry, /^Path=\/opt\/my apps$/m);
    assert.match(entry, /^Icon=\/opt\/my apps\/build\/app-icon\.png$/m);
    assert.match(entry, /^Terminal=false$/m); // the window is the app: no console opens next to it
    assert.match(entry, /^Type=Application$/m);
    // `%` is the format's field code, never a literal one
    assert.match(desktopEntry({ exec: '/x/100%/go.sh', icon: '/i.png', workDir: '/x' }), /^Exec=\/bin\/sh "\/x\/100%%\/go\.sh"$/m);
    // a quote inside: escaped for the quoting rule, then its backslash doubled for the string rule
    assert.match(desktopEntry({ exec: '/x/a"b/go.sh', icon: '/i.png', workDir: '/x' }), /^Exec=\/bin\/sh "\/x\/a\\\\"b\/go\.sh"$/m);
    const made = makeShortcuts({ root: path.join(home, 'repo'), env: { HOME: home }, platform: 'linux' });
    const expected = [path.join(home, '.local', 'share', 'applications', 'sber-harness.desktop'), path.join(home, 'Desktop', 'sber-harness.desktop')];
    assert.deepEqual(made, expected);
    for (const file of expected) {
      assert.equal(fs.readFileSync(file, 'utf8'), desktopEntry({ exec: path.join(home, 'repo', 'start-harness.sh'), icon: path.join(home, 'repo', 'build', 'app-icon.png'), workDir: path.join(home, 'repo') }));
      // the run bit is what makes the shell launch it instead of opening the text
      if (process.platform !== 'win32') assert.ok(fs.statSync(file).mode & 0o100, `runnable: ${file}`);
    }
    assert.deepEqual(makeShortcuts({ root: path.join(home, 'repo'), env: { HOME: home }, platform: 'linux' }), expected); // a second run rewrites nothing new
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('macOS gets an app bundle that runs the launcher, in ~/Applications and on the desktop', () => {
  const home = tmp('harness-mac-home-');
  const runs = [];
  try {
    const root = path.join(home, "my repo's");
    const made = makeShortcuts({ root, env: { HOME: home }, platform: 'darwin', run: (cmd, args) => runs.push([cmd, ...args]) });
    assert.deepEqual(made, [path.join(home, 'Applications', 'sber-harness.app'), path.join(home, 'Desktop', 'sber-harness.app')]);
    for (const app of made) {
      const exe = path.join(app, 'Contents', 'MacOS', 'sber-harness');
      assert.equal(fs.readFileSync(exe, 'utf8'), bundleScript(path.join(root, 'start-harness.sh')));
      if (process.platform !== 'win32') assert.ok(fs.statSync(exe).mode & 0o100, `runnable: ${exe}`);
      assert.equal(fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8'), infoPlist());
    }
    // a quote in the path stays inside one shell word
    assert.equal(bundleScript("/a b/it's/start-harness.sh"), "#!/bin/sh\nexec /bin/sh '/a b/it'\\''s/start-harness.sh'\n");
    assert.match(infoPlist(), /<key>CFBundleExecutable<\/key><string>sber-harness<\/string>/);
    assert.match(infoPlist(), /<key>LSUIElement<\/key><true\/>/); // no second Dock icon next to the window's
    assert.deepEqual(runs[0].slice(0, 4), ['sips', '-s', 'format', 'icns']); // the icon is converted from build/app-icon.png
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Linux without a usable sandbox starts the window with --no-sandbox instead of crashing', () => {
  const bin = process.execPath; // any file that exists stands for the Electron binary
  const sysctl = (values) => (file) => { if (file in values) return values[file]; throw new Error('ENOENT'); };
  const stat = (uid, mode) => () => ({ uid, mode });
  const opts = (o) => ({ platform: 'linux', uid: 1000, read: sysctl({}), stat: stat(1000, 0o755), probe: () => ({ status: 0 }), ...o });
  assert.deepEqual(sandboxSwitches(bin, opts({})), []); // user namespaces work: Chromium sandboxes by itself
  assert.deepEqual(sandboxSwitches(bin, opts({ read: sysctl({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' }) })), ['--no-sandbox']); // Ubuntu >= 23.10
  assert.deepEqual(sandboxSwitches(bin, opts({ read: sysctl({ '/proc/sys/kernel/unprivileged_userns_clone': '0' }), stat: stat(0, 0o104755) })), []); // a setuid-root helper
  assert.deepEqual(sandboxSwitches(bin, opts({ probe: () => ({ status: 1 }) })), ['--no-sandbox']); // allowed, yet refused (seccomp)
  assert.deepEqual(sandboxSwitches(bin, opts({ probe: () => ({ status: 1 }), stat: stat(0, 0o104755) })), []);
  assert.deepEqual(sandboxSwitches(bin, opts({ probe: () => ({ error: { code: 'ENOENT' } }) })), []); // no unshare: no evidence against
  assert.deepEqual(sandboxSwitches(bin, opts({ uid: 0 })), ['--no-sandbox']); // root (a container)
  assert.deepEqual(sandboxSwitches(bin, opts({ platform: 'darwin', uid: 0 })), []);
  assert.deepEqual(sandboxSwitches(path.join(bin, 'missing'), opts({ uid: 0 })), []); // nothing to start, nothing to decide
});
