/**
 * NewProjectModal - "New project" in one screen.
 *
 * Replaces the two-step wizard (type first, then everything else) that took
 * about ten clicks from the "+" to a first conversation. What changed, and why:
 *
 *   - One screen. The type is a row of chips under the name instead of a step
 *     of its own, and for an existing folder it is detected from the folder's
 *     content (detectProjectType) and preselected, with the reason shown.
 *   - The location is remembered: the parent folder of the last project
 *     created, cloned or scaffolded is `projectsRootDir`, pre-filled next time
 *     and granted to the renderer at boot by rendererSecurity, the same way
 *     project paths are. The folder dialog opens there.
 *   - The folder a name becomes is shown before anything is written
 *     (folderNameFor), and everything that would make Create fail is checked
 *     as the user types (validateDraft): a duplicate project, an existing
 *     destination, a path the renderer may not touch, a malformed repo URL.
 *     The old dialog found a duplicate only after the clone had finished.
 *   - A typo in "existing folder" no longer creates a folder silently: it is
 *     said, and Create still offers it.
 *   - Colour and group are set at creation, and "New project" from a folder's
 *     menu lands in that folder.
 *   - Clicking outside does not close it (an outside click cancelled a clone
 *     in progress and lost the form); Escape and Cancel still do.
 *   - The project is opened afterwards and, unless unticked, a conversation
 *     starts in it.
 *
 * Every type keeps its own fields (getWizardFields / bindWizardEvents /
 * getWizardConfig / afterProjectCreate) exactly as before, behind "Options".
 */

const {
  folderNameFor, detectProjectType, validateDraft, nameFromRepoUrl, REPO_URL,
} = require('../../utils/newProject');
const { escapeHtml } = require('../../utils/dom');

const COLORS = ['', '#f87171', '#fb923c', '#facc15', '#4ade80', '#2dd4bf', '#60a5fa', '#a78bfa', '#f472b6'];

const SOURCE_ICONS = {
  folder: '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>',
  create: '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
  clone: '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2v9.67z"/></svg>',
  scaffold: '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/></svg>',
};

const GITIGNORE = ['node_modules/', 'dist/', 'build/', '.env', '.env.local', '*.log', '.DS_Store', 'Thumbs.db', ''].join('\n');

/**
 * What the dialog can learn about a path through the renderer's fs bridge.
 * 'denied' is the bridge refusing a folder the user has not granted (typed
 * rather than picked), which the form explains instead of reporting "missing".
 */
async function probePath(fsp, p) {
  if (!p) return 'unknown';
  try {
    const st = await fsp.stat(p);
    return st.isDirectory() ? 'dir' : 'file';
  } catch (e) {
    if (e?.code === 'ENOENT') return 'missing';
    if (e?.code === 'EACCES' || /access denied/i.test(e?.message || '')) return 'denied';
    return 'unknown';
  }
}

async function readSmall(fsp, file, max = 64 * 1024) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return text.length > max ? text.slice(0, max) : text;
  } catch { return null; }
}

/**
 * @param {object} deps  everything the dialog needs from renderer.js
 * @param {{ folderId?: string|null, presetPath?: string|null }} [opts]
 */
async function openNewProjectModal(deps, opts = {}) {
  const {
    api, t, registry, showModal, closeModal, showToast, projectsState, settingsState, setSetting,
    saveProjects, generateProjectId, moveItemToFolder, renderProjects, checkProjectGitStatus,
    openProject, buildAccountField, path, fsp, homedir,
  } = deps;

  // The dialog draws a chip per type and asks the selected one for its fields.
  await registry.ensureAllLoaded();
  const types = registry.getAll();
  const settings = settingsState.get();
  const folders = projectsState.get().folders || [];

  const state = {
    source: opts.presetPath ? 'folder' : (settings.newProjectLastSource || 'folder'),
    type: 'standalone',
    typeTouched: false,
    nameTouched: false,
    template: null,
    color: '',
    folderId: opts.folderId || null,
    detected: null,
    githubConnected: false,
    reposLoaded: false,
    validation: { ok: false },
    probeSeq: 0,
  };
  if (state.source === 'scaffold' && !registry.get('webapp')?.getTemplateGridHtml) state.source = 'folder';

  const defaultParent = settings.projectsRootDir || '';
  const placeholderPath = path.join(homedir || '~', 'Projects');

  const folderOptions = () => {
    const byParent = (parentId, depth) => folders
      .filter((f) => (f.parentId || null) === parentId)
      .flatMap((f) => [
        `<option value="${escapeHtml(f.id)}" ${state.folderId === f.id ? 'selected' : ''}>${'  '.repeat(depth)}${escapeHtml(f.name)}</option>`,
        ...byParent(f.id, depth + 1),
      ]);
    return byParent(null, 0).join('');
  };

  const templateGrid = (() => {
    try { return registry.get('webapp').getTemplateGridHtml ? registry.get('webapp').getTemplateGridHtml(t) : ''; } catch { return ''; }
  })();

  showModal(t('newProject.title'), `
    <form id="form-project" class="wizard-form np-form" data-no-overlay-close autocomplete="off">
      <div class="np-sources" role="radiogroup" aria-label="${escapeHtml(t('newProject.source'))}">
        ${['folder', 'create', 'clone', 'scaffold'].filter((s) => s !== 'scaffold' || templateGrid).map((s) => `
          <button type="button" role="radio" class="np-source" data-source="${s}">
            ${SOURCE_ICONS[s]}<span>${t({ folder: 'newProject.sourceFolder', create: 'newProject.sourceCreate', clone: 'newProject.sourceClone', scaffold: 'newProject.sourceScaffold' }[s])}</span>
          </button>`).join('')}
      </div>

      <div class="wizard-field clone-config np-only" data-for="clone">
        <label class="wizard-label" for="inp-repo-url">${t('newProject.repoUrl')}</label>
        <div class="clone-input-wrapper">
          <svg class="clone-input-icon" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <input type="text" class="wizard-input clone-url-input" id="inp-repo-url" placeholder="${escapeHtml(t('newProject.repoSearchPlaceholder'))}">
        </div>
        <div class="github-status-hint" id="github-status-hint"></div>
        <div class="github-repo-list" id="github-repo-list" style="display: none;"></div>
      </div>

      <div class="np-only" data-for="scaffold">${templateGrid}</div>

      <div class="np-row">
        <div class="wizard-field np-name">
          <label class="wizard-label" for="inp-name">${t('newProject.projectName')}</label>
          <input type="text" class="wizard-input" id="inp-name" placeholder="${escapeHtml(t('newProject.projectNamePlaceholder'))}" required>
        </div>
      </div>

      <div class="wizard-field">
        <label class="wizard-label" id="label-path" for="inp-path"></label>
        <div class="wizard-input-row">
          <input type="text" class="wizard-input" id="inp-path" spellcheck="false">
          <button type="button" class="wizard-browse-btn" id="btn-browse" title="${escapeHtml(t('newProject.browse'))}" aria-label="${escapeHtml(t('newProject.browse'))}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
          </button>
        </div>
        <div class="np-hint" id="np-hint" aria-live="polite"></div>
      </div>

      <div class="wizard-field">
        <label class="wizard-label">${t('newProject.typeLabel')} <span class="np-detected" id="np-detected"></span></label>
        <div class="np-types" role="radiogroup" aria-label="${escapeHtml(t('newProject.typeLabel'))}">
          ${types.map((tp) => `
            <button type="button" role="radio" class="np-type" data-type="${escapeHtml(tp.id)}" title="${escapeHtml(t(tp.descKey))}">
              <span class="np-type-icon">${tp.icon}</span><span>${escapeHtml(t(tp.nameKey))}</span>
            </button>`).join('')}
        </div>
      </div>

      <div class="np-row np-row-split">
        <div class="wizard-field">
          <label class="wizard-label">${t('newProject.colorLabel')}</label>
          <div class="np-colors" role="radiogroup" aria-label="${escapeHtml(t('newProject.colorLabel'))}">
            ${COLORS.map((c) => `<button type="button" role="radio" class="np-color ${c ? '' : 'none'}" data-color="${c}" ${c ? `style="--c:${c}"` : ''} aria-label="${escapeHtml(c || t('newProject.noColor'))}"></button>`).join('')}
          </div>
        </div>
        ${folders.length ? `
        <div class="wizard-field">
          <label class="wizard-label" for="np-folder">${t('newProject.groupLabel')}</label>
          <select class="wizard-input np-folder" id="np-folder">
            <option value="">${t('newProject.groupNone')}</option>
            ${folderOptions()}
          </select>
        </div>` : ''}
      </div>

      <details class="np-advanced" id="np-advanced">
        <summary>${t('newProject.moreOptions')}</summary>
        <div class="np-advanced-body">
          <div class="wizard-field create-git-config np-only" data-for="create">
            <label class="wizard-checkbox">
              <input type="checkbox" id="chk-init-git" checked>
              <span class="wizard-checkbox-mark"></span>
              <span>${t('newProject.initGit')}</span>
            </label>
          </div>
          <div class="type-specific-fields">${types.map((tp) => tp.getWizardFields()).filter(Boolean).join('')}</div>
          ${buildAccountField()}
        </div>
      </details>

      <div class="wizard-field clone-status" style="display: none;"></div>

      <div class="wizard-actions np-actions">
        <label class="wizard-checkbox np-open-after">
          <input type="checkbox" id="np-open-after" ${settings.newProjectOpenAfter !== false ? 'checked' : ''}>
          <span class="wizard-checkbox-mark"></span>
          <span>${t('newProject.openAfter')}</span>
        </label>
        <button type="button" class="wizard-btn-secondary" id="btn-cancel-wizard">${t('common.cancel')}</button>
        <button type="submit" class="wizard-btn-primary" id="btn-create-project" disabled>
          <span>${t('newProject.createProject')}</span>
          <kbd class="np-kbd">${navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'} ↵</kbd>
        </button>
      </div>
    </form>
  `);

  const form = document.getElementById('form-project');
  const $ = (sel) => form.querySelector(sel);
  const nameInput = $('#inp-name');
  const pathInput = $('#inp-path');
  const repoInput = $('#inp-repo-url');
  const hintEl = $('#np-hint');
  const submitBtn = $('#btn-create-project');

  // ── Source ────────────────────────────────────────────────────────────
  function applySource(source) {
    state.source = source;
    form.dataset.source = source;
    form.querySelectorAll('.np-source').forEach((b) => {
      const on = b.dataset.source === source;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', String(on));
    });
    form.querySelectorAll('.np-only').forEach((el) => { el.style.display = el.dataset.for === source ? '' : 'none'; });
    const scaffoldEl = form.querySelector('.scaffold-templates');
    if (scaffoldEl) scaffoldEl.style.display = source === 'scaffold' ? 'block' : 'none';
    const label = $('#label-path');
    if (source === 'folder') {
      label.textContent = t('newProject.projectPath');
      pathInput.placeholder = path.join(placeholderPath, 'my-project');
      if (pathInput.value === defaultParent && !opts.presetPath) pathInput.value = '';
    } else {
      label.textContent = t('newProject.locationLabel');
      pathInput.placeholder = placeholderPath;
      if (!pathInput.value && defaultParent) pathInput.value = defaultParent;
    }
    if (source === 'scaffold') selectType('webapp', { auto: true });
    if (source === 'clone') updateGitHubHint();
    validate();
  }
  form.querySelectorAll('.np-source').forEach((b) => { b.onclick = () => applySource(b.dataset.source); });

  // ── Type ──────────────────────────────────────────────────────────────
  function selectType(id, { auto = false } = {}) {
    if (!registry.get(id)) id = 'standalone';
    state.type = id;
    if (!auto) state.typeTouched = true;
    form.querySelectorAll('.np-type').forEach((b) => {
      const on = b.dataset.type === id;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', String(on));
    });
    types.forEach((handler) => handler.onWizardTypeSelected?.(form, handler.id === id));
    registry.get(id).bindWizardEvents?.(form, api);
    // A type that brings its own fields shows them rather than hiding them
    // behind a closed "Options".
    const fields = form.querySelector('.type-specific-fields');
    const visible = fields && [...fields.children].some((c) => c.offsetParent !== null || c.style.display === 'block');
    if (visible && !auto) $('#np-advanced').open = true;
  }
  form.querySelectorAll('.np-type').forEach((b) => { b.onclick = () => selectType(b.dataset.type); });

  // ── Appearance and group ──────────────────────────────────────────────
  form.querySelectorAll('.np-color').forEach((b) => {
    b.onclick = () => {
      state.color = b.dataset.color;
      form.querySelectorAll('.np-color').forEach((x) => {
        x.classList.toggle('selected', x === b);
        x.setAttribute('aria-checked', String(x === b));
      });
    };
  });
  form.querySelector('.np-color.none')?.classList.add('selected');
  const folderSelect = $('#np-folder');
  if (folderSelect) folderSelect.onchange = () => { state.folderId = folderSelect.value || null; };

  // ── Templates ─────────────────────────────────────────────────────────
  form.querySelectorAll('.scaffold-card').forEach((card) => {
    card.onclick = () => {
      form.querySelectorAll('.scaffold-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      state.template = card.dataset.template;
      validate();
    };
  });

  // ── Name and path ─────────────────────────────────────────────────────
  nameInput.addEventListener('input', () => { state.nameTouched = !!nameInput.value.trim(); validate(); });
  pathInput.addEventListener('input', () => { state.detected = null; validate(); });

  $('#btn-browse').onclick = async () => {
    const current = pathInput.value.trim();
    const folder = await api.dialog.selectFolder({ defaultPath: current || defaultParent || undefined });
    if (!folder) return;
    pathInput.value = folder;
    if (state.source === 'folder' && !state.nameTouched) nameInput.value = path.basename(folder);
    state.detected = null;
    validate();
    nameInput.focus();
  };

  // ── GitHub repositories (clone) ───────────────────────────────────────
  let repoSearchTimeout = null;
  async function updateGitHubHint() {
    const hint = $('#github-status-hint');
    try {
      const result = await api.github.authStatus();
      state.githubConnected = !!result.authenticated;
      if (result.authenticated) {
        hint.innerHTML = `<span class="hint-success">✓ ${escapeHtml(t('newProject.githubConnected', { login: result.login }))}</span>`;
        if (!state.reposLoaded) loadRepos();
      } else {
        hint.innerHTML = `<span class="hint-warning">${escapeHtml(t('newProject.githubPrivateUnavailable'))} · <a href="#" id="link-github-settings">${escapeHtml(t('settings.githubConnect'))}</a></span>`;
        hint.querySelector('#link-github-settings')?.addEventListener('click', (e) => {
          e.preventDefault();
          closeModal();
          document.dispatchEvent(new CustomEvent('ct-open-settings', { detail: { tab: 'github' } }));
        });
      }
    } catch { hint.innerHTML = ''; }
  }
  async function loadRepos(query) {
    const list = $('#github-repo-list');
    if (!state.githubConnected) return;
    list.innerHTML = `<div class="github-repo-loading"><span class="btn-spinner"></span> ${escapeHtml(t('newProject.loadingRepos'))}</div>`;
    list.style.display = 'block';
    try {
      const result = await api.github.listRepos({ query, perPage: 30 });
      if (!result.success || !result.repos?.length) {
        list.innerHTML = `<div class="github-repo-empty">${escapeHtml(result.error || t('newProject.noReposFound'))}</div>`;
        return;
      }
      state.reposLoaded = true;
      list.innerHTML = result.repos.map((repo) => `
        <button type="button" class="github-repo-item" data-clone-url="${escapeHtml(repo.cloneUrl)}" data-name="${escapeHtml(repo.name)}">
          <div class="github-repo-item-top">
            <span class="repo-name">${escapeHtml(repo.name)}</span>
            <span class="repo-visibility ${repo.private ? 'private' : 'public'}">${escapeHtml(repo.private ? t('newProject.repoPrivate') : t('newProject.repoPublic'))}</span>
          </div>
          <div class="repo-meta"><span class="repo-owner">${escapeHtml(repo.owner)}</span>${repo.language ? `<span class="repo-lang">${escapeHtml(repo.language)}</span>` : ''}</div>
        </button>`).join('');
      list.querySelectorAll('.github-repo-item').forEach((item) => {
        item.onclick = () => {
          repoInput.value = item.dataset.cloneUrl;
          if (!state.nameTouched) nameInput.value = item.dataset.name;
          list.style.display = 'none';
          validate();
        };
      });
    } catch (e) {
      list.innerHTML = `<div class="github-repo-empty">${escapeHtml(e.message)}</div>`;
    }
  }
  repoInput.addEventListener('input', () => {
    const value = repoInput.value.trim();
    if (REPO_URL.test(value)) {
      if (!state.nameTouched) nameInput.value = nameFromRepoUrl(value);
      $('#github-repo-list').style.display = 'none';
    } else if (state.githubConnected) {
      clearTimeout(repoSearchTimeout);
      repoSearchTimeout = setTimeout(() => loadRepos(value || undefined), 300);
    }
    validate();
  });

  // ── Live validation ───────────────────────────────────────────────────
  let validateTimer = 0;
  function validate() {
    clearTimeout(validateTimer);
    validateTimer = setTimeout(runValidation, 120);
  }

  async function runValidation() {
    const seq = ++state.probeSeq;
    const name = nameInput.value.trim();
    const location = pathInput.value.trim();
    const isLocalAbsolute = path.isAbsolute(location);
    let probe = 'unknown';
    let target = location;
    if (location && isLocalAbsolute && name) {
      target = state.source === 'folder' ? location : path.join(location, folderNameFor(name, { strict: state.source === 'scaffold' }));
      probe = await probePath(fsp, target);
      // For a new folder, a parent the renderer cannot reach is the real answer.
      if (state.source !== 'folder' && probe === 'missing' && (await probePath(fsp, location)) === 'denied') probe = 'denied';
    } else if (location && state.source === 'folder' && isLocalAbsolute) {
      probe = await probePath(fsp, location);
    }
    if (seq !== state.probeSeq || !form.isConnected) return;

    if (state.source === 'folder' && probe === 'dir' && !state.detected) await detectType(location, seq);
    if (seq !== state.probeSeq) return;

    const v = location && !isLocalAbsolute
      ? { ok: false, error: 'newProject.v.absolutePath' }
      : validateDraft({
        source: state.source, name, location, repoUrl: repoInput.value, template: state.template,
        probe, projects: projectsState.get().projects, joinPath: path.join,
      });
    state.validation = v;
    submitBtn.disabled = !v.ok;

    let hint = '';
    if (!location) hint = `<span class="np-hint-ok">${escapeHtml(t(state.source === 'folder' ? 'newProject.v.pickFolder' : 'newProject.v.pickLocation'))}</span>`;
    else if (v.error) hint = `<span class="np-hint-error">${escapeHtml(t(v.error, v.errorParams || {}))}</span>`;
    else if (v.warning) hint = `<span class="np-hint-warning">${escapeHtml(t(v.warning))}</span>`;
    else if (v.ok && state.source !== 'folder') hint = `<span class="np-hint-ok">${escapeHtml(t('newProject.willBeCreatedIn'))} <code>${escapeHtml(v.target)}</code></span>`;
    else if (v.ok) hint = `<span class="np-hint-ok">✓ ${escapeHtml(t('newProject.folderFound'))}</span>`;
    hintEl.innerHTML = hint;
  }

  async function detectType(folder, seq) {
    let entries = [];
    try { entries = await fsp.readdir(folder); } catch { return; }
    let pkg = null;
    if (entries.includes('package.json')) {
      try { pkg = JSON.parse(await readSmall(fsp, path.join(folder, 'package.json')) || 'null'); } catch { pkg = null; }
    }
    let py = null;
    for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile']) {
      if (entries.includes(f)) py = `${py || ''}\n${await readSmall(fsp, path.join(folder, f)) || ''}`;
    }
    if (seq !== state.probeSeq) return;
    const found = detectProjectType(entries, pkg, py);
    state.detected = found || { type: null };
    const badge = $('#np-detected');
    if (found && registry.get(found.type)) {
      badge.textContent = t('newProject.detectedType', { type: t(registry.get(found.type).nameKey), reason: found.reason });
      if (!state.typeTouched) selectType(found.type, { auto: true });
    } else {
      badge.textContent = '';
    }
  }

  // ── Submit ────────────────────────────────────────────────────────────
  $('#btn-cancel-wizard').onclick = () => closeModal();
  form.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); }
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (form.dataset.operationId) { await api.operations.cancel(form.dataset.operationId); return; }
    clearTimeout(validateTimer);
    await runValidation();
    const v = state.validation;
    if (!v.ok) return;

    const name = nameInput.value.trim();
    const location = pathInput.value.trim();
    const repoUrl = repoInput.value.trim();
    const projPath = v.target;
    const source = state.source;
    let type = state.type;
    submitBtn.disabled = true;

    // Remember what worked, so the next project starts from here.
    setSetting('newProjectLastSource', source);
    setSetting('newProjectOpenAfter', $('#np-open-after').checked);
    if (source !== 'folder' && path.isAbsolute(location)) setSetting('projectsRootDir', location);

    try {
      if (source === 'folder' && (await probePath(fsp, projPath)) === 'missing') {
        await fsp.mkdir(projPath, { recursive: true });
      }
      if (source === 'create') {
        await fsp.mkdir(projPath, { recursive: true });
        if ($('#chk-init-git')?.checked) {
          try {
            await api.project.initGit({ projectPath: projPath });
            await fsp.writeFile(path.join(projPath, '.gitignore'), GITIGNORE);
          } catch (gitErr) {
            showToast(t('newProject.folderCreatedGitInitError', { error: gitErr.message }), 'error');
          }
        }
      }
    } catch (err) {
      showToast(t('newProject.unableToCreateFolder', { error: err.message }), 'error');
      submitBtn.disabled = false;
      return;
    }

    // Clone / template run in a main-process staging folder, cancellable; the
    // form stays as it was so a retry is one click.
    if (source === 'clone' || source === 'scaffold') {
      const operationId = crypto.randomUUID();
      form.dataset.operationId = operationId;
      const controls = [...form.querySelectorAll('input, select, textarea, button')]
        .filter((c) => c !== submitBtn).map((c) => [c, c.disabled]);
      controls.forEach(([c]) => { c.disabled = true; });
      const label = submitBtn.innerHTML;
      submitBtn.disabled = false;
      submitBtn.type = 'button';
      submitBtn.textContent = t('common.cancel');
      submitBtn.onclick = () => api.operations.cancel(operationId);
      const status = form.querySelector('.clone-status');
      status.style.display = 'block';
      status.textContent = source === 'clone' ? t('newProject.cloning') : t('newProject.scaffolding');
      const unsubscribe = api.operations.onProgress((p) => {
        if (p.operationId === operationId && p.message) status.textContent = p.message.slice(-500);
      });
      let done = false;
      try {
        const result = source === 'clone'
          ? await api.git.clone({ operationId, repoUrl, targetPath: projPath })
          : await api.project.scaffold({ operationId, template: state.template, targetPath: projPath });
        if (!result.success) status.textContent = result.cancelled ? t('newProject.creationCancelled') : result.error;
        else done = true;
        if (source === 'scaffold') type = 'webapp';
      } catch (error) {
        status.textContent = error.message;
      } finally {
        unsubscribe();
        delete form.dataset.operationId;
        controls.forEach(([c, disabled]) => { c.disabled = disabled; });
        submitBtn.type = 'submit';
        submitBtn.onclick = null;
        submitBtn.disabled = false;
        submitBtn.innerHTML = label;
      }
      if (!done || !form.isConnected || !document.getElementById('modal-overlay')?.classList.contains('active')) return;
    }

    try {
      const project = { id: generateProjectId(), name, path: projPath, type, folderId: null };
      const chosenAccount = document.getElementById('wizard-account')?.value;
      if (chosenAccount) project.accountId = chosenAccount;
      if (state.color) project.color = state.color;
      const handler = registry.get(type);
      Object.assign(project, handler.getWizardConfig(form));
      if (handler.afterProjectCreate) await handler.afterProjectCreate(project, projPath);

      const current = projectsState.get();
      projectsState.set({ projects: [...current.projects, project], rootOrder: [...current.rootOrder, project.id] });
      if (state.folderId) moveItemToFolder('project', project.id, state.folderId);
      saveProjects();
      renderProjects();
      const openAfter = $('#np-open-after').checked;
      closeModal();
      checkProjectGitStatus(project);
      openProject(project, { startSession: openAfter });
    } catch (err) {
      console.error('[NewProject] Failed to register project:', err);
      showToast(t('newProject.registrationError', { error: err.message }), 'error');
      submitBtn.disabled = false;
    }
  };

  // ── Initial state ─────────────────────────────────────────────────────
  if (opts.presetPath) {
    pathInput.value = opts.presetPath;
    nameInput.value = path.basename(opts.presetPath);
  }
  applySource(state.source);
  selectType('standalone', { auto: true });
  // A dropped folder is only a path: the renderer may not read it until the
  // user picks it in the folder dialog, which is what grants it. Open that
  // dialog on the folder itself, so confirming is a single keystroke.
  if (opts.presetPath && (await probePath(fsp, opts.presetPath)) === 'denied') {
    setTimeout(() => $('#btn-browse')?.click(), 150);
  }
  setTimeout(() => (opts.presetPath || state.source === 'clone' ? (state.source === 'clone' ? repoInput : nameInput) : nameInput).focus(), 60);
}

module.exports = { openNewProjectModal, probePath };
