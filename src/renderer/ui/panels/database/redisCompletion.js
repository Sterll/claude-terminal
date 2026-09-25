/**
 * Completion for the Redis query editor: command names at the start of a
 * line, key names where the command's signature expects a key. The SQL
 * completion the editor already had was switched off for Redis because
 * tables and columns mean nothing there.
 */

const { REDIS_COMMANDS } = require('../../../../shared/redis-commands');

const MAX_SUGGESTIONS = 12;

/** Whether the argument at `index` (0-based, after the command) names a key. */
function isKeyArgument(spec, index) {
  const words = spec.args.split(' ');
  if (index === 0) return words[0] === 'key' || words[0] === 'source';
  // Variadic key lists: DEL key [key ...], MGET, EXISTS, SINTER...
  if (words[1] === '[key') return true;
  return index === 1 && words[1] === 'destination';
}

/** A key as it has to be typed: quoted when it holds spaces or quotes. */
function typedKey(key) {
  return /[\s"']/.test(key) ? JSON.stringify(key) : key;
}

/**
 * @param {string} text - whole editor content
 * @param {number} cursor - caret offset
 * @param {string[]} keys - key names the browser has loaded, if any
 * @returns {{ partial: string, partialStart: number, suggestions: Array<{ text: string, type: string, detail?: string }> } | null}
 */
function redisCompletions(text, cursor, keys = []) {
  const before = text.slice(0, cursor);
  const line = before.slice(before.lastIndexOf('\n') + 1).replace(/^\s+/, '');
  if (!line || /\s$/.test(line)) return null;

  const tokens = line.split(/\s+/);
  const partial = tokens[tokens.length - 1];
  const partialStart = cursor - partial.length;

  if (tokens.length === 1) {
    const upper = partial.toUpperCase();
    const suggestions = REDIS_COMMANDS
      .filter(c => c.name.startsWith(upper))
      .slice(0, MAX_SUGGESTIONS)
      .map(c => ({ text: c.name, type: 'keyword', detail: c.args }));
    return { partial, partialStart, suggestions };
  }

  const spec = REDIS_COMMANDS.find(c => c.name === tokens[0].toUpperCase());
  if (!spec || !isKeyArgument(spec, tokens.length - 2)) return null;
  const typed = partial.replace(/^"/, '');
  const suggestions = keys
    .filter(k => k.startsWith(typed))
    .slice(0, MAX_SUGGESTIONS)
    .map(k => ({ text: typedKey(k), type: 'column' }));
  return { partial, partialStart, suggestions };
}

module.exports = { redisCompletions, isKeyArgument };
