// The window's main process. Electron loads only a CommonJS entry here: an ES module as app path never lets the app
// become ready, even when nothing in it awaits. Started by scripts/desktop.js from a terminal.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

import(pathToFileURL(path.join(__dirname, 'desktop-app.js')).href)
  .then(({ serve }) => serve({
    root: path.resolve(__dirname, '..'),
    flag: '--harness-desktop',
    argv: process.argv.slice(1).filter((a) => a !== '--ui' && a !== '--harness-desktop'),
  }))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
