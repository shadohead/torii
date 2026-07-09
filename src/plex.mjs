import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSettings, setSettings } from './db.mjs';
import { log } from './log.mjs';

const exec = promisify(execFile);

async function plexFetch(path, init = {}) {
  const { plexUrl, plexToken } = getSettings();
  const url = new URL(path, plexUrl);
  if (plexToken) url.searchParams.set('X-Plex-Token', plexToken);
  return fetch(url, { ...init, headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
}

export async function status() {
  try {
    const res = await plexFetch('/identity');
    if (!res.ok) return { running: false };
    const body = await res.json();
    return { running: true, version: body.MediaContainer?.version, machineId: body.MediaContainer?.machineIdentifier };
  } catch {
    return { running: false };
  }
}

export async function discoverToken() {
  const existing = getSettings().plexToken;
  if (existing) return existing;
  // 1. macOS defaults database
  try {
    const { stdout } = await exec('defaults', ['read', 'com.plexapp.plexmediaserver', 'PlexOnlineToken']);
    const token = stdout.trim();
    if (token) { setSettings({ plexToken: token }); log('plex token discovered via defaults'); return token; }
  } catch {}
  // 2. Preferences.xml (older layouts / non-standard homes)
  for (const p of [
    join(homedir(), 'Library/Application Support/Plex Media Server/Preferences.xml'),
    join(homedir(), 'Library/Preferences/Plex Media Server/Preferences.xml'),
  ]) {
    try {
      if (!existsSync(p)) continue;
      const m = readFileSync(p, 'utf8').match(/PlexOnlineToken="([^"]+)"/);
      if (m) { setSettings({ plexToken: m[1] }); log('plex token discovered via Preferences.xml'); return m[1]; }
    } catch {}
  }
  return '';
}

export async function sections() {
  const token = await discoverToken();
  if (!token) return [];
  try {
    const res = await plexFetch('/library/sections');
    if (!res.ok) return [];
    const body = await res.json();
    return (body.MediaContainer?.Directory || []).map(d => ({
      id: d.key, title: d.title, type: d.type,
      locations: (d.Location || []).map(l => l.path),
    }));
  } catch { return []; }
}

// Trigger a scan of whichever section contains our library dir (partial scan of just
// the changed folder when possible). Falls back to refreshing all sections.
export async function scanLibrary(changedDir) {
  const token = await discoverToken();
  if (!token) return { ok: false, reason: 'no token - Plex will pick files up on its own schedule' };
  const { libraryDir } = getSettings();
  try {
    const secs = await sections();
    const target = secs.find(s => s.locations.some(l => pathWithin(libraryDir, l) || pathWithin(l, libraryDir)));
    let path = '/library/sections/all/refresh';
    if (target) {
      path = `/library/sections/${target.id}/refresh` + (changedDir ? `?path=${encodeURIComponent(changedDir)}` : '');
    }
    const res = await plexFetch(path);
    log('plex scan triggered', path, res.status);
    return { ok: res.ok, section: target?.title || 'all' };
  } catch (err) {
    log.warn('plex scan failed', String(err));
    return { ok: false, reason: String(err) };
  }
}

// Create the "Anime" library section pointing at our folder if no section covers it yet.
export async function ensureAnimeSection() {
  const token = await discoverToken();
  if (!token) return { ok: false, reason: 'no token' };
  const { libraryDir } = getSettings();
  const existing = await sections();
  const covered = existing.find(s => s.locations.some(l => pathWithin(libraryDir, l)));
  if (covered) return { ok: true, section: covered.title, created: false };
  const params = new URLSearchParams({
    name: 'Anime', type: 'show', agent: 'tv.plex.agents.series',
    scanner: 'Plex TV Series', language: 'en-US', location: libraryDir,
  });
  try {
    const res = await plexFetch(`/library/sections?${params}`, { method: 'POST' });
    log('plex Anime library create:', res.status);
    return { ok: res.ok, section: 'Anime', created: res.ok };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

export async function startPlex() {
  try {
    await exec('open', ['-a', 'Plex Media Server', '--background']);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

// Path containment with a directory boundary ("/x/Anime" does not cover "/x/AnimeTest").
export const pathWithin = (child, parent) => child === parent || child.startsWith(parent.replace(/\/$/, '') + '/');

// Watchdog: keep Plex alive if the user asked for that.
let watchdog = null;
export function startWatchdog() {
  clearInterval(watchdog);
  watchdog = setInterval(async () => {
    if (!getSettings().keepPlexRunning) return;
    const s = await status();
    if (!s.running) {
      log('plex is down - starting it');
      await startPlex();
    }
  }, 5 * 60e3);
  watchdog.unref();
}
