/**
 * A branch named after a ticket (`eng-123-fix-login`, `feature/ABC-42`) while
 * no ticket tracker is connected: Settings, Tickets connects one.
 *
 * Signal: `project:opened`. The branch is read through the same git IPC every
 * other screen uses, so it works for a remote (SSH) project whose host is
 * connected and yields nothing otherwise. Connecting a tracker, or having
 * opened the Tickets screen at all, counts as knowing the feature.
 */

/**
 * Words that look like a ticket prefix in a branch name and are not one:
 * `release-2`, `hotfix-3`, `v-1`, `utf-8`...
 */
const NOT_A_PREFIX = new Set([
  'release', 'releases', 'hotfix', 'bugfix', 'fix', 'feat', 'feature', 'features', 'chore', 'docs',
  'refactor', 'test', 'tests', 'wip', 'version', 'ver', 'rc', 'beta', 'alpha', 'utf', 'iso', 'sha',
  'pr', 'mr', 'issue', 'issues', 'patch', 'build', 'backup', 'copy', 'main', 'master', 'dev', 'develop',
  'stage', 'staging', 'prod', 'step', 'part', 'phase', 'sprint', 'week', 'day', 'node', 'python', 'php',
]);

const TICKET_KEY = /(?:^|[/_.\-\s])([a-z][a-z0-9]{1,9})-(\d{1,6})(?=$|[/_.\-\s])/gi;

/**
 * The first ticket-shaped key in a branch name, upper-cased, or null.
 * @param {string} branch
 * @returns {string|null}
 */
function extractTicketKey(branch) {
  const name = String(branch || '');
  if (!name || name === 'HEAD') return null;
  for (const match of name.matchAll(TICKET_KEY)) {
    const prefix = match[1];
    if (/^v\d*$/i.test(prefix)) continue;
    if (NOT_A_PREFIX.has(prefix.toLowerCase())) continue;
    return `${prefix.toUpperCase()}-${match[2]}`;
  }
  return null;
}

module.exports = {
  id: 'ticketTracker',
  triggers: ['project:opened'],
  usedWhen: ['tab:tickets'],
  titleKey: 'discovery.rules.ticketTracker.title',
  bodyKey: 'discovery.rules.ticketTracker.body',
  action: { type: 'setting', tab: 'tickets' },

  async condition(payload, ctx) {
    const project = payload && payload.project;
    if (!project || !project.path) return false;
    let branch;
    try {
      branch = await ctx.api.git.currentBranch({ projectPath: project.path });
    } catch {
      return false;
    }
    const key = extractTicketKey(branch);
    if (!key) return false;
    return { params: { key, branch } };
  },

  async isUsed(ctx) {
    try {
      const res = await ctx.api.issueTrackers.connections();
      return !!(res && res.ok && Array.isArray(res.connections) && res.connections.length > 0);
    } catch {
      return false;
    }
  },

  extractTicketKey,
};
