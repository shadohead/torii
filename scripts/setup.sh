#!/bin/bash
# One-command Torii setup, run from a checkout (install.sh fetches source and
# calls this for you on machines that have nothing yet).
#   npm run setup                    # install deps, start the service, open the UI
#   bash scripts/setup.sh            # same, and works before Node is installed
# Flags:
#   --no-service   do not install the launchd login item (starts in the background once)
#   --no-app       skip building /Applications/Torii.app
#   --no-open      do not open the browser at the end
# Env knobs (persisted into the service definition when set):
#   TORII_PORT, TORII_DATA_DIR, TORII_LIBRARY_DIR
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION="22.16.0"   # keep in sync with install.sh
DATA_DIR="${TORII_DATA_DIR:-$HOME/.torii}"
PORT="${TORII_PORT:-3939}"

NO_APP=0; NO_OPEN=0; NO_SERVICE=0
for arg in ${1+"$@"}; do
  case "$arg" in
    --no-app) NO_APP=1 ;;
    --no-open) NO_OPEN=1 ;;
    --no-service) NO_SERVICE=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# --- Node: use the system one if it is new enough, else keep a private copy ---
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if ! node_ok; then
  if [ ! -x "$DATA_DIR/node/bin/node" ]; then
    case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;; esac
    case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; esac
    echo "▸ no Node.js >= 20 found - installing a private copy to $DATA_DIR/node"
    mkdir -p "$DATA_DIR/node"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$os-$arch.tar.gz" \
      | tar -xz -C "$DATA_DIR/node" --strip-components=1
  fi
  export PATH="$DATA_DIR/node/bin:$PATH"
  node_ok || { echo "could not provision Node.js - install Node >= 20 manually and re-run" >&2; exit 1; }
fi

echo "▸ installing dependencies"
npm install --no-fund --no-audit

if [ "$(uname)" = "Darwin" ] && [ "$NO_SERVICE" -eq 0 ]; then
  echo "▸ installing background service (starts at login)"
  node scripts/service.mjs install
else
  [ "$(uname)" = "Darwin" ] || echo "▸ non-macOS: no managed service - supervise 'npm start' yourself (systemd, pm2, ...)"
  echo "▸ starting Torii in the background"
  # Absolute path so the process is findable by the uninstaller.
  nohup node "$PWD/src/server.mjs" >/dev/null 2>&1 &
fi

if [ "$(uname)" = "Darwin" ] && [ "$NO_APP" -eq 0 ]; then
  echo "▸ building Torii.app"
  bash scripts/make-app.sh
fi

echo "▸ waiting for the service"
for _ in $(seq 1 30); do
  curl -s -m 1 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 && break
  sleep 0.3
done
curl -s -m 2 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 || {
  echo "service did not come up - check $DATA_DIR/torii.log" >&2; exit 1
}

LAN_IP="$(node -p 'Object.values(require("os").networkInterfaces()).flat().find(i => i && !i.internal && i.family === "IPv4")?.address || "localhost"')"
echo
echo "Torii is running:"
echo "  this machine:  http://localhost:$PORT"
echo "  your phone:    http://$LAN_IP:$PORT   (same wifi; Share → Add to Home Screen)"
echo
echo "Next: open Setup in the UI to pick your library folder and check the Plex connection."
[ "$NO_OPEN" -eq 1 ] || { command -v open >/dev/null && open "http://localhost:$PORT" || true; }
