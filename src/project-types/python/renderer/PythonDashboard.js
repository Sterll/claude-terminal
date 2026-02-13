/**
 * Python Dashboard hooks
 * Badge and stats for the dashboard
 */

const { getPythonInfo } = require('./PythonState');

function getDashboardBadge(project) {
  return {
    text: 'Python',
    cssClass: 'python'
  };
}

function getDashboardStats(ctx) {
  const { projectIndex, project, t } = ctx;
  if (projectIndex === undefined || projectIndex === null || projectIndex < 0) return '';

  const info = getPythonInfo(projectIndex);

  // Trigger detection in background if not yet detected
  if (!info.pythonVersion && project && project.path) {
    const { detectPythonInfo } = require('./PythonRendererService');
    detectPythonInfo(projectIndex, project.path);
    // Will show on next dashboard render
  }

  if (!info.pythonVersion && !info.venvPath) return '';

  const parts = [];

  if (info.pythonVersion) {
    parts.push(`
      <div class="dashboard-quick-stat python-stat">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" style="opacity:0.6"><path d="M9.585 11.692h4.328s2.432.039 2.432-2.35V5.391S16.714 3 11.936 3C7.362 3 7.647 4.986 7.647 4.986l.006 2.055h4.363v.617H5.92S3 7.28 3 11.874s2.569 4.426 2.569 4.426h1.533v-2.13s-.083-2.569 2.527-2.569l.004.004h-.048v.087zm-.272-4.41a.829.829 0 110-1.658.829.829 0 010 1.658zM14.415 12.308h-4.328s-2.432-.039-2.432 2.35v3.951S7.286 21 12.064 21c4.574 0 4.289-1.986 4.289-1.986l-.006-2.055h-4.363v-.617h6.096S21 16.72 21 12.126s-2.569-4.426-2.569-4.426h-1.533v2.13s.083 2.569-2.527 2.569l-.004-.004h.048v-.087zm.272 4.41a.829.829 0 110 1.658.829.829 0 010-1.658z"/></svg>
        <span>Python ${info.pythonVersion}</span>
      </div>
    `);
  }

  if (info.venvPath) {
    parts.push(`
      <div class="dashboard-quick-stat python-stat">
        <span class="python-venv-dot python-venv-active"></span>
        <span>${t('python.venv')}: ${info.venvPath}</span>
      </div>
    `);
  }

  if (info.dependencies > 0) {
    parts.push(`
      <div class="dashboard-quick-stat python-stat">
        <span>${info.dependencies} ${t('python.dependencies')}</span>
      </div>
    `);
  }

  if (info.mainEntry) {
    parts.push(`
      <div class="dashboard-quick-stat python-stat">
        <span>${t('python.entryPoint')}: <code style="background:var(--bg-tertiary);padding:1px 6px;border-radius:3px;font-size:11px;">${info.mainEntry}</code></span>
      </div>
    `);
  }

  return parts.join('');
}

module.exports = { getDashboardBadge, getDashboardStats };
