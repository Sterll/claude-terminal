/**
 * API ProjectList hooks
 * Sidebar buttons, icons, status indicator
 */

const { getApiServer } = require('./ApiState');

function getSidebarButtons(ctx) {
  const { project, projectIndex, t } = ctx;
  const server = getApiServer(projectIndex);
  const status = server.status;
  const isRunning = status === 'running';
  const isStarting = status === 'starting';

  if (isRunning || isStarting) {
    return `
      <button class="btn-action-icon btn-api-console" data-project-index="${projectIndex}" data-project-id="${project.id}" title="${t('api.serverConsole')}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
      </button>
      <button class="btn-action-primary btn-api-stop" data-project-index="${projectIndex}" data-project-id="${project.id}" title="${t('api.stopServer')}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>
      </button>`;
  }
  return `
    <button class="btn-action-primary btn-api-start" data-project-index="${projectIndex}" data-project-id="${project.id}" title="${t('api.startServer')}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
    </button>`;
}

function getProjectIcon() {
  return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 1h16a2 2 0 012 2v3a2 2 0 01-2 2H4a2 2 0 01-2-2V3a2 2 0 012-2zm0 8h16a2 2 0 012 2v3a2 2 0 01-2 2H4a2 2 0 01-2-2v-3a2 2 0 012-2zm0 8h16a2 2 0 012 2v3a2 2 0 01-2 2H4a2 2 0 01-2-2v-3a2 2 0 012-2zm1-13v1h2V4H5zm0 8v1h2v-1H5zm0 8v1h2v-1H5z"/></svg>';
}

function getStatusIndicator(ctx) {
  const { projectIndex } = ctx;
  const server = getApiServer(projectIndex);
  return `<span class="api-status-dot ${server.status}" title="${server.status}"></span>`;
}

function getProjectItemClass() {
  return 'api-project';
}

function getMenuItems(ctx) {
  const { projectIndex, t } = ctx;
  const server = getApiServer(projectIndex);

  if (server.status === 'running' && server.port) {
    return `<div class="action-item btn-api-test-endpoint" data-port="${server.port}">
      <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/><path d="M5 5v14h14v-7h-2v5H7V7h5V5H5z"/></svg>
      ${t('api.openEndpoint')}
    </div>`;
  }
  return '';
}

function getDashboardIcon() {
  return getProjectIcon();
}

function bindSidebarEvents(list, cbs) {
  list.querySelectorAll('.btn-api-start').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (cbs.onStartApi) cbs.onStartApi(parseInt(btn.dataset.projectIndex));
    };
  });

  list.querySelectorAll('.btn-api-stop').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (cbs.onStopApi) cbs.onStopApi(parseInt(btn.dataset.projectIndex));
    };
  });

  list.querySelectorAll('.btn-api-console').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (cbs.onOpenApiConsole) cbs.onOpenApiConsole(parseInt(btn.dataset.projectIndex));
    };
  });

  list.querySelectorAll('.btn-api-test-endpoint').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const port = btn.dataset.port;
      if (port) require('electron').shell.openExternal(`http://localhost:${port}`);
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
