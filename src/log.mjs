import { appendFileSync } from 'node:fs';
import { LOG_FILE } from './config.mjs';

function line(level, args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  const s = `${new Date().toISOString()} [${level}] ${msg}`;
  console[level === 'error' ? 'error' : 'log'](s);
  try { appendFileSync(LOG_FILE, s + '\n'); } catch {}
}

export const log = (...a) => line('info', a);
log.warn = (...a) => line('warn', a);
log.error = (...a) => line('error', a);
