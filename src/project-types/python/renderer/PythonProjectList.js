/**
 * Python ProjectList hooks
 * Sidebar badges, icons, status indicator
 */

const { getPythonInfo } = require('./PythonState');

function getSidebarButtons(ctx) {
  const { projectIndex, project } = ctx;
  const info = getPythonInfo(projectIndex);

  // Trigger detection in background if not yet detected
  if (!info.pythonVersion && project && project.path) {
    const { detectPythonInfo } = require('./PythonRendererService');
    detectPythonInfo(projectIndex, project.path).then(newInfo => {
      if (newInfo && newInfo.pythonVersion) {
        // Re-render sidebar to show the badge
        try {
          const ProjectList = require('../../../renderer/ui/components/ProjectList');
          if (ProjectList.render) ProjectList.render();
        } catch (e) {}
      }
    });
  }

  if (!info.pythonVersion) return '';

  const venvClass = info.venvPath ? 'python-venv-active' : 'python-venv-absent';
  const venvTitle = info.venvPath ? `venv: ${info.venvPath}` : 'No venv';

  return `
    <span class="python-version-badge" title="Python ${info.pythonVersion}">
      <svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10"><circle cx="12" cy="12" r="5"/></svg>
      ${info.pythonVersion}
    </span>
    <span class="python-venv-dot ${venvClass}" title="${venvTitle}"></span>
  `;
}

function getProjectIcon() {
  return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.585 11.692h4.328s2.432.039 2.432-2.35V5.391S16.714 3 11.936 3C7.362 3 7.647 4.986 7.647 4.986l.006 2.055h4.363v.617H5.92S3 7.28 3 11.874s2.569 4.426 2.569 4.426h1.533v-2.13s-.083-2.569 2.527-2.569l.004.004h-.048v.087zm-.272-4.41a.829.829 0 110-1.658.829.829 0 010 1.658zM14.415 12.308h-4.328s-2.432-.039-2.432 2.35v3.951S7.286 21 12.064 21c4.574 0 4.289-1.986 4.289-1.986l-.006-2.055h-4.363v-.617h6.096S21 16.72 21 12.126s-2.569-4.426-2.569-4.426h-1.533v2.13s.083 2.569-2.527 2.569l-.004-.004h.048v-.087zm.272 4.41a.829.829 0 110 1.658.829.829 0 010-1.658z"/></svg>';
}

function getStatusIndicator(ctx) {
  const { projectIndex } = ctx;
  const info = getPythonInfo(projectIndex);
  if (!info.venvPath) return '';
  return `<span class="python-venv-dot python-venv-active" title="venv: ${info.venvPath}"></span>`;
}

function getProjectItemClass() {
  return 'python-project';
}

function getMenuItems(ctx) {
  return '';
}

function getDashboardIcon() {
  return getProjectIcon();
}

function bindSidebarEvents(list, cbs) {
  // No interactive buttons for Python type
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
