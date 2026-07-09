import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_FILE } from './config.mjs';

const exec = promisify(execFile);
const LABEL = 'com.torii.service';
const PLIST = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');

function plistXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${SERVER}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>Nice</key><integer>10</integer>
  <key>LowPriorityBackgroundIO</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string>${['TORII_PORT', 'TORII_DATA_DIR', 'TORII_LIBRARY_DIR']
      .filter(k => process.env[k])
      .map(k => `\n    <key>${k}</key><string>${process.env[k]}</string>`)
      .join('')}
  </dict>
</dict>
</plist>`;
}

export async function loginItemStatus() {
  try {
    await exec('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]);
    return { installed: existsSync(PLIST), loaded: true };
  } catch {
    return { installed: existsSync(PLIST), loaded: false };
  }
}

// Install the LaunchAgent. If torii is already running (this process), the agent
// instance would find the port taken and exit(0); SuccessfulExit=false stops respawn
// flapping, and the agent takes over on next login/boot.
export async function enableLoginItem() {
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, plistXml());
  try { await exec('launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST]); } catch {}
  return loginItemStatus();
}

export async function disableLoginItem() {
  try { await exec('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]); } catch {}
  try { rmSync(PLIST); } catch {}
  return loginItemStatus();
}
