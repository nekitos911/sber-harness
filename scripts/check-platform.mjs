#!/usr/bin/env node
// Cross-platform guard: finds code that would only work on the machine it was written on. Prints one line per
// finding (file:line, what, why) and exits 1 when there is any. Run: node scripts/check-platform.mjs [--all] [--root DIR]
// --all also reports patterns that are fine inside an explicit `process.platform` branch; --root checks another tree
// (test/shipped-code.test.js runs this script on a fixture to prove the rules still fire).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const ROOT = path.resolve(arg('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'data', '.demo-smoke', 'coverage', 'worktrees']);
const EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);
const report = [];
const add = (file, line, what, why) => report.push({ file: path.relative(ROOT, file), line, what, why });

/** Every file that ships: server, web/src, scripts, mcp, test (fixtures read as data, not code). */
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name));
      continue;
    }
    if (EXT.has(path.extname(e.name)) && !e.name.endsWith('.min.js')) yield path.join(dir, e.name);
  }
}

/**
 * Rules. `platformAware: true` = the pattern is acceptable when it sits in a branch guarded by process.platform /
 * isWin / darwin — either a few lines above (an early return, a function guarded once) or on an enclosing `if` line
 * whose single-statement body has no braces; such a finding only shows with --all. Prose (a comment, a `rem` line, a
 * string that only mentions the name) is skipped before the rules run.
 */
const WIN_CMDS = /\b(?:taskkill|wmic|icacls)\b|reg(?:\.exe)?\s+add\b/g;
const RULES = [
  // a Windows path in a message or in example argv is a hint, not an assumption of the platform: no rule for it
  { re: /path\.join\(\s*process\.cwd\(\)\s*,\s*['"`][A-Za-z]:[\\/]/g, what: 'Windows path joined to the working directory', why: 'breaks on macOS/Linux: derive the path from config, os.tmpdir() or the project root' },
  { re: /(?<![\w.$'`-])(?:cmd\.exe|comspec|cmd\s*\/c)(?![\w-])/gi, what: 'cmd.exe invocation', why: 'no cmd on macOS/Linux: use resolveShell()/spawnOptions() from server/config.js and server/runner.js', platformAware: true },
  { re: /\bpowershell(?:\.exe)?\b/gi, what: 'PowerShell invocation', why: 'only exists on Windows: guard it with process.platform (and give a POSIX branch)', platformAware: true },
  { re: null, scan: WIN_CMDS, what: 'Windows-only command', why: 'use killTree()/processStartTime() from server/runner.js or add a POSIX branch', platformAware: true },
  { re: /\bpath\.sep\s*!==?\s*['"`]\/['"`]|\bpath\.sep\s*!==?\s*['"`]\\\\['"`]/g, what: 'path.sep comparison', why: 'compare with path.sep, never with a literal separator' },
  { re: /\.split\(\s*['"`]\\+['"`]\s*\)/g, what: 'split on a literal backslash', why: 'paths must be split with path.parse/path.sep, not a literal backslash', platformAware: true },
  { re: /process\.env\.(?:USERPROFILE|APPDATA|LOCALAPPDATA|ComSpec|SystemRoot)\b/g, what: 'Windows-only environment variable', why: 'use os.homedir() and a process.platform branch instead', platformAware: true },
  { re: /\bnpm\.cmd\b|\bnpx\.cmd\b/g, what: 'Windows executable suffix in code', why: 'resolve it by platform (launchers.js shim resolution, ensure-bin.js)', platformAware: true },
  { re: /\bcmd\s*\/[csd]\b/gi, what: 'cmd.exe invocation', why: 'no cmd on macOS/Linux: use resolveShell()/spawnOptions() from server/config.js and server/runner.js', platformAware: true },
];

const all = process.argv.includes('--all');
/** Tests and fixtures may spell out a Windows path on purpose (fixtures of real output); they are not shipped code. */
const isData = (file) => /[\\/]test[\\/]|\.test\.(?:ts|tsx|js|mjs)$/.test(path.relative(ROOT, file));
const NAME = /(?<![\w.$`])(?:powershell|taskkill|wmic|icacls|cmd\.exe|comspec)(?![\w-])/i;
const ARGS = /\b(?:spawn|exec)\w*\s*\(|-\w+['"`]|\/\w+['"`]/;
/**
 * Prose: a comment line, or a line that names the command but shows none of what tells a call from a mention — its
 * arguments (`['-NoProfile']`, `'/F'`), a quoted program, or an `if` about the name. A code line with arguments is
 * judged by the rules even when the name is also discussed in a comment above it.
 */
const isProse = (line) => /^\s*(?:\/\/|\*|\/\*|#(?!\s*!)|rem\b)/i.test(line) || (NAME.test(line) && !ARGS.test(line));
/** The character before the name, so that `a.taskkill` or `'taskkill'` is not a command: a quoted program is. */
const lead = (line, at) => line[at - 1] ?? ' ';
const BLOCKED_BEFORE = new Set(['.', '$', '@', '`', '-', '\\', '/']);
const isNameAt = (line, at) => at > 0 && !BLOCKED_BEFORE.has(lead(line, at)) && !/\w/.test(lead(line, at));
const GUARD = /process\.platform|[Pp]latform\s*(?:===?|!==?)|\bisWin\b|WIN32|'darwin'/;
/**
 * A branch selected once, by the caller: `const win = platform === 'win32' ? windowsShortcuts() : linuxLaunchers()`
 * or `switch (platform) { case 'win32': … }`. The function itself then reads as plain code, so the rule of the caller
 * counts instead of a `process.platform` check repeated inside every function.
 */
const SELECTED = /(?:platform|plat|os)\s*(?:===?|!==?)\s*['"`](?:win32|darwin|linux)['"`]|case\s+['"`](?:win32|darwin|linux)['"`]|['"`](?:win32|darwin|linux)['"`]\s*\?\s*[\w.]+\(/;
/** How far up the enclosing guard is looked for: usually a few lines above, a long signature may push it further. */
const GUARD_LINES = 20;
/** A guard has to be the nearest brace that encloses the line, not any mention of the platform above it. */
const platformAbove = (lines, i) => {
  for (let k = i; k >= Math.max(0, i - GUARD_LINES); k--) {
    if (GUARD.test(lines[k])) return true;
    if (k !== i && /^\s*\}\s*;?\s*$/.test(lines[k])) return false; // a closing brace ends the enclosing block
  }
  return false;
};
/**
 * The function that owns line i (`function name(` or `const name = (` above it) and whether a call site picks a
 * platform for that name: `? windowsShortcuts(` or `= linuxLaunchers(`. A declaration is not a call site, so a helper
 * nobody chooses between stays reported.
 */
function platformSelected(lines, i) {
  let name = null;
  for (let k = i; k >= 0; k--) {
    const decl = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/.exec(lines[k]);
    if (decl) { name = decl[1] ?? decl[2]; break; }
  }
  if (!name) return false;
  return lines.some((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line) && SELECTED.test(line) && new RegExp(`\\b${name}\\s*\\(`).test(line) && !new RegExp(`function\\s+${name}\\b|const\\s+${name}\\s*=`).test(line));
}
/**
 * `if (process.platform === 'win32') do();` on one line, or a `} else if (platform…) … {` header a line or two above:
 * the guarded body has no braces of its own.
 */
const platformInline = (lines, i) => {
  for (let k = i; k >= Math.max(0, i - 2); k--) {
    const opens = lines[k].match(/\{/g)?.length ?? 0;
    if (opens > 0 && k !== i && !GUARD.test(lines[k])) return false; // a braced block: the early-return rule applies
    if (GUARD.test(lines[k]) && /^\s*(?:\}\s*)?(?:if|else if)\b.*\)/.test(lines[k])) return true;
  }
  return false;
};

for (const dir of ['server', 'web/src', 'scripts', 'mcp', 'test']) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const text = fs.readFileSync(file, 'utf8');
    if (file.endsWith('check-platform.mjs')) continue;
    if (isData(file)) continue;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // a comment may name a platform on purpose
      const prose = isProse(line);
      for (const rule of RULES) {
        let hit;
        if (rule.scan) {
          rule.scan.lastIndex = 0;
          for (let m; (m = rule.scan.exec(line)); ) hit = isNameAt(line, m.index);
        } else {
          rule.re.lastIndex = 0;
          hit = rule.re.test(line);
        }
        if (!hit || prose) continue;
        const aware = rule.platformAware && (platformAbove(lines, i) || platformInline(lines, i) || platformSelected(lines, i));
        if (aware && !all) continue;
        add(file, i + 1, rule.what, rule.why);
      }
    });
  }
}

// launcher-independent checks: scripts that ship must be readable and, on POSIX, executable-looking
const shells = ['start-harness.sh', 'start-harness.cmd'];
for (const name of shells) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) add(file, 0, `${name} отсутствует`, 'the shortcut of one platform must not be dropped by a change for another');
  else if (!fs.readFileSync(file, 'utf8').includes('desktop.js')) add(file, 1, `${name} не запускает scripts/desktop.js`, 'both shortcuts must lead to the same entry point');
}
if (fs.existsSync(path.join(ROOT, 'start-harness.sh')) && process.platform !== 'win32') {
  const mode = fs.statSync(path.join(ROOT, 'start-harness.sh')).mode;
  if (!(mode & 0o100)) add(path.join(ROOT, 'start-harness.sh'), 0, 'start-harness.sh без бита исполнения', 'git stores the mode: chmod +x start-harness.sh');
}

if (report.length) {
  for (const r of report) console.log(`${r.file}:${r.line} — ${r.what}\n    ${r.why}`);
  console.log(`\nКроссплатформенность: ${report.length} находок(и)`);
  process.exit(1);
}
console.log('Кроссплатформенность: платформенных допущений не найдено');
