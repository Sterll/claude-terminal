/**
 * HTTP Cache Utilities
 * Shared HTTPS GET + in-memory TTL cache for main process services
 */

/**
 * Create a new cache instance (each service gets its own Map to avoid key collisions)
 * @returns {{ getCached, setCache, invalidateCache }}
 */
function createCache() {
  const cache = new Map();

  function getCached(key) {
    const entry = cache.get(key);
    if (entry && Date.now() < entry.expiresAt) return entry.data;
    cache.delete(key);
    return null;
  }

  function setCache(key, data, ttl) {
    cache.set(key, { data, expiresAt: Date.now() + ttl });
  }

  function invalidateCache(prefix) {
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  }

  return { getCached, setCache, invalidateCache };
}

/**
 * Make an HTTPS GET request and return parsed JSON
 * @param {string} urlString
 * @returns {Promise<{ status: number, data: * }>}
 */
async function httpsGet(urlString) {
  const url = new URL(urlString);
  if (url.protocol !== 'https:') throw new Error('HTTPS URL required');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // Chromium uses the system's trusted certificates and proxy configuration.
    // Keep certificate verification enabled, including for managed networks.
    const response = await require('electron').net.fetch(url.href, {
      headers: { 'User-Agent': 'ClaudeTerminal' },
      credentials: 'omit', cache: 'no-store', redirect: 'error',
      signal: controller.signal
    });
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* Preserve non-JSON error bodies. */ }
    return { status: response.status, data };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Request timeout');
    throw error;
  } finally { clearTimeout(timer); }
}

module.exports = { createCache, httpsGet };
