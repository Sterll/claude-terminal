/**
 * Commit Message Generator
 * Uses Claude CLI (`claude -p`) for intelligent commit message generation,
 * with a heuristic fallback when Claude is unavailable.
 */

const { spawn } = require('child_process');

// ============================================================
// Claude CLI generation
// ============================================================

const CLAUDE_PROMPT = `You are a commit message generator. Analyze the git diff below and generate a single conventional commit message.

Rules:
- Format: type(scope): concise description
- Types: feat, fix, refactor, style, test, docs, chore, perf, ci, build
- Scope is optional, inferred from the file paths (e.g. ui, ipc, main, utils, services)
- Description must be lowercase, imperative mood, no period at the end
- Max 72 characters total
- Output ONLY the commit message, nothing else — no explanation, no quotes, no markdown

Git diff:
`;

/**
 * Generate commit message using Claude CLI
 * @param {string} diffContent - The git diff to analyze
 * @param {number} timeoutMs - Timeout in ms (default 30s)
 * @returns {Promise<string|null>} - The commit message or null on failure
 */
function generateWithClaude(diffContent, timeoutMs = 30000) {
  return new Promise((resolve) => {
    // Truncate very large diffs to avoid overwhelming the model
    const maxDiffLength = 15000;
    const truncatedDiff = diffContent.length > maxDiffLength
      ? diffContent.slice(0, maxDiffLength) + '\n\n[... diff truncated ...]'
      : diffContent;

    const fullPrompt = CLAUDE_PROMPT + truncatedDiff;

    let proc;
    try {
      proc = spawn('claude', ['-p', fullPrompt], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        timeout: timeoutMs,
        windowsHide: true,
      });
    } catch (spawnError) {
      console.error('[CommitGen] Failed to spawn claude:', spawnError.message);
      return resolve(null);
    }

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      resolve(null);
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        // Clean up: remove quotes, backticks, extra whitespace
        let message = stdout.trim()
          .replace(/^["'`]+|["'`]+$/g, '')
          .replace(/^```\w*\n?|\n?```$/g, '')
          .trim();
        // Ensure single line
        message = message.split('\n')[0].trim();
        resolve(message || null);
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
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
// File grouping (for split suggestions)
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
 * Tries Claude CLI first, falls back to heuristic on failure.
 * @param {Array<{path: string, status: string}>} files
 * @param {string} diffContent
 * @returns {Promise<{message: string, source: 'claude'|'heuristic', groups: Array}>}
 */
async function generateCommitMessage(files, diffContent) {
  if (!files || files.length === 0) {
    return { message: '', source: 'heuristic', groups: [] };
  }

  const groups = groupFiles(files);

  // Try Claude CLI first
  if (diffContent) {
    const claudeMessage = await generateWithClaude(diffContent);
    if (claudeMessage) {
      return { message: claudeMessage, source: 'claude', groups };
    }
  }

  // Fallback to heuristic
  const message = generateHeuristicMessage(files, diffContent);
  return { message, source: 'heuristic', groups };
}

module.exports = { generateCommitMessage };
