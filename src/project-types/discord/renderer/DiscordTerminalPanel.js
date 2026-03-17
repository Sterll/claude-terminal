/**
 * Discord Bot Terminal Panel
 * Console + Commands + Events tabs
 */

const { getDiscordServer, getDiscordCommands, getDiscordEvents } = require('./DiscordState');
const { t } = require('../../../renderer/i18n');

const ICON_CONSOLE  = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><rect x="1" y="2" width="14" height="12" rx="2"/><path d="M4.5 6L7 8.5 4.5 11M8.5 11H12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_COMMANDS = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><path d="M5.5 3L10.5 8 5.5 13" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_EVENTS   = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><path d="M8 2v12M2 8h12" stroke-linecap="round"/><circle cx="8" cy="8" r="3"/></svg>`;
const ICON_EMBED    = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><rect x="1" y="2" width="14" height="12" rx="2"/><path d="M4 5h8M4 8h6M4 11h4" stroke-linecap="round"/></svg>`;
const ICON_COMP     = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><rect x="1" y="4" width="6" height="3" rx="1"/><rect x="9" y="4" width="6" height="3" rx="1"/><rect x="1" y="9" width="14" height="3" rx="1"/></svg>`;

function getViewSwitcherHtml() {
  return `
    <div class="dc-shell">
      <div class="wa-tabbar">
        <div class="wa-tabs">
          <button class="wa-tab active" data-view="console">${ICON_CONSOLE} ${t('discord.console')}</button>
          <button class="wa-tab" data-view="commands">${ICON_COMMANDS} ${t('discord.commands')} <span class="dc-tab-count" data-count="commands">0</span></button>
          <button class="wa-tab" data-view="events">${ICON_EVENTS} ${t('discord.events')} <span class="dc-tab-count" data-count="events">0</span></button>
          <button class="wa-tab" data-view="embed-builder">${ICON_EMBED} ${t('discord.embedBuilder')}</button>
          <button class="wa-tab" data-view="comp-builder">${ICON_COMP} ${t('discord.componentBuilder')}</button>
        </div>
        <div class="wa-tabbar-right">
          <div class="dc-bot-status" data-status="stopped">
            <span class="dc-status-pip"></span>
            <span class="dc-status-label">${t('discord.offline')}</span>
          </div>
        </div>
      </div>
      <div class="wa-body">
        <div class="wa-view wa-view-active" data-view="console">
          <div class="discord-console-view"></div>
        </div>
        <div class="wa-view" data-view="commands">
          <div class="dc-commands-view">
            <div class="dc-commands-toolbar">
              <input type="text" class="dc-commands-search" placeholder="${t('discord.searchCommands')}" />
              <button class="dc-commands-scan-btn">${t('discord.scanCommands')}</button>
            </div>
            <div class="dc-commands-list"></div>
          </div>
        </div>
        <div class="wa-view" data-view="events">
          <div class="dc-events-view">
            <div class="dc-events-toolbar">
              <button class="dc-events-clear-btn">${t('discord.clearEvents')}</button>
            </div>
            <div class="dc-events-list"></div>
          </div>
        </div>
        <div class="wa-view" data-view="embed-builder">
          <div class="dc-embed-builder-container"></div>
        </div>
        <div class="wa-view" data-view="comp-builder">
          <div class="dc-comp-builder-container"></div>
        </div>
      </div>
    </div>
  `;
}

function setupViewSwitcher(wrapper, terminalId, projectIndex, project, deps) {
  // Tab switching
  const tabs = wrapper.querySelectorAll('.wa-tab');
  const views = wrapper.querySelectorAll('.wa-view');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      views.forEach(v => v.classList.remove('wa-view-active'));
      tab.classList.add('active');
      const view = wrapper.querySelector(`.wa-view[data-view="${tab.dataset.view}"]`);
      if (view) view.classList.add('wa-view-active');

      // Auto-scan commands on first open
      if (tab.dataset.view === 'commands') {
        const cmds = getDiscordCommands(projectIndex);
        if (!cmds.lastScan) {
          scanCommandsUI(wrapper, projectIndex, project);
        }
      }

      // Initialize builders on first open
      if (tab.dataset.view === 'embed-builder') {
        const builderContainer = wrapper.querySelector('.dc-embed-builder-container');
        if (builderContainer && !builderContainer.dataset.initialized) {
          builderContainer.dataset.initialized = 'true';
          const EmbedBuilder = require('./builders/EmbedBuilder');
          EmbedBuilder.render(builderContainer, null, t);
        }
      }
      if (tab.dataset.view === 'comp-builder') {
        const builderContainer = wrapper.querySelector('.dc-comp-builder-container');
        if (builderContainer && !builderContainer.dataset.initialized) {
          builderContainer.dataset.initialized = 'true';
          const ComponentBuilder = require('./builders/ComponentBuilder');
          ComponentBuilder.render(builderContainer, null, t);
        }
      }
    });
  });

  // Scan commands button
  const scanBtn = wrapper.querySelector('.dc-commands-scan-btn');
  if (scanBtn) {
    scanBtn.addEventListener('click', () => {
      scanCommandsUI(wrapper, projectIndex, project);
    });
  }

  // Commands search
  const searchInput = wrapper.querySelector('.dc-commands-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      filterCommands(wrapper, searchInput.value);
    });
  }

  // Clear events
  const clearBtn = wrapper.querySelector('.dc-events-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const { clearDiscordEvents } = require('./DiscordState');
      clearDiscordEvents(projectIndex);
      renderEvents(wrapper, projectIndex);
    });
  }

  // Subscribe to state changes for counts
  const { discordState } = require('./DiscordState');
  discordState.subscribe(() => {
    updateCounts(wrapper, projectIndex);
    updateBotStatus(wrapper, projectIndex);
  });
}

async function scanCommandsUI(wrapper, projectIndex, project) {
  const { scanCommands } = require('./DiscordRendererService');
  const list = wrapper.querySelector('.dc-commands-list');
  if (list) list.innerHTML = `<div class="dc-commands-loading">${t('discord.scanning')}</div>`;

  const commands = await scanCommands(projectIndex, project.path);
  renderCommands(wrapper, commands);
}

function renderCommands(wrapper, commands) {
  const list = wrapper.querySelector('.dc-commands-list');
  if (!list) return;

  if (!commands.length) {
    list.innerHTML = `<div class="dc-commands-empty">${t('discord.noCommands')}</div>`;
    return;
  }

  list.innerHTML = commands.map(cmd => `
    <div class="dc-command-item" data-name="${cmd.name}">
      <div class="dc-command-name">/${cmd.name}</div>
      <div class="dc-command-desc">${cmd.description || ''}</div>
      <div class="dc-command-meta">
        <span class="dc-command-type">${cmd.type}</span>
        <span class="dc-command-file">${cmd.file}</span>
      </div>
    </div>
  `).join('');
}

function filterCommands(wrapper, query) {
  const items = wrapper.querySelectorAll('.dc-command-item');
  const q = query.toLowerCase();
  items.forEach(item => {
    const name = item.dataset.name || '';
    item.style.display = name.toLowerCase().includes(q) ? '' : 'none';
  });
}

function renderEvents(wrapper, projectIndex) {
  const list = wrapper.querySelector('.dc-events-list');
  if (!list) return;
  const events = getDiscordEvents(projectIndex);

  if (!events.length) {
    list.innerHTML = `<div class="dc-events-empty">${t('discord.noEvents')}</div>`;
    return;
  }

  list.innerHTML = events.map(ev => {
    const time = new Date(ev.timestamp).toLocaleTimeString();
    return `<div class="dc-event-item">
      <span class="dc-event-time">${time}</span>
      <span class="dc-event-type">${ev.type}</span>
      <span class="dc-event-data">${ev.data || ''}</span>
    </div>`;
  }).join('');

  list.scrollTop = list.scrollHeight;
}

function updateCounts(wrapper, projectIndex) {
  const cmds = getDiscordCommands(projectIndex);
  const events = getDiscordEvents(projectIndex);

  const cmdCount = wrapper.querySelector('.dc-tab-count[data-count="commands"]');
  const evtCount = wrapper.querySelector('.dc-tab-count[data-count="events"]');

  if (cmdCount) cmdCount.textContent = cmds.commands.length || '0';
  if (evtCount) evtCount.textContent = events.length || '0';
}

function updateBotStatus(wrapper, projectIndex) {
  const server = getDiscordServer(projectIndex);
  const statusEl = wrapper.querySelector('.dc-bot-status');
  if (statusEl) {
    statusEl.setAttribute('data-status', server.status);
    const label = statusEl.querySelector('.dc-status-label');
    if (label) {
      if (server.status === 'online') label.textContent = server.botName || t('discord.online');
      else if (server.status === 'starting') label.textContent = t('discord.starting');
      else label.textContent = t('discord.offline');
    }
  }
}

function cleanup(wrapper) {
  // Cleanup handled by TerminalManager
}

module.exports = {
  getViewSwitcherHtml,
  setupViewSwitcher,
  cleanup
};
