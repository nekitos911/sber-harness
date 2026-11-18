// Shared test helpers (not a test file itself). Temp dirs carry Cyrillic letters and spaces on purpose.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server/index.js';
import { CODE_ROOT, deepMerge } from '../server/config.js';

export const tmpDir = (prefix = 'харнесс тест ') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

export function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
}

export const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

/** git repo on branch `develop` with one commit (README.md). */
export function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  gitIn(dir, 'init', '-q', '-b', 'develop');
  gitIn(dir, 'config', 'user.name', 'Test');
  gitIn(dir, 'config', 'user.email', 'test@example.com');
  gitIn(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'line 1\nline 2\nline 3\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export async function waitFor(fn, { timeout = 15000, interval = 50, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Waits until a process is gone (a PTY shell can hold its cwd for a moment after kill on Windows). */
export async function waitPidGone(pid, timeout = 10000) {
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const end = Date.now() + timeout;
  while (pid && alive() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
}

/**
 * Starts a server on a random port with temp dataDir and a temp copy of harness.config.json (so PUT /api/settings
 * writes a temp harness.config.local.json). `api(method, path, body, headers)` -> { status, body }.
 */
export async function startTestServer(configOverrides = {}, serverOpts = {}) {
  const dataDir = tmpDir('харнесс данные ');
  const cfgDir = tmpDir('харнесс конфиг ');
  const configFile = path.join(cfgDir, 'harness.config.json');
  fs.copyFileSync(path.join(CODE_ROOT, 'harness.config.json'), configFile);
  const mockState = tmpDir('harness-mock-');
  process.env.MOCK_AGENT_STATE_DIR = mockState;
  const srv = await startServer({
    ...serverOpts,
    dataDir,
    configFile,
    port: 0,
    // mock model discovery is off unless a test turns it on (it would spawn a /models run per server)
    // git writes go straight through git in tests unless a test asks for via "agent"
    configOverrides: deepMerge({ defaultAgent: 'mock', worktreeRoot: null, mcpServersFrom: null, git: { via: 'harness' }, agents: { mock: { modelsDiscovery: null } } }, configOverrides),
  });
  async function api(method, p, body, headers = {}) {
    const res = await fetch(srv.url + p, {
      method,
      headers: { 'x-harness-token': srv.token, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return {
    srv,
    api,
    dataDir,
    configFile,
    async close() {
      // srv.close() leaves agent turns running (they survive restarts): stop them like a user would, so temp dirs can go
      for (let round = 0; round < 3; round++) {
        const sessions = (await api('GET', '/api/state').catch(() => null))?.body?.sessions || [];
        const running = sessions.filter((s) => s.kind === 'chat' && s.pid);
        if (!running.length) break;
        for (const s of running) await api('POST', `/api/sessions/${s.id}/stop`).catch(() => {});
        for (const s of running) await waitPidGone(s.pid, 5000);
        await new Promise((r) => setTimeout(r, 100));
      }
      await srv.close();
      rmrf(dataDir);
      rmrf(cfgDir);
      rmrf(mockState);
    },
  };
}
