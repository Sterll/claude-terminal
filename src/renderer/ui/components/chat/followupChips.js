/**
 * The suggestion chips under a finished turn.
 *
 * Two sources feed one strip and neither can wait for the other: the SDK emits
 * `prompt_suggestion` *after* the `result` message, so it lands once the turn
 * has already been flushed, while the context chips need a scan that finishes
 * whenever it finishes. Hence a bucket each and a re-render on either, rather
 * than a snapshot taken at flush time.
 */

const { escapeHtml } = require('../../../utils');
const { t } = require('../../../i18n');

const SPARKLE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5z"/><path d="M19 15l.75 2.25L22 18l-2.25.75L19 21l-.75-2.25L16 18l2.25-.75z"/></svg>`;

function createFollowupChips(api, suggestionsContainerEl, inputAdapter, project) {
  // The SDK emits `prompt_suggestion` *after* the `result` message, so it lands
  // once the turn has already been flushed. Keep both sources in their own bucket
  // and re-render whenever either one changes, instead of snapshotting on flush.
  let _sdk = [];        // suggestions pushed by the SDK stream
  let _ctx = [];        // context chips (TODOs), fetched when the turn ends
  let _visible = false; // turn is over: chips are allowed on screen

  function _render(chips) {
    if (!chips || chips.length === 0) {
      suggestionsContainerEl.style.display = 'none';
      suggestionsContainerEl.innerHTML = '';
      return;
    }

    const label = document.createElement('span');
    label.className = 'chat-followup-label';
    label.textContent = t('chat.suggestionsLabel') || 'Suggestions';

    const chipsWrapper = document.createElement('div');
    chipsWrapper.className = 'chat-followup-chips';
    chipsWrapper.setAttribute('role', 'listbox');
    chipsWrapper.setAttribute('aria-label', t('chat.suggestionsLabel') || 'Suggestions');

    chips.forEach((text, chipIndex) => {
      const chip = document.createElement('button');
      chip.className = 'chat-followup-chip';
      chip.setAttribute('role', 'option');
      chip.setAttribute('aria-selected', 'false');
      chip.setAttribute('tabindex', chipIndex === 0 ? '0' : '-1');
      chip.innerHTML = `<span class="chat-followup-chip-icon">${SPARKLE_ICON}</span><span class="chat-followup-chip-text">${escapeHtml(text)}</span>`;
      chip.title = text;
      chip.addEventListener('click', () => {
        const existing = inputAdapter.getText().trim();
        if (existing) {
          inputAdapter.setText(existing + ' ' + text);
        } else {
          inputAdapter.setText(text);
        }
        inputAdapter.resize();
        inputAdapter.focus();
        clear();
      });
      chip.addEventListener('keydown', (e) => {
        const allChips = Array.from(chipsWrapper.querySelectorAll('.chat-followup-chip'));
        const idx = allChips.indexOf(chip);
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          const next = allChips[idx + 1];
          if (next) { chip.setAttribute('tabindex', '-1'); next.setAttribute('tabindex', '0'); next.focus(); }
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = allChips[idx - 1];
          if (prev) { chip.setAttribute('tabindex', '-1'); prev.setAttribute('tabindex', '0'); prev.focus(); }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          inputAdapter.focus();
        }
      });
      chipsWrapper.appendChild(chip);
    });

    suggestionsContainerEl.innerHTML = '';
    suggestionsContainerEl.appendChild(label);
    suggestionsContainerEl.appendChild(chipsWrapper);
    suggestionsContainerEl.style.display = 'flex';
  }

  /** Re-render from the current buckets. No-op while streaming or while typing. */
  function _sync() {
    if (!_visible) return;
    if (!inputAdapter.isEmpty()) return;
    const chips = [..._sdk.slice(0, 3), ..._ctx];
    if (chips.length > 0) {
      _render(chips);
    }
  }

  /** Push a suggestion from the SDK stream. Arrives after the turn ended. */
  function addSuggestion(text) {
    if (typeof text === 'string' && text.trim() && _sdk.length < 5) {
      _sdk.push(text.trim());
      _sync();
    }
  }

  /** Called when streaming ends: allow rendering, then fetch context chips */
  async function flush() {
    _visible = true;
    _sync(); // show whatever already arrived
    _ctx = await _fetchContextChips();
    _sync();
  }

  async function _fetchContextChips() {
    if (!project?.path) return [];
    try {
      const todos = await api.project.scanTodos(project.path).catch(() => []);
      const todoCount = Array.isArray(todos) ? todos.length : 0;
      if (todoCount > 0) {
        return [t('chat.suggestTodos', { count: todoCount }).replace(/\s*\[Tab\]\s*$/, '')];
      }
    } catch { /* ignore */ }
    return [];
  }

  function clear() {
    _sdk = [];
    _ctx = [];
    _visible = false;
    suggestionsContainerEl.style.display = 'none';
    suggestionsContainerEl.innerHTML = '';
  }

  // Hide chips when user starts typing
  inputAdapter.onInput(() => {
    if (!inputAdapter.isEmpty() && suggestionsContainerEl.style.display !== 'none') {
      clear();
    }
  });

  return { addSuggestion, flush, clear };
}

module.exports = { createFollowupChips };
