import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'torii-device-download-'));
process.env.TORII_DATA_DIR = join(root, 'data');
process.env.TORII_LIBRARY_DIR = join(root, 'library');
mkdirSync(process.env.TORII_LIBRARY_DIR, { recursive: true });

const { db } = await import('../src/db.mjs');
const { getDownloadFile } = await import('../src/torrents.mjs');
const { serveAttachment } = await import('../src/http-download.mjs');

after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('completed files resolve only from inside the configured library', () => {
  const media = join(process.env.TORII_LIBRARY_DIR, 'episode.mkv');
  const outside = join(root, 'private.txt');
  writeFileSync(media, '0123456789');
  writeFileSync(outside, 'secret');
  const insert = db.prepare(`INSERT INTO downloads
    (info_hash, release_title, status, final_paths, added_at)
    VALUES (?, ?, 'done', ?, ?)`);

  const good = Number(insert.run('good', 'Good', JSON.stringify([media]), Date.now()).lastInsertRowid);
  assert.deepEqual(getDownloadFile(good, 0), { path: realpathSync(media), name: 'episode.mkv', size: 10 });
  assert.equal(getDownloadFile(good, 1), null);

  const escaped = Number(insert.run('escaped', 'Escaped', JSON.stringify([outside]), Date.now()).lastInsertRowid);
  assert.equal(getDownloadFile(escaped, 0), null);

  const link = join(process.env.TORII_LIBRARY_DIR, 'linked.mkv');
  symlinkSync(outside, link);
  const linked = Number(insert.run('linked', 'Linked', JSON.stringify([link]), Date.now()).lastInsertRowid);
  assert.equal(getDownloadFile(linked, 0), null);
});

test('browser downloads include attachment headers and resumable byte ranges', async () => {
  const path = join(process.env.TORII_LIBRARY_DIR, 'range-test.mkv');
  writeFileSync(path, '0123456789');
  const file = { path, name: 'Anime "鳥".mkv', size: 10 };
  const server = http.createServer((req, res) => serveAttachment(req, res, file));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(base);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'video/x-matroska');
    assert.match(res.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''/);
    assert.equal(await res.text(), '0123456789');

    res = await fetch(base, { headers: { Range: 'bytes=2-5' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await res.text(), '2345');

    res = await fetch(base, { headers: { Range: 'bytes=-3' } });
    assert.equal(res.status, 206);
    assert.equal(await res.text(), '789');

    res = await fetch(base, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), '10');

    res = await fetch(base, { headers: { Range: 'bytes=20-' } });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get('content-range'), 'bytes */10');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
