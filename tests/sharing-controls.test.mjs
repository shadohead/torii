import test from 'node:test';
import assert from 'node:assert/strict';
import { WatchTogether } from '../src/watch-together.mjs';
import { containerStarter } from '../src/watch-container-control.mjs';

function harness(ensureCompanion = async () => {}) {
  let settings = { watchTogetherEnabled: true, watchTogetherPlayerId: 'tv', watchTogetherOffsetSeconds: 0 }, now = 0;
  const sessions = [{ id: '1', playerId: 'tv', player: 'Downstairs', ratingKey: '101', file: '/anime/episode.mkv', title: 'Episode', state: 'playing', offset: 100, duration: 1200 }];
  const dependencies = { getSettings: () => settings, setSettings: patch => { settings = { ...settings, ...patch }; }, readSessions: async () => sessions, ensureCompanion, now: () => now };
  return { together: new WatchTogether(dependencies), dependencies, advance: n => { now += n; } };
}
test('sharing pause persists across restarts without pausing or losing the TV timeline', async () => {
  const h = harness(() => { throw new Error('Pause must not start Docker'); });
  await h.together.refresh(); h.advance(5000);
  assert.equal((await h.together.controlSharing('pause')).sharingPaused, true);
  const bridge = await h.together.bridge();
  assert.equal(bridge.session.state, 'playing'); assert.equal(bridge.session.position, 105);
  assert.equal(bridge.enabled, true);
  const restarted = new WatchTogether(h.dependencies);
  assert.equal((await restarted.bridge()).sharingPaused, true);
});
test('start validates the saved TV first and only starts an offline or stale companion', async () => {
  const tokens = [], h = harness(async token => tokens.push(token));
  await assert.rejects(h.together.controlSharing('invalid'), { status: 400 });
  h.together.configure({ enabled: false, playerId: 'tv' });
  await assert.rejects(h.together.controlSharing('start'), { status: 400 });
  assert.equal(tokens.length, 0);
  h.together.configure({ enabled: true, playerId: 'tv' });
  assert.equal((await h.together.controlSharing('start')).sharingPaused, false);
  assert.equal(tokens[0].length, 64);
  h.together.heartbeat({ state: 'following' });
  await h.together.controlSharing('start'); assert.equal(tokens.length, 1);
  h.advance(15001);
  await h.together.controlSharing('start'); assert.equal(tokens.length, 2);
});
test('a newer Pause wins over a Start still waiting for Docker', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  const start = h.together.controlSharing('start');
  await h.together.controlSharing('pause'); finish();
  assert.equal((await start).sharingPaused, true);
  assert.equal((await h.together.bridge()).sharingPaused, true);
});
test('container startup coalesces requests and only runs the fixed installed companion', async () => {
  let complete; const calls = [];
  const start = containerStarter({ env: { PATH: '/usr/local/bin', TORII_COMPANION_URL: 'http://host.docker.internal:3939' }, run: (...args) => { calls.push(args); return new Promise(resolve => { complete = resolve; }); } });
  const pending = start('secret-token', 3939);
  assert.equal(start('secret-token', 3939), pending); assert.equal(calls.length, 1);
  const [command, args, options] = calls[0];
  assert.equal(command, 'docker');
  assert.deepEqual(args.slice(3), ['up', '-d', '--no-build', '--wait', '--wait-timeout', '30']);
  assert.ok(args[2].endsWith('/containers/watch-together/compose.yaml'));
  assert.equal(args.join(' ').includes('secret-token'), false);
  assert.equal(options.env.TORII_WATCH_TOKEN, 'secret-token');
  complete(); await pending;
});
test('Docker failures return a safe actionable error without leaking output or tokens', async () => {
  let count = 0;
  const start = containerStarter({ run: async () => { count++; throw new Error('stderr secret-token'); } });
  await assert.rejects(start('secret-token', 3939), err => err.status === 503 && !err.message.includes('secret-token') && err.message.includes('Docker Desktop'));
  await assert.rejects(start('secret-token', 3939)); assert.equal(count, 2);
});
