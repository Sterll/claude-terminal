/**
 * PR Description Generator
 * Uses Claude Haiku through the Agent SDK (same auth path as the tab-naming
 * session) for AI-generated Pull Request titles and bodies, with a heuristic
 * fallback.
 */

// ============================================================
// AI generation (Claude Haiku)
// ============================================================

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
    console.warn('[prDescriptionGenerator] Haiku unavailable:', err.message);
    return null;
  }
}

const SYSTEM_PROMPT = `You are a senior engineer writing GitHub Pull Request descriptions.

Generate a PR title and body from the given context.

Rules:
- Title: concise, under 72 chars, conventional-commit style (feat/fix/refactor/…), lowercase after type, imperative mood, no trailing period.
- Body must use exactly these three markdown sections in order:
  ## Summary
  ## Changes
  ## Testing
- ## Summary: 1-3 short sentences explaining WHAT and WHY.
- ## Changes: bullet list of the most significant changes (grouped by area when helpful).
- ## Testing: bullet list of how the change was or should be tested.
- Do not include any other section, front-matter, or commentary.
- Output JSON only, with this exact shape:
  {"title": "<title>", "body": "<markdown body>"}
- Do not wrap the JSON in code fences.`;

function buildPrompt({ branch, baseBranch, commits, diffContent, sessionSummary }) {
  const maxDiff = 12000;
  const diff = diffContent && diffContent.length > maxDiff
    ? diffContent.slice(0, maxDiff) + '\n[... truncated ...]'
    : (diffContent || '(no diff available)');

  const commitLog = (commits && commits.length > 0)
    ? commits.map(c => `- ${c}`).join('\n')
    : '(no commits yet)';

  const session = sessionSummary && sessionSummary.trim()
    ? sessionSummary.trim()
    : '(no session recap available)';

  return `Branch: ${branch || '(unknown)'}
Base branch: ${baseBranch || 'main'}

Commits on this branch:
${commitLog}

Recent Claude Code session recap:
${session}

Diff (branch vs base):
${diff}`;
}

async function generateWithAi(context, timeoutMs = 60000) {
  const content = await callHaiku({
    system: SYSTEM_PROMPT,
    user: buildPrompt(context),
    timeoutMs
  });
  if (!content) return null;

  const cleaned = content
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed.title === 'string' && typeof parsed.body === 'string') {
      return {
        title: parsed.title.trim().split('\n')[0].slice(0, 120),
        body: parsed.body.trim()
      };
    }
  } catch (_) {
    // Fallback: try to split plain text — first line is title, rest is body
    const lines = cleaned.split('\n');
    const title = lines[0].replace(/^#+\s*/, '').trim();
    const body = lines.slice(1).join('\n').trim();
    if (title && body) return { title: title.slice(0, 120), body };
  }
  return null;
}

// ============================================================
// Heuristic fallback
// ============================================================

function heuristicTitle(branch, commits) {
  if (commits && commits.length === 1) {
    return commits[0].split('\n')[0].slice(0, 72);
  }
  if (commits && commits.length > 1) {
    // Try to find a common conventional-commit type
    const types = commits
      .map(c => c.match(/^(feat|fix|refactor|style|test|docs|chore|perf|ci|build)(\([^)]+\))?:/i))
      .filter(Boolean)
      .map(m => m[1].toLowerCase());
    const freq = {};
    types.forEach(t => { freq[t] = (freq[t] || 0) + 1; });
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
    const type = top ? top[0] : 'feat';
    const cleanBranch = (branch || 'changes')
      .replace(/^(feature|feat|fix|bugfix|hotfix|chore|refactor)\//i, '')
      .replace(/[-_]/g, ' ')
      .toLowerCase();
    return `${type}: ${cleanBranch}`.slice(0, 72);
  }
  const cleanBranch = (branch || 'changes').replace(/[-_]/g, ' ').toLowerCase();
  return `feat: ${cleanBranch}`.slice(0, 72);
}

function heuristicBody({ commits, sessionSummary, branch, baseBranch }) {
  const commitList = (commits && commits.length > 0)
    ? commits.map(c => `- ${c.split('\n')[0]}`).join('\n')
    : `- Changes on \`${branch || 'branch'}\``;

  const summary = sessionSummary && sessionSummary.trim()
    ? sessionSummary.trim()
    : `Merges changes from \`${branch || 'branch'}\` into \`${baseBranch || 'main'}\`.`;

  return `## Summary
${summary}

## Changes
${commitList}

## Testing
- Manual verification of the affected flows
- Run \`npm test\` and ensure all checks pass`;
}

function generateHeuristic(context) {
  return {
    title: heuristicTitle(context.branch, context.commits),
    body: heuristicBody(context)
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Generate a PR title + body.
 * Tries Claude Haiku first, falls back to heuristic.
 *
 * @param {Object} context
 * @param {string} context.branch           - Source branch name
 * @param {string} context.baseBranch       - Base branch (e.g. 'main')
 * @param {string[]} context.commits        - Commit messages on the branch (subject lines)
 * @param {string} context.diffContent      - Full branch diff vs base
 * @param {string} context.sessionSummary   - Recap of the Claude session (free-form markdown or text)
 * @param {{ useAi?: boolean }} [options]   - Set useAi to true to enable AI generation
 * @returns {Promise<{ title: string, body: string, source: 'ai'|'heuristic' }>}
 */
async function generatePrDescription(context, options) {
  const ctx = {
    branch: context.branch || '',
    baseBranch: context.baseBranch || 'main',
    commits: Array.isArray(context.commits) ? context.commits : [],
    diffContent: context.diffContent || '',
    sessionSummary: context.sessionSummary || ''
  };

  if (options?.useAi) {
    const result = await generateWithAi(ctx);
    if (result) return { ...result, source: 'ai' };
  }

  const fallback = generateHeuristic(ctx);
  return { ...fallback, source: 'heuristic' };
}

module.exports = { generatePrDescription };
