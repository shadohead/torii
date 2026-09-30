import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackIndicators, clockTime } from '../containers/watch-together/indicators.mjs';

const status = (position = 120, state = 'playing', changes = {}) => ({
  state: 'following', playlist: '/hls/1/index.m3u8',
  session: { id: 'tv-session', mediaId: 'episode-7', show: 'Example anime', season: 1, episode: 7, position, state },
  ...changes,
});
test('source pause and buffering stay visible, then clear on normal TV playback', () => {
  const indicators = new PlaybackIndicators();
  indicators.update(status(120, 'paused'), 0);
  assert.equal(indicators.view(1000).state.title, 'Paused on TV');
  assert.equal(indicators.view(1000).state.episode.elapsed, '2:00');
  indicators.update(status(120, 'buffering'), 1000);
  assert.equal(indicators.view(1000).state.title, 'TV is buffering');
  indicators.update(status(120), 2000);
  assert.equal(indicators.view(2000).state, null);
  assert.equal(indicators.view(2000).notice, null);
});
test('unavailable, loading and stale TV data produce clear persistent indicators', () => {
  const indicators = new PlaybackIndicators();
  assert.equal(indicators.view(0).state.title, 'Connecting…');
  indicators.update({ state: 'waiting' }, 0);
  assert.equal(indicators.view(0).state.title, 'Waiting for the TV');
  indicators.update(status(120, 'playing', { state: 'loading', playlist: null }), 1000);
  assert.equal(indicators.view(1000).state.title, 'Loading episode…');
  indicators.update(status(120, 'paused', { state: 'loading', playlist: null }), 2000);
  assert.equal(indicators.view(2000).state.title, 'Paused on TV');
  assert.match(indicators.view(2000).state.detail, /Loading the paused episode/);
  indicators.update({ state: 'error', error: 'Plex is unreachable.' }, 3000);
  assert.equal(indicators.view(3000).state.detail, 'Plex is unreachable.');
  indicators.update(status(), 4000);
  assert.equal(indicators.view(11999).state, null);
  assert.equal(indicators.view(12000).state.title, 'Connection lost');
});
test('actual rewinds and fast-forwards show a timed notice with old and new TV positions', () => {
  const indicators = new PlaybackIndicators();
  indicators.update(status(120), 0);
  indicators.update(status(91), 1000);
  assert.deepEqual(indicators.view(1000).notice, { kind: 'rewind', title: 'Rewound 30s', detail: '2:01 → 1:31' });
  indicators.update(status(92), 2000);
  assert.equal(indicators.view(4999).notice.title, 'Rewound 30s');
  assert.equal(indicators.view(5000).notice, null);
  indicators.update(status(166), 6000);
  assert.equal(indicators.view(6000).notice.title, 'Fast-forwarded 1m 10s');
  assert.equal(indicators.view(6000).notice.detail, '1:36 → 2:46');
});
test('normal progression, small Plex clock corrections and reconnections do not pretend to be skips', () => {
  const indicators = new PlaybackIndicators();
  for (const [position, now] of [[120, 0], [121, 1000], [122, 2000], [122, 3000], [124, 4000], [122, 5000], [125, 6000]]) {
    indicators.update(status(position), now);
    assert.equal(indicators.view(now).notice, null);
  }
  indicators.connectionLost();
  assert.equal(indicators.view(7000).state.title, 'Stream interrupted');
  indicators.update(status(170), 8000);
  assert.equal(indicators.view(8000).notice, null);
  indicators.update(status(300), 20000);
  assert.equal(indicators.view(20000).notice, null);
  indicators.update(status(100, 'playing', { state: 'loading', playlist: null }), 21000);
  indicators.update(status(101), 22000);
  assert.equal(indicators.view(22000).notice, null);
  const ending = new PlaybackIndicators(), s = status(599);
  s.session.duration = 600;
  ending.update(s, 0);
  ending.update({ ...s, session: { ...s.session, position: 600 } }, 7000);
  assert.equal(ending.view(7000).notice, null);
});
test('episode changes notify once, distinguish next/previous/skipped episodes and survive loading', () => {
  const indicators = new PlaybackIndicators();
  const episode = n => ({ ...status(0), session: { ...status(0).session, mediaId: `episode-${n}`, episode: n } });
  indicators.update(episode(7), 0);
  assert.equal(indicators.view(0).notice, null);
  // Plex can briefly drop the old session while opening the next episode.
  indicators.update({ state: 'waiting' }, 500);
  indicators.update({ ...episode(8), state: 'loading', playlist: null }, 1000);
  assert.equal(indicators.view(1000).notice.title, 'Next episode');
  assert.equal(indicators.view(1000).notice.detail, 'Example anime · S1E8');
  indicators.update(episode(8), 2000);
  assert.equal(indicators.view(5000).notice, null);
  indicators.update(episode(11), 6000);
  assert.equal(indicators.view(6000).notice.title, 'Episodes skipped');
  indicators.update(episode(10), 7000);
  assert.equal(indicators.view(7000).notice.title, 'Previous episode');
  indicators.update({ state: 'waiting' }, 70000);
  indicators.update(episode(20), 71000);
  assert.equal(indicators.view(71000).notice, null);
});
test('stream-specific problems have readable indicators and clear when the local player recovers', () => {
  const indicators = new PlaybackIndicators();
  indicators.update(status(), 0);
  assert.equal(indicators.view(0, { buffering: true }).state.title, 'Stream is buffering');
  assert.equal(indicators.view(0, { playBlocked: true }).state.title, 'Playback needs a click');
  assert.equal(indicators.view(0, { error: 'Video decoding failed.' }).state.detail, 'Video decoding failed.');
  assert.equal(indicators.view(0).state, null);
  assert.equal(clockTime(3723.5), '1:02:03');
});
test('paused episode details and progress come from the TV and handle missing or out-of-range durations', () => {
  const indicators = new PlaybackIndicators(), s = status(600, 'paused');
  s.session.title = 'The tournament begins'; s.session.duration = 1440;
  indicators.update(s, 0);
  assert.deepEqual(indicators.view(0).state.episode, { series: 'Example anime · S1E7', title: 'The tournament begins', elapsed: '10:00', total: '24:00', progress: 600 / 1440 });
  indicators.update({ ...s, session: { ...s.session, position: 2000 } }, 1000);
  assert.equal(indicators.view(1000).state.episode.progress, 1);
  assert.equal(indicators.view(1000).state.episode.elapsed, '24:00');
  indicators.update({ ...s, session: { ...s.session, position: -5 } }, 2000);
  assert.equal(indicators.view(2000).state.episode.progress, 0);
  indicators.update({ ...s, session: { ...s.session, duration: 0 } }, 3000);
  assert.equal(indicators.view(3000).state.episode.progress, null);
  assert.equal(indicators.view(3000).state.episode.total, null);
  indicators.update({ ...s, session: { ...s.session, state: 'playing' } }, 4000);
  assert.equal(indicators.view(4000).state, null);
});
