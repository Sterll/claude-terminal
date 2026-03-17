/**
 * Discord Bot ProjectList hooks
 * Sidebar buttons, icons, status indicator
 */

const { getDiscordServer } = require('./DiscordState');

// Discord Clyde icon
const DISCORD_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>';

function getSidebarButtons(ctx) {
  const { project, projectIndex, t } = ctx;
  const server = getDiscordServer(projectIndex);
  const status = server.status;
  const isRunning = status === 'online' || status === 'starting';

  if (isRunning) {
    return `
      <button class="btn-action-icon btn-discord-console" data-project-index="${projectIndex}" data-project-id="${project.id}" title="${t('discord.console')}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
      </button>
      <button class="btn-action-primary btn-discord-stop" data-project-index="${projectIndex}" data-project-id="${project.id}" title="${t('discord.stopBot')}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>
      </button>`;
  }
  return `
    <button class="btn-action-primary btn-discord-start" data-project-index="${projectIndex}" data-project-id="${project.id}" title="${t('discord.startBot')}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
    </button>`;
}

function getProjectIcon() {
  return DISCORD_ICON;
}

function getStatusIndicator(ctx) {
  const { projectIndex } = ctx;
  const server = getDiscordServer(projectIndex);
  return `<span class="discord-status-dot ${server.status}" title="${server.status}"></span>`;
}

function getProjectItemClass() {
  return 'discord-project';
}

function getMenuItems(ctx) {
  const { projectIndex, t } = ctx;
  const server = getDiscordServer(projectIndex);

  if (server.status === 'online') {
    return `<div class="action-item btn-discord-scan-commands" data-project-index="${projectIndex}">
      <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>
      ${t('discord.scanCommands')}
    </div>`;
  }
  return '';
}

function getDashboardIcon() {
  return DISCORD_ICON;
}

function bindSidebarEvents(list, cbs) {
  list.querySelectorAll('.btn-discord-start').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (cbs.onStartDiscordBot) cbs.onStartDiscordBot(parseInt(btn.dataset.projectIndex));
    };
  });

  list.querySelectorAll('.btn-discord-stop').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (cbs.onStopDiscordBot) cbs.onStopDiscordBot(parseInt(btn.dataset.projectIndex));
    };
  });

  list.querySelectorAll('.btn-discord-console').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (cbs.onOpenDiscordConsole) cbs.onOpenDiscordConsole(parseInt(btn.dataset.projectIndex));
    };
  });

  list.querySelectorAll('.btn-discord-scan-commands').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (cbs.onScanDiscordCommands) cbs.onScanDiscordCommands(parseInt(btn.dataset.projectIndex));
    };
  });
}

module.exports = {
  getSidebarButtons,
  getProjectIcon,
  getStatusIndicator,
  getProjectItemClass,
  getMenuItems,
  getDashboardIcon,
  bindSidebarEvents
};
