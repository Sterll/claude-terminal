/**
 * Commit Message Generator
 * Uses GitHub Models API (free with GitHub account) for AI commit messages,
 * with a heuristic fallback when unavailable.
 */

const https = require('https');

// ============================================================
// GitHub Models API (GPT-4o-mini - free tier)
// ============================================================

const SYSTEM_PROMPT = `You are a commit message generator. Generate a single conventional commit message.

Rules:
- Format: type(scope): concise description
- Types: feat, fix, refactor, style, test, docs, chore, perf, ci, build
- Scope is optional, inferred from file paths
- Description must be lowercase, imperative mood, no period at the end
- Max 72 characters total
- Focus on WHAT changed and WHY, not listing files
- Output ONLY the commit message, nothing else`;

function buildPrompt(files, diffContent) {
  const fileList = files.map(f => {
    const labels = { 'M': 'modified', 'A': 'added', 'D': 'deleted', 'R': 'renamed', '?': 'new file' };
    return `  ${labels[f.status] || f.status}: ${f.path}`;
  }).join('\n');

  const maxDiff = 8000;
  const diff = diffContent.length > maxDiff
    ? diffContent.slice(0, maxDiff) + '\n[... truncated ...]'
    : diffContent;

  return `Files:\n${fileList}\n\nDiff:\n${diff}`;
}

/**
 * Generate commit message via GitHub Models API (GPT-4o-mini)
 * Free with any GitHub account.
 * @param {string} githubToken - GitHub OAuth token
 * @param {Array} files - Changed files
 * @param {string} diffContent - Diff content
 * @returns {Promise<string|null>}
 */
function generateWithGitHubModels(githubToken, files, diffContent, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const userMessage = buildPrompt(files, diffContent);

    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 100,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage }
      ]
    });

    const options = {
      hostname: 'models.inference.ai.azure.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${githubToken}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeoutMs
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0]?.message?.content) {
            let message = json.choices[0].message.content.trim()
              .replace(/^["'`]+|["'`]+$/g, '')
              .replace(/^```\w*\n?|\n?```$/g, '')
              .trim();
            message = message.split('\n')[0].trim();
            resolve(message || null);
          } else {
            console.error('[CommitGen] GitHub Models response:', data.slice(0, 300));
            resolve(null);
          }
        } catch (e) {
          console.error('[CommitGen] Parse error:', e.message);
          resolve(null);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.on('error', (err) => {
      console.error('[CommitGen] Request error:', err.message);
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

// ============================================================
// Heuristic fallback
// ============================================================

const PATH_TYPE_RULES = [
  { pattern: /\.(test|spec)\.[jt]sx?$/, type: 'test' },
  { pattern: /__tests__\//, type: 'test' },
  { pattern: /\.css$|\.scss$|\.less$|\.styl$/, type: 'style' },
  { pattern: /package\.json$|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$/, type: 'chore' },
  { pattern: /\.config\.[jt]s$|\.babelrc|\.eslintrc|tsconfig/, type: 'chore' },
  { pattern: /README|CHANGELOG|LICENSE|\.md$/, type: 'docs' },
  { pattern: /Dockerfile|docker-compose|\.dockerignore/, type: 'chore' },
  { pattern: /\.github\/|\.gitlab-ci|\.circleci/, type: 'ci' },
];

const DIFF_TYPE_SIGNALS = [
  { pattern: /(?:new|export\s+(?:default\s+)?(?:function|class|const))\b/, type: 'feat' },
  { pattern: /\bcatch\b|\bfix(?:ed|es)?\b|\bbug\b|\berror\b|\bpatch\b/, type: 'fix' },
  { pattern: /\bcache\b|\bdebounce\b|\bthrottle\b|\bmemoize\b|\blazy\b/, type: 'perf' },
  { pattern: /\brefactor\b|\brename\b|\bmove\b|\breorganize\b/, type: 'refactor' },
];

const SCOPE_MAP = {
  'renderer': 'ui', 'components': 'ui', 'ui': 'ui', 'features': 'ui',
  'main': 'main', 'ipc': 'ipc', 'services': 'services', 'utils': 'utils',
  'windows': 'windows', 'state': 'state', 'styles': 'style',
};

function detectType(files, diffContent) {
  const typeCounts = {};
  for (const file of files) {
    for (const rule of PATH_TYPE_RULES) {
      if (rule.pattern.test(file.path)) {
        typeCounts[rule.type] = (typeCounts[rule.type] || 0) + 1;
        break;
      }
    }
  }
  const pathType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
  if (pathType && pathType[1] >= files.length * 0.6) return pathType[0];

  if (diffContent) {
    for (const signal of DIFF_TYPE_SIGNALS) {
      if (signal.pattern.test(diffContent)) return signal.type;
    }
  }

  if (files.every(f => f.status === 'A' || f.status === '?')) return 'feat';
  if (files.every(f => f.status === 'D')) return 'chore';
  return 'feat';
}

function detectScope(files) {
  const dirs = files.map(f => {
    const parts = f.path.replace(/\\/g, '/').split('/');
    for (const part of parts) {
      if (part === 'src' || part === '.') continue;
      if (SCOPE_MAP[part]) return SCOPE_MAP[part];
    }
    const meaningful = parts.filter(p => p !== 'src' && p !== '.');
    return meaningful.length > 1 ? meaningful[0] : null;
  }).filter(Boolean);

  if (dirs.length === 0) return '';
  const unique = [...new Set(dirs)];
  return unique.length === 1 ? unique[0] : '';
}

function generateDescription(files) {
  if (files.length === 1) {
    const file = files[0];
    const base = file.path.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');
    switch (file.status) {
      case 'A': case '?': return `add ${base}`;
      case 'D': return `remove ${base}`;
      case 'R': return `rename ${base}`;
      default: return `update ${base}`;
    }
  }

  const added = files.filter(f => f.status === 'A' || f.status === '?');
  const deleted = files.filter(f => f.status === 'D');
  const modified = files.filter(f => f.status === 'M');
  const renamed = files.filter(f => f.status === 'R');

  const parts = [];
  if (added.length) parts.push(`add ${added.length} file${added.length > 1 ? 's' : ''}`);
  if (deleted.length) parts.push(`remove ${deleted.length} file${deleted.length > 1 ? 's' : ''}`);
  if (renamed.length) parts.push(`rename ${renamed.length} file${renamed.length > 1 ? 's' : ''}`);
  if (modified.length) parts.push(`update ${modified.length} file${modified.length > 1 ? 's' : ''}`);

  return parts.length ? parts.join(', ') : `update ${files.length} files`;
}

function generateHeuristicMessage(files, diffContent) {
  const type = detectType(files, diffContent);
  const scope = detectScope(files);
  const description = generateDescription(files);
  const scopePart = scope ? `(${scope})` : '';
  return `${type}${scopePart}: ${description}`;
}

// ============================================================
// File grouping
// ============================================================

function groupFiles(files) {
  const groups = {};
  for (const file of files) {
    const parts = file.path.replace(/\\/g, '/').split('/');
    const meaningful = parts.filter(p => p !== 'src' && p !== '.');
    const group = meaningful.length > 1 ? meaningful[0] : 'root';
    if (!groups[group]) groups[group] = [];
    groups[group].push(file);
  }
  return Object.entries(groups).map(([name, groupFiles]) => ({ name, files: groupFiles }));
}

// ============================================================
// Public API
// ============================================================

/**
 * Generate a conventional commit message.
 * Tries GitHub Models API first (free), falls back to heuristic.
 * @param {Array} files - Changed files with path and status
 * @param {string} diffContent - Combined diff content
 * @param {string|null} githubToken - GitHub token for AI generation
 */
async function generateCommitMessage(files, diffContent, githubToken) {
  if (!files || files.length === 0) {
    return { message: '', source: 'heuristic', groups: [] };
  }

  const groups = groupFiles(files);

  // Try GitHub Models API if token available
  if (githubToken) {
    const aiMessage = await generateWithGitHubModels(githubToken, files, diffContent);
    if (aiMessage) {
      return { message: aiMessage, source: 'ai', groups };
    }
  }

  // Fallback to heuristic
  const message = generateHeuristicMessage(files, diffContent);
  return { message, source: 'heuristic', groups };
}

module.exports = { generateCommitMessage };
