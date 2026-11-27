/**
 * ProjectImportModal
 *
 * First launch for someone who already uses Claude Code: their history is in
 * `~/.claude/projects/`, but a fresh profile here opens on an empty project
 * list. Main reads the folders those transcripts were written in
 * (`claude.discoverProjects`, from each transcript's `cwd`, since the
 * directory names cannot be decoded), and this modal offers to add them, one
 * checkbox per folder, all ticked, most recent first.
 *
 * Asked once, like the account onboarding it follows (`projectImportDone`),
 * and never on a profile that already has projects.
 */

const { createModal, showModal, closeModal } = require('./Modal');
const { escapeHtml } = require('../../utils/dom');
const { formatRelativeTimeIntl } = require('../../utils/format');
const { t, getCurrentLanguage } = require('../../i18n');

/** Rows past this are left out of the list: a first launch is not an inventory. */
const MAX_ROWS = 40;

function sameLocalPath(a, b) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function formatLastSession(ms) {
  const language = getCurrentLanguage();
  const relative = formatRelativeTimeIntl(ms, { language });
  let absolute = '';
  try {
    absolute = new Intl.DateTimeFormat(language || 'en', { dateStyle: 'medium' }).format(new Date(ms));
  } catch { /* unreadable date */ }
  return { relative, absolute };
}

/**
 * Show the list and resolve with the folders the user kept ticked, or null
 * when they declined.
 * @param {Array<{ path: string, name: string, lastActivity: number, sessionCount: number }>} folders
 * @returns {Promise<Array<Object>|null>}
 */
function showProjectImportModal(folders) {
  const rows = folders.slice(0, MAX_ROWS);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };

    const items = rows.map((folder, index) => {
      const { relative, absolute } = formatLastSession(folder.lastActivity);
      return `
        <label class="project-import-row" title="${escapeHtml(folder.path)}">
          <input type="checkbox" data-index="${index}" checked>
          <span class="project-import-text">
            <span class="project-import-name">${escapeHtml(folder.name)}</span>
            <span class="project-import-path">${escapeHtml(folder.path)}</span>
          </span>
          <span class="project-import-date" title="${escapeHtml(absolute)}">${escapeHtml(t('projectImport.lastSession', { when: relative }))}</span>
        </label>`;
    }).join('');

    const modal = createModal({
      id: 'project-import-modal',
      title: t('projectImport.title'),
      size: 'medium',
      content: `
        <div class="account-switch-scope">${escapeHtml(t(rows.length === 1 ? 'projectImport.introOne' : 'projectImport.introMany', { count: rows.length }))}</div>
        <div class="project-import-list">${items}</div>
      `,
      buttons: [
        { label: t('projectImport.skip'), action: 'cancel', onClick: (m) => { closeModal(m); finish(null); } },
        {
          label: t('projectImport.add', { count: rows.length }),
          action: 'confirm',
          primary: true,
          onClick: (m) => {
            const picked = [...m.querySelectorAll('.project-import-row input:checked')]
              .map(input => rows[Number(input.dataset.index)])
              .filter(Boolean);
            closeModal(m);
            finish(picked);
          }
        }
      ],
      onClose: () => finish(null)
    });

    const confirmBtn = modal.querySelector('[data-action="confirm"]');
    modal.querySelector('.project-import-list').addEventListener('change', () => {
      const count = modal.querySelectorAll('.project-import-row input:checked').length;
      confirmBtn.textContent = t('projectImport.add', { count });
      confirmBtn.disabled = count === 0;
    });

    showModal(modal);
  });
}

/**
 * Offer, once, to add the folders Claude Code was already used in.
 *
 * `projectImportDone` is set as soon as the question is settled: asked and
 * answered either way, nothing found, or a profile that already has projects.
 * A discovery that failed leaves it unset, so the next launch asks again.
 *
 * @param {{
 *   api?: Object,
 *   getSetting: Function,
 *   setSetting: Function,
 *   isFreshProfile: boolean,
 *   getProjects: () => Object[],
 *   addProject: (data: Object) => Object|null,
 *   onAdded?: (projects: Object[]) => void,
 *   show?: Function,
 * }} deps
 * @returns {Promise<Object[]>} the projects added
 */
async function maybeShowProjectImport({
  api = window.electron_api,
  getSetting,
  setSetting,
  isFreshProfile,
  getProjects,
  addProject,
  onAdded = () => {},
  show = showProjectImportModal,
}) {
  if (getSetting('projectImportDone')) return [];
  if (!isFreshProfile) {
    setSetting('projectImportDone', true);
    return [];
  }
  if (typeof api?.claude?.discoverProjects !== 'function') return [];

  const existing = (getProjects() || []).map(p => p.path).filter(Boolean);
  const res = await api.claude.discoverProjects(existing);
  if (!res?.success) return [];
  // Projects added meanwhile (a drop, the MCP tool) are not offered twice.
  const current = (getProjects() || []).map(p => p.path);
  const folders = (res.folders || []).filter(f => !current.some(p => sameLocalPath(p, f.path)));
  setSetting('projectImportDone', true);
  if (!folders.length) return [];

  const picked = await show(folders);
  if (!picked || !picked.length) return [];

  const added = [];
  for (const folder of picked) {
    const project = addProject({ name: folder.name, path: folder.path, type: 'standalone' });
    if (project) added.push(project);
  }
  if (added.length) {
    const { showSuccess } = require('./Toast');
    showSuccess(t('projectImport.added', { count: added.length }));
    onAdded(added);
  }
  return added;
}

module.exports = {
  showProjectImportModal,
  maybeShowProjectImport,
};
