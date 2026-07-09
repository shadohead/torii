/* Torii frontend - vanilla JS, no build step */
const $ = (s, el = document) => el.querySelector(s);
const GROUP_COLORS = ['#7FB4FA', '#B48CF2', '#F2A65A', '#6FDACB', '#E88CB0', '#9BD37F'];
const groupColor = (g) => {
  if (!g) return 'var(--muted)';
  let h = 0; for (const c of g) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const img = (u) => u ? `/img?u=${encodeURIComponent(u)}` : '';
const fmtBytes = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : (n / 1e6).toFixed(0) + ' MB';
const fmtSpeed = (n) => ((n || 0) / 1048576).toFixed(1) + ' MiB/s';
const fmtEta = (s) => s == null ? '' : s > 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.max(1, Math.ceil(s / 60))}m`;
const relTime = (ms) => {
  const s = Math.floor((ms - Date.now()) / 1000);
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), mi = Math.floor(s % 3600 / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${mi}m` : `${mi}m`;
};
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.status);
  return body;
};

let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2500);
}

/* ============ cards / home ============ */
function cardHTML(m, rank) {
  const topBadge = rank
    ? `<span class="rank-badge ${rank <= 3 ? 'top' : ''}">#${rank}</span>`
    : m.nextEp ? `<span class="ep-badge"><b>EP ${m.nextEp.ep}</b> · ${relTime(m.nextEp.airsAt)}</span>` : '';
  const score = rank && m.score ? `<span class="score-badge">★ ${(m.score / 10).toFixed(1)}</span>` : '';
  return `<div class="card" data-id="${m.id}"><div class="poster-wrap">
    ${topBadge}<img class="poster" loading="lazy" src="${img(m.poster)}" alt="">${score}</div>
    <div class="name">${esc(m.english || m.romaji)}</div></div>`;
}
const showCache = new Map();
function bindCards(el, list) {
  for (const m of list) showCache.set(m.id, m);
  el.onclick = (ev) => {
    const card = ev.target.closest('.card');
    if (card) openDetail(Number(card.dataset.id));
  };
}
async function loadHome() {
  try {
    const { airing, trending } = await api('/api/home');
    $('#rail-airing').innerHTML = airing.map(m => cardHTML(m)).join('');
    $('#grid-trending').innerHTML = trending.map(m => cardHTML(m)).join('');
    bindCards($('#rail-airing'), airing);
    bindCards($('#grid-trending'), trending);
  } catch (err) {
    $('#rail-airing').innerHTML = `<div class="empty">Couldn't reach AniList: ${esc(err.message)}</div>`;
  }
}

/* ============ browse charts ============ */
const SEASON_NAMES = ['Winter', 'Spring', 'Summer', 'Fall'];
const AL_SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
function currentSeason(offset = 0) {
  const now = new Date();
  let idx = Math.floor(now.getMonth() / 3) + offset;
  let year = now.getFullYear() + Math.floor(idx / 4);
  idx = ((idx % 4) + 4) % 4;
  return { season: AL_SEASONS[idx], year, label: `${SEASON_NAMES[idx]} ${year}` };
}
const CHART_LIST = [
  { key: 'home', label: '⛩ Now' },
  { key: 'this-season', label: 'This Season', title: () => currentSeason().label, jp: '今期' },
  { key: 'trending', label: 'Trending', title: () => 'Trending now', jp: '急上昇' },
  { key: 'top-rated', label: 'Top Rated', title: () => 'Top rated · all time', jp: '最高評価' },
  { key: 'popular', label: 'Most Popular', title: () => 'Most popular · all time', jp: '人気' },
  { key: 'upcoming', label: 'Upcoming', title: () => 'Upcoming', jp: '今後' },
  { key: 'movies', label: 'Movies', title: () => 'Top movies', jp: '映画' },
  { key: 'seasons', label: 'Past Seasons', title: () => browse.seasonLabel, jp: '季節' },
];
const browse = { key: 'home', page: 1, items: [], hasNext: false, season: null, year: null, seasonLabel: '', sort: 'season', loading: false };

function renderChips() {
  $('#chart-chips').innerHTML = CHART_LIST.map(c =>
    `<button class="cchip ${browse.key === c.key ? 'on' : ''}" data-key="${c.key}">${c.label}</button>`).join('');
  const seasonsMode = browse.key === 'seasons';
  $('#season-chips').style.display = seasonsMode ? '' : 'none';
  if (seasonsMode) {
    const opts = Array.from({ length: 12 }, (_, i) => currentSeason(-1 - i));
    $('#season-chips').innerHTML =
      `<button class="cchip ${browse.sort === 'season' ? 'on' : ''}" data-sort="season">Popular</button>` +
      `<button class="cchip ${browse.sort === 'season-rated' ? 'on' : ''}" data-sort="season-rated">Top Rated</button>` +
      opts.map(o => `<button class="cchip ${browse.season === o.season && browse.year === o.year ? 'on' : ''}"
        data-season="${o.season}" data-year="${o.year}">${o.label}</button>`).join('');
  }
}
$('#chart-chips').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.cchip'); if (!btn) return;
  $('#q').value = '';
  browse.key = btn.dataset.key;
  if (browse.key === 'seasons' && !browse.season) {
    const last = currentSeason(-1);
    browse.season = last.season; browse.year = last.year; browse.seasonLabel = last.label;
  }
  resetBrowse();
});
$('#season-chips').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.cchip'); if (!btn) return;
  if (btn.dataset.sort) browse.sort = btn.dataset.sort;
  else {
    browse.season = btn.dataset.season; browse.year = Number(btn.dataset.year);
    browse.seasonLabel = btn.textContent;
  }
  resetBrowse();
});
function resetBrowse() {
  browse.page = 1; browse.items = [];
  renderChips();
  syncHomeVisibility();
  if (browse.key !== 'home') loadBrowse();
}
function browseParams() {
  const cur = currentSeason();
  if (browse.key === 'this-season') return { chart: 'season', season: cur.season, year: cur.year };
  if (browse.key === 'seasons') return { chart: browse.sort, season: browse.season, year: browse.year };
  return { chart: browse.key };
}
async function loadBrowse() {
  if (browse.loading) return;
  browse.loading = true;
  const def = CHART_LIST.find(c => c.key === browse.key);
  $('#browse-title').textContent = def.title ? def.title() : '';
  $('#browse-sub').textContent = def.jp || '';
  if (browse.page === 1) $('#grid-browse').innerHTML = '<div class="empty" style="grid-column:1/-1">Loading...</div>';
  try {
    const p = new URLSearchParams({ ...browseParams(), page: browse.page });
    const res = await api('/api/browse?' + p);
    browse.items.push(...res.items);
    browse.hasNext = res.hasNext;
    $('#grid-browse').innerHTML = browse.items.map((m, i) => cardHTML(m, i + 1)).join('') ||
      '<div class="empty" style="grid-column:1/-1">Nothing here.</div>';
    bindCards($('#grid-browse'), browse.items);
    $('#browse-more').style.display = browse.hasNext ? '' : 'none';
  } catch (err) {
    $('#grid-browse').innerHTML = `<div class="empty" style="grid-column:1/-1">Failed: ${esc(err.message)}</div>`;
  }
  browse.loading = false;
}
$('#browse-more').onclick = () => { browse.page++; loadBrowse(); };
function syncHomeVisibility() {
  const q = $('#q').value.trim();
  $('#home-results').style.display = q ? '' : 'none';
  $('#home-rails').style.display = !q && browse.key === 'home' ? '' : 'none';
  $('#home-browse').style.display = !q && browse.key !== 'home' ? '' : 'none';
}

/* ============ search ============ */
let searchT;
$('#q').addEventListener('input', (ev) => {
  clearTimeout(searchT);
  const q = ev.target.value.trim();
  if (!q) { syncHomeVisibility(); return; }
  searchT = setTimeout(async () => {
    try {
      const results = await api('/api/search?q=' + encodeURIComponent(q));
      if ($('#q').value.trim() !== q) return;
      $('#home-rails').style.display = 'none';
      $('#home-browse').style.display = 'none';
      $('#home-results').style.display = '';
      $('#res-count').textContent = results.length ? `${results.length} from AniList` : '';
      $('#grid-results').innerHTML = results.map(m => cardHTML(m)).join('') ||
        `<div class="empty" style="grid-column:1/-1"><span class="big">⛩</span>Nothing on AniList for "${esc(q)}".</div>`;
      bindCards($('#grid-results'), results);
    } catch (err) { toast('Search failed: ' + err.message); }
  }, 350);
});

/* ============ detail ============ */
let cur = null, curPick = { group: null, q: null }, curReleases = [];
async function openDetail(id) {
  const m = showCache.get(id) || {};
  cur = { id, ...m };
  $('#detail').innerHTML = `<div class="detail-inner">
    <div class="banner">${m.banner ? `<img src="${img(m.banner)}" alt="">` : ''}<div class="scrim"></div>
      <button class="back-btn" onclick="closeDetail()">←</button></div>
    <div class="detail-head"><img src="${img(m.poster)}" alt="">
      <div class="t"><h1>${esc(m.english || m.romaji || '...')}</h1><p class="native">${esc(m.native || '')}</p></div></div>
    <div class="chips" id="d-chips"></div>
    <div id="d-body"><div class="empty">Searching nyaa.si...</div></div></div>`;
  $('#detail').classList.add('open');
  document.body.style.overflow = 'hidden';
  try {
    const { show, releases } = await api('/api/show/' + id);
    if (!$('#detail').classList.contains('open') || cur.id !== id) return;
    cur = show; showCache.set(show.id, show); curReleases = releases;
    renderDetail(show, releases);
  } catch (err) {
    $('#d-body').innerHTML = `<div class="empty">nyaa.si unreachable: ${esc(err.message)}</div>`;
  }
}
function renderDetail(m, releases) {
  $('#d-chips').innerHTML = [
    `<span class="chip">${esc(m.format || 'TV')} · ${m.year || ''}</span>`,
    m.score ? `<span class="chip"><span class="star">★</span> ${(m.score / 10).toFixed(1)}</span>` : '',
    `<span class="chip">${m.episodes ? m.episodes + ' eps' : 'ongoing'}</span>`,
    m.nextEp ? `<span class="chip">EP ${m.nextEp.ep} in ${relTime(m.nextEp.airsAt)}</span>` : '',
    ...(m.genres || []).map(g => `<span class="chip">${esc(g)}</span>`),
  ].join('');

  const singles = releases.filter(r => !r.parsed.batch && r.parsed.episode != null);
  const batches = releases.filter(r => r.parsed.batch || r.parsed.episode == null);

  // groups by presence, best-seeded first
  const groupSeeds = {};
  for (const r of singles) if (r.parsed.group) groupSeeds[r.parsed.group] = (groupSeeds[r.parsed.group] || 0) + r.seeders;
  const groups = Object.entries(groupSeeds).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([g]) => g);
  const qualities = [...new Set(singles.map(r => r.parsed.quality).filter(Boolean))]
    .sort((a, b) => parseInt(b) - parseInt(a)).slice(0, 3);
  const preferred = (appSettings.preferredGroups || []).find(p => groups.some(g => g.toLowerCase() === p.toLowerCase()));
  curPick = {
    group: preferred || groups[0] || 'SubsPlease',
    q: qualities.includes(appSettings.defaultQuality) ? appSettings.defaultQuality : (qualities[0] || '1080p'),
  };

  const watched = wlState.some(w => w.anilist_id === m.id);
  const byEp = new Map();
  for (const r of singles) {
    const k = r.parsed.episode;
    if (!byEp.has(k)) byEp.set(k, []);
    byEp.get(k).push(r);
  }
  const eps = [...byEp.keys()].sort((a, b) => b - a).slice(0, 8);
  // Finished/older shows are usually best grabbed as a complete batch.
  const startBatch = batches.length > 0 && (eps.length === 0 || m.status === 'FINISHED');

  $('#d-body').innerHTML = `
    ${m.synopsis ? `<p class="synopsis">${esc(m.synopsis)}</p>` : ''}
    <div class="watch-panel">
      <div class="lbl">Pin for auto-download</div>
      <div class="row" id="pick-group">${groups.map(g =>
        `<button class="pick ${g === curPick.group ? 'on' : ''}" data-g="${esc(g)}">[${esc(g)}]</button>`).join('') || '<span class="chip">no groups found yet</span>'}</div>
      <div class="row" style="margin-top:6px" id="pick-q">${qualities.map(q =>
        `<button class="pick ${q === curPick.q ? 'on' : ''}" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <button class="btn-watch ${watched ? 'added' : ''}" id="btn-watch">
        ${watched ? '✓ On watchlist · auto-downloading' : '★ Add to watchlist'}</button>
    </div>
    <div class="seg"><button class="${startBatch ? '' : 'on'}" data-seg="eps">Episodes</button><button class="${startBatch ? 'on' : ''}" data-seg="batch">Batches</button></div>
    <div id="rel-eps" ${startBatch ? 'style="display:none"' : ''}>${eps.map(e => `
      <div class="ep-head"><h3>Episode ${e}</h3><span>${e === eps[0] ? 'latest' : ''}</span></div>
      ${byEp.get(e).sort((a, b) => b.seeders - a.seeders).slice(0, 5).map(relRow).join('')}`).join('') ||
      '<div class="empty">No individual episodes found on nyaa.</div>'}</div>
    <div id="rel-batch" ${startBatch ? '' : 'style="display:none"'}>
      <div class="ep-head"><h3>Batches & packs</h3><span>${batches.length}</span></div>
      ${batches.sort((a, b) => b.seeders - a.seeders).slice(0, 12).map(relRow).join('') ||
      '<div class="empty">No batches yet - they usually appear after a season ends.</div>'}</div>`;

  $('#pick-group').onclick = (ev) => pickChip(ev, 'group', 'g');
  $('#pick-q').onclick = (ev) => pickChip(ev, 'q', 'q');
  $('#btn-watch').onclick = toggleWatch;
  $('.seg').onclick = (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
    $('#rel-eps').style.display = b.dataset.seg === 'eps' ? '' : 'none';
    $('#rel-batch').style.display = b.dataset.seg === 'batch' ? '' : 'none';
  };
  for (const el of document.querySelectorAll('.rel .dl-btn')) el.onclick = () => downloadRelease(el);
  paintPicks();
}
function pickChip(ev, key, attr) {
  const b = ev.target.closest('.pick'); if (!b) return;
  curPick[key] = b.dataset[attr];
  b.parentElement.querySelectorAll('.pick').forEach(x => x.classList.toggle('on', x === b));
  paintPicks();
}
function paintPicks() {
  document.querySelectorAll('#pick-group .pick').forEach(b => {
    b.style.color = b.classList.contains('on') ? groupColor(b.dataset.g) : '';
  });
}
function relRow(r) {
  const g = r.parsed.group;
  const age = r.pubDate ? Math.round((Date.now() - r.pubDate) / 86400e3) : null;
  return `<div class="rel"><div class="fn">
      <span class="file"><span class="grp" style="color:${groupColor(g)}">${g ? `[${esc(g)}]` : ''}</span>${esc(r.title.replace(`[${g}]`, ''))}</span>
      <span class="meta"><span>${esc(r.sizeText || '')}</span><span class="seeds">▲ ${r.seeders}</span>${age != null ? `<span>${age === 0 ? 'today' : age + 'd ago'}</span>` : ''}${r.trusted ? '<span class="trusted">✓ trusted</span>' : ''}</span>
    </div><button class="dl-btn" data-hash="${esc(r.infoHash || '')}" aria-label="Download">↓</button></div>`;
}
async function downloadRelease(btn) {
  if (btn.classList.contains('q')) return;
  const r = curReleases.find(x => x.infoHash === btn.dataset.hash);
  if (!r) return;
  btn.disabled = true;
  try {
    const res = await api('/api/download', { method: 'POST', body: {
      title: r.title, torrentUrl: r.torrentUrl, infoHash: r.infoHash, size: r.size, parsed: r.parsed,
      showTitle: cur.english || cur.romaji, anilistId: cur.id,
    }});
    if (res.ok) { btn.classList.add('q'); btn.textContent = '✓'; toast('Queued · downloading to Plex'); refreshDownloads(); }
    else toast(res.reason || 'Could not start');
  } catch (err) { toast('Failed: ' + err.message); }
  btn.disabled = false;
}
function closeDetail() { $('#detail').classList.remove('open'); document.body.style.overflow = ''; }
window.closeDetail = closeDetail;

/* ============ watchlist ============ */
let wlState = [];
async function toggleWatch() {
  const on = wlState.some(w => w.anilist_id === cur.id);
  try {
    if (on) { await api('/api/watchlist/' + cur.id, { method: 'DELETE' }); toast('Removed from watchlist'); }
    else {
      await api('/api/watchlist', { method: 'POST', body: { anilistId: cur.id, group: curPick.group, quality: curPick.q } });
      toast(`Watching · new eps auto-download as [${curPick.group}] ${curPick.q}`);
    }
    await refreshWatchlist();
    const b = $('#btn-watch');
    b.classList.toggle('added', !on);
    b.textContent = !on ? '✓ On watchlist · auto-downloading' : '★ Add to watchlist';
  } catch (err) { toast('Failed: ' + err.message); }
}
async function refreshWatchlist() {
  wlState = await api('/api/watchlist');
  const list = $('#wl-list');
  if (!wlState.length) {
    list.innerHTML = `<div class="empty"><span class="big">★</span>Nothing tracked yet.<br>Open a show and add it - new episodes download themselves.</div>`;
    return;
  }
  list.innerHTML = wlState.map((w) => {
    const airing = w.next_airing_at && w.next_airing_at > Date.now();
    const next = airing ? `next <b>EP ${w.next_ep}</b> in ${relTime(w.next_airing_at)}`
      : w.show_status === 'FINISHED' ? '<span class="done">✓ finished airing</span>'
      : 'checking for new episodes';
    return `<div class="wl-card" data-id="${w.anilist_id}">
      <img src="${img(w.poster)}" alt="">
      <div class="mid"><h3>${esc(w.title)}</h3>
        <div class="pins"><span class="pin" style="color:${groupColor(w.group_name)}">[${esc(w.group_name)}]</span><span class="pin">${esc(w.quality)}</span><span class="pin act" data-act="check">check now</span></div>
        <div class="next">${next} · have ≤ ${w.last_episode}</div></div>
      <div class="wl-side">
        <button class="wl-x" data-act="rm" aria-label="Remove">✕</button>
        <div><div class="toggle ${w.auto ? 'on' : ''}" data-act="auto" role="switch" aria-checked="${!!w.auto}"></div>
        <div class="toggle-lbl" style="text-align:center;margin-top:3px">AUTO</div></div></div></div>`;
  }).join('');
}
$('#wl-list').addEventListener('click', async (ev) => {
  const card = ev.target.closest('.wl-card'); if (!card) return;
  const id = Number(card.dataset.id);
  const act = ev.target.closest('[data-act]')?.dataset.act;
  const row = wlState.find(w => w.anilist_id === id);
  try {
    if (act === 'rm') { await api('/api/watchlist/' + id, { method: 'DELETE' }); toast('Removed'); refreshWatchlist(); }
    else if (act === 'auto') { await api('/api/watchlist/' + id, { method: 'PATCH', body: { auto: !row.auto } }); refreshWatchlist(); }
    else if (act === 'check') {
      ev.target.textContent = 'checking...';
      const res = await api(`/api/watchlist/${id}/check`, { method: 'POST' });
      toast(res.grabbed ? `Grabbed ${res.grabbed} new episode(s)` : 'No new episodes yet');
      refreshWatchlist(); refreshDownloads();
    }
    else openDetail(id);
  } catch (err) { toast('Failed: ' + err.message); }
});

/* ============ downloads ============ */
let dlState = [];
const ACTIVE_ST = ['queued', 'downloading', 'moving'];
async function refreshDownloads() {
  dlState = await api('/api/downloads');
  renderDownloads();
}
function renderDownloads() {
  const act = dlState.filter(d => ACTIVE_ST.includes(d.status));
  const done = dlState.filter(d => ['seeding', 'done'].includes(d.status));
  const err = dlState.filter(d => d.status === 'error');
  $('#dl-active-count').textContent = act.length ? `${act.length} running` : '';
  $('#dl-active').innerHTML = [...act, ...err].map(d => `
    <div class="dlrow" data-id="${d.id}">
      <div class="fn">${esc(d.release_title)}</div>
      ${d.status === 'error'
        ? `<div class="stats"><span class="err">✕ ${esc(d.error || 'failed')}</span></div>`
        : `<div class="bar"><i style="width:${(d.progress * 100).toFixed(1)}%"></i></div>
           <div class="stats">
             <span class="spd">▼ ${fmtSpeed(d.speed)}</span>
             <span class="pct">${(d.progress * 100).toFixed(0)}%</span>
             <span class="eta">${d.status === 'queued' ? 'connecting...' : 'eta ' + fmtEta(d.eta)}</span>
             <span>${d.peers || 0} peers</span>
           </div>`}
      <button class="dl-x" data-act="cancel" aria-label="Cancel">✕</button>
    </div>`).join('') || `<div class="empty">Nothing downloading.</div>`;
  $('#dl-done').innerHTML = done.slice(0, 30).map(d => {
    const paths = JSON.parse(d.final_paths || '[]');
    return `<div class="dlrow" data-id="${d.id}">
      <div class="fn">${esc(d.release_title)}</div>
      <div class="bar full"><i style="width:100%"></i></div>
      <div class="stats"><span class="ok">✓ in Plex${d.status === 'seeding' ? ' · seeding back' : ''}</span></div>
      ${paths[0] ? `<div class="path">${esc(paths[0])}</div>` : ''}
      ${d.status === 'seeding' ? '<button class="dl-x" data-act="cancel" aria-label="Stop seeding">✕</button>' : ''}
    </div>`;
  }).join('') || `<div class="empty">Completed episodes appear here, renamed and scanned into Plex.</div>`;
  const badge = $('#dl-badge');
  badge.style.display = act.length ? '' : 'none';
  badge.textContent = act.length;
}
$('#scr-dl').addEventListener('click', async (ev) => {
  if (ev.target.dataset.act !== 'cancel') return;
  const id = Number(ev.target.closest('.dlrow').dataset.id);
  await api('/api/downloads/' + id, { method: 'DELETE' });
  refreshDownloads();
});

/* ============ SSE live updates ============ */
let es;
function connectSSE() {
  es = new EventSource('/api/events');
  es.addEventListener('progress', (ev) => {
    const p = JSON.parse(ev.data);
    const row = document.querySelector(`.dlrow[data-id="${p.id}"]`);
    if (!row) return;
    const bar = row.querySelector('.bar i');
    if (bar) bar.style.width = (p.progress * 100).toFixed(1) + '%';
    const set = (sel, txt) => { const el = row.querySelector(sel); if (el) el.textContent = txt; };
    set('.spd', '▼ ' + fmtSpeed(p.speed));
    set('.pct', (p.progress * 100).toFixed(0) + '%');
    set('.eta', 'eta ' + fmtEta(p.eta));
  });
  es.addEventListener('download', () => refreshDownloads().catch(() => {}));
  es.addEventListener('watchlist', (ev) => {
    const w = JSON.parse(ev.data);
    if (w.action === 'grabbed') toast(`⛩ Auto-grabbed EP ${w.episode}`);
    refreshWatchlist().catch(() => {});
  });
  es.onerror = () => { es.close(); setTimeout(connectSSE, 5000); };
}

/* ============ setup ============ */
async function renderSetup() {
  try {
    const [status, settings] = await Promise.all([api('/api/status'), api('/api/settings')]);
    const freeGB = status.free / 1e9;
    const totalGB = (status.diskTotal || 0) / 1e9;
    const usedPct = totalGB ? Math.min(100, Math.max(3, 100 - freeGB / totalGB * 100)) : 3;
    $('#plex-pill').innerHTML = `<span class="dot ${status.plex.running ? '' : 'off'}"></span>Plex`;
    $('#setup-body').innerHTML = `
    <div class="set-card">
      <h3>Plex server</h3>
      <div class="kv"><span class="k">Status</span><span class="v ${status.plex.running ? 'ok' : 'bad'}">${status.plex.running ? '● connected · v' + esc(status.plex.version) : '○ not running'}</span></div>
      <div class="kv"><span class="k">Library</span><span class="v">${esc(status.libraryDir)}</span></div>
      <div class="kv"><span class="k">Token</span><span class="v ${settings.plexToken ? 'ok' : ''}">${settings.plexToken ? 'found · instant scans' : 'not found - set below'}</span></div>
      <div class="kv"><span class="k">Server URL</span>
        <input class="v-input" id="s-plex-url" type="text" value="${esc(settings.plexUrl || '')}" spellcheck="false" autocapitalize="off"></div>
      <div class="kv"><span class="k">Plex token</span>
        <input class="v-input" id="s-plex-token" type="text" value="${esc(settings.plexToken || '')}" placeholder="auto-discovered on macOS" spellcheck="false" autocapitalize="off"></div>
      <div class="btn-row">
        <button class="sbtn" id="plex-start" ${status.plex.running ? 'disabled' : ''}>▶ Start Plex</button>
        <button class="sbtn" id="plex-scan">⟳ Scan library now</button>
      </div>
    </div>
    <div class="set-card">
      <h3>Library folder</h3>
      <input class="wide-input" id="s-dir" type="text" value="${esc(settings.libraryDir)}" spellcheck="false" autocapitalize="off">
      <div class="kv"><span class="k">Downloads land in</span><span class="v">&lt;folder&gt;/Show/Season XX/</span></div>
      <div class="btn-row"><button class="sbtn" id="dir-save">Save folder</button></div>
    </div>
    <div class="set-card">
      <h3>Storage</h3>
      <div class="store-bar"><i style="width:${usedPct}%"></i></div>
      <div class="kv"><span class="k">Free on volume</span><span class="v">${freeGB.toFixed(0)}${totalGB ? ' / ' + totalGB.toFixed(0) : ''} GB</span></div>
      <div class="kv"><span class="k">Active torrents</span><span class="v">${status.activeTorrents}</span></div>
    </div>
    <div class="set-card">
      <h3>Behavior</h3>
      <div class="kv"><span class="k">Start Torii at login</span><div class="toggle ${status.loginItem.installed ? 'on' : ''}" id="t-login" role="switch"></div></div>
      <div class="kv"><span class="k">Keep Plex running</span><div class="toggle ${settings.keepPlexRunning ? 'on' : ''}" id="t-plex" role="switch"></div></div>
      <div class="kv"><span class="k">Watchlist auto-download</span><div class="toggle ${settings.autoDownload ? 'on' : ''}" id="t-auto" role="switch"></div></div>
    </div>
    <div class="set-card">
      <h3>Downloads</h3>
      <div class="kv"><span class="k">Default quality</span>
        <select id="s-quality">${['1080p', '720p'].map(q => `<option ${settings.defaultQuality === q ? 'selected' : ''}>${q}</option>`).join('')}</select></div>
      <div class="kv"><span class="k">Download limit</span>
        <select id="s-dl-limit">${[[0, 'unlimited'], [2048, '2 MB/s'], [5120, '5 MB/s'], [10240, '10 MB/s']].map(([v, l]) =>
          `<option value="${v}" ${Number(settings.downloadLimitKBs) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="kv"><span class="k">Upload limit</span>
        <select id="s-upload">${[[0, 'unlimited'], [256, '256 KB/s'], [512, '512 KB/s'], [1024, '1 MB/s']].map(([v, l]) =>
          `<option value="${v}" ${settings.uploadLimitKBs === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="kv"><span class="k">Peer connections</span>
        <select id="s-conns">${[20, 30, 50].map(v =>
          `<option value="${v}" ${Number(settings.maxConns) === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="kv"><span class="k">Seed back until</span>
        <select id="s-ratio">${[[0, "Don't seed"], [0.5, 'ratio 0.5'], [1, 'ratio 1.0'], [2, 'ratio 2.0'], [3, 'ratio 3.0']].map(([v, l]) =>
          `<option value="${v}" ${Number(settings.seedRatio) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="kv"><span class="k">Seed time limit</span>
        <select id="s-seedtime">${[[1, '1 hour'], [6, '6 hours'], [12, '12 hours'], [24, '24 hours'], [72, '3 days']].map(([v, l]) =>
          `<option value="${v}" ${Number(settings.seedMaxHours) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="kv"><span class="k">Watchlist check</span>
        <select id="s-poll">${[[15, 'every 15 min'], [30, 'every 30 min'], [60, 'every hour']].map(([v, l]) =>
          `<option value="${v}" ${Number(settings.pollMinutes) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="kv"><span class="k">Preferred groups</span>
        <input class="v-input" id="s-groups" type="text" value="${esc((settings.preferredGroups || []).join(', '))}" spellcheck="false" autocapitalize="off"></div>
      <div class="kv"><span class="k"></span><span class="v">speed/connection changes apply to new torrent sessions</span></div>
    </div>
    <div class="set-card">
      <h3>Tips</h3>
      <div class="kv"><span class="k">On this phone</span><span class="v">Share → Add to Home Screen</span></div>
      <div class="kv"><span class="k">Plex library</span><span class="v">add folder as "TV Shows" type</span></div>
    </div>`;
    $('#plex-start').onclick = async () => { await api('/api/plex/start', { method: 'POST' }); toast('Starting Plex...'); setTimeout(renderSetup, 4000); };
    $('#plex-scan').onclick = async () => { const r = await api('/api/plex/scan', { method: 'POST' }); toast(r.ok ? `Scanning "${r.section}"` : (r.reason || 'Scan failed')); };
    $('#t-login').onclick = async (ev) => {
      const on = !ev.target.classList.contains('on');
      const r = await api('/api/login-item', { method: 'POST', body: { enabled: on } });
      ev.target.classList.toggle('on', r.installed);
      toast(r.installed ? 'Torii will start at login' : 'Removed from login items');
    };
    $('#t-plex').onclick = (ev) => patchToggle(ev, 'keepPlexRunning');
    $('#t-auto').onclick = (ev) => patchToggle(ev, 'autoDownload');
    $('#s-quality').onchange = (ev) => api('/api/settings', { method: 'PATCH', body: { defaultQuality: ev.target.value } });
    $('#s-upload').onchange = (ev) => api('/api/settings', { method: 'PATCH', body: { uploadLimitKBs: Number(ev.target.value) } });
    $('#s-ratio').onchange = (ev) => { api('/api/settings', { method: 'PATCH', body: { seedRatio: Number(ev.target.value) } }); toast(Number(ev.target.value) === 0 ? 'Seeding off - active seeds stop within a minute' : 'Seed policy updated'); };
    $('#s-seedtime').onchange = (ev) => api('/api/settings', { method: 'PATCH', body: { seedMaxHours: Number(ev.target.value) } });
    $('#s-dl-limit').onchange = (ev) => api('/api/settings', { method: 'PATCH', body: { downloadLimitKBs: Number(ev.target.value) } });
    $('#s-conns').onchange = (ev) => api('/api/settings', { method: 'PATCH', body: { maxConns: Number(ev.target.value) } });
    $('#s-poll').onchange = (ev) => api('/api/settings', { method: 'PATCH', body: { pollMinutes: Number(ev.target.value) } });
    $('#s-groups').onchange = (ev) => {
      const groups = ev.target.value.split(',').map(s => s.trim().replace(/^\[|\]$/g, '')).filter(Boolean);
      api('/api/settings', { method: 'PATCH', body: { preferredGroups: groups } });
      toast('Preferred groups: ' + groups.map(g => '[' + g + ']').join(' › '));
    };
    $('#s-plex-url').onchange = async (ev) => {
      const plexUrl = ev.target.value.trim() || 'http://127.0.0.1:32400';
      await api('/api/settings', { method: 'PATCH', body: { plexUrl } });
      toast('Plex URL saved'); renderSetup();
    };
    $('#s-plex-token').onchange = async (ev) => {
      // The masked value round-trips harmlessly: the server ignores tokens containing '•'.
      await api('/api/settings', { method: 'PATCH', body: { plexToken: ev.target.value.trim() } });
      toast('Plex token saved'); renderSetup();
    };
    $('#dir-save').onclick = async () => {
      const dir = $('#s-dir').value.trim();
      try {
        const r = await api('/api/library-dir', { method: 'POST', body: { dir } });
        if (!r.ok) return toast(r.reason);
        toast(r.covered
          ? `Saved · in Plex library "${r.covered}" · ${(r.free / 1e9).toFixed(0)} GB free`
          : 'Saved · no Plex library covers this folder yet');
        renderSetup();
      } catch (err) { toast('Failed: ' + err.message); }
    };
  } catch (err) {
    $('#setup-body').innerHTML = `<div class="empty">Failed to load: ${esc(err.message)}</div>`;
  }
}
async function patchToggle(ev, key) {
  const on = !ev.target.classList.contains('on');
  await api('/api/settings', { method: 'PATCH', body: { [key]: on } });
  ev.target.classList.toggle('on', on);
}

/* ============ tabs ============ */
document.querySelectorAll('nav.tabs button').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('on', b === btn));
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === 'scr-' + btn.dataset.scr));
  closeDetail(); window.scrollTo(0, 0);
  if (btn.dataset.scr === 'dl') refreshDownloads().catch(() => {});
  if (btn.dataset.scr === 'watch') refreshWatchlist().catch(() => {});
  if (btn.dataset.scr === 'setup') renderSetup();
}));

/* ============ boot ============ */
let appSettings = { preferredGroups: ['SubsPlease', 'Erai-raws'], defaultQuality: '1080p' };
api('/api/settings').then(s => { appSettings = s; }).catch(() => {});
loadHome();
renderChips();
refreshWatchlist().catch(() => {});
refreshDownloads().catch(() => {});
connectSSE();
api('/api/status').then(s => {
  $('#plex-pill').innerHTML = `<span class="dot ${s.plex.running ? '' : 'off'}"></span>Plex`;
}).catch(() => {});
setInterval(() => { if ($('#scr-watch').classList.contains('on')) refreshWatchlist().catch(() => {}); }, 60000);
