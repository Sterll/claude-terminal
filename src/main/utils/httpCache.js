/**
 * HTTP Cache Utilities
 * Shared HTTPS GET + in-memory TTL cache for main process services
 */

const https = require('https');

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
function httpsGet(urlString) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'User-Agent': 'ClaudeTerminal' },
      timeout: 15000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { createCache, httpsGet };
