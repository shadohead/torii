import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { libraryFile, normalizeSessions, PlaybackClock } from '../src/playback.mjs';
import { WatchTogether } from '../src/watch-together.mjs';
import { transcodeArgs } from '../containers/watch-together/transcode.mjs';

const session = (patch = {}) => ({ id: '1', playerId: 'tv', player: 'Downstairs', ratingKey: '101', file: '/anime/episode.mkv', title: 'Episode', state: 'playing', offset: 100, duration: 1200, audioTrack: 1, subtitleTrack: 1, ...patch });
function harness() {
  let settings = { watchTogetherEnabled: true, watchTogetherPlayerId: 'tv', watchTogetherOffsetSeconds: 0, watchTogetherToken: '' };
  let sessions = [session()], now = 0, fail = false;
  const together = new WatchTogether({ getSettings: () => settings, setSettings: patch => { settings = { ...settings, ...patch }; }, readSessions: async () => { if (fail) throw new Error('Plex offline'); return sessions; }, now: () => now });
  return { together, advance: n => { now += n; }, sessions: values => { sessions = values; }, fail: () => { fail = true; } };
}

test('unchanged Plex progress advances without repeated backward seeks; fresh seeks re-anchor', () => {
  const clock = new PlaybackClock(), s = session();
  assert.equal(clock.sample(s, 0).position, 100);
  assert.equal(clock.sample(s, 5000).position, 105);
  assert.equal(clock.sample({ ...s, offset: 104 }, 6000).position, 104);
  assert.equal(clock.sample({ ...s, offset: 500 }, 7000).position, 500);
  assert.equal(clock.sample({ ...s, offset: 10 }, 8000).position, 10);
});
test('pauses and buffering freeze position, resume and episode change reset the clock', () => {
  const clock = new PlaybackClock(), s = session();
  clock.sample(s, 0);
  assert.equal(clock.sample({ ...s, state: 'paused' }, 2000).position, 100);
  assert.equal(clock.sample({ ...s, state: 'paused' }, 12000).position, 100);
  assert.equal(clock.sample({ ...s, state: 'buffering' }, 13000).position, 100);
  assert.equal(clock.sample(s, 14000).position, 100);
  assert.equal(clock.sample({ ...s, file: '/anime/next.mkv', offset: 0 }, 15000).position, 0);
});
test('stale progress fails closed and duration clamps extrapolation', () => {
  const clock = new PlaybackClock(), s = session({ offset: 1199 });
  clock.sample(s, 0);
  assert.equal(clock.sample(s, 5000).position, 1200);
  assert.equal(clock.sample(s, 31000).stale, true);
  assert.equal(clock.sample({ ...s, offset: 1200 }, 32000).stale, false);
});
test('realpath library containment rejects sibling paths, symlink escapes, missing files and directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'torii-path-test-'));
  try {
    const library = join(root, 'Anime'), sibling = join(root, 'AnimeOther');
    mkdirSync(library); mkdirSync(sibling);
    const file = join(library, 'episode.mkv'), outside = join(sibling, 'secret');
    writeFileSync(file, 'media'); writeFileSync(outside, 'private');
    symlinkSync(outside, join(library, 'escape.mkv'));
    assert.equal(libraryFile(file, library), true);
    for (const path of [outside, join(library, 'escape.mkv'), library, join(library, 'missing'), 'relative.mkv']) assert.equal(libraryFile(path, library), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('Plex normalization selects the active media, converts tracks and excludes unrelated/multipart media', () => {
  const item = { type: 'episode', sessionKey: '2', ratingKey: '4', title: 'Pilot', grandparentTitle: 'Anime', viewOffset: 12345, duration: 60000, Player: { machineIdentifier: 'tv', title: 'Downstairs', state: 'paused' }, User: { title: 'Viewer' }, Media: [
    { Part: [{ file: '/wrong' }] },
    { selected: '1', Part: [{ file: '/anime/ep.mkv', Stream: [
      { streamType: 2 }, { streamType: 2, selected: 1 }, { streamType: 3, selected: '1' },
    ] }] },
  ] };
  const body = { MediaContainer: { Metadata: [item, { ...item, type: 'track' }, { ...item, Player: { ...item.Player, state: 'stopped' } }, { ...item, Media: [{ Part: [{ file: '/anime/ep.mkv' }, { file: '/anime/ep2.mkv' }] }] }] } };
  const normalized = normalizeSessions(body, '/anime', file => file.startsWith('/anime/'));
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].offset, 12.345);
  assert.equal(normalized[0].audioTrack, 2);
  assert.equal(normalized[0].subtitleTrack, 1);
  assert.equal(normalized[0].playerId, 'tv');
});
test('only the selected TV follows; bridge exposes no file paths or Plex credentials', async () => {
  const h = harness(); h.sessions([session({ playerId: 'other' }), session()]);
  const result = await h.together.bridge();
  assert.equal(result.session.playerId, 'tv');
  assert.equal(result.session.position, 100);
  assert.equal('file' in result.session, false);
  assert.equal(JSON.stringify(result).includes('/anime/'), false);
});
test('pauses, next episodes, stop, duplicate sessions and Plex outages reach the correct states', async () => {
  const h = harness();
  await h.together.refresh();
  h.sessions([session({ state: 'paused', offset: 105 })]);
  assert.equal((await h.together.bridge()).session.position, 105);
  h.sessions([session({ ratingKey: '102', file: '/anime/next.mkv', offset: 0 })]);
  assert.equal((await h.together.bridge()).session.position, 0);
  h.sessions([]); assert.equal((await h.together.refresh()).state, 'waiting');
  h.sessions([session(), session({ id: '2' })]);
  assert.equal((await h.together.refresh()).state, 'error');
  assert.equal(h.together.session, null);
  h.fail(); assert.equal((await h.together.bridge()).session, null);
});
test('a missing fresh progress report cannot continue serving the episode', async () => {
  const h = harness(); await h.together.refresh(); h.advance(31000);
  const result = await h.together.bridge();
  assert.equal(result.state, 'error'); assert.equal(result.session, null);
  h.sessions([session({ offset: 132 })]); assert.equal((await h.together.refresh()).state, 'following');
});
test('configuration validates before saving and disabled sync serves no session', async () => {
  const h = harness();
  for (const invalid of [{ enabled: true, playerId: '' }, { enabled: 'true', playerId: 'tv' }, { enabled: true, playerId: 'tv', offsetSeconds: '1' }, { enabled: true, playerId: 'tv', offsetSeconds: Infinity }, { enabled: true, playerId: 'tv', offsetSeconds: 31 }]) assert.throws(() => h.together.configure(invalid));
  h.together.configure({ enabled: true, playerId: 'tv', offsetSeconds: 3 });
  assert.equal((await h.together.bridge()).session.position, 103);
  h.together.configure({ enabled: false, playerId: 'tv' });
  assert.equal((await h.together.bridge()).session, null);
});
test('bridge tokens are scoped bearer credentials, stable, and absent from public status', () => {
  const h = harness(), token = h.together.token();
  assert.equal(token.length, 64); assert.equal(h.together.token(), token);
  assert.equal(h.together.authorized('Bearer ' + token), true);
  for (const invalid of [undefined, token, 'Bearer ', 'Bearer ' + 'x'.repeat(64)]) assert.equal(h.together.authorized(invalid), false);
  assert.equal(JSON.stringify(h.together.status()).includes(token), false);
});
test('configuration changed during an in-flight Plex request uses the latest TV selection', async () => {
  let complete;
  let settings = { watchTogetherEnabled: true, watchTogetherPlayerId: 'tv', watchTogetherOffsetSeconds: 0 };
  const together = new WatchTogether({ getSettings: () => settings, setSettings: patch => { settings = { ...settings, ...patch }; }, readSessions: () => new Promise(resolve => { complete = resolve; }) });
  const pending = together.refresh();
  together.configure({ enabled: false, playerId: 'tv' });
  complete([session()]);
  assert.equal((await pending).session, null);
  assert.equal(together.state, 'disabled');
});
test('container status expires and never claims verified Discord Go Live', () => {
  const h = harness(); h.together.heartbeat({ state: 'following' });
  assert.equal(h.together.status().companion.state, 'following');
  assert.equal('discordLive' in h.together.status(), false);
  h.advance(15001); assert.equal(h.together.status().companion, null);
});
test('encoder burns subtitles at the TV timeline after a seek and selects the matching audio', () => {
  const args = transcodeArgs('/tmp/episode.mkv', '/tmp/hls', session({ audioTrack: 2, subtitleTrack: 3 }), 123);
  const filter = args[args.indexOf('-vf') + 1];
  assert.ok(filter.indexOf('setpts=PTS+123/TB') < filter.indexOf('subtitles='));
  assert.ok(filter.indexOf('setpts=PTS-STARTPTS') > filter.indexOf('subtitles='));
  assert.ok(filter.includes('si=2')); assert.ok(args.includes('0:a:1?'));
  const without = transcodeArgs('/tmp/episode.mkv', '/tmp/hls', session({ subtitleTrack: 'no' }), 0);
  assert.equal(without[without.indexOf('-vf') + 1].includes('subtitles='), false);
});
