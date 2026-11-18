#!/usr/bin/env node
// The harness without a window: `npm run start:bg` starts it in the background (its output goes to
// <dataDir>/harness.log), `npm run stop` stops it, `node scripts/background.js status` says whether it runs.
// Running agent turns outlive a stop (they are picked up again on the next start).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CODE_ROOT, loadConfig } from '../server/config.js';

const [cmd = 'status', ...rest] = process.argv.slice(2);
const at = rest.indexOf('--data-dir'); // the same data dir the server is given (its server.json says it runs)
const dataDir = at >= 0 ? path.resolve(rest[at + 1]) : loadConfig().dataDir;
const serverJson = path.join(dataDir, 'server.json');
const logFile = path.join(dataDir, 'harness.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function running() {
  try {
    const s = JSON.parse(fs.readFileSync(serverJson, 'utf8'));
    return s?.pid && alive(s.pid) ? s : null;
  } catch { return null; }
}

if (cmd === 'start') {
  const now = running();
  if (now) { console.log(`Уже работает: ${now.url} (pid ${now.pid})`); process.exit(0); }
  fs.mkdirSync(dataDir, { recursive: true });
  const out = fs.openSync(logFile, 'a');
  // detached: it outlives this script (on Windows a non-detached child dies with its parent's job); windowsHide: no window.
  // Its own children (agents, git) are started hidden by the server, so nothing pops up from them either.
  const child = spawn(process.execPath, [path.join(CODE_ROOT, 'server', 'index.js'), ...rest], { cwd: CODE_ROOT, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const s = running();
    if (s) { console.log(`Harness работает в фоне: ${s.url}  (лог: ${logFile})`); process.exit(0); }
    if (!alive(child.pid)) break;
  }
  console.error(`Не запустился — смотрите лог: ${logFile}`);
  process.exit(1);
} else if (cmd === 'stop') {
  const s = running();
  if (!s) { console.log('Не запущен.'); process.exit(0); }
  process.kill(s.pid);
  for (let i = 0; i < 20 && alive(s.pid); i++) await sleep(250);
  console.log(alive(s.pid) ? `Не остановился (pid ${s.pid})` : 'Остановлен.');
} else {
  const s = running();
  console.log(s ? `Работает: ${s.url} (pid ${s.pid}), лог: ${logFile}` : 'Не запущен.');
}
