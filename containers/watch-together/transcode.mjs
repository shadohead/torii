import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function transcodeArgs(input, output, session, base) {
  const subtitle = typeof session.subtitleTrack === 'number' ? session.subtitleTrack - 1 : null;
  const filters = [`setpts=PTS+${base}/TB`];
  if (subtitle != null) filters.push(`subtitles=filename='${input}':si=${subtitle}`);
  filters.push('scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2', 'setpts=PTS-STARTPTS');
  const audio = typeof session.audioTrack === 'number' ? session.audioTrack - 1 : 0;
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(base), '-i', input,
    '-map', '0:v:0', '-map', `0:a:${audio}?`, '-vf', filters.join(','), '-af', 'asetpts=PTS-STARTPTS',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-threads', '2', '-r', '30', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-f', 'hls', '-hls_time', '1',
    '-hls_playlist_type', 'event', '-hls_list_size', '0', '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', join(output, 'segment-%05d.ts'), join(output, 'index.m3u8')];
}

export class Transcoder {
  async start(input, root, session, base, generation) {
    await this.stop();
    this.output = join(root, String(generation));
    mkdirSync(this.output, { recursive: true });
    this.error = null;
    const child = this.child = spawn('ffmpeg', transcodeArgs(input, this.output, session, base), { stdio: ['ignore', 'ignore', 'pipe'] });
    let detail = '';
    child.stderr.on('data', data => { detail = (detail + data).slice(-2000); });
    child.once('error', () => { this.error = 'FFmpeg could not start.'; });
    child.once('exit', code => { if (code && this.child === child) this.error = 'Episode encoding failed. Check the selected audio/subtitle tracks.'; });
    for (let i = 0; i < 600; i++) {
      if (this.error) { console.error(detail); throw new Error(this.error); }
      if (existsSync(join(this.output, 'index.m3u8'))) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Episode encoding did not produce a playable segment.');
  }
  async stop() {
    const child = this.child; this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
    });
    if (this.output) { rmSync(this.output, { recursive: true, force: true }); this.output = null; }
  }
}
