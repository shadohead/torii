import { cached } from './db.mjs';

const BASE = 'https://nyaa.si';

// ---------- release name parsing (anitomy-lite) ----------

const QUALITY_RE = /\b(2160p|1080p|720p|480p)\b/i;
const ROMAN_SEASONS = { ii: 2, iii: 3, iv: 4, v: 5 };

export function parseRelease(title) {
  const out = { group: null, quality: null, season: null, episode: null, batch: null, version: null };
  const g = title.match(/^\[([^\]]+)\]/);
  if (g) out.group = g[1].trim();

  const q = title.match(QUALITY_RE);
  if (q) out.quality = q[1].toLowerCase();

  // strip bracket/paren groups for cleaner episode matching, but keep their text for batch detection
  const plain = title.replace(/^\[[^\]]+\]\s*/, '');

  // batch: "(01-12)", "(01~12)", "[Batch]", "1-12 Complete"
  const range = plain.match(/\(?\b(\d{1,4})\s*[-~]\s*(\d{1,4})\)?(?=[^\d]|$)/);
  const looksBatch = /\b(batch|complete|season\s*\d+\s*$)\b/i.test(plain);
  if (range && (looksBatch || /\((\d{1,4})\s*[-~]\s*(\d{1,4})\)/.test(plain))) {
    const from = Number(range[1]), to = Number(range[2]);
    if (to > from && to - from < 500 && !(from >= 1900 && from <= 2100)) out.batch = { from, to };
  } else if (looksBatch) {
    out.batch = { from: null, to: null };
  }

  // season
  const sx = plain.match(/\bS(\d{1,2})(?:E\d{1,4})?\b/i) || plain.match(/\bSeason\s*(\d{1,2})\b/i) || plain.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i);
  if (sx) out.season = Number(sx[1]);
  else {
    const roman = plain.match(/\s(II|III|IV|V)(?:\s|$|[:\-])/);
    if (roman) out.season = ROMAN_SEASONS[roman[1].toLowerCase()] || null;
  }

  if (!out.batch) {
    // episode patterns, most specific first
    const sxe = plain.match(/\bS(\d{1,2})E(\d{1,4})\b/i);
    const dash = plain.match(/\s-\s(\d{1,4})(?:\.(\d))?(?:v(\d))?\b(?!\s*[-~]\s*\d)/);
    const ep = plain.match(/\b(?:E|EP|Episode)\s?(\d{1,4})\b/i);
    const m = sxe ? { season: Number(sxe[1]), ep: Number(sxe[2]) }
      : dash ? { ep: Number(dash[1]) + (dash[2] ? Number('0.' + dash[2]) : 0), version: dash[3] ? Number(dash[3]) : null }
      : ep ? { ep: Number(ep[1]) }
      : null;
    if (m) {
      out.episode = m.ep;
      if (m.season) out.season = m.season;
      if (m.version) out.version = m.version;
    }
  }
  return out;
}

// ---------- RSS ----------

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#34;': '"', '&#39;': "'", '&apos;': "'" };
const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|apos|#34|#39);/g, (m) => ENTITIES[m]);

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? decode(m[1]) : null;
}

export function sizeToBytes(s) {
  const m = (s || '').match(/([\d.]+)\s*(TiB|GiB|MiB|KiB|B)/i);
  if (!m) return 0;
  const mult = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}

async function fetchRss(q, sort) {
  const url = `${BASE}/?page=rss&q=${encodeURIComponent(q)}&c=1_2&f=0` + (sort ? `&s=${sort}&o=desc` : '');
  const res = await fetch(url, { headers: { 'User-Agent': 'torii/0.1 (personal plex fetcher)' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`nyaa ${res.status}`);
  const xml = await res.text();
  const items = [];
  for (const block of xml.split('<item>').slice(1)) {
    const title = tag(block, 'title');
    if (!title) continue;
    items.push({
      title,
      torrentUrl: tag(block, 'link'),
      viewUrl: tag(block, 'guid'),
      pubDate: new Date(tag(block, 'pubDate') || 0).getTime(),
      seeders: Number(tag(block, 'nyaa:seeders') || 0),
      leechers: Number(tag(block, 'nyaa:leechers') || 0),
      downloads: Number(tag(block, 'nyaa:downloads') || 0),
      infoHash: tag(block, 'nyaa:infoHash'),
      sizeText: tag(block, 'nyaa:size'),
      size: sizeToBytes(tag(block, 'nyaa:size')),
      trusted: tag(block, 'nyaa:trusted') === 'Yes',
      parsed: parseRelease(title),
    });
  }
  return items;
}

export function searchNyaa(q, { ttl = 10 * 60e3, sort = null } = {}) {
  return cached(`nyaa:${sort || 'date'}:${q.toLowerCase()}`, ttl, () => fetchRss(q, sort));
}

// Strip season/part designators so nyaa search terms match how groups name releases
// (SubsPlease writes "Re Zero ... - 77", never "4th Season").
export function stripSeason(title) {
  const clean = title.replace(/[:!?,.']/g, ' ').replace(/\s+/g, ' ').trim();
  const stripped = clean
    .replace(/\b(\d+(?:st|nd|rd|th)\s+Season|Season\s+\d+|Part\s+\d+|S\d+|Final Season)\b/gi, '')
    .replace(/\s+(II|III|IV|V)$/i, '')
    .replace(/\s+/g, ' ').trim();
  return stripped.length > 3 ? stripped : clean;
}

// Season number from an AniList-style title ("Season 3", "4th Season", mid-title "III").
export function seasonFromShowTitle(title) {
  if (!title) return 1;
  const m = title.match(/\bSeason\s+(\d{1,2})\b/i) || title.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i);
  if (m) return Number(m[1]);
  const roman = title.match(/\s(II|III|IV|V)\b/);
  if (roman) return { II: 2, III: 3, IV: 4, V: 5 }[roman[1]];
  return 1;
}

// Franchise base title: subtitle after ": " dropped (the space matters - "Re:Zero"
// survives), season designators stripped. "Mushoku Tensei III: Isekai Ittara Honki
// Dasu" -> "Mushoku Tensei", which is what release groups actually put in filenames.
export function baseTitle(title) {
  if (!title) return '';
  const head = title.split(': ')[0];
  const candidate = head.split(/\s+/).length >= 2 ? head : title;
  return stripSeason(candidate.replace(/\s+(II|III|IV|V)$/, ''));
}

export function searchVariants(show) {
  const titles = [show.romaji, show.english].filter(Boolean);
  const season = seasonFromShowTitle(show.romaji || show.english || '');
  const variants = new Set();
  for (const t of titles) {
    variants.add(t.replace(/[:!?,.']/g, ' ').replace(/\s+/g, ' ').trim());
    variants.add(stripSeason(t));
  }
  const base = baseTitle(show.romaji || show.english || '');
  if (base) {
    variants.add(base);
    if (season > 1) variants.add(`${base} S${season}`); // SubsPlease-style sequel naming
  }
  return [...variants].filter(Boolean).slice(0, 5);
}

// Merged, deduped release search for a show.
export async function releasesForShow(show) {
  const variants = searchVariants(show);
  const settled = await Promise.allSettled(variants.map(v => searchNyaa(v)));
  const byHash = new Map();
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) if (item.infoHash && !byHash.has(item.infoHash)) byHash.set(item.infoHash, item);
  }
  const items = [...byHash.values()];
  items.sort((a, b) => (b.parsed.episode ?? -1) - (a.parsed.episode ?? -1) || b.seeders - a.seeders);
  return items;
}

// Targeted per-episode search (hayase-style). The general show pool only sees
// nyaa's ~75 newest matches, which for older shows is all batches - so each
// episode gets its own seeder-sorted queries with the number attached.
// `numbers` holds every numbering the episode is known by (seasonal, cour
// continuation, absolute), any of which may appear in filenames.
export async function releasesForEpisode(show, numbers) {
  const season = seasonFromShowTitle(show.romaji || show.english || '');
  const pad = (n) => String(n).padStart(2, '0');
  const titles = new Set([show.romaji, show.english].filter(Boolean).map(stripSeason));
  // The franchise base is how groups actually name files ("Mushoku Tensei - 14",
  // never the full subtitle), so it goes in every per-episode query.
  const base = baseTitle(show.romaji || show.english || '');
  if (base) titles.add(base);
  if (base && season > 1) titles.add(`${base} S${season}`);
  const queries = [];
  for (const t of titles) for (const n of numbers) queries.push(`${t} ${pad(n)}`);
  const settled = await Promise.allSettled(
    queries.slice(0, 6).map(q => searchNyaa(q, { ttl: 60 * 60e3, sort: 'seeders' })));
  const byHash = new Map();
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      if (!item.infoHash || byHash.has(item.infoHash)) continue;
      const p = item.parsed;
      if (p.batch || p.episode == null || !numbers.includes(p.episode)) continue;
      if (p.season != null && p.season !== season) continue;
      if (![...titles].some(t => titleMatches(item.title, t))) continue;
      byHash.set(item.infoHash, item);
    }
  }
  return [...byHash.values()].sort((a, b) => b.seeders - a.seeders);
}

// Loose token match so auto-download doesn't grab a different show that shares words.
export function titleMatches(releaseTitle, searchTitle) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 1);
  const hay = new Set(norm(releaseTitle));
  const tokens = norm(searchTitle);
  if (!tokens.length) return false;
  const hits = tokens.filter(t => hay.has(t)).length;
  return hits / tokens.length >= 0.7;
}
