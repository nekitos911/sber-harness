#!/bin/sh
# Rebuild node_modules/.bin from the installed packages. `npm install` creates that folder, but it goes missing in
# practice (a copy that skipped dot-paths, an interrupted install) and then every `npm run` cannot find its tool.
# Each file made here is npm's own shim shape: it hands the package's script to node.
cd "$(dirname "$0")/.." || exit 1

[ -f "node_modules/vite/bin/vite.js" ] || exit 0
[ -x "node_modules/.bin/vite" ] && exit 0

echo "Восстанавливаю node_modules/.bin…"
mkdir -p node_modules/.bin

link() {
  [ -f "node_modules/$2/$3" ] || return 0
  printf '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e "s#\\\\#/#g")")\nexec node "$basedir/%s" "$@"\n' "../$2/$3" > "node_modules/.bin/$1"
  chmod +x "node_modules/.bin/$1"
}

link vite vite bin/vite.js
link electron electron cli.js
link install-electron electron install.js
link tsc typescript bin/tsc
exit 0
