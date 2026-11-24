// The window's main process. Electron loads only a CommonJS entry here: an ES module as app path never lets the app
// become ready, even when nothing in it awaits. Started by scripts/desktop.js from a terminal.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

import(pathToFileURL(path.join(__dirname, 'desktop-app.js')).href)
  .then(({ serve }) => serve({
    root: path.resolve(__dirname, '..'),
    flag: '--harness-desktop',
    // argv[1] is this file (Electron's app path) and --no-sandbox is Chromium's: neither belongs to the server
    argv: process.argv.slice(2).filter((a) => a !== '--ui' && a !== '--harness-desktop' && a !== '--no-sandbox'),
  }))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
