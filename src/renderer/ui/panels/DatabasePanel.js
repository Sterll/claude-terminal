/**
 * DatabasePanel
 * Database connections management, schema viewer, query editor
 * + MCP auto-provisioning for Claude chat integration
 */

const { escapeHtml } = require('../../utils');
const { highlight } = require('../../utils/syntaxHighlight');
const { t } = require('../../i18n');
const { showConfirm, createModal, showModal, closeModal } = require('../components/Modal');

/**
 * Escape a SQL identifier (table/column name).
 * PostgreSQL and SQLite use double quotes; MySQL uses backticks.
 */
function escapeIdentifier(name, dbType) {
  if (dbType === 'mysql' || dbType === 'mariadb') {
    return '`' + String(name).replace(/`/g, '``') + '`';
  }
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * Escape a value for safe inclusion in a SQL string literal.
 * Returns the SQL representation: 'escaped_value' or NULL.
 */
function escapeSqlValue(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number' && Number.isFinite(val)) return String(val);
  return `'${String(val).replace(/'/g, "''")}'`;
}

let ctx = null;

// ==================== Redis Tree Builder ====================

function buildRedisTree(keys, filter = '') {
  const root = { children: new Map(), keys: [], keyCount: 0 };
  const filtered = filter
    ? keys.filter(k => k.toLowerCase().includes(filter.toLowerCase()))
    : keys;

  for (const key of filtered) {
    const parts = key.split(':');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.children.has(parts[i])) {
        node.children.set(parts[i], { children: new Map(), keys: [], keyCount: 0 });
      }
      node = node.children.get(parts[i]);
    }
    node.keys.push(key);
  }

  (function count(n) {
    let c = n.keys.length;
    for (const child of n.children.values()) c += count(child);
    return (n.keyCount = c);
  })(root);

  return root;
}

function formatTtl(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

// ==================== Autocomplete Index ====================
let autocompleteIndex = null; // { tables: string[], columnsByTable: {}, allColumns: string[], sqlKeywords: string[] }

let panelState = {
  initialized: false,
  activeSubTab: 'connections', // 'connections' | 'schema' | 'query'
  expandedTables: new Set(),
  queryRunning: false,
  allowDestructive: false,
  historyExpanded: false,
  autocomplete: null, // { suggestions, selectedIndex, left, top, partial, partialStart }
  // Data browser state
  browserSelectedTable: null,
  browserTableFilter: '',
  browserData: null,       // { columns, rows, totalCount }
  browserPage: 0,
  browserPageSize: 50,
  browserLoading: false,
  browserSortCol: null,
  browserSortDir: 'ASC',
  browserEditingCell: null, // { row, col, original }
  browserPendingEdits: new Map(), // rowIdx -> { col: newVal }
  browserSearchTerm: '',
  browserSearchDebounce: null,
  _blurCommitTimer: null, // Timer ID for pending blur commit
  browserTableRowCounts: {},  // { tableName: number }
  browserColumnWidths: {},    // { tableName: { colName: widthPx } }
  queryResultColumnWidths: {}, // { colName: widthPx }
  browserSelectedRows: new Set(),
  browserLastSelectedRow: null,
  browserSidebarWidth: 240,
  explainResult: null,         // { dbType, rawResult, sql }
  tabStates: {},               // { [tabId]: { queryRunning, explainResult, queryResultColumnWidths } }
  // Redis tree view state
  redisTreeKeys: null,              // string[] — all key names for current db
  redisTreeFilter: '',              // search filter for tree
  redisExpandedFolders: new Set(),  // expanded folder paths (e.g. "user", "user:123")
  redisSelectedKey: null,           // full key name of selected leaf
  redisKeyInfo: null,               // { key, type, ttl, pttl, size, length, value }
  redisKeyInfoLoading: false,
  redisTreeLoading: false,
};

function init(context) {
  ctx = context;
}

// ==================== Main Entry ====================

async function loadPanel() {
  if (!panelState.initialized) {
    panelState.initialized = true;
    setupSubTabs();
    setupHeaderButtons();
  }

  // Load persisted history & saved queries
  const state = require('../../state');
  state.loadDatabasePersistence();

  // Load connections from disk on first visit
  if (state.getDatabaseConnections().length === 0) {
    try {
      const connections = await ctx.api.database.loadConnections();
      if (connections && connections.length > 0) {
        state.setDatabaseConnections(connections);
      }
    } catch (e) { /* ignore */ }
  }

  renderContent();
}

// ==================== Sub-tab Setup ====================

function setupSubTabs() {
  document.querySelectorAll('.database-sub-tab').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.database-sub-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      panelState.activeSubTab = btn.dataset.subtab;
      renderContent();
    };
  });
}

function setupHeaderButtons() {
  const addBtn = document.getElementById('database-add-btn');
  if (addBtn) addBtn.onclick = () => showConnectionForm();

  const detectBtn = document.getElementById('database-detect-btn');
  if (detectBtn) detectBtn.onclick = () => runAutoDetect();

  // Database picker — custom dropdown
  const trigger = document.getElementById('database-picker-trigger');
  if (trigger) {
    trigger.onclick = (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById('database-picker-dropdown');
      if (!dropdown) return;
      const isOpen = dropdown.classList.contains('open');
      dropdown.classList.toggle('open', !isOpen);
      if (!isOpen) {
        // Close on outside click
        const close = () => { dropdown.classList.remove('open'); document.removeEventListener('click', close); };
        setTimeout(() => document.addEventListener('click', close), 0);
      }
    };
  }
}

function switchToSubTab(name) {
  document.querySelectorAll('.database-sub-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.subtab === name);
  });
  panelState.activeSubTab = name;
  renderContent();
}

// ==================== Render Router ====================

function renderContent() {
  const container = document.getElementById('database-content');
  if (!container) return;

  updateDatabasePicker();

  switch (panelState.activeSubTab) {
    case 'connections': renderConnections(container); break;
    case 'schema': renderSchema(container); break;
    case 'query': renderQuery(container); break;
  }
}

function updateDatabasePicker() {
  const picker = document.getElementById('database-picker');
  const trigger = document.getElementById('database-picker-trigger');
  const dropdown = document.getElementById('database-picker-dropdown');
  if (!picker || !trigger || !dropdown) return;

  const state = require('../../state');
  const connections = state.getDatabaseConnections();
  const activeId = state.getActiveConnection();
  const showPicker = panelState.activeSubTab !== 'connections' && connections.length > 0;

  picker.style.display = showPicker ? '' : 'none';
  if (!showPicker) return;

  // Update trigger label
  const activeConn = activeId ? connections.find(c => c.id === activeId) : null;
  const activeStatus = activeId ? state.getConnectionStatus(activeId) : '';
  if (activeConn) {
    const dotHtml = activeStatus === 'connected' ? '<span class="database-picker-dot connected"></span>' :
                    activeStatus === 'connecting' ? '<span class="database-picker-dot connecting"></span>' :
                    activeStatus === 'error' ? '<span class="database-picker-dot error"></span>' : '';
    trigger.innerHTML = `${dotHtml}<span class="database-picker-type">${escapeHtml(activeConn.type.toUpperCase())}</span><span class="database-picker-name">${escapeHtml(activeConn.name || activeConn.database || activeConn.filePath || activeConn.id)}</span><svg class="database-picker-chevron" viewBox="0 0 10 6" width="10" height="6"><path d="M0 0l5 6 5-6z" fill="currentColor"/></svg>`;
  } else {
    trigger.innerHTML = `<span class="database-picker-name" style="opacity:0.5">${t('database.noActiveConnection')}</span><svg class="database-picker-chevron" viewBox="0 0 10 6" width="10" height="6"><path d="M0 0l5 6 5-6z" fill="currentColor"/></svg>`;
  }

  // Build dropdown items (only if changed)
  const optionsKey = connections.map(c => `${c.id}:${state.getConnectionStatus(c.id)}`).join(',') + '|' + (activeId || '');
  if (dropdown._lastKey === optionsKey) return;
  dropdown._lastKey = optionsKey;

  dropdown.innerHTML = connections.map(c => {
    const status = state.getConnectionStatus(c.id);
    const isActive = c.id === activeId;
    const dotCls = status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : status === 'error' ? 'error' : '';
    return `<div class="database-picker-item ${isActive ? 'active' : ''}" data-id="${escapeHtml(c.id)}">
      ${dotCls ? `<span class="database-picker-dot ${dotCls}"></span>` : '<span class="database-picker-dot-placeholder"></span>'}
      <span class="database-picker-item-type">${escapeHtml(c.type.toUpperCase())}</span>
      <span class="database-picker-item-name">${escapeHtml(c.name || c.database || c.filePath || c.id)}</span>
    </div>`;
  }).join('');

  // Bind click events on items
  dropdown.querySelectorAll('.database-picker-item').forEach(item => {
    item.onclick = async (e) => {
      e.stopPropagation();
      dropdown.classList.remove('open');
      const id = item.dataset.id;
      if (id === activeId && state.getConnectionStatus(id) === 'connected') return;
      await connectDatabase(id);
      renderContent();
    };
  });
}

// ==================== Connections Tab ====================

function renderConnections(container) {
  const state = require('../../state');
  const connections = state.getDatabaseConnections();
  const detected = state.getDetectedDatabases();

  if (connections.length === 0 && detected.length === 0) {
    container.innerHTML = `
      <div class="database-empty-state">
        <div class="database-empty-icon">
          <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48">
            <path d="M12 3C7.58 3 4 4.79 4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7c0-2.21-3.58-4-8-4zm6 14c0 .5-2.13 2-6 2s-6-1.5-6-2v-2.23c1.61.78 3.72 1.23 6 1.23s4.39-.45 6-1.23V17zm0-5c0 .5-2.13 2-6 2s-6-1.5-6-2V9.77C7.61 10.55 9.72 11 12 11s4.39-.45 6-1.23V12zm-6-3c-3.87 0-6-1.5-6-2s2.13-2 6-2 6 1.5 6 2-2.13 2-6 2z"/>
          </svg>
        </div>
        <div class="database-empty-text">${t('database.noConnections')}</div>
        <div class="database-empty-hint">${t('database.noConnectionsHint')}</div>
      </div>`;
    return;
  }

  let html = '';

  // Detected databases
  if (detected.length > 0) {
    html += `<div class="database-section-label">${t('database.detectedDatabases', { count: detected.length })}</div>`;
    for (const d of detected) {
      html += buildDetectedCard(d);
    }
  }

  // Saved connections
  if (connections.length > 0) {
    if (detected.length > 0) {
      html += `<div class="database-section-label">${t('database.connections')}</div>`;
    }
    for (const conn of connections) {
      html += buildConnectionCard(conn, state.getConnectionStatus(conn.id));
    }
  }

  container.innerHTML = html;
  bindConnectionEvents(container);
}

function buildConnectionCard(conn, status) {
  const state = require('../../state');
  const active = state.getActiveConnection() === conn.id;
  const projectName = conn.projectId ? getProjectName(conn.projectId) : '';

  // Status dot: green=connected, orange=connecting, red=error, nothing=disconnected
  const dotClass = status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : status === 'error' ? 'error' : '';

  return `
    <div class="database-card ${active ? 'selected' : ''} ${status === 'connecting' ? 'connecting' : ''}" data-id="${escapeHtml(conn.id)}">
      <div class="database-card-header">
        <div class="database-card-title-row">
          ${dotClass ? `<span class="database-status-dot ${dotClass}"></span>` : ''}
          <span class="database-type-badge ${conn.type}">${escapeHtml(conn.type.toUpperCase())}</span>
          <span class="database-card-title">${escapeHtml(conn.name || conn.id)}</span>
        </div>
        <div class="database-card-actions">
          <button class="btn-database" data-action="edit" data-id="${escapeHtml(conn.id)}" title="${t('database.editConnection')}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          </button>
          <button class="btn-database danger" data-action="delete" data-id="${escapeHtml(conn.id)}" title="${t('database.deleteConnection')}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </div>
      </div>
      <div class="database-card-info">
        ${conn.type === 'sqlite' ? escapeHtml(conn.filePath || '') :
          conn.type === 'mongodb' ? escapeHtml(conn.connectionString ? conn.connectionString.replace(/\/\/[^@]+@/, '//***@') : `${conn.host}:${conn.port}`) :
          escapeHtml(`${conn.host || 'localhost'}:${conn.port || ''} / ${conn.database || ''}`)}
        ${projectName ? ` <span class="database-card-project">${escapeHtml(projectName)}</span>` : ''}
      </div>
    </div>`;
}

function buildDetectedCard(d) {
  return `
    <div class="database-card detected">
      <div class="database-card-header">
        <div class="database-card-title-row">
          <span class="database-type-badge ${d.type}">${escapeHtml(d.type.toUpperCase())}</span>
          <span class="database-card-title">${escapeHtml(d.name || d.type)}</span>
        </div>
        <span class="database-detected-source">${escapeHtml(d.detectedFrom || '')}</span>
      </div>
      <div class="database-card-info">
        ${d.type === 'sqlite' ? escapeHtml(d.filePath || '') :
          d.connectionString ? escapeHtml(d.connectionString.replace(/\/\/[^@]+@/, '//***@')) :
          escapeHtml(`${d.host || ''}:${d.port || ''} / ${d.database || ''}`)}
      </div>
      <div class="database-card-actions">
        <button class="btn-database primary" data-action="import-detected" data-detected='${escapeHtml(JSON.stringify(d))}' title="${t('database.import')}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          <span style="margin-left:4px;font-size:11px">${t('database.import')}</span>
        </button>
      </div>
    </div>`;
}

function bindConnectionEvents(container) {
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      switch (action) {
        case 'edit': showConnectionForm(id); break;
        case 'delete': await deleteConnection(id); break;
        case 'import-detected': importDetected(btn.dataset.detected); break;
      }
    };
  });

  // Click card to select + auto-connect
  container.querySelectorAll('.database-card:not(.detected)').forEach(card => {
    card.onclick = async () => {
      const id = card.dataset.id;
      const state = require('../../state');
      const currentStatus = state.getConnectionStatus(id);

      // Already connected and active → switch to schema
      if (currentStatus === 'connected' && state.getActiveConnection() === id) {
        switchToSubTab('schema');
        return;
      }

      // Auto-connect (connectDatabase handles disconnecting the previous one)
      await connectDatabase(id);

      // If connection succeeded, switch to schema
      if (state.getConnectionStatus(id) === 'connected') {
        switchToSubTab('schema');
      }
    };
  });
}

// ==================== Schema / Data Browser Tab ====================

function renderSchema(container) {
  const state = require('../../state');
  const activeId = state.getActiveConnection();

  if (!activeId || state.getConnectionStatus(activeId) !== 'connected') {
    container.innerHTML = `<div class="database-empty-state"><div class="database-empty-text">${t('database.noActiveConnection')}</div></div>`;
    return;
  }

  const schema = state.getDatabaseSchema(activeId);
  if (!schema) {
    loadSchema(activeId);
    container.innerHTML = `<div class="database-empty-state">
      <div class="database-empty-icon">
        <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M12 3C7.58 3 4 4.79 4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7c0-2.21-3.58-4-8-4zm6 14c0 .5-2.13 2-6 2s-6-1.5-6-2v-2.23c1.61.78 3.72 1.23 6 1.23s4.39-.45 6-1.23V17zm0-5c0 .5-2.13 2-6 2s-6-1.5-6-2V9.77C7.61 10.55 9.72 11 12 11s4.39-.45 6-1.23V12zm-6-3c-3.87 0-6-1.5-6-2s2.13-2 6-2 6 1.5 6 2-2.13 2-6 2z"/></svg>
      </div>
      <div class="database-empty-text">${t('database.detecting')}</div>
    </div>`;
    return;
  }

  const conn = state.getDatabaseConnection(activeId);
  const isMongo = conn && conn.type === 'mongodb';
  const isRedis = conn && conn.type === 'redis';
  const tableLabel = isRedis ? t('database.databases') : (isMongo ? t('database.collections') : t('database.tables'));
  const columnLabel = isMongo ? t('database.fields') : t('database.columns');

  if (!schema.tables || schema.tables.length === 0) {
    container.innerHTML = `<div class="database-empty-state"><div class="database-empty-text">${t('database.noTables')}</div></div>`;
    return;
  }

  // Filter tables
  const filter = panelState.browserTableFilter.toLowerCase();
  const filteredTables = filter
    ? schema.tables.filter(t => t.name.toLowerCase().includes(filter))
    : schema.tables;

  const selectedTable = panelState.browserSelectedTable;
  const selectedMeta = selectedTable ? schema.tables.find(t => t.name === selectedTable) : null;

  container.innerHTML = `
    <div class="db-browser">
      <div class="db-browser-sidebar" style="width:${panelState.browserSidebarWidth}px">
        <div class="db-browser-search">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <input type="text" class="db-browser-search-input" id="db-browser-filter" placeholder="${tableLabel}..." value="${escapeHtml(panelState.browserTableFilter)}">
          <span class="db-browser-count">${filteredTables.length}</span>
        </div>
        <div class="db-browser-table-list" id="db-browser-table-list">
          ${filteredTables.map(table => {
            const rc = panelState.browserTableRowCounts[table.name];
            const rcBadge = rc !== undefined ? `<span class="db-browser-table-rows" title="${rc} rows">${formatRowCount(rc)}</span>` : '';
            const icon = isRedis
              ? '<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13" class="db-browser-table-icon"><path d="M12 3C7.58 3 4 4.79 4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7c0-2.21-3.58-4-8-4zm6 14c0 .5-2.13 2-6 2s-6-1.5-6-2v-2.23c1.61.78 3.72 1.23 6 1.23s4.39-.45 6-1.23V17zm0-5c0 .5-2.13 2-6 2s-6-1.5-6-2V9.77C7.61 10.55 9.72 11 12 11s4.39-.45 6-1.23V12zm-6-3c-3.87 0-6-1.5-6-2s2.13-2 6-2 6 1.5 6 2-2.13 2-6 2z"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13" class="db-browser-table-icon"><path d="M3 3h18v18H3V3zm2 4v4h6V7H5zm8 0v4h6V7h-6zm-8 6v4h6v-4H5zm8 0v4h6v-4h-6z"/></svg>';
            return `
            <div class="db-browser-table-item ${table.name === selectedTable ? 'active' : ''}" data-table="${escapeHtml(table.name)}">
              ${icon}
              <span class="db-browser-table-name">${escapeHtml(table.name)}</span>
              ${rcBadge}
              ${isRedis ? '' : `<span class="db-browser-table-cols">${table.columns.length}</span>`}
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="db-browser-resize-handle"></div>
      <div class="db-browser-main">
        ${isRedis
          ? (selectedTable ? renderRedisBrowserPanel(selectedTable) : renderBrowserEmptyState(tableLabel))
          : (selectedTable && selectedMeta ? renderBrowserDataPanel(selectedTable, selectedMeta, isMongo, columnLabel) : renderBrowserEmptyState(tableLabel))}
      </div>
    </div>`;

  bindBrowserEvents(container);
}

// ==================== Redis Tree Browser ====================

function renderRedisBrowserPanel(dbName) {
  const treeKeys = panelState.redisTreeKeys;
  const loading = panelState.redisTreeLoading;
  const filter = panelState.redisTreeFilter;
  const selectedKey = panelState.redisSelectedKey;
  const keyInfo = panelState.redisKeyInfo;
  const keyInfoLoading = panelState.redisKeyInfoLoading;

  let treeHtml = '';
  if (loading) {
    treeHtml = `<div class="redis-tree-loading"><div class="db-browser-spinner"></div>${t('database.redisLoadingKeys')}</div>`;
  } else if (!treeKeys) {
    treeHtml = `<div class="redis-tree-empty">${t('database.redisNoKeys')}</div>`;
  } else if (treeKeys.length === 0) {
    treeHtml = `<div class="redis-tree-empty">${t('database.redisNoKeys')}</div>`;
  } else {
    const tree = buildRedisTree(treeKeys, filter);
    treeHtml = renderRedisTreeNodes(tree, '', panelState.redisExpandedFolders, selectedKey);
  }

  let detailHtml = '';
  if (keyInfoLoading) {
    detailHtml = `<div class="redis-detail-loading"><div class="db-browser-spinner"></div>${t('database.redisLoadingKey')}</div>`;
  } else if (!selectedKey) {
    detailHtml = `<div class="redis-detail-empty">
      <svg viewBox="0 0 24 24" fill="currentColor" width="40" height="40" style="opacity:0.3"><path d="M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1z"/></svg>
      <span>${t('database.redisSelectKey')}</span>
    </div>`;
  } else if (keyInfo) {
    detailHtml = renderRedisKeyDetail(keyInfo);
  }

  const filteredCount = filter && treeKeys
    ? treeKeys.filter(k => k.toLowerCase().includes(filter.toLowerCase())).length
    : (treeKeys ? treeKeys.length : 0);

  return `
    <div class="redis-browser">
      <div class="redis-tree-panel">
        <div class="redis-tree-header">
          <div class="redis-tree-search">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
            <input type="text" class="redis-tree-search-input" id="redis-tree-filter" placeholder="${t('database.redisFilterKeys')}" value="${escapeHtml(filter)}">
            <span class="redis-tree-count">${filteredCount}</span>
          </div>
          <button class="db-browser-btn" id="redis-tree-refresh" title="${t('database.redisRefreshKeys')}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
          </button>
        </div>
        <div class="redis-tree-list" id="redis-tree-list">
          ${treeHtml}
        </div>
      </div>
      <div class="redis-detail-panel" id="redis-detail-panel">
        ${detailHtml}
      </div>
    </div>`;
}

function renderRedisTreeNodes(node, pathPrefix, expandedFolders, selectedKey) {
  let html = '';
  const sortedChildren = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const sortedKeys = [...node.keys].sort();

  for (const [name, childNode] of sortedChildren) {
    const folderPath = pathPrefix ? `${pathPrefix}:${name}` : name;
    const isExpanded = expandedFolders.has(folderPath);
    const childHtml = isExpanded ? renderRedisTreeNodes(childNode, folderPath, expandedFolders, selectedKey) : '';
    html += `
      <div class="redis-tree-folder ${isExpanded ? 'expanded' : ''}">
        <div class="redis-tree-folder-header" data-folder-toggle="${escapeHtml(folderPath)}">
          <svg class="redis-tree-chevron" viewBox="0 0 10 10" width="10" height="10">
            <path d="${isExpanded ? 'M1 3l4 4 4-4' : 'M3 1l4 4-4 4'}" fill="none" stroke="currentColor" stroke-width="1.5"/>
          </svg>
          <svg class="redis-tree-folder-icon" viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
            <path d="${isExpanded
              ? 'M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z'
              : 'M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z'}"/>
          </svg>
          <span class="redis-tree-folder-name">${escapeHtml(name)}</span>
          <span class="redis-tree-folder-count">${childNode.keyCount}</span>
        </div>
        <div class="redis-tree-folder-children" ${isExpanded ? '' : 'style="display:none"'}>
          ${childHtml}
        </div>
      </div>`;
  }

  for (const key of sortedKeys) {
    const leafName = key.split(':').pop();
    const isSelected = key === selectedKey;
    html += `
      <div class="redis-tree-key ${isSelected ? 'active' : ''}" data-redis-key="${escapeHtml(key)}">
        <svg class="redis-tree-key-icon" viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
          <path d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h3v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/>
        </svg>
        <span class="redis-tree-key-name">${escapeHtml(leafName)}</span>
      </div>`;
  }
  return html;
}

function renderRedisKeyDetail(info) {
  const { key, type, ttl, size, length, value } = info;
  const ttlDisplay = ttl === null ? t('database.redisNoExpiry') : `${ttl}s (${formatTtl(ttl)})`;

  let valueHtml = '';
  try {
    if (type === 'string') {
      let formatted = value, isJson = false;
      try { formatted = JSON.stringify(JSON.parse(value), null, 2); isJson = true; } catch {}
      valueHtml = `<pre class="redis-value-pre ${isJson ? 'json' : ''}">${escapeHtml(formatted || '')}</pre>`;
    } else if (type === 'hash') {
      const entries = typeof value === 'string' ? JSON.parse(value) : (value || {});
      const pairs = Object.entries(entries);
      valueHtml = `<div class="redis-value-table-wrapper"><table class="redis-value-table">
        <thead><tr><th>${t('database.redisField')}</th><th>${t('database.redisValue')}</th></tr></thead>
        <tbody>${pairs.map(([f, v]) => `<tr><td class="redis-field-name">${escapeHtml(f)}</td><td>${escapeHtml(String(v))}</td></tr>`).join('')}</tbody>
      </table></div>`;
    } else if (type === 'list') {
      const items = typeof value === 'string' ? JSON.parse(value) : (value || []);
      valueHtml = `<div class="redis-value-table-wrapper"><table class="redis-value-table">
        <thead><tr><th>#</th><th>${t('database.redisValue')}</th></tr></thead>
        <tbody>${items.map((v, i) => `<tr><td class="redis-list-index">${i}</td><td>${escapeHtml(String(v))}</td></tr>`).join('')}</tbody>
      </table></div>`;
    } else if (type === 'set') {
      const members = typeof value === 'string' ? JSON.parse(value) : (value || []);
      valueHtml = `<div class="redis-value-table-wrapper"><table class="redis-value-table">
        <thead><tr><th>${t('database.redisMember')}</th></tr></thead>
        <tbody>${members.map(m => `<tr><td>${escapeHtml(String(m))}</td></tr>`).join('')}</tbody>
      </table></div>`;
    } else if (type === 'zset') {
      const arr = typeof value === 'string' ? JSON.parse(value) : (value || []);
      const pairs = [];
      for (let i = 0; i < arr.length; i += 2) pairs.push({ member: arr[i], score: arr[i + 1] });
      valueHtml = `<div class="redis-value-table-wrapper"><table class="redis-value-table">
        <thead><tr><th>${t('database.redisScore')}</th><th>${t('database.redisMember')}</th></tr></thead>
        <tbody>${pairs.map(p => `<tr><td class="redis-zset-score">${escapeHtml(String(p.score))}</td><td>${escapeHtml(String(p.member))}</td></tr>`).join('')}</tbody>
      </table></div>`;
    } else {
      valueHtml = `<pre class="redis-value-pre">${escapeHtml(String(value || ''))}</pre>`;
    }
  } catch {
    valueHtml = `<pre class="redis-value-pre">${escapeHtml(String(value || ''))}</pre>`;
  }

  return `
    <div class="redis-detail">
      <div class="redis-detail-header">
        <div class="redis-detail-key-row">
          <span class="redis-detail-key-name" title="${escapeHtml(key)}">${escapeHtml(key)}</span>
          <span class="redis-type-badge ${type}">${type.toUpperCase()}</span>
        </div>
        <div class="redis-detail-meta">
          <span class="redis-detail-ttl">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            ${escapeHtml(ttlDisplay)}
          </span>
          ${size !== null && size !== undefined ? `<span class="redis-detail-size">${t('database.redisBytes', { count: size })}</span>` : ''}
          ${length !== null && length !== undefined ? `<span class="redis-detail-length">${t('database.redisItems', { count: length })}</span>` : ''}
        </div>
      </div>
      <div class="redis-detail-value">
        ${valueHtml}
      </div>
    </div>`;
}

function renderBrowserEmptyState(tableLabel) {
  return `
    <div class="db-browser-empty">
      <svg viewBox="0 0 24 24" fill="currentColor" width="40" height="40"><path d="M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z"/></svg>
      <span>${t('database.selectTable')}</span>
    </div>`;
}

function renderBrowserDataPanel(tableName, tableMeta, isMongo, columnLabel) {
  const data = panelState.browserData;
  const loading = panelState.browserLoading;
  const page = panelState.browserPage;
  const pageSize = panelState.browserPageSize;
  const sortCol = panelState.browserSortCol;
  const sortDir = panelState.browserSortDir;

  // Column info strip
  const colsHtml = tableMeta.columns.map(col => {
    const pkClass = col.primaryKey ? ' pk' : '';
    const fkClass = col.foreignKey ? ' fk' : '';
    const fkTitle = col.foreignKey ? ` FK \u2192 ${col.foreignKey.table}(${col.foreignKey.column})` : '';
    return `<span class="db-col-chip${pkClass}${fkClass}" title="${escapeHtml(col.type)}${col.primaryKey ? ' (PK)' : ''}${col.nullable ? ' NULL' : ''}${fkTitle}">
      ${col.primaryKey ? '<span class="db-col-pk">PK</span>' : ''}
      ${col.foreignKey ? `<span class="db-col-fk">FK</span>` : ''}
      ${escapeHtml(col.name)}
      <span class="db-col-type">${escapeHtml(col.type)}</span>
      ${col.foreignKey ? `<span class="db-col-fk-ref" data-fk-table="${escapeHtml(col.foreignKey.table)}">\u2192 ${escapeHtml(col.foreignKey.table)}</span>` : ''}
    </span>`;
  }).join('');

  // Data grid
  let gridHtml = '';
  if (loading) {
    gridHtml = `<div class="db-browser-loading"><div class="db-browser-spinner"></div>${t('database.browserLoading')}</div>`;
  } else if (!data || !data.rows) {
    gridHtml = `<div class="db-browser-loading">${t('database.browserClickLoad')}</div>`;
  } else if (data.rows.length === 0) {
    gridHtml = `<div class="db-browser-loading">${t('database.browserNoRows')}</div>`;
  } else {
    const cols = data.columns || [];
    const selAll = panelState.browserSelectedRows.size > 0 && panelState.browserSelectedRows.size === data.rows.length;
    const selSome = panelState.browserSelectedRows.size > 0 && !selAll;
    gridHtml = `
      <div class="db-grid-wrapper">
        <table class="db-grid">
          <thead><tr>
            <th class="db-grid-checkbox-col"><input type="checkbox" class="db-grid-select-all" id="db-grid-select-all" ${selAll ? 'checked' : ''} ${selSome ? 'data-indeterminate' : ''}></th>
            <th class="db-grid-row-num">#</th>
            ${(() => {
              const storedWidths = panelState.browserColumnWidths[tableName] || {};
              return cols.map(col => {
                const isSorted = sortCol === col;
                const arrow = isSorted ? (sortDir === 'ASC' ? ' &#9650;' : ' &#9660;') : '';
                const w = storedWidths[col];
                const widthStyle = w ? ` style="width:${w}px;min-width:${w}px"` : '';
                return `<th class="db-grid-th ${isSorted ? 'sorted' : ''}" data-col="${escapeHtml(col)}"${widthStyle}>${escapeHtml(col)}${arrow}<div class="db-grid-resize-handle" data-resize-col="${escapeHtml(col)}"></div></th>`;
              }).join('');
            })()}
          </tr></thead>
          <tbody>
            ${data.rows.map((row, ri) => {
              const globalIdx = page * pageSize + ri + 1;
              const isSelected = panelState.browserSelectedRows.has(ri);
              return `<tr data-row="${ri}" class="${isSelected ? 'selected' : ''}">
                <td class="db-grid-checkbox-col"><input type="checkbox" class="db-grid-row-checkbox" data-row="${ri}" ${isSelected ? 'checked' : ''}></td>
                <td class="db-grid-row-num"><span class="db-grid-row-idx">${globalIdx}</span><button class="db-grid-row-delete" data-row="${ri}" title="${t('database.browserDeleteRow')}"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button></td>
                ${cols.map(col => {
                  const val = row[col];
                  const isNull = val === null || val === undefined;
                  const displayVal = isNull ? 'NULL' : escapeHtml(String(val));
                  const cellClass = isNull ? 'db-grid-cell null' : 'db-grid-cell';
                  const isEditing = panelState.browserEditingCell && panelState.browserEditingCell.row === ri && panelState.browserEditingCell.col === col;
                  if (isEditing) {
                    return `<td class="db-grid-cell editing"><input class="db-grid-edit-input" data-row="${ri}" data-col="${escapeHtml(col)}" value="${isNull ? '' : escapeHtml(String(val))}" autofocus></td>`;
                  }
                  return `<td class="${cellClass}" data-row="${ri}" data-col="${escapeHtml(col)}">${displayVal}<button class="db-cell-expand-btn" data-expand-row="${ri}" data-expand-col="${escapeHtml(col)}" title="${t('database.cellExpand')}"><svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10"><path d="M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z"/></svg></button></td>`;
                }).join('')}
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // Pagination
  const totalCount = data ? (data.totalCount || data.rows?.length || 0) : 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const rowsShown = data && data.rows ? data.rows.length : 0;
  const fromRow = rowsShown > 0 ? page * pageSize + 1 : 0;
  const toRow = fromRow + rowsShown - 1;

  const searchTerm = panelState.browserSearchTerm;

  return `
    <div class="db-browser-panel">
      <div class="db-browser-toolbar">
        <div class="db-browser-toolbar-left">
          <span class="db-browser-table-title">${escapeHtml(tableName)}</span>
          <span class="db-browser-row-info">${totalCount > 0 ? `${fromRow}-${toRow} / ${totalCount}` : ''}</span>
          ${panelState.browserSelectedRows.size > 0 ? `
            <span class="db-browser-selection-badge">${panelState.browserSelectedRows.size} ${t('database.selected')}</span>
            <button class="db-browser-btn" id="db-browser-delete-selected" title="${t('database.deleteSelected')}">
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>` : ''}
        </div>
        <div class="db-browser-toolbar-search">
          <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <input type="text" class="db-browser-toolbar-search-input" id="db-browser-search" placeholder="${t('database.browserSearchPlaceholder')}" value="${escapeHtml(searchTerm)}">
          ${searchTerm ? `<button class="db-browser-toolbar-search-clear" id="db-browser-search-clear" title="${t('database.browserSearchClear')}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>` : ''}
        </div>
        <div class="db-browser-toolbar-right">
          <button class="db-browser-btn" id="db-browser-refresh" title="${t('database.browserRefresh')}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
          </button>
          <button class="db-browser-btn" id="db-browser-add-row" title="${t('database.browserAddRow')}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          </button>
          <div class="db-export-wrap">
            <button class="db-browser-btn" id="db-browser-export" title="${t('database.export')}">
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            </button>
            <div class="db-export-menu" id="db-browser-export-menu">
              <button class="db-export-option" data-browser-export="csv">CSV</button>
              <button class="db-export-option" data-browser-export="json">JSON</button>
            </div>
          </div>
          <div class="db-browser-pagination">
            <button class="db-browser-btn" id="db-browser-prev" ${page <= 0 ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
            </button>
            <span class="db-browser-page-info">${page + 1} / ${totalPages}</span>
            <button class="db-browser-btn" id="db-browser-next" ${page >= totalPages - 1 ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="db-browser-columns-strip">${colsHtml}</div>
      <div class="db-browser-grid-container">${gridHtml}</div>
    </div>`;
}

function bindBrowserEvents(container) {
  // Table filter
  const filterInput = container.querySelector('#db-browser-filter');
  if (filterInput) {
    filterInput.oninput = () => {
      panelState.browserTableFilter = filterInput.value;
      renderContent();
      // Re-focus input after re-render
      setTimeout(() => {
        const input = document.querySelector('#db-browser-filter');
        if (input) { input.focus(); input.selectionStart = input.selectionEnd = input.value.length; }
      }, 0);
    };
  }

  // Table selection
  container.querySelectorAll('.db-browser-table-item').forEach(item => {
    item.onclick = () => {
      const tableName = item.dataset.table;
      if (panelState.browserSelectedTable !== tableName) {
        panelState.browserSelectedTable = tableName;
        panelState.browserPage = 0;
        panelState.browserSortCol = null;
        panelState.browserSortDir = 'ASC';
        panelState.browserData = null;
        panelState.browserEditingCell = null;
        panelState.browserPendingEdits.clear();
        panelState.browserSearchTerm = '';
        panelState.browserSelectedRows = new Set();
        panelState.browserLastSelectedRow = null;

        const state2 = require('../../state');
        const conn2 = state2.getDatabaseConnection(state2.getActiveConnection());
        if (conn2 && conn2.type === 'redis') {
          panelState.redisTreeKeys = null;
          panelState.redisSelectedKey = null;
          panelState.redisKeyInfo = null;
          panelState.redisTreeFilter = '';
          panelState.redisExpandedFolders = new Set();
          renderContent();
          loadRedisKeys(tableName);
        } else {
          renderContent();
          loadTableData(tableName);
        }
      }
    };
  });

  // Data search
  const searchInput = container.querySelector('#db-browser-search');
  if (searchInput) {
    searchInput.oninput = () => {
      panelState.browserSearchTerm = searchInput.value;
      clearTimeout(panelState.browserSearchDebounce);
      panelState.browserSearchDebounce = setTimeout(() => {
        panelState.browserPage = 0;
        loadTableData(panelState.browserSelectedTable);
      }, 400);
    };
    searchInput.onkeydown = (e) => {
      if (e.key === 'Escape') {
        if (panelState.browserSearchTerm) {
          panelState.browserSearchTerm = '';
          panelState.browserPage = 0;
          renderContent();
          loadTableData(panelState.browserSelectedTable);
          e.stopPropagation();
        }
      } else if (e.key === 'Enter') {
        clearTimeout(panelState.browserSearchDebounce);
        panelState.browserPage = 0;
        loadTableData(panelState.browserSelectedTable);
      }
    };
  }
  const searchClearBtn = container.querySelector('#db-browser-search-clear');
  if (searchClearBtn) {
    searchClearBtn.onclick = () => {
      panelState.browserSearchTerm = '';
      panelState.browserPage = 0;
      renderContent();
      loadTableData(panelState.browserSelectedTable);
    };
  }

  // Refresh
  const refreshBtn = container.querySelector('#db-browser-refresh');
  if (refreshBtn) refreshBtn.onclick = () => loadTableData(panelState.browserSelectedTable);

  // Pagination
  const prevBtn = container.querySelector('#db-browser-prev');
  if (prevBtn) prevBtn.onclick = () => { panelState.browserPage--; panelState.browserSelectedRows = new Set(); panelState.browserLastSelectedRow = null; loadTableData(panelState.browserSelectedTable); };
  const nextBtn = container.querySelector('#db-browser-next');
  if (nextBtn) nextBtn.onclick = () => { panelState.browserPage++; panelState.browserSelectedRows = new Set(); panelState.browserLastSelectedRow = null; loadTableData(panelState.browserSelectedTable); };

  // Column sort
  container.querySelectorAll('.db-grid-th').forEach(th => {
    th.onclick = () => {
      const col = th.dataset.col;
      if (panelState.browserSortCol === col) {
        panelState.browserSortDir = panelState.browserSortDir === 'ASC' ? 'DESC' : 'ASC';
      } else {
        panelState.browserSortCol = col;
        panelState.browserSortDir = 'ASC';
      }
      panelState.browserPage = 0;
      loadTableData(panelState.browserSelectedTable);
    };
  });

  // Cell click to edit
  container.querySelectorAll('.db-grid-cell:not(.editing)').forEach(cell => {
    cell.ondblclick = () => {
      // Cancel any pending blur commit from a previous cell
      if (panelState._blurCommitTimer) {
        clearTimeout(panelState._blurCommitTimer);
        panelState._blurCommitTimer = null;
      }
      const row = parseInt(cell.dataset.row);
      const col = cell.dataset.col;
      if (col === undefined) return;
      panelState.browserEditingCell = { row, col, original: cell.textContent };
      renderContent();
      setTimeout(() => {
        const input = document.querySelector('.db-grid-edit-input');
        if (input) { input.focus(); input.select(); }
      }, 0);
    };
  });

  // Edit input handling
  container.querySelectorAll('.db-grid-edit-input').forEach(input => {
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        // Cancel pending blur since we're committing now
        if (panelState._blurCommitTimer) { clearTimeout(panelState._blurCommitTimer); panelState._blurCommitTimer = null; }
        commitCellEdit(input);
      } else if (e.key === 'Escape') {
        if (panelState._blurCommitTimer) { clearTimeout(panelState._blurCommitTimer); panelState._blurCommitTimer = null; }
        panelState.browserEditingCell = null;
        renderContent();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        if (panelState._blurCommitTimer) { clearTimeout(panelState._blurCommitTimer); panelState._blurCommitTimer = null; }
        commitCellEdit(input);
      }
    };
    input.onblur = () => {
      // Capture values immediately before DOM may change
      const row = parseInt(input.dataset.row);
      const col = input.dataset.col;
      const value = input.value;
      panelState._blurCommitTimer = setTimeout(() => {
        panelState._blurCommitTimer = null;
        if (panelState.browserEditingCell && panelState.browserEditingCell.row === row && panelState.browserEditingCell.col === col) {
          commitCellEdit({ dataset: { row, col }, value });
        }
      }, 100);
    };
  });

  // Add row button
  const addRowBtn = container.querySelector('#db-browser-add-row');
  if (addRowBtn) addRowBtn.onclick = () => insertNewRow();

  // Delete row buttons
  container.querySelectorAll('.db-grid-row-delete').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const rowIdx = parseInt(btn.dataset.row);
      deleteRow(rowIdx);
    };
  });

  // Export button (browser)
  const exportBtn = container.querySelector('#db-browser-export');
  const exportMenu = container.querySelector('#db-browser-export-menu');
  if (exportBtn && exportMenu) {
    exportBtn.onclick = (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle('open');
    };
  }
  container.querySelectorAll('[data-browser-export]').forEach(btn => {
    btn.onclick = () => {
      exportMenu && exportMenu.classList.remove('open');
      exportResults(btn.dataset.browserExport, panelState.browserData, panelState.browserSelectedTable);
    };
  });

  // Select all checkbox
  const selectAllCb = container.querySelector('#db-grid-select-all');
  if (selectAllCb) {
    if (selectAllCb.hasAttribute('data-indeterminate')) {
      selectAllCb.indeterminate = true;
    }
    selectAllCb.onchange = () => {
      const data = panelState.browserData;
      if (selectAllCb.checked && data && data.rows) {
        panelState.browserSelectedRows = new Set(data.rows.map((_, i) => i));
      } else {
        panelState.browserSelectedRows = new Set();
      }
      panelState.browserLastSelectedRow = null;
      renderContent();
    };
  }

  // Individual row checkboxes
  container.querySelectorAll('.db-grid-row-checkbox').forEach(cb => {
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = (e) => {
      const rowIdx = parseInt(cb.dataset.row);
      if (e.shiftKey && panelState.browserLastSelectedRow !== null) {
        const start = Math.min(panelState.browserLastSelectedRow, rowIdx);
        const end = Math.max(panelState.browserLastSelectedRow, rowIdx);
        for (let i = start; i <= end; i++) panelState.browserSelectedRows.add(i);
      } else if (cb.checked) {
        panelState.browserSelectedRows.add(rowIdx);
      } else {
        panelState.browserSelectedRows.delete(rowIdx);
      }
      panelState.browserLastSelectedRow = rowIdx;
      renderContent();
    };
  });

  // Delete selected rows
  const deleteSelectedBtn = container.querySelector('#db-browser-delete-selected');
  if (deleteSelectedBtn) {
    deleteSelectedBtn.onclick = () => deleteSelectedRows();
  }

  // FK navigation — click FK ref to jump to referenced table
  container.querySelectorAll('.db-col-fk-ref').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const targetTable = el.dataset.fkTable;
      if (targetTable && targetTable !== panelState.browserSelectedTable) {
        panelState.browserSelectedTable = targetTable;
        panelState.browserPage = 0;
        panelState.browserSortCol = null;
        panelState.browserSortDir = 'ASC';
        panelState.browserData = null;
        panelState.browserEditingCell = null;
        panelState.browserSearchTerm = '';
        panelState.browserSelectedRows = new Set();
        panelState.browserLastSelectedRow = null;
        renderContent();
        loadTableData(targetTable);
      }
    };
  });

  // Column resize
  setupColumnResize(container, 'browserColumnWidths', panelState.browserSelectedTable);

  // Sidebar resize
  setupSidebarResize(container);

  // Cell expand buttons (browser data grid)
  container.querySelectorAll('.db-cell-expand-btn[data-expand-row]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const row = parseInt(btn.dataset.expandRow);
      const col = btn.dataset.expandCol;
      const data = panelState.browserData;
      if (!data || !data.rows[row]) return;
      const val = data.rows[row][col];
      const state = require('../../state');
      const activeId = state.getActiveConnection();
      const schema = state.getDatabaseSchema(activeId);
      const tableMeta = schema?.tables?.find(t => t.name === panelState.browserSelectedTable);
      const colMeta = tableMeta?.columns?.find(c => c.name === col);
      showCellViewerModal(val, col, colMeta?.type);
    };
  });
}

async function commitCellEdit(input) {
  const row = parseInt(input.dataset.row);
  const col = input.dataset.col;
  const newVal = input.value;
  const data = panelState.browserData;

  if (!data || !data.rows[row]) return;

  const oldVal = data.rows[row][col];
  const oldStr = oldVal === null || oldVal === undefined ? '' : String(oldVal);

  panelState.browserEditingCell = null;

  if (newVal === oldStr) {
    renderContent();
    return;
  }

  // Build UPDATE query
  const state = require('../../state');
  const activeId = state.getActiveConnection();
  const conn = state.getDatabaseConnection(activeId);
  const schema = state.getDatabaseSchema(activeId);
  const tableMeta = schema?.tables?.find(t => t.name === panelState.browserSelectedTable);

  if (!tableMeta || !activeId) return;

  // Find primary key for WHERE clause
  const pkCol = tableMeta.columns.find(c => c.primaryKey);
  const isMongo = conn && conn.type === 'mongodb';
  const isRedis = conn && conn.type === 'redis';
  const dbType = conn ? conn.type : 'sqlite';

  if (isMongo || isRedis) {
    ctx.showToast({ type: 'warning', title: t('database.browserEditNotSupported') });
    renderContent();
    return;
  }

  let whereClause = '';
  if (pkCol) {
    const pkVal = data.rows[row][pkCol.name];
    whereClause = `WHERE ${escapeIdentifier(pkCol.name, dbType)} = ${escapeSqlValue(pkVal)}`;
  } else {
    // No PK — use all columns for WHERE
    const conditions = data.columns.map(c => {
      const v = data.rows[row][c];
      if (v === null || v === undefined) return `${escapeIdentifier(c, dbType)} IS NULL`;
      return `${escapeIdentifier(c, dbType)} = ${escapeSqlValue(v)}`;
    });
    whereClause = (dbType === 'mysql' || dbType === 'mariadb')
      ? `WHERE ${conditions.join(' AND ')} LIMIT 1`
      : `WHERE ${conditions.join(' AND ')}`;
  }

  const setVal = newVal === '' ? 'NULL' : escapeSqlValue(newVal);
  const sql = `UPDATE ${escapeIdentifier(panelState.browserSelectedTable, dbType)} SET ${escapeIdentifier(col, dbType)} = ${setVal} ${whereClause}`;

  try {
    const result = await ctx.api.database.executeQuery({ id: activeId, sql, allowDestructive: true });
    if (result.error) {
      ctx.showToast({ type: 'error', title: t('database.browserQueryError'), message: result.error });
    } else {
      // Update local data
      data.rows[row][col] = newVal === '' ? null : newVal;
      ctx.showToast({ type: 'success', title: t('database.browserRowUpdated', { table: panelState.browserSelectedTable }) });
    }
  } catch (e) {
    ctx.showToast({ type: 'error', title: t('database.browserQueryError'), message: e.message });
  }

  renderContent();
}

function insertNewRow() {
  const state = require('../../state');
  const activeId = state.getActiveConnection();
  const conn = state.getDatabaseConnection(activeId);
  if (!activeId || !panelState.browserSelectedTable) return;

  if (conn && (conn.type === 'mongodb' || conn.type === 'redis')) {
    ctx.showToast({ type: 'warning', title: t('database.browserEditNotSupported') });
    return;
  }

  const schema = state.getDatabaseSchema(activeId);
  const tableMeta = schema?.tables?.find(t => t.name === panelState.browserSelectedTable);
  if (!tableMeta) return;

  // Build form fields for each column
  const fieldsHtml = tableMeta.columns.map(col => {
    const pkBadge = col.primaryKey ? `<span class="db-insert-pk">PK</span>` : '';
    const nullHint = col.nullable ? `<span class="db-insert-nullable">NULL</span>` : '';
    const defaultHint = col.defaultValue ? `<span class="db-insert-default">${escapeHtml(String(col.defaultValue))}</span>` : '';
    return `
      <div class="db-insert-field">
        <label class="db-insert-label">
          ${pkBadge}${escapeHtml(col.name)}
          <span class="db-insert-type">${escapeHtml(col.type)}</span>
          ${nullHint}${defaultHint}
        </label>
        <input class="db-insert-input" data-col="${escapeHtml(col.name)}" data-nullable="${col.nullable}" placeholder="${col.nullable ? 'NULL' : ''}" />
      </div>`;
  }).join('');

  const html = `<div class="db-insert-form">${fieldsHtml}</div>`;
  const footer = `
    <button class="btn-secondary" id="db-insert-cancel">${t('database.cancel')}</button>
    <button class="btn-primary" id="db-insert-save">${t('database.browserInsertBtn')}</button>`;

  ctx.showModal(t('database.browserAddRow') + ' — ' + panelState.browserSelectedTable, html, footer);

  document.getElementById('db-insert-cancel').onclick = () => ctx.closeModal();
  document.getElementById('db-insert-save').onclick = async () => {
    const inputs = document.querySelectorAll('.db-insert-input');
    const colNames = [];
    const values = [];
    const dbType = conn ? conn.type : 'sqlite';
    inputs.forEach(input => {
      const val = input.value.trim();
      const nullable = input.dataset.nullable === 'true';
      // Skip empty nullable fields (they'll use default/NULL)
      if (val === '' && nullable) return;
      if (val === '') return;
      colNames.push(escapeIdentifier(input.dataset.col, dbType));
      values.push(escapeSqlValue(val));
    });

    if (colNames.length === 0) {
      ctx.showToast({ type: 'warning', title: t('database.browserInsertEmpty') });
      return;
    }

    const sql = `INSERT INTO ${escapeIdentifier(panelState.browserSelectedTable, dbType)} (${colNames.join(', ')}) VALUES (${values.join(', ')})`;
    try {
      const result = await ctx.api.database.executeQuery({ id: activeId, sql, allowDestructive: true });
      if (result.error) {
        ctx.showToast({ type: 'error', title: t('database.browserQueryError'), message: result.error });
      } else {
        ctx.showToast({ type: 'success', title: t('database.browserRowInserted', { table: panelState.browserSelectedTable }) });
        ctx.closeModal();
        loadTableData(panelState.browserSelectedTable);
      }
    } catch (e) {
      ctx.showToast({ type: 'error', title: t('database.browserQueryError'), message: e.message });
    }
  };
}

async function deleteRow(rowIdx) {
  const state = require('../../state');
  const activeId = state.getActiveConnection();
  const conn = state.getDatabaseConnection(activeId);
  const data = panelState.browserData;
  if (!activeId || !data || !data.rows[rowIdx]) return;

  if (conn && (conn.type === 'mongodb' || conn.type === 'redis')) {
    ctx.showToast({ type: 'warning', title: t('database.browserEditNotSupported') });
    return;
  }

  const schema = state.getDatabaseSchema(activeId);
  const tableMeta = schema?.tables?.find(t => t.name === panelState.browserSelectedTable);
  if (!tableMeta) return;

  const row = data.rows[rowIdx];
  const pkCol = tableMeta.columns.find(c => c.primaryKey);

  // Build a preview of the row for the confirmation message
  const previewCols = data.columns.slice(0, 3);
  const preview = previewCols.map(c => `${c}: ${row[c] === null ? 'NULL' : row[c]}`).join(', ');

  const confirmed = await showConfirm({
    title: t('database.browserDeleteRow'),
    message: `${t('database.browserDeleteConfirm')}\n\n${preview}${data.columns.length > 3 ? '...' : ''}`,
    confirmLabel: t('common.delete') || 'Delete',
    danger: true
  });

  if (!confirmed) return;

  const dbType = conn ? conn.type : 'sqlite';
  let whereClause = '';
  if (pkCol) {
    const pkVal = row[pkCol.name];
    whereClause = `WHERE ${escapeIdentifier(pkCol.name, dbType)} = ${escapeSqlValue(pkVal)}`;
  } else {
    const conditions = data.columns.map(c => {
      const v = row[c];
      if (v === null || v === undefined) return `${escapeIdentifier(c, dbType)} IS NULL`;
      return `${escapeIdentifier(c, dbType)} = ${escapeSqlValue(v)}`;
    });
    whereClause = (dbType === 'mysql' || dbType === 'mariadb')
      ? `WHERE ${conditions.join(' AND ')} LIMIT 1`
      : `WHERE ${conditions.join(' AND ')}`;
  }

  const sql = `DELETE FROM ${escapeIdentifier(panelState.browserSelectedTable, dbType)} ${whereClause}`;
  try {
    const result = await ctx.api.database.executeQuery({ id: activeId, sql, allowDestructive: true });
    if (result.error) {
      ctx.showToast({ type: 'error', title: t('database.browserQueryError'), message: result.error });
    } else {
      ctx.showToast({ type: 'success', title: t('database.browserRowDeleted', { table: panelState.browserSelectedTable }) });
      loadTableData(panelState.browserSelectedTable);
    }
  } catch (e) {
    ctx.showToast({ type: 'error', title: t('database.browserQueryError'), message: e.message });
  }
}

async function deleteSelectedRows() {
  const selected = panelState.browserSelectedRows;
  if (selected.size === 0) return;

  const confirmed = await showConfirm({
    title: t('database.deleteSelected'),
    message: t('database.deleteSelectedConfirm', { count: selected.size }),
    confirmLabel: t('common.delete') || 'Delete',
    danger: true
  });
  if (!confirmed) return;

  // Delete rows in reverse index order to keep indices valid
  const indices = Array.from(selected).sort((a, b) => b - a);
  for (const idx of indices) {
    await deleteRow(idx);
  }
  panelState.browserSelectedRows = new Set();
  panelState.browserLastSelectedRow = null;
  loadTableData(panelState.browserSelectedTable);
}

function setupColumnResize(container, stateKey, tableName) {
  container.querySelectorAll('.db-grid-resize-handle').forEach(handle => {
    handle.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const th = handle.closest('th');
      if (!th) return;
      const col = handle.dataset.resizeCol;
      const startX = e.clientX;
      const startWidth = th.offsetWidth;

      const onMouseMove = (moveEvt) => {
        const delta = moveEvt.clientX - startX;
        const newWidth = Math.max(60, startWidth + delta);
        th.style.width = newWidth + 'px';
        th.style.minWidth = newWidth + 'px';
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        const finalWidth = th.offsetWidth;
        if (stateKey === 'browserColumnWidths') {
          if (!panelState.browserColumnWidths[tableName]) panelState.browserColumnWidths[tableName] = {};
          panelState.browserColumnWidths[tableName][col] = finalWidth;
        } else {
          panelState.queryResultColumnWidths[col] = finalWidth;
        }
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };
  });

  // Redis tree events
  bindRedisBrowserEvents(container);
}

// ==================== Redis Tree Events & Loading ====================

function bindRedisBrowserEvents(container) {
  const filterInput = container.querySelector('#redis-tree-filter');
  if (filterInput) {
    filterInput.oninput = () => {
      panelState.redisTreeFilter = filterInput.value;
      renderContent();
      setTimeout(() => {
        const input = document.querySelector('#redis-tree-filter');
        if (input) { input.focus(); input.selectionStart = input.selectionEnd = input.value.length; }
      }, 0);
    };
  }

  const refreshBtn = container.querySelector('#redis-tree-refresh');
  if (refreshBtn) {
    refreshBtn.onclick = () => loadRedisKeys(panelState.browserSelectedTable);
  }

  // Folder toggle (event delegation)
  container.querySelectorAll('[data-folder-toggle]').forEach(el => {
    el.onclick = () => {
      const folder = el.dataset.folderToggle;
      if (panelState.redisExpandedFolders.has(folder)) {
        panelState.redisExpandedFolders.delete(folder);
      } else {
        panelState.redisExpandedFolders.add(folder);
      }
      renderContent();
    };
  });

  // Key selection (event delegation)
  container.querySelectorAll('.redis-tree-key').forEach(el => {
    el.onclick = () => {
      const key = el.dataset.redisKey;
      if (key && key !== panelState.redisSelectedKey) {
        panelState.redisSelectedKey = key;
        panelState.redisKeyInfo = null;
        renderContent();
        loadRedisKeyInfo(panelState.browserSelectedTable, key);
      }
    };
  });
}

async function loadRedisKeys(dbName) {
  if (!dbName) return;
  const state = require('../../state');
  const activeId = state.getActiveConnection();
  if (!activeId) return;

  panelState.redisTreeLoading = true;
  renderContent();

  const dbIndex = dbName.startsWith('db:') ? parseInt(dbName.slice(3)) : 0;
  try {
    const result = await ctx.api.database.executeQuery({ id: activeId, sql: `_REDIS_KEYS ${dbIndex}`, limit: 100000 });
    if (result.error) {
      ctx.showToast({ type: 'error', title: result.error });
      panelState.redisTreeKeys = [];
    } else {
      panelState.redisTreeKeys = (result.rows || []).map(r => r.key);
    }
  } catch (e) {
    panelState.redisTreeKeys = [];
    ctx.showToast({ type: 'error', title: e.message });
  }

  panelState.redisTreeLoading = false;
  renderContent();
}

async function loadRedisKeyInfo(dbName, key) {
  const state = require('../../state');
  const activeId = state.getActiveConnection();
  if (!activeId) return;

  panelState.redisKeyInfoLoading = true;
  renderContent();

  const dbIndex = dbName && dbName.startsWith('db:') ? parseInt(dbName.slice(3)) : 0;
  try {
    const result = await ctx.api.database.executeQuery({ id: activeId, sql: `_REDIS_KEY_INFO ${dbIndex} ${key}`, limit: 1 });
    if (result.error) {
      ctx.showToast({ type: 'error', title: result.error });
      panelState.redisKeyInfo = null;
    } else if (result.rows && result.rows.length > 0) {
      panelState.redisKeyInfo = result.rows[0];
    }
  } catch (e) {
    panelState.redisKeyInfo = null;
    ctx.showToast({ type: 'error', title: e.message });
  }

  panelState.redisKeyInfoLoading = false;
  renderContent();
}

async function loadTableData(tableName) {
  if (!tableName) return;
  const state = require('../../state');
  const activeId = state.getActiveConnection();
  const conn = state.getDatabaseConnection(activeId);
  if (!activeId) return;

  panelState.browserLoading = true;
  panelState.browserEditingCell = null;
  renderContent();

  const isMongo = conn && conn.type === 'mongodb';
  const isRedis = conn && conn.type === 'redis';
  const dbType = conn ? conn.type : 'sqlite';
  const page = panelState.browserPage;
  const pageSize = panelState.browserPageSize;
  const offset = page * pageSize;
  const sortCol = panelState.browserSortCol;
  const sortDir = panelState.browserSortDir;

  // Build search WHERE clause
  const searchTerm = panelState.browserSearchTerm.trim();
  let searchWhere = '';
  if (searchTerm && !isMongo && !isRedis) {
    const state2 = require('../../state');
    const schema = state2.getDatabaseSchema(activeId);
    const tableMeta = schema?.tables?.find(t => t.name === tableName);
    if (tableMeta && tableMeta.columns.length > 0) {
      // Use '!' as LIKE escape char (works on MySQL, PostgreSQL, SQLite)
      const escaped = searchTerm.replace(/'/g, "''").replace(/%/g, '!%').replace(/_/g, '!_');
      // MySQL/MariaDB CAST target is CHAR; PostgreSQL and SQLite use TEXT
      const castType = (dbType === 'mysql' || dbType === 'mariadb') ? 'CHAR' : 'TEXT';
      const conditions = tableMeta.columns.map(col => {
        return `CAST(${escapeIdentifier(col.name, dbType)} AS ${castType}) LIKE '%${escaped}%' ESCAPE '!'`;
      });
      searchWhere = ` WHERE (${conditions.join(' OR ')})`;
    }
  }

  const escapedTable = escapeIdentifier(tableName, dbType);
  let sql, countSql;
  if (isRedis) {
    // tableName is "db:N" — extract DB index
    const dbIndex = tableName.startsWith('db:') ? parseInt(tableName.slice(3)) : 0;
    sql = `_REDIS_SCAN ${dbIndex} ${pageSize} ${offset}${searchTerm ? ' ' + searchTerm : ''}`;
    countSql = null;
  } else if (isMongo) {
    // Use $regex per-field search — safe against NoSQL injection (no $where/JS eval)
    if (searchTerm) {
      const escapedRegex = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const state2 = require('../../state');
      const schema = state2.getDatabaseSchema(activeId);
      const tableMeta = schema?.tables?.find(t => t.name === tableName);
      const fields = tableMeta ? tableMeta.columns.map(c => c.name).filter(n => n !== '_id') : [];
      if (fields.length > 0) {
        const orConditions = fields.map(f => `${JSON.stringify(f)}: { "$regex": ${JSON.stringify(escapedRegex)}, "$options": "i" }`);
        sql = `db.${tableName}.find({ "$or": [${orConditions.map(c => `{ ${c} }`).join(', ')}] }).limit(${pageSize}).skip(${offset})`;
      } else {
        sql = `db.${tableName}.find({}).limit(${pageSize}).skip(${offset})`;
      }
    } else {
      sql = `db.${tableName}.find({}).limit(${pageSize}).skip(${offset})`;
    }
    countSql = null;
  } else {
    const orderBy = sortCol ? ` ORDER BY ${escapeIdentifier(sortCol, dbType)} ${sortDir === 'DESC' ? 'DESC' : 'ASC'}` : '';
    sql = `SELECT * FROM ${escapedTable}${searchWhere}${orderBy} LIMIT ${pageSize} OFFSET ${offset}`;
    countSql = `SELECT COUNT(*) as cnt FROM ${escapedTable}${searchWhere}`;
  }

  try {
    // Fetch count + data in parallel
    const [dataResult, countResult] = await Promise.all([
      ctx.api.database.executeQuery({ id: activeId, sql, limit: pageSize }),
      countSql ? ctx.api.database.executeQuery({ id: activeId, sql: countSql, limit: 1 }) : Promise.resolve(null)
    ]);

    let totalCount = 0;
    if (countResult && countResult.rows && countResult.rows.length > 0) {
      totalCount = Object.values(countResult.rows[0])[0] || 0;
    }

    panelState.browserData = {
      columns: dataResult.columns || [],
      rows: dataResult.rows || [],
      totalCount: totalCount || dataResult.rows?.length || 0,
      error: dataResult.error || null
    };

    if (dataResult.error) {
      ctx.showToast({ type: 'error', title: dataResult.error });
    }
  } catch (e) {
    panelState.browserData = { columns: [], rows: [], totalCount: 0, error: e.message };
    ctx.showToast({ type: 'error', title: e.message });
  }

  panelState.browserLoading = false;
  renderContent();
}

async function loadSchema(id) {
  const state = require('../../state');
  const result = await ctx.api.database.getSchema({ id });
  if (result.success) {
    state.setDatabaseSchema(id, { tables: result.tables });
    buildAutocompleteIndex();
    if (panelState.activeSubTab === 'schema') renderContent();
    loadTableRowCounts(id);
  }
}

// ==================== Query Tab ====================

function getQueryTemplates(isMongo, dbType, isRedis) {
  if (isRedis) {
    return [
      { label: 'KEYS',    icon: '&#x1F511;', sql: 'KEYS *',                                    cat: 'read'  },
      { label: 'GET',     icon: '&#x25B6;',  sql: 'GET mykey',                                  cat: 'read'  },
      { label: 'SET',     icon: '&#x270E;',  sql: 'SET mykey myvalue',                           cat: 'write' },
      { label: 'SETEX',   icon: '&#x23F1;',  sql: 'SETEX mykey 3600 myvalue',                   cat: 'write' },
      { label: 'DEL',     icon: '&#x2716;',  sql: 'DEL mykey',                                  cat: 'danger'},
      { label: 'HGETALL', icon: '&#x1F4CB;', sql: 'HGETALL myhash',                             cat: 'read'  },
      { label: 'HSET',    icon: '&#x270E;',  sql: 'HSET myhash field value',                    cat: 'write' },
      { label: 'LRANGE',  icon: '&#x1F4CB;', sql: 'LRANGE mylist 0 -1',                         cat: 'read'  },
      { label: 'SMEMBERS',icon: '&#x2B55;',  sql: 'SMEMBERS myset',                             cat: 'read'  },
      { label: 'TTL',     icon: '&#x23F3;',  sql: 'TTL mykey',                                  cat: 'read'  },
      { label: 'EXPIRE',  icon: '&#x23F3;',  sql: 'EXPIRE mykey 3600',                          cat: 'write' },
      { label: 'INFO',    icon: '&#x2139;',  sql: 'INFO server',                                cat: 'read'  },
    ];
  }
  if (isMongo) {
    return [
      { label: 'Find All',     icon: '&#x25B6;', sql: 'db.collection.find({}).limit(50)',        cat: 'read' },
      { label: 'Find Where',   icon: '&#x1F50D;', sql: 'db.collection.find({ field: "value" })', cat: 'read' },
      { label: 'Count',        icon: '&#x23;',   sql: 'db.collection.countDocuments({})',         cat: 'read' },
      { label: 'Insert',       icon: '&#x2B;',   sql: 'db.collection.insertOne({ key: "value" })', cat: 'write' },
      { label: 'Update',       icon: '&#x270E;', sql: 'db.collection.updateOne({ _id: "" }, { $set: { key: "value" } })', cat: 'write' },
      { label: 'Delete',       icon: '&#x2716;', sql: 'db.collection.deleteOne({ _id: "" })',    cat: 'danger' },
      { label: 'Aggregate',    icon: '&#x2261;', sql: 'db.collection.aggregate([\n  { $match: {} },\n  { $group: { _id: "$field", count: { $sum: 1 } } }\n])', cat: 'read' },
      { label: 'Distinct',     icon: '&#x2662;', sql: 'db.collection.distinct("field")',          cat: 'read' },
    ];
  }

  // DB-specific templates
  let createTable, indexes, describe;
  if (dbType === 'postgresql') {
    createTable = 'CREATE TABLE new_table (\n  id SERIAL PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);';
    indexes     = "SELECT indexname, indexdef\nFROM pg_indexes\nWHERE tablename = 'table_name';";
    describe    = "SELECT column_name, data_type, is_nullable, column_default\nFROM information_schema.columns\nWHERE table_name = 'table_name'\nORDER BY ordinal_position;";
  } else if (dbType === 'sqlite') {
    createTable = 'CREATE TABLE new_table (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);';
    indexes     = 'PRAGMA index_list(table_name);';
    describe    = 'PRAGMA table_info(table_name);';
  } else {
    // mysql / mariadb (default)
    createTable = 'CREATE TABLE new_table (\n  id INT PRIMARY KEY AUTO_INCREMENT,\n  name VARCHAR(255) NOT NULL,\n  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);';
    indexes     = 'SHOW INDEX FROM table_name;';
    describe    = 'DESCRIBE table_name;';
  }

  return [
    { label: 'SELECT',        icon: '&#x25B6;', sql: 'SELECT * FROM table_name\nLIMIT 100;',     cat: 'read' },
    { label: 'WHERE',         icon: '&#x1F50D;', sql: "SELECT * FROM table_name\nWHERE column = 'value'\nLIMIT 100;", cat: 'read' },
    { label: 'COUNT',         icon: '&#x23;',   sql: 'SELECT COUNT(*) AS total\nFROM table_name;', cat: 'read' },
    { label: 'JOIN',          icon: '&#x21C4;', sql: 'SELECT a.*, b.*\nFROM table_a a\nINNER JOIN table_b b ON a.id = b.a_id\nLIMIT 100;', cat: 'read' },
    { label: 'GROUP BY',      icon: '&#x2261;', sql: 'SELECT column, COUNT(*) AS cnt\nFROM table_name\nGROUP BY column\nORDER BY cnt DESC;', cat: 'read' },
    { label: 'INSERT',        icon: '&#x2B;',   sql: "INSERT INTO table_name (col1, col2)\nVALUES ('val1', 'val2');", cat: 'write' },
    { label: 'UPDATE',        icon: '&#x270E;', sql: "UPDATE table_name\nSET column = 'new_value'\nWHERE id = 1;", cat: 'write' },
    { label: 'DELETE',        icon: '&#x2716;', sql: 'DELETE FROM table_name\nWHERE id = 1;',     cat: 'danger' },
    { label: 'CREATE TABLE',  icon: '&#x2295;', sql: createTable,                                  cat: 'ddl' },
    { label: 'ALTER TABLE',   icon: '&#x2699;', sql: 'ALTER TABLE table_name\nADD COLUMN new_col VARCHAR(255);', cat: 'ddl' },
    { label: 'INDEXES',       icon: '&#x26A1;', sql: indexes,                                      cat: 'read' },
    { label: 'DESCRIBE',      icon: '&#x2139;', sql: describe,                                     cat: 'read' },
  ];
}

// ==================== Helpers ====================

function formatRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return t('database.historyJustNow');
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const date = new Date(timestamp);
  return `${date.getDate()}/${date.getMonth() + 1}`;
}

function formatRowCount(count) {
  if (count === null || count === undefined) return '';
  if (count >= 1000000) return (count / 1000000).toFixed(1).replace('.0', '') + 'M';
  if (count >= 1000) return (count / 1000).toFixed(1).replace('.0', '') + 'k';
  return String(count);
}

async function loadTableRowCounts(connectionId) {
  const state = require('../../state');
  const conn = state.getDatabaseConnection(connectionId);
  if (!conn) return;
  if (conn.type === 'redis' || conn.type === 'mongodb') return;

  const schema = state.getDatabaseSchema(connectionId);
  if (!schema || !schema.tables) return;

  const counts = {};
  const dbType = conn.type;
  const BATCH = 10;

  try {
    for (let i = 0; i < schema.tables.length; i += BATCH) {
      const batch = schema.tables.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(table => {
        const escaped = escapeIdentifier(table.name, dbType);
        return ctx.api.database.executeQuery({
          id: connectionId,
          sql: `SELECT COUNT(*) as cnt FROM ${escaped}`,
          limit: 1
        }).catch(() => null);
      }));
      results.forEach((result, idx) => {
        if (result && result.rows && result.rows[0]) {
          const val = Object.values(result.rows[0])[0];
          counts[batch[idx].name] = typeof val === 'number' ? val : parseInt(val) || 0;
        }
      });
    }
  } catch (_) { /* ignore */ }

  panelState.browserTableRowCounts = counts;
  if (panelState.activeSubTab === 'schema') renderContent();
}

// ==================== Save Query Modal ====================

function showSaveQueryModal(sql) {
  const state = require('../../state');
  const content = `
    <div class="db-save-query-form">
      <label class="db-save-query-label">${t('database.savedQueryName')}</label>
      <input type="text" id="save-query-name-input" class="database-form-input" placeholder="${escapeHtml(t('database.savedQueryNamePlaceholder'))}" />
      <div class="db-save-query-preview">${escapeHtml(sql.length > 200 ? sql.substring(0, 200) + '...' : sql)}</div>
    </div>
  `;
  const modal = createModal({
    id: 'save-query-modal',
    title: t('database.saveQuery'),
    content,
    size: 'small',
    buttons: [
      { label: t('database.cancel'), action: 'cancel', onClick: (m) => closeModal(m) },
      { label: t('database.save'), action: 'save', primary: true, onClick: (m) => {
        const nameInput = m.querySelector('#save-query-name-input');
        const name = nameInput ? nameInput.value.trim() : '';
        if (!name) { if (nameInput) nameInput.focus(); return; }
        state.addSavedQuery({
          id: _generateId(),
          name,
          sql,
          createdAt: Date.now()
        });
        closeModal(m);
        renderContent();
      }}
    ]
  });
  showModal(modal);

  const inp = modal.querySelector('#save-query-name-input');
  if (inp) {
    inp.focus();
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const name = inp.value.trim();
        if (!name) return;
        state.addSavedQuery({ id: _generateId(), name, sql, createdAt: Date.now() });
        closeModal(modal);
        renderContent();
      }
    };
  }
}

// ==================== Autocomplete Engine ====================

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP',
  'ALTER', 'TABLE', 'INTO', 'VALUES', 'SET', 'JOIN', 'LEFT', 'RIGHT', 'INNER',
  'OUTER', 'ON', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'ORDER',
  'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'AS', 'DISTINCT', 'COUNT',
  'SUM', 'AVG', 'MAX', 'MIN', 'EXISTS', 'BETWEEN', 'UNION', 'ALL', 'CASE',
  'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC', 'PRIMARY', 'KEY', 'INDEX',
  'UNIQUE', 'DEFAULT', 'CONSTRAINT', 'FOREIGN', 'REFERENCES', 'CASCADE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRUNCATE', 'CROSS', 'FULL', 'NATURAL',
  'EXCEPT', 'INTERSECT', 'WITH', 'RECURSIVE', 'RETURNING', 'EXPLAIN', 'ANALYZE'
];

function buildAutocompleteIndex() {
  const state = require('../../state');
  const activeId = state.getActiveConnection();
  if (!activeId) { autocompleteIndex = null; return; }

  const conn = state.getDatabaseConnection(activeId);
  if (conn && (conn.type === 'mongodb' || conn.type === 'redis')) { autocompleteIndex = null; return; }

  const schema = state.getDatabaseSchema(activeId);
  if (!schema || !schema.tables) { autocompleteIndex = null; return; }

  const tables = schema.tables.map(t => t.name);
  const columnsByTable = {};
  const allColumnsSet = new Set();

  for (const table of schema.tables) {
    const cols = (table.columns || []).map(c => c.name);
    columnsByTable[table.name] = cols;
    cols.forEach(c => allColumnsSet.add(c));
  }

  autocompleteIndex = {
    tables,
    columnsByTable,
    allColumns: [...allColumnsSet],
    sqlKeywords: SQL_KEYWORDS
  };
}

function getAutocompleteContext(text, cursorPos) {
  const beforeCursor = text.substring(0, cursorPos);

  // After a dot: table.column pattern
  const dotMatch = beforeCursor.match(/(\w+)\.\s*(\w*)$/);
  if (dotMatch) {
    return { type: 'column_of_table', tableName: dotMatch[1], partial: dotMatch[2] || '' };
  }

  // Current word being typed
  const wordMatch = beforeCursor.match(/(\w+)$/);
  const partial = wordMatch ? wordMatch[1] : '';

  // Context before partial
  const contextBefore = partial
    ? beforeCursor.substring(0, beforeCursor.length - partial.length).trimEnd()
    : beforeCursor.trimEnd();

  if (/\b(FROM|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|LEFT\s+OUTER\s+JOIN|RIGHT\s+OUTER\s+JOIN|INTO|UPDATE|TABLE)\s*$/i.test(contextBefore)) {
    return { type: 'table', partial };
  }

  if (/\b(WHERE|AND|OR|ON|SET|BY|HAVING)\s*$/i.test(contextBefore) || /,\s*$/.test(contextBefore)) {
    return { type: 'column', partial };
  }

  // After SELECT before FROM
  if (/\bSELECT\b/i.test(contextBefore) && !/\bFROM\b/i.test(contextBefore)) {
    return { type: 'column', partial };
  }

  if (partial.length >= 2) {
    return { type: 'all', partial };
  }

  return null;
}

function getSuggestions(context) {
  if (!autocompleteIndex || !context) return [];
  const partial = context.partial.toLowerCase();
  const max = 12;
  let suggestions = [];

  switch (context.type) {
    case 'column_of_table': {
      const tableKey = autocompleteIndex.tables.find(t => t.toLowerCase() === context.tableName.toLowerCase());
      if (tableKey && autocompleteIndex.columnsByTable[tableKey]) {
        suggestions = autocompleteIndex.columnsByTable[tableKey]
          .filter(c => !partial || c.toLowerCase().startsWith(partial))
          .map(c => ({ text: c, type: 'column', detail: tableKey }));
      }
      break;
    }
    case 'table':
      suggestions = autocompleteIndex.tables
        .filter(t => !partial || t.toLowerCase().startsWith(partial))
        .map(t => ({ text: t, type: 'table' }));
      break;
    case 'column':
      suggestions = autocompleteIndex.allColumns
        .filter(c => !partial || c.toLowerCase().startsWith(partial))
        .map(c => ({ text: c, type: 'column' }));
      break;
    case 'all': {
      const tableMatches = autocompleteIndex.tables
        .filter(t => t.toLowerCase().startsWith(partial))
        .map(t => ({ text: t, type: 'table' }));
      const colMatches = autocompleteIndex.allColumns
        .filter(c => c.toLowerCase().startsWith(partial))
        .map(c => ({ text: c, type: 'column' }));
      const kwMatches = autocompleteIndex.sqlKeywords
        .filter(k => k.toLowerCase().startsWith(partial))
        .map(k => ({ text: k, type: 'keyword' }));
      suggestions = [...tableMatches, ...colMatches, ...kwMatches];
      break;
    }
  }
  return suggestions.slice(0, max);
}

function getCaretCoordinates(textarea, position) {
  const mirror = document.createElement('div');
  const computed = getComputedStyle(textarea);
  const props = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
    'wordSpacing', 'whiteSpace', 'wordWrap', 'overflowWrap', 'padding',
    'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
    'border', 'borderWidth', 'boxSizing', 'tabSize', 'width'];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.overflow = 'hidden';
  mirror.style.height = 'auto';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  props.forEach(p => { mirror.style[p] = computed[p]; });
  document.body.appendChild(mirror);

  const textBefore = textarea.value.substring(0, position);
  const textNode = document.createTextNode(textBefore);
  mirror.appendChild(textNode);
  const span = document.createElement('span');
  span.textContent = '|';
  mirror.appendChild(span);

  const mirrorRect = mirror.getBoundingClientRect();
  const spanRect = span.getBoundingClientRect();
  const left = spanRect.left - mirrorRect.left;
  const top = spanRect.top - mirrorRect.top + parseFloat(computed.lineHeight || computed.fontSize);
  document.body.removeChild(mirror);

  return { left: left - textarea.scrollLeft, top: top - textarea.scrollTop };
}

function renderAutocompleteDropdown() {
  const existing = document.getElementById('db-autocomplete-dropdown');
  if (existing) existing.remove();

  const ac = panelState.autocomplete;
  if (!ac || ac.suggestions.length === 0) return;

  const dropdown = document.createElement('div');
  dropdown.id = 'db-autocomplete-dropdown';
  dropdown.className = 'db-autocomplete-dropdown';
  dropdown.style.left = ac.left + 'px';
  dropdown.style.top = ac.top + 'px';

  dropdown.innerHTML = ac.suggestions.map((s, i) => {
    const activeClass = i === ac.selectedIndex ? 'active' : '';
    const detailHtml = s.detail ? `<span class="db-ac-detail">${escapeHtml(s.detail)}</span>` : '';
    return `<div class="db-ac-item ${activeClass}" data-ac-idx="${i}">
      <span class="db-ac-icon-${s.type}"></span>
      <span class="db-ac-text">${escapeHtml(s.text)}</span>
      ${detailHtml}
    </div>`;
  }).join('');

  const editorWrap = document.querySelector('.db-query-highlight-wrap');
  if (editorWrap) {
    editorWrap.style.position = 'relative';
    editorWrap.appendChild(dropdown);
  }

  dropdown.querySelectorAll('.db-ac-item').forEach(item => {
    item.onmousedown = (e) => {
      e.preventDefault();
      applyAutocomplete(parseInt(item.dataset.acIdx));
    };
  });
}

function hideAutocomplete() {
  panelState.autocomplete = null;
  const existing = document.getElementById('db-autocomplete-dropdown');
  if (existing) existing.remove();
}

function applyAutocomplete(index) {
  const ac = panelState.autocomplete;
  if (!ac || !ac.suggestions[index]) return;

  const suggestion = ac.suggestions[index];
  const textarea = document.getElementById('database-query-input');
  if (!textarea) return;

  const state = require('../../state');
  const before = textarea.value.substring(0, ac.partialStart);
  const after = textarea.value.substring(textarea.selectionStart);

  textarea.value = before + suggestion.text + after;
  const newPos = ac.partialStart + suggestion.text.length;
  textarea.setSelectionRange(newPos, newPos);
  state.setCurrentQuery(textarea.value);

  // Sync highlight
  const highlightEl = document.getElementById('database-query-highlight');
  if (highlightEl) {
    const code = highlightEl.querySelector('code');
    const conn = state.getDatabaseConnection(state.getActiveConnection());
    const isMongo = conn && conn.type === 'mongodb';
    if (code) code.innerHTML = textarea.value ? highlight(textarea.value, isMongo ? 'js' : 'sql') + '\n' : '\n';
  }

  hideAutocomplete();
  textarea.focus();
}

function triggerAutocomplete(textarea) {
  if (!autocompleteIndex) { hideAutocomplete(); return; }

  const cursorPos = textarea.selectionStart;
  const text = textarea.value;
  const context = getAutocompleteContext(text, cursorPos);
  if (!context || context.partial.length === 0) { hideAutocomplete(); return; }

  const suggestions = getSuggestions(context);
  if (suggestions.length === 0) { hideAutocomplete(); return; }

  // Don't show if only exact match
  if (suggestions.length === 1 && suggestions[0].text.toLowerCase() === context.partial.toLowerCase()) { hideAutocomplete(); return; }

  const coords = getCaretCoordinates(textarea, cursorPos - context.partial.length);
  panelState.autocomplete = {
    suggestions,
    selectedIndex: 0,
    left: coords.left,
    top: coords.top,
    partial: context.partial,
    partialStart: cursorPos - context.partial.length
  };
  renderAutocompleteDropdown();
}

// ==================== History Section Builder ====================

function _buildHistorySection(state) {
  const history = state.getQueryHistory();
  if (history.length === 0) return '';

  const chevronSvg = '<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>';
  const xSvg = '<svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

  let listHtml = '';
  if (panelState.historyExpanded) {
    listHtml = `<div class="db-query-history-list">` +
      history.slice(0, 50).map(entry => {
        const sqlPreview = entry.sql.length > 120 ? entry.sql.substring(0, 120) + '...' : entry.sql;
        return `<div class="db-query-history-entry ${entry.success ? '' : 'error'}" data-history-id="${entry.id}">
          <div class="db-query-history-meta">
            <span class="db-query-history-time">${formatRelativeTime(entry.timestamp)}</span>
            <span class="db-query-history-duration">${entry.duration || 0}ms</span>
            ${entry.success
              ? `<span class="db-query-history-rows">${entry.rowCount ?? '?'} rows</span>`
              : `<span class="db-query-history-error-badge">${t('database.error')}</span>`
            }
          </div>
          <div class="db-query-history-sql">${escapeHtml(sqlPreview.replace(/\n/g, ' '))}</div>
          <button class="db-query-history-delete" data-history-delete="${entry.id}" title="${t('database.historyDelete')}">${xSvg}</button>
        </div>`;
      }).join('') +
    `</div>`;
  }

  return `<div class="db-query-history ${panelState.historyExpanded ? 'expanded' : ''}">
    <button class="db-query-history-toggle" id="db-history-toggle">
      ${chevronSvg}
      ${t('database.history')}
      <span class="db-query-history-count">${history.length}</span>
      ${history.length > 0 ? `<button class="db-query-history-clear" id="db-history-clear">${t('database.historyClearAll')}</button>` : ''}
    </button>
    ${listHtml}
  </div>`;
}

// ==================== Query Tab ====================

function renderQuery(container) {
  const state = require('../../state');
  const activeId = state.getActiveConnection();

  if (!activeId || state.getConnectionStatus(activeId) !== 'connected') {
    container.innerHTML = `<div class="database-empty-state"><div class="database-empty-text">${t('database.noActiveConnection')}</div></div>`;
    return;
  }

  // Ensure at least one tab exists
  let tabs = state.getQueryTabs();
  if (tabs.length === 0) {
    state.addQueryTab({ id: 'tab-1', name: 'Query 1', query: '' });
    tabs = state.getQueryTabs();
  }
  const activeTabId = state.getActiveQueryTabId();
  const activeTab = state.getActiveQueryTab();

  const conn = state.getDatabaseConnection(activeId);
  const isMongo = conn && conn.type === 'mongodb';
  const isRedis = conn && conn.type === 'redis';
  const placeholder = isMongo ? t('database.mongoPlaceholder') : isRedis ? 'GET mykey' : t('database.queryPlaceholder');
  const currentQuery = activeTab ? activeTab.query : '';
  const tabState = activeTab ? getTabState(activeTab.id) : { queryRunning: false, explainResult: null };
  const queryResult = activeTab ? state.getQueryResult(activeTab.id) : null;
  const isRunning = tabState.queryRunning || panelState.queryRunning;
  const templates = getQueryTemplates(isMongo, conn ? conn.type : 'mysql', isRedis);

  // Build autocomplete index if needed
  if (!isMongo && !isRedis) buildAutocompleteIndex();

  // Template chips
  const builtinChipsHtml = templates.map((tpl, i) => {
    const catClass = `db-query-tpl-${tpl.cat}`;
    return `<button class="db-query-tpl ${catClass}" data-tpl-idx="${i}" title="${escapeHtml(tpl.sql.replace(/\n/g, ' '))}">${tpl.icon} ${escapeHtml(tpl.label)}</button>`;
  }).join('');

  // Saved query chips
  const savedQueries = state.getSavedQueries();
  const savedChipsHtml = savedQueries.map((sq, i) => {
    return `<button class="db-query-tpl db-query-tpl-saved" data-saved-idx="${i}" title="${escapeHtml(sq.sql.replace(/\n/g, ' '))}">&#x2B50; ${escapeHtml(sq.name)}</button>`;
  }).join('');

  const templatesHtml = builtinChipsHtml + (savedQueries.length > 0 ? '<span class="db-query-tpl-divider"></span>' + savedChipsHtml : '');

  // Build results
  let resultsHtml = '';
  if (tabState.explainResult || panelState.explainResult) {
    resultsHtml = buildExplainView(tabState.explainResult || panelState.explainResult);
  } else if (queryResult) {
    if (queryResult.error) {
      resultsHtml = `<div class="db-query-error">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        ${escapeHtml(queryResult.error)}
      </div>`;
    } else {
      const stmtInfo = queryResult.statementsRun ? ` ${t('database.statementsRun', { count: queryResult.statementsRun })}` : '';
      const isDml = queryResult.rows && queryResult.rows.length === 1 && queryResult.columns &&
        (queryResult.columns.includes('affectedRows') || queryResult.columns.includes('changes'));

      if (isDml) {
        const row = queryResult.rows[0];
        const affected = row.affectedRows !== undefined ? row.affectedRows : row.changes;
        resultsHtml = `<div class="db-query-dml-result">
          <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          <span class="db-query-dml-text">${t('database.queryAffected', { count: affected })}${stmtInfo}</span>
          <span class="db-query-dml-time">${queryResult.duration || 0}ms</span>
        </div>`;
      } else {
        resultsHtml = `<div class="db-query-success">
          <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          ${t('database.querySuccess', { count: queryResult.rowCount || 0, duration: queryResult.duration || 0 })}${stmtInfo}
          <div class="db-export-wrap" style="margin-left:auto">
            <button class="db-browser-btn" id="db-query-export" title="${t('database.export')}">
              <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            </button>
            <div class="db-export-menu" id="db-query-export-menu">
              <button class="db-export-option" data-query-export="csv">CSV</button>
              <button class="db-export-option" data-query-export="json">JSON</button>
            </div>
          </div>
        </div>`;
        resultsHtml += buildResultsTable(queryResult);
      }
    }
  }

  // Tab bar HTML
  const tabBarHtml = `<div class="db-query-tab-bar">
    <div class="db-query-tabs-scroll">
      ${tabs.map(tab => `
        <div class="db-query-tab ${tab.id === activeTabId ? 'active' : ''}" data-tab-id="${escapeHtml(tab.id)}">
          <span class="db-query-tab-name" data-tab-name="${escapeHtml(tab.id)}">${escapeHtml(tab.name)}</span>
          ${tabs.length > 1 ? `<button class="db-query-tab-close" data-close-tab="${escapeHtml(tab.id)}" title="${t('database.closeTab')}"><svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>` : ''}
        </div>
      `).join('')}
    </div>
    <button class="db-query-tab-add" id="db-query-tab-add" title="${t('database.newTab')}">
      <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
    </button>
  </div>`;

  container.innerHTML = `
    <div class="db-query-layout">
      ${tabBarHtml}
      <div class="db-query-top">
        <div class="db-query-templates">${templatesHtml}</div>
        <div class="db-query-editor-wrap">
          <div class="db-query-highlight-wrap">
            <pre class="db-query-highlight" id="database-query-highlight" aria-hidden="true"><code>${currentQuery ? highlight(currentQuery, isMongo ? 'js' : 'sql') + '\n' : '\n'}</code></pre>
            <textarea class="database-query-editor" id="database-query-input" placeholder="${escapeHtml(placeholder)}" spellcheck="false">${escapeHtml(currentQuery)}</textarea>
          </div>
          <div class="db-query-actions">
            <button class="db-query-run" id="database-run-btn" ${isRunning ? 'disabled' : ''}>
              ${isRunning
                ? `<span class="db-query-run-spinner"></span> ${t('database.connecting')}`
                : `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg> ${t('database.runQuery')}`
              }
            </button>
            <button class="db-query-explain" id="database-explain-btn" ${isRunning || isMongo || isRedis ? 'disabled' : ''} title="${t('database.explainTooltip')}">
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
              ${t('database.explain')}
            </button>
            <button class="db-query-save" id="database-save-query-btn" title="${t('database.saveQuery')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            </button>
            <button class="db-query-clear" id="database-clear-btn" title="${t('database.queryClear')}">
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
            <label class="db-allow-destructive" title="${escapeHtml(t('database.allowDestructiveTooltip'))}">
              <input type="checkbox" id="database-allow-destructive" ${panelState.allowDestructive ? 'checked' : ''} />
              <span>${escapeHtml(t('database.allowDestructive'))}</span>
            </label>
            <span class="db-query-shortcut">${t('database.runQueryShortcut')}</span>
          </div>
        </div>
      </div>
      ${_buildHistorySection(state)}
      <div class="db-query-results">
        ${resultsHtml}
      </div>
    </div>`;

  // Bind events
  const runBtn = document.getElementById('database-run-btn');
  if (runBtn) runBtn.onclick = () => runQuery();

  const destructiveCheckbox = document.getElementById('database-allow-destructive');
  if (destructiveCheckbox) destructiveCheckbox.onchange = () => { panelState.allowDestructive = destructiveCheckbox.checked; };

  // Explain button
  const explainBtn = document.getElementById('database-explain-btn');
  if (explainBtn) explainBtn.onclick = () => runExplain();

  const clearBtn = document.getElementById('database-clear-btn');
  if (clearBtn) clearBtn.onclick = () => {
    state.setCurrentQuery('');
    if (activeTab) {
      state.setQueryResult(activeTab.id, null);
      getTabState(activeTab.id).explainResult = null;
    } else {
      state.setQueryResult(activeId, null);
    }
    panelState.explainResult = null;
    renderContent();
  };

  // Save query button
  const saveQueryBtn = document.getElementById('database-save-query-btn');
  if (saveQueryBtn) saveQueryBtn.onclick = () => {
    const sql = state.getCurrentQuery().trim();
    if (!sql) return;
    showSaveQueryModal(sql);
  };

  const input = document.getElementById('database-query-input');
  const highlightEl = document.getElementById('database-query-highlight');
  const syncHighlight = () => {
    if (highlightEl && input) {
      const code = highlightEl.querySelector('code');
      if (code) code.innerHTML = input.value ? highlight(input.value, isMongo ? 'js' : 'sql') + '\n' : '\n';
    }
  };
  const syncScroll = () => {
    if (highlightEl && input) {
      highlightEl.scrollTop = input.scrollTop;
      highlightEl.scrollLeft = input.scrollLeft;
    }
  };
  if (input) {
    input.onkeydown = (e) => {
      // Autocomplete keyboard navigation
      if (panelState.autocomplete && panelState.autocomplete.suggestions.length > 0) {
        const ac = panelState.autocomplete;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          ac.selectedIndex = (ac.selectedIndex + 1) % ac.suggestions.length;
          renderAutocompleteDropdown();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          ac.selectedIndex = (ac.selectedIndex - 1 + ac.suggestions.length) % ac.suggestions.length;
          renderAutocompleteDropdown();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          applyAutocomplete(ac.selectedIndex);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          hideAutocomplete();
          return;
        }
      }
      // Ctrl+Enter to run query
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        runQuery();
      }
    };
    input.oninput = () => {
      state.setCurrentQuery(input.value);
      syncHighlight();
      triggerAutocomplete(input);
    };
    input.onblur = () => {
      setTimeout(() => hideAutocomplete(), 150);
    };
    input.onscroll = syncScroll;
  }

  // Built-in template click handlers
  container.querySelectorAll('.db-query-tpl[data-tpl-idx]').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.tplIdx);
      const tpl = templates[idx];
      if (!tpl) return;
      const textarea = document.getElementById('database-query-input');
      if (textarea) {
        textarea.value = tpl.sql;
        textarea.focus();
        state.setCurrentQuery(tpl.sql);
        syncHighlight();
      }
    };
  });

  // Saved query chip handlers
  container.querySelectorAll('.db-query-tpl-saved').forEach(btn => {
    const idx = parseInt(btn.dataset.savedIdx);
    const sq = savedQueries[idx];
    if (!sq) return;

    btn.onclick = () => {
      const textarea = document.getElementById('database-query-input');
      if (textarea) {
        textarea.value = sq.sql;
        textarea.focus();
        state.setCurrentQuery(sq.sql);
        syncHighlight();
      }
    };

    btn.oncontextmenu = (e) => {
      e.preventDefault();
      if (confirm(t('database.deleteSavedQuery') + ` "${sq.name}"?`)) {
        state.removeSavedQuery(sq.id);
        renderContent();
      }
    };
  });

  // History toggle
  const historyToggle = document.getElementById('db-history-toggle');
  if (historyToggle) historyToggle.onclick = (e) => {
    if (e.target.closest('#db-history-clear')) return;
    panelState.historyExpanded = !panelState.historyExpanded;
    renderContent();
  };

  // History clear all
  const historyClear = document.getElementById('db-history-clear');
  if (historyClear) historyClear.onclick = (e) => {
    e.stopPropagation();
    state.clearQueryHistory();
    renderContent();
  };

  // History entry click -> load, delete button
  container.querySelectorAll('.db-query-history-entry').forEach(el => {
    el.onclick = (e) => {
      if (e.target.closest('.db-query-history-delete')) return;
      const id = el.dataset.historyId;
      const entry = state.getQueryHistory().find(h => h.id === id);
      if (entry) {
        const textarea = document.getElementById('database-query-input');
        if (textarea) {
          textarea.value = entry.sql;
          textarea.focus();
          state.setCurrentQuery(entry.sql);
          syncHighlight();
        }
      }
    };
  });
  container.querySelectorAll('.db-query-history-delete').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      state.removeQueryHistoryEntry(btn.dataset.historyDelete);
      renderContent();
    };
  });

  // Export button (query results)
  const queryExportBtn = document.getElementById('db-query-export');
  const queryExportMenu = document.getElementById('db-query-export-menu');
  if (queryExportBtn && queryExportMenu) {
    queryExportBtn.onclick = (e) => {
      e.stopPropagation();
      queryExportMenu.classList.toggle('open');
    };
  }
  container.querySelectorAll('[data-query-export]').forEach(btn => {
    btn.onclick = () => {
      queryExportMenu && queryExportMenu.classList.remove('open');
      const result = activeTab ? state.getQueryResult(activeTab.id) : state.getQueryResult(activeId);
      exportResults(btn.dataset.queryExport, result, 'query-results');
    };
  });

  // Column resize (query results)
  const resultsWrapper = container.querySelector('.database-results-wrapper');
  if (resultsWrapper) {
    setupColumnResize(resultsWrapper, 'queryResultColumnWidths', null);
  }

  // Cell expand buttons (query results)
  container.querySelectorAll('.db-cell-expand-btn[data-expand-qcol]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const col = btn.dataset.expandQcol;
      const rowIdx = parseInt(btn.dataset.expandQrow);
      const result = activeTab ? state.getQueryResult(activeTab.id) : state.getQueryResult(activeId);
      if (!result || !result.rows || !result.rows[rowIdx]) return;
      const val = result.rows[rowIdx][col];
      showCellViewerModal(val, col, null);
    };
  });

  // === Query Tab Events ===
  // Tab click to switch
  container.querySelectorAll('.db-query-tab').forEach(tab => {
    tab.onclick = (e) => {
      if (e.target.closest('.db-query-tab-close')) return;
      const tabId = tab.dataset.tabId;
      if (tabId !== activeTabId) {
        // Save current query text before switching
        const textarea = document.getElementById('database-query-input');
        if (textarea && activeTab) {
          state.updateQueryTab(activeTab.id, { query: textarea.value });
        }
        state.setActiveQueryTabId(tabId);
        renderContent();
      }
    };
  });

  // Close tab
  container.querySelectorAll('.db-query-tab-close').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      state.removeQueryTab(btn.dataset.closeTab);
      renderContent();
    };
  });

  // Add tab
  const addTabBtn = document.getElementById('db-query-tab-add');
  if (addTabBtn) addTabBtn.onclick = () => {
    // Save current query first
    const textarea = document.getElementById('database-query-input');
    if (textarea && activeTab) {
      state.updateQueryTab(activeTab.id, { query: textarea.value });
    }
    const tabId = 'tab-' + Date.now().toString(36);
    const tabNum = state.getQueryTabs().length + 1;
    state.addQueryTab({ id: tabId, name: `Query ${tabNum}`, query: '' });
    renderContent();
  };

  // Double-click tab name to rename
  container.querySelectorAll('.db-query-tab-name').forEach(nameEl => {
    nameEl.ondblclick = (e) => {
      e.stopPropagation();
      const tabId = nameEl.dataset.tabName;
      const tab = state.getQueryTabs().find(t => t.id === tabId);
      if (!tab) return;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'db-query-tab-rename-input';
      input.value = tab.name;
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      const finish = () => {
        const newName = input.value.trim() || tab.name;
        state.updateQueryTab(tabId, { name: newName });
        renderContent();
      };
      input.onblur = finish;
      input.onkeydown = (ke) => {
        if (ke.key === 'Enter') { ke.preventDefault(); finish(); }
        if (ke.key === 'Escape') { ke.preventDefault(); renderContent(); }
      };
    };
  });
}

async function exportResults(format, data, sourceName) {
  if (!data || !data.columns || !data.rows || data.rows.length === 0) {
    ctx.showToast({ type: 'warning', title: t('database.exportNoData') });
    return;
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const defaultName = `${sourceName || 'query-results'}-${dateStr}.${format}`;
  const { fs } = window.electron_nodeModules;

  if (format === 'csv') {
    const header = data.columns.join(',');
    const rows = data.rows.map(row =>
      data.columns.map(col => {
        const val = row[col];
        if (val === null || val === undefined) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      }).join(',')
    );
    const csvContent = [header, ...rows].join('\n');

    const filePath = await ctx.api.dialog.saveFileDialog({
      defaultPath: defaultName,
      title: t('database.exportTitle'),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (filePath) {
      fs.writeFileSync(filePath, '\uFEFF' + csvContent, 'utf8');
      ctx.showToast({ type: 'success', title: t('database.exportSuccess') });
    }
  } else {
    const jsonData = data.rows.map(row => {
      const obj = {};
      for (const col of data.columns) obj[col] = row[col];
      return obj;
    });

    const filePath = await ctx.api.dialog.saveFileDialog({
      defaultPath: defaultName,
      title: t('database.exportTitle'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (filePath) {
      fs.writeFileSync(filePath, JSON.stringify(jsonData, null, 2), 'utf8');
      ctx.showToast({ type: 'success', title: t('database.exportSuccess') });
    }
  }
}

function buildResultsTable(result) {
  if (!result.columns || result.columns.length === 0 || !result.rows || result.rows.length === 0) {
    return '';
  }

  const storedWidths = panelState.queryResultColumnWidths;
  let html = `<div class="database-results-wrapper"><table class="database-results-table"><thead><tr>`;
  for (const col of result.columns) {
    const w = storedWidths[col];
    const widthStyle = w ? ` style="width:${w}px;min-width:${w}px"` : '';
    html += `<th${widthStyle}>${escapeHtml(String(col))}<div class="db-grid-resize-handle" data-resize-col="${escapeHtml(String(col))}"></div></th>`;
  }
  html += `</tr></thead><tbody>`;

  for (const row of result.rows) {
    html += '<tr>';
    for (const col of result.columns) {
      const val = row[col];
      const display = val === null ? '<span class="null-value">NULL</span>' : escapeHtml(String(val));
      html += `<td>${display}<button class="db-cell-expand-btn" data-expand-qcol="${escapeHtml(String(col))}" data-expand-qrow="${result.rows.indexOf(row)}" title="${t('database.cellExpand')}"><svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10"><path d="M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z"/></svg></button></td>`;
    }
    html += '</tr>';
  }

  html += `</tbody></table></div>`;
  return html;
}

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let inString = false;
  let stringChar = '';
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') { current += '/'; i++; inBlockComment = false; }
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === stringChar && next === stringChar) { current += next; i++; }
      else if (ch === stringChar) inString = false;
      continue;
    }

    if (ch === '\'' || ch === '"' || ch === '`') { inString = true; stringChar = ch; current += ch; continue; }
    if (ch === '-' && next === '-') { inLineComment = true; current += ch; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; current += ch; continue; }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }
    current += ch;
  }
  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

function _generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

function _recordHistory(state, sql, conn, activeId, result, duration) {
  state.addQueryHistoryEntry({
    id: _generateId(),
    timestamp: Date.now(),
    sql,
    connectionId: activeId,
    connectionName: conn ? conn.name : '',
    dbType: conn ? conn.type : '',
    duration: duration || result.duration || 0,
    rowCount: result.error ? null : (result.rowCount ?? result.rows?.length ?? null),
    error: result.error || null,
    success: !result.error
  });
}

async function runQuery() {
  const state = require('../../state');
  const activeId = state.getActiveConnection();
  if (!activeId) return;

  const conn = state.getDatabaseConnection(activeId);
  const isMongo = conn && conn.type === 'mongodb';

  const activeTab = state.getActiveQueryTab ? state.getActiveQueryTab() : null;
  const input = document.getElementById('database-query-input');
  const sql = input ? input.value.trim() : (activeTab ? activeTab.query : state.getCurrentQuery()).trim();
  if (!sql) return;

  // Save query text to tab
  if (activeTab && input) state.updateQueryTab(activeTab.id, { query: input.value });

  const tabId = activeTab ? activeTab.id : null;
  if (tabId) {
    getTabState(tabId).queryRunning = true;
    getTabState(tabId).explainResult = null;
  }
  panelState.queryRunning = true;
  panelState.explainResult = null;
  renderContent();

  try {
    // MongoDB: send as-is (not SQL, no semicolon splitting)
    if (isMongo) {
      const result = await ctx.api.database.executeQuery({ id: activeId, sql, limit: 100, allowDestructive: panelState.allowDestructive });
      state.setQueryResult(tabId || activeId, result);
      _recordHistory(state, sql, conn, activeId, result, result.duration);
    } else {
      const statements = splitSqlStatements(sql);
      if (statements.length === 0) {
        panelState.queryRunning = false;
        renderContent();
        return;
      }

      let lastResult = null;
      let totalDuration = 0;
      let totalAffected = 0;
      let statementsRun = 0;

      for (const stmt of statements) {
        const result = await ctx.api.database.executeQuery({ id: activeId, sql: stmt, limit: 100, allowDestructive: panelState.allowDestructive });
        statementsRun++;
        totalDuration += result.duration || 0;

        if (result.error) {
          const errorResult = {
            error: t('database.statementError', { current: statementsRun, total: statements.length, error: result.error }),
            duration: totalDuration
          };
          state.setQueryResult(tabId || activeId, errorResult);
          _recordHistory(state, sql, conn, activeId, errorResult, totalDuration);
          if (tabId) getTabState(tabId).queryRunning = false;
          panelState.queryRunning = false;
          renderContent();
          return;
        }

        // Track affected rows for non-SELECT statements
        if (result.rows && result.rows[0] && result.rows[0].affectedRows !== undefined) {
          totalAffected += result.rows[0].affectedRows;
        }
        lastResult = result;
      }

      // If multiple statements and last one was non-SELECT, show aggregate
      if (statements.length > 1 && lastResult && lastResult.rows && lastResult.rows[0] && lastResult.rows[0].affectedRows !== undefined) {
        lastResult.rows = [{ affectedRows: totalAffected, insertId: lastResult.rows[0].insertId }];
      }
      lastResult.duration = totalDuration;
      if (statements.length > 1) {
        lastResult.statementsRun = statementsRun;
      }
      state.setQueryResult(tabId || activeId, lastResult);
      _recordHistory(state, sql, conn, activeId, lastResult, totalDuration);
    }
  } catch (e) {
    const errorResult = { error: e.message };
    state.setQueryResult(tabId || activeId, errorResult);
    _recordHistory(state, sql, conn, activeId, errorResult, 0);
  }

  if (tabId) getTabState(tabId).queryRunning = false;
  panelState.queryRunning = false;
  renderContent();
}

// ==================== Actions ====================

async function connectDatabase(id) {
  const state = require('../../state');
  const conn = state.getDatabaseConnection(id);
  if (!conn) return;

  // Auto-disconnect previous connection if any
  const previousId = state.getActiveConnection();
  if (previousId && previousId !== id && state.getConnectionStatus(previousId) === 'connected') {
    await ctx.api.database.disconnect({ id: previousId }).catch(() => {});
    state.setConnectionStatus(previousId, 'disconnected');
    state.setDatabaseSchema(previousId, null);
  }

  state.setConnectionStatus(id, 'connecting');
  state.setActiveConnection(id);
  renderContent();

  // Retrieve password from keychain if needed
  let config = { ...conn };
  if (conn.type !== 'sqlite') {
    const cred = await ctx.api.database.getCredential({ id });
    if (cred.success && cred.password) {
      config.password = cred.password;
    }
  }

  const result = await ctx.api.database.connect({ id, config });
  state.setConnectionStatus(id, result.success ? 'connected' : 'error');

  if (result.success) {
    ctx.showToast({ type: 'success', title: t('database.connectionSuccess') });
    loadSchema(id);
  } else {
    ctx.showToast({ type: 'error', title: t('database.connectionFailed', { error: result.error }) });
  }

  renderContent();
}

async function disconnectDatabase(id) {
  const state = require('../../state');
  await ctx.api.database.disconnect({ id });
  state.setConnectionStatus(id, 'disconnected');
  state.setDatabaseSchema(id, null);
  renderContent();
}

async function deleteConnection(id) {
  if (!confirm(t('database.deleteConfirm'))) return;

  const state = require('../../state');
  const conn = state.getDatabaseConnection(id);

  // Disconnect if connected
  if (state.getConnectionStatus(id) === 'connected') {
    await ctx.api.database.disconnect({ id });
  }

  // Delete credential
  await ctx.api.database.setCredential({ id, password: '' }).catch(() => {});

  state.removeDatabaseConnection(id);
  await saveConnections();
  renderContent();
}


async function runAutoDetect() {
  const state = require('../../state');
  const projects = state.projectsState ? state.projectsState.get().projects : ctx.projectsState.get().projects;
  const openedId = projects.length > 0 ? (state.projectsState || ctx.projectsState).get().openedProjectId : null;
  const project = openedId ? projects.find(p => p.id === openedId) : projects[0];

  if (!project || !project.path) {
    ctx.showToast({ type: 'warning', title: t('database.noDetected') });
    return;
  }

  ctx.showToast({ type: 'info', title: t('database.detecting') });
  const detected = await ctx.api.database.detect({ projectPath: project.path });

  if (detected && detected.length > 0) {
    // Tag detected with project id
    const tagged = detected.map(d => ({ ...d, projectId: project.id }));
    state.setDetectedDatabases(tagged);
    ctx.showToast({ type: 'success', title: t('database.detectedDatabases', { count: detected.length }) });
  } else {
    state.setDetectedDatabases([]);
    ctx.showToast({ type: 'info', title: t('database.noDetected') });
  }

  renderContent();
}

function importDetected(jsonStr) {
  try {
    const d = JSON.parse(jsonStr);
    showConnectionForm(null, d);
  } catch (e) { /* ignore */ }
}

// ==================== Connection Form ====================

function showConnectionForm(editId, prefill) {
  const state = require('../../state');
  const existing = editId ? state.getDatabaseConnection(editId) : null;
  const data = existing || prefill || {};

  const projects = (state.projectsState || ctx.projectsState).get().projects || [];

  const html = `
    <div class="database-form">
      <div class="database-form-row">
        <div class="database-form-group database-form-grow">
          <label class="database-form-label">${t('database.name')}</label>
          <input type="text" class="database-form-input" id="db-form-name" value="${escapeHtml(data.name || '')}" placeholder="My Database">
        </div>
        <div class="database-form-group">
          <label class="database-form-label">${t('database.type')}</label>
          <select class="database-form-select" id="db-form-type">
            <option value="sqlite"     ${data.type === 'sqlite'     ? 'selected' : ''}>SQLite</option>
            <option value="mysql"      ${data.type === 'mysql'      ? 'selected' : ''}>MySQL</option>
            <option value="mariadb"    ${data.type === 'mariadb'    ? 'selected' : ''}>MariaDB</option>
            <option value="postgresql" ${data.type === 'postgresql' ? 'selected' : ''}>PostgreSQL</option>
            <option value="mongodb"    ${data.type === 'mongodb'    ? 'selected' : ''}>MongoDB</option>
            <option value="redis"      ${data.type === 'redis'      ? 'selected' : ''}>Redis</option>
          </select>
        </div>
      </div>
      <div id="db-form-fields"></div>
      <div class="database-form-group">
        <label class="database-form-label">${t('database.linkToProject')}</label>
        <select class="database-form-select" id="db-form-project">
          <option value="">${t('database.noProject')}</option>
          ${projects.map(p => `<option value="${escapeHtml(p.id)}" ${data.projectId === p.id ? 'selected' : ''}>${escapeHtml(p.name || p.path)}</option>`).join('')}
        </select>
      </div>
      <div class="database-form-test-section">
        <button class="database-form-test-btn" id="db-form-test">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
          ${t('database.testConnection')}
        </button>
        <div class="database-form-test-result" id="db-form-test-result"></div>
      </div>
    </div>`;

  const footer = `
    <button class="btn-secondary" id="db-form-cancel">${t('database.cancel')}</button>
    <button class="btn-primary" id="db-form-save">${t('database.save')}</button>`;

  ctx.showModal(editId ? t('database.editConnection') : t('database.addConnection'), html, footer);

  // Setup type-dependent fields
  const typeSelect = document.getElementById('db-form-type');
  const updateFields = () => renderFormFields(data, typeSelect.value);
  typeSelect.onchange = () => updateFields();
  updateFields();

  // Test button
  document.getElementById('db-form-test').onclick = async () => {
    const config = collectFormData();
    const testBtn = document.getElementById('db-form-test');
    const resultEl = document.getElementById('db-form-test-result');
    testBtn.disabled = true;
    testBtn.classList.add('testing');
    resultEl.textContent = t('database.testing');
    resultEl.className = 'database-form-test-result';

    const result = await ctx.api.database.testConnection(config);
    testBtn.disabled = false;
    testBtn.classList.remove('testing');
    if (result.success) {
      resultEl.textContent = t('database.connectionSuccess');
      resultEl.className = 'database-form-test-result success';
    } else {
      resultEl.textContent = t('database.connectionFailed', { error: result.error });
      resultEl.className = 'database-form-test-result error';
    }
  };

  // Save
  document.getElementById('db-form-save').onclick = async () => {
    const config = collectFormData();
    if (!config.name) config.name = `${config.type} - ${config.database || config.filePath || 'default'}`;

    const id = editId || `db-${Date.now()}`;
    const password = config.password;
    delete config.password;

    if (editId) {
      state.updateDatabaseConnection(editId, config);
    } else {
      state.addDatabaseConnection({ ...config, id });
    }

    // Store password
    if (password) {
      await ctx.api.database.setCredential({ id, password });
    }

    await saveConnections();
    ctx.closeModal();
    renderContent();
  };

  // Cancel
  document.getElementById('db-form-cancel').onclick = () => ctx.closeModal();
}

function renderFormFields(data, type) {
  const container = document.getElementById('db-form-fields');
  if (!container) return;

  if (type === 'sqlite') {
    container.innerHTML = `
      <div class="database-form-group">
        <label class="database-form-label">${t('database.filePath')}</label>
        <div class="database-form-input-row">
          <input type="text" class="database-form-input database-form-grow" id="db-form-filepath" value="${escapeHtml(data.filePath || '')}" placeholder="/path/to/database.db">
          <button class="database-form-browse-btn" id="db-form-browse">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
            ${t('database.browse')}
          </button>
        </div>
      </div>`;
    const browseBtn = document.getElementById('db-form-browse');
    if (browseBtn) {
      browseBtn.onclick = async () => {
        const result = await ctx.api.dialog.openFile({ filters: [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] }] });
        if (result) document.getElementById('db-form-filepath').value = result;
      };
    }
  } else if (type === 'mongodb') {
    container.innerHTML = `
      <div class="database-form-group">
        <label class="database-form-label">${t('database.connectionString')}</label>
        <input type="text" class="database-form-input" id="db-form-connstring" value="${escapeHtml(data.connectionString || '')}" placeholder="mongodb://localhost:27017/mydb">
      </div>
      <div class="database-form-group">
        <label class="database-form-label">${t('database.databaseName')}</label>
        <input type="text" class="database-form-input" id="db-form-database" value="${escapeHtml(data.database || '')}" placeholder="mydb">
      </div>`;
  } else if (type === 'redis') {
    container.innerHTML = `
      <div class="database-form-row">
        <div class="database-form-group database-form-grow-2">
          <label class="database-form-label">${t('database.host')}</label>
          <input type="text" class="database-form-input" id="db-form-host" value="${escapeHtml(data.host || 'localhost')}" placeholder="localhost">
        </div>
        <div class="database-form-group database-form-grow">
          <label class="database-form-label">${t('database.port')}</label>
          <input type="number" class="database-form-input" id="db-form-port" value="${escapeHtml(String(data.port || '6379'))}" placeholder="6379">
        </div>
      </div>
      <div class="database-form-row">
        <div class="database-form-group database-form-grow">
          <label class="database-form-label">${t('database.password')} <span style="color:var(--text-muted)">(${t('database.optional') || 'optional'})</span></label>
          <input type="password" class="database-form-input" id="db-form-password" value="" placeholder="********">
        </div>
        <div class="database-form-group database-form-grow">
          <label class="database-form-label">Database index</label>
          <input type="number" class="database-form-input" id="db-form-database" min="0" max="15" value="${escapeHtml(String(data.database || '0'))}" placeholder="0">
        </div>
      </div>`;
  } else {
    // MySQL / MariaDB / PostgreSQL
    const defaultPort = (type === 'mysql' || type === 'mariadb') ? '3306' : '5432';
    const placeholder = type === 'postgresql' ? 'postgresql://user:pass@host:5432/dbname' : 'mysql://user:pass@host:3306/dbname';
    container.innerHTML = `
      <div class="database-form-connstring-toggle">
        <button class="database-form-toggle-btn active" data-mode="fields" id="db-form-mode-fields">${t('database.inputFields')}</button>
        <button class="database-form-toggle-btn" data-mode="uri" id="db-form-mode-uri">${t('database.inputConnectionString')}</button>
      </div>
      <div id="db-form-fields-area">
        <div class="database-form-row">
          <div class="database-form-group database-form-grow-2">
            <label class="database-form-label">${t('database.host')}</label>
            <input type="text" class="database-form-input" id="db-form-host" value="${escapeHtml(data.host || 'localhost')}" placeholder="localhost">
          </div>
          <div class="database-form-group database-form-grow">
            <label class="database-form-label">${t('database.port')}</label>
            <input type="number" class="database-form-input" id="db-form-port" value="${escapeHtml(String(data.port || defaultPort))}" placeholder="${defaultPort}">
          </div>
        </div>
        <div class="database-form-group">
          <label class="database-form-label">${t('database.databaseName')}</label>
          <input type="text" class="database-form-input" id="db-form-database" value="${escapeHtml(data.database || '')}" placeholder="mydb">
        </div>
        <div class="database-form-row">
          <div class="database-form-group database-form-grow">
            <label class="database-form-label">${t('database.username')}</label>
            <input type="text" class="database-form-input" id="db-form-username" value="${escapeHtml(data.username || '')}" placeholder="user">
          </div>
          <div class="database-form-group database-form-grow">
            <label class="database-form-label">${t('database.password')}</label>
            <input type="password" class="database-form-input" id="db-form-password" value="" placeholder="********">
          </div>
        </div>
      </div>
      <div id="db-form-uri-area" style="display:none">
        <div class="database-form-group">
          <label class="database-form-label">${t('database.connectionString')}</label>
          <input type="text" class="database-form-input" style="font-family:'Cascadia Code',monospace;font-size:12px" id="db-form-connstring-input" value="" placeholder="${placeholder}">
        </div>
      </div>`;

    // Toggle handlers
    const fieldsBtn = document.getElementById('db-form-mode-fields');
    const uriBtn = document.getElementById('db-form-mode-uri');
    const fieldsArea = document.getElementById('db-form-fields-area');
    const uriArea = document.getElementById('db-form-uri-area');
    const connInput = document.getElementById('db-form-connstring-input');

    if (fieldsBtn && uriBtn) {
      uriBtn.onclick = () => {
        fieldsBtn.classList.remove('active');
        uriBtn.classList.add('active');
        if (fieldsArea) fieldsArea.style.display = 'none';
        if (uriArea) uriArea.style.display = '';
        // Build URI from current field values
        if (connInput) {
          const cfg = {
            host: document.getElementById('db-form-host')?.value || 'localhost',
            port: parseInt(document.getElementById('db-form-port')?.value) || parseInt(defaultPort),
            database: document.getElementById('db-form-database')?.value || '',
            username: document.getElementById('db-form-username')?.value || '',
            password: document.getElementById('db-form-password')?.value || '',
          };
          connInput.value = buildConnectionString(type, cfg);
        }
      };
      fieldsBtn.onclick = () => {
        uriBtn.classList.remove('active');
        fieldsBtn.classList.add('active');
        if (uriArea) uriArea.style.display = 'none';
        if (fieldsArea) fieldsArea.style.display = '';
        // Parse URI back into fields
        if (connInput && connInput.value.trim()) {
          const parsed = parseConnectionString(type, connInput.value.trim());
          if (parsed) {
            const hostEl = document.getElementById('db-form-host');
            const portEl = document.getElementById('db-form-port');
            const dbEl = document.getElementById('db-form-database');
            const userEl = document.getElementById('db-form-username');
            const passEl = document.getElementById('db-form-password');
            if (hostEl) hostEl.value = parsed.host;
            if (portEl) portEl.value = parsed.port;
            if (dbEl) dbEl.value = parsed.database;
            if (userEl) userEl.value = parsed.username;
            if (passEl) passEl.value = parsed.password;
          }
        }
      };
    }
  }
}

function collectFormData() {
  const type = document.getElementById('db-form-type').value;
  const name = document.getElementById('db-form-name').value.trim();
  const projectId = document.getElementById('db-form-project').value || null;

  const config = { type, name, projectId };

  if (type === 'sqlite') {
    config.filePath = document.getElementById('db-form-filepath')?.value.trim() || '';
  } else if (type === 'mongodb') {
    config.connectionString = document.getElementById('db-form-connstring')?.value.trim() || '';
    config.database = document.getElementById('db-form-database')?.value.trim() || '';
  } else if (type === 'redis') {
    config.host = document.getElementById('db-form-host')?.value.trim() || 'localhost';
    config.port = parseInt(document.getElementById('db-form-port')?.value) || 6379;
    config.password = document.getElementById('db-form-password')?.value || '';
    config.database = parseInt(document.getElementById('db-form-database')?.value) || 0;
  } else {
    // Check if URI mode is active
    const connStringInput = document.getElementById('db-form-connstring-input');
    const uriArea = document.getElementById('db-form-uri-area');
    if (connStringInput && uriArea && uriArea.style.display !== 'none' && connStringInput.value.trim()) {
      const parsed = parseConnectionString(type, connStringInput.value.trim());
      if (parsed) {
        config.host = parsed.host;
        config.port = parsed.port;
        config.database = parsed.database;
        config.username = parsed.username;
        config.password = parsed.password;
      }
    } else {
      config.host = document.getElementById('db-form-host')?.value.trim() || 'localhost';
      config.port = parseInt(document.getElementById('db-form-port')?.value) || ((type === 'mysql' || type === 'mariadb') ? 3306 : 5432);
      config.database = document.getElementById('db-form-database')?.value.trim() || '';
      config.username = document.getElementById('db-form-username')?.value.trim() || '';
      config.password = document.getElementById('db-form-password')?.value || '';
    }
  }

  return config;
}

// ==================== Helpers ====================

async function saveConnections() {
  const state = require('../../state');
  const connections = state.getDatabaseConnections();
  await ctx.api.database.saveConnections({ connections });
  // Refresh global MCP config (passwords env vars, connection list)
  await ctx.api.database.refreshMcp().catch(() => {});
}

function getProject(id) {
  const state = require('../../state');
  const projects = (state.projectsState || ctx.projectsState).get().projects || [];
  return projects.find(p => p.id === id);
}

function getProjectName(id) {
  const project = getProject(id);
  return project ? (project.name || ctx.path.basename(project.path)) : '';
}

// ==================== Cell Value Viewer ====================

function showCellViewerModal(value, columnName, dataType) {
  const isNull = value === null || value === undefined;
  const strVal = isNull ? '' : String(value);
  const length = isNull ? 0 : strVal.length;

  let displayHtml;
  let isJson = false;
  if (!isNull) {
    try {
      const parsed = JSON.parse(strVal);
      isJson = true;
      displayHtml = highlight(JSON.stringify(parsed, null, 2), 'json');
    } catch (_) {
      displayHtml = escapeHtml(strVal);
    }
  } else {
    displayHtml = '<span class="null-value">NULL</span>';
  }

  const content = `
    <div class="db-cell-viewer">
      <div class="db-cell-viewer-meta">
        <span class="db-cell-viewer-col">${escapeHtml(columnName)}</span>
        <span class="db-cell-viewer-type">${escapeHtml(dataType || 'unknown')}</span>
        <span class="db-cell-viewer-length">${isNull ? 'NULL' : `${length} chars`}</span>
        ${isJson ? '<span class="db-cell-viewer-badge">JSON</span>' : ''}
      </div>
      <pre class="db-cell-viewer-content${isJson ? ' json' : ''}">${displayHtml}</pre>
    </div>`;

  const modal = createModal({
    id: 'cell-viewer-modal',
    title: t('database.cellViewer'),
    content,
    size: 'medium',
    buttons: [
      { label: t('database.cellCopy'), action: 'copy', onClick: () => {
        navigator.clipboard.writeText(strVal);
        ctx.showToast({ type: 'success', title: t('database.cellCopied') });
      }},
      { label: t('database.close') || 'Close', action: 'close', primary: true, onClick: (m) => closeModal(m) }
    ]
  });
  showModal(modal);
}

// ==================== Sidebar Resize ====================

function setupSidebarResize(container) {
  const handle = container.querySelector('.db-browser-resize-handle');
  if (!handle) return;

  handle.onmousedown = (e) => {
    e.preventDefault();
    const sidebar = container.querySelector('.db-browser-sidebar');
    if (!sidebar) return;
    const startX = e.clientX;
    const startWidth = sidebar.offsetWidth;

    const onMouseMove = (moveEvt) => {
      const delta = moveEvt.clientX - startX;
      const newWidth = Math.max(180, Math.min(400, startWidth + delta));
      sidebar.style.width = newWidth + 'px';
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      panelState.browserSidebarWidth = sidebar.offsetWidth;
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };
}

// ==================== EXPLAIN / Query Plan ====================

function getTabState(tabId) {
  if (!panelState.tabStates[tabId]) {
    panelState.tabStates[tabId] = { queryRunning: false, explainResult: null, queryResultColumnWidths: {} };
  }
  return panelState.tabStates[tabId];
}

async function runExplain() {
  const state = require('../../state');
  const activeId = state.getActiveConnection();
  if (!activeId) return;

  const conn = state.getDatabaseConnection(activeId);
  if (!conn || conn.type === 'mongodb' || conn.type === 'redis') return;

  const activeTab = state.getActiveQueryTab ? state.getActiveQueryTab() : null;
  const input = document.getElementById('database-query-input');
  let sql = input ? input.value.trim() : (activeTab ? activeTab.query : state.getCurrentQuery()).trim();
  if (!sql) return;

  // Strip existing EXPLAIN prefix
  sql = sql.replace(/^\s*EXPLAIN\s+(ANALYZE\s+)?(QUERY\s+PLAN\s+)?(FORMAT\s*=?\s*\w+\s+)?/i, '').trim();
  if (!sql) return;

  let explainSql;
  switch (conn.type) {
    case 'postgresql':
      explainSql = `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`;
      break;
    case 'mysql':
    case 'mariadb':
      explainSql = `EXPLAIN FORMAT=JSON ${sql}`;
      break;
    case 'sqlite':
      explainSql = `EXPLAIN QUERY PLAN ${sql}`;
      break;
    default:
      explainSql = `EXPLAIN ${sql}`;
  }

  const tabId = activeTab ? activeTab.id : null;
  if (tabId) {
    getTabState(tabId).queryRunning = true;
  } else {
    panelState.queryRunning = true;
  }
  renderContent();

  try {
    const result = await ctx.api.database.executeQuery({
      id: activeId, sql: explainSql, limit: 1000, allowDestructive: false
    });
    if (result.error) {
      if (tabId) {
        state.setQueryResult(tabId, result);
        getTabState(tabId).explainResult = null;
      } else {
        state.setQueryResult(activeId, result);
        panelState.explainResult = null;
      }
    } else {
      if (tabId) {
        getTabState(tabId).explainResult = { dbType: conn.type, rawResult: result, sql };
        state.setQueryResult(tabId, null);
      } else {
        panelState.explainResult = { dbType: conn.type, rawResult: result, sql };
        state.setQueryResult(activeId, null);
      }
    }
  } catch (e) {
    const errResult = { error: e.message };
    if (tabId) {
      state.setQueryResult(tabId, errResult);
    } else {
      state.setQueryResult(activeId, errResult);
    }
  }

  if (tabId) {
    getTabState(tabId).queryRunning = false;
  } else {
    panelState.queryRunning = false;
  }
  renderContent();
}

function buildExplainView(explainResult) {
  const { dbType, rawResult } = explainResult;

  if (dbType === 'postgresql' || dbType === 'mysql' || dbType === 'mariadb') {
    try {
      const firstCol = rawResult.columns[0];
      const planJson = rawResult.rows[0][firstCol];
      const plan = typeof planJson === 'string' ? JSON.parse(planJson) : planJson;
      return `<div class="db-explain-view">
        <div class="db-explain-header">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          ${t('database.explainTitle')}
        </div>
        <pre class="db-explain-content">${highlight(JSON.stringify(plan, null, 2), 'json')}</pre>
      </div>`;
    } catch (_) {
      return buildResultsTable(rawResult);
    }
  }

  if (dbType === 'sqlite') {
    return `<div class="db-explain-view">
      <div class="db-explain-header">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        ${t('database.explainTitle')}
      </div>
      <div class="db-explain-tree">
        ${rawResult.rows.map(row => {
          const indent = (row.parent || 0) * 20;
          return `<div class="db-explain-tree-node" style="padding-left:${indent + 12}px">
            <span class="db-explain-tree-id">${row.id !== undefined ? row.id : ''}</span>
            <span class="db-explain-tree-detail">${escapeHtml(row.detail || '')}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  return buildResultsTable(rawResult);
}

// ==================== Connection String Helpers ====================

function parseConnectionString(type, uri) {
  try {
    const url = new URL(uri);
    return {
      host: url.hostname || 'localhost',
      port: parseInt(url.port) || (type === 'postgresql' ? 5432 : 3306),
      database: url.pathname.replace(/^\//, '') || '',
      username: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || ''),
    };
  } catch (e) {
    return null;
  }
}

function buildConnectionString(type, config) {
  const proto = type === 'postgresql' ? 'postgresql' : 'mysql';
  const userPart = config.username ? `${encodeURIComponent(config.username)}${config.password ? ':' + encodeURIComponent(config.password) : ''}@` : '';
  const port = config.port || (type === 'postgresql' ? 5432 : 3306);
  return `${proto}://${userPart}${config.host || 'localhost'}:${port}/${config.database || ''}`;
}

module.exports = { init, loadPanel };
