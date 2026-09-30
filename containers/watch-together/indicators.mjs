export function clockTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60), tail = String(total % 60).padStart(2, '0');
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`;
}
const duration = seconds => {
  const total = Math.max(1, Math.round(Math.abs(seconds))), minutes = Math.floor(total / 60);
  return minutes ? `${minutes}m${total % 60 ? ` ${total % 60}s` : ''}` : `${total}s`;
};
const episodeLabel = s => s.show ? `${s.show} · S${s.season}E${s.episode}` : s.title || 'Current episode';
const card = (kind, title, detail) => ({ kind, title, detail });
function pausedEpisode(s) {
  const duration = Number.isFinite(s.duration) && s.duration > 0 ? s.duration : null;
  const position = Math.min(duration || Infinity, Math.max(0, Number(s.position) || 0));
  return {
    series: s.show ? `${s.show} · S${s.season}E${s.episode}` : '',
    title: s.title || (s.episode ? `Episode ${s.episode}` : 'Current episode'),
    elapsed: clockTime(position), total: duration ? clockTime(duration) : null,
    progress: duration ? position / duration : null,
  };
}

// Use the TV's projected position, not its intermittent raw Plex offsets or the
// companion's corrective seeks. A loading/reconnection gap resets the baseline.
export class PlaybackIndicators {
  constructor() { this.snapshot = null; this.receivedAt = null; this.previous = null; this.media = null; this.notice = null; this.noticeUntil = 0; }
  update(snapshot, now) {
    this.snapshot = snapshot; this.receivedAt = now;
    const s = snapshot.session;
    if (s?.mediaId) {
      if (this.media && now - this.media.at < 60000 && this.media.mediaId !== s.mediaId) {
        let title = 'Episode changed';
        if (s.show && this.media.show === s.show && s.season === this.media.season) {
          if (s.episode === this.media.episode + 1) title = 'Next episode';
          else if (s.episode === this.media.episode - 1) title = 'Previous episode';
          else if (s.episode > this.media.episode + 1) title = 'Episodes skipped';
        }
        this.showNotice(card('episode', title, episodeLabel(s)), now);
      }
      this.media = { ...s, at: now };
    } else if (this.media && now - this.media.at >= 60000) this.media = null;
    const usable = snapshot.state === 'following' && !!snapshot.playlist && !!s?.mediaId && Number.isFinite(s.position);
    const previous = this.previous;
    if (usable && previous && previous.mediaId === s.mediaId && previous.id === s.id && now >= previous.at && now - previous.at < 8000) {
      const expected = Math.min(previous.duration || Infinity, previous.position + (previous.state === 'playing' ? (now - previous.at) / 1000 : 0));
      const change = s.position - expected;
      if (Math.abs(change) >= 5) this.showNotice(card(change < 0 ? 'rewind' : 'forward', `${change < 0 ? 'Rewound' : 'Fast-forwarded'} ${duration(change)}`, `${clockTime(expected)} → ${clockTime(s.position)}`), now);
    }
    this.previous = usable ? { ...s, at: now } : null;
  }
  showNotice(notice, now) { this.notice = notice; this.noticeUntil = now + 4000; }
  connectionLost() {
    this.snapshot = { state: 'error', error: 'Torii connection lost. Playback is paused while it reconnects.' };
    this.previous = null;
  }
  view(now, local = {}) {
    const snapshot = this.snapshot, s = snapshot?.session;
    let state = null;
    if (!snapshot) state = card('loading', 'Connecting…', 'Waiting for the downstairs TV');
    else if (snapshot.state === 'error') state = card('error', 'Stream interrupted', snapshot.error || 'Playback is paused while Torii reconnects.');
    else if (this.receivedAt != null && now - this.receivedAt >= 8000) state = card('error', 'Connection lost', 'Playback is paused. Waiting for the TV connection.');
    else if (s?.state === 'paused') state = { ...card('pause', 'Paused on TV', snapshot.state === 'loading' ? 'Loading the paused episode' : 'Resumes when the TV resumes'), episode: pausedEpisode(s) };
    else if (s?.state === 'buffering') state = card('buffering', 'TV is buffering', 'The stream will continue with the TV.');
    else if (snapshot.state === 'loading') state = card('loading', 'Loading episode…', s ? episodeLabel(s) : 'Preparing the TV’s video');
    else if (snapshot.state !== 'following' || !snapshot.playlist || !s) state = card('waiting', 'Waiting for the TV', 'Start an anime on the downstairs TV to watch together.');
    else if (local.error) state = card('error', 'Stream interrupted', local.error);
    else if (local.playBlocked) state = card('error', 'Playback needs a click', 'Click the video to enable playback and sound.');
    else if (local.buffering) state = card('buffering', 'Stream is buffering', 'Catching up with the TV…');
    return { state, notice: now < this.noticeUntil ? this.notice : null };
  }
}
