/**
 * Tickets for Claude sessions in terminal mode.
 *
 * A chat tab has its own Tickets tab. A terminal tab has no room for one, so a
 * single button in the session bar serves the active terminal tab and opens
 * the same component (chat/ticketsTab.js) in a popover. Its key is the CLI
 * session id the hooks report (`claudeSessionId`): without hooks a terminal
 * tab has no id, and the button stays hidden.
 *
 * Detections cannot be asked about in a conversation here, since the
 * transcript is the terminal's. A toast names what was detected, for any
 * terminal session including one in the background, with a button that
 * brings that tab forward and opens the popover where the suggestions wait.
 * Each suggestion is toasted once.
 */

'use strict';

const { t } = require('../../../i18n');
const { createTicketsTab } = require('../chat/ticketsTab');

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1.5a2.5 2.5 0 0 0 0 5V16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1.5a2.5 2.5 0 0 0 0-5z"/></svg>';

const keyOf = (ref) => ref.slice(ref.indexOf(':') + 1);

/**
 * @param {object} deps
 * @param {object} deps.api window.electron_api
 * @param {HTMLElement} deps.hostEl the session bar the button goes into
 * @param {object} deps.terminalsState observable with { terminals: Map, activeTerminal }
 * @param {(id: any) => void} deps.activateTerminal
 * @param {(opts: object) => void} deps.showToast
 */
function createTerminalTicketsButton(deps) {
  const { api, hostEl, terminalsState } = deps;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'session-action-btn terminal-tickets-btn';
  button.hidden = true;
  button.title = t('chat.tabTickets');
  button.setAttribute('aria-label', t('chat.tabTickets'));
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = `${ICON}<span class="chat-tab-badge" hidden>0</span>`;
  hostEl.insertBefore(button, hostEl.firstChild);
  const badgeEl = button.querySelector('.chat-tab-badge');

  const popover = document.createElement('div');
  popover.className = 'terminal-tickets-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', t('chat.tickets.title'));
  popover.hidden = true;
  const panelEl = document.createElement('div');
  panelEl.className = 'session-tickets-panel';
  popover.appendChild(panelEl);
  document.body.appendChild(popover);

  let current = null; // { terminalId, key, tab }
  const toasted = new Set(); // `${sessionKey}|${ref}`

  /** The active tab when it is a Claude session in terminal mode with a known id. */
  function activeTerminal() {
    const { terminals, activeTerminal: id } = terminalsState.get();
    const td = id != null && terminals ? terminals.get(id) : null;
    return td && td.mode === 'terminal' && !td.isBasic && td.claudeSessionId ? { terminalId: id, td } : null;
  }

  function terminalByKey(key) {
    for (const [terminalId, td] of terminalsState.get().terminals || []) {
      if (td.mode === 'terminal' && !td.isBasic && td.claudeSessionId === key) return { terminalId, td };
    }
    return null;
  }

  function close() {
    popover.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    current?.tab.hide();
  }

  function open() {
    if (!current) return;
    const box = button.getBoundingClientRect();
    popover.hidden = false;
    popover.style.top = `${box.bottom + 6}px`;
    popover.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - popover.offsetWidth - 8))}px`;
    button.setAttribute('aria-expanded', 'true');
    current.tab.show();
  }

  /** Follow the active tab: one Tickets component, for the session on screen. */
  function sync() {
    const active = activeTerminal();
    if (current && (!active || active.terminalId !== current.terminalId)) {
      close();
      current.tab.destroy();
      current = null;
      button.hidden = true;
      badgeEl.hidden = true;
    }
    if (!active) return;
    if (current) {
      if (current.key !== active.td.claudeSessionId) {
        current.key = active.td.claudeSessionId;
        current.tab.onSessionId(current.key); // /clear: the new session starts with the old one's tickets
      }
      return;
    }
    const tab = createTicketsTab({
      api,
      panelEl,
      tabBtn: button,
      badgeEl,
      initialKey: active.td.claudeSessionId,
      getProjectId: () => active.td.project?.id || null,
      onAvailable: () => { button.hidden = false; },
      showToast: deps.showToast,
    });
    current = { terminalId: active.terminalId, key: active.td.claudeSessionId, tab };
    tab.probe();
  }

  /** Any terminal session, active or not: say what was detected, once. */
  async function onLinksChanged({ sessionKey } = {}) {
    const term = sessionKey ? terminalByKey(sessionKey) : null;
    if (!term) return;
    const res = await api.issueLinks.get(sessionKey);
    if (!res?.ok) return;
    const fresh = res.links.filter((l) => l.status === 'suggested' && !toasted.has(`${sessionKey}|${l.ref}`));
    if (!fresh.length) return;
    fresh.forEach((l) => toasted.add(`${sessionKey}|${l.ref}`));
    deps.showToast({
      type: 'info',
      title: t('chat.tickets.detectedInTerminal', { keys: fresh.map((l) => keyOf(l.ref)).join(', '), tab: term.td.name || '' }),
      action: t('chat.tickets.review'),
      onAction: () => {
        deps.activateTerminal(term.terminalId);
        sync();
        open();
      },
    });
  }

  function onButtonClick() {
    if (popover.hidden) open();
    else close();
  }

  function onDocumentMousedown(event) {
    if (popover.hidden) return;
    if (popover.contains(event.target) || button.contains(event.target)) return;
    close();
  }

  function onDocumentKeydown(event) {
    if (event.key === 'Escape' && !popover.hidden) close();
  }

  button.addEventListener('click', onButtonClick);
  document.addEventListener('mousedown', onDocumentMousedown);
  document.addEventListener('keydown', onDocumentKeydown);
  const offState = terminalsState.subscribe(() => sync());
  const offLinks = api.issueLinks?.onChanged?.((payload) => { onLinksChanged(payload); });
  sync();

  return {
    sync,
    destroy() {
      close();
      current?.tab.destroy();
      offState?.();
      offLinks?.();
      button.removeEventListener('click', onButtonClick);
      document.removeEventListener('mousedown', onDocumentMousedown);
      document.removeEventListener('keydown', onDocumentKeydown);
      button.remove();
      popover.remove();
    },
  };
}

module.exports = { createTerminalTicketsButton };
