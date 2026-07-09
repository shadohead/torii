#!/bin/bash
# One-command Torii setup.
#   npm run setup                # install deps, start the service, open the UI
#   npm run setup -- --no-app    # skip building /Applications/Torii.app
#   npm run setup -- --no-open   # do not open the browser at the end
# Env knobs (persisted into the service definition when set):
#   TORII_PORT, TORII_DATA_DIR, TORII_LIBRARY_DIR
set -euo pipefail
cd "$(dirname "$0")/.."

NO_APP=0; NO_OPEN=0
for arg in "$@"; do
  case "$arg" in
    --no-app) NO_APP=1 ;;
    --no-open) NO_OPEN=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

command -v node >/dev/null || { echo "Node.js >= 20 is required: https://nodejs.org" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js >= 20 required, found $(node -v)" >&2; exit 1; }

echo "▸ installing dependencies"
npm install --no-fund --no-audit

PORT="${TORII_PORT:-3939}"

if [ "$(uname)" = "Darwin" ]; then
  echo "▸ installing background service (starts at login)"
  node scripts/service.mjs install

  if [ "$NO_APP" -eq 0 ]; then
    echo "▸ building Torii.app"
    bash scripts/make-app.sh
  fi
else
  echo "▸ non-macOS: starting in the foreground is 'npm start'; supervise it yourself (systemd, pm2, ...)"
  nohup node src/server.mjs >/dev/null 2>&1 &
fi

echo "▸ waiting for the service"
for _ in $(seq 1 30); do
  curl -s -m 1 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 && break
  sleep 0.3
done
curl -s -m 2 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 || {
  echo "service did not come up - check ~/.torii/torii.log" >&2; exit 1
}

LAN_IP="$(node -p 'Object.values(require("os").networkInterfaces()).flat().find(i => i && !i.internal && i.family === "IPv4")?.address || "localhost"')"
echo
echo "Torii is running:"
echo "  this machine:  http://localhost:$PORT"
echo "  your phone:    http://$LAN_IP:$PORT   (same wifi; Share → Add to Home Screen)"
echo
echo "Next: open Setup in the UI to pick your library folder and check the Plex connection."
[ "$NO_OPEN" -eq 1 ] || { command -v open >/dev/null && open "http://localhost:$PORT" || true; }
