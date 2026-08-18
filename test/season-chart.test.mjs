import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'torii-season-chart-'));
process.env.TORII_DATA_DIR = join(root, 'data');
process.env.TORII_LIBRARY_DIR = join(root, 'library');
mkdirSync(process.env.TORII_LIBRARY_DIR, { recursive: true });

const { db } = await import('../src/db.mjs');
const anilist = await import('../src/anilist.mjs');

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  db.close();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => db.exec('DELETE FROM api_cache'));

const media = (id, popularity) => ({
  id,
  title: { romaji: `Show ${id}`, english: `Show ${id}`, native: `作品 ${id}` },
  coverImage: { extraLarge: `poster-${id}`, color: '#000' },
  bannerImage: null,
  description: null,
  episodes: 12,
  nextAiringEpisode: null,
  averageScore: 70,
  popularity,
  seasonYear: 2026,
  format: 'TV',
  status: 'RELEASING',
  genres: [],
});

// Pulls the aliased Page queries back out of the document the module builds, so
// the fake can answer each one the way AniList would.
function parseSlots(query) {
  const slots = [];
  const re = /(q\d+_\d+): Page\(page: (\d+), perPage: (\d+)\) \{[\s\S]*?media\(([^)]*)\)/g;
  for (const m of query.matchAll(re)) {
    slots.push({ alias: m[1], page: Number(m[2]), perPage: Number(m[3]), args: m[4] });
  }
  return slots;
}

// `lists` maps a list name to the ids AniList would hold for it; `glitch` names
// the (list, page) pairs that come back empty the first time they are asked for.
function fakeAniList(lists, { glitch = [] } = {}) {
  const calls = [];
  const burned = new Set();
  globalThis.fetch = async (_url, opts) => {
    const query = JSON.parse(opts.body).query;
    const data = {};
    for (const slot of parseSlots(query)) {
      const list = slot.args.includes('season:') ? 'premieres'
        : slot.args.includes('endDate_greater') ? 'endedLater' : 'stillAiring';
      calls.push({ list, page: slot.page });
      const ids = lists[list] || [];
      const from = (slot.page - 1) * slot.perPage;
      const key = `${list}:${slot.page}`;
      const glitched = glitch.includes(key) && !burned.has(key);
      if (glitched) burned.add(key);
      data[slot.alias] = {
        pageInfo: { hasNextPage: ids.length > from + slot.perPage },
        media: glitched ? [] : ids.slice(from, from + slot.perPage).map(id => media(id, 1000 - id)),
      };
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return calls;
}

const ids = (n, offset = 0) => Array.from({ length: n }, (_, i) => offset + i + 1);

test('a season carries over shows that premiered earlier, without duplicating its own', async () => {
  fakeAniList({
    premieres: ids(60),
    stillAiring: [55, 56, 500, 501],   // 55 and 56 also premiered this season
    endedLater: [501, 502],            // 501 also came back as still airing
  });

  const res = await anilist.browse({ chart: 'season', season: 'SUMMER', year: 2026 });

  assert.equal(res.items.length, 60);
  assert.equal(res.hasNext, false, 'a materialised season has nothing left to fetch');
  assert.deepEqual(res.carryover.map(m => m.id), [500, 501, 502],
    'carryover drops this season\'s own premieres and is popularity-ordered');
});

test('carryover queries stop at their first page', async () => {
  const calls = fakeAniList({
    premieres: ids(60),
    stillAiring: ids(200, 1000),
    endedLater: ids(200, 2000),
  });

  const res = await anilist.browse({ chart: 'season', season: 'SUMMER', year: 2026 });

  // Past page one these filters turn slow and flaky on AniList's side.
  assert.deepEqual(calls.filter(c => c.list === 'stillAiring').map(c => c.page), [1]);
  assert.deepEqual(calls.filter(c => c.list === 'endedLater').map(c => c.page), [1]);
  assert.equal(res.carryover.length, 100);
});

test('a promised page that comes back empty is retried, not taken as the end', async () => {
  const calls = fakeAniList({
    premieres: ids(120),
    stillAiring: [],
    endedLater: [],
  }, { glitch: ['premieres:2'] });

  const res = await anilist.browse({ chart: 'season', season: 'SUMMER', year: 2026 });

  assert.equal(res.items.length, 120, 'the tail of the season survives the empty page');
  assert.ok(calls.filter(c => c.list === 'premieres' && c.page === 2).length > 1, 'page 2 was asked for again');
});

test('a season that genuinely ends on a short page is not retried', async () => {
  const calls = fakeAniList({ premieres: ids(70), stillAiring: [], endedLater: [] });

  const res = await anilist.browse({ chart: 'season', season: 'SUMMER', year: 2026 });

  assert.equal(res.items.length, 70);
  assert.equal(calls.filter(c => c.list === 'premieres').length, 3, 'one round of three pages, no retry');
});

test('non-seasonal charts still page against AniList and carry no continuing list', async () => {
  globalThis.fetch = async (_url, opts) => {
    assert.match(JSON.parse(opts.body).query, /sort: TRENDING_DESC/);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { Page: { pageInfo: { hasNextPage: true }, media: ids(24).map(id => media(id, id)) } } }),
    };
  };

  const res = await anilist.browse({ chart: 'trending', page: 2 });

  assert.equal(res.items.length, 24);
  assert.equal(res.hasNext, true);
  assert.deepEqual(res.carryover, []);

  // The last page the server will serve must not advertise another one, or the
  // client keeps asking and gets the same page clamped back at it.
  const last = await anilist.browse({ chart: 'trending', page: 99 });
  assert.equal(last.page, 40);
  assert.equal(last.hasNext, false);
});

test('bad chart arguments are rejected before any request goes out', () => {
  globalThis.fetch = () => assert.fail('should not have reached AniList');
  assert.throws(() => anilist.browse({ chart: 'season', year: 2026 }), /season and year required/);
  assert.throws(() => anilist.browse({ chart: 'season', season: 'SUMMER', year: 'soon' }), /season and year required/);
  assert.throws(() => anilist.browse({ chart: 'nonsense' }), /unknown chart/);
});
