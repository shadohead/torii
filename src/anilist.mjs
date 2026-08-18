import { cached } from './db.mjs';
import { log } from './log.mjs';

const API = 'https://graphql.anilist.co';

const MEDIA_FIELDS = `
  id
  title { romaji english native }
  coverImage { extraLarge color }
  bannerImage
  description(asHtml: false)
  episodes
  nextAiringEpisode { episode airingAt }
  averageScore
  popularity
  seasonYear
  format
  status
  genres
`;

async function gql(query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') || 5);
    log.warn(`anilist: rate limited, waiting ${wait}s`);
    await new Promise(r => setTimeout(r, wait * 1000));
    return gql(query, variables);
  }
  if (!res.ok) throw new Error(`AniList ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error('AniList: ' + body.errors[0].message);
  return body.data;
}

function slim(m) {
  return {
    id: m.id,
    romaji: m.title.romaji,
    english: m.title.english,
    native: m.title.native,
    poster: m.coverImage?.extraLarge || null,
    color: m.coverImage?.color || null,
    banner: m.bannerImage || null,
    synopsis: m.description ? m.description.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 500) : null,
    episodes: m.episodes,
    score: m.averageScore,
    year: m.seasonYear,
    format: m.format,
    status: m.status,
    genres: (m.genres || []).slice(0, 3),
    nextEp: m.nextAiringEpisode
      ? { ep: m.nextAiringEpisode.episode, airsAt: m.nextAiringEpisode.airingAt * 1000 }
      : null,
  };
}

export function home() {
  return cached('anilist:home', 6 * 3600e3, async () => {
    const data = await gql(`query {
      airing: Page(perPage: 14) { media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC, format: TV) { ${MEDIA_FIELDS} } }
      trending: Page(perPage: 18) { media(type: ANIME, sort: TRENDING_DESC) { ${MEDIA_FIELDS} } }
    }`);
    const airing = data.airing.media.map(slim);
    const seen = new Set(airing.map(m => m.id));
    const trending = data.trending.media.map(slim).filter(m => !seen.has(m.id));
    return { airing, trending };
  });
}

// MAL-style charts. Definitions live server-side so the API surface stays constrained.
const CHART_DEFS = {
  trending: { sort: 'TRENDING_DESC' },
  popular: { sort: 'POPULARITY_DESC' },
  'top-rated': { sort: 'SCORE_DESC' },
  upcoming: { sort: 'POPULARITY_DESC', status: 'NOT_YET_RELEASED' },
  movies: { sort: 'SCORE_DESC', format: 'MOVIE' },
  season: { sort: 'POPULARITY_DESC', seasonal: true },
  'season-rated': { sort: 'SCORE_DESC', seasonal: true },
};
const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

// Day-of-year each AniList season opens, as the MMDD half of a FuzzyDateInt.
const SEASON_START = { WINTER: 101, SPRING: 401, SUMMER: 701, FALL: 1001 };

// AniList degrades under bursts - responses stretch to tens of seconds and
// pages start coming back empty even though the previous page promised more -
// so a chart is worth one request, not one per page. A single document carries
// every page of every list as an alias, and a promised page that arrives empty
// is retried rather than believed: swallowing it silently truncates the chart
// and then caches the truncated version for hours.
async function fetchLists(lists, { perPage = 50, rounds = 3 } = {}) {
  const out = Object.fromEntries(lists.map(l => [l.key, []]));
  let cursors = lists.map(l => ({ maxPages: l.pages * rounds, ...l, next: 1 }));
  for (let round = 0; round < rounds && cursors.length; round++) {
    const slots = cursors.flatMap((c, ci) => Array.from({ length: c.pages }, (_, i) => ({
      key: c.key, args: c.args, alias: `q${ci}_${i}`, page: c.next + i,
    })));
    const query = `query { ${slots.map(s => `${s.alias}: Page(page: ${s.page}, perPage: ${perPage}) {
      pageInfo { hasNextPage }
      media(${s.args.join(', ')}) { ${MEDIA_FIELDS} }
    }`).join('\n')} }`;

    let data;
    for (let attempt = 0; ; attempt++) {
      data = await gql(query);
      const cheated = slots.some((s, i) => !data[s.alias].media.length
        && i > 0 && slots[i - 1].key === s.key && data[slots[i - 1].alias].pageInfo.hasNextPage);
      if (!cheated || attempt >= 2) break;
      log.warn('anilist: a promised page came back empty, retrying');
      await new Promise(r => setTimeout(r, 1500));
    }

    const exhausted = new Set();
    for (const s of slots) {
      if (exhausted.has(s.key)) continue;
      const pg = data[s.alias];
      out[s.key].push(...pg.media);
      if (!pg.pageInfo.hasNextPage || !pg.media.length) exhausted.add(s.key);
    }
    cursors = cursors.filter(c => !exhausted.has(c.key))
      .map(c => ({ ...c, next: c.next + c.pages }))
      .filter(c => c.next + c.pages - 1 <= c.maxPages);
  }
  return out;
}

// AniList's season filter matches a show's *premiere* season, so a split-cour
// continuation or a long-runner airing straight through the season never shows
// up in it - One Piece, a Spring sequel still on air in Summer, and so on. MAL
// lists those under "Continuing"; fetch them as a second list instead of
// silently dropping them. Seasons are small enough (~100 premieres) to
// materialise whole in one request, which also lets the client page instantly
// and tell the reader how many entries are still below the fold.
function seasonChart(chart, def, season, year) {
  if (!SEASONS.includes(season) || !/^\d{4}$/.test(String(year))) throw new Error('season and year required');
  year = Number(year);
  const key = `anilist:season:${chart}:${season}:${year}`;
  return cached(key, 3 * 3600e3, async () => {
    const base = ['type: ANIME', 'isAdult: false'];
    const start = year * 10000 + SEASON_START[season];
    const carryArgs = [...base, 'sort: POPULARITY_DESC', 'format_in: [TV, TV_SHORT, ONA, OVA]',
      `startDate_lesser: ${start}`];
    const { premieres, stillAiring, endedLater } = await fetchLists([
      { key: 'premieres', pages: 3, args: [...base, `sort: ${def.sort}`, `season: ${season}`, `seasonYear: ${year}`] },
      // The two carryover filters are the expensive ones on AniList's side, and
      // past their first page they turn slow and flaky (tens of seconds, empty
      // results). One page of each, popularity-first, still reaches every title
      // anyone would recognise, so stop there.
      // Started earlier and never stopped - covers entries with no end date.
      { key: 'stillAiring', pages: 1, maxPages: 1, args: [...carryArgs, 'status: RELEASING'] },
      // Started earlier and ran at least into this season.
      { key: 'endedLater', pages: 1, maxPages: 1, args: [...carryArgs, `endDate_greater: ${start}`] },
    ]);

    const seen = new Set(premieres.map(m => m.id));
    const carryover = [];
    for (const m of [...stillAiring, ...endedLater]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      carryover.push(m);
    }
    carryover.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    return { items: premieres.map(slim), carryover: carryover.map(slim), hasNext: false, page: 1 };
  });
}

export function browse({ chart = 'trending', season, year, page = 1 } = {}) {
  const def = CHART_DEFS[chart];
  if (!def) throw new Error('unknown chart');
  if (def.seasonal) return seasonChart(chart, def, season, year);
  const LAST_PAGE = 40;
  page = Math.min(Math.max(1, Number(page) || 1), LAST_PAGE);
  const args = ['type: ANIME', 'isAdult: false', `sort: ${def.sort}`];
  if (def.status) args.push(`status: ${def.status}`);
  if (def.format) args.push(`format: ${def.format}`);
  const key = `anilist:browse:${chart}:${page}`;
  return cached(key, 3 * 3600e3, async () => {
    const data = await gql(`query { Page(page: ${page}, perPage: 24) {
      pageInfo { hasNextPage }
      media(${args.join(', ')}) { ${MEDIA_FIELDS} }
    } }`);
    // Past the cap the request would be clamped back to LAST_PAGE, so stop
    // offering more rather than handing out the same page again.
    const hasNext = page < LAST_PAGE && data.Page.pageInfo.hasNextPage;
    return { items: data.Page.media.map(slim), carryover: [], hasNext, page };
  });
}

export function searchAnime(q) {
  return cached('anilist:search:' + q.toLowerCase(), 24 * 3600e3, async () => {
    const data = await gql(
      `query ($q: String) { Page(perPage: 12) { media(type: ANIME, search: $q) { ${MEDIA_FIELDS} } } }`, { q });
    return data.Page.media.map(slim);
  });
}

export function getAnime(id, { fresh = false } = {}) {
  const fetcher = async () => {
    const data = await gql(`query ($id: Int) { Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} } }`, { id: Number(id) });
    return slim(data.Media);
  };
  if (fresh) return fetcher().catch(err => { log.warn('anilist getAnime fresh failed', String(err)); return null; });
  return cached('anilist:media:' + id, 12 * 3600e3, fetcher);
}
