/**
 * Split view: several tabs of one project on screen at once.
 *
 * One pane holds one tab, and the tab bar stays the single bar it always was.
 * The focused pane *is* the active terminal, so every reader of
 * getActiveTerminal() keeps meaning "where the user types". Activating a tab
 * that is not in the layout puts it in the focused pane; the tab it replaces is
 * hidden, never closed.
 *
 * No wrapper ever moves in the DOM. They all stay stacked in
 * #terminals-container, and the ones on screen get `.split-pane` plus four
 * custom properties (`--pane-left/top/width/height`) that only a rule scoped to
 * `.terminals-container.is-split` reads. Three things depend on that:
 *   - xterm, its WebGL canvas and the chat's TranscriptPruner are never
 *     detached, so nothing has to survive a reparent;
 *   - a wrapper the Control Tower borrows for its focus view stops matching
 *     the rule and renders the Control Tower's way, then comes back as it was;
 *   - each xterm's existing ResizeObserver refits it when its pane changes
 *     size. Cell metrics do not change with the pane, so the glyph atlas does
 *     not need re-cutting.
 *
 * The layout is a binary tree, at most MAX_PANES leaves, one tree per project:
 *   leaf  { tab: <tab id> }
 *   split { dir: 'row' | 'column', ratio, a, b }   ('row' = a left of b)
 * Tab ids are the terminals Map keys as they are: a number for a PTY tab, a
 * string for a chat, so they are compared through String() and stored as is.
 */

'use strict';

const MAX_PANES = 4;
const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;
/** Below this a pane is not worth having: ~40 columns, ~10 rows of xterm. */
const MIN_PANE_WIDTH = 360;
const MIN_PANE_HEIGHT = 200;
/** Gap between two panes, which is also the grab area of the handle. */
const GAP_PX = 6;
/** Pointer this close to a pane edge (fraction of the pane) splits that side. */
const EDGE_ZONE = 0.25;

const SIDES = {
  left: { dir: 'row', before: true },
  right: { dir: 'row', before: false },
  top: { dir: 'column', before: true },
  bottom: { dir: 'column', before: false },
};

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function isLeaf(node) {
  return !!node && Object.prototype.hasOwnProperty.call(node, 'tab');
}

/** Tab ids of a tree, left to right, top to bottom. */
function leaves(node, out = []) {
  if (!node) return out;
  if (isLeaf(node)) out.push(node.tab);
  else { leaves(node.a, out); leaves(node.b, out); }
  return out;
}

function contains(node, id) {
  return leaves(node).some((leaf) => sameId(leaf, id));
}

function clampRatio(ratio) {
  const r = Number(ratio);
  if (!Number.isFinite(r)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

/** Put `newId` on `side` of the leaf holding `targetId`. */
function splitLeaf(node, targetId, newId, side) {
  const spec = SIDES[side];
  if (!node || !spec) return node;
  if (isLeaf(node)) {
    if (!sameId(node.tab, targetId)) return node;
    const fresh = { tab: newId };
    return { dir: spec.dir, ratio: 0.5, a: spec.before ? fresh : node, b: spec.before ? node : fresh };
  }
  const a = splitLeaf(node.a, targetId, newId, side);
  const b = splitLeaf(node.b, targetId, newId, side);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** Drop a leaf; its sibling takes the parent's place. Null when nothing is left. */
function removeLeaf(node, id) {
  if (!node) return null;
  if (isLeaf(node)) return sameId(node.tab, id) ? null : node;
  const a = removeLeaf(node.a, id);
  const b = removeLeaf(node.b, id);
  if (!a) return b;
  if (!b) return a;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

function replaceLeaf(node, oldId, newId) {
  if (!node) return node;
  if (isLeaf(node)) return sameId(node.tab, oldId) ? { tab: newId } : node;
  const a = replaceLeaf(node.a, oldId, newId);
  const b = replaceLeaf(node.b, oldId, newId);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** Exchange the places of two leaves. */
function swapLeaves(node, id1, id2) {
  if (!node) return node;
  if (isLeaf(node)) {
    if (sameId(node.tab, id1)) return { tab: id2 };
    if (sameId(node.tab, id2)) return { tab: id1 };
    return node;
  }
  const a = swapLeaves(node.a, id1, id2);
  const b = swapLeaves(node.b, id1, id2);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** The split node at `path` ('' for the root, then 'a' / 'b' per level). */
function nodeAt(node, path) {
  let cur = node;
  for (const step of path) {
    if (!cur || isLeaf(cur)) return null;
    cur = cur[step];
  }
  return cur;
}

function withRatio(node, path, ratio) {
  if (!node || isLeaf(node)) return node;
  if (path === '') return { ...node, ratio };
  const step = path[0];
  return { ...node, [step]: withRatio(node[step], path.slice(1), ratio) };
}

/**
 * The pane each leaf gets and the line each split draws, as fractions of the
 * container. A handle carries the box of its split so a drag can turn a
 * pointer position back into a ratio.
 */
function computeRects(node, box = { x: 0, y: 0, w: 1, h: 1 }, path = '', out = { panes: [], handles: [] }) {
  if (!node) return out;
  if (isLeaf(node)) {
    out.panes.push({ id: node.tab, ...box });
    return out;
  }
  if (node.dir === 'row') {
    const aw = box.w * node.ratio;
    computeRects(node.a, { x: box.x, y: box.y, w: aw, h: box.h }, path + 'a', out);
    computeRects(node.b, { x: box.x + aw, y: box.y, w: box.w - aw, h: box.h }, path + 'b', out);
    out.handles.push({ path, dir: 'row', x: box.x + aw, y: box.y, w: 0, h: box.h, box });
  } else {
    const ah = box.h * node.ratio;
    computeRects(node.a, { x: box.x, y: box.y, w: box.w, h: ah }, path + 'a', out);
    computeRects(node.b, { x: box.x, y: box.y + ah, w: box.w, h: box.h - ah }, path + 'b', out);
    out.handles.push({ path, dir: 'column', x: box.x, y: box.y + ah, w: box.w, h: 0, box });
  }
  return out;
}

/** The least room a subtree needs along one axis, in pixels. */
function minExtent(node, axis) {
  if (!node) return 0;
  if (isLeaf(node)) return axis === 'x' ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT;
  const along = (node.dir === 'row') === (axis === 'x');
  const a = minExtent(node.a, axis);
  const b = minExtent(node.b, axis);
  return along ? a + b : Math.max(a, b);
}

/** Whether every pane of the tree keeps the minimum size in a container this big. */
function fitsMinimum(node, size) {
  const { panes } = computeRects(node);
  return panes.every((p) => p.w * size.width + 0.5 >= MIN_PANE_WIDTH && p.h * size.height + 0.5 >= MIN_PANE_HEIGHT);
}

/**
 * How far the split at `path` may move: 15 % to 85 %, and never so far that a
 * pane on either side drops under its minimum. Null when even the current
 * position does not leave room (a window shrunk after the split): the handle
 * then does not move rather than crush one side.
 */
function ratioBounds(node, path, size) {
  const split = nodeAt(node, path);
  if (!split || isLeaf(split)) return null;
  const handle = computeRects(node).handles.find((h) => h.path === path);
  if (!handle) return null;
  const axis = split.dir === 'row' ? 'x' : 'y';
  const extent = axis === 'x' ? handle.box.w * size.width : handle.box.h * size.height;
  if (!(extent > 0)) return { lo: MIN_RATIO, hi: MAX_RATIO };
  const lo = Math.max(MIN_RATIO, minExtent(split.a, axis) / extent);
  const hi = Math.min(MAX_RATIO, 1 - minExtent(split.b, axis) / extent);
  return lo <= hi ? { lo, hi } : null;
}

/**
 * The tree as it can be drawn in a container this big: every ratio pulled
 * back inside the bounds that keep both sides at their minimum, where such
 * bounds exist. Used for drawing only, so a layout restored into a smaller
 * window, or a window shrunk after the split, gets back the ratios the user
 * chose once there is room for them again.
 */
function fitToSize(node, size, box = { x: 0, y: 0, w: 1, h: 1 }) {
  if (!node || isLeaf(node) || !(size.width > 0) || !(size.height > 0)) return node;
  const axis = node.dir === 'row' ? 'x' : 'y';
  const extent = axis === 'x' ? box.w * size.width : box.h * size.height;
  const lo = Math.max(MIN_RATIO, minExtent(node.a, axis) / extent);
  const hi = Math.min(MAX_RATIO, 1 - minExtent(node.b, axis) / extent);
  const ratio = lo <= hi ? Math.min(hi, Math.max(lo, node.ratio)) : node.ratio;
  const boxA = axis === 'x' ? { ...box, w: box.w * ratio } : { ...box, h: box.h * ratio };
  const boxB = axis === 'x'
    ? { ...box, x: box.x + box.w * ratio, w: box.w * (1 - ratio) }
    : { ...box, y: box.y + box.h * ratio, h: box.h * (1 - ratio) };
  const a = fitToSize(node.a, size, boxA);
  const b = fitToSize(node.b, size, boxB);
  return ratio === node.ratio && a === node.a && b === node.b ? node : { ...node, ratio, a, b };
}

/** Which part of a pane the pointer is over: an edge to split, or the middle. */
function zoneAt(rect, x, y) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  if (rx < 0 || rx > 1 || ry < 0 || ry > 1) return null;
  const edges = [['left', rx], ['right', 1 - rx], ['top', ry], ['bottom', 1 - ry]];
  edges.sort((p, q) => p[1] - q[1]);
  return edges[0][1] <= EDGE_ZONE ? edges[0][0] : 'center';
}

/**
 * The layout as saved: leaves become indices into the project's saved tabs.
 * `indexOf` is computed at save time from the tab ids in memory, so a tab
 * reordered or closed before it cannot shift a leaf onto the wrong tab. A leaf
 * whose tab is not saved (a file tab) drops out and its sibling takes its place.
 */
function serializeLayout(root, indexOf) {
  let tree = root;
  for (const id of leaves(root)) {
    const i = indexOf(id);
    if (!Number.isInteger(i) || i < 0) tree = removeLeaf(tree, id);
  }
  if (!tree || isLeaf(tree)) return null;
  const walk = (n) => (isLeaf(n)
    ? { tab: indexOf(n.tab) }
    : { dir: n.dir, ratio: Math.round(n.ratio * 1000) / 1000, a: walk(n.a), b: walk(n.b) });
  return walk(tree);
}

/**
 * Read a saved layout back. Whatever does not check out drops: an index with
 * no tab behind it, a tab listed twice, a shape this code did not write. Fewer
 * than two panes left is no layout at all.
 */
function deserializeLayout(saved, idAt) {
  const seen = new Set();
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > MAX_PANES) return null;
    if (Object.prototype.hasOwnProperty.call(n, 'tab')) {
      if (!Number.isInteger(n.tab) || n.tab < 0) return null;
      const id = idAt(n.tab);
      if (id == null || seen.has(String(id))) return null;
      seen.add(String(id));
      return { tab: id };
    }
    if (n.dir !== 'row' && n.dir !== 'column') return null;
    const a = walk(n.a, depth + 1);
    const b = walk(n.b, depth + 1);
    if (!a) return b;
    if (!b) return a;
    return { dir: n.dir, ratio: clampRatio(n.ratio), a, b };
  };
  const tree = walk(saved, 0);
  if (!tree || isLeaf(tree) || leaves(tree).length > MAX_PANES) return null;
  return tree;
}

/** A pane's place as CSS lengths, the gap taken off its inner edges only. */
function paneGeometry(p) {
  const half = GAP_PX / 2;
  const l = p.x > 1e-6 ? half : 0;
  const r = p.x + p.w < 1 - 1e-6 ? half : 0;
  const tp = p.y > 1e-6 ? half : 0;
  const b = p.y + p.h < 1 - 1e-6 ? half : 0;
  const pct = (v) => `${Math.round(v * 100000) / 1000}%`;
  return {
    left: `calc(${pct(p.x)} + ${l}px)`,
    top: `calc(${pct(p.y)} + ${tp}px)`,
    width: `calc(${pct(p.w)} - ${l + r}px)`,
    height: `calc(${pct(p.h)} - ${tp + b}px)`,
  };
}

const PANE_VARS = ['--pane-left', '--pane-top', '--pane-width', '--pane-height'];

/**
 * @param {Object} deps
 * @param {() => HTMLElement|null} deps.getContainer - #terminals-container
 * @param {() => *} deps.getActiveTerminal
 * @param {(id: *) => string|null} deps.ownerOf - the project a tab is shown under
 * @param {(id: *) => {ok: boolean, reasonKey?: string}} deps.canSplit
 * @param {(idText: string) => *} deps.resolveId - a data-id back to its Map key
 * @param {(id: *) => void} deps.activate - make a tab the active one
 * @param {() => void} [deps.onChange] - the layout changed (save it)
 * @param {(message: string) => void} [deps.notify] - toast
 * @param {(key: string, params?: Object) => string} deps.t
 * @param {() => {width: number, height: number}} [deps.measure] - container size
 */
function createSplitLayout(deps) {
  const {
    getContainer, getActiveTerminal, ownerOf, canSplit, resolveId, activate, t,
  } = deps;
  const onChange = deps.onChange || (() => {});
  const notify = deps.notify || (() => {});
  const measure = deps.measure || (() => {
    const c = getContainer();
    return { width: c ? c.clientWidth : 0, height: c ? c.clientHeight : 0 };
  });

  const layouts = new Map(); // owner project id -> tree
  const lastFocused = new Map(); // owner project id -> tab id
  let appliedKey = null;
  let pending = null; // { targetId, side }: the next new tab goes there
  let handleEls = [];
  let overlayEl = null;
  let drag = null;
  let resize = null;
  let bound = null;

  const attr = (id) => String(id).replace(/["\\]/g, '\\$&');
  const wrapperOf = (container, id) => container.querySelector(`.terminal-wrapper[data-id="${attr(id)}"]`);
  const tabOf = (id) => document.querySelector(`.terminal-tab[data-id="${attr(id)}"]`);

  function findKeyOf(id) {
    for (const [key, root] of layouts) if (contains(root, id)) return key;
    return null;
  }

  function setLayout(key, root) {
    if (root && !isLeaf(root)) layouts.set(key, root);
    else { layouts.delete(key); lastFocused.delete(key); }
  }

  function refuse(reasonKey, params) {
    notify(t(reasonKey, params));
    return { ok: false, reasonKey };
  }

  /** The applied layout as drawn in the container's current size. */
  function drawnRoot() {
    const root = appliedKey != null ? layouts.get(appliedKey) : null;
    return root ? fitToSize(root, measure()) : null;
  }

  function isShown(id) {
    if (appliedKey == null) return false;
    const root = layouts.get(appliedKey);
    return !!root && contains(root, id);
  }

  // ── Activation ──

  /**
   * Called before a tab becomes the active one. A tab of the same project that
   * is not on screen takes the focused pane, so clicking a tab always shows
   * it; the tab it replaces goes back to being hidden.
   */
  function willActivate(id, prevId) {
    if (id == null) return;
    if (pending) {
      const p = pending;
      pending = null;
      if (findKeyOf(id) == null && !sameId(id, p.targetId)) {
        placeNew(p.targetId, id, p.side);
        return;
      }
    }
    const key = ownerOf(id);
    const root = key != null ? layouts.get(key) : null;
    if (!root) return;
    if (contains(root, id)) { lastFocused.set(key, id); return; }
    if (!canSplit(id).ok) return; // shown alone; the layout waits for it
    let slot = contains(root, prevId) ? prevId : lastFocused.get(key);
    if (!contains(root, slot)) slot = leaves(root)[0];
    setLayout(key, replaceLeaf(root, slot, id));
    lastFocused.set(key, id);
    onChange();
  }

  function placeNew(targetId, newId, side) {
    const key = ownerOf(targetId);
    if (key == null || !canSplit(newId).ok || ownerOf(newId) !== key) return;
    const root = layouts.get(key);
    const base = root && contains(root, targetId) ? root : { tab: targetId };
    if (leaves(base).length >= MAX_PANES) return;
    setLayout(key, splitLeaf(base, targetId, newId, side));
    lastFocused.set(key, newId);
    onChange();
  }

  /**
   * The next tab created goes beside `targetId` instead of into its pane. The
   * caller clears it once the creation has settled, so a creation that failed
   * cannot leave it armed for an unrelated click later.
   */
  function expectNewTab(targetId, side) { pending = { targetId, side }; }
  function clearPending() { pending = null; }

  // ── Changes ──

  /**
   * Put `newId` on `side` of the pane holding `targetId`, then focus it. A tab
   * already in the layout moves there.
   */
  function split(targetId, newId, side) {
    if (!SIDES[side] || targetId == null || newId == null || sameId(targetId, newId)) return { ok: false };
    for (const id of [targetId, newId]) {
      const check = canSplit(id);
      if (!check.ok) return refuse(check.reasonKey);
    }
    const key = ownerOf(targetId);
    if (key == null || ownerOf(newId) !== key) return { ok: false };
    const root = layouts.get(key);
    let base = root && contains(root, targetId) ? root : { tab: targetId };
    if (contains(base, newId)) base = removeLeaf(base, newId);
    if (!base || !contains(base, targetId)) return { ok: false };
    if (leaves(base).length >= MAX_PANES) return refuse('terminals.splitMaxPanes', { count: MAX_PANES });
    const next = splitLeaf(base, targetId, newId, side);
    const size = measure();
    // A container with no size is not on screen: there is nothing to measure
    // against, and the next resize will lay it out anyway.
    if (size.width > 0 && size.height > 0 && !fitsMinimum(next, size)) return refuse('terminals.splitTooSmall');
    setLayout(key, next);
    lastFocused.set(key, newId);
    onChange();
    activate(newId);
    apply();
    return { ok: true };
  }

  /** Whether one more pane fits beside `targetId`, said with a toast when not. */
  function canSplitBeside(targetId, side) {
    const check = canSplit(targetId);
    if (!check.ok) return refuse(check.reasonKey);
    const key = ownerOf(targetId);
    const root = key != null ? layouts.get(key) : null;
    const base = root && contains(root, targetId) ? root : { tab: targetId };
    if (leaves(base).length >= MAX_PANES) return refuse('terminals.splitMaxPanes', { count: MAX_PANES });
    const probe = splitLeaf(base, targetId, { probe: true }, side);
    const size = measure();
    if (size.width > 0 && size.height > 0 && !fitsMinimum(probe, size)) return refuse('terminals.splitTooSmall');
    return { ok: true };
  }

  /**
   * Take a tab out of its layout. Returns the tab that should be focused
   * afterwards (the closed pane's neighbour, or whatever stays on screen), or
   * null when the tab was in no layout. Call it before the tab leaves the
   * terminals state: the answer depends on whether it was the active one.
   */
  function removeTab(id) {
    const key = findKeyOf(id);
    if (key == null) return null;
    const root = layouts.get(key);
    const wasActive = sameId(getActiveTerminal(), id);
    const next = removeLeaf(root, id);
    setLayout(key, next);
    if (sameId(lastFocused.get(key), id)) lastFocused.delete(key);
    onChange();
    if (!next) return null;
    if (!wasActive) {
      const active = getActiveTerminal();
      return contains(next, active) ? active : leaves(next)[0];
    }
    return neighbourOf(root, id) ?? leaves(next)[0];
  }

  /** The first leaf of the subtree that sits beside `id`. */
  function neighbourOf(node, id) {
    if (!node || isLeaf(node)) return null;
    if (isLeaf(node.a) && sameId(node.a.tab, id)) return leaves(node.b)[0];
    if (isLeaf(node.b) && sameId(node.b.tab, id)) return leaves(node.a)[0];
    return contains(node.a, id) ? neighbourOf(node.a, id) : neighbourOf(node.b, id);
  }

  /** "Remove from split view": the tab stays open, its pane goes. */
  function detach(id) {
    const wasActive = sameId(getActiveTerminal(), id);
    const successor = removeTab(id);
    if (wasActive && successor != null) activate(successor);
    apply();
  }

  /** "Exit split view": the active tab stays, alone. */
  function exitSplit(id) {
    const key = findKeyOf(id) ?? ownerOf(id);
    if (key == null || !layouts.has(key)) return;
    setLayout(key, null);
    onChange();
    apply();
  }

  // ── Drawing ──

  function apply() {
    const container = getContainer();
    if (!container) return;
    bind(container);
    const active = getActiveTerminal();
    const key = active != null ? findKeyOf(active) : null;
    const root = key != null ? layouts.get(key) : null;
    const shown = !!root && leaves(root).every((id) => {
      const w = wrapperOf(container, id);
      return !!w && w.style.display !== 'none';
    });
    appliedKey = shown ? key : null;
    if (shown) lastFocused.set(key, active);

    const ids = shown ? leaves(root).map(String) : [];
    container.querySelectorAll('.terminal-wrapper.split-pane').forEach((w) => {
      if (!ids.includes(w.dataset.id)) clearPane(w);
    });
    document.querySelectorAll('.terminal-tab.in-split').forEach((tab) => {
      if (!ids.includes(tab.dataset.id)) tab.classList.remove('in-split');
    });
    for (const id of ids) {
      const w = wrapperOf(container, id);
      if (!w.classList.contains('split-pane')) w.classList.add('split-pane');
      ensurePaneClose(w);
      tabOf(id)?.classList.add('in-split');
    }
    container.classList.toggle('is-split', shown);
    positionPanes();
  }

  function clearPane(w) {
    w.classList.remove('split-pane');
    for (const v of PANE_VARS) w.style.removeProperty(v);
    w.querySelector(':scope > .split-pane-close')?.remove();
  }

  /** Each pane carries its own way out. Re-added after a mode switch empties the wrapper. */
  function ensurePaneClose(w) {
    if (w.querySelector(':scope > .split-pane-close')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'split-pane-close';
    btn.title = t('terminals.splitClosePane');
    btn.setAttribute('aria-label', t('terminals.splitClosePane'));
    btn.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      detach(resolveId(w.dataset.id));
    });
    w.appendChild(btn);
  }

  /** Pane geometry and handles; the only thing a handle drag repaints. */
  function positionPanes() {
    const container = getContainer();
    if (!container) return;
    const root = drawnRoot();
    const { panes, handles } = root ? computeRects(root) : { panes: [], handles: [] };
    for (const p of panes) {
      const w = wrapperOf(container, p.id);
      if (!w) continue;
      const g = paneGeometry(p);
      w.style.setProperty('--pane-left', g.left);
      w.style.setProperty('--pane-top', g.top);
      w.style.setProperty('--pane-width', g.width);
      w.style.setProperty('--pane-height', g.height);
    }
    syncHandles(container, handles, root);
  }

  function syncHandles(container, handles, root) {
    const signature = handles.map((h) => `${h.path}:${h.dir}`).join('|');
    if (signature !== handleEls.map((el) => `${el.dataset.path}:${el.dataset.dir}`).join('|')) {
      handleEls.forEach((el) => el.remove());
      handleEls = handles.map((h) => createHandle(h));
      handleEls.forEach((el) => container.appendChild(el));
    }
    handles.forEach((h, i) => {
      const el = handleEls[i];
      const pct = (v) => `${Math.round(v * 100000) / 1000}%`;
      if (h.dir === 'row') {
        el.style.left = `calc(${pct(h.x)} - ${GAP_PX / 2}px)`;
        el.style.top = pct(h.y);
        el.style.width = `${GAP_PX}px`;
        el.style.height = pct(h.h);
      } else {
        el.style.left = pct(h.x);
        el.style.top = `calc(${pct(h.y)} - ${GAP_PX / 2}px)`;
        el.style.width = pct(h.w);
        el.style.height = `${GAP_PX}px`;
      }
      const split = nodeAt(root, h.path);
      if (split) el.setAttribute('aria-valuenow', String(Math.round(split.ratio * 100)));
    });
  }

  function createHandle(h) {
    const el = document.createElement('div');
    el.className = `split-handle ${h.dir}`;
    el.dataset.path = h.path;
    el.dataset.dir = h.dir;
    el.tabIndex = 0;
    el.setAttribute('role', 'separator');
    // A 'row' split puts panes side by side, so its separator line is vertical.
    el.setAttribute('aria-orientation', h.dir === 'row' ? 'vertical' : 'horizontal');
    el.setAttribute('aria-valuemin', String(MIN_RATIO * 100));
    el.setAttribute('aria-valuemax', String(MAX_RATIO * 100));
    el.setAttribute('aria-label', t('terminals.splitResize'));
    el.addEventListener('pointerdown', onHandleDown);
    el.addEventListener('dblclick', () => setRatio(el.dataset.path, 0.5, true));
    el.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -0.05, ArrowUp: -0.05, ArrowRight: 0.05, ArrowDown: 0.05 }[e.key];
      if (step === undefined) return;
      const split = nodeAt(drawnRoot(), el.dataset.path);
      if (!split) return;
      e.preventDefault();
      setRatio(el.dataset.path, split.ratio + step, true);
    });
    return el;
  }

  /** Move a split, within its bounds. Returns whether anything moved. */
  function setRatio(path, ratio, save) {
    // From the tree as drawn: a handle moves from where the user sees it.
    const root = drawnRoot();
    const split = nodeAt(root, path);
    if (!split || isLeaf(split)) return false;
    const bounds = ratioBounds(root, path, measure());
    if (!bounds) return false;
    const next = Math.min(bounds.hi, Math.max(bounds.lo, ratio));
    if (Math.abs(next - split.ratio) < 1e-4) return false;
    layouts.set(appliedKey, withRatio(root, path, next));
    positionPanes();
    if (save) onChange();
    return true;
  }

  // ── Handle drag ──

  function onHandleDown(e) {
    if (e.button !== 0 || appliedKey == null) return;
    const el = e.currentTarget;
    const handle = computeRects(drawnRoot()).handles.find((h) => h.path === el.dataset.path);
    const container = getContainer();
    if (!handle || !container) return;
    e.preventDefault();
    // One measurement for the whole drag: the pointer is turned into a ratio
    // against it, so a move never reads layout after the write before it.
    const rect = container.getBoundingClientRect();
    resize = { el, path: el.dataset.path, dir: handle.dir, box: handle.box, rect, frame: 0, ratio: null, moved: false };
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic event */ }
    container.classList.add('split-resizing');
    el.classList.add('dragging');
    el.addEventListener('pointermove', onHandleMove);
    el.addEventListener('pointerup', onHandleUp);
    el.addEventListener('pointercancel', onHandleUp);
  }

  function onHandleMove(e) {
    if (!resize) return;
    const { box, rect, dir } = resize;
    resize.ratio = dir === 'row'
      ? (e.clientX - rect.left - box.x * rect.width) / (box.w * rect.width)
      : (e.clientY - rect.top - box.y * rect.height) / (box.h * rect.height);
    if (resize.frame) return;
    resize.frame = requestAnimationFrame(() => {
      if (!resize) return;
      resize.frame = 0;
      if (Number.isFinite(resize.ratio) && setRatio(resize.path, resize.ratio, false)) resize.moved = true;
    });
  }

  function onHandleUp() {
    if (!resize) return;
    const { el, frame, moved } = resize;
    if (frame) cancelAnimationFrame(frame);
    if (Number.isFinite(resize.ratio) && setRatio(resize.path, resize.ratio, false)) resize.moved = true;
    const changed = moved || resize.moved;
    resize = null;
    el.classList.remove('dragging');
    el.removeEventListener('pointermove', onHandleMove);
    el.removeEventListener('pointerup', onHandleUp);
    el.removeEventListener('pointercancel', onHandleUp);
    getContainer()?.classList.remove('split-resizing');
    if (changed) onChange();
  }

  // ── Dropping a tab on a pane ──

  /** A tab of the bar started dragging; the container becomes a drop target. */
  function beginTabDrag(id) {
    if (id == null) { drag = null; return; }
    drag = { id, check: canSplit(id), panes: null, origin: null, zoneKey: null, target: null };
  }

  function endTabDrag() {
    drag = null;
    hideOverlay();
  }

  /**
   * Pane rectangles in client pixels, measured once per drag at its first
   * dragover. Every later event works from these numbers, so no dragover
   * reads layout after a write.
   */
  function dragPanes(container) {
    const rect = container.getBoundingClientRect();
    const active = getActiveTerminal();
    const root = drawnRoot();
    const panes = root ? computeRects(root).panes : (active != null ? [{ id: active, x: 0, y: 0, w: 1, h: 1 }] : []);
    drag.origin = rect;
    return panes.map((p) => ({
      id: p.id,
      rect: { left: rect.left + p.x * rect.width, top: rect.top + p.y * rect.height, width: p.w * rect.width, height: p.h * rect.height },
    }));
  }

  /** What dropping here would do, or null for nothing. */
  function dropTarget(x, y) {
    for (const pane of drag.panes) {
      const zone = zoneAt(pane.rect, x, y);
      if (!zone) continue;
      if (sameId(pane.id, drag.id)) return null;
      if (zone === 'center' && !appliedKey) return null; // already what is shown
      if (ownerOf(pane.id) !== ownerOf(drag.id)) return null;
      return { pane, zone };
    }
    return null;
  }

  function onDragOver(e) {
    if (!drag) return;
    const container = e.currentTarget;
    e.preventDefault();
    e.stopPropagation();
    if (!drag.check.ok) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      if (drag.zoneKey !== 'refused') {
        drag.zoneKey = 'refused';
        showOverlay(container, null, t(drag.check.reasonKey));
      }
      return;
    }
    if (!drag.panes) drag.panes = dragPanes(container);
    const target = dropTarget(e.clientX, e.clientY);
    if (e.dataTransfer) e.dataTransfer.dropEffect = target ? 'move' : 'none';
    const zoneKey = target ? `${target.pane.id}|${target.zone}` : null;
    if (zoneKey === drag.zoneKey) return; // nothing moved: write nothing
    drag.zoneKey = zoneKey;
    drag.target = target;
    if (!target) { hideOverlay(); return; }
    showOverlay(container, zoneRect(target), null);
  }

  /** The part of the pane the dragged tab would take, in container pixels. */
  function zoneRect({ pane, zone }) {
    const origin = drag.origin;
    const r = { left: pane.rect.left - origin.left, top: pane.rect.top - origin.top, width: pane.rect.width, height: pane.rect.height };
    if (zone === 'left') r.width /= 2;
    else if (zone === 'right') { r.left += r.width / 2; r.width /= 2; }
    else if (zone === 'top') r.height /= 2;
    else if (zone === 'bottom') { r.top += r.height / 2; r.height /= 2; }
    return r;
  }

  function showOverlay(container, r, message) {
    if (!overlayEl || overlayEl.parentElement !== container) {
      overlayEl?.remove();
      overlayEl = document.createElement('div');
      overlayEl.className = 'split-drop-overlay';
      overlayEl.setAttribute('aria-hidden', 'true');
      container.appendChild(overlayEl);
    }
    overlayEl.classList.toggle('refused', !!message);
    overlayEl.textContent = message || '';
    const box = r || { left: 0, top: 0, width: container.clientWidth, height: container.clientHeight };
    overlayEl.style.left = `${box.left}px`;
    overlayEl.style.top = `${box.top}px`;
    overlayEl.style.width = message && !r ? '100%' : `${box.width}px`;
    overlayEl.style.height = message && !r ? '100%' : `${box.height}px`;
    overlayEl.hidden = false;
  }

  function hideOverlay() {
    if (overlayEl && !overlayEl.hidden) overlayEl.hidden = true;
  }

  function onDragLeave(e) {
    if (!drag) return;
    const container = e.currentTarget;
    if (e.relatedTarget && container.contains(e.relatedTarget)) return;
    drag.zoneKey = null;
    drag.target = null;
    hideOverlay();
  }

  function onDrop(e) {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const { id, check, target } = drag;
    endTabDrag();
    if (!check.ok) { refuse(check.reasonKey); return; }
    if (!target) return;
    const paneId = target.pane.id;
    if (target.zone === 'center') {
      const key = findKeyOf(paneId);
      const root = layouts.get(key);
      if (!root) return;
      setLayout(key, contains(root, id) ? swapLeaves(root, paneId, id) : replaceLeaf(root, paneId, id));
      lastFocused.set(key, id);
      onChange();
      activate(id);
      apply();
      return;
    }
    split(paneId, id, target.zone);
  }

  // ── Focus follows the pointer's click ──

  function focusPaneOf(e) {
    const container = e.currentTarget;
    if (!container.classList.contains('is-split')) return;
    const w = e.target.closest?.('.terminal-wrapper.split-pane');
    if (!w || w.parentElement !== container) return;
    if (sameId(w.dataset.id, getActiveTerminal())) return;
    activate(resolveId(w.dataset.id));
  }

  function bind(container) {
    if (bound && bound.container === container) return;
    unbind();
    const listeners = [
      ['dragover', onDragOver, true],
      ['dragleave', onDragLeave, true],
      ['drop', onDrop, true],
      ['pointerdown', focusPaneOf, true],
      ['focusin', focusPaneOf, true],
    ];
    for (const [type, fn, capture] of listeners) container.addEventListener(type, fn, capture);
    // A window resize can push a pane under its minimum: redraw the fitted tree.
    let frame = 0;
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
        if (appliedKey == null || frame) return;
        frame = requestAnimationFrame(() => { frame = 0; positionPanes(); });
      })
      : null;
    observer?.observe(container);
    bound = { container, listeners, observer };
  }

  function unbind() {
    if (!bound) return;
    for (const [type, fn, capture] of bound.listeners) bound.container.removeEventListener(type, fn, capture);
    bound.observer?.disconnect();
    bound = null;
  }

  // ── Persistence ──

  /** The layout of a project as saved, or null. */
  function serializeFor(projectId, indexOf) {
    const root = layouts.get(projectId);
    if (!root) return null;
    const tree = serializeLayout(root, indexOf);
    if (!tree) return null;
    const focusedIdx = indexOf(lastFocused.get(projectId));
    return { root: tree, focused: Number.isInteger(focusedIdx) && focusedIdx >= 0 ? focusedIdx : null };
  }

  /** Restore a saved layout; `idAt(i)` is the restored tab at saved index i. Returns the tab to focus. */
  function restore(projectId, saved, idAt) {
    if (!saved || typeof saved !== 'object') return null;
    const root = deserializeLayout(saved.root, (i) => {
      const id = idAt(i);
      return id != null && canSplit(id).ok && ownerOf(id) === projectId ? id : null;
    });
    if (!root) return null;
    setLayout(projectId, root);
    const focused = Number.isInteger(saved.focused) ? idAt(saved.focused) : null;
    const target = focused != null && contains(root, focused) ? focused : leaves(root)[0];
    lastFocused.set(projectId, target);
    return target;
  }

  function destroy() {
    if (resize) onHandleUp();
    unbind();
    handleEls.forEach((el) => el.remove());
    handleEls = [];
    overlayEl?.remove();
    overlayEl = null;
    const container = getContainer();
    if (container) {
      container.classList.remove('is-split', 'split-resizing');
      container.querySelectorAll('.terminal-wrapper.split-pane').forEach(clearPane);
    }
    document.querySelectorAll('.terminal-tab.in-split').forEach((tab) => tab.classList.remove('in-split'));
    layouts.clear();
    lastFocused.clear();
    appliedKey = null;
    pending = null;
    drag = null;
  }

  return {
    willActivate,
    expectNewTab,
    clearPending,
    split,
    canSplitBeside,
    removeTab,
    detach,
    exitSplit,
    apply,
    isShown,
    isInLayout: (id) => findKeyOf(id) != null,
    hasLayout: (projectId) => layouts.has(projectId),
    getLayout: (projectId) => layouts.get(projectId) || null,
    paneCount: (projectId) => leaves(layouts.get(projectId)).length,
    beginTabDrag,
    endTabDrag,
    serializeFor,
    restore,
    destroy,
  };
}

module.exports = {
  createSplitLayout,
  // Pure tree helpers, exported for the tests and the session service.
  leaves,
  contains,
  splitLeaf,
  removeLeaf,
  replaceLeaf,
  swapLeaves,
  computeRects,
  fitsMinimum,
  ratioBounds,
  fitToSize,
  minExtent,
  zoneAt,
  serializeLayout,
  deserializeLayout,
  paneGeometry,
  MAX_PANES,
  MIN_RATIO,
  MAX_RATIO,
  MIN_PANE_WIDTH,
  MIN_PANE_HEIGHT,
};
