'use strict';

function resolveVars(value, vars) {
  if (typeof value !== 'string') return value;

  // Fast path: entire string is a single $variable — return raw value (object, array, etc.)
  const singleVarMatch = value.match(/^\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)$/);
  if (singleVarMatch) {
    const parts = singleVarMatch[1].split('.');
    if (vars.has(parts[0])) {
      let cur = vars.get(parts[0]);
      // Walk the property chain.
      //   - null/undefined intermediate → unresolvable, leave verbatim (fall through)
      //   - primitive (non-object) intermediate with remaining parts → the suffix is
      //     literal text (e.g. $today.md) → fall through to mixed-path handler
      //   - OBJECT parent whose leaf property is missing → '' (don't serialize parent)
      let fellThrough = false;
      for (let i = 1; i < parts.length; i++) {
        if (cur == null) { fellThrough = true; break; }
        if (typeof cur !== 'object') { fellThrough = true; break; }
        if (!(parts[i] in cur)) return '';
        cur = cur[parts[i]];
      }
      if (!fellThrough) {
        if (cur == null) return ''; // leaf resolved to null/undefined → empty string
        // Trailing-only CR/LF trim for strings (shell outputs commonly append one).
        // Anchored to the end, so internal newlines in multi-line content are kept.
        return typeof cur === 'string' ? cur.replace(/[\r\n]+$/, '') : cur;
      }
      // fell through → handled by mixed-path replacement below
    }
  }

  // Mixed text with variables: interpolate as strings
  return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
    const parts = key.split('.');
    if (!vars.has(parts[0])) return match; // unknown root → leave verbatim
    // Try resolving from longest path down to root variable
    // e.g. $today.md → try "today.md" (fails) → try "today" + suffix ".md"
    for (let take = parts.length; take >= 1; take--) {
      let cur = vars.get(parts[0]);
      for (let i = 1; i < take && cur != null; i++) cur = cur[parts[i]];
      if (cur != null && (take === parts.length || typeof cur !== 'object')) {
        // Trailing-only CR/LF trim (anchored to end; internal newlines preserved).
        const resolved = typeof cur === 'object' ? JSON.stringify(cur) : String(cur).replace(/[\r\n]+$/, '');
        const suffix = take < parts.length ? '.' + parts.slice(take).join('.') : '';
        return resolved + suffix;
      }
    }
    return match; // nothing resolved
  });
}

/**
 * Deep-resolve all string leaves of an object.
 * @param {any} obj
 * @param {Map<string, any>} vars
 * @returns {any}
 */
function resolveDeep(obj, vars) {
  if (typeof obj === 'string') return resolveVars(obj, vars);
  if (Array.isArray(obj))     return obj.map(v => resolveDeep(v, vars));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveDeep(v, vars);
    return out;
  }
  return obj;
}

module.exports = { resolveVars, resolveDeep };
