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

export function browse({ chart = 'trending', season, year, page = 1 } = {}) {
  const def = CHART_DEFS[chart];
  if (!def) throw new Error('unknown chart');
  page = Math.min(Math.max(1, Number(page) || 1), 40);
  const args = ['type: ANIME', 'isAdult: false', `sort: ${def.sort}`];
  if (def.status) args.push(`status: ${def.status}`);
  if (def.format) args.push(`format: ${def.format}`);
  if (def.seasonal) {
    if (!SEASONS.includes(season) || !/^\d{4}$/.test(String(year))) throw new Error('season and year required');
    args.push(`season: ${season}`, `seasonYear: ${Number(year)}`);
  }
  const key = `anilist:browse:${chart}:${season || ''}:${year || ''}:${page}`;
  return cached(key, 3 * 3600e3, async () => {
    const data = await gql(`query { Page(page: ${page}, perPage: 24) {
      pageInfo { hasNextPage }
      media(${args.join(', ')}) { ${MEDIA_FIELDS} }
    } }`);
    return { items: data.Page.media.map(slim), hasNext: data.Page.pageInfo.hasNextPage, page };
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
