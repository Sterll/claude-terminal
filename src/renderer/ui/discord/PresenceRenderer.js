/**
 * Discord Rich Presence Renderer
 * Renders an activity card faithful to Discord's profile "Now Playing" widget:
 * large/small art, application name, details, state, party size, elapsed/remaining
 * timer and up to two activity buttons.
 */

const { escapeHtml, escapeAttr } = require('./EmbedRenderer');

const ACTIVITY_HEADERS = {
  playing: 'Playing a Game',
  listening: 'Listening to',
  watching: 'Watching',
  streaming: 'Streaming',
  competing: 'Competing in',
};

/** Return the first defined value among the given keys. */
function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

/** Normalize a timestamp (unix seconds, unix ms or ISO string) to epoch ms. */
function normalizeTs(ts) {
  if (ts === undefined || ts === null || ts === '') return null;
  const n = Number(ts);
  if (isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(ts);
  return isNaN(parsed) ? null : parsed;
}

/** Format a duration in ms as H:MM:SS or MM:SS. */
function formatElapsed(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function initialTimeText(startMs, endMs) {
  const now = Date.now();
  if (endMs) return `${formatElapsed(endMs - now)} left`;
  if (startMs) return `${formatElapsed(now - startMs)} elapsed`;
  return '';
}

/**
 * Render a Discord Rich Presence card.
 * @param {Object} data - Presence data object
 * @returns {string} HTML string
 */
function render(data) {
  if (!data || typeof data !== 'object') return '';

  const type = String(data.type || 'playing').toLowerCase();
  const headerBase = ACTIVITY_HEADERS[type] || ACTIVITY_HEADERS.playing;
  const name = pick(data, ['name', 'application', 'application_name', 'app']) || '';

  // For Listening/Watching/Competing, Discord folds the name into the header.
  let headerText = headerBase;
  if ((type === 'listening' || type === 'watching' || type === 'competing') && name) {
    headerText = `${headerBase} ${name}`;
  }

  const largeImage = pick(data, ['largeImage', 'large_image', 'largeImageUrl', 'large_image_url']);
  const largeText = pick(data, ['largeText', 'large_text']);
  const smallImage = pick(data, ['smallImage', 'small_image', 'smallImageUrl', 'small_image_url']);
  const smallText = pick(data, ['smallText', 'small_text']);
  const details = data.details || '';
  const state = data.state || '';

  // Party: { current, max } | { size: [cur, max] } | partySize: [cur, max]
  let party = data.party || null;
  if (!party && Array.isArray(data.partySize)) party = { current: data.partySize[0], max: data.partySize[1] };
  if (party && Array.isArray(party.size)) party = { current: party.size[0], max: party.size[1] };

  let stateLine = escapeHtml(state);
  if (party && (party.current || party.max)) {
    const cur = party.current || 0;
    const partyStr = party.max ? `${cur} of ${party.max}` : `${cur}`;
    stateLine += `${state ? ' ' : ''}<span class="dc-presence-party">(${partyStr})</span>`;
  }

  const startMs = normalizeTs(pick(data, ['start', 'startTimestamp', 'start_timestamp']));
  const endMs = normalizeTs(pick(data, ['end', 'endTimestamp', 'end_timestamp']));

  let html = '<div class="dc-presence">';
  html += `<div class="dc-presence-header dc-presence-${escapeAttr(type)}">${escapeHtml(headerText)}</div>`;
  html += '<div class="dc-presence-body">';

  // Artwork (large + small overlay)
  if (largeImage) {
    html += '<div class="dc-presence-art">';
    html += `<img class="dc-presence-large" src="${escapeAttr(largeImage)}" alt="${escapeAttr(largeText || name)}"${largeText ? ` title="${escapeAttr(largeText)}"` : ''}>`;
    if (smallImage) {
      html += `<img class="dc-presence-small" src="${escapeAttr(smallImage)}" alt="${escapeAttr(smallText || '')}"${smallText ? ` title="${escapeAttr(smallText)}"` : ''}>`;
    }
    html += '</div>';
  }

  // Info column
  html += '<div class="dc-presence-info">';
  if (name) html += `<div class="dc-presence-name">${escapeHtml(name)}</div>`;
  if (details) html += `<div class="dc-presence-details">${escapeHtml(details)}</div>`;
  if (state || party) html += `<div class="dc-presence-state">${stateLine}</div>`;
  if (startMs || endMs) {
    const attrs = [];
    if (startMs) attrs.push(`data-start="${startMs}"`);
    if (endMs) attrs.push(`data-end="${endMs}"`);
    html += `<div class="dc-presence-time" ${attrs.join(' ')}>${escapeHtml(initialTimeText(startMs, endMs))}</div>`;
  }
  html += '</div>'; // info
  html += '</div>'; // body

  // Buttons (max 2, Discord limit)
  if (Array.isArray(data.buttons) && data.buttons.length) {
    html += '<div class="dc-presence-buttons">';
    for (const btn of data.buttons.slice(0, 2)) {
      const label = escapeHtml(typeof btn === 'string' ? btn : (btn.label || ''));
      const url = typeof btn === 'object' && btn.url ? btn.url : '';
      if (url) {
        html += `<a class="dc-presence-btn" href="${escapeAttr(url)}" target="_blank" rel="noopener">${label}</a>`;
      } else {
        html += `<button class="dc-presence-btn">${label}</button>`;
      }
    }
    html += '</div>';
  }

  html += '</div>'; // presence
  return html;
}

module.exports = {
  render,
  formatElapsed,
  normalizeTs,
  ACTIVITY_HEADERS,
};
