#!/bin/sh
# Harness in its own window (Linux and macOS: a terminal, or the menu entry / app that `npm run shortcut` makes).
# Needs Node.js >= 22; the first run installs and builds everything by itself, nothing has to be installed by hand.
cd "$(dirname "$0")" || exit 1

# no terminal (a desktop entry, Finder): what would be printed goes to a log instead of nowhere
LOG="${TMPDIR:-/tmp}/sber-harness-desktop.log"
[ -t 1 ] || [ -t 2 ] || exec >"$LOG" 2>&1

fail() {
  echo "$1" >&2
  # without a terminal nobody reads stderr: say it where the user looks
  if ! [ -t 2 ]; then
    if command -v osascript >/dev/null 2>&1; then
      osascript -e "display alert \"sber-harness\" message \"$1 Журнал: $LOG\"" >/dev/null 2>&1
    elif command -v notify-send >/dev/null 2>&1; then
      notify-send "sber-harness" "$1 Журнал: $LOG"
    fi
  fi
  exit 1
}

node_ok() { node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' >/dev/null 2>&1; }
if ! node_ok; then
  # a desktop entry or Finder starts with a bare PATH: try the login shell's PATH, then where Homebrew, Volta, asdf,
  # fnm and nvm keep node (nvm is loaded by an interactive shell only, so its folders are named here)
  base=$PATH
  login=$("${SHELL:-/bin/sh}" -lc 'printf %s "$PATH"' </dev/null 2>/dev/null)
  for dir in "$login" /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.asdf/shims" \
    "$HOME/.local/share/fnm/aliases/default/bin" "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin; do
    [ -n "$dir" ] || continue
    PATH="$dir:$base"
    node_ok && break
    PATH=$base
  done
  export PATH
  node_ok || fail "Не найден Node.js 22 или новее — без него харнес не запустить: https://nodejs.org"
fi

# a half-finished install (no node_modules/.bin, an Electron package without its files) is put right here
node scripts/ensure-bin.js
# and what is really absent is installed: `npm install` is cheap when almost everything is already in place
if [ ! -x "node_modules/.bin/vite" ] || ! node -e "require('electron')" >/dev/null 2>&1; then
  echo "Ставлю зависимости проекта…"
  npm install --no-audit --no-fund || fail "Не удалось установить зависимости (npm install)."
  # npm keeps an installed package as it is: an Electron binary an earlier download lost is fetched here
  node -e "require('electron')" >/dev/null 2>&1 || node node_modules/electron/install.js || fail "Не удалось скачать Electron."
fi
if [ ! -f "web/dist/index.html" ]; then
  echo "Собираю интерфейс…"
  npm run build || fail "Не удалось собрать интерфейс (npm run build)."
fi
exec node scripts/desktop.js --ui "$@"
