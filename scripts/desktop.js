// Desktop shell: the same server in its own window instead of a browser tab. Started by `npm run desktop`.
// The harness and its agents run under Node (node:sqlite, node-pty), so Electron must not own them: from a terminal
// this entry point opens the window; inside Electron, with the desktop marker, it shows the same window in this process.
// Without `--ui` it runs the server itself, which is also how the window's own server starts.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DESKTOP_FLAG = '--harness-desktop';
const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '..');

export const isElectron = (versions = process.versions) => Boolean(versions.electron);

/** A Node interpreter that can run the harness server (Electron's own binary is Chromium, not Node, on every platform). */
export const nodeCommand = (env = process.env) => /[\\/]electron(\.exe)?$/i.test(env.npm_node_execpath || '') ? 'node' : env.npm_node_execpath || 'node';

/** The window hands its flags to the same entry, so `npm run desktop -- --demo` stays an offline demo. */
export function npmArgs(script, flag, argv, scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts || {}, entry = 'scripts/desktop.js') {
  const words = (scripts[script] || '').split(/\s+/).filter(Boolean);
  // `npm run desktop` is `[node, scripts/ensure-bin.js, &&, node, scripts/desktop.js, --ui]`: start after its entry point
  const at = words.findIndex((w) => w.replace(/\\/g, '/').endsWith(entry));
  if (at < 0) return []; // another script runs another entry: neither the marker nor this script's flags belong to it
  const flags = [...new Set([...words.slice(at + 1).filter((w) => w.startsWith('-')), ...argv.filter((a) => a !== flag)])].filter((a) => a !== '--ui');
  // the marker leads the window's argv, and only once: Electron reads the rest as its own switches
  return [flag, ...flags.filter((a) => a !== flag)];
}

/**
 * The Electron binary this repository installed. `require('electron')` answers with the binary's path, unless the
 * package was not resolved at all — a thrown error inside Electron's module system can end the process on the spot,
 * so the walk up the folders reports "not installed" as a plain value instead.
 */
export function findByWalk(start, pkg = 'electron', seen = new Set()) {
  for (let dir = start; !seen.has(dir); dir = dirname(dir)) {
    seen.add(dir);
    const candidate = join(dir, 'node_modules', pkg);
    try {
      if (!statSync(candidate).isDirectory()) continue;
    } catch {
      if (dirname(dir) === dir) return null;
      continue;
    }
    const entry = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')).main || 'index.js';
    return join(candidate, entry);
  }
  return null;
}

/**
 * Chromium switches this machine needs before Electron can start at all. Linux sandboxes the renderer with user
 * namespaces; where they are off (Ubuntu >= 23.10 restricts them through AppArmor, hardened kernels, a container's seccomp)
 * Chromium falls back to chrome-sandbox, which works only as a setuid-root file — and `npm install` never makes it one.
 * Then the start dies before any window, so the window runs without the OS sandbox instead: it shows only the local app,
 * and links leave for the system browser.
 */
export function sandboxSwitches(electron, { platform = process.platform, uid = process.getuid?.(), read = readFileSync, stat = statSync, probe = () => spawnSync('unshare', ['--user', 'true'], { stdio: 'ignore', timeout: 5000 }) } = {}) {
  if (platform !== 'linux' || !existsSync(electron)) return [];
  if (uid === 0) return ['--no-sandbox']; // Chromium refuses to run as root with a sandbox
  const sysctl = (name) => { try { return String(read(`/proc/sys/${name}`, 'utf8')).trim(); } catch { return null; } };
  const userns = sysctl('kernel/apparmor_restrict_unprivileged_userns') !== '1' && sysctl('kernel/unprivileged_userns_clone') !== '0' && sysctl('user/max_user_namespaces') !== '0';
  // the sysctls can allow them while seccomp still refuses: one real try (no `unshare` at all means no answer, not a no)
  const tried = userns && probe();
  if (userns && (tried.error?.code === 'ENOENT' || tried.status === 0)) return [];
  try {
    const helper = stat(join(dirname(electron), 'chrome-sandbox'));
    if (helper.uid === 0 && helper.mode & 0o4000) return [];
  } catch {}
  return ['--no-sandbox'];
}

/** The window's own argv: the app entry Electron loads, then the desktop marker and whatever the script added. */
export function electronArgs(root = ROOT, argv = process.argv, scripts, electron = electronBinary(root), switches = sandboxSwitches(electron)) {
  // Electron loads its first argument as an app package (ESM there never reaches app readiness), so the entry is named
  // here and `--ui` stays behind: the window process must never spawn another window
  const entry = resolve(root, 'scripts', 'desktop-window.cjs');
  const flags = npmArgs('desktop', DESKTOP_FLAG, argv.slice(2), scripts); // leads with the marker, which the shell adds below
  return [electron, [entry, DESKTOP_FLAG, ...flags.filter((a) => a !== DESKTOP_FLAG), ...switches]];
}

/** The flags the window process keeps: the marker and Electron's own switches stay with the shell, `--ui` names this entry. */
export function desktopArgv(argv) {
  return argv.filter((a) => a !== '--ui' && a !== DESKTOP_FLAG);
}

/** The Electron binary this repository installed; a string is the path, a module object means "already inside Electron". */
export function electronBinary(root = ROOT, requireFrom, inside = isElectron()) {
  if (inside) return resolve(root, 'scripts', 'desktop-window.cjs'); // the window process spawns nothing
  const entry = findByWalk(root);
  if (!entry) return 'electron'; // npm's own bin; the start then fails with npm's message
  // `createRequire` is resolved here, not in the signature: a module-scope binding is not there yet when it is built
  const load = typeof requireFrom === 'function' ? requireFrom : createRequire(resolve(root, 'package.json'));
  const loaded = load(resolve(entry));
  return typeof loaded === 'string' ? loaded : join(dirname(entry), 'dist', readFileSync(join(dirname(entry), 'path.txt'), 'utf8'));
}

/** `npm run desktop` → Electron with the desktop marker; anything else → the plain server. */
export function runDesktop(root = ROOT, argv = process.argv, spawnProcess = spawn, electronPath = electronBinary(root)) {
  if (argv.includes('--ui')) {
    const window = electronArgs(root, argv, undefined, electronPath);
    const child = spawnProcess(...window, { cwd: root, stdio: 'inherit', windowsHide: false });
    // Electron's own exit never decides ours: a console (Ctrl+C, a closed terminal, a dev reload) must not end the
    // window it started, so this entry waits for the window to be closed instead of mirroring its exit code
    const exitWindows = () => (process.platform === 'win32' ? child.kill() : process.kill(child.pid, 'SIGTERM'));
    process.on('SIGINT', exitWindows);
    process.on('SIGTERM', exitWindows);
    child.on('exit', () => process.exit(0));
    return;
  }
  // no window asked for: the server itself, with the same flags — or the same answers it gives without starting
  const asked = argv.find((a) => INSPECT_FLAGS.includes(a));
  if (asked) inspect(asked);
  else runServer(argv);
}

/** Flags that report on this machine instead of serving: they must not take the data directory a running harness holds. */
export const INSPECT_FLAGS = ['--check', '--print-config'];

async function inspect(flag) {
  const { checkSetup, describeConfig } = await import('../server/index.js');
  const { loadConfig } = await import('../server/config.js');
  if (flag === '--print-config') return console.log(JSON.stringify(describeConfig(loadConfig()), null, 2));
  const result = checkSetup(loadConfig());
  for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
  console.log(result.ok ? 'Готово к запуску.' : 'Есть пункты, без которых харнес не запустится (см. FAIL выше).');
  process.exitCode = result.ok ? 0 : 1;
}

/** The server under this interpreter — the same module the server's own entry point runs. */
async function runServer(argv) {
  const { startServer } = await import('../server/index.js');
  const arg = (n) => { const i = argv.indexOf(n); return i > 0 ? argv[i + 1] : undefined; };
  const port = arg('--port') === undefined ? undefined : Number(arg('--port'));
  const srv = await startServer({ dev: argv.includes('--dev'), demo: argv.includes('--demo'), port, dataDir: arg('--data-dir') });
  console.log(`Harness running at ${srv.url}`);
  const shutdown = () => {
    srv.flush();
    srv.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// a plain `node scripts/desktop.js …`. Inside Electron this file is never an entry: the window gets desktop-window.cjs,
// which Electron can load as an ordinary CommonJS app.
if (process.argv[1] && !isElectron() && realpathSync(process.argv[1]) === realpathSync(SELF)) await runDesktop();
