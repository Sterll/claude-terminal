/**
 * The session list: grouping, labelling and the card markup.
 *
 * Sessions are bucketed by recency rather than by date, because "yesterday"
 * is the question actually being asked of this list. Everything here is a
 * pure read of a session record.
 *
 * The card is built as an HTML string and its icons come from one sprite
 * sheet injected once (SESSION_SVG_DEFS) rather than inline per card: the
 * list re-renders wholesale on every filter keystroke, and ten inline SVGs
 * per row is what that costs.
 */

const { escapeHtml } = require('../../../utils');
const { t, getCurrentLanguage } = require('../../../i18n');

// BCP 47 tags used for date formatting, one per supported UI language.
const DATE_LOCALES = { en: 'en-US', fr: 'fr-FR', es: 'es-ES' };

const SESSION_SVG_DEFS = `<svg style="display:none" xmlns="http://www.w3.org/2000/svg">
  <symbol id="s-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></symbol>
  <symbol id="s-bolt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></symbol>
  <symbol id="s-msg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></symbol>
  <symbol id="s-clock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></symbol>
  <symbol id="s-branch" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></symbol>
  <symbol id="s-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></symbol>
  <symbol id="s-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="s-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></symbol>
  <symbol id="s-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7"/><path d="M5 17h14"/><path d="M7 11l-2 6h14l-2-6"/></symbol>
  <symbol id="s-rename" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></symbol>
  <symbol id="s-move" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h5a2 2 0 0 0 2-2V6a2 2 0 0 1 2-2h7"/><polyline points="17 1 21 5 17 9"/></symbol>
</svg>`;

function formatRelativeTime(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t('time.justNow');
  if (diffMins < 60) return t('time.minutesAgo', { count: diffMins });
  if (diffHours < 24) return t('time.hoursAgo', { count: diffHours });
  if (diffDays < 7) return t('time.daysAgo', { count: diffDays });
  const locale = DATE_LOCALES[getCurrentLanguage()] || DATE_LOCALES.en;
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

function truncateText(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

function cleanSessionText(text) {
  if (!text) return { text: '', skillName: '' };

  let skillName = '';

  const cmdNameMatch = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
  if (cmdNameMatch) {
    skillName = cmdNameMatch[1].trim().replace(/^\//, '');
  }

  const argsMatch = text.match(/<command-args>([^<]+)<\/command-args>/);
  const argsText = argsMatch ? argsMatch[1].trim() : '';

  let cleaned = text.replace(/<[^>]+>[^<]*<\/[^>]+>/g, '');
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  cleaned = cleaned.replace(/\[Request interrupted[^\]]*\]/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (!cleaned && argsText) {
    cleaned = argsText;
  }

  return { text: cleaned, skillName };
}

function getSessionGroup(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  if (date >= today) return 'today';
  if (date >= yesterday) return 'yesterday';
  if (date >= weekAgo) return 'thisWeek';
  return 'older';
}

function groupSessionsByTime(sessions) {
  const groups = {
    pinned: { key: 'pinned', label: t('sessions.pinned'), sessions: [] },
    today: { key: 'today', label: t('sessions.today'), sessions: [] },
    yesterday: { key: 'yesterday', label: t('sessions.yesterday'), sessions: [] },
    thisWeek: { key: 'thisWeek', label: t('sessions.thisWeek'), sessions: [] },
    older: { key: 'older', label: t('sessions.older'), sessions: [] }
  };

  sessions.forEach(session => {
    if (session.pinned) {
      groups.pinned.sessions.push(session);
    } else {
      const group = getSessionGroup(session.modified);
      groups[group].sessions.push(session);
    }
  });

  return Object.values(groups).filter(g => g.sessions.length > 0);
}

function buildSessionCardHtml(s, index) {
  const MAX_ANIMATED = 10;
  const animClass = index < MAX_ANIMATED ? ' session-card--anim' : ' session-card--instant';
  const freshClass = s.freshness ? ` session-card--${s.freshness}` : '';
  const pinnedClass = s.pinned ? ' session-card--pinned' : '';
  const renamedClass = s.isRenamed ? ' session-card--renamed' : '';
  const skillClass = s.isSkill ? ' session-card-icon--skill' : '';
  const titleSkillClass = s.isSkill ? ' session-card-title--skill' : '';
  const iconId = s.isSkill ? 's-bolt' : 's-chat';
  const pinTitle = s.pinned ? (t('sessions.unpin') || 'Unpin') : (t('sessions.pin') || 'Pin');
  const renameTitle = t('sessions.rename') || 'Rename';
  const moveTitle = t('sessions.move.title');
  // A session the CLI re-filed under a worktree: say where it ran, because it
  // will resume there and not in the project root.
  const worktreeTitle = s.worktreeMissing
    ? t('sessions.worktreeGone', { name: s.worktree })
    : t('sessions.worktreeRan', { name: s.worktree });
  const worktreeHtml = s.worktree
    ? `<span class="session-meta-worktree${s.worktreeMissing ? ' session-meta-worktree--gone' : ''}" title="${escapeHtml(worktreeTitle)}"><svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="3" cy="3" r="1.5"/><circle cx="8" cy="3" r="1.5"/><circle cx="3" cy="8" r="1.5"/><path d="M3 4.5v3M4.5 3h3M8 4.5v1a2 2 0 01-2 2H4.5"/></svg>${escapeHtml(s.worktree)}</span>`
    : '';

  return `<div class="session-card${freshClass}${pinnedClass}${renamedClass}${animClass}" data-sid="${s.sessionId}" style="--ci:${index < MAX_ANIMATED ? index : 0}">
<div class="session-card-icon${skillClass}"><svg width="16" height="16"><use href="#${iconId}"/></svg></div>
<div class="session-card-body">
<span class="session-card-title${titleSkillClass}">${escapeHtml(truncateText(s.displayTitle, 80))}</span>
${s.displaySubtitle ? `<span class="session-card-subtitle">${escapeHtml(truncateText(s.displaySubtitle, 120))}</span>` : ''}
</div>
<div class="session-card-meta">
<span class="session-meta-item"><svg width="11" height="11"><use href="#s-msg"/></svg>${s.messageCount}</span>
<span class="session-meta-item"><svg width="11" height="11"><use href="#s-clock"/></svg>${formatRelativeTime(s.modified)}</span>
${s.gitBranch ? `<span class="session-meta-branch"><svg width="10" height="10"><use href="#s-branch"/></svg>${escapeHtml(s.gitBranch)}</span>` : ''}
${worktreeHtml}
</div>
<div class="session-card-actions">
<button class="session-card-rename" data-rename-sid="${s.sessionId}" title="${escapeHtml(renameTitle)}" aria-label="${escapeHtml(renameTitle)}"><svg width="12" height="12"><use href="#s-rename"/></svg></button>
<button class="session-card-move" data-move-sid="${s.sessionId}" title="${escapeHtml(moveTitle)}" aria-label="${escapeHtml(moveTitle)}"><svg width="13" height="13"><use href="#s-move"/></svg></button>
<button class="session-card-pin" data-pin-sid="${s.sessionId}" title="${escapeHtml(pinTitle)}" aria-label="${escapeHtml(pinTitle)}"><svg width="13" height="13"><use href="#s-pin"/></svg></button>
</div>
<div class="session-card-arrow"><svg width="12" height="12"><use href="#s-arrow"/></svg></div>
</div>`;
}

module.exports = {
  formatRelativeTime,
  truncateText,
  cleanSessionText,
  getSessionGroup,
  groupSessionsByTime,
  buildSessionCardHtml,
  SESSION_SVG_DEFS,
};
