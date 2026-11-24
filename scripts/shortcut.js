// Shortcuts to this folder's launcher, with the app's own icon: a .lnk on Windows, a .desktop entry on Linux, a small
// app bundle on macOS. `npm run shortcut` (= `node scripts/shortcut.js`) makes or refreshes them.
// Windows makes a .lnk through the shell's COM API, which is PowerShell's business here (one call, hidden — no console
// stays open). Linux reads .desktop files; one per user lives in ~/.local/share/applications, the desktop gets a copy.
// macOS starts apps, not scripts: ~/Applications/sber-harness.app runs start-harness.sh (Launchpad, Spotlight, Dock).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

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
export function makeShortcuts({ root = resolve('.'), env = process.env, platform = process.platform, run = spawnSync } = {}) {
  if (platform === 'win32') return windowsShortcuts({ root, env });
  if (platform === 'darwin') return macBundles({ root, env, run });
  return platform === 'linux' ? linuxLaunchers({ root, env }) : [];
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
  // the quoting rule escapes \ " ` $ inside the quotes; the string rule, applied before it, then doubles each backslash
  const quote = (s) => `"${String(s).replace(/[\\"`$]/g, '\\$&')}"`.replace(/\\/g, '\\\\');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${name}`,
    'Comment=Локальная IDE для кодовых агентов',
    // through /bin/sh: a copy that lost its run bit (an archive, a Windows share) still starts
    `Exec=/bin/sh ${quote(exec).replace(/%/g, '%%')}`,
    `Path=${workDir}`,
    `Icon=${icon}`,
    'Terminal=false',
    'StartupNotify=true',
    // the window's class (Electron takes it from the app name): the dock groups the window under this entry's icon
    `StartupWMClass=${name}`,
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

const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const xml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** Info.plist of the launcher bundle. LSUIElement: the bundle shows no Dock icon of its own, the window's is the one. */
export function infoPlist(name = 'sber-harness') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${xml(name)}</string>
  <key>CFBundleDisplayName</key><string>${xml(name)}</string>
  <key>CFBundleIdentifier</key><string>local.${xml(name)}.launcher</string>
  <key>CFBundleExecutable</key><string>${xml(name)}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>app-icon</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;
}

/** The bundle's executable: the repository's own launcher, through /bin/sh so that its run bit does not matter. */
export const bundleScript = (launcher) => `#!/bin/sh\nexec /bin/sh ${shQuote(launcher)}\n`;

function macBundles({ root, env, run }) {
  const home = env.HOME || homedir();
  const name = 'sber-harness';
  const made = [];
  for (const dir of [join(home, 'Applications'), join(home, 'Desktop')]) {
    const contents = join(dir, `${name}.app`, 'Contents');
    mkdirSync(join(contents, 'MacOS'), { recursive: true });
    mkdirSync(join(contents, 'Resources'), { recursive: true });
    const exe = join(contents, 'MacOS', name);
    writeFileSync(exe, bundleScript(join(root, 'start-harness.sh')));
    chmodSync(exe, 0o755);
    writeFileSync(join(contents, 'Info.plist'), infoPlist(name));
    // the icon is a nicety: without sips (or with a failed one) Finder shows the generic app icon
    run('sips', ['-s', 'format', 'icns', join(root, 'build', 'app-icon.png'), '--out', join(contents, 'Resources', 'app-icon.icns')], { stdio: 'ignore', timeout: 30000 });
    made.push(join(dir, `${name}.app`));
  }
  return made;
}

// `npm run shortcut`: the shortcuts for this checkout, wherever it was started from
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const made = makeShortcuts({ root: resolve(dirname(fileURLToPath(import.meta.url)), '..') });
  console.log(made.length ? `Ярлыки:\n${made.join('\n')}` : 'На этой системе ярлыки не создаются: запускайте start-harness.');
}
