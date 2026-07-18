import { createReadStream } from 'node:fs';
import { extname } from 'node:path';

const MIME = {
  '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.avi': 'video/x-msvideo',
  '.webm': 'video/webm', '.m4v': 'video/x-m4v',
};

function attachmentHeader(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function rejectRange(res, size) {
  res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
  res.end();
}

// Stream an already-authorized file as an attachment. Byte ranges let browsers
// resume paused or interrupted multi-gigabyte transfers.
export function serveAttachment(req, res, file, onError = () => {}) {
  const headers = {
    'Content-Type': MIME[extname(file.name).toLowerCase()] || 'application/octet-stream',
    'Content-Disposition': attachmentHeader(file.name),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
  };
  let start = 0;
  let end = file.size - 1;
  let code = 200;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return rejectRange(res, file.size);
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return rejectRange(res, file.size);
      start = Math.max(0, file.size - suffix);
    } else {
      start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= file.size || end < start) {
      return rejectRange(res, file.size);
    }
    end = Math.min(end, file.size - 1);
    code = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  res.writeHead(code, headers);
  if (req.method === 'HEAD' || file.size === 0) return res.end();
  const stream = createReadStream(file.path, { start, end });
  stream.on('error', (err) => {
    onError(err);
    res.destroy(err);
  });
  stream.pipe(res);
}
