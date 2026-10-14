/**
 * @tickets mention source
 * -----------------------------------------------------------------------------
 * The connected tracker's open tickets, to cite in a chat message. Picking one
 * adds a chip; when the message is sent, `resolve` turns the chip into the
 * ticket's content (title, status, people, description) for Claude, and links
 * the ticket to the session, since citing it is the user saying "this
 * session is about that".
 * -----------------------------------------------------------------------------
 */

'use strict';

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1.5a2.5 2.5 0 0 0 0 5V16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1.5a2.5 2.5 0 0 0 0-5z"/></svg>';

const { PRIORITY_NAMES, ticketBlock } = require('../../../shared/issue-trackers');

const CACHE_MS = 30_000;
const DESCRIPTION_CHARS = 6000;
const COMMENTS = 5;

let cache = { at: 0, items: [] };

function t(key, params) {
  try { return require('../../i18n').t(key, params); } catch { return key; }
}

const bridge = () => (typeof window !== 'undefined' ? window.electron_api?.issueTrackers : null);

/**
 * The issue as Claude reads it: enough to work from without opening the
 * tracker. Fenced as tracker data (`ticketBlock`): anyone who can edit the
 * ticket wrote it, so none of it is an instruction from the user.
 */
function issueAsText(issue) {
  return ticketBlock(issue.key, issueBody(issue));
}

function issueBody(issue) {
  const lines = [`# ${issue.key}: ${issue.title}`];
  const facts = [`Status: ${issue.state.name}`];
  if (issue.priority != null) facts.push(`Priority: ${PRIORITY_NAMES[issue.priority] ?? issue.priority}`);
  if (issue.assignee) facts.push(`Assignee: ${issue.assignee.name}`);
  // A tracker whose container is also a facet (a GitHub repository) names it there.
  if (issue.container && !Object.values(issue.facets || {}).includes(issue.container.name)) facts.push(`Team: ${issue.container.name}`);
  // Facets are keyed by id (`project`, `cycle`); capitalised to match the other labels.
  for (const [id, value] of Object.entries(issue.facets || {})) facts.push(`${id.charAt(0).toUpperCase()}${id.slice(1)}: ${value}`);
  if (issue.labels?.length) facts.push(`Labels: ${issue.labels.map((l) => l.name).join(', ')}`);
  lines.push(facts.join(' | '));
  if (issue.url) lines.push(issue.url);
  if (issue.branchName) lines.push(`Suggested branch: ${issue.branchName}`);
  if (issue.parent) lines.push(`Sub-issue of ${issue.parent.key}: ${issue.parent.title}`);
  if (issue.description) {
    const text = issue.description.length > DESCRIPTION_CHARS
      ? `${issue.description.slice(0, DESCRIPTION_CHARS)}\n[description truncated]`
      : issue.description;
    lines.push('', text);
  }
  const comments = (issue.comments || []).slice(-COMMENTS);
  if (comments.length) {
    lines.push('', '## Latest comments');
    for (const c of comments) lines.push(`- ${c.author?.name || 'someone'}: ${c.body.replace(/\s+/g, ' ').slice(0, 500)}`);
  }
  if (issue.children?.length) {
    lines.push('', issue.subIssues ? `## Sub-issues (${issue.subIssues.done}/${issue.subIssues.total} done)` : '## Sub-issues');
    for (const child of issue.children) lines.push(`- ${child.key} [${child.state.name}] ${child.title}`);
  }
  return lines.join('\n');
}

module.exports = {
  // Same as the keyword: the @ dropdown filters on the id as the user types.
  id: 'tickets',
  keyword: '@tickets',
  prefix: null,
  surfaces: ['mention'],
  scope: 'global',
  label: () => t('chat.mentionTickets'),
  icon: ICON,

  async getData() {
    const api = bridge();
    if (!api) return [];
    if (Date.now() - cache.at < CACHE_MS) return cache.items;
    const conns = await api.connections();
    const conn = conns?.ok ? conns.connections.find((c) => c.available) : null;
    if (!conn) return [];
    const res = await api.listIssues(conn.id, { stateCategories: ['backlog', 'todo', 'started'], limit: 100, sort: 'updated' }, null);
    const items = res?.ok
      ? res.issues.map((issue) => ({ id: issue.ref, issue, connectionId: conn.id, providerName: conn.providerName }))
      : [];
    cache = { at: Date.now(), items };
    return items;
  },

  render(item) {
    return {
      icon: ICON,
      color: item.issue.state.color,
      label: `${item.issue.key}  ${item.issue.title}`,
      sublabel: `${item.issue.state.name}${item.issue.assignee ? ` · ${item.issue.assignee.name}` : ''}`,
    };
  },

  getChipData(item) {
    return {
      type: 'tickets',
      label: `@${item.issue.key}`,
      data: { ref: item.issue.ref, key: item.issue.key, title: item.issue.title, connectionId: item.connectionId, chipLabel: `@${item.issue.key}` },
    };
  },

  onSelect(item, consumer, api = {}) {
    if (consumer !== 'mention') return;
    const chip = this.getChipData(item);
    api.addMentionChip?.(chip.type, chip.data);
    api.closeDropdown?.();
  },

  /**
   * The chip's content at send time, fetched fresh so Claude reads the status
   * as it is now. Also links the ticket to the session.
   */
  async resolve(data, ctx = {}) {
    ctx.linkTicket?.({ ref: data.ref, connectionId: data.connectionId, title: data.title }, 'mention');
    const api = bridge();
    const res = api ? await api.getIssue(data.connectionId, data.key) : null;
    if (!res?.ok) return ticketBlock(data.key, `# ${data.key}: ${data.title}\n[Could not load the ticket: ${res?.error || 'tracker unavailable'}]`);
    return issueAsText(res.issue);
  },

  /** Tests only. */
  _reset() { cache = { at: 0, items: [] }; },
  issueAsText,
};
