/**
 * EmptyState - the one empty-screen block every panel shares.
 *
 * An empty screen is where a user who has never used a feature lands, and
 * "No items" tells them neither what the screen is for nor how to begin. This
 * block always says both: a `purpose` sentence in terms of the user's problem,
 * and one primary action that starts the feature, with optional examples and
 * secondary links beside it.
 *
 * Two rules hold for every caller:
 *
 * - Nothing happens until a click. The block draws buttons only; an example
 *   pre-fills a form the user still has to confirm, it never creates anything
 *   by itself. The callbacks are the caller's existing "new" handlers.
 * - An action a remote (SSH) project cannot run is not offered as a button that
 *   fails. An item carrying `requires: { project, feature }` is checked against
 *   `src/shared/remote-capabilities.js`; when refused it is drawn disabled, its
 *   click does nothing, and the existing translated reason is shown as text
 *   under it (and as its tooltip).
 *
 * Text is set with textContent, never parsed as HTML. `icon` is the one markup
 * input and must be a static SVG string from the caller's own code.
 *
 * @typedef {{ project: object, feature: string }} Requirement
 * @typedef {{ label: string, onClick: Function, id?: string, icon?: string, requires?: Requirement }} EmptyStateAction
 * @typedef {{ label: string, onClick: Function, id?: string, shortcut?: string, requires?: Requirement }} EmptyStateLink
 *
 * @typedef {Object} EmptyStateOptions
 * @property {string} id                 data-empty-state value (styling and tests)
 * @property {string} [icon]             trusted static SVG markup
 * @property {string} title
 * @property {string} purpose            what the screen is for
 * @property {EmptyStateAction} [action] the one-click way to start
 * @property {{ label?: string, items: EmptyStateAction[] }} [examples]
 *           ready-made starting points; each inherits `action.requires` unless it has its own
 * @property {EmptyStateLink[]} [links]  secondary links (a setting, a shortcut)
 * @property {string} [className]        extra classes kept for a panel's own hooks
 * @property {boolean} [compact]         smaller variant for side columns and cards
 */

'use strict';

const { t } = require('../../i18n');
const { can } = require('../../../shared/remote-capabilities');

/** The refusal reason of an item, or null when it may run. */
function refusalOf(requires) {
  if (!requires || !requires.project || !requires.feature) return null;
  const verdict = can(requires.project, requires.feature);
  return verdict.ok ? null : t(verdict.reasonKey);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

/**
 * A button that runs `onClick` unless `reason` refuses it. Refused buttons stay
 * focusable (aria-disabled, not `disabled`) so the tooltip is reachable.
 */
function button(className, item, reason) {
  const btn = el('button', className);
  btn.type = 'button';
  if (item.id) btn.id = item.id;
  if (item.icon) {
    const glyph = el('span', 'empty-guide-btn-icon');
    glyph.innerHTML = item.icon;
    glyph.setAttribute('aria-hidden', 'true');
    btn.appendChild(glyph);
  }
  btn.appendChild(el('span', 'empty-guide-btn-label', item.label));
  if (reason) {
    btn.classList.add('is-disabled');
    btn.setAttribute('aria-disabled', 'true');
    btn.title = reason;
  }
  btn.addEventListener('click', (event) => {
    if (reason) { event.preventDefault(); return; }
    if (typeof item.onClick === 'function') item.onClick(event);
  });
  return btn;
}

/**
 * Build the block. The caller mounts it; nothing is called before a click.
 * @param {EmptyStateOptions} options
 * @returns {HTMLElement}
 */
function createEmptyState(options = {}) {
  const root = el('div', 'empty-guide');
  if (options.compact) root.classList.add('empty-guide--compact');
  if (options.className) root.classList.add(...String(options.className).split(/\s+/).filter(Boolean));
  if (options.id) root.dataset.emptyState = options.id;
  root.setAttribute('role', 'region');
  if (options.title) root.setAttribute('aria-label', options.title);

  if (options.icon) {
    const glyph = el('div', 'empty-guide-icon');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.innerHTML = options.icon;
    root.appendChild(glyph);
  }
  if (options.title) root.appendChild(el('p', 'empty-guide-title', options.title));
  if (options.purpose) root.appendChild(el('p', 'empty-guide-purpose', options.purpose));

  const reasons = new Set();
  const action = options.action;
  const actionReason = action ? refusalOf(action.requires) : null;

  if (action) {
    if (actionReason) reasons.add(actionReason);
    root.appendChild(button('empty-guide-action', action, actionReason));
  }

  const examples = options.examples;
  if (examples && Array.isArray(examples.items) && examples.items.length) {
    const box = el('div', 'empty-guide-examples');
    if (examples.label) box.appendChild(el('p', 'empty-guide-examples-label', examples.label));
    const list = el('div', 'empty-guide-example-list');
    for (const item of examples.items) {
      const reason = item.requires ? refusalOf(item.requires) : actionReason;
      if (reason) reasons.add(reason);
      list.appendChild(button('empty-guide-example', item, reason));
    }
    box.appendChild(list);
    root.appendChild(box);
  }

  if (Array.isArray(options.links) && options.links.length) {
    const row = el('div', 'empty-guide-links');
    for (const link of options.links) {
      const reason = refusalOf(link.requires);
      if (reason) reasons.add(reason);
      const btn = button('empty-guide-link', link, reason);
      if (link.shortcut) btn.appendChild(el('kbd', 'empty-guide-kbd', link.shortcut));
      row.appendChild(btn);
    }
    root.appendChild(row);
  }

  for (const reason of reasons) {
    root.appendChild(el('p', 'empty-guide-reason', reason));
  }
  return root;
}

/**
 * Replace the content of `container` with the block.
 * @param {HTMLElement} container
 * @param {EmptyStateOptions} options
 * @returns {HTMLElement|null} the block
 */
function mountEmptyState(container, options) {
  if (!container) return null;
  const block = createEmptyState(options);
  container.replaceChildren(block);
  return block;
}

module.exports = { createEmptyState, mountEmptyState };
