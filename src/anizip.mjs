import { cached } from './db.mjs';

// Episode metadata (titles, air dates, real-world numbering) from AniZip.
// The object key is AniList's per-entry index starting at 1, while
// episodeNumber matches how release groups actually number files - cour
// continuations keep counting (Mushoku Tensei Part 2 starts at 12), and
// absoluteEpisodeNumber covers franchises numbered from episode 1 forever.
export function episodeMeta(anilistId) {
  return cached('anizip:' + anilistId, 24 * 3600e3, async () => {
    const res = await fetch(`https://api.ani.zip/mappings?anilist_id=${anilistId}`, {
      headers: { 'User-Agent': 'torii (personal plex fetcher)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`anizip ${res.status}`);
    const body = await res.json();
    const episodes = [];
    for (const [key, e] of Object.entries(body.episodes || {})) {
      if (!/^\d+$/.test(key)) continue; // skip specials ("S1", ...)
      episodes.push({
        idx: Number(key),                                   // AniList-local index
        ep: e.episodeNumber ?? Number(key),                 // number groups put in filenames
        absolute: e.absoluteEpisodeNumber ?? null,
        title: e.title?.en || e.title?.['x-jat'] || null,
        airdate: e.airdate || null,
      });
    }
    episodes.sort((a, b) => a.idx - b.idx);
    return { count: body.episodeCount ?? episodes.length, episodes };
  });
}
