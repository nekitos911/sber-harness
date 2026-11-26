#!/usr/bin/env node
// Starts GigaCode in ACP mode the way the harness does and times each step: initialize, session/new, and (with --prompt)
// one turn. Diagnoses «ACP session/new: нет ответа за 120 с» without the harness in between.
//   node scripts/acp-probe.js [--cwd <dir>] [--settings <run settings.json>] [--prompt "<text>"] [--timeout <s>]
//   --settings   the file the harness wrote for a chat (data/runs/<id>/settings.json): passed as GIGACODE_SYSTEM_SETTINGS_PATH
//   --command    the CLI to run (default: gigacode from PATH, the bundled node + lib/cli-entry.js when it is a .cmd shim)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const cwd = path.resolve(arg('--cwd', process.cwd()));
const settings = arg('--settings');
const prompt = arg('--prompt');
const timeoutS = Number(arg('--timeout', 180));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} с`;
const log = (s) => console.log(`${at()}  ${s}`);

/** gigacode.cmd can't be spawned without a shell: run what it runs (bundled node + lib/cli-entry.js). */
function command() {
  const explicit = arg('--command');
  if (explicit) return /\.[cm]?js$/i.test(explicit) ? [process.execPath, [explicit]] : [explicit, []];
  if (process.platform !== 'win32') return ['gigacode', []];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const cmd = path.join(d, 'gigacode.cmd');
    if (!fs.existsSync(cmd)) continue;
    const root = path.dirname(d);
    const node = path.join(root, 'runtime', 'node', 'node.exe');
    const entry = path.join(root, 'lib', 'cli-entry.js');
    if (fs.existsSync(node) && fs.existsSync(entry)) return [node, ['--max-old-space-size=6144', entry]];
    return [cmd, []];
  }
  for (const d of dirs) if (fs.existsSync(path.join(d, 'gigacode.exe'))) return [path.join(d, 'gigacode.exe'), []];
  throw new Error('gigacode не найден в PATH — укажите --command <путь>');
}

const [cmd, pre] = command();
const env = { ...process.env, NO_BROWSER: 'true' };
if (settings) env.GIGACODE_SYSTEM_SETTINGS_PATH = path.resolve(settings);
log(`запуск: ${cmd} ${[...pre, '--acp'].join(' ')}`);
log(`cwd: ${cwd}${settings ? `; настройки запуска: ${env.GIGACODE_SYSTEM_SETTINGS_PATH}` : '; без настроек харнеса'}`);
const child = spawn(cmd, [...pre, '--acp'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let buf = '';
let seq = 0;
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log(`stdout: ${line.slice(0, 200)}`); continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    } else if (msg.method && msg.id !== undefined) {
      log(`агент спрашивает: ${msg.method} — отвечаю «не поддерживается»`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'probe: not supported' } })}\n`);
    } else if (msg.method === 'session/update') {
      const u = msg.params?.update;
      if (u?.sessionUpdate === 'agent_message_chunk') process.stdout.write(u.content?.text ?? '');
      else log(`update: ${u?.sessionUpdate}`);
    } else if (msg.method) log(`уведомление: ${msg.method}`);
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (s) => s.split(/\r?\n/).filter((l) => l.trim()).forEach((l) => log(`stderr: ${l.slice(0, 300)}`)));
child.on('exit', (code, signal) => { log(`процесс завершился: code=${code} signal=${signal}`); process.exit(code ?? 1); });

function request(method, params) {
  const id = ++seq;
  const started = Date.now();
  log(`→ ${method}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: нет ответа за ${timeoutS} с`)); }, timeoutS * 1000);
    pending.set(id, { resolve: (msg) => {
      clearTimeout(timer);
      log(`← ${method} за ${((Date.now() - started) / 1000).toFixed(1)} с${msg.error ? ` — ошибка: ${JSON.stringify(msg.error).slice(0, 300)}` : ''}`);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } });
  });
}

try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  const { sessionId } = await request('session/new', { cwd, mcpServers: [] });
  log(`сессия: ${sessionId}`);
  if (prompt) {
    await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
    console.log('');
  }
  log('готово');
} catch (e) {
  log(`СБОЙ: ${e.message}`);
  process.exitCode = 1;
} finally {
  child.kill();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
}

