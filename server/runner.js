// Runs ONE agent turn: resolve the executable (never via a shell), spawn, read NDJSON from stdout with
// partial-line buffering, enforce the first-event timeout, kill the whole process tree on stop.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

const isWin = process.platform === 'win32';
const STDERR_TAIL = 4000;

function searchPath(name, env) {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  // On Windows an extensionless file in PATH is usually a bash shim; only PATHEXT candidates are runnable.
  const exts = isWin && !path.extname(name) ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext.toLowerCase());
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {}
    }
  }
  return null;
}

/** npm/pnpm .cmd shims end with `"%dp0%\node_modules\pkg\cli.js" %*`; run that entry with node instead. */
function unwrapShim(file) {
  const dir = path.dirname(file);
  const targets = [...fs.readFileSync(file, 'utf8').matchAll(/"([^"]*%~?dp0%?[^"]*)"/gi)]
    .map((m) => m[1].replace(/^.*?%~?dp0%?\\?/i, dir + path.sep))
    .map((p) => path.normalize(p));
  const js = targets.filter((t) => /\.[cm]?js$/i.test(t)).pop();
  if (js) return { file: process.execPath, args: [js] };
  const exe = targets.filter((t) => /\.exe$/i.test(t) && !/[\\/]node\.exe$/i.test(t)).pop();
  if (exe) return { file: exe, args: [] };
  throw new Error(`Cannot unwrap "${file}" to a node entry point. Set "command" in harness.config.json to an argv array, e.g. ["node", "C:/path/to/cli.js"].`);
}

/** @returns {{file: string, args: string[]}} */
export function resolveCommand(command, env = process.env) {
  if (Array.isArray(command)) {
    if (!command.length) throw new Error('"command" argv array is empty');
    return { file: command[0] === 'node' ? process.execPath : command[0], args: command.slice(1) };
  }
  if (typeof command !== 'string' || !command) throw new Error('"command" must be a string or an argv array');
  if (command === 'node') return { file: process.execPath, args: [] };
  const found = /[\\/]/.test(command) ? command : searchPath(command, env);
  if (!found || !fs.existsSync(found)) {
    throw new Error(`Command "${command}" not found in PATH. Set "command" in harness.config.json to an absolute path or an argv array, e.g. ["node", "C:/path/to/cli.js"].`);
  }
  if (!isWin) return { file: found, args: [] };
  const ext = path.extname(found).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file: found, args: [] };
  if (ext === '.cmd' || ext === '.bat') return unwrapShim(found);
  throw new Error(`Cannot run "${found}" without a shell. Set "command" in harness.config.json to an argv array, e.g. ["node", "C:/path/to/cli.js"].`);
}

export function killTree(pid) {
  if (!pid) return;
  if (isWin) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // the child leads its own process group (detached: true)
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

const shortArg = (a) => JSON.stringify(a.length > 200 ? `${a.slice(0, 200)}...` : a);

/**
 * @param {{ launcher, ctx, command, cwd, env, firstEventTimeoutMs: number, logFile: string, onEvent: (ev) => void }} o
 * @returns {{ pid: number|null, stop(): void, done: Promise<{code, signal, sawResult, timedOut, stopped, error, stderrTail}> }}
 */
export function runTurn({ launcher, ctx, command, cwd, env, firstEventTimeoutMs, logFile, onEvent }) {
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  const res = { code: null, signal: null, sawResult: false, timedOut: false, stopped: false, error: null, stderrTail: '' };
  let child;
  try {
    if (!fs.existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
    const { file, args: pre } = resolveCommand(command);
    const args = [...pre, ...launcher.buildArgs(ctx)];
    log.write(`\n=== ${new Date().toISOString()} ${shortArg(file)} ${args.map(shortArg).join(' ')}\n`);
    child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !isWin });
  } catch (e) {
    log.end(`[harness] ${e.message}\n`);
    return { pid: null, stop() {}, done: Promise.resolve({ ...res, error: e.message }) };
  }

  const state = {};
  let buf = '';
  const timer = setTimeout(() => {
    res.timedOut = true;
    killTree(child.pid);
  }, firstEventTimeoutMs);

  function handleLine(raw) {
    const line = raw.trim();
    if (!line) return;
    clearTimeout(timer);
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      log.write(`[stdout] ${line}\n`);
      return;
    }
    for (const ev of launcher.parse(obj, state)) {
      if (ev.type === 'meta') {
        log.write(`[meta] ${line.length > 2000 ? `${line.slice(0, 2000)}...` : line}\n`);
        continue;
      }
      if (ev.type === 'result') res.sawResult = true;
      try {
        onEvent(ev);
      } catch (e) {
        log.write(`[harness] event handler failed: ${e.stack}\n`);
      }
    }
  }

  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      handleLine(line);
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    log.write(chunk);
    res.stderrTail = (res.stderrTail + chunk).slice(-STDERR_TAIL);
  });

  const done = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handleLine(buf);
      buf = '';
      log.end(`=== exit code=${res.code} signal=${res.signal}${res.timedOut ? ' (first-event timeout)' : ''}${res.stopped ? ' (stopped)' : ''}\n`);
      resolve(res);
    };
    child.on('error', (e) => {
      res.error = e.code === 'ENOENT' ? `Cannot start agent: ${e.message}` : e.message;
      if (!child.pid) finish();
    });
    child.on('close', (code, signal) => {
      res.code = code;
      res.signal = signal;
      finish();
    });
  });

  return {
    pid: child.pid ?? null,
    stop() {
      res.stopped = true;
      killTree(child.pid);
    },
    done,
  };
}
