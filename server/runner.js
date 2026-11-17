// Runs ONE agent turn: resolve the executable (never via a shell), spawn, read NDJSON from stdout with
// partial-line buffering (capped line length), enforce the first-event timeout, kill the whole process tree on stop.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

const isWin = process.platform === 'win32';
const STDERR_TAIL = 4000;
export const MAX_LINE = 8 * 1024 * 1024;

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

/** Absolute path of `command` (a path, or a name looked up in PATH/PATHEXT), or null. */
export function locate(command, env = process.env) {
  const found = /[\\/]/.test(command) ? command : searchPath(command, env);
  return found && fs.existsSync(found) ? path.resolve(found) : null;
}

/** Paths a .cmd shim references relative to its own folder (%~dp0 / %dp0%), in order of appearance. */
export function shimTargets(file, text = fs.readFileSync(file, 'utf8')) {
  const dir = path.dirname(file);
  return [...text.matchAll(/"([^"]*%~?dp0%?[^"]*)"/gi)]
    .map((m) => m[1].replace(/^.*?%~?dp0%?\\?/i, dir + path.sep))
    .map((p) => path.normalize(p));
}

export const shimJsEntry = (file, text) => shimTargets(file, text).filter((t) => /\.[cm]?js$/i.test(t)).pop() || null;

/** npm/pnpm .cmd shims end with `"%dp0%\node_modules\pkg\cli.js" %*`; run that entry with node instead. */
function unwrapShim(file) {
  const js = shimJsEntry(file);
  if (js) return { file: process.execPath, args: [js] };
  const exe = shimTargets(file).filter((t) => /\.exe$/i.test(t) && !/[\\/]node\.exe$/i.test(t)).pop();
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
  const found = locate(command, env);
  if (!found) {
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
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  // the child leads its own process group (detached: true): a polite SIGTERM first, SIGKILL after 3 s
  const signal = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try { process.kill(pid, sig); } catch {}
    }
  };
  signal('SIGTERM');
  setTimeout(() => { if (isAlive(pid)) signal('SIGKILL'); }, 3000).unref();
}

const shortArg = (a) => JSON.stringify(a.length > 200 ? `${a.slice(0, 200)}...` : a);
const TAIL_POLL_MS = 200;
// a login prompt of the CLI (first run on a machine): an URL on such a line, or an URL followed by a device code
const AUTH_RE = /auth|login|oauth|device|verif|sign.?in|авториз|войд|вход/i;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/;
const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/;
const ALIVE_POLL_MS = 1000;

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists, just not ours to signal
  }
}

// ---- process identity: a pid saved before a restart may belong to another process by now ----
const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: 10000, encoding: 'utf8' }, (e, out) => resolve(e ? '' : String(out).trim()));
});

/** Linux start time from /proc (boot time + start ticks): the same number every time for the same process. */
function procStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    const btime = Number(fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)/m)[1]);
    return Number.isFinite(ticks) ? btime * 1000 + ticks * 10 : null; // shortcut: USER_HZ assumed 100 (all mainstream Linux builds)
  } catch {
    return null;
  }
}

/** wmic CreationDate "20261117224144.123456+180" (local time, offset in minutes) -> ms since epoch. */
export function parseWmicDate(text) {
  const m = String(text).match(/(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\.(\d{3})\d*([+-]\d+)/);
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) - Number(m[8]) * 60000 : null;
}

const startCache = new Map(); // pid -> { at, value }: a PowerShell query costs about a second on Windows

/** Start time (ms since epoch) of a live process, or null when unknown. */
export async function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const hit = startCache.get(pid);
  if (hit && Date.now() - hit.at < 10000) return hit.value;
  let value = null;
  if (process.platform === 'linux') value = procStart(pid);
  else if (isWin) {
    const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }`]);
    value = Number(ps) || parseWmicDate(await run('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'])) || null;
  } else {
    value = Date.parse(await run('ps', ['-o', 'lstart=', '-p', String(pid)])) || null;
  }
  startCache.set(pid, { at: Date.now(), value });
  return value;
}

/** Stamp recorded at spawn, comparable with processStartTime (Linux reads /proc so both sides use the same clock). */
export const startStamp = (pid) => (process.platform === 'linux' && procStart(pid)) || Date.now();

/** True only when `pid` is alive AND started at `startedAt` (±2 s): a reused pid is never adopted or killed. */
export async function sameProcess(pid, startedAt) {
  if (!pid || !startedAt || !isAlive(pid)) return false;
  const t = await processStartTime(pid);
  return t != null && Math.abs(t - startedAt) <= 2000;
}

/** Last `bytes` of a file as text ('' when missing). */
export function readTail(file, bytes = STDERR_TAIL) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Follows a growing NDJSON file from byte `offset`: complete lines go to onLine, `offset` always points at the first
 * byte not consumed yet (the start of a partial line), so a later re-attach resumes exactly there. Lines longer than
 * maxLine are cut with a marker and the rest of that line is skipped.
 */
function tailFile(file, offset, maxLine, onLine, onOffset) {
  let pending = Buffer.alloc(0);
  let skipping = false;
  let watcher = null;
  let poll = null;

  function consume(chunk) {
    let data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let i;
    while ((i = data.indexOf(10)) >= 0) {
      const line = data.subarray(0, i);
      data = data.subarray(i + 1);
      offset += line.length + 1;
      if (skipping) skipping = false;
      else onLine(line.length > maxLine ? `${line.subarray(0, maxLine).toString('utf8')} [line truncated by harness]` : line.toString('utf8'));
    }
    if (!skipping && data.length > maxLine) {
      onLine(`${data.subarray(0, maxLine).toString('utf8')} [line truncated by harness]`);
      skipping = true;
    }
    if (skipping) {
      offset += data.length;
      data = Buffer.alloc(0);
    }
    pending = Buffer.from(data);
  }

  function read() {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return;
    }
    try {
      const size = fs.fstatSync(fd).size;
      let pos = offset + pending.length;
      const before = offset;
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(size - pos, 1 << 20));
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        pos += n;
        consume(buf.subarray(0, n));
      }
      if (offset !== before) onOffset?.(offset);
    } finally {
      fs.closeSync(fd);
    }
  }

  try {
    watcher = fs.watch(file, () => read());
    watcher.on('error', () => {});
  } catch {} // the poll below is enough
  poll = setInterval(read, TAIL_POLL_MS);
  read();
  return {
    read,
    /** reads to the end; a final line without a newline is consumed too */
    drain() {
      read();
      if (pending.length && !skipping) {
        const last = pending.toString('utf8');
        offset += pending.length;
        pending = Buffer.alloc(0);
        onLine(last);
        onOffset?.(offset);
      }
    },
    close() {
      clearInterval(poll);
      try { watcher?.close(); } catch {}
    },
  };
}

/**
 * Runs (or re-attaches to) ONE agent turn. The agent is spawned detached with stdout/stderr redirected to files
 * (outFile / errFile), so it keeps running when the harness stops; the harness follows outFile.
 * @param {{ launcher, ctx, command, cwd, env, firstEventTimeoutMs, authTimeoutMs?, logFile, outFile, errFile, onEvent,
 *           onOffset?, maxLine?, reattach?: { pid, offset, startedAt } }} o
 *   Events are the launcher's NormalizedEvents plus { type: 'raw', text } for each non-JSON stdout line and
 *   { type: 'auth', url, code } when, before the first JSON event, stdout or stderr shows a login link: the
 *   first-event timeout is then replaced by authTimeoutMs (the CLI waits for the browser login and continues).
 *   reattach: follow an already running turn (not our child): it ends at its `result` event or when the pid is gone;
 *   the exit code is then unknown (null); stop() kills it only after re-checking its identity (sameProcess).
 *   pid null = not adopted (unknown or reused pid): only the output already in the file is read.
 * @returns {{ pid, startedAt, stop(), detach(), done: Promise<{code, signal, sawResult, timedOut, stopped, detached, error, stderrTail, eventCount}> }}
 */
export function runTurn({ launcher, ctx, command, cwd, env, firstEventTimeoutMs, authTimeoutMs = 600000, logFile, outFile, errFile, onEvent, onOffset, maxLine = MAX_LINE, reattach = null }) {
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  const res = { code: null, signal: null, sawResult: false, timedOut: false, stopped: false, detached: false, error: null, stderrTail: '', eventCount: 0, priorOutput: (reattach?.offset ?? 0) > 0 };
  let child = null;
  let pid = reattach?.pid ?? null;
  let startedAt = reattach?.startedAt ?? null;
  if (!reattach) {
    try {
      if (!fs.existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
      const { file, args: pre } = command?.file ? command : resolveCommand(command);
      const args = [...pre, ...launcher.buildArgs(ctx)];
      log.write(`\n=== ${new Date().toISOString()} ${shortArg(file)} ${args.map(shortArg).join(' ')}\n`);
      const out = fs.openSync(outFile, 'w');
      const err = fs.openSync(errFile, 'w');
      try {
        // files instead of pipes + detached: the turn outlives a harness restart
        child = spawn(file, args, { cwd, env, stdio: ['ignore', out, err], windowsHide: true, detached: true });
      } finally {
        fs.closeSync(out);
        fs.closeSync(err);
      }
      child.unref();
      pid = child.pid ?? null;
      startedAt = pid ? startStamp(pid) : null;
    } catch (e) {
      log.end(`[harness] ${e.message}\n`);
      return { pid: null, startedAt: null, stop() {}, detach() {}, done: Promise.resolve({ ...res, error: e.message }) };
    }
  } else {
    log.write(`\n=== ${new Date().toISOString()} re-attached to pid ${pid} at offset ${reattach.offset}\n`);
  }

  const state = {};
  let settled = false;
  let finish = () => {};
  const timer = reattach ? null : setTimeout(() => {
    res.timedOut = true;
    killTree(pid);
  }, firstEventTimeoutMs);
  let sawJson = res.priorOutput;
  let authTimer = null;
  let pendingUrl = null;

  function scanAuth(line) {
    if (sawJson || res.auth) return;
    const url = line.match(URL_RE)?.[0];
    let code = null;
    if (url && AUTH_RE.test(line)) code = line.match(CODE_RE)?.[0] ?? null;
    else if (url) return void (pendingUrl = url);
    else if (pendingUrl && CODE_RE.test(line)) code = line.match(CODE_RE)[0];
    else return void (pendingUrl = null);
    res.auth = true;
    clearTimeout(timer);
    if (!reattach) {
      authTimer = setTimeout(() => {
        res.timedOut = true;
        res.authTimedOut = true;
        killTree(pid);
      }, authTimeoutMs);
    }
    log.write(`[harness] login requested: ${url || pendingUrl}\n`);
    try {
      onEvent({ type: 'auth', url: url || pendingUrl, code }); // not counted as output: a login prompt alone is no answer
    } catch {}
  }

  const emit = (ev) => {
    res.eventCount++;
    try {
      onEvent(ev);
    } catch (e) {
      log.write(`[harness] event handler failed: ${e.stack}\n`);
    }
  };

  function handleLine(raw) {
    const line = raw.trim();
    if (!line) return;
    clearTimeout(timer);
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      log.write(`[stdout] ${line.slice(0, 2000)}\n`);
      emit({ type: 'raw', text: line.length > 20000 ? `${line.slice(0, 20000)}...` : line });
      scanAuth(line);
      return;
    }
    if (!sawJson) {
      sawJson = true;
      clearTimeout(authTimer); // logged in: the CLI started for real
    }
    for (const ev of launcher.parse(obj, state)) {
      if (ev.type === 'meta') {
        log.write(`[meta] ${line.length > 2000 ? `${line.slice(0, 2000)}...` : line}\n`);
        continue;
      }
      if (ev.type === 'result') res.sawResult = true;
      emit(ev);
    }
    // a re-attached process is not our child: its result line ends the turn
    if (reattach && res.sawResult) setImmediate(() => finish());
  }

  const tail = tailFile(outFile, reattach?.offset ?? 0, maxLine, handleLine, onOffset);
  // stderr is only watched for a login prompt; its tail goes into messages when the turn ends
  const errTail = tailFile(errFile, 0, maxLine, (line) => { if (line.trim()) scanAuth(line.trim()); });
  let alive = null;

  const done = new Promise((resolve) => {
    finish = (detached = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(alive);
      if (!detached) tail.drain();
      tail.close();
      errTail.close();
      clearTimeout(authTimer);
      res.detached = detached;
      res.stderrTail = readTail(errFile);
      if (res.stderrTail) log.write(`[stderr]\n${res.stderrTail}\n`);
      log.end(`=== ${detached ? 'detached (the turn keeps running)' : `exit code=${res.code} signal=${res.signal}`}${res.timedOut ? ' (first-event timeout)' : ''}${res.stopped ? ' (stopped)' : ''}\n`);
      resolve(res);
    };
    if (child) {
      child.on('error', (e) => {
        res.error = e.code === 'ENOENT' ? `Cannot start agent: ${e.message}` : e.message;
        if (!child.pid) finish();
      });
      child.on('exit', (code, signal) => {
        res.code = code;
        res.signal = signal;
        finish();
      });
    } else {
      alive = setInterval(() => { if (!isAlive(pid)) finish(); }, ALIVE_POLL_MS);
      if (!isAlive(pid)) setImmediate(() => finish());
    }
  });

  return {
    pid,
    startedAt,
    stop() {
      res.stopped = true;
      if (!reattach) return killTree(pid);
      // not our child: kill only if the pid still is that process; otherwise just stop following
      sameProcess(pid, startedAt).then((ours) => (ours ? killTree(pid) : finish()));
    },
    /** stop following without touching the process (harness shutdown) */
    detach() {
      finish(true);
    },
    done,
  };
}
