#!/bin/bash
# Builds Torii.app - a double-clickable macOS launcher for the Torii service.
# The .app ensures the background service is running, then opens the web UI.
# Re-run after moving the project or switching Node versions.
set -euo pipefail

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PORT="${TORII_PORT:-3939}"
VERSION="$(node -p "require('$PROJ/package.json').version")"

APP_DIR="/Applications"
[ -w "$APP_DIR" ] || { APP_DIR="$HOME/Applications"; mkdir -p "$APP_DIR"; }
APP="$APP_DIR/Torii.app"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# ---- icon: rasterize the SVG at every size iconutil needs ----
TMP="$(mktemp -d)"
ICONSET="$TMP/Torii.iconset"
mkdir -p "$ICONSET"
for s in 16 32 64 128 256 512 1024; do
  qlmanage -t -s "$s" -o "$TMP" "$PROJ/public/icon.svg" >/dev/null 2>&1
  mv "$TMP/icon.svg.png" "$TMP/icon_$s.png"
done
cp "$TMP/icon_16.png"   "$ICONSET/icon_16x16.png"
cp "$TMP/icon_32.png"   "$ICONSET/icon_16x16@2x.png"
cp "$TMP/icon_32.png"   "$ICONSET/icon_32x32.png"
cp "$TMP/icon_64.png"   "$ICONSET/icon_32x32@2x.png"
cp "$TMP/icon_128.png"  "$ICONSET/icon_128x128.png"
cp "$TMP/icon_256.png"  "$ICONSET/icon_128x128@2x.png"
cp "$TMP/icon_256.png"  "$ICONSET/icon_256x256.png"
cp "$TMP/icon_512.png"  "$ICONSET/icon_256x256@2x.png"
cp "$TMP/icon_512.png"  "$ICONSET/icon_512x512.png"
cp "$TMP/icon_1024.png" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Torii.icns"
rm -rf "$TMP"

# ---- launcher ----
cat > "$APP/Contents/MacOS/Torii" <<LAUNCHER
#!/bin/bash
# Torii launcher: make sure the service is up, then open the UI.
PLIST="\$HOME/Library/LaunchAgents/com.torii.service.plist"
if ! curl -s -m 1 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then
  if [ -f "\$PLIST" ]; then
    launchctl bootstrap "gui/\$(id -u)" "\$PLIST" 2>/dev/null
    launchctl kickstart "gui/\$(id -u)/com.torii.service" 2>/dev/null
  else
    nohup "$NODE" "$PROJ/src/server.mjs" >> "\$HOME/.torii/torii.log" 2>&1 &
  fi
  for _ in \$(seq 1 30); do
    curl -s -m 1 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 && break
    sleep 0.3
  done
fi
[ -n "\${TORII_NO_OPEN:-}" ] || open "http://127.0.0.1:$PORT"
LAUNCHER
chmod +x "$APP/Contents/MacOS/Torii"

# ---- Info.plist ----
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Torii</string>
  <key>CFBundleDisplayName</key><string>Torii</string>
  <key>CFBundleIdentifier</key><string>com.torii.app</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>Torii</string>
  <key>CFBundleIconFile</key><string>Torii</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict>
</plist>
PLIST

touch "$APP"
echo "built: $APP"
