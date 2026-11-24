// The Electron side of the desktop shell (imported only when process.versions.electron is set).
// The window shows what the server already serves; closing it stops the server this window started.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { nodeCommand } from './desktop.js';

const DEFAULT_PORT = 4777;
const CONNECT_TIMEOUT_MS = 20000;
const POLL_MS = 200;
const STOP_GRACE_MS = 15000;

const isUp = async (record) => {
  if (typeof record?.url !== 'string') return false;
  try {
    const health = await (await fetch(`${record.url}/api/health`, { signal: AbortSignal.timeout(1000) })).json();
    return health?.ok === true && (!record.pid || health.pid === record.pid);
  } catch {
    return false;
  }
};

/** The address of a harness that is up and answering right now (`<dataDir>/server.json`, if any). */
export async function runningHarness(serverJson) {
  let record;
  try {
    record = JSON.parse(readFileSync(serverJson, 'utf8'));
  } catch {
    return null;
  }
  return (await isUp(record)) ? record.url : null;
}

const portFree = (port, host) =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });

/**
 * The port the desktop instance starts on: the one its config names, or the first free one from 4777 up. A harness
 * already running there is never stopped for the window — it just gets the next port.
 */
export async function pickPort(config, { host = '127.0.0.1', scan = 50, free = portFree } = {}) {
  const wanted = Number.isInteger(config?.port) ? config.port : DEFAULT_PORT;
  for (let port = wanted; port < wanted + scan; port++) if (await free(port, host)) return port;
  return 0; // no free port in the scan: let the system choose one
}

/** A folder name that is safe on every platform (workspaces are absolute paths). */
const slug = (s) => String(s).replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-]+$/g, '') || 'workspace';

/**
 * Where the desktop instance keeps its data: the harness's own data dir while it is idle, otherwise a sibling per root
 * and port — the two instances then hold separate locks and separate boards instead of fighting over one.
 */
export function desktopDataDir({ baseDir, root, port, running = null }) {
  return running ? path.join(baseDir, `${slug(root)}-${port}`) : baseDir;
}

/**
 * Starts the harness next to the window and resolves its URL once /api/health answers for that pid.
 * Resolves null if the server exits first (its own reason, e.g. a taken port, is already on stderr).
 */
export function startHarness({ root, node, flag, argv = [], dataDir, env = process.env, spawnProcess = spawn, wait = () => new Promise((r) => setTimeout(r, POLL_MS)) }) {
  const serverJson = path.join(dataDir, 'server.json');
  // never the harness's own data dir: a record left there by a run that did not finish cleanly must not be deleted
  rmSync(serverJson, { force: true });
  // the server reads its data dir from the flag, from --data-dir or from HARNESS_CONFIG; the folder stays the same
  const args = [path.join(root, 'server', 'index.js'), flag, ...(flag === '--demo' ? [] : argv), '--data-dir', dataDir];
  const child = spawnProcess(node, args, { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', (e) => {
    exited = true;
    console.error(`Не удалось запустить ${node}: ${e.message}`);
  });
  const url = (async () => {
    for (const deadline = Date.now() + CONNECT_TIMEOUT_MS; Date.now() < deadline && !exited;) {
      try {
        const record = JSON.parse(readFileSync(serverJson, 'utf8'));
        if (record.pid === child.pid && (await isUp(record))) return record.url;
      } catch {}
      await wait();
    }
    return null;
  })();
  return { child, url };
}

/** Asks the server to stop the way Ctrl+C would, then makes sure the process is gone. */
export async function stopHarness(child, { graceMs = STOP_GRACE_MS } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise((resolve) => child.once('exit', resolve));
  // Windows has no signals inside Node: `process.kill(pid, 'SIGINT')` there ends the process outright, which the server
  // treats as an interrupted run — the same outcome, just without a graceful pass
  try {
    process.kill(child.pid, 'SIGINT');
  } catch {}
  const timeout = new Promise((r) => setTimeout(() => r('timeout'), graceMs));
  if ((await Promise.race([gone, timeout])) === 'timeout') {
    try {
      process.kill(child.pid);
    } catch {}
    await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
  }
}

/** The folder this window starts its server in: a running harness is joined, never disturbed. */
async function openUrl({ root, flag, argv, env, spawnProcess }) {
  const { loadConfig } = await import('../server/config.js');
  const config = loadConfig({ root, configFile: env.HARNESS_CONFIG });
  const running = await runningHarness(path.join(config.dataDir, 'server.json'));
  if (running) return { url: running, child: null };
  const port = await pickPort(config, { host: config.host });
  const own = desktopDataDir({ baseDir: config.dataDir, root, port, running });
  mkdirSync(own, { recursive: true });
  const harness = startHarness({ root, node: nodeCommand(env), flag, argv: [...argv, '--port', String(port)], dataDir: own, env, spawnProcess });
  return { url: await harness.url, child: harness.child };
}

const errorPage = (title, html) => `<!doctype html><meta charset="utf-8"><body style="font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;padding:2rem">
<h1 style="font-size:1.3rem">${escapeHtml(title)}</h1><p>${html}</p></body>`;

/** The window itself: the app's page, with links handed to the system browser. */
function showWindow(BrowserWindow, shell, url, { preload, platform = process.platform, icon } = {}) {
  // macOS draws the traffic lights itself and places the app's buttons next to them; elsewhere the page draws all three
  const mac = platform === 'darwin';
  const win = new BrowserWindow({
    show: true,
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'sber-harness',
    // the app's own icon instead of Electron's atom in the window and on the taskbar
    ...(icon ? { icon } : {}),
    // no Windows-look title bar: the app's own top bar is the title bar, and its buttons drive this window over IPC
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: mac ? { color: '#1a1a1a', symbolColor: '#e8e8e8', height: 36 } : false,
    trafficLightPosition: mac ? { x: 12, y: 11 } : undefined,
    // the page names itself «Harness» (unread badge and all); the shell's job is the frame, not the title
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, ...(preload ? { preload } : {}) },
  });
  const fail = (msg) => win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(msg)}`).catch(() => {});
  win.on('page-title-updated', (e) => e.preventDefault());
  const send = () => { try { win.webContents.send('desktop:maximized-changed', win.isMaximized()); } catch {} };
  win.on('maximize', send);
  win.on('unmaximize', send);
  // the window buttons live in the page: its preload asks for these over IPC, and the main process only touches this window
  const ipc = win.webContents.ipc; // Electron ≥ 31 scopes handlers to this window; older versions keep them in the module
  ipc.on('desktop:maximized', (event) => { event.returnValue = win.isMaximized(); });
  ipc.on('desktop:minimize', () => win.minimize());
  ipc.on('desktop:toggle-maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipc.on('desktop:close', () => win.close());
  // on Windows and Linux a title bar maximises on a double click; this one is the page's, so the page reports the clicks
  // and the shell answers here — a page that wants the click for itself just never sends it
  ipc.on('desktop:double-click', () => { if (win.isMaximizable()) win.isMaximized() ? win.unmaximize() : win.maximize(); });
  // inside the app a Ctrl/⌘+click must not open a second window with no frame of its own: the system browser gets the link
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (target === url || target.startsWith(`${url}/`)) return; // the app's own routes stay in the window
    e.preventDefault();
    if (/^https?:/i.test(target)) shell.openExternal(target).catch(() => {});
  });
  win.loadURL(url).catch((e) => fail(errorPage(`Не удалось открыть ${url}`, escapeHtml(e.message))));
  return win;
}

/**
 * The window. `electron` is injectable for tests; it defaults to the real module.
 * Closing the window quits the app; if this process started the server, the server stops with it.
 */
export async function serve({ root, flag = '--harness-desktop', argv = [], electron, env = process.env, spawnProcess = spawn }) {
  // from Electron's main process `import('electron')` may hand back the binary path instead of the API — take the API
  const api = electron || (await import('electron'));
  const { app, BrowserWindow, shell } = typeof api === 'string' || typeof api?.app !== 'object' ? (await import('electron')).default : api;
  app.setName('sber-harness');
  // a window's own copy of the profile: the second instance does not fight the first over the one Chromium locks, and the
  // renderer stays inspectable (a debugging port next to the window opens no server the harness would not have)
  const profile = env.HARNESS_ELECTRON_PROFILE || path.join(app.getPath('userData'), 'window');
  try { app.setPath('userData', profile); } catch {}
  if (env.HARNESS_ELECTRON_DEBUG) app.commandLine.appendSwitch('remote-debugging-port', String(env.HARNESS_ELECTRON_DEBUG));
  let harness = null;
  let stopping = false;
  app.on('window-all-closed', () => app.quit()); // no tray: a closed window means "done"
  app.on('before-quit', (e) => {
    if (!harness || stopping) return;
    e.preventDefault();
    stopping = true;
    stopHarness(harness).finally(() => app.quit());
  });

  await app.whenReady();
  const { url, child } = await openUrl({ root, flag, argv, env, spawnProcess });
  harness = child;
  const preload = path.resolve(root, 'scripts', 'desktop-preload.js');
  const icon = await appIcon(root);
  // macOS takes the Dock icon from the bundle, which is Electron's own here: the app's icon is set on the Dock instead
  if (icon && app.dock) try { app.dock.setIcon(icon); } catch {}
  if (!url) {
    showWindow(BrowserWindow, shell, `data:text/html;charset=utf-8,${encodeURIComponent(errorPage('Харнес не запустился', 'Причина — в журнале запуска <code>sber-harness-desktop.log</code> во временной папке (ярлык) или в терминале (<code>npm run desktop</code>).'))}`, { preload, icon });
    return app;
  }
  showWindow(BrowserWindow, shell, url, { preload, icon });
  // macOS: started by a script (the launcher app, a terminal), not by LaunchServices, the window would open behind the rest
  if (app.dock) app.focus({ steal: true });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) showWindow(BrowserWindow, shell, url, { preload, icon }); }); // macOS dock
  return app;
}

/**
 * The icon in `build/`. It ships with the repository; only a missing one is drawn (scripts/icon.js), never a present one
 * redrawn: file times after a clone say nothing about which is newer, and a redraw would dirty the working tree.
 */
async function appIcon(root) {
  const png = path.resolve(root, 'build', 'app-icon.png');
  try {
    if (!existsSync(png)) await (await import('./icon.js')).ensureIcons({ root });
    return existsSync(png) ? png : undefined;
  } catch {
    return undefined; // an icon is a nicety: never a reason not to open
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
