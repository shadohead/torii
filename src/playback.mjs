import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';

// Plex supplies filesystem paths. Only mirror files inside Torii's anime library,
// including a realpath check so a symlink cannot escape the configured folder.
export function libraryFile(file, libraryDir) {
  if (!file || !isAbsolute(file)) return false;
  try {
    const child = realpathSync(file), parent = realpathSync(libraryDir);
    const rel = relative(parent, child);
    return ['.mkv', '.mp4', '.m4v', '.avi', '.webm', '.ts', '.m2ts'].includes(extname(file).toLowerCase()) &&
      rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) &&
      !isAbsolute(rel) && statSync(child).isFile();
  } catch { return false; }
}

const selected = x => x?.selected === true || Number(x?.selected) === 1;
const number = x => Number.isFinite(Number(x)) ? Number(x) : 0;

export function normalizeSessions(body, libraryDir, allowedFile = libraryFile) {
  const items = body.MediaContainer?.Metadata || [];
  return items.flatMap(item => {
    if (!['episode', 'movie'].includes(item.type) || !item.ratingKey) return [];
    const player = item.Player;
    if (!player?.machineIdentifier || !['playing', 'paused', 'buffering'].includes(player.state)) return [];
    const media = item.Media?.find(selected) || item.Media?.[0];
    // A multipart item needs a part-relative seek calculation; don't silently
    // show the wrong part. Torii's downloaded episodes are single-file media.
    if (media?.Part?.length !== 1) return [];
    const part = media.Part[0];
    if (!allowedFile(part.file, libraryDir)) return [];
    const streams = part.Stream || [];
    const track = type => {
      const list = streams.filter(s => Number(s.streamType) === type && !s.key);
      const index = list.findIndex(selected);
      return index < 0 ? null : index + 1;
    };
    // Plex reports an explicitly selected external subtitle as a URL, which
    // cannot be loaded as a local embedded track. Use mpv's English preference.
    const externalSub = streams.some(s => Number(s.streamType) === 3 && selected(s) && s.key);
    return [{
      id: String(item.sessionKey ?? item.Session?.id ?? player.machineIdentifier),
      playerId: String(player.machineIdentifier),
      player: player.title || player.product || 'Plex player',
      user: item.User?.title || '',
      ratingKey: String(item.ratingKey || ''),
      mediaId: createHash('sha256').update(String(item.ratingKey) + ':' + part.file).digest('hex').slice(0, 24),
      title: item.title || 'Untitled',
      show: item.grandparentTitle || '',
      season: number(item.parentIndex), episode: number(item.index),
      state: player.state,
      offset: Math.max(0, number(item.viewOffset)) / 1000,
      duration: Math.max(0, number(item.duration)) / 1000,
      file: part.file,
      audioTrack: track(2),
      subtitleTrack: externalSub || !streams.length ? null : (track(3) ?? 'no'),
    }];
  });
}

export function publicSession({ file, audioTrack, subtitleTrack, ...session }) { return session; }

// Plex clients report progress periodically rather than for every frame. Do not
// seek back to an unchanged offset on each poll; advance from the last report.
export class PlaybackClock {
  sample(session, now) {
    const key = `${session.id}:${session.ratingKey}:${session.file}`;
    const changed = key !== this.key || session.offset !== this.offset || session.state !== this.state;
    if (changed) {
      this.key = key; this.offset = session.offset; this.state = session.state; this.at = now;
    }
    const age = Math.max(0, (now - this.at) / 1000);
    const stale = session.state === 'playing' && age > 30;
    const elapsed = session.state === 'playing' ? Math.min(age, 30) : 0;
    return { position: Math.min(session.duration || Infinity, session.offset + elapsed), stale };
  }
  reset() { this.key = null; }
}
