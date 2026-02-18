/**
 * Marketplace Service
 * Handles skill discovery, installation and management via skills.sh API
 */

const https = require('https');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const homeDir = os.homedir();
const skillsDir = path.join(homeDir, '.claude', 'skills');
const dataDir = path.join(homeDir, '.claude-terminal');
const manifestFile = path.join(dataDir, 'marketplace.json');

// In-memory cache with TTL
const cache = new Map();
const CACHE_TTL = {
  featured: 10 * 60 * 1000,  // 10 min
  search: 5 * 60 * 1000,     // 5 min
  readme: 30 * 60 * 1000,    // 30 min
  installed: 2 * 60 * 1000   // 2 min
};

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

/**
 * Make an HTTPS GET request and return parsed JSON
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

/**
 * Fetch raw text content from a URL (for README/SKILL.md files)
 */
function httpsGetText(urlString) {
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
      // Handle redirects
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return httpsGetText(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Search skills on skills.sh
 */
async function searchSkills(query, limit = 20) {
  const cacheKey = `search:${query}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const encoded = encodeURIComponent(query);
  const result = await httpsGet(`https://skills.sh/api/search?q=${encoded}&limit=${limit}`);
  if (result.status !== 200) {
    throw new Error(`API returned status ${result.status}`);
  }
  setCache(cacheKey, result.data, CACHE_TTL.search);
  return result.data;
}

/**
 * Get featured/popular skills by combining multiple popular queries
 */
async function getFeatured(limit = 30) {
  const cacheKey = `featured:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const queries = ['best', 'practices', 'code', 'react', 'typescript'];
  const allSkills = new Map();

  // Fetch from multiple queries to get a diverse set
  const results = await Promise.allSettled(
    queries.map(q => httpsGet(`https://skills.sh/api/search?q=${q}&limit=${Math.ceil(limit / 2)}`))
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.status === 200) {
      const skills = result.value.data.skills || [];
      for (const skill of skills) {
        // Deduplicate by id
        if (!allSkills.has(skill.id)) {
          allSkills.set(skill.id, skill);
        }
      }
    }
  }

  // Sort by installs descending and limit
  const skills = Array.from(allSkills.values())
    .sort((a, b) => (b.installs || 0) - (a.installs || 0))
    .slice(0, limit);

  const data = { skills, count: skills.length };
  setCache(cacheKey, data, CACHE_TTL.featured);
  return data;
}

/**
 * List subdirectories in a GitHub repo path via API
 */
async function listGitHubDir(source, dirPath) {
  try {
    const result = await httpsGet(`https://api.github.com/repos/${source}/contents/${dirPath}`);
    if (result.status === 200 && Array.isArray(result.data)) {
      return result.data.filter(item => item.type === 'dir').map(item => item.name);
    }
  } catch { /* ignore */ }
  return [];
}

/**
 * Get the SKILL.md readme content from GitHub
 * Handles cases where the folder name differs from skillId (e.g. repo has "react-best-practices" but skillId is "vercel-react-best-practices")
 */
async function getSkillReadme(source, skillId) {
  const cacheKey = `readme:${source}:${skillId}`;
  const cached = getCached(cacheKey);
  if (cached !== null) return cached;

  const branches = ['main', 'master'];

  // Build candidate paths including the skillId itself and partial matches
  const directPaths = [
    `skills/${skillId}/SKILL.md`,
    `${skillId}/SKILL.md`,
    `SKILL.md`
  ];

  // First try direct paths on both branches
  for (const branch of branches) {
    for (const filePath of directPaths) {
      try {
        const url = `https://raw.githubusercontent.com/${source}/${branch}/${filePath}`;
        const result = await httpsGetText(url);
        if (result.status === 200 && result.data) {
          setCache(cacheKey, result.data, CACHE_TTL.readme);
          return result.data;
        }
      } catch { /* try next */ }
    }
  }

  // If direct paths failed, list the skills/ directory and find a matching folder
  // The folder name might be a suffix of the skillId (e.g. "react-best-practices" matches "vercel-react-best-practices")
  try {
    const subdirs = await listGitHubDir(source, 'skills');
    if (subdirs.length > 0) {
      const match = subdirs.find(dir => skillId.endsWith(dir) || dir.endsWith(skillId) || skillId.includes(dir));
      if (match) {
        for (const branch of branches) {
          try {
            const url = `https://raw.githubusercontent.com/${source}/${branch}/skills/${match}/SKILL.md`;
            const result = await httpsGetText(url);
            if (result.status === 200 && result.data) {
              setCache(cacheKey, result.data, CACHE_TTL.readme);
              return result.data;
            }
          } catch { /* try next branch */ }
        }
      }
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * Clone a repo to a temp directory
 * Uses execFile instead of exec to prevent shell injection via repoUrl
 */
function gitCloneTemp(repoUrl) {
  return new Promise((resolve, reject) => {
    // Validate repoUrl format before cloning
    if (typeof repoUrl !== 'string' || !/^https:\/\/github\.com\/[\w.\-]+\/[\w.\-]+(\.git)?$/.test(repoUrl)) {
      return reject(new Error(`Invalid repository URL: ${repoUrl}`));
    }

    const tmpDir = path.join(os.tmpdir(), `claude-marketplace-${Date.now()}`);
    // Use execFile (no shell) to prevent injection — arguments passed as array
    execFile(
      'git',
      ['clone', '--depth', '1', repoUrl, tmpDir],
      { timeout: 120000, maxBuffer: 1024 * 1024 * 10 },
      (error) => {
        if (error) {
          reject(new Error(`Clone failed: ${error.message}`));
        } else {
          resolve(tmpDir);
        }
      }
    );
  });
}

/**
 * Recursively copy a directory
 */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Install a skill from the marketplace
 */
async function installSkill({ source, skillId, name, installs }) {
  console.debug(`[Marketplace] Installing skill ${skillId} from ${source}`);

  const repoUrl = `https://github.com/${source}.git`;
  let tmpDir = null;

  try {
    // 1. Clone to temp
    tmpDir = await gitCloneTemp(repoUrl);

    // 2. Find the skill directory
    let skillSourceDir = null;
    const candidates = [
      path.join(tmpDir, 'skills', skillId),
      path.join(tmpDir, skillId),
      tmpDir // root of repo if it's a single-skill repo
    ];

    for (const candidate of candidates) {
      const skillMd = path.join(candidate, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        skillSourceDir = candidate;
        break;
      }
    }

    // If not found, scan skills/ directory for partial matches
    // (e.g. skillId "vercel-react-best-practices" but folder is "react-best-practices")
    if (!skillSourceDir) {
      const skillsSubDir = path.join(tmpDir, 'skills');
      if (fs.existsSync(skillsSubDir)) {
        try {
          const subdirs = fs.readdirSync(skillsSubDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
          const match = subdirs.find(dir =>
            skillId.endsWith(dir) || dir.endsWith(skillId) || skillId.includes(dir)
          );
          if (match) {
            const candidate = path.join(skillsSubDir, match);
            if (fs.existsSync(path.join(candidate, 'SKILL.md'))) {
              skillSourceDir = candidate;
            }
          }
        } catch { /* ignore */ }
      }
    }

    if (!skillSourceDir) {
      throw new Error(`Could not find SKILL.md in repository ${source}`);
    }

    // 3. Copy to ~/.claude/skills/{skillId}/
    const destDir = path.join(skillsDir, skillId);
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    fs.mkdirSync(destDir, { recursive: true });
    copyDirSync(skillSourceDir, destDir);

    // Remove .git if we copied the whole repo
    const gitDir = path.join(destDir, '.git');
    if (fs.existsSync(gitDir)) {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }

    // 4. Update manifest
    const manifest = loadManifest();
    manifest.installed[skillId] = {
      skillId,
      name: name || skillId,
      source,
      installs: installs || 0,
      installedAt: new Date().toISOString(),
      path: destDir
    };
    saveManifest(manifest);

    invalidateCache('installed');
    console.debug(`[Marketplace] Skill ${skillId} installed successfully`);
    return { success: true, path: destDir };
  } finally {
    // 5. Cleanup temp
    if (tmpDir && fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (e) {
        console.warn('[Marketplace] Could not cleanup temp dir:', e.message);
      }
    }
  }
}

/**
 * Uninstall a skill
 */
function uninstallSkill(skillId) {
  console.debug(`[Marketplace] Uninstalling skill ${skillId}`);

  const skillDir = path.join(skillsDir, skillId);
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }

  const manifest = loadManifest();
  delete manifest.installed[skillId];
  saveManifest(manifest);

  invalidateCache('installed');
  return { success: true };
}

/**
 * Get list of installed marketplace skills
 */
function getInstalled() {
  const cached = getCached('installed');
  if (cached) return cached;

  const manifest = loadManifest();
  const installed = [];

  for (const [skillId, info] of Object.entries(manifest.installed)) {
    const skillDir = path.join(skillsDir, skillId);
    if (fs.existsSync(skillDir)) {
      installed.push(info);
    } else {
      // Skill was deleted externally, clean up manifest
      delete manifest.installed[skillId];
    }
  }

  // Save cleaned manifest
  saveManifest(manifest);
  setCache('installed', installed, CACHE_TTL.installed);
  return installed;
}

/**
 * Load marketplace manifest
 */
function loadManifest() {
  try {
    if (fs.existsSync(manifestFile)) {
      const data = fs.readFileSync(manifestFile, 'utf8');
      const manifest = JSON.parse(data);
      if (!manifest.installed) manifest.installed = {};
      return manifest;
    }
  } catch (e) {
    console.error('[Marketplace] Error loading manifest:', e);
  }
  return { installed: {} };
}

/**
 * Save marketplace manifest
 */
function saveManifest(manifest) {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
  } catch (e) {
    console.error('[Marketplace] Error saving manifest:', e);
  }
}

module.exports = {
  searchSkills,
  getFeatured,
  getSkillReadme,
  installSkill,
  uninstallSkill,
  getInstalled
};
