#!/usr/bin/env bash
set -euo pipefail
shutdown() { trap - TERM INT; wait || true; exit 0; }
trap shutdown TERM INT
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
# A stopped container keeps /tmp, but none of its old display/audio processes.
# Clear only this desktop's transient locks, preserving the Discord profile.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 "$XDG_RUNTIME_DIR/pulse/pid" "$XDG_RUNTIME_DIR/pulse/native" /tmp/torii-discord-automation.json
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
for attempt in {1..50}; do
  if test -S /tmp/.X11-unix/X99; then break; fi
  sleep 0.1
done
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=companion sink_properties=device.description=Torii >/dev/null
pactl set-default-sink companion
openbox &
x11vnc -display :99 -localhost -forever -shared -nopw -rfbport 5900 -quiet &
websockify --web=/usr/share/novnc/ 6080 localhost:5900 &
node /opt/companion/server.mjs &
# These process locks refer to the old container's hostname/PIDs after a
# recreation. Only this service owns the volume; preserve all login/profile data.
rm -f /home/torii/chromium/SingletonLock /home/torii/chromium/SingletonCookie /home/torii/chromium/SingletonSocket
node --input-type=module -e '
  import { existsSync, readFileSync, writeFileSync } from "node:fs";
  const file = "/home/torii/chromium/Default/Preferences";
  if (existsSync(file)) {
    const preferences = JSON.parse(readFileSync(file, "utf8"));
    preferences.profile ||= {};
    preferences.profile.exit_type = "Normal";
    preferences.profile.exited_cleanly = true;
    writeFileSync(file, JSON.stringify(preferences));
  }
'
# Chromium's profile and display exist solely in this unprivileged container.
# Docker drops capabilities; no host display, files, devices or socket are mounted.
# The Chromium sandbox requires privileges/user namespaces unavailable here.
dbus-run-session -- node /opt/companion/discord-automation.mjs &
wait -n
