/**
 * Contextual feature suggestions: the host side.
 *
 * `engine.js` decides whether a suggestion may be shown and `rules/` says when
 * one applies; this file is everything that touches the app: it reads the
 * signals, judges whether this is a bad moment, draws the card and resolves
 * "Show me". Navigation is the renderer's, so the two ways a card can take
 * the user somewhere (a sidebar screen, a setting) are callbacks the host
 * registers with `setCallbacks`, exactly as WhatsNew does.
 *
 * Signals come from two places:
 *  - observed here: tab counts (terminals state), the opened project
 *    (projects state), prompts from terminal tabs (the hooks' PROMPT_SUBMIT),
 *    and which sidebar screen is on show (body[data-active-tab]);
 *  - reported by the code that owns them, through `report()` and
 *    `markUsed()`: ChatView (typed prompts, the context gauge), GitChangesPanel
 *    (commits, the generate button) and the usage chip in renderer.js.
 * Both are no-ops until `init()` has run, so a caller never has to know.
 */

const { createDiscoveryEngine } = require('./engine');
const { createDiscoveryStore } = require('./store');
const RULES = require('./rules');

const SUGGESTION_DURATION_MS = 20000;
const FLUSH_INTERVAL_MS = 15000;
const HIGHLIGHT_MS = 2400;

const _callbacks = { onOpenTab: null, onOpenSetting: null };

/**
 * @param {Object} cbs
 * @param {(tab: string) => void} [cbs.onOpenTab]
 * @param {(target: { tab: string, anchor?: string }) => void} [cbs.onOpenSetting]
 */
function setCallbacks(cbs) { Object.assign(_callbacks, cbs); }

let _engine = null;
const _teardown = [];

/** Signals sent before init (or with suggestions off) are simply dropped. */
function report(type, payload) {
  if (!_engine) return;
  _engine.signal(type, payload).catch(() => {});
}

function markUsed(key) {
  if (_engine) _engine.markUsed(key);
}

// ── The moment ───────────────────────────────────────────────────────────

/** Is a modal, a confirm dialog or any aria-modal surface on screen? */
function isModalOpen(doc = document) {
  if (doc.querySelector('.modal-overlay.active, .confirm-overlay.active')) return true;
  return [...doc.querySelectorAll('[aria-modal="true"]')].some((el) => el.isConnected && el.getClientRects().length > 0);
}

/**
 * Why now is a bad moment, or null. Every tab counts, not only the visible
 * one: a turn running in a background tab is still the user's attention.
 * @param {{ terminals: Map, doc?: Document }} deps
 */
function busyReason({ terminals, doc = document }) {
  if (doc.hidden || (typeof doc.hasFocus === 'function' && !doc.hasFocus())) return 'unfocused';
  for (const term of terminals.values()) {
    if (!term || term.isBasic) continue;
    if (term.attention === 'input') return 'waiting';
    if (term.status === 'working') return 'turn';
  }
  if (isModalOpen(doc)) return 'modal';
  return null;
}

/**
 * The most Claude tabs open on one project. Plain shells, file tabs and the
 * project-type consoles are not Claude sessions.
 * @param {Map} terminals
 */
function maxClaudeTabsPerProject(terminals) {
  const counts = new Map();
  let max = 0;
  for (const term of terminals.values()) {
    if (!term || term.isBasic || !term.project) continue;
    if (term.type === 'file' || term.type === 'fivem' || term.type === 'webapp') continue;
    const key = term.parentProjectId || term.project.id;
    if (!key) continue;
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > max) max = n;
  }
  return max;
}

// ── The card ─────────────────────────────────────────────────────────────

function highlight(selector) {
  if (!selector) return;
  const el = document.querySelector(selector);
  if (!el) return;
  el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  el.classList.add('discovery-highlight');
  setTimeout(() => el.classList.remove('discovery-highlight'), HIGHLIGHT_MS);
}

function runAction(action) {
  if (!action) return;
  if (action.type === 'tab') {
    _callbacks.onOpenTab?.(action.tab);
    // The screen renders after the click; give it a frame or two.
    if (action.highlight) setTimeout(() => highlight(action.highlight), 350);
  } else if (action.type === 'setting') {
    _callbacks.onOpenSetting?.({ tab: action.tab, anchor: action.anchor || null });
  }
}

function makePresenter({ t, showToast }) {
  return (suggestion, handlers) => {
    showToast({
      type: 'info',
      className: 'toast-suggestion',
      title: t(suggestion.titleKey, suggestion.params),
      message: t(suggestion.bodyKey, suggestion.params),
      duration: SUGGESTION_DURATION_MS,
      dedupe: false,
      action: t(suggestion.actionLabelKey),
      onAction: () => {
        handlers.onAction();
        runAction(suggestion.action);
      },
      secondaryAction: t('discovery.dontShowAgain'),
      onSecondaryAction: handlers.onDismiss,
      onHide: handlers.onHide,
    });
  };
}

// ── Wiring ───────────────────────────────────────────────────────────────

/**
 * Start the engine. Idempotent; resolves once the store is read.
 * @param {Object} [opts]
 * @param {object} [opts.api]
 * @param {number} [opts.startupGraceMs]  the engine's default unless given (tests)
 */
async function init({ api = window.electron_api, startupGraceMs } = {}) {
  if (_engine) return _engine;

  const { fs, path } = window.electron_nodeModules;
  const { atomicWriteJSON } = require('../../utils/fs-async');
  const { dataDir } = require('../../utils/paths');
  const { t } = require('../../i18n');
  const { showToast } = require('../../ui/components/Toast');
  const { getSetting } = require('../../state/settings.state');
  const { terminalsState } = require('../../state/terminals.state');
  const { projectsState } = require('../../state/projects.state');
  const { getAccounts } = require('../../state/accounts.state');
  const { can } = require('../../../shared/remote-capabilities');
  const { SPLIT_SHORTCUTS } = require('../../ui/components/terminal/keyBindings');

  const store = createDiscoveryStore({
    readFile: (file) => fs.promises.readFile(file, 'utf8'),
    writeJSON: (file, data) => atomicWriteJSON(file, data),
    file: path.join(dataDir, 'discovery.json'),
  });
  await store.load();

  const getTerminals = () => terminalsState.get().terminals;

  _engine = createDiscoveryEngine({
    rules: RULES,
    store,
    isEnabled: () => getSetting('discoverySuggestionsEnabled') !== false,
    busyReason: () => busyReason({ terminals: getTerminals() }),
    present: makePresenter({ t, showToast }),
    ...(startupGraceMs !== undefined ? { startupGraceMs } : {}),
    ctx: {
      api,
      getSetting,
      getAccounts,
      can,
      fs: fs.promises,
      joinPath: (...parts) => path.join(...parts),
      isSplitInUse: () => !!document.querySelector('.terminals-container.is-split'),
      splitShortcut: () => (getSetting('shortcuts') || {}).splitRight || SPLIT_SHORTCUTS.splitRight,
    },
  });
  const engine = _engine;

  // Tabs: the largest count per project, signalled only when it changes.
  // Any terminals change may also mean a turn ended, which can free a pending
  // suggestion.
  let lastMax = 0;
  _teardown.push(terminalsState.subscribe(() => {
    const max = maxClaudeTabsPerProject(getTerminals());
    if (max !== lastMax) {
      lastMax = max;
      report('tabs:changed', { maxClaudeTabs: max });
    }
    if (document.querySelector('.terminals-container.is-split')) engine.markUsed('split-view');
    engine.flush();
  }));

  // The project the user opens.
  let lastOpened = projectsState.get().openedProjectId || null;
  const announceProject = (id) => {
    const project = (projectsState.get().projects || []).find((p) => p.id === id);
    if (project) report('project:opened', { project });
  };
  if (lastOpened) announceProject(lastOpened);
  _teardown.push(projectsState.subscribe(() => {
    const id = projectsState.get().openedProjectId || null;
    if (id === lastOpened) return;
    lastOpened = id;
    if (id) announceProject(id);
  }));

  // Prompts typed in terminal tabs, when the hooks carry them. Chat tabs
  // report their own (ChatView), since only they know the typed text.
  try {
    const { getEventBus, EVENT_TYPES } = require('../../events');
    const bus = getEventBus();
    _teardown.push(bus.on(EVENT_TYPES.PROMPT_SUBMIT, (e) => {
      if (e.source === 'hooks' && e.data && e.data.prompt) report('prompt:sent', { text: e.data.prompt, source: 'terminal' });
    }));
  } catch { /* event bus not ready: chat prompts still count */ }

  // Which screens the user opens: every one counts as using that feature.
  const noteTab = () => {
    const tab = document.body.dataset.activeTab;
    if (tab) engine.markUsed(`tab:${tab}`);
  };
  noteTab();
  const observer = new MutationObserver(noteTab);
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-active-tab'] });
  _teardown.push(() => observer.disconnect());

  // The moment may have changed: focus came back, or simply time passed.
  const onFocus = () => engine.flush();
  window.addEventListener('focus', onFocus);
  _teardown.push(() => window.removeEventListener('focus', onFocus));
  const interval = setInterval(() => engine.flush(), FLUSH_INTERVAL_MS);
  _teardown.push(() => clearInterval(interval));
  window.addEventListener('beforeunload', () => { store.flush(); });

  return engine;
}

function destroy() {
  while (_teardown.length) {
    try { _teardown.pop()(); } catch { /* best effort */ }
  }
  _engine = null;
}

module.exports = {
  init,
  destroy,
  setCallbacks,
  report,
  markUsed,
  RULES,
  // Exported for the tests.
  busyReason,
  isModalOpen,
  maxClaudeTabsPerProject,
  makePresenter,
  runAction,
};
