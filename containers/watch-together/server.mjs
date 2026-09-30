import http from 'node:http';
import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transcoder } from './transcode.mjs';
import { readDiscordStatus } from './automation-config.mjs';

const upstream = process.env.TORII_URL || 'http://host.docker.internal:3939';
const headers = { Authorization: `Bearer ${process.env.TORII_WATCH_TOKEN || ''}` };
const root = '/tmp/torii-media'; mkdirSync(root, { recursive: true });
const input = join(root, 'episode.mkv'), encoder = new Transcoder();
let status = { state: 'waiting', error: null, session: null }, readyKey = '', downloaded = '', job = null, generation = 0, base = 0, snapshot;
let targetKey = '', downloadAbort, retryAt = 0;
const key = session => `${session.mediaId}:${session.id}:${session.audioTrack}:${session.subtitleTrack}`;
async function bridge(path, options = {}) {
  const res = await fetch(new URL(path, upstream), { ...options, headers: { ...headers, ...options.headers }, signal: options.signal || AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Torii connection returned ${res.status}. Restart the container from Torii if its token changed.`);
  return res;
}
async function prepare(session, requested) {
  status = { state: 'loading', error: null, session };
  try {
    await encoder.stop(); readyKey = '';
    if (downloaded !== session.mediaId) {
      downloaded = '';
      downloadAbort = new AbortController();
      const timeout = setTimeout(() => downloadAbort.abort(), 300000);
      try {
        const res = await bridge(`/api/watch-together/media?id=${encodeURIComponent(session.id)}`, { signal: downloadAbort.signal });
        const size = Number(res.headers.get('content-length'));
        if (!size || size > 8 * 1024 ** 3) throw new Error('This companion supports episode files up to 8 GB.');
        await pipeline(Readable.fromWeb(res.body), createWriteStream(input), { signal: downloadAbort.signal });
        downloaded = session.mediaId;
      } finally { clearTimeout(timeout); downloadAbort = null; }
    }
    if (targetKey !== requested) return;
    // Use the latest TV time after downloading, not the old time at job start.
    const current = snapshot?.session;
    if (!current || key(current) !== requested) return;
    base = Math.max(0, current.position - 5); generation++;
    await encoder.start(input, root, current, base, generation);
    if (targetKey !== requested) { await encoder.stop(); return; }
    readyKey = requested;
    status = { state: 'following', error: null, session: current };
  } catch (err) {
    if (targetKey === requested) { retryAt = Date.now() + 15000; status = { state: 'error', error: err.message, session: null }; }
  }
}
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    snapshot = await (await bridge('/api/watch-together/bridge')).json();
    const session = snapshot.enabled && snapshot.state === 'following' ? snapshot.session : null;
    const previousKey = targetKey;
    targetKey = session ? key(session) : '';
    if (previousKey !== targetKey) retryAt = 0;
    if (!session) {
      downloadAbort?.abort();
      status = { state: snapshot.error ? 'error' : 'waiting', error: snapshot.error, session: null };
      if (!job) { await encoder.stop(); readyKey = ''; }
    } else if (!job && Date.now() >= retryAt && (readyKey !== targetKey || encoder.error)) {
      const requested = targetKey;
      job = prepare(session, requested).finally(() => { job = null; });
    } else if (readyKey === targetKey && !job) status = { state: 'following', error: null, session };
    await bridge('/api/watch-together/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: status.state, error: status.error, discord: readDiscordStatus() }) });
  } catch {
    targetKey = ''; downloadAbort?.abort();
    status = { state: 'error', error: 'Torii is unreachable. Playback paused until it reconnects.', session: null };
  } finally { polling = false; }
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ...status, discord: readDiscordStatus(), base, generation, playlist: readyKey && readyKey === targetKey ? `/hls/${generation}/index.m3u8` : null }));
  }
  if (url.pathname === '/seek' && req.method === 'POST') {
    // The viewer requests a fresh segment range, but never controls the TV.
    if (!job && snapshot?.session) { readyKey = ''; const requested = targetKey; job = prepare(snapshot.session, requested).finally(() => { job = null; }); }
    res.writeHead(202); return res.end();
  }
  const file = url.pathname === '/' ? new URL('./player.html', import.meta.url) :
    url.pathname === '/player.js' ? new URL('./player.js', import.meta.url) :
    url.pathname === '/indicators.mjs' ? new URL('./indicators.mjs', import.meta.url) :
    url.pathname === '/hls.js' ? new URL('./node_modules/hls.js/dist/hls.min.js', import.meta.url) :
    /^\/hls\/\d+\/(?:index\.m3u8|segment-\d+\.ts)$/.test(url.pathname) ? join(root, url.pathname.slice(5)) : null;
  if (!file) { res.writeHead(404); return res.end(); }
  try {
    res.writeHead(200, { 'Content-Type': mime[extname(String(file))] || 'application/octet-stream', 'Content-Length': statSync(file).size, 'Cache-Control': 'no-store' });
    const stream = createReadStream(file); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(8080, '127.0.0.1'); poll(); setInterval(poll, 2000);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { downloadAbort?.abort(); await encoder.stop(); server.close(); process.exit(0); });
