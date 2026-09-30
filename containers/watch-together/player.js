import { PlaybackIndicators } from './indicators.mjs';

const video = document.querySelector('video'), stage = document.querySelector('#stage'), label = document.querySelector('#status');
const indicators = new PlaybackIndicators();
const local = { buffering: true, playBlocked: false, error: null };
const icons = {
  pause: 'M11 7v18M21 7v18',
  error: 'M16 3 30 28H2zM16 12v7M16 23v1',
  loading: 'M26 16a10 10 0 1 1-10-10',
  buffering: 'M26 16a10 10 0 1 1-10-10',
  waiting: 'M4 7h24v18H4zM11 29h10',
  rewind: 'M15 7 3 16l12 9zM29 7 17 16l12 9z',
  forward: 'M3 7 15 16 3 25zM17 7 29 16 17 25z',
  episode: 'M6 7 20 16 6 25zM25 7v18',
};
const elements = Object.fromEntries(['state-layer', 'state-card', 'state-icon', 'state-title', 'state-detail', 'pause-info', 'pause-series', 'pause-episode', 'pause-progress', 'pause-progress-fill', 'pause-elapsed', 'pause-total', 'notice', 'notice-icon', 'notice-title', 'notice-detail'].map(id => [id, document.getElementById(id)]));
function setText(node, value) { if (node.textContent !== value) node.textContent = value; }
function paint() {
  const { state, notice } = indicators.view(Date.now(), { ...local, buffering: local.buffering || video.readyState < 3 });
  elements['state-layer'].hidden = !state;
  if (state) {
    elements['state-card'].dataset.kind = state.kind;
    elements['state-icon'].setAttribute('d', icons[state.kind]);
    setText(elements['state-title'], state.title); setText(elements['state-detail'], state.detail);
  }
  elements['pause-info'].hidden = !state?.episode;
  if (state?.episode) {
    const episode = state.episode;
    setText(elements['pause-series'], episode.series); elements['pause-series'].hidden = !episode.series;
    setText(elements['pause-episode'], episode.title);
    setText(elements['pause-elapsed'], episode.elapsed); setText(elements['pause-total'], episode.total || '—');
    elements['pause-progress'].hidden = episode.progress == null;
    if (episode.progress != null) {
      const percent = String(Math.round(episode.progress * 1000) / 10);
      elements['pause-progress-fill'].style.width = `${percent}%`;
      elements['pause-progress'].setAttribute('aria-valuenow', percent);
      elements['pause-progress'].setAttribute('aria-valuetext', `${episode.elapsed} of ${episode.total}`);
    }
  }
  elements.notice.hidden = !notice;
  if (notice) {
    elements['notice-icon'].setAttribute('d', icons[notice.kind]);
    setText(elements['notice-title'], notice.title); setText(elements['notice-detail'], notice.detail);
  }
}
let hls, playlist, sample, sampledAt = 0, restarting = false, fetching = false;
function play() {
  video.play().then(() => { local.playBlocked = false; paint(); }).catch(error => {
    // A source pause can intentionally cancel a pending play promise.
    if (error.name === 'NotAllowedError') { local.playBlocked = true; paint(); }
  });
}
function enableSound() { video.muted = false; if (sample?.session?.state === 'playing') play(); }
function fullscreen() {
  // Fullscreen the video and its indicators together so Discord captures both.
  const action = document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen();
  action.catch(() => {});
}
video.addEventListener('click', enableSound);
video.addEventListener('dblclick', () => { enableSound(); fullscreen(); });
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); fullscreen(); }
  else if (event.key.toLowerCase() === 'm') video.muted = !video.muted;
});
video.addEventListener('waiting', () => { local.buffering = true; paint(); });
video.addEventListener('seeking', () => { local.buffering = true; paint(); });
for (const event of ['playing', 'canplay', 'seeked']) video.addEventListener(event, () => {
  local.buffering = video.readyState < 3;
  if (event === 'playing') { local.playBlocked = false; local.error = null; }
  paint();
});
function pause(message) { video.pause(); document.body.classList.add('waiting'); setText(label, message); paint(); }
async function sync() {
  if (fetching) return;
  fetching = true;
  try {
    const res = await fetch('/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error();
    sample = await res.json(); sampledAt = Date.now(); indicators.update(sample, sampledAt);
    if (sample.state !== 'following' || !sample.playlist || !sample.session) {
      pause(sample.error || (sample.state === 'loading' ? 'Loading the current episode…' : 'Waiting for anime on your TV.')); return;
    }
    if (playlist !== sample.playlist) {
      hls?.destroy(); playlist = sample.playlist;
      local.buffering = true;
      hls = new Hls({ startPosition: Math.max(0, sample.session.position - sample.base), liveSyncDuration: 86400, maxBufferLength: 20 });
      hls.attachMedia(video); hls.loadSource(playlist);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) { local.error = 'Playback is paused while the video reconnects.'; pause('Player interrupted. Reconnecting…'); playlist = null; }
      });
    }
    document.body.classList.remove('waiting');
    const s = sample.session;
    setText(label, `${s.show || s.title}${s.show ? ` · S${s.season}E${s.episode}` : ''} · ${s.state}`);
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
    if (s.state === 'playing') play();
    else video.pause();
  } catch { indicators.connectionLost(); sample = null; pause('Connection lost. Playback paused.'); }
  finally { fetching = false; paint(); }
}
// A frozen container/bridge must not leave the last episode running indefinitely.
setInterval(() => {
  if (sampledAt && Date.now() - sampledAt >= 8000) pause('Waiting for the TV connection…');
  else paint();
}, 250);
sync(); setInterval(sync, 1000);
