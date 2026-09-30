import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelTarget, readConfig, saveConfig, publicDiscordStatus, RecoverySchedule } from '../containers/watch-together/automation-config.mjs';
import { WatchTogether } from '../src/watch-together.mjs';

const target = 'https://discord.com/channels/597931060780728340/605840475762844180';
test('automation only accepts an explicit Discord server/channel URL without credentials or redirects', () => {
  assert.equal(channelTarget(target + '/').channelUrl, target);
  for (const url of [target.replace('https:', 'http:'), target.replace('discord.com', 'discord.com.evil.test'), target.replace('discord.com', 'user:password@discord.com'), target + '?redirect=evil', target + '#token', 'https://discord.com/channels/@me/605840475762844180', 'https://discord.com/channels/1/2', target.replace('discord.com', 'discord.com:4433')]) assert.throws(() => channelTarget(url));
});
test('saved destination survives a restart; corrupted configuration fails closed without changing the login profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'torii-discord-config-')), file = join(root, 'config.json');
  try {
    saveConfig({ enabled: true, channelUrl: target, name: 'Beanbag Lounge' }, file);
    assert.equal(readConfig(file).channelUrl, target); assert.equal(readConfig(file).enabled, true);
    saveConfig({ ...readConfig(file), enabled: false }, file);
    assert.equal(readConfig(file).enabled, false); assert.equal(readConfig(file).channelUrl, target);
    const previous = readFileSync(file, 'utf8');
    assert.throws(() => saveConfig({ enabled: true, channelUrl: 'https://evil.test' }, file));
    assert.equal(readFileSync(file, 'utf8'), previous);
    writeFileSync(file, '{invalid'); assert.equal(readConfig(file).enabled, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('recovery backs off, resets after success, and does not leave during brief episode transitions', () => {
  const r = new RecoverySchedule();
  r.failed(0); assert.equal(r.canRetry(14999), false); assert.equal(r.canRetry(15000), true);
  r.failed(15000); assert.equal(r.retryAt, 45000);
  for (let i = 0; i < 30; i++) r.failed(100000);
  assert.equal(r.retryAt, 400000);
  r.recovered(); assert.equal(r.canRetry(0), true);
  assert.equal(r.shouldLeave(false, 0), false); assert.equal(r.shouldLeave(false, 59999), false);
  assert.equal(r.shouldLeave(true, 60000), false); assert.equal(r.shouldLeave(false, 61000), false);
  assert.equal(r.shouldLeave(false, 121000), true);
});
test('Discord heartbeat exposes capture evidence only, drops private fields, and expires stale or invalid status', () => {
  const incoming = { state: 'streaming', video: true, audio: true, at: 10000, token: 'secret', cookie: 'private', profile: '/home/torii/chromium' };
  assert.deepEqual(publicDiscordStatus(incoming, 10000), { state: 'streaming', error: null, video: true, audio: true, at: 10000 });
  for (const value of [{ ...incoming, at: 0 }, { ...incoming, at: 1000000 }, { ...incoming, state: 'made-up' }]) assert.equal(publicDiscordStatus(value, 50000), null);
  const together = new WatchTogether({ getSettings: () => ({}), setSettings: () => {}, readSessions: async () => [], now: () => 10000 });
  together.heartbeat({ state: 'following', discord: incoming });
  assert.equal(together.status().companion.discord.audio, true);
  assert.equal(JSON.stringify(together.status()).includes('secret'), false);
});
test('paused status exposes the saved destination while excluding channel URLs and credentials', () => {
  const value = publicDiscordStatus({ state: 'paused', video: false, audio: false, at: 10000, automationEnabled: true, destination: 'The Zoo · Beanbag Lounge', channelUrl: target, token: 'secret' }, 10000);
  assert.equal(value.state, 'paused'); assert.equal(value.destination, 'The Zoo · Beanbag Lounge');
  assert.equal(value.automationEnabled, true);
  assert.equal('channelUrl' in value, false); assert.equal('token' in value, false);
});
