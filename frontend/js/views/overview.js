// Overview — the default landing view (#/).
//
// Answers "how is my signage doing?" at a glance: screens online/offline,
// what is playing where, content storage, and anything that needs attention.
// The getting-started checklist lives here now (it used to repeat on the
// Displays, Playlists and Content pages) with a single global dismissal.

import { api } from '../api.js';
import { esc, livenessBadge } from '../utils.js';
import { t } from '../i18n.js';
import * as gettingStarted from '../components/getting-started.js';

let cleanupFns = [];

export function cleanup() {
  cleanupFns.forEach((fn) => { try { fn(); } catch (_) {} });
  cleanupFns = [];
}

function fmtBytes(n) {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export async function render(app) {
  cleanup();

  app.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${esc(t('overview.title'))}</h1>
        <p class="subtitle">${esc(t('overview.subtitle'))}</p>
      </div>
    </div>
    <div id="ovGettingStarted"></div>
    <div class="ov-cards" id="ovCards"><div class="card"><p>${esc(t('common.loading'))}</p></div></div>
    <div class="ov-grid">
      <section class="card">
        <h2>${esc(t('overview.now_playing'))}</h2>
        <div id="ovNowPlaying"><p class="muted">${esc(t('common.loading'))}</p></div>
      </section>
      <section class="card">
        <h2>${esc(t('overview.needs_attention'))}</h2>
        <div id="ovAlerts"><p class="muted">${esc(t('common.loading'))}</p></div>
      </section>
    </div>`;

  // The checklist first — it is the one thing a brand-new account needs.
  try {
    const [devices0, playlists0] = await Promise.all([api.getDevices(), api.getPlaylists()]);
    await gettingStarted.mount(document.getElementById('ovGettingStarted'), {
      devices: devices0 || [],
      playlists: playlists0 || [],
    });
  } catch (_) { /* onboarding must never break the overview */ }

  let devices = [];
  let playlists = [];
  let content = [];
  try {
    const [d, pl, contentRes] = await Promise.all([
      api.getDevices().catch(() => []),
      api.getPlaylists().catch(() => []),
      api.getAllContent({ maxItems: 2000 }).catch(() => ({ items: [] })),
    ]);
    devices = Array.isArray(d) ? d : [];
    playlists = Array.isArray(pl) ? pl : [];
    // getAllContent resolves { items, truncated }, not a bare array.
    content = Array.isArray(contentRes) ? contentRes : (contentRes.items || []);
  } catch (_) {}

  const seen = new Map();
  for (const d of devices) seen.set(d.id, d);
  devices = Array.from(seen.values());

  const playlistById = new Map((playlists || []).map((p) => [p.id, p]));
  const online = devices.filter((d) => d.device_status === 'online');
  const offline = devices.filter((d) => d.device_status !== 'online' && d.device_status !== 'provisioning');
  const storageBytes = (content || []).reduce((sum, c) => sum + Number(c.file_size || 0), 0);

  // "Now playing": online devices pointed at a published playlist.
  const publishedIds = new Set((playlists || []).filter((p) => p.published_snapshot).map((p) => p.id));
  const playing = devices.filter((d) => d.playlist_id && publishedIds.has(d.playlist_id));

  // Alerts: offline screens, screens with nothing assigned, unpublished playlists.
  const alerts = [];
  for (const d of offline) {
    alerts.push({
      kind: 'offline',
      html: `<a href="#/device/${esc(d.id)}">${esc(d.device_name || d.name || t('overview.unnamed_screen'))}</a> ${esc(t('overview.alert_offline'))}`,
    });
  }
  for (const d of devices) {
    if (!d.playlist_id && d.device_status !== 'provisioning') {
      alerts.push({
        kind: 'empty',
        html: `<a href="#/device/${esc(d.id)}">${esc(d.device_name || d.name || t('overview.unnamed_screen'))}</a> ${esc(t('overview.alert_no_content'))}`,
      });
    }
  }
  for (const p of playlists || []) {
    if (!p.published_snapshot && Number(p.item_count || 0) > 0) {
      alerts.push({
        kind: 'unpublished',
        html: `<a href="#/playlists">${esc(p.name)}</a> ${esc(t('overview.alert_unpublished'))}`,
      });
    }
  }

  const cardsEl = document.getElementById('ovCards');
  if (cardsEl) {
    cardsEl.innerHTML = `
      <div class="card ov-stat">
        <div class="ov-stat-num">${online.length}<span class="ov-stat-total">/${devices.length}</span></div>
        <div class="ov-stat-label">${esc(t('overview.stat_screens'))}</div>
        ${offline.length ? `<div class="ov-stat-warn">${esc(t('overview.stat_offline', { n: offline.length }))}</div>` : ''}
      </div>
      <div class="card ov-stat">
        <div class="ov-stat-num">${playing.length}</div>
        <div class="ov-stat-label">${esc(t('overview.stat_playing'))}</div>
      </div>
      <div class="card ov-stat">
        <div class="ov-stat-num">${esc(fmtBytes(storageBytes))}</div>
        <div class="ov-stat-label">${esc(t('overview.stat_storage', { n: (content || []).length }))}</div>
      </div>
      <div class="card ov-stat ${alerts.length ? 'ov-stat-alert' : ''}">
        <div class="ov-stat-num">${alerts.length}</div>
        <div class="ov-stat-label">${esc(t('overview.stat_alerts'))}</div>
      </div>`;
  }

  const npEl = document.getElementById('ovNowPlaying');
  if (npEl) {
    npEl.innerHTML = playing.length
      ? `<ul class="ov-list">${playing.map((d) => {
        const p = playlistById.get(d.playlist_id);
        const b = livenessBadge(d, { short: true });
        return `<li>
          <span class="device-status-badge ${b.state}">${esc(b.label)}</span>
          <a href="#/device/${esc(d.id)}"><strong>${esc(d.device_name || d.name || t('overview.unnamed_screen'))}</strong></a>
          <span class="muted">— ${esc(p ? p.name : t('overview.unknown_playlist'))}</span>
        </li>`;
      }).join('')}</ul>`
      : `<p class="muted">${esc(t('overview.nothing_playing'))}</p>`;
  }

  const alEl = document.getElementById('ovAlerts');
  if (alEl) {
    alEl.innerHTML = alerts.length
      ? `<ul class="ov-list ov-alerts">${alerts.slice(0, 12).map((a) =>
        `<li class="ov-alert-${a.kind}">${a.html}</li>`).join('')}</ul>
        ${alerts.length > 12 ? `<p class="muted">+${alerts.length - 12} ${esc(t('overview.more'))}</p>` : ''}`
      : `<p class="muted">${esc(t('overview.all_clear'))}</p>`;
  }
}
