/**
 * What's new, after the restart.
 *
 * The updater already fetches the release notes and offers them in the update
 * banner — but that is shown *before* the install, so anyone who clicks
 * "Restart to update" without expanding it never learns what changed. The
 * 1.3.0 Files screen made the cost of that concrete: the file explorer moved
 * and people wrote in asking where their files had gone.
 *
 * So this runs once per version, at launch, after the update has landed:
 *
 *  - **What moved** comes first and is local (MOVES below). It is the part
 *    people need, it has to work offline, and each entry carries the button
 *    that takes you there — a changelog line saying a thing moved is not the
 *    same as being able to press "Show me".
 *  - **The release notes** follow, fetched from GitHub, and are simply left out
 *    when there is no network. They are the nice-to-have half.
 *
 * Every version between the one last seen and the one now running is
 * considered, so skipping three releases still surfaces all three moves.
 */

const { t } = require('../../i18n');
const { escapeHtml } = require('../../utils');
const { settingsState, saveSettings, getSetting } = require('../../state/settings.state');
const markdown = require('../../services/markdown');

const api = window.electron_api;

/**
 * Things that moved, by the version that moved them.
 *
 * Only entries worth interrupting someone for: a screen that changed address,
 * a control that is no longer where it was. Not a feature list — the release
 * notes below already are one.
 *
 * `action` is resolved by the host (see setCallbacks), because opening a screen
 * belongs to the renderer's navigation, not to a modal.
 */
const MOVES = {
  '1.3.0': [
    {
      titleKey: 'whatsNew.moves.filesScreen.title',
      bodyKey: 'whatsNew.moves.filesScreen.body',
      action: { type: 'tab', tab: 'files', labelKey: 'whatsNew.showMe' },
    },
  ],
  '1.3.1': [
    {
      titleKey: 'whatsNew.moves.filesDock.title',
      bodyKey: 'whatsNew.moves.filesDock.body',
      action: { type: 'setting', setting: 'filesDockedInChat', labelKey: 'whatsNew.turnItOn' },
    },
  ],
};

const _callbacks = { onOpenTab: null, onOpenSetting: null };
function setCallbacks(cbs) { Object.assign(_callbacks, cbs); }

/**
 * Compare two `x.y.z` strings.
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

/** Every move introduced after `from` and no later than `to`. */
function movesBetween(from, to) {
  return Object.keys(MOVES)
    .filter(v => (!from || compareVersions(v, from) > 0) && compareVersions(v, to) <= 0)
    .sort(compareVersions)
    .flatMap(v => MOVES[v].map(m => ({ ...m, version: v })));
}

/**
 * Should the panel open for this launch?
 *
 * A fresh install has nothing to catch up on, so it only records the version.
 * The catch: `lastSeenVersion` did not exist before this feature, so on the
 * first launch that has it, every existing user looks like a fresh install.
 * Having projects already is what tells the two apart — and it is exactly the
 * upgrade where the moves matter most.
 *
 * @param {string} current - the running version
 * @param {string|null} lastSeen
 * @param {boolean} hasHistory - does this profile predate the launch?
 */
function shouldShow(current, lastSeen, hasHistory) {
  if (!current) return false;
  if (!lastSeen) return hasHistory;
  return compareVersions(current, lastSeen) > 0;
}

function _moveHtml(move) {
  const label = move.action ? escapeHtml(t(move.action.labelKey)) : '';
  const button = move.action
    ? `<button class="whats-new-move-action" data-move-action="${escapeHtml(JSON.stringify(move.action))}">${label}</button>`
    : '';
  return `<div class="whats-new-move">
    <div class="whats-new-move-text">
      <div class="whats-new-move-title">${escapeHtml(t(move.titleKey))}</div>
      <div class="whats-new-move-body">${escapeHtml(t(move.bodyKey))}</div>
    </div>
    ${button}
  </div>`;
}

/**
 * Build the panel body. The notes are optional: offline, the moves alone are
 * still worth showing, and an empty shell would not be.
 */
function buildHtml(moves, notes) {
  const movesSection = moves.length
    ? `<div class="whats-new-section">
        <h3 class="whats-new-section-title">${escapeHtml(t('whatsNew.movedTitle'))}</h3>
        ${moves.map(_moveHtml).join('')}
      </div>`
    : '';

  const notesSection = notes
    ? `<div class="whats-new-section">
        <h3 class="whats-new-section-title">${escapeHtml(t('whatsNew.notesTitle'))}</h3>
        <div class="whats-new-notes markdown-body">${markdown.render(notes)}</div>
      </div>`
    : `<div class="whats-new-offline">${escapeHtml(t('whatsNew.notesUnavailable'))}</div>`;

  return `<div class="whats-new">${movesSection}${notesSection}</div>`;
}

/** Wire the "take me there" buttons, then close the panel behind them. */
function wireActions(root, close) {
  root.querySelectorAll('[data-move-action]').forEach((btn) => {
    btn.onclick = () => {
      let action;
      try {
        action = JSON.parse(btn.dataset.moveAction);
      } catch {
        return;
      }
      close();
      if (action.type === 'tab') _callbacks.onOpenTab?.(action.tab);
      else if (action.type === 'setting') _callbacks.onOpenSetting?.(action.setting);
    };
  });
}

/**
 * Show the panel if this launch is the first on a new version, and record the
 * version either way.
 *
 * @param {Object} host
 * @param {(title: string, html: string, footer: string) => void} host.showModal
 * @param {() => void} host.closeModal
 * @param {boolean} host.hasHistory - true when the profile predates this feature
 * @returns {Promise<boolean>} whether the panel was shown
 */
async function maybeShow({ showModal, closeModal, hasHistory }) {
  let current = null;
  try {
    current = await api.app.getVersion();
  } catch {
    return false;
  }

  const lastSeen = getSetting('lastSeenVersion') || null;
  // Recorded before anything can fail: a panel that could not be built is not
  // a reason to ask again on every launch.
  if (current && current !== lastSeen) {
    settingsState.setProp('lastSeenVersion', current);
    saveSettings();
  }

  if (!shouldShow(current, lastSeen, hasHistory)) return false;

  const moves = movesBetween(lastSeen, current);
  let notes = null;
  try {
    notes = await api.updates.releaseNotes(current);
  } catch {
    notes = null;
  }
  // Nothing local to say and nothing fetched: skip it rather than open an
  // empty window on someone who just wanted to get to work.
  if (!moves.length && !notes) return false;

  showModal(
    t('whatsNew.title', { version: current }),
    buildHtml(moves, notes),
    `<button class="btn-primary" id="whats-new-close">${escapeHtml(t('whatsNew.gotIt'))}</button>`
  );

  const body = document.getElementById('modal-body');
  if (body) wireActions(body, closeModal);
  document.getElementById('whats-new-close')?.addEventListener('click', closeModal);
  return true;
}

module.exports = {
  maybeShow,
  setCallbacks,
  // Exported for the tests: the version arithmetic is the part that decides
  // whether anyone ever sees this.
  compareVersions,
  movesBetween,
  shouldShow,
  buildHtml,
  MOVES,
};
