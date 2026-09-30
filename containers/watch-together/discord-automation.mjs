import { chromium } from 'playwright-core';
import { writeFileSync, renameSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { readConfig, statusFile, RecoverySchedule } from './automation-config.mjs';

const playerUrl = 'http://127.0.0.1:8080/';
const playerTitle = 'Torii Watch Together';
const recovery = new RecoverySchedule();
let context, discord, player, stopping = false, lastState = '', currentTarget = '';
function report(state, error = null, capture = {}) {
  const value = { state, error, video: capture.video === true, audio: capture.audio === true, width: capture.width || null, height: capture.height || null, at: Date.now() };
  writeFileSync(`${statusFile}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${statusFile}.tmp`, statusFile);
  const key = `${state}:${error || ''}`;
  if (lastState !== key) { console.log(`Discord automation: ${state}${error ? ` — ${error}` : ''}`); lastState = key; }
}

// Observe the standard browser capture API, without Discord tokens or private APIs.
// These flags never claim that a remote viewer has received the media.
function observeCapture() {
  if (location.hostname !== 'discord.com' || !navigator.mediaDevices?.getDisplayMedia) return;
  const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
  let captured;
  navigator.mediaDevices.getDisplayMedia = async (...args) => {
    captured = await original(...args);
    return captured;
  };
  window.__toriiCaptureStatus = () => {
    const video = captured?.getVideoTracks().find(t => t.readyState === 'live');
    const audio = captured?.getAudioTracks().find(t => t.readyState === 'live');
    const settings = video?.getSettings();
    return { video: !!video, audio: !!audio, surface: settings?.displaySurface || null, width: settings?.width || null, height: settings?.height || null };
  };
}
const visibleButton = (page, name) => page.getByRole('button', { name }).filter({ visible: true }).first();
const isVisible = async locator => locator.isVisible().catch(() => false);
const stopShare = () => visibleButton(discord, /^(Stop Streaming|Stop Sharing|Stop Screen Share)$/i);
const disconnect = () => visibleButton(discord, /^Disconnect$/i);
const connected = () => isVisible(discord.getByText('Voice Connected', { exact: true }).first());
const captureStatus = () => discord.evaluate(() => window.__toriiCaptureStatus?.() || { video: false, audio: false, surface: null });
async function fullscreenPlayer() {
  await player.bringToFront();
  if (!await player.evaluate(() => !!document.fullscreenElement)) {
    await player.locator('video').press('f');
    await player.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 5000 });
  }
}
async function attention() {
  if (new URL(discord.url()).pathname.startsWith('/login') || await isVisible(discord.getByRole('heading', { name: /Welcome back!/i }))) return ['needs_login', 'Sign into the separate account in the isolated desktop.'];
  if (await isVisible(discord.getByText(/Please check your email to verify your account|You must verify your account before/i).first())) return ['needs_verification', 'Verify the Discord account email before joining voice.'];
  if (await isVisible(discord.locator('iframe[src*="hcaptcha"], iframe[src*="recaptcha"]').first()) || await isVisible(discord.getByText(/Verify you are human|Verify your identity|Two-Factor Authentication/i).first())) return ['needs_attention', 'Discord requires verification. Complete it yourself in the isolated desktop.'];
  return null;
}
async function leave() {
  if (await isVisible(stopShare())) await stopShare().click();
  if (await isVisible(disconnect())) await disconnect().click();
}
async function dismissPromotion() {
  // Close only a recognized non-binding promotion, never verification or terms.
  const promo = discord.getByRole('dialog').filter({ hasText: /New in the Shop:|What's New/i }).first();
  const close = promo.getByRole('button', { name: /^(Close|Dismiss)$/i }).first();
  if (await isVisible(promo) && await isVisible(close)) await close.click();
  const teenNotice = discord.getByText(/Launched Additional Protections for Teens|age group hasn.t been confirmed yet/i).filter({ visible: true }).first();
  if (await isVisible(teenNotice) && await isVisible(visibleButton(discord, /^Close$/i))) await visibleButton(discord, /^Close$/i).click();
}
async function joinAndShare(config) {
  // Discord redirects voice-channel URLs to the last text channel in the guild.
  // Remaining in that guild is enough; use its exact voice-channel link to join.
  if (!discord.url().startsWith(`https://discord.com/channels/${config.guildId}/`)) await discord.goto(config.channelUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const gate = await attention();
  if (gate) { report(...gate); return; }
  await dismissPromotion();
  if (!await connected()) {
    report('joining');
    const link = discord.locator(`[data-list-item-id="channels___${config.channelId}"], a[href="/channels/${config.guildId}/${config.channelId}"]`).filter({ visible: true }).first();
    const join = visibleButton(discord, /^(Join Voice|Join Call|Join Voice Channel)$/i);
    if (await isVisible(join)) await join.click();
    else await link.click({ timeout: 15000 });
    await discord.getByText('Voice Connected', { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
  }
  let capture = await captureStatus();
  if (capture.video && capture.audio && capture.surface === 'browser' && await isVisible(stopShare())) {
    recovery.recovered(); report('streaming', null, capture); return;
  }
  if (capture.video || await isVisible(stopShare())) await leave();
  if (!await connected()) return; // Rejoin on the next bounded attempt after an incomplete share.
  // Chromium matches a title substring; reject even another partial match.
  const candidates = await Promise.all(context.pages().map(async p => ({ page: p, title: await p.title() })));
  if (candidates.filter(p => p.title.includes(playerTitle)).length !== 1 || await player.title() !== playerTitle) throw new Error('ambiguous-player');
  report('sharing');
  await visibleButton(discord, /^(Share Your Screen|Share Screen|Screen Share|Screen)$/i).click({ timeout: 15000 });
  const deadline = Date.now() + 30000;
  let clickedGoLive = false;
  while (Date.now() < deadline && !stopping) {
    const gate = await attention();
    if (gate) { report(...gate); return; }
    const go = visibleButton(discord, /^Go Live$/i);
    if (!clickedGoLive && await isVisible(go)) { await go.click(); clickedGoLive = true; }
    capture = await captureStatus();
    if (capture.video && capture.audio && capture.surface === 'browser' && await isVisible(stopShare())) {
      recovery.recovered(); report('streaming', null, capture);
      await fullscreenPlayer(); return;
    }
    await sleep(1000);
  }
  if (capture.video && (!capture.audio || capture.surface !== 'browser')) {
    await leave(); report('needs_attention', 'The share did not include the Torii browser tab and audio. Inspect the isolated desktop.');
    recovery.failed(Date.now()); return;
  }
  throw new Error('share-not-confirmed');
}
async function launch() {
  report('starting');
  context = await chromium.launchPersistentContext('/home/torii/chromium', {
    executablePath: '/usr/bin/chromium', headless: false, viewport: null,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-session-crashed-bubble', '--password-store=basic', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720', `--auto-select-tab-capture-source-by-title=${playerTitle}`],
  });
  await context.addInitScript(observeCapture);
  player = context.pages()[0] || await context.newPage();
  await player.goto(playerUrl, { waitUntil: 'domcontentloaded' });
  discord = await context.newPage();
  const config = readConfig();
  await discord.goto(config.enabled ? config.channelUrl : 'https://discord.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
  currentTarget = config.channelUrl;
  recovery.recovered();
}
async function tick() {
  if (!context || !player || !discord || player.isClosed() || discord.isClosed()) {
    if (!recovery.canRetry(Date.now())) { report('retrying', 'Restarting the isolated browser shortly.'); return; }
    await context?.close().catch(() => {}); context = null; await launch();
  }
  const config = readConfig();
  if (!config.enabled) { report(config.channelUrl ? 'disabled' : 'unconfigured'); return; }
  if (currentTarget !== config.channelUrl) {
    await leave(); currentTarget = config.channelUrl; recovery.recovered();
    await discord.goto(config.channelUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  const gate = await attention();
  if (gate) { report(...gate); return; }
  const res = await fetch(new URL('/status', playerUrl), { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('player-unavailable');
  const media = await res.json();
  const active = !!media.session && ['following', 'loading'].includes(media.state);
  if (!active) {
    if (recovery.shouldLeave(false, Date.now())) await leave();
    report('waiting'); return;
  }
  recovery.shouldLeave(true, Date.now());
  const capture = await captureStatus();
  if (await connected() && capture.video && capture.audio && capture.surface === 'browser' && await isVisible(stopShare())) {
    recovery.recovered(); report('streaming', null, capture); return;
  }
  if (!recovery.canRetry(Date.now())) { report('retrying', 'Reconnecting Discord shortly.'); return; }
  await joinAndShare(config);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; context?.close().catch(() => {}); });
while (!stopping) {
  try { await tick(); }
  catch {
    recovery.failed(Date.now());
    report('retrying', 'Discord controls could not be reached. Retrying; check the isolated desktop if this persists.');
    // Narrow diagnostics include control labels only, never messages or credentials.
    if (discord && !discord.isClosed()) {
      const controls = await discord.locator('button[aria-label], [role="button"][aria-label]').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label')).filter(label => /^(Close|Dismiss|Join|Share|Stop|Disconnect|Screen|Voice)/i.test(label))).catch(() => []);
      const config = readConfig();
      const targetLinks = await discord.locator(`a[href="/channels/${config.guildId}/${config.channelId}"]`).evaluateAll(nodes => nodes.map(n => ({ role: n.getAttribute('role'), label: n.getAttribute('aria-label') }))).catch(() => []);
      const channelLabel = config.name.split(' · ').at(-1);
      const channelNodes = channelLabel ? await discord.getByText(channelLabel, { exact: true }).evaluateAll(nodes => nodes.map(n => {
        const ancestors = []; let current = n;
        for (let i = 0; current && i < 5; i++, current = current.parentElement) ancestors.push({ tag: current.tagName, role: current.getAttribute('role'), href: current.getAttribute('href'), listId: current.getAttribute('data-list-item-id'), label: current.getAttribute('aria-label') });
        return ancestors;
      })).catch(() => []) : [];
      writeFileSync('/tmp/torii-discord-controls.json', JSON.stringify({ controls, targetLinks, channelNodes, capture: await captureStatus().catch(() => null) }), { mode: 0o600 });
    }
    if (!context || !player || !discord || player.isClosed() || discord.isClosed()) { await context?.close().catch(() => {}); context = null; player = null; discord = null; }
  }
  await sleep(5000);
}
