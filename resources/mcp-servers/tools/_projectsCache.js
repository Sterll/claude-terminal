const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CT_DATA_DIR || path.join(require('os').homedir(), '.claude-terminal');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

let _cache = null;
let _cacheAt = 0;
const TTL = 3000;

function loadProjects() {
  const now = Date.now();
  if (_cache && now - _cacheAt < TTL) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    _cacheAt = now;
    return _cache;
  } catch {
    return { projects: [], folders: [], rootOrder: [] };
  }
}

function invalidate() {
  _cache = null;
  _cacheAt = 0;
}

module.exports = { loadProjects, invalidate, PROJECTS_FILE, DATA_DIR };
