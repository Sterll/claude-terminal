/**
 * Three-way merge for projects.json.
 *
 * projects.json has several independent writers: this renderer, the MCP server
 * (kanban tools), and ParallelTaskService (worktree projects). The renderer
 * used to rewrite the whole file from its in-memory copy, so anything written
 * by another process after the renderer loaded was silently destroyed — a
 * kanban board filled from an MCP session disappeared the moment the renderer
 * saved for any unrelated reason.
 *
 * Rewriting is only safe with a baseline: the content we last agreed on with
 * the disk. With `base` (last synced), `ours` (in memory) and `theirs` (on
 * disk right now) we can tell "we changed this" apart from "we never saw it",
 * which a two-way comparison cannot do. A field we did not touch takes the
 * disk's value; a field we did touch keeps ours.
 *
 * Deletion follows from the same rule: an entity on disk that is absent from
 * memory was deleted by us only if the baseline knew it. If the baseline never
 * had it, it is new from another writer and must be kept.
 */

/** Stable deep equality — the values here are plain JSON. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/**
 * Merge one entity field by field.
 *
 * A field we left as the baseline found it is a field we have no opinion on,
 * so the disk wins — that is what carries an MCP-written `tasks` array through
 * a save triggered by something else entirely. Any field we did change stays
 * ours, including a field we cleared on purpose.
 */
function mergeEntity(base, ours, theirs) {
  const result = {};
  const keys = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(ours || {}),
    ...Object.keys(theirs || {}),
  ]);

  for (const key of keys) {
    const b = base ? base[key] : undefined;
    const o = ours ? ours[key] : undefined;
    const t = theirs ? theirs[key] : undefined;

    const value = deepEqual(o, b) ? t : o;
    if (value !== undefined) result[key] = value;
  }

  return result;
}

/**
 * Merge a list of id-keyed entities (projects or folders).
 * @returns {Array} merged entities, ours first (stable UI order), then theirs
 */
function mergeEntityList(baseList, ourList, theirList) {
  const byId = (list) => new Map((list || []).filter(e => e && e.id).map(e => [e.id, e]));
  const base = byId(baseList);
  const ours = byId(ourList);
  const theirs = byId(theirList);

  const merged = [];

  // Ours drives the order: the list the user is looking at keeps its shape.
  for (const [id, o] of ours) {
    merged.push(mergeEntity(base.get(id), o, theirs.get(id)));
  }

  // On disk but not in memory: ours only if the baseline knew it (we deleted
  // it). Otherwise another writer added it while we were running — keep it.
  for (const [id, t] of theirs) {
    if (ours.has(id)) continue;
    if (base.has(id)) continue; // deleted by us
    merged.push(t);
  }

  return merged;
}

/**
 * Reconcile an order array against the entities that actually survived.
 * Drops ids of deleted entities and appends any root-level entity missing
 * from the order, so a project added by another process is still reachable.
 */
function reconcileOrder(baseOrder, ourOrder, theirOrder, rootIds) {
  const chosen = deepEqual(ourOrder || [], baseOrder || [])
    ? (theirOrder || [])
    : (ourOrder || []);

  const seen = new Set();
  const order = [];

  for (const id of chosen) {
    if (rootIds.has(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }

  // Anything root-level that no order array mentioned yet.
  for (const id of rootIds) {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }

  return order;
}

/**
 * Three-way merge of the whole projects.json payload.
 *
 * @param {Object|null} base   - last content we synced with disk
 * @param {Object} ours        - current in-memory state
 * @param {Object|null} theirs - what is on disk right now
 * @returns {{projects: Array, folders: Array, rootOrder: Array}}
 */
function mergeProjectsData(base, ours, theirs) {
  const empty = { projects: [], folders: [], rootOrder: [] };

  // Nothing to reconcile against: our copy is the only truth we have.
  if (!theirs) {
    return {
      projects: ours.projects || [],
      folders: ours.folders || [],
      rootOrder: ours.rootOrder || [],
    };
  }

  const b = base || empty;

  const projects = mergeEntityList(b.projects, ours.projects, theirs.projects);
  const folders = mergeEntityList(b.folders, ours.folders, theirs.folders);

  // Root order only holds items with no parent folder.
  const rootIds = new Set([
    ...projects.filter(p => !p.folderId).map(p => p.id),
    ...folders.filter(f => !f.parentId).map(f => f.id),
  ]);

  const rootOrder = reconcileOrder(b.rootOrder, ours.rootOrder, theirs.rootOrder, rootIds);

  return { projects, folders, rootOrder };
}

/** Snapshot used as the next baseline. Plain JSON, so a clone is enough. */
function snapshot(data) {
  return {
    projects: JSON.parse(JSON.stringify(data.projects || [])),
    folders: JSON.parse(JSON.stringify(data.folders || [])),
    rootOrder: [...(data.rootOrder || [])],
  };
}

module.exports = {
  deepEqual,
  mergeEntity,
  mergeEntityList,
  reconcileOrder,
  mergeProjectsData,
  snapshot,
};
