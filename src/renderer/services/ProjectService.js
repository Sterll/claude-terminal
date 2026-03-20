/**
 * Project Service
 * Handles project-related operations in the renderer
 */

const { BaseService } = require('../core/BaseService');
const { t } = require('../i18n');
const { showConfirm } = require('../ui/components/Modal');
const {
  projectsState, getProject, getProjectIndex,
  addProject, updateProject, deleteProject: deleteProjectState,
  loadProjects, saveProjects,
  setSelectedProjectFilter, setOpenedProjectId
} = require('../state');

class ProjectService extends BaseService {
  async addProjectFromDialog(type = 'standalone') {
    const folderPath = await this.api.dialog.selectFolder();
    if (!folderPath) return null;
    const name = folderPath.split(/[/\\]/).pop();
    return addProject({ name, path: folderPath, type });
  }

  async addFivemProject() {
    const folderPath = await this.api.dialog.selectFolder();
    if (!folderPath) return null;
    const name = folderPath.split(/[/\\]/).pop();
    const runCommand = await this.api.dialog.selectFile({
      filters: [
        { name: t('projects.filterBatch'), extensions: ['bat', 'cmd'] },
        { name: t('projects.filterExe'), extensions: ['exe'] },
        { name: t('projects.filterAll'), extensions: ['*'] }
      ]
    });
    return addProject({ name, path: folderPath, type: 'fivem', runCommand: runCommand || null });
  }

  async deleteProjectWithConfirm(projectId, onConfirm) {
    const project = getProject(projectId);
    if (!project) return false;
    const confirmed = await showConfirm({
      title: t('projects.deleteProject') || 'Delete project',
      message: t('projects.confirmDelete', { name: project.name }),
      confirmLabel: t('common.delete'),
      danger: true
    });
    if (!confirmed) return false;
    if (onConfirm) onConfirm(projectId, project);
    deleteProjectState(projectId);
    return true;
  }

  openInEditor(projectId, editor = 'code') {
    const project = getProject(projectId);
    if (project) this.api.dialog.openInEditor({ editor, path: project.path });
  }

  openInExplorer(projectId) {
    const project = getProject(projectId);
    if (project) this.api.dialog.openInExplorer(project.path);
  }

  selectProject(projectId) {
    setSelectedProjectFilter(getProjectIndex(projectId));
    setOpenedProjectId(null);
  }

  clearProjectSelection() {
    setSelectedProjectFilter(null);
    setOpenedProjectId(null);
  }

  getAllProjects() {
    return projectsState.get().projects;
  }

  getProjectsByType(type) {
    return projectsState.get().projects.filter(p => p.type === type);
  }

  searchProjects(query) {
    const lowerQuery = query.toLowerCase();
    return projectsState.get().projects.filter(p =>
      p.name.toLowerCase().includes(lowerQuery) ||
      p.path.toLowerCase().includes(lowerQuery)
    );
  }

  async checkAllProjectsGitStatus(renderCallback) {
    const { setGitRepoStatus } = require('../state');
    const projects = projectsState.get().projects;
    for (const project of projects) {
      try {
        const result = await this.api.git.statusQuick({ projectPath: project.path });
        setGitRepoStatus(project.id, result.isGitRepo);
      } catch (e) {
        setGitRepoStatus(project.id, false);
      }
    }
    if (renderCallback) renderCallback();
  }
}

// ── Lazy singleton + legacy exports ──

let _instance = null;

function _getInstance() {
  if (!_instance) {
    const { getApiProvider, getContainer } = require('../core');
    _instance = new ProjectService(getApiProvider(), getContainer());
  }
  return _instance;
}

module.exports = {
  ProjectService,
  getInstance: _getInstance,
  addProjectFromDialog: (...a) => _getInstance().addProjectFromDialog(...a),
  addFivemProject: (...a) => _getInstance().addFivemProject(...a),
  deleteProjectWithConfirm: (...a) => _getInstance().deleteProjectWithConfirm(...a),
  openInEditor: (...a) => _getInstance().openInEditor(...a),
  openInExplorer: (...a) => _getInstance().openInExplorer(...a),
  selectProject: (...a) => _getInstance().selectProject(...a),
  clearProjectSelection: (...a) => _getInstance().clearProjectSelection(...a),
  getAllProjects: (...a) => _getInstance().getAllProjects(...a),
  getProjectsByType: (...a) => _getInstance().getProjectsByType(...a),
  searchProjects: (...a) => _getInstance().searchProjects(...a),
  checkAllProjectsGitStatus: (...a) => _getInstance().checkAllProjectsGitStatus(...a),
  // Re-exported state helpers (unchanged)
  loadProjects, saveProjects
};
