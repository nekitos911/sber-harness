// Shortcuts to this folder's launcher, with the app's own icon: a .lnk on Windows, a .desktop entry on Linux.
// Windows makes a .lnk through the shell's COM API, which is PowerShell's business here (one call, hidden — no console
// stays open). Linux reads .desktop files; one per user lives in ~/.local/share/applications, the desktop gets a copy.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, win32 } from 'node:path';

/** Where a user's shortcuts live: the desktop (when the shell knows it) and the Start menu. */
export function shortcutDirs(env = process.env) {
  const home = env.USERPROFILE || env.HOME || '';
  return {
    desktop: win32.join(env.OneDrive || home, 'Desktop'),
    startMenu: win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  };
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The PowerShell that writes one .lnk: a 256px icon from build/, no console styling of its own. */
export function shortcutScript({ target, workDir, icon, link, name }) {
  return [
    `$link = ${psQuote(link)}`,
    `$shell = New-Object -ComObject WScript.Shell`,
    `$shortcut = $shell.CreateShortcut($link)`,
    `$shortcut.TargetPath = ${psQuote(target)}`,
    `$shortcut.WorkingDirectory = ${psQuote(workDir)}`,
    `$shortcut.IconLocation = ${psQuote(icon + ',0')}`,
    `$shortcut.Description = ${psQuote(name)}`,
    `$shortcut.WindowStyle = 7`,
    `$shortcut.Save()`,
  ].join('\n');
}

/** Writes (or rewrites) the shortcuts; returns the files it made, an empty list on a platform without them. */
export function makeShortcuts({ root = resolve('.'), env = process.env, platform = process.platform } = {}) {
  return platform === 'win32' ? windowsShortcuts({ root, env }) : platform === 'linux' ? linuxLaunchers({ root, env }) : [];
}

function windowsShortcuts({ root, env }) {
  const target = win32.join(root, 'start-harness.cmd');
  const icon = win32.join(root, 'build', 'app-icon.ico');
  const dirs = shortcutDirs(env);
  const made = [];
  for (const [where, dir] of Object.entries(dirs)) {
    if (!dir) continue;
    const link = win32.join(dir, 'sber-harness.lnk');
    const script = shortcutScript({ target, workDir: win32.normalize(root), icon, link, name: 'sber-harness' });
    const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { stdio: 'ignore', windowsHide: true, timeout: 60000 });
    if (run.status === 0) made.push(link);
    else console.error(`Не удалось обновить ярлык ${where === 'desktop' ? 'на рабочем столе' : 'в меню «Пуск»'}: ${link}`);
  }
  return made;
}

/**
 * A .desktop entry: the shell's own launcher with the app's icon, no terminal window. Quotes keep paths with spaces
 * whole, `%` is the format's field code and becomes `%%`, and the entry is runnable — the desktop runs the other mode.
 */
export function desktopEntry({ exec, icon, workDir, name = 'sber-harness' }) {
  const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${name}`,
    'Comment=Локальная IDE для кодовых агентов',
    `Exec=${quote(exec).replace(/%/g, '%%')}`,
    `Path=${workDir}`,
    `Icon=${icon}`,
    'Terminal=false',
    'StartupNotify=true',
    'Categories=Development;IDE;',
    '',
  ].join('\n');
}

function linuxLaunchers({ root, env }) {
  const home = env.HOME || homedir();
  const applications = join(home, '.local', 'share', 'applications');
  const desktop = env.XDG_DESKTOP_DIR || join(home, 'Desktop');
  const entry = desktopEntry({ exec: join(root, 'start-harness.sh'), icon: join(root, 'build', 'app-icon.png'), workDir: root });
  const made = [];
  for (const dir of [applications, desktop]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, 'sber-harness.desktop');
    if (existsSync(file) && readFileSync(file, 'utf8') === entry) { made.push(file); continue; }
    writeFileSync(file, entry);
    // a launcher the desktop may run must be executable, and GNOME asks for its own trust flag before it starts one
    chmodSync(file, 0o755);
    if (dir === desktop) spawnSync('gio', ['set', file, 'metadata::trusted', 'true'], { stdio: 'ignore', timeout: 10000 });
    made.push(file);
  }
  return made;
}
