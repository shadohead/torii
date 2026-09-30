// Manual, isolated end-to-end fixture: run with the same Node runtime as Torii,
// then start the container with TORII_LOCAL_URL=http://127.0.0.1:3940.
// Uses generated test media and a fake Plex server; never touches ~/.torii.
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const root = mkdtempSync(join(tmpdir(), 'torii-watch-fixture-'));
const library = join(root, 'Anime'); mkdirSync(library);
const subtitle = join(root, 'subtitles.srt');
writeFileSync(subtitle, '1\n00:00:00,000 --> 00:00:40,000\nFIRST HALF · subtitle sync test\n\n2\n00:00:40,000 --> 00:01:20,000\nSECOND HALF · subtitle sync test\n');
const media = join(library, 'pilot.mkv');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=80', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=80', '-i', subtitle, '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-c:a', 'aac', '-c:s', 'srt', '-t', '80', media]);
copyFileSync(media, join(library, 'next.mkv'));
const data = join(root, 'data'); mkdirSync(data);
const db = new Database(join(data, 'torii.db'));
db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const put = db.prepare('INSERT INTO settings VALUES (?, ?)');
for (const [k, v] of Object.entries({ libraryDir: library, plexUrl: 'http://127.0.0.1:3941', plexToken: 'fixture-token', keepPlexRunning: false, autoDownload: false, watchTogetherToken: 'isolated-test', watchTogetherEnabled: true, watchTogetherPlayerId: 'fixture-tv', watchTogetherOffsetSeconds: 0 })) put.run(k, JSON.stringify(v));
db.close();
let state = 'playing', offset = 10, at = Date.now(), episode = 1, stopped = false;
const position = () => Math.min(79, offset + (state === 'playing' ? (Date.now() - at) / 1000 : 0));
const pms = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const send = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/control') {
    const current = position();
    offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : current;
    state = url.searchParams.get('state') || state; at = Date.now();
    episode = Number(url.searchParams.get('episode')) || episode; stopped = url.searchParams.get('stopped') === 'true';
    return send({ state, offset, episode, stopped });
  }
  if (url.pathname === '/identity') return send({ MediaContainer: { version: 'fixture', machineIdentifier: 'fixture' } });
  if (url.pathname === '/library/sections') return send({ MediaContainer: { Directory: [{ key: '1', title: 'Anime', type: 'show', Location: [{ path: library }] }] } });
  if (url.pathname === '/status/sessions') return send({ MediaContainer: { size: stopped ? 0 : 1, Metadata: stopped ? [] : [{
    type: 'episode', sessionKey: String(episode), ratingKey: String(100 + episode), title: episode === 1 ? 'Pilot' : 'Next episode', grandparentTitle: 'Generated test anime', parentIndex: 1, index: episode, duration: 80000, viewOffset: Math.round(position() * 1000),
    Player: { machineIdentifier: 'fixture-tv', title: 'Fixture downstairs TV', state }, User: { title: 'Test viewer' },
    Media: [{ Part: [{ file: join(library, episode === 1 ? 'pilot.mkv' : 'next.mkv'), Stream: [{ streamType: 2, selected: 1 }, { streamType: 3, selected: 1 }] }] }],
  }] } });
  res.writeHead(404); res.end();
});
await new Promise(resolve => pms.listen(3941, '0.0.0.0', resolve));
const child = spawn(process.execPath, ['src/server.mjs'], { stdio: 'inherit', env: { ...process.env, TORII_DATA_DIR: data, TORII_PORT: '3940', TORII_LIBRARY_DIR: library } });
console.log(`Fixture: http://127.0.0.1:3940 · controls: http://127.0.0.1:3941/control?state=paused&offset=20 · data: ${root}`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill('SIGTERM'); pms.close(); setTimeout(() => process.exit(0), 1000); });
child.on('exit', () => { pms.close(); });
