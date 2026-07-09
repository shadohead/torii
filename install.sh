#!/bin/bash
# Torii bootstrap installer - works on a machine with nothing but curl.
#
#   curl -fsSL https://raw.githubusercontent.com/shadohead/torii/main/install.sh | bash
#
# Provisions a private Node.js runtime under ~/.torii/node if the system has
# none (no Homebrew, no sudo), fetches the source to ~/.torii/app, then hands
# off to scripts/setup.sh. Flags are forwarded to setup.sh
# (--no-service, --no-app, --no-open). Override locations with
# TORII_DATA_DIR / TORII_INSTALL_DIR.
set -euo pipefail

main() {
  REPO="shadohead/torii"
  NODE_VERSION="22.16.0"   # keep in sync with scripts/setup.sh
  DATA_DIR="${TORII_DATA_DIR:-$HOME/.torii}"
  INSTALL_DIR="${TORII_INSTALL_DIR:-$DATA_DIR/app}"

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

  # --- source ---
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "$INSTALL_DIR is a git checkout - update it with git pull, then run: npm run setup" >&2
    exit 1
  fi
  echo "▸ fetching Torii to $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  # Keep node_modules across updates so reinstalls stay fast; npm reconciles it.
  find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" \
    | tar -xz -C "$INSTALL_DIR" --strip-components=1

  exec bash "$INSTALL_DIR/scripts/setup.sh" ${1+"$@"}
}

main ${1+"$@"}
