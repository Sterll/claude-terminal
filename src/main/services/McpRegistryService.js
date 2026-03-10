/**
 * MCP Registry Service
 * Handles MCP server discovery via the official MCP Registry API
 */

const { createCache, httpsGet } = require('../utils/httpCache');

const BASE_URL = 'https://registry.modelcontextprotocol.io/v0.1';

const { getCached, setCache } = createCache();
const CACHE_TTL = {
  browse: 10 * 60 * 1000,   // 10 min
  search: 5 * 60 * 1000,    // 5 min
  detail: 30 * 60 * 1000    // 30 min
};

/**
 * Filter servers that have at least one package or remote
 */
function filterInstallable(servers) {
  if (!Array.isArray(servers)) return [];
  return servers.filter(s =>
    (s.packages && s.packages.length > 0) || (s.remotes && s.remotes.length > 0)
  );
}

/**
 * Browse servers from the MCP Registry
 */
async function browseServers(limit = 50, cursor = null) {
  const cacheKey = `browse:${limit}:${cursor || 'initial'}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  let url = `${BASE_URL}/servers?limit=${limit}&version=latest`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

  const result = await httpsGet(url);
  if (result.status !== 200) {
    throw new Error(`API returned status ${result.status}`);
  }

  // The API wraps each entry as { server: {...}, _meta: {...} } — unwrap to get the server object
  const rawEntries = result.data.servers || result.data || [];
  const unwrapped = rawEntries.map(entry => (entry && entry.server ? entry.server : entry));
  const servers = filterInstallable(unwrapped);

  // Pagination cursor is nested under metadata.nextCursor
  const nextCursor = (result.data.metadata && result.data.metadata.nextCursor) ||
    result.data.cursor || result.data.nextCursor || null;

  const data = { servers, nextCursor };
  setCache(cacheKey, data, CACHE_TTL.browse);
  return data;
}

/**
 * Search servers from the MCP Registry
 */
async function searchServers(query, limit = 30) {
  const cacheKey = `search:${query}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const encoded = encodeURIComponent(query);
  const url = `${BASE_URL}/servers?search=${encoded}&limit=${limit}&version=latest`;

  const result = await httpsGet(url);
  if (result.status !== 200) {
    throw new Error(`API returned status ${result.status}`);
  }

  // The API wraps each entry as { server: {...}, _meta: {...} } — unwrap to get the server object
  const rawEntries = result.data.servers || result.data || [];
  const unwrapped = rawEntries.map(entry => (entry && entry.server ? entry.server : entry));
  const servers = filterInstallable(unwrapped);

  const data = { servers };
  setCache(cacheKey, data, CACHE_TTL.search);
  return data;
}

/**
 * Get detailed info about a specific MCP server
 */
async function getServerDetail(name) {
  const cacheKey = `detail:${name}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const encoded = encodeURIComponent(name);
  const url = `${BASE_URL}/servers/${encoded}/versions/latest`;

  const result = await httpsGet(url);
  if (result.status !== 200) {
    throw new Error(`API returned status ${result.status}`);
  }

  // The API returns { server: {...}, _meta: {...} } — unwrap to get the server object
  const server = (result.data && result.data.server) ? result.data.server : result.data;
  setCache(cacheKey, server, CACHE_TTL.detail);
  return server;
}

module.exports = {
  browseServers,
  searchServers,
  getServerDetail
};
