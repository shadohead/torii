#!/bin/bash
# Torii uninstaller - removes the background service, Torii.app, partial
# downloads, and Torii's program files (including the private Node runtime).
#
#   curl -fsSL https://raw.githubusercontent.com/shadohead/torii/main/uninstall.sh | bash
#   npm run uninstall            # same, from a checkout
#   ... | bash -s -- --purge     # also remove settings, watchlist, and caches
#
# Your media library is NEVER touched: everything Torii downloaded and
# organized stays in Plex. Without --purge, settings and watchlist survive
# a reinstall.
set -euo pipefail

main() {
  PURGE=0
  for arg in ${1+"$@"}; do
    case "$arg" in
      --purge) PURGE=1 ;;
      *) echo "unknown flag: $arg (supported: --purge)" >&2; exit 1 ;;
    esac
  done

  DATA_DIR="${TORII_DATA_DIR:-$HOME/.torii}"
  LABEL="com.torii.service"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

  # Resolve the library folder before any data is removed so .incoming can be cleaned.
  LIBRARY_DIR=""
  if command -v sqlite3 >/dev/null 2>&1 && [ -f "$DATA_DIR/torii.db" ]; then
    LIBRARY_DIR="$(sqlite3 "$DATA_DIR/torii.db" \
      "select value from settings where key='libraryDir'" 2>/dev/null | sed 's/^"//; s/"$//')" || true
  fi
  [ -n "$LIBRARY_DIR" ] || LIBRARY_DIR="${TORII_LIBRARY_DIR:-$HOME/Movies/Anime}"

  if [ "$(uname)" = "Darwin" ]; then
    echo "▸ stopping the background service"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "▸ removing Torii.app"
    rm -rf "/Applications/Torii.app" "$HOME/Applications/Torii.app"
  fi
  pkill -f "torii.*src/server\.mjs" 2>/dev/null || true

  if [ -d "$LIBRARY_DIR/.incoming" ]; then
    echo "▸ removing partial downloads ($LIBRARY_DIR/.incoming)"
    rm -rf "$LIBRARY_DIR/.incoming"
  fi

  echo "▸ removing program files"
  rm -rf "$DATA_DIR/app" "$DATA_DIR/node"

  if [ "$PURGE" -eq 1 ]; then
    echo "▸ removing settings, watchlist, and caches ($DATA_DIR)"
    rm -rf "$DATA_DIR"
  else
    echo "▸ kept $DATA_DIR (settings, watchlist, download history) - pass --purge to remove it"
  fi

  echo
  echo "Torii is uninstalled. Your media in $LIBRARY_DIR was not touched."
  if [ -f "package.json" ] && grep -q '"name": "torii"' package.json 2>/dev/null; then
    echo "This checkout itself was left alone - delete the folder if you no longer want it."
  fi
}

main ${1+"$@"}
