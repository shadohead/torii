import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PlaybackClock, publicSession } from './playback.mjs';

export class WatchTogether {
  constructor({ readSessions, getSettings, setSettings, now = Date.now }) {
    Object.assign(this, { readSessions, getSettings, setSettings, now });
    this.clock = new PlaybackClock(); this.sessions = []; this.session = null;
    this.state = 'disabled'; this.error = null; this.companion = null;
  }
  async refresh() {
    if (this.pending) return this.pending;
    this.pending = this.update().finally(() => { this.pending = null; });
    return this.pending;
  }
  async update() {
    try {
      this.sessions = await this.readSessions();
      const s = this.getSettings();
      const matches = s.watchTogetherEnabled ? this.sessions.filter(x => x.playerId === s.watchTogetherPlayerId) : [];
      if (matches.length > 1) throw new Error('Multiple sessions on the selected TV. Stop the extra session to resume.');
      this.session = matches[0] || null;
      this.state = !s.watchTogetherEnabled ? 'disabled' : this.session ? 'following' : 'waiting';
      this.error = null;
      if (this.session) {
        const sample = this.clock.sample(this.session, this.now());
        this.position = Math.max(0, Math.min(this.session.duration || Infinity, sample.position + s.watchTogetherOffsetSeconds));
        if (sample.stale) throw new Error('Waiting for a fresh TV progress report. Companion paused.');
      } else this.clock.reset();
    } catch (err) {
      this.session = null; this.sessions = []; this.state = 'error'; this.error = err.message;
    }
    return this.status();
  }
  status() {
    const s = this.getSettings();
    return {
      enabled: s.watchTogetherEnabled, playerId: s.watchTogetherPlayerId,
      offsetSeconds: s.watchTogetherOffsetSeconds, state: this.state, error: this.error,
      session: this.session ? publicSession(this.session) : null,
      sessions: this.sessions.map(publicSession),
      companion: this.companion && this.now() - this.companion.at < 15000 ? this.companion : null,
    };
  }
  configure({ enabled, playerId, offsetSeconds = 0 }) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false.');
    if (typeof playerId !== 'string' || playerId.length > 256 || (enabled && !playerId.trim())) throw new Error('Choose the Plex TV to follow.');
    if (typeof offsetSeconds !== 'number' || !Number.isFinite(offsetSeconds) || Math.abs(offsetSeconds) > 30) throw new Error('Sync adjustment must be between -30 and 30 seconds.');
    this.setSettings({ watchTogetherEnabled: enabled, watchTogetherPlayerId: playerId.trim(), watchTogetherOffsetSeconds: offsetSeconds });
    this.clock.reset(); this.session = null; this.companion = null;
  }
  token() {
    let token = this.getSettings().watchTogetherToken;
    if (!token) { token = randomBytes(32).toString('hex'); this.setSettings({ watchTogetherToken: token }); }
    return token;
  }
  authorized(header) {
    const token = this.getSettings().watchTogetherToken;
    if (!token || !header?.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(header.slice(7)), expected = Buffer.from(token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  heartbeat({ state, error }) {
    if (!['waiting', 'loading', 'following', 'error'].includes(state)) throw new Error('Invalid companion state.');
    this.companion = { state, error: typeof error === 'string' ? error.slice(0, 250) : null, at: this.now() };
  }
  async bridge() {
    await this.refresh();
    return {
      enabled: this.getSettings().watchTogetherEnabled, state: this.state, error: this.error,
      session: this.session ? {
        ...publicSession(this.session), position: this.position,
        audioTrack: this.session.audioTrack, subtitleTrack: this.session.subtitleTrack,
      } : null,
    };
  }
}
