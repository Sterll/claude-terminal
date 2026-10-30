/**
 * The chat's side column: the session's brief on top, then its branches and
 * its tickets, its background tasks last, scrolled as one. Each section folds
 * from its header, which stays at the top of the column while its section
 * scrolls under it.
 *
 * Collapsed, the column leaves a strip on the right edge, the way the projects
 * column leaves one on the left. The strip, and a folded section's header,
 * keep saying what is hidden: a dot when the brief is behind the conversation,
 * a red one when a branch needs the user, one when a detected ticket waits for
 * an answer, a pulse while a task runs. A click anywhere on the strip brings
 * it back.
 *
 * It starts collapsed: the strip is all a tab shows until the user opens it.
 * Collapsed or not, and each fold, is one choice for every chat tab,
 * remembered across launches: body classes, so every open tab follows at once
 * without being told, plus an event for the tabs that have something to
 * catch up on.
 */

'use strict';

const { t } = require('../../../i18n');

const STORAGE_KEY = 'chat-side-collapsed';
const BODY_CLASS = 'chat-side-collapsed';
const EVENT = 'chat-side-toggled';
const SECTIONS = ['brief', 'git', 'tickets', 'tasks'];

const foldClass = (section) => `chat-side-${section}-folded`;
const foldKey = (section) => `chat-side-folded-${section}`;

let restored = false;

function isCollapsed() {
  return document.body.classList.contains(BODY_CLASS);
}

function isFolded(section) {
  return document.body.classList.contains(foldClass(section));
}

function remember(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* not worth failing over */ }
}

function setCollapsed(collapsed) {
  document.body.classList.toggle(BODY_CLASS, collapsed);
  remember(STORAGE_KEY, collapsed);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { collapsed } }));
}

function setFolded(section, folded) {
  document.body.classList.toggle(foldClass(section), folded);
  remember(foldKey(section), folded);
  for (const head of document.querySelectorAll(`.chat-side-section[data-section="${section}"] .chat-side-section-head`)) {
    head.setAttribute('aria-expanded', String(!folded));
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { section, folded } }));
}

/** Once per window: the first chat view puts back what the user left. */
function restoreState() {
  if (restored) return;
  restored = true;
  try {
    // Collapsed unless the user opened it: a column 340px wide on every chat
    // tab is the user's to ask for, not a default to dismiss.
    if (localStorage.getItem(STORAGE_KEY) !== 'false') document.body.classList.add(BODY_CLASS);
    for (const section of SECTIONS) {
      if (localStorage.getItem(foldKey(section)) === 'true') document.body.classList.add(foldClass(section));
    }
  } catch {
    document.body.classList.add(BODY_CLASS);
  }
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.sideEl - the expanded column
 * @param {HTMLElement} deps.railEl - the strip left when it is collapsed
 * @param {() => void} [deps.onExpand] - the column, or one of its sections, is back on screen
 */
function createSidePanel({ sideEl, railEl, onExpand = () => {} }) {
  restoreState();
  const briefSignal = railEl.querySelector('.chat-side-rail-brief');
  const gitSignal = railEl.querySelector('.chat-side-rail-git');
  const ticketsSignal = railEl.querySelector('.chat-side-rail-tickets');
  const tasksSignal = railEl.querySelector('.chat-side-rail-tasks');
  const headOf = (section) => sideEl.querySelector(`.chat-side-section[data-section="${section}"] .chat-side-section-head`);

  for (const section of SECTIONS) headOf(section)?.setAttribute('aria-expanded', String(!isFolded(section)));

  const toggleFold = (head) => {
    const section = head.closest('.chat-side-section')?.dataset.section;
    if (section) setFolded(section, !isFolded(section));
  };
  const onSideClick = (e) => {
    if (e.target.closest('.chat-side-collapse')) { setCollapsed(true); return; }
    const head = e.target.closest('.chat-side-section-head');
    // A button in the header (clear finished tasks) does its own thing.
    if (head && !e.target.closest('button')) toggleFold(head);
  };
  const onSideKey = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const head = e.target.closest('.chat-side-section-head');
    if (!head || e.target !== head) return;
    e.preventDefault();
    toggleFold(head);
  };
  const onRailClick = () => setCollapsed(false);
  const onToggled = (e) => {
    const { section, folded, collapsed } = e.detail || {};
    if (section ? !folded : !collapsed) onExpand();
  };
  sideEl.addEventListener('click', onSideClick);
  sideEl.addEventListener('keydown', onSideKey);
  railEl.addEventListener('click', onRailClick);
  window.addEventListener(EVENT, onToggled);

  /** The number beside a section's title. */
  const setCount = (section, count) => {
    const el = headOf(section)?.querySelector('.chat-side-count');
    if (el) el.textContent = count ? String(count) : '';
  };

  return {
    isCollapsed,
    isFolded,
    /** A section's content is on the page: the column open, the section unfolded. */
    isOpen: (section) => !isCollapsed() && !isFolded(section),
    /** The brief is behind the conversation: a dot on the strip and on its header. */
    setBriefBehind(behind) {
      briefSignal.classList.toggle('behind', !!behind);
      headOf('brief')?.classList.toggle('behind', !!behind);
    },
    /** The session's branches: a count, and a red dot while one needs the user. */
    setGit({ count, attention }) {
      setCount('git', count);
      gitSignal.hidden = !count;
      gitSignal.classList.toggle('attention', attention > 0);
      headOf('git')?.classList.toggle('attention', attention > 0);
      const label = attention > 0 ? t('chat.git.attention', { count: attention }) : '';
      gitSignal.title = label;
      headOf('git')?.setAttribute('title', label);
    },
    /** The session's tickets: shown once a tracker is connected, a dot while a detected one waits. */
    setTickets({ available, count, suggested }) {
      setCount('tickets', count);
      ticketsSignal.hidden = !available;
      ticketsSignal.classList.toggle('behind', suggested > 0);
      headOf('tickets')?.classList.toggle('behind', suggested > 0);
      const label = suggested > 0 ? t('chat.side.suggested', { count: suggested }) : '';
      ticketsSignal.title = label;
      headOf('tickets')?.setAttribute('title', label);
    },
    /** This tab's tasks: the strip's icon only once it has some, pulsing while one runs. */
    setTasks({ count, running }) {
      tasksSignal.hidden = !count;
      tasksSignal.classList.toggle('running', running > 0);
      headOf('tasks')?.classList.toggle('running', running > 0);
    },
    destroy() {
      sideEl.removeEventListener('click', onSideClick);
      sideEl.removeEventListener('keydown', onSideKey);
      railEl.removeEventListener('click', onRailClick);
      window.removeEventListener(EVENT, onToggled);
    },
  };
}

module.exports = { createSidePanel, setCollapsed, isCollapsed, setFolded, isFolded, STORAGE_KEY };
