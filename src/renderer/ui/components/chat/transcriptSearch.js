/**
 * Find-in-conversation: the Ctrl+F bar over the transcript.
 *
 * Highlights by wrapping matched text nodes in <mark> and unwrapping them on
 * clear, rather than re-rendering anything — the transcript holds live tool
 * cards, listeners and streaming nodes that a re-render would destroy.
 *
 * Two things it has to cooperate with. It walks the *mounted* tree, so the
 * transcript pruner is suspended and fully mounted for the bar's whole
 * lifetime, or matches in older messages would silently not exist. And
 * streaming can replace message nodes underneath it, detaching the marks it
 * holds, so navigation re-runs the search when it notices a stale hit.
 *
 * Matches inside collapsed tool cards and hidden panels are skipped: they
 * cannot be scrolled to, so counting them would only inflate the counter.
 */

const { t } = require('../../../i18n');

/**
 * @param {object} deps
 * @param {HTMLElement} deps.chatView      the whole pane, for scoping Ctrl+F
 * @param {HTMLElement} deps.messagesEl    the transcript being searched
 * @param {HTMLElement} deps.tabbarEl      to reveal the transcript if hidden
 * @param {() => HTMLElement} deps.getInputEl  composer, to hand focus back
 * @param {() => object} deps.getPruner    read late: the pruner is built after
 *                                         this, since it needs the scroll state
 */
function createTranscriptSearch({ chatView, messagesEl, tabbarEl, getInputEl, getPruner }) {
  const searchBarEl = chatView.querySelector('.chat-search');
  const searchInputEl = chatView.querySelector('.chat-search-input');
  const searchCountEl = chatView.querySelector('.chat-search-count');
  const searchPrevBtn = chatView.querySelector('.chat-search-prev');
  const searchNextBtn = chatView.querySelector('.chat-search-next');
  const searchCloseBtn = chatView.querySelector('.chat-search-close');
  const searchOpenBtn = chatView.querySelector('.chat-search-btn');
// Tags whose text is never user-visible prose, so never worth highlighting.
const SEARCH_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG', 'CANVAS']);
const SEARCH_MAX_HITS = 500;

let searchHits = [];
let searchHitIndex = -1;
let searchDebounceTimer = null;
let searchLastQuery = '';
// Assigned once the scroll state exists (it needs userHasScrolled); only
// user-triggered paths run before that, and they all guard with ?.
let transcriptPruner = null;

function clearSearchHighlights() {
  for (const mark of messagesEl.querySelectorAll('mark.chat-search-hit')) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  }
  searchHits = [];
  searchHitIndex = -1;
}

// Collapsed tool cards and hidden panels hold text we can never scroll to,
// so matches inside them would only inflate the counter.
function isSearchableElement(el, cache) {
  if (!el || el === messagesEl) return true;
  const cached = cache.get(el);
  if (cached !== undefined) return cached;
  let ok = true;
  if (SEARCH_SKIP_TAGS.has(el.tagName.toUpperCase()) || el.hasAttribute('hidden')) {
    ok = false;
  } else if (el.offsetParent === null) {
    ok = false;
  } else {
    ok = isSearchableElement(el.parentElement, cache);
  }
  cache.set(el, ok);
  return ok;
}

function wrapSearchMatches(textNode, needle) {
  const marks = [];
  let current = textNode;
  for (;;) {
    const idx = current.nodeValue.toLowerCase().indexOf(needle);
    if (idx === -1) break;
    const matchNode = current.splitText(idx);
    const tail = matchNode.splitText(needle.length);
    const mark = document.createElement('mark');
    mark.className = 'chat-search-hit';
    matchNode.parentNode.replaceChild(mark, matchNode);
    mark.appendChild(matchNode);
    marks.push(mark);
    current = tail;
  }
  return marks;
}

function runSearch(query, { keepIndex = false } = {}) {
  const previousIndex = searchHitIndex;
  clearSearchHighlights();
  searchLastQuery = query;
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) {
    searchCountEl.textContent = '';
    searchBarEl.classList.remove('no-results');
    return;
  }

  const visibilityCache = new Map();
  const walker = document.createTreeWalker(messagesEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
      return isSearchableElement(node.parentElement, visibilityCache)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });

  const targets = [];
  let node;
  while ((node = walker.nextNode())) targets.push(node);

  for (const target of targets) {
    searchHits.push(...wrapSearchMatches(target, needle));
    if (searchHits.length >= SEARCH_MAX_HITS) break;
  }

  searchBarEl.classList.toggle('no-results', searchHits.length === 0);
  if (!searchHits.length) {
    searchCountEl.textContent = t('chat.searchNoResults') || 'No results';
    return;
  }
  const nextIndex = keepIndex && previousIndex >= 0
    ? Math.min(previousIndex, searchHits.length - 1)
    : 0;
  focusSearchHit(nextIndex, { scroll: !keepIndex });
}

function focusSearchHit(index, { scroll = true } = {}) {
  if (!searchHits.length) return;
  searchHits[searchHitIndex]?.classList.remove('current');
  searchHitIndex = (index + searchHits.length) % searchHits.length;
  const hit = searchHits[searchHitIndex];
  hit.classList.add('current');
  if (scroll) hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const total = searchHits.length >= SEARCH_MAX_HITS ? `${SEARCH_MAX_HITS}+` : `${searchHits.length}`;
  searchCountEl.textContent = `${searchHitIndex + 1}/${total}`;
}

function navigateSearch(forward) {
  // Streaming can replace message nodes under us, detaching the marks we hold.
  if (searchHits.length && searchHits.some(h => !h.isConnected)) {
    runSearch(searchLastQuery, { keepIndex: true });
    if (!searchHits.length) return;
  }
  if (!searchHits.length) return;
  focusSearchHit(searchHitIndex + (forward ? 1 : -1));
}

function openSearch() {
  // The Changes tab hides the transcript, so there would be nothing to match against.
  if (messagesEl.hidden) tabbarEl.querySelector('.chat-tab[data-tab="conversation"]')?.click();
  // Search walks the mounted DOM — bring the pruned entries back for its
  // whole lifetime, or matches in older messages would silently vanish.
  getPruner()?.suspend();
  getPruner()?.mountAll();
  searchBarEl.hidden = false;
  // Seed with the current selection so "select then Ctrl+F" works like a browser.
  const selected = String(window.getSelection() || '').trim();
  if (selected && selected.length <= 100 && messagesEl.contains(window.getSelection()?.anchorNode || null)) {
    searchInputEl.value = selected;
    runSearch(selected);
  } else if (searchInputEl.value.trim()) {
    runSearch(searchInputEl.value);
  }
  searchInputEl.focus();
  searchInputEl.select();
}

function closeSearch({ refocusInput = true } = {}) {
  if (searchBarEl.hidden) return;
  clearTimeout(searchDebounceTimer);
  clearSearchHighlights();
  searchBarEl.hidden = true;
  searchBarEl.classList.remove('no-results');
  searchCountEl.textContent = '';
  getPruner()?.resume();
  if (refocusInput) getInputEl()?.focus();
}

searchInputEl.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => runSearch(searchInputEl.value), 180);
});

searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (searchInputEl.value !== searchLastQuery) {
      clearTimeout(searchDebounceTimer);
      runSearch(searchInputEl.value);
      return;
    }
    navigateSearch(!e.shiftKey);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeSearch();
  }
});

searchPrevBtn.addEventListener('click', () => navigateSearch(false));
searchNextBtn.addEventListener('click', () => navigateSearch(true));
searchCloseBtn.addEventListener('click', () => closeSearch());
searchOpenBtn.addEventListener('click', () => {
  if (searchBarEl.hidden) openSearch(); else closeSearch();
});

// Only the visible chat view claims Ctrl+F; hidden tabs keep display:none wrappers.
function _onSearchShortcut(e) {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f' || e.altKey) return;
  if (!chatView.isConnected || chatView.offsetParent === null) return;
  const active = document.activeElement;
  if (active && active !== document.body && !chatView.contains(active)) return;
  e.preventDefault();
  e.stopPropagation();
  openSearch();
}
document.addEventListener('keydown', _onSearchShortcut, true);
  function destroy() {
    clearTimeout(searchDebounceTimer);
    document.removeEventListener('keydown', _onSearchShortcut, true);
  }

  return { open: openSearch, close: closeSearch, destroy };
}

module.exports = { createTranscriptSearch };
