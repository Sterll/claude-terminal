/**
 * RemoteProjectModal
 *
 * "Open Remote Project" (design/remote-ssh.md sections 3 and 6): choose an SSH
 * host profile, browse the remote filesystem, then open a folder, create one,
 * `git init` it or clone a repository into it. The result is a `general`
 * project whose path is an `ssh-remote://` URI and whose `remote` block names
 * the profile, the canonical remote path and a display label for the host.
 *
 * Also home to the host profile editor, which the Settings panel's "SSH hosts"
 * tab and the "host not configured on this machine" badge reuse, and to the
 * "Verify host" view: a small terminal running OpenSSH's own host key prompt.
 *
 * What it never does, by construction:
 * - send a host, user, port or ssh option anywhere but `ssh.saveProfile`
 *   (the editor itself); every other call names the host by profile id;
 * - ask for, hold or send a password or passphrase. Password-only hosts work
 *   in a terminal tab, where OpenSSH prompts on its own;
 * - read a remote file: the browser lists directories only.
 */

const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');
const { createModal, showModal, closeModal, showConfirm } = require('./Modal');
const Toast = require('./Toast');
const remotePath = require('../../../shared/remote-path');
const {
  remoteHostsState,
  hostLabelOf,
  getHostProfiles,
  getHostProfile,
  getHostStatus,
  connectHost,
  holdHost,
  saveHostProfile,
  deleteHostProfile,
  testHostProfile,
} = require('../../state/remoteHosts.state');
const { projectsState, addProject, flushProjectsSave } = require('../../state/projects.state');
const { stateLabel, stateTooltip, unsupportedReason } = require('./RemoteHostBadge');

const MODAL_ID = 'remote-project-modal';

/** The editor's fields, and the only keys a saved profile is ever sent with. */
const PROFILE_FIELDS = ['label', 'sshConfigAlias', 'host', 'user', 'port', 'identityFile', 'proxyJump', 'forwardAgent', 'tmuxSessions', 'remoteClaudePath'];

let _defaults = { onProjectCreated: null };
let _active = null; // { modal, cleanup: Set<Function> }

function _api() {
  return window.electron_api || {};
}

/** Callbacks the app wires once (renderer.js): what to do with a created project. */
function setDefaults(defaults) {
  _defaults = { ..._defaults, ...defaults };
}

// ── Small helpers ──

function hostStatusOf(profileId) {
  const profile = getHostProfile(profileId);
  const status = getHostStatus(profileId);
  return { profileId, profile, status, state: status.state, hostLabel: hostLabelOf(profile) };
}

function dotHtml(state) {
  return `<span class="ssh-state-dot state-${escapeHtml(state || 'idle')}"></span>`;
}

/** `user@host:port` from a host label cached on a synced project. */
function parseHostLabel(label) {
  const m = /^(?:([A-Za-z0-9._][A-Za-z0-9._-]*)@)?([A-Za-z0-9._:-]+?|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?$/.exec(String(label || '').trim());
  if (!m) return {};
  return { user: m[1] || '', host: m[2] || '', port: m[3] || '' };
}

/** A single new folder name: no slash, no control character, not . or .. */
function isValidFolderName(name) {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  if (!n || n === '.' || n === '..' || n.includes('/') || n.length > 255) return false;
  return !remotePath.hasControlChars(n);
}

/** Folder name a clone URL suggests: its last segment, without `.git`. */
function folderFromCloneUrl(url) {
  const last = String(url || '').trim().replace(/\/+$/, '').split(/[/:]/).pop() || '';
  return last.replace(/\.git$/i, '');
}

function randomId() {
  return `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function errorText(res) {
  return (res && (res.error || res.code)) || t('ssh.unknownError');
}

// ── Modal lifecycle ──

function _closeActive() {
  if (!_active) return;
  const { modal, cleanup } = _active;
  _active = null;
  for (const fn of cleanup) { try { fn(); } catch (_) { /* best effort */ } }
  closeModal(modal);
}

function _openShell(title) {
  _closeActive();
  const cleanup = new Set();
  const modal = createModal({
    id: MODAL_ID,
    title,
    content: '<div class="ssh-modal"></div>',
    size: 'large',
    onClose: () => {
      if (_active && _active.modal === modal) {
        _active = null;
        for (const fn of cleanup) { try { fn(); } catch (_) { /* best effort */ } }
      }
    },
  });
  _active = { modal, cleanup };
  showModal(modal);
  return { modal, root: modal.querySelector('.ssh-modal'), cleanup };
}

// ── Profile editor (shared with Settings) ──

/**
 * Render the host profile editor into `root`.
 *
 * @param {HTMLElement} root
 * @param {Object} opts
 * @param {Object} [opts.profile] - existing profile to edit
 * @param {Object} [opts.prefill] - { id, hostLabel } for a host synced in from another machine
 * @param {(profile: Object) => void} [opts.onSaved]
 * @param {() => void} [opts.onCancel]
 * @param {(profileId: string) => void} [opts.onVerify]
 * @param {(profileId: string) => void} [opts.onDeleted]
 */
function renderProfileEditor(root, opts = {}) {
  const existing = opts.profile || null;
  const prefill = opts.prefill || {};
  const fromLabel = existing ? {} : parseHostLabel(prefill.hostLabel);
  const value = (key) => {
    if (existing) return existing[key] == null ? '' : existing[key];
    if (key === 'host') return fromLabel.host || '';
    if (key === 'user') return fromLabel.user || '';
    if (key === 'port') return fromLabel.port || '';
    return '';
  };
  // An id comes from the profile being edited, or from a synced project that
  // names a profile this machine does not have yet: saving under that id is
  // what reconnects the project to it.
  const profileId = existing ? existing.id : (remotePath.isValidProfileId(prefill.id) ? prefill.id : null);
  const connected = existing && getHostStatus(existing.id).state !== 'idle';

  const text = (key, label, hint, placeholder = '') => `
    <label class="ssh-field">
      <span class="ssh-field-label">${escapeHtml(label)}</span>
      <input type="text" class="ssh-input" data-field="${key}" value="${escapeHtml(String(value(key)))}" placeholder="${escapeHtml(placeholder)}" spellcheck="false" autocomplete="off">
      ${hint ? `<span class="ssh-field-hint">${escapeHtml(hint)}</span>` : ''}
    </label>`;
  const check = (key, label, hint) => `
    <label class="ssh-check">
      <input type="checkbox" data-field="${key}" ${existing && existing[key] ? 'checked' : ''}>
      <span><span class="ssh-check-label">${escapeHtml(label)}</span>${hint ? `<span class="ssh-field-hint">${escapeHtml(hint)}</span>` : ''}</span>
    </label>`;

  root.innerHTML = `
    <form class="ssh-editor" novalidate>
      ${prefill.hostLabel && !existing ? `<div class="ssh-notice">${escapeHtml(t('ssh.editor.unconfiguredNotice', { host: prefill.hostLabel }))}</div>` : ''}
      <div class="ssh-notice ssh-notice-muted">${escapeHtml(t('ssh.editor.authNote'))}</div>
      <div class="ssh-grid">
        ${text('label', t('ssh.editor.label'), t('ssh.editor.labelHint'), t('ssh.editor.labelPlaceholder'))}
        ${text('sshConfigAlias', t('ssh.editor.alias'), t('ssh.editor.aliasHint'), 'build-box')}
        ${text('host', t('ssh.editor.host'), '', 'build.example.com')}
        ${text('user', t('ssh.editor.user'), '', 'yanis')}
        ${text('port', t('ssh.editor.port'), '', '22')}
        ${text('proxyJump', t('ssh.editor.proxyJump'), t('ssh.editor.proxyJumpHint'), 'bastion.example.com')}
      </div>
      <div class="ssh-field">
        <span class="ssh-field-label">${escapeHtml(t('ssh.editor.identityFile'))}</span>
        <div class="ssh-row">
          <input type="text" class="ssh-input" data-field="identityFile" value="${escapeHtml(String(value('identityFile')))}" readonly placeholder="${escapeHtml(t('ssh.editor.identityFileNone'))}">
          <button type="button" class="btn-secondary ssh-btn" data-action="pick-identity">${escapeHtml(t('ssh.editor.browse'))}</button>
          <button type="button" class="btn-secondary ssh-btn" data-action="clear-identity">${escapeHtml(t('ssh.editor.clear'))}</button>
        </div>
        <span class="ssh-field-hint">${escapeHtml(t('ssh.editor.identityFileHint'))}</span>
      </div>
      ${text('remoteClaudePath', t('ssh.editor.remoteClaudePath'), t('ssh.editor.remoteClaudePathHint'), '/home/yanis/.local/bin/claude')}
      ${check('forwardAgent', t('ssh.editor.forwardAgent'), t('ssh.editor.forwardAgentWarning'))}
      ${check('tmuxSessions', t('ssh.editor.tmuxSessions'), t('ssh.editor.tmuxSessionsHint'))}
      ${connected ? `<div class="ssh-notice">${escapeHtml(t('ssh.editor.reconnectNotice'))}</div>` : ''}
      <div class="ssh-editor-error" role="alert" hidden></div>
      <div class="ssh-test-result" aria-live="polite" hidden></div>
      <div class="ssh-actions">
        ${existing ? `<button type="button" class="btn-danger ssh-btn" data-action="delete">${escapeHtml(t('ssh.editor.delete'))}</button>` : ''}
        <span class="ssh-actions-spacer"></span>
        ${opts.onCancel ? `<button type="button" class="btn-secondary ssh-btn" data-action="cancel">${escapeHtml(t('ssh.back'))}</button>` : ''}
        <button type="button" class="btn-secondary ssh-btn" data-action="save">${escapeHtml(t('ssh.editor.save'))}</button>
        <button type="submit" class="btn-primary ssh-btn" data-action="save-test">${escapeHtml(t('ssh.editor.saveAndTest'))}</button>
      </div>
    </form>`;

  const form = root.querySelector('.ssh-editor');
  const errorEl = form.querySelector('.ssh-editor-error');
  const resultEl = form.querySelector('.ssh-test-result');
  const field = (key) => form.querySelector(`[data-field="${key}"]`);
  let savedId = profileId;

  const showError = (message) => {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  };

  const collect = () => {
    const out = {};
    for (const key of PROFILE_FIELDS) {
      const el = field(key);
      if (!el) continue;
      if (el.type === 'checkbox') out[key] = el.checked;
      else {
        const v = el.value.trim();
        if (key === 'port') out.port = v === '' ? null : (/^\d+$/.test(v) ? Number(v) : v);
        else out[key] = v === '' ? null : v;
      }
    }
    if (savedId) out.id = savedId;
    return out;
  };

  const save = async () => {
    showError('');
    const fields = collect();
    if (!fields.host && !fields.sshConfigAlias) {
      showError(t('ssh.editor.hostRequired'));
      return null;
    }
    const buttons = form.querySelectorAll('button');
    buttons.forEach(b => { b.disabled = true; });
    try {
      const res = await saveHostProfile(fields);
      if (!res || !res.success) {
        showError(t('ssh.editor.saveFailed', { error: errorText(res) }));
        return null;
      }
      savedId = res.profile.id;
      return res.profile;
    } catch (e) {
      showError(t('ssh.editor.saveFailed', { error: e.message }));
      return null;
    } finally {
      buttons.forEach(b => { b.disabled = false; });
    }
  };

  const renderTest = (res) => {
    resultEl.hidden = false;
    resultEl.className = 'ssh-test-result';
    if (!res || !res.success) {
      resultEl.classList.add('is-error');
      resultEl.textContent = t('ssh.test.failed', { error: errorText(res) });
      return;
    }
    const r = res.result || {};
    if (r.ok) {
      resultEl.classList.add('is-ok');
      const caps = r.capabilities || {};
      const claude = caps.claude
        ? t('ssh.test.claudeFound', { version: caps.claudeVersion || '?' })
        : t('ssh.test.claudeMissing');
      resultEl.innerHTML = `<div>${escapeHtml(t('ssh.test.ok', { host: r.destination || '' }))}</div><div class="ssh-field-hint">${escapeHtml(claude)}</div>`;
      return;
    }
    resultEl.classList.add('is-error');
    let message;
    if (r.state === 'unreachable') message = t('ssh.test.unreachable', { reason: (r.detail && r.detail.kind) || '?' });
    else if (r.state === 'unsupported') message = t('ssh.tooltip.unsupported', { host: hostLabelOf(collect()) || '', reason: unsupportedReason(r.detail) });
    else message = stateTooltip({ state: r.state, hostLabel: hostLabelOf(collect()), status: { detail: r.detail } });
    const stderr = r.detail && r.detail.stderr ? String(r.detail.stderr).trim().split(/\r?\n/).slice(-3).join('\n') : '';
    resultEl.innerHTML = `<div>${escapeHtml(stateLabel(r.state === 'unreachable' ? 'offline' : r.state))}: ${escapeHtml(message)}</div>${stderr ? `<pre class="ssh-stderr">${escapeHtml(stderr)}</pre>` : ''}${r.state === 'hostKeyUnknown' && opts.onVerify ? `<button type="button" class="btn-secondary ssh-btn" data-action="verify">${escapeHtml(t('ssh.verify.button'))}</button>` : ''}`;
    const verifyBtn = resultEl.querySelector('[data-action="verify"]');
    if (verifyBtn) verifyBtn.onclick = () => opts.onVerify(savedId);
  };
  form.querySelector('[data-action="pick-identity"]').onclick = async () => {
    try {
      const res = await _api().ssh.pickIdentityFile();
      if (res && res.success && res.path) field('identityFile').value = res.path;
    } catch (e) {
      showError(e.message);
    }
  };
  form.querySelector('[data-action="clear-identity"]').onclick = () => { field('identityFile').value = ''; };

  const cancelBtn = form.querySelector('[data-action="cancel"]');
  if (cancelBtn) cancelBtn.onclick = () => opts.onCancel();

  form.querySelector('[data-action="save"]').onclick = async () => {
    const profile = await save();
    if (profile && opts.onSaved) opts.onSaved(profile);
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const profile = await save();
    if (!profile) return;
    resultEl.hidden = false;
    resultEl.className = 'ssh-test-result';
    resultEl.textContent = t('ssh.test.testing');
    let res;
    try { res = await testHostProfile(profile.id); } catch (err) { res = { success: false, error: err.message }; }
    renderTest(res);
    // The result sits under the whole form, below the fold of the dialog at
    // its usual height: bring it (and its Verify host button) into view.
    if (typeof resultEl.scrollIntoView === 'function') resultEl.scrollIntoView({ block: 'nearest' });
    if (res && res.success && res.result && res.result.ok && opts.onTested) opts.onTested(profile);
  };

  const deleteBtn = form.querySelector('[data-action="delete"]');
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      const ok = await showConfirm({
        title: t('ssh.editor.delete'),
        message: t('ssh.editor.deleteConfirm', { name: existing.label || hostLabelOf(existing) }),
        confirmLabel: t('ssh.editor.delete'),
        danger: true,
      });
      if (!ok) return;
      const res = await deleteHostProfile(existing.id);
      if (!res || !res.success) { showError(errorText(res)); return; }
      if (opts.onDeleted) opts.onDeleted(existing.id);
    };
  }

  return { form, collect };
}

// ── Verify host ──

/**
 * Run OpenSSH's own host key prompt in a small terminal inside `root`. The app
 * shows the fingerprint exactly as OpenSSH prints it and the user types the
 * answer; nothing here answers for them or writes known_hosts.
 */
async function renderVerifyHost(root, profileId, { onDone, onBack, cleanup }) {
  const host = hostStatusOf(profileId);
  root.innerHTML = `
    <div class="ssh-verify">
      <div class="ssh-notice">${escapeHtml(t('ssh.verify.hint', { host: host.hostLabel || profileId }))}</div>
      <div class="ssh-verify-term" aria-label="${escapeHtml(t('ssh.verify.title'))}"></div>
      <div class="ssh-verify-status" aria-live="polite">${escapeHtml(t('ssh.verify.starting'))}</div>
      <div class="ssh-actions">
        <span class="ssh-actions-spacer"></span>
        ${onBack ? `<button type="button" class="btn-secondary ssh-btn" data-action="back">${escapeHtml(t('ssh.back'))}</button>` : ''}
        <button type="button" class="btn-primary ssh-btn" data-action="connect" disabled>${escapeHtml(t('ssh.connect'))}</button>
      </div>
    </div>`;
  const statusEl = root.querySelector('.ssh-verify-status');
  const termEl = root.querySelector('.ssh-verify-term');
  const connectBtn = root.querySelector('[data-action="connect"]');
  const backBtn = root.querySelector('[data-action="back"]');
  const api = _api();
  let ptyId = null;
  let exited = false;
  let stopped = false;
  let term = null;
  const offs = [];
  const stop = () => {
    stopped = true;
    for (const off of offs) { try { off(); } catch (_) { /* gone */ } }
    offs.length = 0;
    if (ptyId != null && !exited) { try { api.terminal.kill({ id: ptyId }); } catch (_) { /* gone */ } }
    if (term) { try { term.dispose(); } catch (_) { /* gone */ } term = null; }
  };
  if (cleanup) cleanup.add(stop);
  if (backBtn) backBtn.onclick = () => { stop(); onBack(); };
  connectBtn.onclick = async () => {
    stop();
    if (onDone) onDone();
  };

  let res;
  try { res = await api.ssh.verifyHost(profileId); } catch (e) { res = { success: false, error: e.message }; }
  if (!res || !res.success) {
    statusEl.textContent = t('ssh.verify.failed', { error: errorText(res) });
    return;
  }
  ptyId = res.id;
  // Closed or navigated away while the PTY was starting: nothing will ever
  // answer OpenSSH's prompt, so end it now instead of leaving ssh waiting.
  if (stopped) {
    try { api.terminal.kill({ id: ptyId }); } catch (_) { /* gone */ }
    return;
  }

  const pending = [];
  offs.push(api.terminal.onData(({ id, data }) => {
    if (id !== ptyId) return;
    if (term) term.write(data); else pending.push(data);
  }));
  offs.push(api.terminal.onExit(({ id, exitCode }) => {
    if (id !== ptyId) return;
    exited = true;
    statusEl.textContent = exitCode === 0 ? t('ssh.verify.done') : t('ssh.verify.exited', { code: exitCode == null ? '?' : exitCode });
    connectBtn.disabled = false;
  }));
  statusEl.textContent = t('ssh.verify.running');

  try {
    const { Terminal, FitAddon } = await require('../../services/xtermLoader').loadXterm();
    if (stopped) return; // stop() already ended the PTY; nothing to show it in
    const css = getComputedStyle(document.documentElement);
    const color = (name) => css.getPropertyValue(name).trim() || undefined;
    term = new Terminal({
      fontSize: 13,
      cursorBlink: true,
      scrollback: 1000,
      theme: { background: color('--bg-primary'), foreground: color('--text-primary'), cursor: color('--accent') },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termEl);
    try { fit.fit(); api.terminal.resize({ id: ptyId, cols: term.cols, rows: term.rows }); } catch (_) { /* hidden pane */ }
    for (const chunk of pending.splice(0)) term.write(chunk);
    term.onData((data) => { if (!exited) api.terminal.input({ id: ptyId, data }); });
    term.focus();
  } catch (e) {
    statusEl.textContent = t('ssh.verify.failed', { error: e.message });
  }
}

// ── Remote directory browser ──

/**
 * Browse a host's directories and turn one into a project.
 * @param {HTMLElement} root
 * @param {string} profileId
 * @param {{ onBack?: Function, onCreated: (project: Object) => void, cleanup: Set<Function> }} opts
 */
function renderBrowser(root, profileId, opts) {
  const api = _api();
  const profile = getHostProfile(profileId);
  const hostLabel = hostLabelOf(profile);
  const release = holdHost(profileId);
  opts.cleanup.add(release);

  let current = null;      // canonical remote path being shown
  let busy = false;
  let cloneOperation = null;

  root.innerHTML = `
    <div class="ssh-browser">
      <div class="ssh-browser-head">
        <span class="ssh-browser-host">${dotHtml('connecting')}<span class="ssh-browser-host-label">${escapeHtml(hostLabel)}</span></span>
        <div class="ssh-row ssh-path-row">
          <button type="button" class="btn-secondary ssh-btn ssh-icon-btn" data-action="up" title="${escapeHtml(t('ssh.browser.parent'))}" aria-label="${escapeHtml(t('ssh.browser.parent'))}">..</button>
          <button type="button" class="btn-secondary ssh-btn" data-action="home">${escapeHtml(t('ssh.browser.home'))}</button>
          <input type="text" class="ssh-input ssh-path-input" spellcheck="false" autocomplete="off" aria-label="${escapeHtml(t('ssh.browser.path'))}">
          <button type="button" class="btn-secondary ssh-btn" data-action="go">${escapeHtml(t('ssh.browser.go'))}</button>
        </div>
      </div>
      <div class="ssh-browser-status" role="status" aria-live="polite"></div>
      <ul class="ssh-dir-list" role="listbox" aria-label="${escapeHtml(t('ssh.browser.folders'))}"></ul>
      <div class="ssh-browser-tools">
        <div class="ssh-row">
          <input type="text" class="ssh-input" data-input="new-folder" placeholder="${escapeHtml(t('ssh.browser.newFolderPlaceholder'))}" spellcheck="false" autocomplete="off" aria-label="${escapeHtml(t('ssh.browser.newFolder'))}">
          <button type="button" class="btn-secondary ssh-btn" data-action="mkdir">${escapeHtml(t('ssh.browser.newFolder'))}</button>
        </div>
        <details class="ssh-clone">
          <summary>${escapeHtml(t('ssh.clone.title'))}</summary>
          <div class="ssh-row">
            <input type="text" class="ssh-input" data-input="clone-url" placeholder="${escapeHtml(t('ssh.clone.urlPlaceholder'))}" spellcheck="false" autocomplete="off" aria-label="${escapeHtml(t('ssh.clone.url'))}">
            <input type="text" class="ssh-input ssh-input-narrow" data-input="clone-folder" placeholder="${escapeHtml(t('ssh.clone.folder'))}" spellcheck="false" autocomplete="off" aria-label="${escapeHtml(t('ssh.clone.folder'))}">
            <button type="button" class="btn-secondary ssh-btn" data-action="clone">${escapeHtml(t('ssh.clone.start'))}</button>
            <button type="button" class="btn-secondary ssh-btn" data-action="clone-cancel" hidden>${escapeHtml(t('ssh.clone.cancel'))}</button>
          </div>
          <div class="ssh-clone-progress ssh-field-hint" aria-live="polite"></div>
          <div class="ssh-field-hint">${escapeHtml(t('ssh.clone.credentialsNote'))}</div>
        </details>
      </div>
      <div class="ssh-actions">
        ${opts.onBack ? `<button type="button" class="btn-secondary ssh-btn" data-action="back">${escapeHtml(t('ssh.back'))}</button>` : ''}
        <span class="ssh-actions-spacer"></span>
        <button type="button" class="btn-secondary ssh-btn" data-action="init">${escapeHtml(t('ssh.browser.gitInit'))}</button>
        <button type="button" class="btn-primary ssh-btn" data-action="open">${escapeHtml(t('ssh.browser.open'))}</button>
      </div>
    </div>`;

  const q = (sel) => root.querySelector(sel);
  const statusEl = q('.ssh-browser-status');
  const listEl = q('.ssh-dir-list');
  const pathInput = q('.ssh-path-input');
  const hostDot = q('.ssh-browser-host .ssh-state-dot');
  const progressEl = q('.ssh-clone-progress');

  const setStatus = (message, kind = '') => {
    statusEl.textContent = message || '';
    statusEl.className = `ssh-browser-status${kind ? ` is-${kind}` : ''}`;
  };
  const setHostDot = (state) => { if (hostDot) hostDot.className = `ssh-state-dot state-${state}`; };
  const setBusy = (value) => {
    busy = value;
    root.querySelectorAll('[data-action]:not([data-action="back"]):not([data-action="clone-cancel"])').forEach(b => { b.disabled = value; });
  };

  const renderEntries = (entries, truncated) => {
    if (!entries.length) {
      listEl.innerHTML = `<li class="ssh-dir-empty">${escapeHtml(t('ssh.browser.empty'))}</li>`;
    } else {
      listEl.innerHTML = entries.map(e => `
        <li class="ssh-dir-item" role="option" tabindex="0" data-name="${escapeHtml(e.name)}">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
          <span>${escapeHtml(e.name)}</span>${e.symlink ? `<span class="ssh-dir-link" title="${escapeHtml(t('ssh.browser.symlink'))}">&#8599;</span>` : ''}
        </li>`).join('');
    }
    if (truncated) setStatus(t('ssh.browser.truncated'));
  };

  const browse = async (dir) => {
    if (busy) return;
    setBusy(true);
    setStatus(t('ssh.browser.loading'));
    try {
      const res = await api.ssh.browse(profileId, dir || '');
      if (!res || !res.success) {
        setStatus(t('ssh.browser.browseFailed', { error: errorText(res) }), 'error');
        return;
      }
      current = res.path;
      pathInput.value = res.path;
      setStatus('');
      // Directories only: the handler never returns anything else, and the
      // list would not show a file even if it did.
      renderEntries((res.entries || []).filter(e => e && e.type === 'directory'), res.truncated);
    } catch (e) {
      setStatus(t('ssh.browser.browseFailed', { error: e.message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const createProject = async (posix) => {
    let canonical;
    try { canonical = remotePath.toPosix(posix); } catch (_) { canonical = null; }
    if (!canonical || canonical === '/') { setStatus(t('ssh.browser.rootRefused'), 'error'); return; }
    const uri = remotePath.format(profileId, canonical);
    const existing = projectsState.get().projects.find(p => p.path === uri);
    if (existing) {
      Toast.showToast({ type: 'info', message: t('ssh.projectExists', { name: existing.name }) });
      opts.onCreated(existing);
      return;
    }
    const project = addProject({
      name: remotePath.basename(canonical),
      remote: { profileId, path: canonical, hostLabel },
    });
    if (!project) { setStatus(t('ssh.browser.createFailed'), 'error'); return; }
    // The project is opened right away, and main resolves its URI against
    // projects.json: write it before anything asks main about it.
    try { await flushProjectsSave(); } catch (e) { console.warn('[RemoteProjectModal] Saving projects:', e.message); }
    Toast.showToast({ type: 'success', message: t('ssh.projectAdded', { name: project.name, host: hostLabel }) });
    opts.onCreated(project);
  };

  const connect = async () => {
    setBusy(true);
    setHostDot('connecting');
    setStatus(t('ssh.tooltip.connecting', { host: hostLabel }));
    const status = await connectHost(profileId);
    setBusy(false);
    const state = status ? status.state : 'offline';
    setHostDot(state);
    if (state === 'connected') {
      await browse('');
      return;
    }
    const message = stateTooltip({ state, hostLabel, status: status || {} });
    setStatus(`${stateLabel(state)}: ${message}`, 'error');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn-secondary ssh-btn';
    retry.textContent = state === 'hostKeyUnknown' ? t('ssh.verify.button') : t('ssh.retry');
    retry.onclick = () => {
      if (state === 'hostKeyUnknown') opts.onVerify(profileId);
      else connect();
    };
    statusEl.appendChild(document.createTextNode(' '));
    statusEl.appendChild(retry);
  };

  // Keep the dot honest while the dialog is open.
  opts.cleanup.add(remoteHostsState.subscribe(() => {
    const state = getHostStatus(profileId).state;
    if (hostDot && current) setHostDot(state);
  }));

  listEl.onclick = (e) => {
    const item = e.target.closest('.ssh-dir-item');
    if (!item || !current) return;
    browse(remotePath.join(current, item.dataset.name));
  };
  listEl.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const item = e.target.closest('.ssh-dir-item');
    if (item && current) browse(remotePath.join(current, item.dataset.name));
  };
  q('[data-action="up"]').onclick = () => { if (current && current !== '/') browse(remotePath.dirname(current)); };
  q('[data-action="home"]').onclick = () => browse('');
  q('[data-action="go"]').onclick = () => {
    const v = pathInput.value.trim();
    if (!v.startsWith('/')) { setStatus(t('ssh.browser.absoluteRequired'), 'error'); return; }
    browse(v);
  };
  pathInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); q('[data-action="go"]').click(); } };
  const backBtn = q('[data-action="back"]');
  if (backBtn) backBtn.onclick = () => opts.onBack();

  q('[data-action="mkdir"]').onclick = async () => {
    const input = q('[data-input="new-folder"]');
    const name = input.value.trim();
    if (!current) return;
    if (!isValidFolderName(name)) { setStatus(t('ssh.browser.invalidFolderName'), 'error'); return; }
    setBusy(true);
    try {
      const res = await api.ssh.mkdir(profileId, remotePath.join(current, name));
      if (!res || !res.success) { setStatus(t('ssh.browser.mkdirFailed', { error: errorText(res) }), 'error'); return; }
      input.value = '';
      setBusy(false);
      await browse(res.path);
    } catch (e) {
      setStatus(t('ssh.browser.mkdirFailed', { error: e.message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  q('[data-action="open"]').onclick = () => { if (current) createProject(current); };

  q('[data-action="init"]').onclick = async () => {
    if (!current) return;
    if (current === '/') { setStatus(t('ssh.browser.rootRefused'), 'error'); return; }
    setBusy(true);
    setStatus(t('ssh.browser.initRunning'));
    try {
      const res = await api.ssh.init(profileId, current);
      if (!res || !res.success) { setStatus(t('ssh.browser.initFailed', { error: errorText(res) }), 'error'); return; }
      await createProject(current);
    } catch (e) {
      setStatus(t('ssh.browser.initFailed', { error: e.message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const urlInput = q('[data-input="clone-url"]');
  const folderInput = q('[data-input="clone-folder"]');
  urlInput.oninput = () => {
    if (!folderInput.dataset.touched) folderInput.value = folderFromCloneUrl(urlInput.value);
  };
  folderInput.oninput = () => { folderInput.dataset.touched = '1'; };

  const cancelCloneBtn = q('[data-action="clone-cancel"]');
  cancelCloneBtn.onclick = () => {
    if (cloneOperation) { try { api.operations.cancel(cloneOperation); } catch (_) { /* gone */ } }
  };
  opts.cleanup.add(() => { if (cloneOperation) { try { api.operations.cancel(cloneOperation); } catch (_) { /* gone */ } } });

  q('[data-action="clone"]').onclick = async () => {
    if (!current) return;
    const url = urlInput.value.trim();
    const folder = (folderInput.value || folderFromCloneUrl(url)).trim();
    if (!url) { setStatus(t('ssh.clone.urlRequired'), 'error'); return; }
    if (!isValidFolderName(folder)) { setStatus(t('ssh.browser.invalidFolderName'), 'error'); return; }
    const dest = remotePath.join(current, folder);
    const operationId = randomId();
    cloneOperation = operationId;
    setBusy(true);
    cancelCloneBtn.hidden = false;
    progressEl.textContent = t('ssh.clone.running');
    const offProgress = api.operations && typeof api.operations.onProgress === 'function'
      ? api.operations.onProgress((p) => {
        if (p && p.operationId === operationId && p.message) progressEl.textContent = p.message;
      })
      : null;
    try {
      // Profile id and the destination path only: the host is resolved in main.
      const res = await api.ssh.clone({ profileId, url, path: dest, operationId });
      if (!res || !res.success) {
        progressEl.textContent = '';
        setStatus(res && res.cancelled ? t('ssh.clone.cancelled') : t('ssh.clone.failed', { error: errorText(res) }), 'error');
        return;
      }
      progressEl.textContent = '';
      await createProject(res.path || dest);
    } catch (e) {
      setStatus(t('ssh.clone.failed', { error: e.message }), 'error');
    } finally {
      if (typeof offProgress === 'function') offProgress();
      cloneOperation = null;
      cancelCloneBtn.hidden = true;
      setBusy(false);
    }
  };

  connect();
}

// ── Host picker ──

function renderHostPicker(root, { selected, onNext, onEdit, onAdd }) {
  const { profiles, error } = { profiles: getHostProfiles(), error: remoteHostsState.get().error };
  let chosen = selected && profiles.some(p => p.id === selected) ? selected : (profiles[0] && profiles[0].id) || null;

  const rows = profiles.map(p => {
    const status = getHostStatus(p.id);
    const tooltip = stateTooltip({ state: status.state, hostLabel: hostLabelOf(p), status });
    return `
      <li class="ssh-host-item${p.id === chosen ? ' selected' : ''}" role="option" tabindex="0" aria-selected="${p.id === chosen}" data-profile-id="${escapeHtml(p.id)}">
        <span title="${escapeHtml(tooltip)}">${dotHtml(status.state)}</span>
        <span class="ssh-host-text">
          <span class="ssh-host-name">${escapeHtml(p.label || hostLabelOf(p))}</span>
          <span class="ssh-host-dest">${escapeHtml(hostLabelOf(p))}${p.proxyJump ? ` ${escapeHtml(t('ssh.picker.via', { jump: p.proxyJump }))}` : ''}</span>
        </span>
        <button type="button" class="btn-secondary ssh-btn" data-action="edit" data-profile-id="${escapeHtml(p.id)}">${escapeHtml(t('ssh.picker.edit'))}</button>
      </li>`;
  }).join('');

  root.innerHTML = `
    <div class="ssh-picker">
      <p class="ssh-field-hint">${escapeHtml(t('ssh.picker.intro'))}</p>
      ${error ? `<div class="ssh-notice is-error">${escapeHtml(t('ssh.storeUnreadable', { error: error.message || error.code || '' }))}</div>` : ''}
      ${profiles.length
        ? `<ul class="ssh-host-list" role="listbox" aria-label="${escapeHtml(t('ssh.picker.title'))}">${rows}</ul>`
        : `<div class="ssh-empty">${escapeHtml(t('ssh.picker.empty'))}</div>`}
      <div class="ssh-actions">
        <button type="button" class="btn-secondary ssh-btn" data-action="add" ${error ? 'disabled' : ''}>${escapeHtml(t('ssh.picker.add'))}</button>
        <span class="ssh-actions-spacer"></span>
        <button type="button" class="btn-primary ssh-btn" data-action="next" ${chosen ? '' : 'disabled'}>${escapeHtml(t('ssh.picker.next'))}</button>
      </div>
    </div>`;

  const select = (id) => {
    chosen = id;
    root.querySelectorAll('.ssh-host-item').forEach(li => {
      const on = li.dataset.profileId === id;
      li.classList.toggle('selected', on);
      li.setAttribute('aria-selected', String(on));
    });
    root.querySelector('[data-action="next"]').disabled = !id;
  };

  root.querySelector('.ssh-picker').onclick = (e) => {
    const edit = e.target.closest('[data-action="edit"]');
    if (edit) { onEdit(edit.dataset.profileId); return; }
    const item = e.target.closest('.ssh-host-item');
    if (item) select(item.dataset.profileId);
  };
  root.querySelector('.ssh-picker').ondblclick = (e) => {
    const item = e.target.closest('.ssh-host-item');
    if (item) { select(item.dataset.profileId); onNext(item.dataset.profileId); }
  };
  root.querySelector('.ssh-picker').onkeydown = (e) => {
    const item = e.target.closest('.ssh-host-item');
    if (item && e.key === 'Enter') { select(item.dataset.profileId); onNext(item.dataset.profileId); }
  };
  root.querySelector('[data-action="add"]').onclick = () => onAdd();
  root.querySelector('[data-action="next"]').onclick = () => { if (chosen) onNext(chosen); };
}

// ── Entry points ──

/**
 * Open the Open Remote Project dialog.
 * @param {Object} [opts]
 * @param {string} [opts.profileId] - start on this host's browser
 * @param {(project: Object) => void} [opts.onProjectCreated]
 */
function openRemoteProjectModal(opts = {}) {
  const { root, cleanup } = _openShell(t('ssh.modalTitle'));
  const onCreated = opts.onProjectCreated || _defaults.onProjectCreated;
  let viewCleanup = new Set();
  const resetView = () => {
    for (const fn of viewCleanup) { try { fn(); } catch (_) { /* gone */ } }
    viewCleanup = new Set();
  };
  cleanup.add(resetView);

  const finish = (project) => {
    _closeActive();
    if (typeof onCreated === 'function') onCreated(project);
  };

  const showPicker = (selected) => {
    resetView();
    renderHostPicker(root, {
      selected,
      onNext: (id) => showBrowser(id),
      onEdit: (id) => showEditor(getHostProfile(id)),
      onAdd: () => showEditor(null),
    });
  };
  const showEditor = (profile) => {
    resetView();
    renderProfileEditor(root, {
      profile,
      onCancel: () => showPicker(profile && profile.id),
      onSaved: (saved) => showPicker(saved.id),
      onDeleted: () => showPicker(null),
      onVerify: (id) => showVerify(id, () => showEditor(getHostProfile(id))),
    });
  };
  const showVerify = (profileId, back) => {
    resetView();
    renderVerifyHost(root, profileId, { onBack: back, onDone: () => showBrowser(profileId), cleanup: viewCleanup });
  };
  const showBrowser = (profileId) => {
    resetView();
    renderBrowser(root, profileId, {
      cleanup: viewCleanup,
      onBack: () => showPicker(profileId),
      onVerify: (id) => showVerify(id, () => showBrowser(id)),
      onCreated: finish,
    });
  };

  if (opts.profileId && getHostProfile(opts.profileId)) showBrowser(opts.profileId);
  else if (!getHostProfiles().length && !remoteHostsState.get().error) showEditor(null);
  else showPicker(opts.profileId);
}

/**
 * The profile editor on its own (Settings, or a project whose host is not
 * configured on this machine).
 * @param {{ profile?: Object, prefill?: { id?: string, hostLabel?: string }, onSaved?: Function }} [opts]
 */
function openHostEditor(opts = {}) {
  const title = opts.profile ? t('ssh.editor.editTitle') : t('ssh.editor.addTitle');
  const { root, cleanup } = _openShell(title);
  const viewCleanup = new Set();
  cleanup.add(() => { for (const fn of viewCleanup) { try { fn(); } catch (_) { /* gone */ } } });
  const show = (profile) => {
    renderProfileEditor(root, {
      profile,
      prefill: profile ? null : opts.prefill,
      onSaved: (saved) => { _closeActive(); if (opts.onSaved) opts.onSaved(saved); },
      onDeleted: () => _closeActive(),
      onVerify: (id) => renderVerifyHost(root, id, {
        cleanup: viewCleanup,
        onBack: () => show(getHostProfile(id)),
        onDone: () => { _closeActive(); connectHost(id); },
      }),
    });
  };
  show(opts.profile || null);
}

/** OpenSSH's host key prompt for a host, on its own. */
function openVerifyHost(profileId) {
  const { root, cleanup } = _openShell(t('ssh.verify.title'));
  renderVerifyHost(root, profileId, {
    cleanup,
    onDone: () => { _closeActive(); connectHost(profileId); },
  });
}

// ── Settings → SSH hosts ──

/**
 * The "SSH hosts" settings tab: every profile with its state, and the editor
 * behind Add / Edit. Repaints on profile or status changes while mounted.
 * @param {HTMLElement} container
 * @returns {Function} unsubscribe
 */
function renderHostsSettings(container) {
  if (!container) return () => {};
  const draw = () => {
    const profiles = getHostProfiles();
    const error = remoteHostsState.get().error;
    container.innerHTML = `
      <div class="ssh-settings">
        <p class="ssh-field-hint">${escapeHtml(t('ssh.settings.intro'))}</p>
        ${error ? `<div class="ssh-notice is-error">${escapeHtml(t('ssh.storeUnreadable', { error: error.message || error.code || '' }))}</div>` : ''}
        ${profiles.length ? `<ul class="ssh-host-list">${profiles.map(p => {
          const status = getHostStatus(p.id);
          const tooltip = stateTooltip({ state: status.state, hostLabel: hostLabelOf(p), status });
          return `
          <li class="ssh-host-item" data-profile-id="${escapeHtml(p.id)}">
            <span title="${escapeHtml(tooltip)}">${dotHtml(status.state)}</span>
            <span class="ssh-host-text">
              <span class="ssh-host-name">${escapeHtml(p.label || hostLabelOf(p))}</span>
              <span class="ssh-host-dest">${escapeHtml(hostLabelOf(p))} - ${escapeHtml(stateLabel(status.state))}</span>
            </span>
            ${status.state === 'connected'
              ? `<button type="button" class="btn-secondary ssh-btn" data-action="disconnect">${escapeHtml(t('ssh.disconnect'))}</button>`
              : `<button type="button" class="btn-secondary ssh-btn" data-action="connect">${escapeHtml(t('ssh.connect'))}</button>`}
            <button type="button" class="btn-secondary ssh-btn" data-action="edit">${escapeHtml(t('ssh.picker.edit'))}</button>
          </li>`;
        }).join('')}</ul>` : `<div class="ssh-empty">${escapeHtml(t('ssh.picker.empty'))}</div>`}
        <div class="ssh-actions">
          <button type="button" class="btn-secondary ssh-btn" data-action="add" ${error ? 'disabled' : ''}>${escapeHtml(t('ssh.picker.add'))}</button>
        </div>
      </div>`;
  };
  container.onclick = (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.closest('[data-profile-id]')?.dataset.profileId;
    if (btn.dataset.action === 'add') openHostEditor({});
    else if (btn.dataset.action === 'edit' && id) openHostEditor({ profile: getHostProfile(id) });
    else if (btn.dataset.action === 'connect' && id) connectHost(id);
    else if (btn.dataset.action === 'disconnect' && id) require('../../state/remoteHosts.state').disconnectHost(id);
  };
  draw();
  const off = remoteHostsState.subscribe(() => {
    if (!container.isConnected) { off(); return; }
    draw();
  });
  return off;
}

module.exports = {
  setDefaults,
  openRemoteProjectModal,
  openHostEditor,
  openVerifyHost,
  renderHostsSettings,
  renderProfileEditor,
  // Exposed for tests.
  parseHostLabel,
  isValidFolderName,
  folderFromCloneUrl,
  PROFILE_FIELDS,
};
