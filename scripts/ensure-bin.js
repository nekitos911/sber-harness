// Put back what a half-finished `npm install` leaves behind: `node_modules/electron` without its package files (npm
// writes them into `node_modules/.electron-<hash>` first, and Windows may hold one of the old ones), and
// `node_modules/.bin` without its shims — `npm run build` then dies with «'vite' is not recognized» before it starts.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';

/** Every file under `dir`, as paths relative to it. */
export function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? walk(full).map((f) => join(e.name, f)) : [e.name];
  });
}

/**
 * Electron's binary is downloaded by its install script; a killed install leaves `dist/` and nothing else. The complete
 * package is still in npm's own staging folder, so copy the missing files from there — a file the system keeps busy
 * stays as it is (Electron only uses those as its fallback page).
 */
export function repairElectron(root) {
  const dir = join(root, 'node_modules', 'electron');
  if (!existsSync(dir)) return false;
  // the files whose absence means the package is unusable; a partly written install may hold some of them already
  const broken = ['package.json', 'index.js', 'cli.js'].filter((f) => !existsSync(join(dir, f)));
  if (!broken.length) return false;
  const spare = readdirSync(join(root, 'node_modules')).find((n) => n.startsWith('.electron-'));
  if (!spare) return false;
  const from = join(root, 'node_modules', spare);
  for (const file of walk(from)) {
    const to = join(dir, file);
    mkdirSync(dirname(to), { recursive: true });
    if (existsSync(to) && !broken.includes(file)) continue;
    try {
      copyFileSync(join(from, file), to);
    } catch {}
  }
  return broken.every((f) => existsSync(join(dir, f)));
}

const cmdShim = (target) => `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*
`;

const shShim = (target) => `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's#\\\\#/#g')")
exec node "$basedir/${target}" "$@"
`;

/**
 * Repairs whatever is broken and returns what it wrote (empty when nothing was). Shims are made only for packages that
 * are actually installed: without vite there is nothing to build with, and `npm install` is the honest answer.
 */
export function ensureBin(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const done = [];
  if (repairElectron(root)) done.push('electron');
  if (!existsSync(join(root, 'node_modules', 'vite', 'bin', 'vite.js'))) return done;
  const links = [
    ['vite', 'vite', 'bin/vite.js'],
    ['electron', 'electron', 'cli.js'],
    ['install-electron', 'electron', 'install.js'],
    ['tsc', 'typescript', 'bin/tsc'],
  ].filter(([, pkg, file]) => existsSync(join(root, 'node_modules', pkg, file)));
  const missing = links.filter(([name]) => !existsSync(join(root, 'node_modules', '.bin', WIN ? `${name}.cmd` : name)));
  if (!missing.length) return done;
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  for (const [name, pkg, file] of missing) {
    const target = relative(join(root, 'node_modules', '.bin'), join(root, 'node_modules', pkg, file));
    if (WIN) writeFileSync(join(root, 'node_modules', '.bin', `${name}.cmd`), cmdShim(target));
    // the POSIX shim always uses forward slashes: `relative` gives '\' on Windows, and /bin/sh must not see it
    writeFileSync(join(root, 'node_modules', '.bin', name), shShim(target.split(sep).join('/')), WIN ? undefined : { mode: 0o755 });
    if (!WIN) chmodSync(join(root, 'node_modules', '.bin', name), 0o755);
  }
  return [...done, ...missing.map(([name]) => name)];
}

// `npm run build` starts this file first; anything else imports the functions above
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const made = ensureBin();
  if (made.length && process.env.npm_lifecycle_event) console.log(`Восстановил в node_modules: ${made.join(', ')}`);
}
