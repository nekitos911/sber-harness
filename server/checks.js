// «Проверка перед готово»: the project's own command (tests, lint, types) that the harness runs itself in the agent's
// worktree after the agent reports — a deterministic sensor, not the model's word for it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killTree } from './runner.js';

const OUTPUT_MAX = 20000; // the tail is what tells why it failed

/** Runs `command` in `cwd` → { ok, code, output (tail), ms, timedOut }; never throws. */
export function runCheck({ cwd, command, timeoutMs = 15 * 60000 }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const win = process.platform === 'win32';
    // the person's own command line (&&, pipes, npm scripts): through the system shell on purpose, like a terminal
    const p = spawn(win ? process.env.ComSpec || 'cmd.exe' : '/bin/sh', win ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command], {
      cwd, windowsHide: true, windowsVerbatimArguments: win, env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });
    let output = '';
    const keep = (d) => { output = (output + d).slice(-OUTPUT_MAX); };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(p.pid); }, timeoutMs);
    timer.unref?.();
    const done = (code) => { clearTimeout(timer); resolve({ ok: code === 0 && !timedOut, code, output, ms: Date.now() - t0, timedOut }); };
    p.on('error', (e) => { output += e.message; done(null); });
    p.on('close', done);
  });
}

/** What a repository's own files suggest as its check — only offered in the settings, never run unasked. */
export function suggestCheck(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const win = process.platform === 'win32';
  if (has('package.json')) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {};
      const parts = ['test', 'lint', 'typecheck'].filter((k) => s[k] && !/no test specified/.test(s[k])).map((k) => (k === 'test' ? 'npm test' : `npm run ${k}`));
      if (parts.length) return parts.join(' && ');
    } catch { /* not JSON: no suggestion */ }
  }
  if (has('mvnw') || has('mvnw.cmd')) return win ? 'mvnw.cmd -q test' : './mvnw -q test';
  if (has('pom.xml')) return 'mvn -q test';
  if (has('gradlew') || has('gradlew.bat')) return win ? 'gradlew.bat test' : './gradlew test';
  if (has('build.gradle') || has('build.gradle.kts')) return 'gradle test';
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test';
  if (has('pyproject.toml') || has('pytest.ini')) return 'pytest -q';
  return null;
}
