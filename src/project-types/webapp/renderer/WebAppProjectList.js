/**
 * Web App ProjectList hooks
 * Sidebar buttons, icons, status indicator
 */

const { getWebAppServer } = require('./WebAppState');

function getSidebarButtons(ctx) {
  const { project, projectIndex, t } = ctx;
  const server = getWebAppServer(projectIndex);
  const status = server.status;
  const isRunning = status === 'running';
  const isStarting = status === 'starting';

  if (isRunning || isStarting) {
    return `
      <button class="btn-action-icon btn-webapp-console" data-project-index="${projectIndex}" data-project-id="${project.id}" title="${t('webapp.devServer')}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
      </button>
      <button class="btn-action-primary btn-webapp-stop" data-project-index="${projectIndex}" data-project-id="${project.id}" title="${t('webapp.stopServer')}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>
      </button>`;
  }
  return `
    <button class="btn-action-primary btn-webapp-start" data-project-index="${projectIndex}" data-project-id="${project.id}" title="${t('webapp.startServer')}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
    </button>`;
}

function getProjectIcon() {
  return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.36 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2m-5.15 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56M14.34 14H9.66c-.1-.66-.16-1.32-.16-2 0-.68.06-1.35.16-2h4.68c.09.65.16 1.32.16 2 0 .68-.07 1.34-.16 2M12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96M8 8H5.08A7.923 7.923 0 0 1 9.4 4.44C8.8 5.55 8.35 6.75 8 8m-2.92 8H8c.35 1.25.8 2.45 1.4 3.56A8.008 8.008 0 0 1 5.08 16m-.82-2C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2M12 4.03c.83 1.2 1.48 2.54 1.91 3.97H10.09c.43-1.43 1.08-2.77 1.91-3.97M18.92 8h-2.95a15.65 15.65 0 0 0-1.38-3.56c1.84.63 3.37 1.9 4.33 3.56M12 2C6.47 2 2 6.5 2 12a10 10 0 0 0 10 10 10 10 0 0 0 10-10A10 10 0 0 0 12 2Z"/></svg>';
}

function getStatusIndicator(ctx) {
  const { projectIndex } = ctx;
  const server = getWebAppServer(projectIndex);
  return `<span class="webapp-status-dot ${server.status}" title="${server.status}"></span>`;
}

function getProjectItemClass() {
  return 'webapp-project';
}

function getMenuItems(ctx) {
  const { projectIndex, t } = ctx;
  const server = getWebAppServer(projectIndex);

  if (server.status === 'running' && server.port) {
    return `<div class="action-item btn-webapp-open-browser" data-port="${server.port}">
      <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/><path d="M5 5v14h14v-7h-2v5H7V7h5V5H5z"/></svg>
      ${t('webapp.openBrowser')}
    </div>`;
  }
  return '';
}

function getDashboardIcon() {
  return getProjectIcon();
}

function bindSidebarEvents(list, cbs) {
  list.querySelectorAll('.btn-webapp-start').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (cbs.onStartWebApp) cbs.onStartWebApp(parseInt(btn.dataset.projectIndex));
    };
  });

  list.querySelectorAll('.btn-webapp-stop').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (cbs.onStopWebApp) cbs.onStopWebApp(parseInt(btn.dataset.projectIndex));
    };
  });

  list.querySelectorAll('.btn-webapp-console').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (cbs.onOpenWebAppConsole) cbs.onOpenWebAppConsole(parseInt(btn.dataset.projectIndex));
    };
  });

  list.querySelectorAll('.btn-webapp-browser, .btn-webapp-open-browser').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const port = btn.dataset.port;
      if (port) window.electron_api.dialog.openExternal(`http://localhost:${port}`);
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
