import { join } from 'node:path';
import { db, getSettings } from './db.mjs';
import { incomingDir, organizeDownload, cleanupIncoming, freeBytes } from './organize.mjs';
import { scanLibrary } from './plex.mjs';
import { broadcast } from './sse.mjs';
import { log } from './log.mjs';

let client = null;           // lazy - only exists while torrents are active
const active = new Map();    // infoHash -> { torrent, dl, seedTimer }

const insertDl = db.prepare(`
  INSERT INTO downloads (info_hash, release_title, show_title, anilist_id, season, episode, group_name, quality, torrent_url, size, status, source, added_at)
  VALUES (@info_hash, @release_title, @show_title, @anilist_id, @season, @episode, @group_name, @quality, @torrent_url, @size, 'queued', @source, @added_at)
`);
const updStatus = db.prepare('UPDATE downloads SET status = ?, error = ? WHERE id = ?');
const updProgress = db.prepare('UPDATE downloads SET progress = ?, size = ? WHERE id = ?');
const updDone = db.prepare(`UPDATE downloads SET status = ?, progress = 1, completed_at = ?, final_paths = ? WHERE id = ?`);
const getByHash = db.prepare('SELECT * FROM downloads WHERE info_hash = ?');
const getById = db.prepare('SELECT * FROM downloads WHERE id = ?');

async function getClient() {
  if (client) return client;
  const { default: WebTorrent } = await import('webtorrent');
  const s = getSettings();
  client = new WebTorrent({
    maxConns: s.maxConns,
    dht: false,   // nyaa torrents are tracker-based; DHT off keeps idle network/CPU low
    lsd: false,
    utp: false,
    downloadLimit: s.downloadLimitKBs > 0 ? s.downloadLimitKBs * 1024 : -1,
    uploadLimit: s.uploadLimitKBs > 0 ? s.uploadLimitKBs * 1024 : -1,
  });
  client.on('error', (err) => log.error('webtorrent client', String(err)));
  log('torrent client started');
  return client;
}

function maybeShutdownClient() {
  if (client && active.size === 0) {
    const c = client;
    client = null;
    c.destroy(() => log('torrent client stopped (idle)'));
  }
}

function setStatus(dl, status, error = null) {
  updStatus.run(status, error, dl.id);
  dl.status = status;
  broadcast('download', { id: dl.id, status, error });
}

export function listDownloads() {
  const rows = db.prepare(`SELECT * FROM downloads WHERE status != 'canceled' ORDER BY added_at DESC LIMIT 200`).all();
  for (const row of rows) {
    const a = active.get(row.info_hash);
    if (a?.torrent) {
      const t = a.torrent;
      row.progress = stat(t, 'progress');
      row.speed = stat(t, 'downloadSpeed');
      row.uploadSpeed = stat(t, 'uploadSpeed');
      row.peers = stat(t, 'numPeers');
      row.eta = row.speed > 0 ? (t.length - stat(t, 'downloaded')) / row.speed : null;
      row.ratio = stat(t, 'uploaded') / Math.max(1, stat(t, 'downloaded', 1));
    }
  }
  return rows;
}

// Enqueue a nyaa release. meta: { title, torrentUrl, infoHash, size, parsed, showTitle, anilistId, season, source }
export async function startDownload(meta) {
  const existing = meta.infoHash && getByHash.get(meta.infoHash.toLowerCase());
  if (existing && !['error', 'canceled'].includes(existing.status)) {
    return { ok: false, reason: 'already downloading or downloaded', id: existing.id };
  }

  const free = freeBytes();
  const need = Math.max((meta.size || 0) * 1.05, 2e9);
  if (free < need) {
    return { ok: false, reason: `not enough free space (${(free / 1e9).toFixed(0)} GB left)` };
  }

  const rec = {
    info_hash: meta.infoHash ? meta.infoHash.toLowerCase() : null,
    release_title: meta.title,
    show_title: meta.showTitle || null,
    anilist_id: meta.anilistId || null,
    season: meta.season || meta.parsed?.season || 1,
    episode: meta.parsed?.episode ?? null,
    group_name: meta.parsed?.group || null,
    quality: meta.parsed?.quality || null,
    torrent_url: meta.torrentUrl,
    size: meta.size || null,
    source: meta.source || 'manual',
    added_at: Date.now(),
  };
  let id;
  if (existing) {
    db.prepare(`UPDATE downloads SET status='queued', error=NULL, progress=0, added_at=? WHERE id=?`).run(Date.now(), existing.id);
    id = existing.id;
  } else {
    id = insertDl.run(rec).lastInsertRowid;
  }
  const dl = getById.get(id);
  broadcast('download', { id, status: 'queued', title: dl.release_title });
  attach(dl).catch((err) => {
    log.error('startDownload', String(err));
    setStatus(dl, 'error', String(err));
    maybeShutdownClient();
  });
  return { ok: true, id };
}

async function attach(dl) {
  const c = await getClient();
  const res = await fetch(dl.torrent_url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'torii/0.1' } });
  if (!res.ok) throw new Error(`torrent file fetch ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  await new Promise((resolve, reject) => {
    const torrent = c.add(buf, { path: incomingDir() }, (t) => {
      const hash = t.infoHash.toLowerCase();
      if (dl.info_hash && dl.info_hash !== hash) db.prepare('UPDATE downloads SET info_hash=? WHERE id=?').run(hash, dl.id);
      dl.info_hash = hash;
      active.set(hash, { torrent: t, dl });
      setStatus(dl, 'downloading');
      updProgress.run(stat(t, 'progress'), t.length, dl.id);

      let lastPush = 0;
      t.on('download', () => {
        const now = Date.now();
        if (now - lastPush > 1000) {
          lastPush = now;
          broadcast('progress', snapshot(t, dl));
          if (now % 5000 < 1200) updProgress.run(stat(t, 'progress'), t.length, dl.id);
        }
      });
      t.on('done', () => onDone(t, dl).catch(err => { log.error('onDone', String(err)); setStatus(dl, 'error', String(err)); }));
      t.on('error', (err) => { setStatus(dl, 'error', String(err)); active.delete(hash); maybeShutdownClient(); });
      t.on('warning', (err) => log.warn('torrent warning', dl.id, String(err)));
      resolve();
    });
    torrent.on?.('error', reject);
  });
}

// webtorrent's progress/downloaded getters can throw mid-download (completed pieces
// are nulled before the bitfield updates), so every stat read goes through this.
function stat(t, prop, fallback = 0) {
  try { const v = t[prop]; return Number.isFinite(v) ? v : fallback; } catch { return fallback; }
}

function snapshot(t, dl) {
  const speed = stat(t, 'downloadSpeed');
  return {
    id: dl.id, status: dl.status, progress: stat(t, 'progress'), speed,
    uploadSpeed: stat(t, 'uploadSpeed'), peers: stat(t, 'numPeers'),
    eta: speed > 0 ? (t.length - stat(t, 'downloaded')) / speed : null,
  };
}

async function onDone(t, dl) {
  setStatus(dl, 'moving');
  const paths = t.files.map(f => join(t.path, f.path));
  // Give the OS a beat to flush, then move files out of .incoming.
  await new Promise(r => setTimeout(r, 500));
  const finals = organizeDownload(dl, paths);
  updDone.run('seeding', Date.now(), JSON.stringify(finals), dl.id);
  dl.status = 'seeding';
  broadcast('download', { id: dl.id, status: 'seeding', finals });
  log('organized', dl.release_title, '->', finals.length, 'file(s)');

  const dir = finals[0] ? finals[0].slice(0, finals[0].lastIndexOf('/')) : null;
  scanLibrary(dir).then(r => {
    broadcast('download', { id: dl.id, status: 'seeding', plexScanned: r.ok });
  });

  // Keep watchlist bookkeeping in sync when a tracked show's episode lands.
  if (dl.anilist_id && dl.episode != null) {
    db.prepare(`UPDATE watchlist SET last_episode = MAX(last_episode, ?) WHERE anilist_id = ?`).run(dl.episode, dl.anilist_id);
  }

  // Seeding policy: library copy is a hardlink, so the torrent keeps seeding from
  // .incoming. Stop at ratio or max hours, whichever comes first. Settings are read
  // every tick so Setup changes apply to torrents that are already seeding.
  const startedSeeding = Date.now();
  let check;
  const evalSeed = () => {
    const { seedRatio, seedMaxHours } = getSettings();
    const ratio = stat(t, 'uploaded') / Math.max(1, stat(t, 'downloaded', 1));
    const hours = (Date.now() - startedSeeding) / 3600e3;
    if (seedRatio <= 0 || ratio >= seedRatio || hours >= seedMaxHours) {
      clearInterval(check);
      finishSeeding(t, dl);
      return true;
    }
    return false;
  };
  if (evalSeed()) return;
  check = setInterval(evalSeed, 60e3);
  check.unref();
  const a = active.get(dl.info_hash);
  if (a) a.seedTimer = check;
}

function finishSeeding(t, dl) {
  const hash = dl.info_hash;
  const root = join(t.path, t.name);
  // destroyStore removes the .incoming copies; the library hardlinks keep the data.
  t.destroy({ destroyStore: true }, () => {
    active.delete(hash);
    cleanupIncoming(root);
    if (dl.status !== 'error') {
      updStatus.run('done', null, dl.id);
      broadcast('download', { id: dl.id, status: 'done' });
    }
    maybeShutdownClient();
  });
}

export function cancelDownload(id) {
  const dl = getById.get(id);
  if (!dl) return { ok: false, reason: 'not found' };
  const a = dl.info_hash && active.get(dl.info_hash);
  if (a) {
    clearInterval(a.seedTimer);
    a.torrent.destroy({ destroyStore: true }, () => { active.delete(dl.info_hash); maybeShutdownClient(); });
  }
  if (['seeding', 'done'].includes(dl.status)) {
    // finished items: cancel just means "stop seeding", never delete library files
    updStatus.run('done', null, id);
    return { ok: true, status: 'done' };
  }
  updStatus.run('canceled', null, id);
  broadcast('download', { id, status: 'canceled' });
  return { ok: true, status: 'canceled' };
}

// Resume unfinished downloads after a restart. webtorrent re-checks existing pieces
// in .incoming so progress is preserved.
export function resumeUnfinished() {
  const rows = db.prepare(`SELECT * FROM downloads WHERE status IN ('queued','downloading','moving','seeding')`).all();
  for (const dl of rows) {
    // 'moving'/'seeding' rows still have their data hardlinked in .incoming; re-adding
    // verifies existing pieces, fires 'done', and organize is idempotent.
    log('resuming', dl.release_title, `(${dl.status})`);
    attach(dl).catch(err => setStatus(dl, 'error', String(err)));
  }
}

export function activeCount() { return active.size; }
