/**
 * DatabasePanel
 * Database connections management, schema viewer, query editor
 * + MCP auto-provisioning for Claude chat integration
 */

const { escapeHtml } = require('../../utils');
const { highlight } = require('../../utils/syntaxHighlight');
const { t } = require('../../i18n');
const { showConfirm } = require('../components/Modal');

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

let panelState = {
  initialized: false,
  activeSubTab: 'connections', // 'connections' | 'schema' | 'query'
  expandedTables: new Set(),
  queryRunning: false,
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

  // Load connections from disk on first visit
  const state = require('../../state');
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
}

// ==================== Render Router ====================

function renderContent() {
  const container = document.getElementById('database-content');
  if (!container) return;

  switch (panelState.activeSubTab) {
    case 'connections': renderConnections(container); break;
    case 'schema': renderSchema(container); break;
    case 'query': renderQuery(container); break;
  }
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

  return `
    <div class="database-card ${active ? 'selected' : ''}" data-id="${escapeHtml(conn.id)}">
      <div class="database-card-header">
        <div class="database-card-title-row">
          <span class="database-type-badge ${conn.type}">${escapeHtml(conn.type.toUpperCase())}</span>
          <span class="database-card-title">${escapeHtml(conn.name || conn.id)}</span>
        </div>
        <span class="database-status-badge ${status}">${t('database.' + status)}</span>
      </div>
      <div class="database-card-bottom">
        <div class="database-card-info">
          ${conn.type === 'sqlite' ? escapeHtml(conn.filePath || '') :
            conn.type === 'mongodb' ? escapeHtml(conn.connectionString ? conn.connectionString.replace(/\/\/[^@]+@/, '//***@') : `${conn.host}:${conn.port}`) :
            escapeHtml(`${conn.host || 'localhost'}:${conn.port || ''} / ${conn.database || ''}`)}
          ${projectName ? ` <span class="database-card-project">${escapeHtml(projectName)}</span>` : ''}
        </div>
        <div class="database-card-actions">
        ${status === 'connected' ?
          `<button class="btn-database" data-action="disconnect" data-id="${escapeHtml(conn.id)}" title="${t('database.disconnect')}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42A6.92 6.92 0 0119 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.05.89-3.89 2.3-5.16L5.88 5.46A8.94 8.94 0 003 12a9 9 0 0018 0c0-2.74-1.23-5.19-3.17-6.83z"/></svg>
          </button>` :
          `<button class="btn-database primary" data-action="connect" data-id="${escapeHtml(conn.id)}" title="${t('database.connect')}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg>
          </button>`}
        <button class="btn-database" data-action="edit" data-id="${escapeHtml(conn.id)}" title="${t('database.editConnection')}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        </button>
        <button class="btn-database danger" data-action="delete" data-id="${escapeHtml(conn.id)}" title="${t('database.deleteConnection')}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>
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
        case 'connect': await connectDatabase(id); break;
        case 'disconnect': await disconnectDatabase(id); break;
        case 'edit': showConnectionForm(id); break;
        case 'delete': await deleteConnection(id); break;
        case 'import-detected': importDetected(btn.dataset.detected); break;
      }
    };
  });

  // Click card to select
  container.querySelectorAll('.database-card:not(.detected)').forEach(card => {
    card.onclick = () => {
      const state = require('../../state');
      state.setActiveConnection(card.dataset.id);
      renderContent();
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
  const tableLabel = isMongo ? t('database.collections') : t('database.tables');
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
      <div class="db-browser-sidebar">
        <div class="db-browser-search">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <input type="text" class="db-browser-search-input" id="db-browser-filter" placeholder="${tableLabel}..." value="${escapeHtml(panelState.browserTableFilter)}">
          <span class="db-browser-count">${filteredTables.length}</span>
        </div>
        <div class="db-browser-table-list" id="db-browser-table-list">
          ${filteredTables.map(table => `
            <div class="db-browser-table-item ${table.name === selectedTable ? 'active' : ''}" data-table="${escapeHtml(table.name)}">
              <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13" class="db-browser-table-icon"><path d="M3 3h18v18H3V3zm2 4v4h6V7H5zm8 0v4h6V7h-6zm-8 6v4h6v-4H5zm8 0v4h6v-4h-6z"/></svg>
              <span class="db-browser-table-name">${escapeHtml(table.name)}</span>
              <span class="db-browser-table-cols">${table.columns.length}</span>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="db-browser-main">
        ${selectedTable && selectedMeta ? renderBrowserDataPanel(selectedTable, selectedMeta, isMongo, columnLabel) : renderBrowserEmptyState(tableLabel)}
      </div>
    </div>`;

  bindBrowserEvents(container);
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
    return `<span class="db-col-chip${pkClass}" title="${escapeHtml(col.type)}${col.primaryKey ? ' (PK)' : ''}${col.nullable ? ' NULL' : ''}">
      ${col.primaryKey ? '<span class="db-col-pk">PK</span>' : ''}
      ${escapeHtml(col.name)}
      <span class="db-col-type">${escapeHtml(col.type)}</span>
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
    gridHtml = `
      <div class="db-grid-wrapper">
        <table class="db-grid">
          <thead><tr>
            <th class="db-grid-row-num">#</th>
            ${cols.map(col => {
              const isSorted = sortCol === col;
              const arrow = isSorted ? (sortDir === 'ASC' ? ' &#9650;' : ' &#9660;') : '';
              return `<th class="db-grid-th ${isSorted ? 'sorted' : ''}" data-col="${escapeHtml(col)}">${escapeHtml(col)}${arrow}</th>`;
            }).join('')}
          </tr></thead>
          <tbody>
            ${data.rows.map((row, ri) => {
              const globalIdx = page * pageSize + ri + 1;
              return `<tr data-row="${ri}">
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
                  return `<td class="${cellClass}" data-row="${ri}" data-col="${escapeHtml(col)}">${displayVal}</td>`;
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
        renderContent();
        loadTableData(tableName);
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
  if (prevBtn) prevBtn.onclick = () => { panelState.browserPage--; loadTableData(panelState.browserSelectedTable); };
  const nextBtn = container.querySelector('#db-browser-next');
  if (nextBtn) nextBtn.onclick = () => { panelState.browserPage++; loadTableData(panelState.browserSelectedTable); };

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
    const result = await ctx.api.database.executeQuery({ id: activeId, sql });
    if (result.error) {
      ctx.showToast({ type: 'error', title: result.error });
    } else {
      // Update local data
      data.rows[row][col] = newVal === '' ? null : newVal;
      ctx.showToast({ type: 'success', title: t('database.browserRowUpdated') });
    }
  } catch (e) {
    ctx.showToast({ type: 'error', title: e.message });
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
      const result = await ctx.api.database.executeQuery({ id: activeId, sql });
      if (result.error) {
        ctx.showToast({ type: 'error', title: result.error });
      } else {
        ctx.showToast({ type: 'success', title: t('database.browserRowInserted') });
        ctx.closeModal();
        loadTableData(panelState.browserSelectedTable);
      }
    } catch (e) {
      ctx.showToast({ type: 'error', title: e.message });
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
    const result = await ctx.api.database.executeQuery({ id: activeId, sql });
    if (result.error) {
      ctx.showToast({ type: 'error', title: result.error });
    } else {
      ctx.showToast({ type: 'success', title: t('database.browserRowDeleted') });
      loadTableData(panelState.browserSelectedTable);
    }
  } catch (e) {
    ctx.showToast({ type: 'error', title: e.message });
  }
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
    if (panelState.activeSubTab === 'schema') renderContent();
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

function renderQuery(container) {
  const state = require('../../state');
  const activeId = state.getActiveConnection();

  if (!activeId || state.getConnectionStatus(activeId) !== 'connected') {
    container.innerHTML = `<div class="database-empty-state"><div class="database-empty-text">${t('database.noActiveConnection')}</div></div>`;
    return;
  }

  const conn = state.getDatabaseConnection(activeId);
  const isMongo = conn && conn.type === 'mongodb';
  const isRedis = conn && conn.type === 'redis';
  const placeholder = isMongo ? t('database.mongoPlaceholder') : isRedis ? 'GET mykey' : t('database.queryPlaceholder');
  const currentQuery = state.getCurrentQuery();
  const queryResult = state.getQueryResult(activeId);
  const templates = getQueryTemplates(isMongo, conn ? conn.type : 'mysql', isRedis);

  // Template chips
  const templatesHtml = templates.map((tpl, i) => {
    const catClass = `db-query-tpl-${tpl.cat}`;
    return `<button class="db-query-tpl ${catClass}" data-tpl-idx="${i}" title="${escapeHtml(tpl.sql.replace(/\n/g, ' '))}">${tpl.icon} ${escapeHtml(tpl.label)}</button>`;
  }).join('');

  // Build results
  let resultsHtml = '';
  if (queryResult) {
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
        </div>`;
        resultsHtml += buildResultsTable(queryResult);
      }
    }
  }

  container.innerHTML = `
    <div class="db-query-layout">
      <div class="db-query-top">
        <div class="db-query-templates">${templatesHtml}</div>
        <div class="db-query-editor-wrap">
          <div class="db-query-highlight-wrap">
            <pre class="db-query-highlight" id="database-query-highlight" aria-hidden="true"><code>${currentQuery ? highlight(currentQuery, isMongo ? 'js' : 'sql') + '\n' : '\n'}</code></pre>
            <textarea class="database-query-editor" id="database-query-input" placeholder="${escapeHtml(placeholder)}" spellcheck="false">${escapeHtml(currentQuery)}</textarea>
          </div>
          <div class="db-query-actions">
            <button class="db-query-run" id="database-run-btn" ${panelState.queryRunning ? 'disabled' : ''}>
              ${panelState.queryRunning
                ? `<span class="db-query-run-spinner"></span> ${t('database.connecting')}`
                : `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg> ${t('database.runQuery')}`
              }
            </button>
            <button class="db-query-clear" id="database-clear-btn" title="${t('database.queryClear')}">
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
            <span class="db-query-shortcut">${t('database.runQueryShortcut')}</span>
          </div>
        </div>
      </div>
      <div class="db-query-results">
        ${resultsHtml}
      </div>
    </div>`;

  // Bind events
  const runBtn = document.getElementById('database-run-btn');
  if (runBtn) runBtn.onclick = () => runQuery();

  const clearBtn = document.getElementById('database-clear-btn');
  if (clearBtn) clearBtn.onclick = () => {
    state.setCurrentQuery('');
    state.setQueryResult(activeId, null);
    renderContent();
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
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        runQuery();
      }
    };
    input.oninput = () => {
      state.setCurrentQuery(input.value);
      syncHighlight();
    };
    input.onscroll = syncScroll;
  }

  // Template click handlers
  container.querySelectorAll('.db-query-tpl').forEach(btn => {
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
}

function buildResultsTable(result) {
  if (!result.columns || result.columns.length === 0 || !result.rows || result.rows.length === 0) {
    return '';
  }

  let html = `<div class="database-results-wrapper"><table class="database-results-table"><thead><tr>`;
  for (const col of result.columns) {
    html += `<th>${escapeHtml(String(col))}</th>`;
  }
  html += `</tr></thead><tbody>`;

  for (const row of result.rows) {
    html += '<tr>';
    for (const col of result.columns) {
      const val = row[col];
      const display = val === null ? '<span class="null-value">NULL</span>' : escapeHtml(String(val));
      html += `<td>${display}</td>`;
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

async function runQuery() {
  const state = require('../../state');
  const activeId = state.getActiveConnection();
  if (!activeId) return;

  const conn = state.getDatabaseConnection(activeId);
  const isMongo = conn && conn.type === 'mongodb';

  const input = document.getElementById('database-query-input');
  const sql = input ? input.value.trim() : state.getCurrentQuery().trim();
  if (!sql) return;

  panelState.queryRunning = true;
  renderContent();

  try {
    // MongoDB: send as-is (not SQL, no semicolon splitting)
    if (isMongo) {
      const result = await ctx.api.database.executeQuery({ id: activeId, sql, limit: 100 });
      state.setQueryResult(activeId, result);
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
        const result = await ctx.api.database.executeQuery({ id: activeId, sql: stmt, limit: 100 });
        statementsRun++;
        totalDuration += result.duration || 0;

        if (result.error) {
          state.setQueryResult(activeId, {
            error: t('database.statementError', { current: statementsRun, total: statements.length, error: result.error }),
            duration: totalDuration
          });
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
      state.setQueryResult(activeId, lastResult);
    }
  } catch (e) {
    state.setQueryResult(activeId, { error: e.message });
  }

  panelState.queryRunning = false;
  renderContent();
}

// ==================== Actions ====================

async function connectDatabase(id) {
  const state = require('../../state');
  const conn = state.getDatabaseConnection(id);
  if (!conn) return;

  state.setConnectionStatus(id, 'connecting');
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
  state.setActiveConnection(id);

  if (result.success) {
    ctx.showToast({ type: 'success', title: t('database.connectionSuccess') });
    // Preload schema
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
    container.innerHTML = `
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
      </div>`;
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
    config.host = document.getElementById('db-form-host')?.value.trim() || 'localhost';
    config.port = parseInt(document.getElementById('db-form-port')?.value) || ((type === 'mysql' || type === 'mariadb') ? 3306 : 5432);
    config.database = document.getElementById('db-form-database')?.value.trim() || '';
    config.username = document.getElementById('db-form-username')?.value.trim() || '';
    config.password = document.getElementById('db-form-password')?.value || '';
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

module.exports = { init, loadPanel };
