/**
 * Discord Bot Dashboard hooks
 * Badge and stats for the dashboard
 */

const { getDiscordServer } = require('./DiscordState');

function getDashboardBadge(project) {
  return {
    text: 'Discord Bot',
    cssClass: 'discord'
  };
}

function getDashboardStats(ctx) {
  const { projectIndex, t } = ctx;
  if (projectIndex === undefined || projectIndex === null) return '';

  const server = getDiscordServer(projectIndex);
  const status = server.status;

  if (status === 'stopped') return '';

  const parts = [];
  if (server.botName) parts.push(server.botName);
  if (server.guildCount !== null) parts.push(`${server.guildCount} ${t('discord.guilds')}`);

  const statusLabel = status === 'online'
    ? (parts.length ? parts.join(' · ') : t('discord.online'))
    : t('discord.starting');

  return `
    <div class="dashboard-quick-stat discord-stat">
      <span class="discord-status-dot ${status}"></span>
      <span>${t('discord.bot')}: ${statusLabel}</span>
    </div>
  `;
}

module.exports = { getDashboardBadge, getDashboardStats };
