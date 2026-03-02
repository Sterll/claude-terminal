/**
 * McpPanel
 * MCP servers local management + MCP registry browsing/install
 * Extracted from renderer.js
 */

const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');

let ctx = null;

let mcpState = {
  mcps: [],
  mcpProcesses: {},
  selectedMcp: null,
  mcpLogsCollapsed: false,
  activeSubTab: 'local',
  registryInitialized: false,
  registry: {
    servers: [],
    searchResults: [],
    searchQuery: '',
    searchCache: new Map()
  }
};

let mcpRegistrySearchTimeout = null;

function init(context) {
  ctx = context;
}

async function loadMcps() {
  if (!mcpState.registryInitialized) {
    mcpState.registryInitialized = true;
    setupMcpSubTabs();
  }

  if (mcpState.activeSubTab === 'local') {
    await loadLocalMcps();
  } else {
    await loadMcpRegistryContent();
  }
}

function setupMcpSubTabs() {
  document.querySelectorAll('.mcp-sub-tab').forEach(btn => {
    btn.onclick = async () => {
      document.querySelectorAll('.mcp-sub-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      mcpState.activeSubTab = btn.dataset.subtab;

      const searchContainer = document.getElementById('mcp-registry-search');

      if (btn.dataset.subtab === 'local') {
        searchContainer.style.display = 'none';
      } else {
        searchContainer.style.display = 'flex';
      }

      await loadMcps();
    };
  });

  const input = document.getElementById('mcp-registry-search-input');
  if (input) {
    input.addEventListener('input', () => {
      clearTimeout(mcpRegistrySearchTimeout);
      const query = input.value.trim();
      mcpState.registry.searchQuery = query;

      mcpRegistrySearchTimeout = setTimeout(() => {
        if (query.length >= 2) {
          searchMcpRegistry(query);
        } else if (query.length === 0) {
          loadMcpRegistryBrowse();
        }
      }, 300);
    });
  }
}

async function loadLocalMcps() {
  mcpState.mcps = [];

  try {
    if (ctx.fs.existsSync(ctx.claudeConfigFile)) {
      const config = JSON.parse(await ctx.fs.promises.readFile(ctx.claudeConfigFile, 'utf8'));
      if (config.mcpServers) {
        Object.entries(config.mcpServers).forEach(([name, mcpConfig]) => {
          mcpState.mcps.push({
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
    if (ctx.fs.existsSync(ctx.claudeSettingsFile)) {
      const settings = JSON.parse(await ctx.fs.promises.readFile(ctx.claudeSettingsFile, 'utf8'));
      if (settings.mcpServers) {
        Object.entries(settings.mcpServers).forEach(([name, config]) => {
          if (!mcpState.mcps.find(m => m.name === name)) {
            mcpState.mcps.push({
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

  const projects = ctx.projectsState.get().projects;
  for (const project of projects) {
    try {
      const projectMcpFile = ctx.path.join(project.path, '.claude', 'settings.local.json');
      if (ctx.fs.existsSync(projectMcpFile)) {
        const projectSettings = JSON.parse(await ctx.fs.promises.readFile(projectMcpFile, 'utf8'));
        if (projectSettings.mcpServers) {
          Object.entries(projectSettings.mcpServers).forEach(([name, config]) => {
            const existingGlobal = mcpState.mcps.find(m => m.name === name && m.source === 'global');
            if (!existingGlobal) {
              mcpState.mcps.push({
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

  mcpState.mcps.forEach(mcp => {
    if (!mcpState.mcpProcesses[mcp.id]) {
      mcpState.mcpProcesses[mcp.id] = { status: 'stopped', logs: [] };
    }
  });

  renderMcps();
}

function renderMcps() {
  const list = document.getElementById('mcp-list');
  if (mcpState.mcps.length === 0) {
    list.innerHTML = `<div class="empty-list"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 16l-4-4V8.82C14.16 8.4 15 7.3 15 6c0-1.66-1.34-3-3-3S9 4.34 9 6c0 1.3.84 2.4 2 2.82V12l-4 4H3v5h5v-3.05l4-4.2 4 4.2V21h5v-5h-4z"/></svg><h3>${t('mcpLocal.noServers')}</h3><p>${t('mcpLocal.configureHint')}</p></div>`;
    return;
  }

  const globalMcps = mcpState.mcps.filter(m => m.source === 'global');
  const projectMcps = mcpState.mcps.filter(m => m.source === 'project');

  let html = '';

  if (globalMcps.length > 0) {
    html += `<div class="mcp-section"><div class="mcp-section-title">${t('mcpLocal.global')}</div>`;
    html += globalMcps.map(mcp => renderMcpCard(mcp)).join('');
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
      html += mcps.map(mcp => renderMcpCard(mcp)).join('');
      html += `</div>`;
    });
  }

  list.innerHTML = html;
  bindMcpCardHandlers();
}

function renderMcpCard(mcp) {
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

async function loadMcpTools(mcp) {
  const filePath = findMcpSourceFile(mcp);
  if (!filePath) return null;
  try {
    const tools = [];

    const mainSource = await ctx.fs.promises.readFile(filePath, 'utf8');
    tools.push(...extractTools(mainSource));

    const toolsDir = ctx.path.join(ctx.path.dirname(filePath), 'tools');
    if (ctx.fs.existsSync(toolsDir)) {
      const files = ctx.fs.readdirSync(toolsDir).filter(f => f.endsWith('.js'));
      for (const file of files) {
        try {
          const src = await ctx.fs.promises.readFile(ctx.path.join(toolsDir, file), 'utf8');
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

function renderMcpTools(panel, tools) {
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

function bindMcpCardHandlers() {
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
        const mcp = mcpState.mcps.find(m => m.id === id);
        const tools = await loadMcpTools(mcp);
        renderMcpTools(panel, tools);
      }
    });
  });
}

// ========== MCP REGISTRY ==========

function isMcpInstalled(serverName) {
  return mcpState.mcps.some(m => m.name === serverName);
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

function getMcpServerIcon(server) {
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

async function loadMcpRegistryContent() {
  if (mcpState.registry.searchQuery) {
    await searchMcpRegistry(mcpState.registry.searchQuery);
  } else {
    await loadMcpRegistryBrowse();
  }
}

async function searchMcpRegistry(query) {
  const list = document.getElementById('mcp-list');

  const cachedResults = mcpState.registry.searchCache.get(query);
  if (cachedResults) {
    mcpState.registry.searchResults = cachedResults;
    await renderMcpRegistryCards(cachedResults, t('mcpRegistry.searchResults'));
  } else {
    list.innerHTML = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;
  }

  try {
    const result = await ctx.api.mcpRegistry.search(query, 30);
    if (!result.success) throw new Error(result.error);

    const newServers = result.servers || [];
    mcpState.registry.searchCache.set(query, newServers);

    if (JSON.stringify(newServers) !== JSON.stringify(mcpState.registry.searchResults)) {
      mcpState.registry.searchResults = newServers;
      await renderMcpRegistryCards(newServers, t('mcpRegistry.searchResults'));
    }
  } catch (e) {
    if (!cachedResults) {
      list.innerHTML = `<div class="marketplace-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }
}

async function loadMcpRegistryBrowse() {
  const list = document.getElementById('mcp-list');

  if (mcpState.registry.servers.length > 0) {
    await renderMcpRegistryCards(mcpState.registry.servers, t('mcpRegistry.available'));
  } else {
    list.innerHTML = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;
  }

  try {
    const result = await ctx.api.mcpRegistry.browse(50);
    if (!result.success) throw new Error(result.error);

    const newServers = result.servers || [];
    if (JSON.stringify(newServers) !== JSON.stringify(mcpState.registry.servers)) {
      mcpState.registry.servers = newServers;
      await renderMcpRegistryCards(newServers, t('mcpRegistry.available'));
    }
  } catch (e) {
    if (mcpState.registry.servers.length === 0) {
      list.innerHTML = `<div class="marketplace-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }
}

async function renderMcpRegistryCards(servers, sectionTitle) {
  const list = document.getElementById('mcp-list');

  await loadLocalMcpsQuiet();

  if (!servers || servers.length === 0) {
    list.innerHTML = `<div class="marketplace-empty">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
      <h3>${t('mcpRegistry.noResults')}</h3>
      <p>${t('mcpRegistry.searchHint')}</p>
    </div>`;
    return;
  }

  let html = `<div class="list-section">
    <div class="list-section-title">${escapeHtml(sectionTitle)} <span class="list-section-count">${servers.length}</span></div>
    <div class="list-section-grid">`;

  html += servers.map(server => {
    const serverName = server.name || '';
    const displayName = server.title || serverName;
    const installed = isMcpInstalled(serverName);
    const serverType = getMcpServerType(server);
    const icon = getMcpServerIcon(server);
    const description = server.description || t('mcpRegistry.noDescription');
    const cardClass = installed ? 'mcp-registry-card installed' : 'mcp-registry-card';

    return `
    <div class="${cardClass}" data-server-name="${escapeHtml(serverName)}">
      <div class="mcp-registry-card-header">
        <div class="mcp-registry-icon">${icon}</div>
        <div class="mcp-registry-card-info">
          <div class="mcp-registry-card-title">${escapeHtml(displayName)}</div>
          <div class="mcp-registry-card-desc">${escapeHtml(description)}</div>
        </div>
      </div>
      <div class="mcp-registry-card-footer">
        <div class="mcp-registry-card-badges">
          ${serverType ? `<span class="mcp-registry-badge ${serverType}">${serverType}</span>` : ''}
          ${installed ? `<span class="mcp-registry-badge installed-badge">${t('mcpRegistry.installed')}</span>` : ''}
        </div>
        <div class="mcp-registry-card-actions">
          <button class="btn-sm btn-secondary btn-mcp-details">${t('mcpRegistry.details')}</button>
          ${installed ? '' : `<button class="btn-sm btn-install btn-mcp-install">${t('mcpRegistry.install')}</button>`}
        </div>
      </div>
    </div>`;
  }).join('');

  html += `</div></div>`;
  list.innerHTML = html;
  bindMcpRegistryCardHandlers();
}

function bindMcpRegistryCardHandlers() {
  const list = document.getElementById('mcp-list');

  // Handle icon image load errors using data-fallback instead of inline onerror handlers
  list.querySelectorAll('.mcp-icon-img').forEach(img => {
    img.addEventListener('error', () => {
      if (img.parentElement) img.parentElement.textContent = img.dataset.fallback || '?';
    });
  });

  list.querySelectorAll('.mcp-registry-card').forEach(card => {
    const serverName = card.dataset.serverName;

    const detailsBtn = card.querySelector('.btn-mcp-details');
    if (detailsBtn) {
      detailsBtn.onclick = (e) => {
        e.stopPropagation();
        showMcpRegistryDetail(serverName);
      };
    }

    const installBtn = card.querySelector('.btn-mcp-install');
    if (installBtn) {
      installBtn.onclick = async (e) => {
        e.stopPropagation();
        installBtn.disabled = true;
        installBtn.textContent = t('mcpRegistry.installing');
        try {
          await installMcpFromRegistry(serverName);
          await loadMcpRegistryContent();
        } catch (err) {
          installBtn.disabled = false;
          installBtn.textContent = t('mcpRegistry.install');
          alert(`${t('mcpRegistry.installError')}: ${err.message}`);
        }
      };
    }
  });
}

async function showMcpRegistryDetail(serverName) {
  const installed = isMcpInstalled(serverName);

  let content = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;
  ctx.showModal(t('mcpRegistry.details'), content);

  try {
    const result = await ctx.api.mcpRegistry.detail(serverName);
    if (!result.success) throw new Error(result.error);
    const server = result.server;

    const displayName = server.title || server.name || serverName;
    const description = server.description || t('mcpRegistry.noDescription');
    const serverType = getMcpServerType(server);
    const icon = getMcpServerIcon(server);
    const version = server.version_detail?.version || server.version || '';

    let metaHtml = '';
    if (version) {
      metaHtml += `<div class="mcp-detail-meta-row"><span class="mcp-detail-meta-label">${t('mcpRegistry.version')}</span><span class="mcp-detail-meta-value">${escapeHtml(version)}</span></div>`;
    }
    if (serverType) {
      metaHtml += `<div class="mcp-detail-meta-row"><span class="mcp-detail-meta-label">${t('mcpRegistry.serverType')}</span><span class="mcp-detail-meta-value"><span class="mcp-registry-badge ${serverType}">${serverType}</span></span></div>`;
    }
    if (server.packages && server.packages.length > 0) {
      const pkg = server.packages[0];
      metaHtml += `<div class="mcp-detail-meta-row"><span class="mcp-detail-meta-label">${t('mcpRegistry.packages')}</span><span class="mcp-detail-meta-value">${escapeHtml(pkg.name || pkg.package_name || '')}</span></div>`;
    }
    if (server.repository && server.repository.url) {
      metaHtml += `<div class="mcp-detail-meta-row"><span class="mcp-detail-meta-label">${t('mcpRegistry.repository')}</span><span class="mcp-detail-meta-value"><a href="#" class="mcp-repo-link" data-url="${escapeHtml(server.repository.url)}" style="color: var(--accent);">${escapeHtml(server.repository.url)}</a></span></div>`;
    }

    const detailContent = `
      <div class="mcp-detail-header">
        <div class="mcp-detail-icon">${icon}</div>
        <div class="mcp-detail-info">
          <div class="mcp-detail-title">${escapeHtml(displayName)}</div>
          <div class="mcp-detail-name">${escapeHtml(serverName)}</div>
        </div>
      </div>
      <div class="mcp-detail-desc">${escapeHtml(description)}</div>
      ${metaHtml ? `<div class="mcp-detail-meta">${metaHtml}</div>` : ''}
      <div class="mcp-detail-actions">
        ${installed
          ? `<span class="mcp-registry-badge installed-badge" style="font-size: 13px; padding: 6px 16px;">${t('mcpRegistry.installed')}</span>`
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
          api.dialog.openExternal(url);
        }
      });
    }

    const installDetailBtn = document.querySelector('.btn-mcp-install-detail');
    if (installDetailBtn) {
      installDetailBtn.onclick = async () => {
        installDetailBtn.disabled = true;
        installDetailBtn.textContent = t('mcpRegistry.installing');
        try {
          await installMcpFromRegistry(serverName);
          ctx.closeModal();
          await loadMcpRegistryContent();
        } catch (err) {
          installDetailBtn.disabled = false;
          installDetailBtn.textContent = t('mcpRegistry.install');
          alert(`${t('mcpRegistry.installError')}: ${err.message}`);
        }
      };
    }
  } catch (e) {
    document.getElementById('modal-body').innerHTML = `<div class="marketplace-empty"><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

async function installMcpFromRegistry(serverName) {
  const result = await ctx.api.mcpRegistry.detail(serverName);
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
    const formResult = await showMcpEnvForm(server, envVarsSpec, argsSpec);
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

  await saveMcpToConfig(serverName, mcpConfig);
  await loadLocalMcpsQuiet();

  if (ctx.showToast) {
    ctx.showToast({ type: 'success', title: t('mcpRegistry.installSuccess', { name: server.title || serverName }) });
  }
}

function showMcpEnvForm(server, envVarsSpec, argsSpec) {
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

    ctx.showModal(t('mcpRegistry.configureServer') + ' - ' + escapeHtml(displayName), content, footer);

    document.getElementById('mcp-env-cancel').onclick = () => {
      ctx.closeModal();
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

      ctx.closeModal();
      resolve({ env, args });
    };
  });
}

async function saveMcpToConfig(serverName, mcpConfig) {
  try {
    let config = {};
    if (ctx.fs.existsSync(ctx.claudeConfigFile)) {
      config = JSON.parse(await ctx.fs.promises.readFile(ctx.claudeConfigFile, 'utf8'));
    }
    if (!config.mcpServers) {
      config.mcpServers = {};
    }
    config.mcpServers[serverName] = mcpConfig;
    ctx.fs.writeFileSync(ctx.claudeConfigFile, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving MCP to config:', e);
    throw new Error('Failed to save configuration: ' + e.message);
  }
}

async function loadLocalMcpsQuiet() {
  mcpState.mcps = [];
  try {
    if (ctx.fs.existsSync(ctx.claudeConfigFile)) {
      const config = JSON.parse(await ctx.fs.promises.readFile(ctx.claudeConfigFile, 'utf8'));
      if (config.mcpServers) {
        Object.entries(config.mcpServers).forEach(([name, mcpConfig]) => {
          mcpState.mcps.push({ id: `global-${name}`, name, command: mcpConfig.command || '', args: mcpConfig.args || [], env: mcpConfig.env || {}, source: 'global', sourceLabel: 'Global' });
        });
      }
    }
  } catch { /* ignore */ }
  try {
    if (ctx.fs.existsSync(ctx.claudeSettingsFile)) {
      const settings = JSON.parse(await ctx.fs.promises.readFile(ctx.claudeSettingsFile, 'utf8'));
      if (settings.mcpServers) {
        Object.entries(settings.mcpServers).forEach(([name, config]) => {
          if (!mcpState.mcps.find(m => m.name === name)) {
            mcpState.mcps.push({ id: `global-${name}`, name, command: config.command || '', args: config.args || [], env: config.env || {}, source: 'global', sourceLabel: 'Global' });
          }
        });
      }
    }
  } catch { /* ignore */ }
}

module.exports = { init, loadMcps };
