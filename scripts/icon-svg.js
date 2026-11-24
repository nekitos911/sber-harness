// The app's own icon, drawn once: the mark from Favicon/BrandMark on the console's dark tile. Rasterised by the
// renderer (Electron only) and written as build/app-icon.png — the ico for Windows is packed from it by build/icons.mjs.
const SVG = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="${size}" height="${size}">
  <rect width="256" height="256" rx="56" fill="#16171b"/>
  <g transform="translate(48 48) scale(10)" fill="none" stroke="#8b9dff" stroke-width="1.6" stroke-linecap="round">
    <path d="M4.5 2.5v11M4.5 8c0-2.4 7-2 7-5.5M11.5 13.5V9.5"/>
    <circle cx="11.5" cy="8" r="1.4" fill="#8b9dff" stroke="none"/>
  </g>
</svg>`;

/** Raw RGBA of the icon at `size`, straight from a hidden renderer window. */
export async function iconPixels(BrowserWindow, size = 256) {
  const win = new BrowserWindow({
    show: false,
    width: size,
    height: size,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await win.loadURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG(size))}`);
    await new Promise((r) => setTimeout(r, 300));
    const image = await win.webContents.capturePage();
    const { width, height } = image.getSize();
    return { width, height, data: image.toBitmap() };
  } finally {
    win.destroy();
  }
}

export { SVG };
