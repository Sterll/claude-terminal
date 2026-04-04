/**
 * Cloud Shared Helpers
 * Common utilities used by both cloud-relay.ipc.js and cloud-projects.ipc.js
 */

const fs = require('fs');
const { settingsFile } = require('../utils/paths');

const FETCH_TIMEOUT_MS = 10000;
const FETCH_DOWNLOAD_TIMEOUT_MS = 60000;

function _loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    }
  } catch (e) {
    console.warn('[Cloud] Failed to parse settings:', e.message);
  }
  return {};
}

function _getCloudConfig() {
  const settings = _loadSettings();
  const url = settings.cloudServerUrl;
  const key = settings.cloudApiKey;
  if (!url || !key) throw new Error('Cloud not configured');
  const trimmed = url.replace(/\/$/, '');
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('Cloud server URL must start with http:// or https://');
  return { url: trimmed, key };
}

/**
 * Fetch with timeout via AbortController.
 * @param {string} url
 * @param {RequestInit} opts
 * @param {number} [timeoutMs]
 */
async function _fetchCloud(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  FETCH_TIMEOUT_MS,
  FETCH_DOWNLOAD_TIMEOUT_MS,
  _loadSettings,
  _getCloudConfig,
  _fetchCloud,
};
