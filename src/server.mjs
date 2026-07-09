import http from 'node:http';
import { createReadStream, existsSync, statSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getSettings, setSettings, db } from './db.mjs';
import { POSTER_CACHE_DIR, PORT_OVERRIDE } from './config.mjs';
import * as anilist from './anilist.mjs';
import * as nyaa from './nyaa.mjs';
import * as plex from './plex.mjs';
import * as torrents from './torrents.mjs';
import * as watchlist from './watchlist.mjs';
import * as system from './system.mjs';
import { addClient } from './sse.mjs';
import { freeBytes, diskSpace, incomingDir } from './organize.mjs';
import { log } from './log.mjs';

const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const json = (res, code, body) => {
  const buf = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(buf);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) { chunks.push(c); if (chunks.length > 4096) throw new Error('body too large'); }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// ---------- API routes ----------
const routes = [
  ['GET', /^\/api\/home$/, async () => anilist.home()],

  ['GET', /^\/api\/browse$/, async (_m, url) => anilist.browse({
    chart: url.searchParams.get('chart') || 'trending',
    season: url.searchParams.get('season')?.toUpperCase(),
    year: url.searchParams.get('year'),
    page: url.searchParams.get('page'),
  })],

  ['GET', /^\/api\/search$/, async (_m, url) => {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return [];
    return anilist.searchAnime(q);
  }],

  ['GET', /^\/api\/show\/(\d+)$/, async (m) => {
    const show = await anilist.getAnime(m[1]);
    const season = nyaa.seasonFromShowTitle(show.romaji || show.english || '');
    // Episodes tab: only this season (unmarked releases pass - absolute numbering).
    // Batches stay unfiltered so older seasons of a franchise are easy to grab.
    const releases = (await nyaa.releasesForShow(show)).filter(r =>
      r.parsed.batch || r.parsed.episode == null || r.parsed.season == null || r.parsed.season === season);
    return { show, season, releases };
  }],

  ['GET', /^\/api\/nyaa$/, async (_m, url) => {
    const q = (url.searchParams.get('q') || '').trim();
    return q ? nyaa.searchNyaa(q) : [];
  }],

  ['POST', /^\/api\/download$/, async (_m, _url, body) => {
    return torrents.startDownload({
      title: body.title, torrentUrl: body.torrentUrl, infoHash: body.infoHash,
      size: body.size, parsed: body.parsed || nyaa.parseRelease(body.title || ''),
      showTitle: body.showTitle, anilistId: body.anilistId, season: body.season, source: 'manual',
    });
  }],

  ['GET', /^\/api\/downloads$/, async () => torrents.listDownloads()],
  ['DELETE', /^\/api\/downloads\/(\d+)$/, async (m) => torrents.cancelDownload(Number(m[1]))],

  ['GET', /^\/api\/watchlist$/, async () => watchlist.listWatchlist()],
  ['POST', /^\/api\/watchlist$/, async (_m, _url, body) =>
    watchlist.addToWatchlist({ anilistId: body.anilistId, group: body.group, quality: body.quality })],
  ['DELETE', /^\/api\/watchlist\/(\d+)$/, async (m) => { watchlist.removeFromWatchlist(Number(m[1])); return { ok: true }; }],
  ['PATCH', /^\/api\/watchlist\/(\d+)$/, async (m, _url, body) => {
    if ('auto' in body) watchlist.setAuto(Number(m[1]), body.auto);
    return { ok: true };
  }],
  ['POST', /^\/api\/watchlist\/(\d+)\/check$/, async (m) => {
    const row = watchlist.listWatchlist().find(r => r.anilist_id === Number(m[1]));
    if (!row) return { ok: false, reason: 'not tracked' };
    const grabbed = await watchlist.checkShow(row);
    return { ok: true, grabbed };
  }],

  ['GET', /^\/api\/status$/, async () => {
    const s = getSettings();
    const plexStatus = await plex.status();
    const login = await system.loginItemStatus();
    const disk = diskSpace();
    return {
      plex: plexStatus,
      free: disk.free,
      diskTotal: disk.total,
      libraryDir: s.libraryDir,
      activeTorrents: torrents.activeCount(),
      loginItem: login,
      version: '1.0.0',
    };
  }],

  ['GET', /^\/api\/settings$/, async () => {
    const s = getSettings();
    return { ...s, plexToken: s.plexToken ? '••••' + s.plexToken.slice(-4) : '' };
  }],
  ['PATCH', /^\/api\/settings$/, async (_m, _url, body) => {
    if (body.plexToken && body.plexToken.includes('•')) delete body.plexToken;
    setSettings(body);
    return { ok: true };
  }],

  // Change the library folder: validate, create, probe writability, report Plex coverage.
  ['POST', /^\/api\/library-dir$/, async (_m, _url, body) => {
    const dir = String(body.dir || '').trim().replace(/\/+$/, '');
    if (!dir.startsWith('/')) return { ok: false, reason: 'absolute path required' };
    if (dir === '/' || dir.split('/').length < 3) return { ok: false, reason: 'pick a folder, not a volume root' };
    try {
      mkdirSync(dir, { recursive: true });
      const probe = join(dir, '.torii-write-probe');
      writeFileSync(probe, 'x');
      unlinkSync(probe);
    } catch (err) {
      return { ok: false, reason: `not writable: ${err.code || err.message}` };
    }
    setSettings({ libraryDir: dir });
    incomingDir(); // create .incoming under the new root
    let covered = null;
    try {
      const secs = await plex.sections();
      covered = secs.find(s => s.locations.some(l => plex.pathWithin(dir, l)))?.title || null;
    } catch {}
    log('library dir changed to', dir, covered ? `(Plex: ${covered})` : '(no Plex section covers it)');
    return { ok: true, dir, free: freeBytes(), covered };
  }],

  ['POST', /^\/api\/plex\/start$/, async () => plex.startPlex()],
  ['POST', /^\/api\/plex\/scan$/, async () => plex.scanLibrary(null)],
  ['POST', /^\/api\/plex\/create-library$/, async () => plex.ensureAnimeSection()],
  ['POST', /^\/api\/login-item$/, async (_m, _url, body) =>
    body.enabled ? system.enableLoginItem() : system.disableLoginItem()],
];

// ---------- poster cache proxy ----------
async function servePoster(res, url) {
  const remote = url.searchParams.get('u') || '';
  if (!/^https:\/\/(s\d\.anilist\.co|img\.anili\.st)\//.test(remote)) { res.writeHead(400); return res.end(); }
  const key = createHash('sha1').update(remote).digest('hex') + extname(new URL(remote).pathname);
  const file = join(POSTER_CACHE_DIR, key);
  if (!existsSync(file)) {
    try {
      const r = await fetch(remote, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(String(r.status));
      writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    } catch { res.writeHead(502); return res.end(); }
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] || 'image/jpeg',
    'Content-Length': statSync(file).size,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
}

// ---------- static ----------
function serveStatic(res, pathname) {
  let p = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || p === '') p = '/index.html';
  const file = join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    // SPA fallback
    const index = join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    return createReadStream(index).pipe(res);
  }
  const ext = extname(file);
  // App code must always be fresh (phones cache aggressively); only static art is cacheable.
  const cacheable = ['.png', '.svg', '.woff2', '.ico'].includes(ext);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': statSync(file).size,
    'Cache-Control': cacheable ? 'public, max-age=86400' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/events') return addClient(res);
    if (url.pathname === '/img') return servePoster(res, url);
    for (const [method, re, handler] of routes) {
      if (req.method !== method) continue;
      const m = url.pathname.match(re);
      if (!m) continue;
      const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await readBody(req) : null;
      const out = await handler(m, url, body);
      return json(res, 200, out);
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    return serveStatic(res, url.pathname);
  } catch (err) {
    log.error(req.method, url.pathname, String(err));
    return json(res, 500, { error: String(err.message || err) });
  }
});

const settings = getSettings();
const port = PORT_OVERRIDE || settings.port;
mkdirSync(settings.libraryDir, { recursive: true });
incomingDir();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Another torii instance owns the port (launchd + manual run). Exit cleanly so
    // launchd's SuccessfulExit=false policy doesn't respawn-loop us.
    log.warn(`port ${port} in use - torii already running, exiting`);
    process.exit(0);
  }
  throw err;
});

server.listen(port, '0.0.0.0', () => {
  const lan = Object.values(networkInterfaces()).flat().find(i => i && !i.internal && i.family === 'IPv4');
  log(`torii listening on http://${lan?.address || 'localhost'}:${port}`);
  torrents.resumeUnfinished();
  watchlist.startScheduler();
  plex.startWatchdog();
  plex.discoverToken().then(t => log(t ? 'plex token: ok' : 'plex token: not found (set in Setup for instant scans)'));
  plex.ensureAnimeSection().then(r => log('plex anime library:', JSON.stringify(r))).catch(() => {});
});

// Safety net: webtorrent internals occasionally throw from stream event handlers.
// A background service must log and carry on, never die mid-download.
process.on('uncaughtException', (err) => log.error('uncaught', err?.stack || String(err)));
process.on('unhandledRejection', (err) => log.error('unhandledRejection', String(err)));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutting down on', sig);
    server.close();
    setTimeout(() => process.exit(0), 800);
  });
}
