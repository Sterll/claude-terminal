/**
 * @session mention source — reference a Claude Code session from the project.
 * Distinct from @conversation in that it is replay-oriented (link to Session Replay).
 */

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
  + '<circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>';

// Per-project cache to avoid spamming IPC on every keystroke.
const CACHE_TTL = 30_000;
const _cache = new Map(); // projectPath -> { ts, sessions }

async function loadSessions(projectPath) {
  if (!projectPath) return [];
  const hit = _cache.get(projectPath);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.sessions;
  try {
    const sessions = await window.electron_api.claude.sessions(projectPath);
    const arr = Array.isArray(sessions) ? sessions : [];
    arr.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    _cache.set(projectPath, { ts: Date.now(), sessions: arr });
    return arr;
  } catch {
    return [];
  }
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

module.exports = {
  id: 'session',
  keyword: '@session',
  prefix: '#',
  surfaces: ['mention', 'palette'],
  scope: 'project',
  label: () => {
    try { return require('../../i18n').t('chat.mentionSession') || 'Sessions'; }
    catch { return 'Sessions'; }
  },
  icon: ICON,

  async getData(ctx = {}) {
    const sessions = await loadSessions(ctx.project?.path);
    return sessions.slice(0, 60).map(s => ({
      id: s.sessionId,
      firstPrompt: s.firstPrompt || s.summary || s.sessionId?.slice(0, 8) || '?',
      summary: s.summary || '',
      modified: s.modified,
      messageCount: s.messageCount || 0,
      projectPath: ctx.project?.path,
    }));
  },

  render(item) {
    const label = item.firstPrompt.length > 80 ? item.firstPrompt.slice(0, 80) + '…' : item.firstPrompt;
    const time = formatRelativeTime(item.modified);
    const count = item.messageCount ? ` · ${item.messageCount} msgs` : '';
    return {
      icon: ICON,
      label,
      sublabel: `${time}${count}`,
    };
  },

  getChipData(item) {
    return {
      type: 'session',
      label: `@${item.firstPrompt.slice(0, 40)}`,
      data: { sessionId: item.id, firstPrompt: item.firstPrompt, projectPath: item.projectPath },
    };
  },

  onSelect(item, consumer, api = {}) {
    if (consumer === 'mention') {
      const chip = this.getChipData(item);
      api.addMentionChip?.(chip.type, chip.data);
      api.closeDropdown?.();
      return;
    }
    document.querySelector('[data-tab="session-replay"]')?.click();
    setTimeout(() => {
      const el = document.querySelector(`[data-session-id="${item.id}"]`);
      el?.click();
    }, 150);
  },
};
