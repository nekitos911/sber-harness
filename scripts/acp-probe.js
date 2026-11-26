#!/usr/bin/env node
// Starts GigaCode in ACP mode the way the harness does and times each step: initialize, session/new, and (with --prompt)
// one turn. Diagnoses «ACP session/new: нет ответа за 120 с» without the harness in between.
//   node scripts/acp-probe.js [--cwd <dir>] [--settings <run settings.json>] [--prompt "<text>"] [--timeout <s>]
//   --settings   the file the harness wrote for a chat (data/runs/<id>/settings.json): passed as GIGACODE_SYSTEM_SETTINGS_PATH
//   --command    the CLI to run (default: gigacode from PATH, the bundled node + lib/cli-entry.js when it is a .cmd shim)
//   --grep <s>   instead of a run: print where <s> appears in the CLI's own lib/*.js (±400 characters), e.g. a method name
//   --flag <f>   the ACP switch to pass (default --acp; try --experimental-acp: 26.11 treats only --acp as «managed»)
//   --no-auth    do not answer session/requestCredentialsRefresh with `authenticate` (to see the hang as it is)
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
    // the shim's own identity: without it cli-entry.js refuses any launch but --acp («identities do not match»)
    const identity = /GIGACODE_PACKAGE_IDENTITY=["']?([0-9a-f]{64})/i.exec(fs.readFileSync(cmd, 'utf8'))?.[1];
    const shimEnv = identity ? { GIGACODE_PACKAGE_IDENTITY: identity, GIGACODE_PACKAGE_LAUNCHER: cmd } : {};
    if (fs.existsSync(node) && fs.existsSync(entry)) return [node, ['--max-old-space-size=6144', entry], shimEnv];
    return [cmd, []];
  }
  for (const d of dirs) if (fs.existsSync(path.join(d, 'gigacode.exe'))) return [path.join(d, 'gigacode.exe'), []];
  throw new Error('gigacode не найден в PATH — укажите --command <путь>');
}

/** Values that look like secrets (tokens, keys, long hex/base64) are cut, the shape stays. */
const mask = (v) => JSON.stringify(v, (k, x) => (typeof x === 'string' && (/token|secret|password|authorization|key/i.test(k) || /^[A-Za-z0-9_\-.=+/]{32,}$/.test(x)) ? `<${x.length} симв.>` : x));

const [cmd, pre, shimEnv = {}] = command();
const acpFlag = arg('--flag', '--acp');
const grep = arg('--grep');
if (grep) {
  const js = pre.find((x) => /\.[cm]?js$/.test(x));
  const root = js ? path.dirname(path.resolve(js)) : path.dirname(cmd);
  const files = [];
  const walk = (d, depth = 0) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 2 && e.name !== 'node_modules') walk(f, depth + 1);
      else if (e.isFile() && /\.(c|m)?js$/.test(e.name)) files.push(f);
    }
  };
  walk(root);
  let hits = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (let i = text.indexOf(grep); i >= 0 && hits < 12; i = text.indexOf(grep, i + grep.length)) {
      hits++;
      console.log(`\n=== ${path.relative(root, f)} @${i}\n${text.slice(Math.max(0, i - 400), i + 400 + grep.length)}`);
    }
  }
  console.log(`\n${hits ? `совпадений показано: ${hits}` : 'не найдено'} (искал в ${files.length} файлах под ${root})`);
  process.exit(0);
}

const env = { ...process.env, ...shimEnv, NO_BROWSER: 'true' };
if (settings) env.GIGACODE_SYSTEM_SETTINGS_PATH = path.resolve(settings);
log(`запуск: ${cmd} ${[...pre, acpFlag].join(' ')}`);
log(`cwd: ${cwd}${settings ? `; настройки запуска: ${env.GIGACODE_SYSTEM_SETTINGS_PATH}` : '; без настроек харнеса'}`);
const child = spawn(cmd, [...pre, acpFlag], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let buf = '';
let seq = 0;
let authMethods = [];
let authTried = false;
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
      log(`агент спрашивает: ${msg.method} ${mask(msg.params).slice(0, 1500)} — отвечаю «не поддерживается»`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'probe: not supported' } })}\n`);
    } else if (msg.method === 'session/update') {
      const u = msg.params?.update;
      if (u?.sessionUpdate === 'agent_message_chunk') process.stdout.write(u.content?.text ?? '');
      else log(`update: ${u?.sessionUpdate}`);
    } else if (msg.method) {
      log(`уведомление: ${msg.method} ${mask(msg.params).slice(0, 1500)}`);
      // GigaCode 26.11.141 asks for a credentials refresh after session/new and waits: the ACP way is `authenticate`
      if (msg.method === 'session/requestCredentialsRefresh' && !authTried && !process.argv.includes('--no-auth')) {
        authTried = true;
        const methodId = authMethods[0]?.id ?? 'gigacode';
        request('authenticate', { methodId }).then((r) => log(`authenticate → ${mask(r ?? null).slice(0, 1500)}`), (e) => log(`authenticate не удался: ${e.message}`));
      }
    }
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
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  log(`initialize → ${mask(init).slice(0, 3000)}`);
  authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];
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

