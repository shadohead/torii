const video = document.querySelector('video'), label = document.querySelector('#status');
let hls, playlist, sample, sampledAt = 0, restarting = false, fetching = false;
function enableSound() { video.muted = false; if (sample?.session?.state === 'playing') video.play().catch(() => {}); }
function fullscreen() {
  const action = document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen();
  action.catch(() => {});
}
video.addEventListener('click', enableSound);
video.addEventListener('dblclick', () => { enableSound(); fullscreen(); });
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); fullscreen(); }
  else if (event.key.toLowerCase() === 'm') video.muted = !video.muted;
});
function pause(message) { video.pause(); document.body.classList.add('waiting'); label.textContent = message; }
async function sync() {
  if (fetching) return;
  fetching = true;
  try {
    const res = await fetch('/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error();
    sample = await res.json(); sampledAt = Date.now();
    if (sample.state !== 'following' || !sample.playlist || !sample.session) {
      pause(sample.error || (sample.state === 'loading' ? 'Loading the current episode…' : 'Waiting for anime on your TV.')); return;
    }
    if (playlist !== sample.playlist) {
      hls?.destroy(); playlist = sample.playlist;
      hls = new Hls({ startPosition: Math.max(0, sample.session.position - sample.base), liveSyncDuration: 86400, maxBufferLength: 20 });
      hls.attachMedia(video); hls.loadSource(playlist);
      hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) { pause('Player interrupted. Reconnecting…'); playlist = null; } });
    }
    document.body.classList.remove('waiting');
    const s = sample.session;
    label.textContent = `${s.show || s.title}${s.show ? ` · S${s.season}E${s.episode}` : ''} · ${s.state}`;
    const target = s.position - sample.base;
    if (video.readyState >= 2) {
      const range = video.seekable;
      const available = range.length && target >= range.start(0) && target < range.end(range.length - 1);
      const tolerance = s.state === 'playing' ? 2.5 : 0.15;
      if (available && Math.abs(video.currentTime - target) > tolerance) video.currentTime = target;
      else if (!available && !restarting && (target < 0.5 || (range.length && target > range.end(range.length - 1) + 8))) {
        restarting = true; await fetch('/seek', { method: 'POST' }); setTimeout(() => { restarting = false; }, 10000);
      }
    }
    if (s.state === 'playing') video.play().catch(() => { label.textContent = 'Click the video to begin playback with sound.'; });
    else video.pause();
  } catch { pause('Connection lost. Playback paused.'); sample = null; }
  finally { fetching = false; }
}
// A frozen container/bridge must not leave the last episode running indefinitely.
setInterval(() => { if (Date.now() - sampledAt > 8000) pause('Waiting for the TV connection…'); }, 1000);
sync(); setInterval(sync, 1000);
