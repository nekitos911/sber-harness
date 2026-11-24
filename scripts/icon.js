// The app's icons, made from the app itself: a hidden Electron window rasterises the mark (scripts/icon-svg.js) into
// build/app-icon.png, and build/icons.mjs packs the ico Windows wants. Runs when the icons are absent and never fails
// the start: a missing icon means the default one, not a broken launch.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronBinary, isElectron, sandboxSwitches } from './desktop.js';

export const ICON_PNG = join('build', 'app-icon.png');
export const ICON_ICO = join('build', 'app-icon.ico');

/** Writes both icons unless they are already newer than the drawing; returns what it made. */
export async function ensureIcons({ root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), platform = process.platform, electron } = {}) {
  const png = join(root, ICON_PNG);
  const ico = join(root, ICON_ICO);
  const svg = join(root, 'scripts', 'icon-svg.js');
  const fresh = (file) => existsSync(file) && statSync(file).mtimeMs >= statSync(svg).mtimeMs;
  const made = [];
  mkdirSync(join(root, 'build'), { recursive: true });
  if (!fresh(png)) {
    // Electron's binary can draw the SVG without a display: offscreen capture, no window on screen
    const { SVG } = await import('./icon-svg.js');
    // the binary per platform (electron.exe, electron, Electron.app/…/Electron); inside the window it is this very process
    const out = await drawWithElectron(electron || (isElectron() ? process.execPath : electronBinary(root, undefined, false)), SVG(256));
    if (!out) return made; // nothing to pack either: the next start tries again
    writeFileSync(png, out);
    made.push(ICON_PNG);
  }
  if (platform === 'win32' && !fresh(ico)) {
    // inside the window process.execPath is Electron, which would load icons.mjs as an app that never quits and block
    // the window for good: as plain Node it runs the script and exits
    execFileSync(process.execPath, [join(root, 'scripts', 'build', 'icons.mjs'), png, ico], { stdio: 'ignore', timeout: 60000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    made.push(ICON_ICO);
  }
  return made;
}

/** Rasterises the SVG in a throwaway Electron process that writes the PNG next to its own script. */
function drawWithElectron(electronPath, svg) {
  if (!existsSync(electronPath)) return null;
  const dir = join(tmpdir(), 'harness-icon');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'draw.cjs');
  const out = join(dir, 'icon.png');
  rmSync(out, { force: true }); // a file left by an earlier run must not pass for this one
  const script = `
    const { app, BrowserWindow } = require('electron');
    const fs = require('node:fs');
    const svg = ${JSON.stringify(svg)};
    app.disableHardwareAcceleration();
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false, width: 256, height: 256, frame: false, transparent: true,
        webPreferences: { offscreen: true, sandbox: true } });
      await win.loadURL('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        // a file, not stdout: a console in another code page would corrupt the bytes on the way
        fs.writeFileSync(${JSON.stringify(out)}, image.toPNG());
        app.exit(0);
      }, 400);
    });`;
  writeFileSync(file, script);
  try {
    execFileSync(electronPath, [file, ...sandboxSwitches(electronPath)], { stdio: 'ignore', timeout: 60000, windowsHide: true });
    return existsSync(out) ? readFileSync(out) : null;
  } catch {
    return null;
  }
}

// `node scripts/icon.js` rebuilds them by hand (also on macOS/Linux, where no ico is needed)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const made = await ensureIcons();
  console.log(made.length ? `Сделал иконки: ${made.join(', ')}` : 'Иконки уже на месте.');
}
