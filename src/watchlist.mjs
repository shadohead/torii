import { db, getSettings } from './db.mjs';
import { searchNyaa, titleMatches, baseTitle, seasonFromShowTitle } from './nyaa.mjs';
import { getAnime } from './anilist.mjs';
import { startDownload } from './torrents.mjs';
import { broadcast } from './sse.mjs';
import { log } from './log.mjs';

const listStmt = db.prepare('SELECT * FROM watchlist ORDER BY added_at DESC');
const getStmt = db.prepare('SELECT * FROM watchlist WHERE anilist_id = ?');

export function listWatchlist() { return listStmt.all(); }

function nyaaQuery(group, searchTitle, quality) {
  return `${group} ${searchTitle.replace(/[:!?,.']/g, ' ')} ${quality}`.replace(/\s+/g, ' ');
}

// Groups disagree on naming: SubsPlease uses romaji ("Tenmaku no Jaadugar"),
// ToonsHub uses English ("Sparks of Tomorrow"). Always try both bases.
function basesFor(show, fallback) {
  return [...new Set([
    baseTitle(show?.romaji || ''),
    baseTitle(show?.english || ''),
    baseTitle(fallback || ''),
  ].filter(b => b.length > 3))];
}

async function releasesForBases(group, bases, quality) {
  const byHash = new Map();
  for (const base of bases) {
    try {
      for (const r of await searchNyaa(nyaaQuery(group, base, quality), { ttl: 5 * 60e3 })) {
        if (r.infoHash && !byHash.has(r.infoHash)) byHash.set(r.infoHash, r);
      }
    } catch {}
  }
  return [...byHash.values()];
}

export async function addToWatchlist({ anilistId, group, quality }) {
  const show = await getAnime(anilistId);
  if (!show) throw new Error('unknown show');
  const title = show.english || show.romaji;
  // Baseline = the latest episode number this group has actually published on nyaa.
  // Groups often use absolute numbering (Re:Zero ep 77) while AniList counts
  // per-season (ep 11), so nyaa itself is the only trustworthy zero point.
  // Search by franchise base ("Mushoku Tensei", not "Mushoku Tensei III: Isekai
  // Ittara Honki Dasu") - that's what groups put in filenames.
  const bases = basesFor(show, title);
  const searchTitle = bases[0] || baseTitle(title);
  const season = seasonFromShowTitle(show.romaji || title);
  let latest = show.nextEp ? show.nextEp.ep - 1 : (show.episodes || 0);
  const releases = await releasesForBases(group, bases, quality);
  const pool = releases.filter(r =>
    r.parsed.group?.toLowerCase() === group.toLowerCase() && !r.parsed.batch &&
    r.parsed.episode != null && (r.parsed.season == null || r.parsed.season === season) &&
    bases.some(b => titleMatches(r.title, b)));
  // Prefer releases that explicitly mark this season ("S3 - 02") over unmarked
  // ones, so an old absolute-numbered stray can't inflate the baseline.
  const marked = pool.filter(r => r.parsed.season === season);
  const eps = (marked.length ? marked : pool).map(r => r.parsed.episode);
  if (eps.length) latest = Math.max(...eps);
  db.prepare(`
    INSERT INTO watchlist (anilist_id, title, search_title, poster, group_name, quality, auto, last_episode, season, episodes, next_ep, next_airing_at, show_status, added_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(anilist_id) DO UPDATE SET group_name=excluded.group_name, quality=excluded.quality, auto=1
  `).run(
    show.id, title, searchTitle, show.poster, group, quality,
    latest, season, show.episodes,
    show.nextEp?.ep ?? null, show.nextEp?.airsAt ?? null, show.status, Date.now()
  );
  broadcast('watchlist', { anilistId: show.id, action: 'added' });
  return getStmt.get(show.id);
}

export function removeFromWatchlist(anilistId) {
  db.prepare('DELETE FROM watchlist WHERE anilist_id = ?').run(anilistId);
  broadcast('watchlist', { anilistId, action: 'removed' });
}

export function setAuto(anilistId, auto) {
  db.prepare('UPDATE watchlist SET auto = ? WHERE anilist_id = ?').run(auto ? 1 : 0, anilistId);
}

// ---------- polling loop ----------

function checkIntervalMs(row, settings) {
  // Poll hard around the expected air time (fansubs land 15min-2h after broadcast),
  // lazily otherwise. Zero AniList traffic here - airing times come from the DB.
  if (row.next_airing_at) {
    const delta = Date.now() - row.next_airing_at;
    if (delta > -30 * 60e3 && delta < 4 * 3600e3) return settings.hotPollMinutes * 60e3;
  }
  return settings.pollMinutes * 60e3;
}

async function refreshAiringInfo(row) {
  // Once the known airing time passes, re-ask AniList for the next one.
  if (!row.next_airing_at || row.next_airing_at > Date.now() - 6 * 3600e3) return;
  const fresh = await getAnime(row.anilist_id, { fresh: true });
  if (!fresh) return;
  db.prepare('UPDATE watchlist SET next_ep = ?, next_airing_at = ?, episodes = ?, show_status = ? WHERE anilist_id = ?')
    .run(fresh.nextEp?.ep ?? null, fresh.nextEp?.airsAt ?? null, fresh.episodes, fresh.status, row.anilist_id);
}

export async function checkShow(row) {
  const show = await getAnime(row.anilist_id).catch(() => null);
  const bases = show ? basesFor(show, row.title) : [row.search_title];
  const releases = await releasesForBases(row.group_name, bases, row.quality);
  const freshCutoff = Date.now() - 14 * 86400e3; // airing episodes are always recent
  const candidates = releases.filter(r =>
    r.parsed.group && r.parsed.group.toLowerCase() === row.group_name.toLowerCase() &&
    (!r.parsed.quality || r.parsed.quality === row.quality) &&
    !r.parsed.batch &&
    r.parsed.episode != null && r.parsed.episode > row.last_episode &&
    (r.parsed.season == null || r.parsed.season === row.season) &&
    (!r.pubDate || r.pubDate > freshCutoff) &&
    bases.some(b => titleMatches(r.title, b))
  );

  // One release per episode (v2s and re-uploads share the number) - take the newest.
  const byEp = new Map();
  for (const c of candidates) {
    const prev = byEp.get(c.parsed.episode);
    if (!prev || (c.pubDate || 0) > (prev.pubDate || 0)) byEp.set(c.parsed.episode, c);
  }
  const picks = [...byEp.values()]
    .sort((a, b) => a.parsed.episode - b.parsed.episode)
    .slice(-3); // safety cap - normal case is exactly 1 new episode

  let grabbed = 0;
  for (const rel of picks) {
    const res = await startDownload({
      title: rel.title, torrentUrl: rel.torrentUrl, infoHash: rel.infoHash, size: rel.size,
      parsed: rel.parsed, showTitle: row.title, anilistId: row.anilist_id, season: row.season, source: 'watchlist',
    });
    if (res.ok) {
      grabbed++;
      log('watchlist grabbed', rel.title);
      broadcast('watchlist', { anilistId: row.anilist_id, action: 'grabbed', episode: rel.parsed.episode, title: rel.title });
      db.prepare('UPDATE watchlist SET last_episode = ? WHERE anilist_id = ?').run(rel.parsed.episode, row.anilist_id);
    }
  }
  db.prepare('UPDATE watchlist SET checked_at = ? WHERE anilist_id = ?').run(Date.now(), row.anilist_id);
  await refreshAiringInfo(row);
  return grabbed;
}

// Explicit historical sync. Adding a show starts at its current release so it
// only follows future episodes; this action intentionally queues every matching
// episode that Nyaa currently returns for the pinned group and quality.
export async function catchUpShow(row) {
  const show = await getAnime(row.anilist_id).catch(() => null);
  const bases = show ? basesFor(show, row.title) : [row.search_title];
  const releases = await releasesForBases(row.group_name, bases, row.quality);
  const candidates = releases.filter(r =>
    r.parsed.group && r.parsed.group.toLowerCase() === row.group_name.toLowerCase() &&
    (!r.parsed.quality || r.parsed.quality === row.quality) &&
    !r.parsed.batch && r.parsed.episode != null &&
    (r.parsed.season == null || r.parsed.season === row.season) &&
    bases.some(b => titleMatches(r.title, b))
  );

  // One best release per episode, so a v2 or re-upload cannot produce a
  // duplicate torrent. Keep all historical matches; unlike checkShow there is
  // deliberately no recency guard or three-episode safety cap.
  const byEp = new Map();
  for (const rel of candidates) {
    const prev = byEp.get(rel.parsed.episode);
    if (!prev || (rel.pubDate || 0) > (prev.pubDate || 0)) byEp.set(rel.parsed.episode, rel);
  }
  const picks = [...byEp.values()].sort((a, b) => a.parsed.episode - b.parsed.episode);
  let grabbed = 0;
  for (const rel of picks) {
    const res = await startDownload({
      title: rel.title, torrentUrl: rel.torrentUrl, infoHash: rel.infoHash, size: rel.size,
      parsed: rel.parsed, showTitle: row.title, anilistId: row.anilist_id, season: row.season, source: 'catch-up',
    });
    if (res.ok) grabbed++;
  }
  if (picks.length) {
    db.prepare('UPDATE watchlist SET last_episode = MAX(last_episode, ?), checked_at = ? WHERE anilist_id = ?')
      .run(Math.max(...picks.map(r => r.parsed.episode)), Date.now(), row.anilist_id);
  }
  broadcast('watchlist', { anilistId: row.anilist_id, action: 'catch-up', grabbed });
  return { ok: true, grabbed, found: picks.length };
}

let timer = null;
export function startScheduler() {
  const tick = async () => {
    try {
      const settings = getSettings();
      if (!settings.autoDownload) return;
      const rows = listStmt.all().filter(r => r.auto && r.show_status !== 'FINISHED');
      for (const row of rows) {
        if (Date.now() - row.checked_at < checkIntervalMs(row, settings)) continue;
        try { await checkShow(row); } catch (err) { log.warn('watchlist check failed', row.title, String(err)); }
        await new Promise(r => setTimeout(r, 3000)); // be polite to nyaa
      }
    } catch (err) { log.error('scheduler tick', String(err)); }
  };
  timer = setInterval(tick, 60e3);
  timer.unref();
  setTimeout(tick, 10e3).unref(); // first pass shortly after boot
  log('watchlist scheduler started');
}
