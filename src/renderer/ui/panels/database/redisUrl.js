/**
 * Redis connection URLs, the form every hosting provider hands out:
 * `redis[s]://[[user][:password]@]host[:port][/db]`. `rediss` is TLS.
 */

/**
 * @param {string} text
 * @returns {{ host: string, port: number, username: string, password: string, database: number, tls: boolean } | null}
 */
function parseRedisUrl(text) {
  const trimmed = String(text || '').trim();
  if (!/^rediss?:\/\//i.test(trimmed)) return null;
  let url;
  try {
    // URL only fills in the parts it knows for special schemes; swap to one it parses generically
    url = new URL(trimmed.replace(/^rediss?:/i, 'http:'));
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  const dbText = url.pathname.replace(/^\//, '');
  const database = /^\d+$/.test(dbText) ? parseInt(dbText, 10) : 0;
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? parseInt(url.port, 10) : 6379,
    // `redis://:secret@host` is a password with no user, the pre-ACL form
    username: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    database,
    tls: /^rediss:/i.test(trimmed),
  };
}

/** The URL for a connection's fields, password left out: it is shown on screen. */
function buildRedisUrl({ host = 'localhost', port = 6379, username = '', database = 0, tls = false } = {}) {
  const user = username ? `${encodeURIComponent(username)}@` : '';
  const hostPart = host.includes(':') ? `[${host}]` : host;
  return `${tls ? 'rediss' : 'redis'}://${user}${hostPart}:${port || 6379}/${database || 0}`;
}

module.exports = { parseRedisUrl, buildRedisUrl };
