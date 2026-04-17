/**
 * PR Description Generator
 * Uses GitHub Models API (free with GitHub account) for AI-generated
 * Pull Request titles and bodies, with a heuristic fallback.
 */

const https = require('https');

// ============================================================
// GitHub Models API
// ============================================================

function callGitHubModels(token, messages, maxTokens, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: maxTokens,
      messages
    });

    const options = {
      hostname: 'models.inference.ai.azure.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeoutMs
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content?.trim();
          resolve(content || null);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
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

async function generateWithGitHubModels(githubToken, context, timeoutMs = 15000) {
  const userMessage = buildPrompt(context);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage }
  ];

  const content = await callGitHubModels(githubToken, messages, 900, timeoutMs);
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
 * Tries GitHub Models API first, falls back to heuristic.
 *
 * @param {Object} context
 * @param {string} context.branch           - Source branch name
 * @param {string} context.baseBranch       - Base branch (e.g. 'main')
 * @param {string[]} context.commits        - Commit messages on the branch (subject lines)
 * @param {string} context.diffContent      - Full branch diff vs base
 * @param {string} context.sessionSummary   - Recap of the Claude session (free-form markdown or text)
 * @param {string|null} githubToken         - GitHub OAuth token (optional)
 * @returns {Promise<{ title: string, body: string, source: 'ai'|'heuristic' }>}
 */
async function generatePrDescription(context, githubToken) {
  const ctx = {
    branch: context.branch || '',
    baseBranch: context.baseBranch || 'main',
    commits: Array.isArray(context.commits) ? context.commits : [],
    diffContent: context.diffContent || '',
    sessionSummary: context.sessionSummary || ''
  };

  if (githubToken) {
    const result = await generateWithGitHubModels(githubToken, ctx);
    if (result) return { ...result, source: 'ai' };
  }

  const fallback = generateHeuristic(ctx);
  return { ...fallback, source: 'heuristic' };
}

module.exports = { generatePrDescription };
