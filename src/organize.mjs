import { mkdirSync, renameSync, linkSync, existsSync, statSync, readdirSync, rmSync, statfsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { getSettings } from './db.mjs';
import { parseRelease, seasonFromShowTitle } from './nyaa.mjs';
import { log } from './log.mjs';
export { seasonFromShowTitle };

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.webm']);
const pad2 = (n) => String(Math.floor(n)).padStart(2, '0');

export const sanitize = (s) => s.replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();

export function incomingDir() {
  const { libraryDir, incomingDirName } = getSettings();
  const dir = join(libraryDir, incomingDirName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Show folder name: strip season designators so all seasons nest under one show.
export function showFolderName(title) {
  return sanitize(
    title
      .replace(/\b(\d+(?:st|nd|rd|th)\s+Season|Season\s+\d+|Final Season)\b/gi, '')
      .replace(/\s+(II|III|IV|V)$/, '')
      .replace(/[-:]\s*$/, '')
      .trim()
  ) || sanitize(title);
}

function destName(showFolder, season, episode, group, quality, ext) {
  const epPart = Number.isInteger(episode) ? pad2(episode) : String(episode).replace('.', '.');
  const tags = [group && `[${group}]`, quality && `[${quality}]`].filter(Boolean).join('');
  return `${showFolder} - S${pad2(season)}E${epPart}${tags ? ' ' + tags : ''}${ext}`;
}

// Move every video file of a completed download into the Plex library.
// Returns the list of final absolute paths.
export function organizeDownload(dl, filePaths) {
  const { libraryDir } = getSettings();
  const showTitle = dl.show_title || dl.release_title;
  const folder = showFolderName(showTitle);
  const season = dl.season || seasonFromShowTitle(showTitle) || 1;
  const seasonDir = join(libraryDir, folder, `Season ${pad2(season)}`);
  mkdirSync(seasonDir, { recursive: true });

  const finals = [];
  for (const src of filePaths) {
    const ext = extname(src).toLowerCase();
    if (!VIDEO_EXT.has(ext)) continue;
    const name = basename(src);
    if (/\bsample\b/i.test(name)) continue;
    // Prefer per-file episode parse (matters for batches); fall back to the release title parse.
    const parsed = parseRelease(name);
    const episode = parsed.episode ?? dl.episode;
    let destFile;
    if (episode != null) {
      destFile = destName(folder, parsed.season || season, episode, dl.group_name || parsed.group, dl.quality || parsed.quality, ext);
    } else {
      destFile = sanitize(name); // unknown numbering - keep original name inside the show folder
    }
    let dest = join(seasonDir, destFile);
    if (existsSync(dest)) {
      if (statSync(dest).size === statSync(src).size) { finals.push(dest); continue; } // already organized
      const alt = dest.replace(ext, ` (${Date.now() % 10000})${ext}`);
      log.warn('destination exists, using', alt);
      dest = alt;
    }
    // Hardlink so the torrent can keep seeding from .incoming while Plex sees the
    // library copy immediately - zero extra disk space on the same APFS volume.
    // Falls back to a move if linking isn't possible.
    try { linkSync(src, dest); } catch { renameSync(src, dest); }
    finals.push(dest);
  }
  return finals;
}

// Clean an empty torrent folder left in .incoming after organizing.
export function cleanupIncoming(rootPath) {
  try {
    if (!rootPath || !existsSync(rootPath)) return;
    if (!rootPath.startsWith(incomingDir())) return;
    if (statSync(rootPath).isDirectory()) {
      const left = readdirSync(rootPath, { recursive: true }).filter(f => VIDEO_EXT.has(extname(String(f)).toLowerCase()));
      if (left.length === 0) rmSync(rootPath, { recursive: true, force: true });
    }
  } catch (err) { log.warn('cleanupIncoming', String(err)); }
}

export function freeBytes() {
  const s = statfsSync(getSettings().libraryDir);
  return s.bavail * s.bsize;
}

export function diskSpace() {
  try {
    const s = statfsSync(getSettings().libraryDir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return { free: 0, total: 0 };
  }
}
