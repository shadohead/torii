import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const configFile = join(homedir(), 'discord-automation.json');
export const statusFile = '/tmp/torii-discord-automation.json';
export const discordStates = ['disabled', 'unconfigured', 'waiting', 'starting', 'joining', 'sharing', 'streaming', 'needs_login', 'needs_verification', 'needs_attention', 'retrying', 'error'];

export function channelTarget(value) {
  const url = new URL(value);
  const match = url.pathname.match(/^\/channels\/(\d{17,20})\/(\d{17,20})\/?$/);
  if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.port || url.username || url.password || url.search || url.hash || !match) {
    throw new Error('Use a Discord server voice-channel URL: https://discord.com/channels/SERVER_ID/CHANNEL_ID');
  }
  return { guildId: match[1], channelId: match[2], channelUrl: `https://discord.com/channels/${match[1]}/${match[2]}` };
}
export function readConfig(file = configFile) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return { ...channelTarget(value.channelUrl), enabled: value.enabled === true, name: typeof value.name === 'string' ? value.name.slice(0, 120) : '' };
  } catch { return { enabled: false, channelUrl: '', name: '' }; }
}
export function saveConfig(value, file = configFile) {
  const config = { ...channelTarget(value.channelUrl), enabled: value.enabled === true, name: String(value.name || '').slice(0, 120) };
  writeFileSync(`${file}.tmp`, JSON.stringify(config), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return config;
}
export function publicDiscordStatus(value, now = Date.now()) {
  if (!value || !discordStates.includes(value.state) || !Number.isFinite(value.at) || value.at > now + 5000 || now - value.at > 45000) return null;
  return { state: value.state, error: typeof value.error === 'string' ? value.error.slice(0, 250) : null, video: value.video === true, audio: value.audio === true, at: value.at };
}
export function readDiscordStatus(now = Date.now()) {
  try { return publicDiscordStatus(JSON.parse(readFileSync(statusFile, 'utf8')), now); } catch { return null; }
}
export class RecoverySchedule {
  constructor() { this.failures = 0; this.retryAt = 0; this.idleSince = null; }
  failed(now) { this.retryAt = now + Math.min(300000, 15000 * 2 ** Math.min(this.failures++, 5)); }
  recovered() { this.failures = 0; this.retryAt = 0; }
  canRetry(now) { return now >= this.retryAt; }
  shouldLeave(active, now) {
    if (active) { this.idleSince = null; return false; }
    this.idleSince ??= now;
    return now - this.idleSince >= 60000;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  try {
    if (mode === 'enable') console.log(JSON.stringify(saveConfig({ enabled: true, channelUrl: process.argv[3], name: process.argv[4] })));
    else if (mode === 'disable') {
      const old = readConfig();
      if (old.channelUrl) saveConfig({ ...old, enabled: false });
      console.log('Discord automation disabled. An existing manual share is left running.');
    } else if (mode === 'status') console.log(JSON.stringify({ config: readConfig(), status: readDiscordStatus() }, null, 2));
    else throw new Error('Use enable CHANNEL_URL [NAME] | disable | status');
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
