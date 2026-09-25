/**
 * Pure helpers behind the Redis key browser: no DOM, no IPC, so they can be
 * tested on their own.
 */

/**
 * Group key names into folders on a separator, the way every Redis GUI does:
 * `user:42:profile` becomes user > 42 > profile. An empty separator gives a
 * flat list, for keyspaces that do not use one.
 */
function buildRedisTree(keys, filter = '', separator = ':') {
  const root = { children: new Map(), keys: [], keyCount: 0 };
  const needle = filter.toLowerCase();
  const filtered = needle ? keys.filter(k => k.toLowerCase().includes(needle)) : keys;

  for (const key of filtered) {
    const parts = separator ? key.split(separator) : [key];
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.children.has(parts[i])) {
        node.children.set(parts[i], { children: new Map(), keys: [], keyCount: 0 });
      }
      node = node.children.get(parts[i]);
    }
    node.keys.push(key);
  }

  (function count(n) {
    let c = n.keys.length;
    for (const child of n.children.values()) c += count(child);
    return (n.keyCount = c);
  })(root);

  return root;
}

/** The last segment of a key, as the tree shows it under its folder. */
function leafName(key, separator = ':') {
  if (!separator) return key;
  const at = key.lastIndexOf(separator);
  return at < 0 ? key : key.slice(at + separator.length);
}

function formatTtl(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

/**
 * Whether a filter can be answered from the keys already loaded, or needs a
 * scan on the server. The loaded list is complete for `loadedPattern` unless
 * it was truncated, and a filter that only narrows it (contains it) selects a
 * subset of that list. Anything else - a wider filter, or any filter over a
 * partial list - could be missing keys that exist.
 */
function canFilterLocally({ filter, loadedPattern, truncated }) {
  const f = (filter || '').toLowerCase();
  const loaded = (loadedPattern || '').toLowerCase();
  if (f === loaded) return true;
  if (truncated) return false;
  return f.includes(loaded);
}

module.exports = { buildRedisTree, leafName, formatTtl, canFilterLocally };
