// The repository itself must pass the cross-platform check (scripts/check-platform.mjs), and the check must still
// catch the assumptions it exists for — a lint nobody tests rots silently into "no findings".
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-platform.mjs');
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });

const trees = [];
after(() => {
  for (const dir of trees) rmSync(dir, { recursive: true, force: true });
});

/** A tree with the two launchers (so the ship check stays quiet) and the given files. */
function fixture(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cp-check-'));
  trees.push(dir);
  for (const name of ['start-harness.sh', 'start-harness.cmd']) {
    writeFileSync(path.join(dir, name), '#!/bin/sh\nnode scripts/desktop.js\n');
  }
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('the repository ships without platform assumptions', () => {
  const run0 = run();
  assert.equal(run0.status, 0, run0.stdout + run0.stderr);
});

test('an unguarded Windows-only command is reported, a guarded one is not', () => {
  const dir = fixture({
    'server/call.js': "export function spawnBad() {\n  return spawn('taskkill', ['/PID', '1', '/T', '/F']);\n}\n",
    'server/guarded.js': "export function spawnGood() {\n  if (process.platform !== 'win32') return;\n  return spawn('taskkill', ['/PID', '1', '/T', '/F']);\n}\n",
    'server/paths.js': "export const parts = (p) => p.split('\\\\');\n",
  });
  // --all drops the "a platform branch made it acceptable" exception, so both forms show up and are compared as text
  const result = run('--root', dir, '--all');
  assert.match(result.stdout, /server[\\/]call\.js:2 — Windows-only command/);
  assert.match(result.stdout, /server[\\/]paths\.js:1 — split on a literal backslash/);
  const flagged = result.stdout.split('\n').filter((line) => line.includes(' — '));
  assert.equal(flagged.filter((line) => /^server[\\/]guarded\.js/.test(line)).length, 1, result.stdout);
});

test('a function whose caller picks the platform counts as guarded', () => {
  const dir = fixture({
    'scripts/shortcut.js': [
      "import { spawnSync } from 'node:child_process';",
      'export function makeShortcuts({ platform = process.platform } = {}) {',
      "  return platform === 'win32' ? windowsShortcuts() : [];",
      '}',
      'function windowsShortcuts() {',
      "  return spawnSync('powershell', ['-NoProfile', '-Command', 'x'], { stdio: 'ignore' });",
      '}',
      'function helpers() {',
      "  return spawnSync('powershell', ['-NoProfile', '-Command', 'y'], { stdio: 'ignore' });",
      '}',
      '',
    ].join('\n'),
  });
  const result = run('--root', dir);
  assert.equal(result.status, 1, result.stdout);
  assert.doesNotMatch(result.stdout, /shortcut\.js:6/);
  assert.match(result.stdout, /shortcut\.js:9 — PowerShell invocation/);
});

test('a launcher of one platform may not disappear', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cp-check-'));
  trees.push(dir);
  mkdirSync(path.join(dir, 'server'));
  writeFileSync(path.join(dir, 'start-harness.cmd'), 'node scripts/desktop.js\r\n');
  const result = run('--root', dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /start-harness\.sh отсутствует/);
});
