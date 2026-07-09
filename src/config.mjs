import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const DATA_DIR = process.env.TORII_DATA_DIR || join(homedir(), '.torii');
export const POSTER_CACHE_DIR = join(DATA_DIR, 'posters');
export const LOG_FILE = join(DATA_DIR, 'torii.log');

for (const d of [DATA_DIR, POSTER_CACHE_DIR]) mkdirSync(d, { recursive: true });

// Environment overrides (useful for launchd/systemd units and non-default setups).
export const PORT_OVERRIDE = Number(process.env.TORII_PORT) || null;

// Settings live in sqlite so the UI can edit them; these are the defaults.
// The library folder is changeable any time in Setup (or via TORII_LIBRARY_DIR
// before first run); point it inside a folder your Plex server watches.
export const DEFAULT_SETTINGS = {
  port: 3939,
  libraryDir: process.env.TORII_LIBRARY_DIR || join(homedir(), 'Movies', 'Anime'),
  incomingDirName: '.incoming',
  plexUrl: 'http://127.0.0.1:32400',
  plexToken: '',
  defaultQuality: '1080p',
  preferredGroups: ['SubsPlease', 'Erai-raws'],
  autoDownload: true,
  keepPlexRunning: true,
  // Torrent engine tuning - kept conservative so the Mac stays responsive.
  maxConns: 30,
  downloadLimitKBs: 0,          // 0 = unlimited
  uploadLimitKBs: 512,
  seedRatio: 1.0,               // stop seeding at this ratio
  seedMaxHours: 6,              // ... or after this many hours, whichever first
  // Watchlist polling
  pollMinutes: 30,              // baseline check interval per show
  hotPollMinutes: 10,           // when an episode is due within +/- 2h of air time
};
