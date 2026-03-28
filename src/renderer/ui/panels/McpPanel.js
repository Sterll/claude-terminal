/**
 * McpPanel
 * MCP servers local management + MCP registry browsing/install
 * Extracted from renderer.js — migrated to OOP (BasePanel)
 */

const { BasePanel } = require('../../core/BasePanel');
const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { projectsState } = require('../../state');
const { fileExists, fsp } = require('../../utils/fs-async');

// ========== CATEGORY DETECTION ==========

const CATEGORY_PATTERNS = {
  database: /database|postgres|mysql|sqlite|mongo|redis|sql|mariadb|supabase|neon|prisma|drizzle|dynamo|cassandra|couchdb|elasticsearch/i,
  files: /file|filesystem|folder|directory|disk|storage|s3|drive|dropbox|onedrive/i,
  integration: /github|gitlab|jira|linear|notion|slack|discord|trello|asana|confluence|zendesk|salesforce|hubspot|stripe|twilio/i,
  web: /search|brave|google|bing|web|scrape|crawl|fetch|http|browser|playwright|puppeteer|selenium|url/i,
  ai: /ai|llm|openai|anthropic|embedding|vector|langchain|semantic|hugging|ollama|cohere/i,
  devtools: /git|deploy|ci|docker|kubernetes|aws|cloud|terraform|ansible|build|package|npm|pip|cargo|helm/i
};

function getMcpServerCategory(server) {
  const text = `${server.name || ''} ${server.title || ''} ${server.description || ''}`;
  for (const [cat, pattern] of Object.entries(CATEGORY_PATTERNS)) {
    if (pattern.test(text)) return cat;
  }
  return 'other';
}

// ========== AVATAR COLORS ==========

const AVATAR_COLORS = [
  { bg: 'rgba(139, 92, 246, 0.18)', color: '#a78bfa' },
  { bg: 'rgba(59, 130, 246, 0.18)', color: '#60a5fa' },
  { bg: 'rgba(34, 197, 94, 0.18)', color: '#4ade80' },
  { bg: 'rgba(249, 115, 22, 0.18)', color: '#fb923c' },
  { bg: 'rgba(236, 72, 153, 0.18)', color: '#f472b6' },
  { bg: 'rgba(20, 184, 166, 0.18)', color: '#2dd4bf' },
  { bg: 'rgba(234, 179, 8, 0.18)', color: '#facc15' },
  { bg: 'rgba(99, 102, 241, 0.18)', color: '#818cf8' }
];

function getServerAvatarStyle(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash |= 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getMcpServerType(server) {
  if (server.packages && server.packages.length > 0) {
    return server.packages[0].registryType || 'npm';
  }
  if (server.remotes && server.remotes.length > 0) {
    return 'http';
  }
  return null;
}

function findMcpSourceFile(mcp) {
  const { command, args } = mcp;
  if (command && (command.endsWith('.js') || command.endsWith('.mjs'))) return command;
  if ((command === 'node' || command === 'node.exe') && args && args.length > 0) {
    return args.find(a => a.endsWith('.js') || a.endsWith('.mjs')) || null;
  }
  return null;
}

function extractTools(source) {
  const tools = [];
  const seen = new Set();
  const regex = /name:\s*['"`]([\w_-]{3,})['"`]/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const name = match[1];
    if (seen.has(name)) continue;
    const ahead = source.slice(match.index, match.index + 600);
    if (!ahead.includes('inputSchema:')) continue;
    seen.add(name);
    const descMatch = ahead.match(/description:\s*'([^']{1,400})'/) ||
                      ahead.match(/description:\s*"([^"]{1,400})"/);
    tools.push({ name, description: descMatch ? descMatch[1] : null });
  }
  return tools;
}

// ========== McpPanel CLASS ==========

class McpPanel extends BasePanel {
  constructor(el, options = {}) {
    super(el, options);
    this._state = {
      mcps: [],
      mcpProcesses: {},
      selectedMcp: null,
      mcpLogsCollapsed: false,
      activeSubTab: 'local',
      activeCategory: 'all',
      registryInitialized: false,
      registry: {
        servers: [],
        nextCursor: null,
        isLoadingMore: false,
        searchResults: [],
        searchQuery: '',
        searchCache: new Map(),
        lastSectionTitle: ''
      }
    };
    this._registrySearchTimeout = null;
    this._showToast = options.showToast;
    this._showModal = options.showModal;
    this._closeModal = options.closeModal;
    this._claudeConfigFile = options.claudeConfigFile;
    this._claudeSettingsFile = options.claudeSettingsFile;
  }

  async loadMcps() {
    if (!this._state.registryInitialized) {
      this._state.registryInitialized = true;
      this._setupMcpSubTabs();
    }

    if (this._state.activeSubTab === 'local') {
      await this._loadLocalMcps();
    } else {
      await this._loadMcpRegistryContent();
    }
  }

  // ── Private: Sub-tabs ──

  _setupMcpSubTabs() {
    document.querySelectorAll('.mcp-sub-tab').forEach(btn => {
      btn.onclick = async () => {
        document.querySelectorAll('.mcp-sub-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._state.activeSubTab = btn.dataset.subtab;

        const searchContainer = document.getElementById('mcp-registry-search');

        if (btn.dataset.subtab === 'local') {
          searchContainer.style.display = 'none';
        } else {
          searchContainer.style.display = 'flex';
        }

        await this.loadMcps();
      };
    });

    const input = document.getElementById('mcp-registry-search-input');
    if (input) {
      input.addEventListener('input', () => {
        clearTimeout(this._registrySearchTimeout);
        const query = input.value.trim();
        this._state.registry.searchQuery = query;

        // Reset category filter on new search
        if (query.length > 0) this._state.activeCategory = 'all';

        this._registrySearchTimeout = setTimeout(() => {
          if (query.length >= 2) {
            this._searchMcpRegistry(query);
          } else if (query.length === 0) {
            this._loadMcpRegistryBrowse();
          }
        }, 300);
      });
    }
  }

  // ── Private: Local MCPs ──

  async _loadLocalMcps() {
    this._state.mcps = [];

    try {
      if (await fileExists(this._claudeConfigFile)) {
        const config = JSON.parse(await fsp.readFile(this._claudeConfigFile, 'utf8'));
        if (config.mcpServers) {
          Object.entries(config.mcpServers).forEach(([name, mcpConfig]) => {
            this._state.mcps.push({
              id: `global-${name}`,
              name,
              command: mcpConfig.command || '',
              args: mcpConfig.args || [],
              env: mcpConfig.env || {},
              source: 'global',
              sourceLabel: 'Global'
            });
          });
        }
      }
    } catch (e) { console.error('Error loading MCPs from ~/.claude.json:', e); }

    try {
      if (await fileExists(this._claudeSettingsFile)) {
        const settings = JSON.parse(await fsp.readFile(this._claudeSettingsFile, 'utf8'));
        if (settings.mcpServers) {
          Object.entries(settings.mcpServers).forEach(([name, config]) => {
            if (!this._state.mcps.find(m => m.name === name)) {
              this._state.mcps.push({
                id: `global-${name}`,
                name,
                command: config.command || '',
                args: config.args || [],
                env: config.env || {},
                source: 'global',
                sourceLabel: 'Global'
              });
            }
          });
        }
      }
    } catch (e) { console.error('Error loading MCPs from ~/.claude/settings.json:', e); }

    const projects = projectsState.get().projects;
    for (const project of projects) {
      try {
        const projectMcpFile = this.api.path.join(project.path, '.claude', 'settings.local.json');
        if (await fileExists(projectMcpFile)) {
          const projectSettings = JSON.parse(await fsp.readFile(projectMcpFile, 'utf8'));
          if (projectSettings.mcpServers) {
            Object.entries(projectSettings.mcpServers).forEach(([name, config]) => {
              const existingGlobal = this._state.mcps.find(m => m.name === name && m.source === 'global');
              if (!existingGlobal) {
                this._state.mcps.push({
                  id: `project-${project.id}-${name}`,
                  name,
                  command: config.command || '',
                  args: config.args || [],
                  env: config.env || {},
                  source: 'project',
                  sourceLabel: project.name,
                  projectId: project.id
                });
              }
            });
          }
        }
      } catch (e) { /* ignore project-specific errors */ }
    }

    this._state.mcps.forEach(mcp => {
      if (!this._state.mcpProcesses[mcp.id]) {
        this._state.mcpProcesses[mcp.id] = { status: 'stopped', logs: [] };
      }
    });

    this._renderMcps();
  }

  _renderMcps() {
    const list = document.getElementById('mcp-list');
    if (this._state.mcps.length === 0) {
      list.innerHTML = `<div class="empty-list"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 16l-4-4V8.82C14.16 8.4 15 7.3 15 6c0-1.66-1.34-3-3-3S9 4.34 9 6c0 1.3.84 2.4 2 2.82V12l-4 4H3v5h5v-3.05l4-4.2 4 4.2V21h5v-5h-4z"/></svg><h3>${t('mcpLocal.noServers')}</h3><p>${t('mcpLocal.configureHint')}</p></div>`;
      return;
    }

    const globalMcps = this._state.mcps.filter(m => m.source === 'global');
    const projectMcps = this._state.mcps.filter(m => m.source === 'project');

    let html = '';

    if (globalMcps.length > 0) {
      html += `<div class="mcp-section"><div class="mcp-section-title">${t('mcpLocal.global')}</div>`;
      html += globalMcps.map(mcp => this._renderMcpCard(mcp)).join('');
      html += `</div>`;
    }

    if (projectMcps.length > 0) {
      const byProject = {};
      projectMcps.forEach(mcp => {
        if (!byProject[mcp.sourceLabel]) byProject[mcp.sourceLabel] = [];
        byProject[mcp.sourceLabel].push(mcp);
      });

      Object.entries(byProject).forEach(([projectName, mcps]) => {
        html += `<div class="mcp-section"><div class="mcp-section-title">${escapeHtml(projectName)}</div>`;
        html += mcps.map(mcp => this._renderMcpCard(mcp)).join('');
        html += `</div>`;
      });
    }

    list.innerHTML = html;
    this._bindMcpCardHandlers();
  }

  _renderMcpCard(mcp) {
    const initial = (mcp.name || '?').charAt(0).toUpperCase();
    const cmdFull = `${mcp.command}${mcp.args?.length ? ' ' + mcp.args.join(' ') : ''}`;

    return `<div class="mcp-card-wrapper">
    <div class="mcp-card" data-id="${mcp.id}">
      <div class="mcp-card-avatar">${escapeHtml(initial)}</div>
      <div class="mcp-card-body">
        <div class="mcp-card-name">
          ${escapeHtml(mcp.name)}
          <span class="mcp-source-badge">${escapeHtml(mcp.sourceLabel || 'Global')}</span>
        </div>
        <div class="mcp-card-cmd" title="${escapeHtml(cmdFull)}">${escapeHtml(cmdFull)}</div>
      </div>
      <div class="mcp-card-chevron">▸</div>
    </div>
    <div class="mcp-tools-panel" data-id="${mcp.id}"></div>
  </div>`;
  }

  async _loadMcpTools(mcp) {
    const filePath = findMcpSourceFile(mcp);
    if (!filePath) return null;
    try {
      const tools = [];

      const mainSource = await fsp.readFile(filePath, 'utf8');
      tools.push(...extractTools(mainSource));

      const toolsDir = this.api.path.join(this.api.path.dirname(filePath), 'tools');
      if (await fileExists(toolsDir)) {
        const files = (await fsp.readdir(toolsDir)).filter(f => f.endsWith('.js'));
        for (const file of files) {
          try {
            const src = await fsp.readFile(this.api.path.join(toolsDir, file), 'utf8');
            tools.push(...extractTools(src));
          } catch { /* ignore */ }
        }
      }

      // Deduplicate by name
      const seen = new Set();
      return tools.filter(t => seen.has(t.name) ? false : seen.add(t.name));
    } catch {
      return null;
    }
  }

  _renderMcpTools(panel, tools) {
    if (!tools) {
      panel.innerHTML = `<div class="mcp-tools-unavailable">${t('mcp.toolsUnavailable')}</div>`;
      return;
    }
    if (tools.length === 0) {
      panel.innerHTML = `<div class="mcp-tools-unavailable">${t('mcp.noTools')}</div>`;
      return;
    }
    const rows = tools.map(tool => `
    <div class="mcp-tool-row">
      <span class="mcp-tool-row-name">${escapeHtml(tool.name)}</span>
      ${tool.description ? `<span class="mcp-tool-row-desc">${escapeHtml(tool.description)}</span>` : ''}
    </div>`).join('');
    panel.innerHTML = `<div class="mcp-tools-table">${rows}</div>`;
  }

  _bindMcpCardHandlers() {
    document.querySelectorAll('.mcp-card').forEach(card => {
      card.addEventListener('click', async () => {
        const id = card.dataset.id;
        const panel = document.querySelector(`.mcp-tools-panel[data-id="${id}"]`);
        const chevron = card.querySelector('.mcp-card-chevron');
        if (!panel) return;

        const isOpen = panel.classList.contains('open');
        panel.classList.toggle('open', !isOpen);
        if (chevron) chevron.textContent = isOpen ? '▸' : '▾';

        if (!isOpen && !panel.dataset.loaded) {
          panel.dataset.loaded = 'true';
          panel.innerHTML = `<div class="mcp-tools-loading"><div class="spinner-sm"></div></div>`;
          const mcp = this._state.mcps.find(m => m.id === id);
          const tools = await this._loadMcpTools(mcp);
          this._renderMcpTools(panel, tools);
        }
      });
    });
  }

  // ========== MCP REGISTRY ==========

  _isMcpInstalled(serverName) {
    return this._state.mcps.some(m => m.name === serverName);
  }

  _getMcpServerIcon(server) {
    if (server.icons && server.icons.length > 0) {
      const fallback = escapeHtml((server.title || server.name || '?').charAt(0).toUpperCase());
      return `<img src="${escapeHtml(server.icons[0])}" data-fallback="${fallback}" class="mcp-icon-img">`;
    }
    if (server.repository && server.repository.url) {
      const ghMatch = server.repository.url.match(/github\.com\/([^/]+)/);
      if (ghMatch) {
        const fallback = escapeHtml((server.title || server.name || '?').charAt(0).toUpperCase());
        return `<img src="https://github.com/${ghMatch[1]}.png?size=64" data-fallback="${fallback}" class="mcp-icon-img">`;
      }
    }
    return escapeHtml((server.title || server.name || '?').charAt(0).toUpperCase());
  }

  _filterServersByCategory(servers) {
    if (this._state.activeCategory === 'all') return servers;
    return servers.filter(s => getMcpServerCategory(s) === this._state.activeCategory);
  }

  // ========== CATEGORY FILTERS ==========

  _renderCategoryFilters(servers) {
    const categories = ['all', 'database', 'files', 'web', 'integration', 'devtools', 'ai'];
    const counts = { all: servers.length };

    servers.forEach(s => {
      const cat = getMcpServerCategory(s);
      counts[cat] = (counts[cat] || 0) + 1;
    });

    // Only show categories that have at least 1 match
    const visibleCats = categories.filter(c => c === 'all' || (counts[c] || 0) > 0);

    return `<div class="mcp-category-filters">
    ${visibleCats.map(cat => {
      const count = counts[cat] || 0;
      const active = this._state.activeCategory === cat ? 'active' : '';
      const label = t(`mcpRegistry.category.${cat}`);
      const countHtml = cat !== 'all' ? ` <span class="mcp-filter-count">${count}</span>` : '';
      return `<button class="mcp-filter-pill ${active}" data-category="${cat}">${label}${countHtml}</button>`;
    }).join('')}
  </div>`;
  }

  _bindCategoryFilterHandlers(servers, sectionTitle) {
    document.querySelectorAll('.mcp-filter-pill').forEach(btn => {
      btn.onclick = () => {
        this._state.activeCategory = btn.dataset.category;
        this._renderMcpRegistryCards(servers, sectionTitle);
      };
    });
  }

  // ========== REGISTRY CARD RENDERING ==========

  _renderRegistryCard(server) {
    const serverName = server.name || '';
    const displayName = server.title || serverName;
    const installed = this._isMcpInstalled(serverName);
    const serverType = getMcpServerType(server);
    const description = server.description || t('mcpRegistry.noDescription');
    const avatarStyle = getServerAvatarStyle(serverName);

    // Package name for subtitle
    let pkgName = '';
    if (server.packages && server.packages.length > 0) {
      pkgName = server.packages[0].name || server.packages[0].package_name || '';
    } else if (server.remotes && server.remotes.length > 0) {
      pkgName = server.remotes[0].url || '';
    }

    // Icon: prefer server icon, then GitHub org avatar, then colored letter
    let iconHtml;
    if (server.icons && server.icons.length > 0) {
      const fallback = escapeHtml(displayName.charAt(0).toUpperCase());
      iconHtml = `<img src="${escapeHtml(server.icons[0])}" data-fallback="${fallback}" class="mcp-icon-img">`;
    } else if (server.repository && server.repository.url) {
      const ghMatch = server.repository.url.match(/github\.com\/([^/]+)/);
      if (ghMatch) {
        const fallback = escapeHtml(displayName.charAt(0).toUpperCase());
        iconHtml = `<img src="https://github.com/${ghMatch[1]}.png?size=64" data-fallback="${fallback}" class="mcp-icon-img">`;
      } else {
        iconHtml = escapeHtml(displayName.charAt(0).toUpperCase());
      }
    } else {
      iconHtml = escapeHtml(displayName.charAt(0).toUpperCase());
    }

    const cardClass = installed ? 'mcp-registry-card installed' : 'mcp-registry-card';

    return `
  <div class="${cardClass}" data-server-name="${escapeHtml(serverName)}">
    <div class="mcp-registry-card-header">
      <div class="mcp-registry-icon" style="background:${avatarStyle.bg};color:${avatarStyle.color}">${iconHtml}</div>
      <div class="mcp-registry-card-info">
        <div class="mcp-registry-card-title">${escapeHtml(displayName)}</div>
        ${pkgName ? `<div class="mcp-registry-card-pkg">${escapeHtml(pkgName)}</div>` : ''}
      </div>
    </div>
    <div class="mcp-registry-card-desc">${escapeHtml(description)}</div>
    <div class="mcp-registry-card-footer">
      <div class="mcp-registry-card-badges">
        ${serverType ? `<span class="mcp-registry-badge ${serverType}">${serverType}</span>` : ''}
        ${installed ? `<span class="mcp-registry-badge installed-badge">✓ ${t('mcpRegistry.installed')}</span>` : ''}
      </div>
      ${installed
        ? ''
        : `<button class="btn-sm btn-install btn-mcp-install">${t('mcpRegistry.install')}</button>`
      }
    </div>
  </div>`;
  }

  async _loadMcpRegistryContent() {
    if (this._state.registry.searchQuery) {
      await this._searchMcpRegistry(this._state.registry.searchQuery);
    } else {
      await this._loadMcpRegistryBrowse();
    }
  }

  async _searchMcpRegistry(query) {
    const list = document.getElementById('mcp-list');

    const cachedResults = this._state.registry.searchCache.get(query);
    if (cachedResults) {
      this._state.registry.searchResults = cachedResults;
      await this._renderMcpRegistryCards(cachedResults, t('mcpRegistry.searchResults'));
      return;
    }

    list.innerHTML = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;

    try {
      const result = await this.api.mcpRegistry.search(query, 30);
      if (!result.success) throw new Error(result.error);

      const newServers = result.servers || [];
      this._state.registry.searchCache.set(query, newServers);
      this._state.registry.searchResults = newServers;
      // Always render — clears spinner even when result is empty
      await this._renderMcpRegistryCards(newServers, t('mcpRegistry.searchResults'));
    } catch (e) {
      list.innerHTML = `<div class="marketplace-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }

  async _loadMcpRegistryBrowse() {
    const list = document.getElementById('mcp-list');

    // If we already have servers cached, render them immediately while refreshing in background
    if (this._state.registry.servers.length > 0) {
      await this._renderMcpRegistryCards(this._state.registry.servers, t('mcpRegistry.available'));
      return;
    }

    list.innerHTML = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;

    try {
      const result = await this.api.mcpRegistry.browse(50);
      if (!result.success) throw new Error(result.error);

      const newServers = result.servers || [];
      this._state.registry.servers = newServers;
      this._state.registry.nextCursor = result.nextCursor || null;
      // Always render — even if empty, this clears the spinner
      await this._renderMcpRegistryCards(newServers, t('mcpRegistry.available'));
    } catch (e) {
      list.innerHTML = `<div class="marketplace-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }

  async _loadMoreMcpRegistryServers() {
    if (!this._state.registry.nextCursor || this._state.registry.isLoadingMore) return;
    this._state.registry.isLoadingMore = true;

    const btn = document.getElementById('mcp-registry-load-more');
    if (btn) {
      btn.disabled = true;
      btn.textContent = t('common.loading');
    }

    try {
      const result = await this.api.mcpRegistry.browse(50, this._state.registry.nextCursor);
      if (!result.success) throw new Error(result.error);

      const moreServers = result.servers || [];
      this._state.registry.servers = [...this._state.registry.servers, ...moreServers];
      this._state.registry.nextCursor = result.nextCursor || null;
      await this._renderMcpRegistryCards(this._state.registry.servers, t('mcpRegistry.available'));
    } catch (e) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = t('mcpRegistry.loadMore');
      }
    } finally {
      this._state.registry.isLoadingMore = false;
    }
  }

  async _renderMcpRegistryCards(servers, sectionTitle) {
    const list = document.getElementById('mcp-list');

    await this._loadLocalMcpsQuiet();

    if (!servers || servers.length === 0) {
      list.innerHTML = `<div class="marketplace-empty">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
      <h3>${t('mcpRegistry.noResults')}</h3>
      <p>${t('mcpRegistry.searchHint')}</p>
    </div>`;
      return;
    }

    // Store for re-use by category filters
    this._state.registry.lastSectionTitle = sectionTitle;

    const filtered = this._filterServersByCategory(servers);
    const catFilters = this._renderCategoryFilters(servers);

    if (filtered.length === 0) {
      list.innerHTML = catFilters + `<div class="marketplace-empty">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
      <h3>${t('mcpRegistry.noResults')}</h3>
    </div>`;
      this._bindCategoryFilterHandlers(servers, sectionTitle);
      return;
    }

    let html = catFilters;
    html += `<div class="list-section">
    <div class="list-section-title">${escapeHtml(sectionTitle)} <span class="list-section-count">${filtered.length}</span></div>
    <div class="list-section-grid">`;

    html += filtered.map(server => this._renderRegistryCard(server)).join('');

    html += `</div></div>`;

    // Show "Load more" button only for browse mode (not search) when there is a next page
    const isSearchMode = !!this._state.registry.searchQuery;
    if (!isSearchMode && this._state.registry.nextCursor) {
      html += `<div class="mcp-registry-load-more-wrapper">
      <button class="btn-secondary" id="mcp-registry-load-more">${t('mcpRegistry.loadMore')}</button>
    </div>`;
    }

    list.innerHTML = html;

    // Bind "Load more" handler
    const loadMoreBtn = document.getElementById('mcp-registry-load-more');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => this._loadMoreMcpRegistryServers());
    }

    this._bindMcpRegistryCardHandlers();
    this._bindCategoryFilterHandlers(servers, sectionTitle);
  }

  _bindMcpRegistryCardHandlers() {
    const list = document.getElementById('mcp-list');

    // Handle icon image load errors
    list.querySelectorAll('.mcp-icon-img').forEach(img => {
      img.addEventListener('error', () => {
        if (img.parentElement) img.parentElement.textContent = img.dataset.fallback || '?';
      });
    });

    list.querySelectorAll('.mcp-registry-card').forEach(card => {
      const serverName = card.dataset.serverName;

      // Card click = open details modal
      card.addEventListener('click', (e) => {
        if (!e.target.closest('button')) {
          this._showMcpRegistryDetail(serverName);
        }
      });

      const installBtn = card.querySelector('.btn-mcp-install');
      if (installBtn) {
        installBtn.onclick = async (e) => {
          e.stopPropagation();
          installBtn.disabled = true;
          installBtn.innerHTML = `<span class="btn-install-spinner"></span>${t('mcpRegistry.installing')}`;
          try {
            await this._installMcpFromRegistry(serverName);
            await this._loadMcpRegistryContent();
          } catch (err) {
            installBtn.disabled = false;
            installBtn.innerHTML = t('mcpRegistry.install');
            if (this._showToast) {
              this._showToast({ type: 'error', title: `${t('mcpRegistry.installError')}: ${err.message}` });
            }
          }
        };
      }
    });
  }

  async _showMcpRegistryDetail(serverName) {
    const installed = this._isMcpInstalled(serverName);

    let content = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;
    this._showModal(t('mcpRegistry.details'), content);

    try {
      const result = await this.api.mcpRegistry.detail(serverName);
      if (!result.success) throw new Error(result.error);
      const server = result.server;

      const displayName = server.title || server.name || serverName;
      const description = server.description || t('mcpRegistry.noDescription');
      const serverType = getMcpServerType(server);
      const icon = this._getMcpServerIcon(server);
      const version = server.version_detail?.version || server.version || '';
      const avatarStyle = getServerAvatarStyle(serverName);

      let metaHtml = '';
      if (version) {
        metaHtml += `<div class="mcp-detail-meta-row"><span class="mcp-detail-meta-label">${t('mcpRegistry.version')}</span><span class="mcp-detail-meta-value">${escapeHtml(version)}</span></div>`;
      }
      if (serverType) {
        metaHtml += `<div class="mcp-detail-meta-row"><span class="mcp-detail-meta-label">${t('mcpRegistry.serverType')}</span><span class="mcp-detail-meta-value"><span class="mcp-registry-badge ${serverType}">${serverType}</span></span></div>`;
      }
      if (server.packages && server.packages.length > 0) {
        const pkg = server.packages[0];
        const pkgName = pkg.name || pkg.package_name || '';
        metaHtml += `<div class="mcp-detail-meta-row"><span class="mcp-detail-meta-label">${t('mcpRegistry.packages')}</span><span class="mcp-detail-meta-value">${escapeHtml(pkgName)}</span></div>`;
      }
      if (server.repository && server.repository.url) {
        metaHtml += `<div class="mcp-detail-meta-row"><span class="mcp-detail-meta-label">${t('mcpRegistry.repository')}</span><span class="mcp-detail-meta-value"><a href="#" class="mcp-repo-link" data-url="${escapeHtml(server.repository.url)}" style="color: var(--accent);">${escapeHtml(server.repository.url)}</a></span></div>`;
      }

      const detailContent = `
      <div class="mcp-detail-header">
        <div class="mcp-detail-icon" style="background:${avatarStyle.bg};color:${avatarStyle.color}">${icon}</div>
        <div class="mcp-detail-info">
          <div class="mcp-detail-title">${escapeHtml(displayName)}</div>
          <div class="mcp-detail-name">${escapeHtml(serverName)}</div>
        </div>
      </div>
      <div class="mcp-detail-desc">${escapeHtml(description)}</div>
      ${metaHtml ? `<div class="mcp-detail-meta">${metaHtml}</div>` : ''}
      <div class="mcp-detail-actions">
        ${installed
          ? `<span class="mcp-registry-badge installed-badge" style="font-size: 13px; padding: 6px 16px;">✓ ${t('mcpRegistry.installed')}</span>`
          : `<button class="btn-primary btn-mcp-install-detail">${t('mcpRegistry.install')}</button>`
        }
      </div>
    `;

      document.getElementById('modal-body').innerHTML = detailContent;

      const repoLink = document.querySelector('.mcp-repo-link');
      if (repoLink) {
        repoLink.addEventListener('click', (e) => {
          e.preventDefault();
          const url = repoLink.dataset.url;
          if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
            this.api.dialog.openExternal(url);
          }
        });
      }

      const installDetailBtn = document.querySelector('.btn-mcp-install-detail');
      if (installDetailBtn) {
        installDetailBtn.onclick = async () => {
          installDetailBtn.disabled = true;
          installDetailBtn.innerHTML = `<span class="btn-install-spinner"></span>${t('mcpRegistry.installing')}`;
          try {
            await this._installMcpFromRegistry(serverName);
            this._closeModal();
            await this._loadMcpRegistryContent();
          } catch (err) {
            installDetailBtn.disabled = false;
            installDetailBtn.innerHTML = t('mcpRegistry.install');
            if (this._showToast) {
              this._showToast({ type: 'error', title: `${t('mcpRegistry.installError')}: ${err.message}` });
            }
          }
        };
      }
    } catch (e) {
      document.getElementById('modal-body').innerHTML = `<div class="marketplace-empty"><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }

  // ========== CONNECTION TEST ==========

  async _testMcpConnection(serverName, mcpConfig) {
    // HTTP servers can't be tested via process start
    if (mcpConfig.type === 'url' || !mcpConfig.command) {
      return 'http';
    }

    const testId = `mcp-test-${serverName}-${Date.now()}`;

    return new Promise((resolve) => {
      let resolved = false;

      const done = (result) => {
        if (!resolved) {
          resolved = true;
          unsubOutput();
          unsubExit();
          clearTimeout(timer);
          // Stop the test process (unless it already exited)
          if (result !== 'exited' && result !== 'failed') {
            this.api.mcp.stop({ id: testId }).catch(() => {});
          }
          resolve(result);
        }
      };

      // 5s timeout - MCP servers can be slow to start (npm install)
      const timer = setTimeout(() => done('timeout'), 5000);

      const unsubOutput = this.api.mcp.onOutput(({ id }) => {
        if (id === testId) done('connected');
      });

      const unsubExit = this.api.mcp.onExit(({ id, code }) => {
        if (id === testId) done(code === 0 ? 'exited' : 'failed');
      });

      this.api.mcp.start({
        id: testId,
        command: mcpConfig.command,
        args: mcpConfig.args || [],
        env: mcpConfig.env || {}
      }).catch(() => done('failed'));
    });
  }

  // ========== INSTALL ==========

  async _installMcpFromRegistry(serverName) {
    const result = await this.api.mcpRegistry.detail(serverName);
    if (!result.success) throw new Error(result.error);
    const server = result.server;

    let mcpConfig = null;
    let serverType = null;
    let envVarsSpec = [];
    let argsSpec = [];

    if (server.packages && server.packages.length > 0) {
      const pkg = server.packages[0];
      serverType = pkg.registryType || 'npm';
      const identifier = pkg.name || pkg.package_name || '';

      if (pkg.environment_variables && pkg.environment_variables.length > 0) {
        envVarsSpec = pkg.environment_variables;
      }
      if (pkg.arguments && pkg.arguments.length > 0) {
        argsSpec = pkg.arguments;
      }

      if (serverType === 'npm') {
        mcpConfig = { command: 'npx', args: ['-y', identifier] };
      } else if (serverType === 'pypi') {
        mcpConfig = { command: 'uvx', args: [identifier] };
      }
    } else if (server.remotes && server.remotes.length > 0) {
      const remote = server.remotes[0];
      serverType = 'http';

      if (remote.environment_variables && remote.environment_variables.length > 0) {
        envVarsSpec = remote.environment_variables;
      }

      mcpConfig = { type: 'url', url: remote.url };
    }

    if (!mcpConfig) {
      throw new Error(t('mcpRegistry.cannotInstall'));
    }

    if (envVarsSpec.length > 0 || argsSpec.length > 0) {
      const formResult = await this._showMcpEnvForm(server, envVarsSpec, argsSpec);
      if (!formResult) return;

      if (formResult.env && Object.keys(formResult.env).length > 0) {
        mcpConfig.env = formResult.env;
      }
      if (formResult.args && formResult.args.length > 0) {
        if (mcpConfig.args) {
          mcpConfig.args = [...mcpConfig.args, ...formResult.args];
        }
      }
    }

    await this._saveMcpToConfig(serverName, mcpConfig);
    await this._loadLocalMcpsQuiet();

    const displayName = server.title || serverName;

    // Show immediate success toast
    if (this._showToast) {
      this._showToast({ type: 'success', title: t('mcpRegistry.installSuccess', { name: displayName }) });
    }

    // Test connection in background — don't block the install flow
    const configCopy = { ...mcpConfig };
    this._testMcpConnection(serverName, configCopy).then((testResult) => {
      if (testResult === 'failed') {
        if (this._showToast) {
          this._showToast({ type: 'warning', title: `${displayName}: ${t('mcpRegistry.connectionFailed')}` });
        }
      } else if (testResult === 'connected') {
        if (this._showToast) {
          this._showToast({ type: 'success', title: `${displayName}: ${t('mcpRegistry.connectionSuccess')}` });
        }
      }
      // timeout / http / exited: no extra toast needed
    }).catch(() => { /* silent */ });
  }

  _showMcpEnvForm(server, envVarsSpec, argsSpec) {
    return new Promise((resolve) => {
      const displayName = server.title || server.name || '';

      let fieldsHtml = '';

      if (envVarsSpec.length > 0) {
        fieldsHtml += `<div class="mcp-env-section-title">${t('mcpRegistry.environmentVariables')}</div>`;
        envVarsSpec.forEach(envVar => {
          const name = envVar.name || envVar;
          const desc = envVar.description || '';
          const required = envVar.required !== false;
          const isSecret = envVar.isSecret || name.toLowerCase().includes('key') || name.toLowerCase().includes('token') || name.toLowerCase().includes('secret') || name.toLowerCase().includes('password');
          fieldsHtml += `
          <div class="mcp-env-field">
            <label>${escapeHtml(name)} ${required ? `<span class="mcp-env-required">${t('mcpRegistry.requiredField')}</span>` : ''}</label>
            <input type="${isSecret ? 'password' : 'text'}" data-env-name="${escapeHtml(name)}" data-required="${required}" placeholder="${escapeHtml(name)}">
            ${desc ? `<div class="mcp-env-hint">${escapeHtml(desc)}</div>` : ''}
          </div>`;
        });
      }

      if (argsSpec.length > 0) {
        fieldsHtml += `<div class="mcp-env-section-title">${t('mcpRegistry.arguments')}</div>`;
        argsSpec.forEach((arg, i) => {
          const name = arg.name || arg.description || `Arg ${i + 1}`;
          const desc = arg.description || '';
          const required = arg.required !== false;
          fieldsHtml += `
          <div class="mcp-env-field">
            <label>${escapeHtml(name)} ${required ? `<span class="mcp-env-required">${t('mcpRegistry.requiredField')}</span>` : ''}</label>
            <input type="text" data-arg-index="${i}" data-required="${required}" placeholder="${escapeHtml(name)}">
            ${desc ? `<div class="mcp-env-hint">${escapeHtml(desc)}</div>` : ''}
          </div>`;
        });
      }

      const content = `
      <div class="mcp-env-form">
        <div class="mcp-env-form-desc">${t('mcpRegistry.envFormDescription')}</div>
        ${fieldsHtml}
      </div>
    `;

      const footer = `
      <button class="btn-secondary" id="mcp-env-cancel">${t('modal.cancel')}</button>
      <button class="btn-primary" id="mcp-env-confirm">${t('mcpRegistry.install')}</button>
    `;

      this._showModal(t('mcpRegistry.configureServer') + ' - ' + escapeHtml(displayName), content, footer);

      document.getElementById('mcp-env-cancel').onclick = () => {
        this._closeModal();
        resolve(null);
      };

      document.getElementById('mcp-env-confirm').onclick = () => {
        const env = {};
        const args = [];
        let valid = true;

        document.querySelectorAll('.mcp-env-form input[data-env-name]').forEach(input => {
          const name = input.dataset.envName;
          const val = input.value.trim();
          const required = input.dataset.required === 'true';
          if (required && !val) {
            input.style.borderColor = 'var(--danger, #ef4444)';
            valid = false;
          } else {
            input.style.borderColor = '';
            if (val) env[name] = val;
          }
        });

        document.querySelectorAll('.mcp-env-form input[data-arg-index]').forEach(input => {
          const val = input.value.trim();
          const required = input.dataset.required === 'true';
          if (required && !val) {
            input.style.borderColor = 'var(--danger, #ef4444)';
            valid = false;
          } else {
            input.style.borderColor = '';
            if (val) args.push(val);
          }
        });

        if (!valid) return;

        this._closeModal();
        resolve({ env, args });
      };
    });
  }

  async _saveMcpToConfig(serverName, mcpConfig) {
    try {
      let config = {};
      if (await fileExists(this._claudeConfigFile)) {
        config = JSON.parse(await fsp.readFile(this._claudeConfigFile, 'utf8'));
      }
      if (!config.mcpServers) {
        config.mcpServers = {};
      }
      config.mcpServers[serverName] = mcpConfig;
      await fsp.writeFile(this._claudeConfigFile, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
      console.error('Error saving MCP to config:', e);
      throw new Error('Failed to save configuration: ' + e.message);
    }
  }

  async _loadLocalMcpsQuiet() {
    this._state.mcps = [];
    try {
      if (await fileExists(this._claudeConfigFile)) {
        const config = JSON.parse(await fsp.readFile(this._claudeConfigFile, 'utf8'));
        if (config.mcpServers) {
          Object.entries(config.mcpServers).forEach(([name, mcpConfig]) => {
            this._state.mcps.push({ id: `global-${name}`, name, command: mcpConfig.command || '', args: mcpConfig.args || [], env: mcpConfig.env || {}, source: 'global', sourceLabel: 'Global' });
          });
        }
      }
    } catch { /* ignore */ }
    try {
      if (await fileExists(this._claudeSettingsFile)) {
        const settings = JSON.parse(await fsp.readFile(this._claudeSettingsFile, 'utf8'));
        if (settings.mcpServers) {
          Object.entries(settings.mcpServers).forEach(([name, config]) => {
            if (!this._state.mcps.find(m => m.name === name)) {
              this._state.mcps.push({ id: `global-${name}`, name, command: config.command || '', args: config.args || [], env: config.env || {}, source: 'global', sourceLabel: 'Global' });
            }
          });
        }
      }
    } catch { /* ignore */ }
  }
}

// ── Lazy singleton + legacy exports ──

let _instance = null;

function init(context) {
  const { getApiProvider, getContainer } = require('../../core');
  _instance = new McpPanel(null, {
    api: getApiProvider(),
    container: getContainer(),
    showToast: context.showToast,
    showModal: context.showModal,
    closeModal: context.closeModal,
    claudeConfigFile: context.claudeConfigFile,
    claudeSettingsFile: context.claudeSettingsFile
  });
}

module.exports = {
  McpPanel,
  init,
  loadMcps: (...a) => _instance.loadMcps(...a)
};
