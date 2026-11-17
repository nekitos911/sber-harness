// Shared test helpers (not a test file itself).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server/index.js';

export const tmpDir = (prefix = 'harness-test-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

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

/** Starts a server on a random port with a temp dataDir; `api(method, path, body, headers)` -> { status, body }. */
export async function startTestServer(configOverrides = {}) {
  const dataDir = tmpDir('harness-data-');
  const mockState = tmpDir('harness-mock-');
  process.env.MOCK_AGENT_STATE_DIR = mockState;
  const srv = await startServer({
    dataDir,
    port: 0,
    configOverrides: { defaultAgent: 'mock', worktreeRoot: null, ...configOverrides },
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
    async close() {
      await srv.close();
      rmrf(dataDir);
      rmrf(mockState);
    },
  };
}
