#!/bin/sh
# Harness in its own window (Desktop shortcut on Linux and macOS). Needs Node.js >= 22; the first run installs and builds
# everything by itself, and nothing has to be installed by hand afterwards.
cd "$(dirname "$0")" || exit 1

command -v node >/dev/null 2>&1 || {
  echo "Не найден Node.js 22 или новее — без него харнес не запустить: https://nodejs.org" >&2
  exit 1
}

# a half-finished install (no node_modules/.bin, an Electron package without its files) is put right here
node scripts/ensure-bin.js
# and what is really absent is installed: `npm install` is cheap when almost everything is already in place
if [ ! -x "node_modules/.bin/vite" ] || ! node -e "require.resolve('electron')" >/dev/null 2>&1; then
  echo "Ставлю зависимости проекта…"
  npm install --no-audit --no-fund || exit 1
fi
if [ ! -f "web/dist/index.html" ]; then
  echo "Собираю интерфейс…"
  npm run build || exit 1
fi
exec node scripts/desktop.js --ui "$@"
