import Database from 'better-sqlite3';
import { join } from 'node:path';
import { DATA_DIR, DEFAULT_SETTINGS } from './config.mjs';

export const db = new Database(join(DATA_DIR, 'torii.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlist (
  anilist_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  search_title TEXT NOT NULL,
  poster TEXT,
  group_name TEXT NOT NULL,
  quality TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 1,
  last_episode REAL NOT NULL DEFAULT 0,
  season INTEGER NOT NULL DEFAULT 1,
  episodes INTEGER,
  next_ep INTEGER,
  next_airing_at INTEGER,
  show_status TEXT,
  checked_at INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  info_hash TEXT UNIQUE,
  release_title TEXT NOT NULL,
  show_title TEXT,
  anilist_id INTEGER,
  season INTEGER NOT NULL DEFAULT 1,
  episode REAL,
  group_name TEXT,
  quality TEXT,
  torrent_url TEXT,
  size INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  final_paths TEXT,
  added_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
CREATE TABLE IF NOT EXISTS api_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`);

// ---------- settings ----------
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const row = getSettingStmt.get(key);
    if (row) { try { out[key] = JSON.parse(row.value); } catch {} }
  }
  return out;
}
export function setSettings(patch) {
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      setSettingStmt.run(k, JSON.stringify(v));
    }
  });
  tx(Object.entries(patch));
  return getSettings();
}

// ---------- api cache ----------
const cacheGet = db.prepare('SELECT value FROM api_cache WHERE key = ? AND expires > ?');
const cacheSet = db.prepare('INSERT INTO api_cache (key, value, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires');

export function cached(key, ttlMs, fn) {
  const hit = cacheGet.get(key, Date.now());
  if (hit) return Promise.resolve(JSON.parse(hit.value));
  return Promise.resolve(fn()).then((val) => {
    cacheSet.run(key, JSON.stringify(val), Date.now() + ttlMs);
    return val;
  });
}
export function cacheBust(prefix) {
  db.prepare(`DELETE FROM api_cache WHERE key LIKE ?`).run(prefix + '%');
}
