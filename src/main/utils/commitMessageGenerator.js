/**
 * Commit Message Generator
 * Uses Claude Haiku through the Agent SDK (same auth path as the tab-naming
 * session) for AI commit messages, with a heuristic fallback when unavailable.
 */

const { formatDuration } = require('./formatDuration');

/**
 * Ask Haiku for a completion. Lazily requires ChatService so this module stays
 * loadable in tests and in any context without the SDK.
 * @returns {Promise<string|null>}
 */
async function callHaiku({ system, user, timeoutMs }) {
  try {
    const ChatService = require('../services/ChatService');
    return await ChatService.runHaikuPrompt({ systemPrompt: system, prompt: user, timeoutMs });
  } catch (err) {
    console.warn('[commitMessageGenerator] Haiku unavailable:', err.message);
    return null;
  }
}

// ============================================================
// AI generation (Claude Haiku)
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
 * Generate a commit message via Claude Haiku.
 * @param {Array} files - Changed files
 * @param {string} diffContent - Diff content
 * @param {number} [timeoutMs=45000] - Generous: the SDK spawns a CLI process (~10-15s)
 * @returns {Promise<string|null>}
 */
async function generateWithAi(files, diffContent, timeoutMs = 45000) {
  const content = await callHaiku({
    system: SYSTEM_PROMPT,
    user: buildPrompt(files, diffContent),
    timeoutMs
  });
  if (!content) return null;

  let message = content
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^```\w*\n?|\n?```$/g, '')
    .trim();
  message = message.split('\n')[0].trim();
  return message || null;
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
// Session Recap (AI summary of a Claude session)
// ============================================================

function buildSessionRecapSystemPrompt(isRich) {
  if (isRich) {
    return `Summarize this Claude Code session in 2-3 bullet points starting with "•".
Focus on what was ACCOMPLISHED. Imperative mood. No quotes. No trailing punctuation.
Output ONLY the bullet points, nothing else.`;
  }
  return `Summarize this Claude Code session in ONE short sentence (max 15 words).
Focus on what was ACCOMPLISHED. Imperative mood. No quotes. No trailing punctuation.
Output ONLY the sentence, nothing else.`;
}

function generateSessionRecapHeuristic(ctx) {
  const entries = Object.entries(ctx.toolCounts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, count]) => `${name} ×${count}`)
    .join(', ');
  return entries || `${ctx.toolCount || 0} tool uses`;
}

/**
 * Generate a session recap summary via Claude Haiku, with heuristic fallback.
 * @param {{ toolCounts: Object, prompts: string[], durationMs: number, toolCount: number }} ctx
 * @param {{ useAi?: boolean }} [options] - Set useAi to true to enable AI generation
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<{ summary: string, source: 'ai'|'heuristic' }>}
 */
async function generateSessionRecap(ctx, options, timeoutMs = 30000) {
  if (!ctx) return { summary: '', source: 'heuristic' };

  const isRich = ctx.toolCount > 10 || (ctx.prompts && ctx.prompts.length > 2);
  const systemPrompt = buildSessionRecapSystemPrompt(isRich);

  const toolList = Object.entries(ctx.toolCounts || {})
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ×${count}`)
    .join(', ') || 'none';

  const promptList = (ctx.prompts || []).join(' | ') || 'unknown';
  const durationStr = formatDuration(ctx.durationMs || 0);

  const userMessage = `User requests: ${promptList}\nTools used: ${toolList}\nDuration: ${durationStr}`;

  if (options?.useAi) {
    const result = await callHaiku({
      system: systemPrompt,
      user: userMessage,
      timeoutMs
    });
    if (result) return { summary: result, source: 'ai' };
  }

  return { summary: generateSessionRecapHeuristic(ctx), source: 'heuristic' };
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
 * Tries Claude Haiku first, falls back to heuristic.
 * @param {Array} files - Changed files with path and status
 * @param {string} diffContent - Combined diff content
 * @param {{ useAi?: boolean }} [options] - Set useAi to true to enable AI generation
 */
async function generateCommitMessage(files, diffContent, options) {
  if (!files || files.length === 0) {
    return { message: '', source: 'heuristic', groups: [] };
  }

  const groups = groupFiles(files);

  if (options?.useAi) {
    const aiMessage = await generateWithAi(files, diffContent);
    if (aiMessage) {
      return { message: aiMessage, source: 'ai', groups };
    }
  }

  // Fallback to heuristic
  const message = generateHeuristicMessage(files, diffContent);
  return { message, source: 'heuristic', groups };
}

/**
 * Generate separate commit messages for each file group.
 * Returns an array of { group, files, message, source }.
 * @param {Array} files - All changed files
 * @param {Object} diffs - Map of group name to diff content
 * @param {{ useAi?: boolean }} [options] - Set useAi to true to enable AI generation
 */
async function generateMultiCommitMessages(files, diffs, options) {
  if (!files || files.length === 0) return [];

  const groups = groupFiles(files);
  if (groups.length <= 1) {
    // Single group — use regular generation
    const diff = Object.values(diffs).join('\n\n');
    const result = await generateCommitMessage(files, diff, options);
    return [{ group: groups[0]?.name || 'root', files, message: result.message, source: result.source }];
  }

  // Generate a message per group
  const results = await Promise.all(groups.map(async (g) => {
    const diff = diffs[g.name] || '';
    if (options?.useAi) {
      const aiMessage = await generateWithAi(g.files, diff);
      if (aiMessage) return { group: g.name, files: g.files, message: aiMessage, source: 'ai' };
    }
    const message = generateHeuristicMessage(g.files, diff);
    return { group: g.name, files: g.files, message, source: 'heuristic' };
  }));

  return results;
}

module.exports = { generateCommitMessage, generateMultiCommitMessages, generateSessionRecap, generateSessionRecapHeuristic, groupFiles };
