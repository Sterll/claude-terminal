/**
 * Python Renderer Service
 * Handles Python detection in the renderer
 */

const api = window.electron_api;
const { getPythonInfo, setPythonInfo } = require('./PythonState');

// Cache TTL: 60 seconds
const CACHE_TTL = 60000;
const lastDetection = new Map();

async function detectPythonInfo(projectIndex, projectPath) {
  const now = Date.now();
  const lastTime = lastDetection.get(projectIndex) || 0;

  // Return cached if fresh
  if (now - lastTime < CACHE_TTL) {
    return getPythonInfo(projectIndex);
  }

  try {
    const info = await api.python.detectInfo({ projectPath });
    setPythonInfo(projectIndex, info);
    lastDetection.set(projectIndex, now);
    return info;
  } catch (e) {
    console.error('[Python] Detection error:', e);
    return getPythonInfo(projectIndex);
  }
}

function invalidateCache(projectIndex) {
  lastDetection.delete(projectIndex);
}

module.exports = {
  detectPythonInfo,
  invalidateCache
};
