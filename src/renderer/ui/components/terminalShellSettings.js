/**
 * Settings → General → Shell and external terminal (issue #255).
 *
 * Two choices, each a list of what main found installed here plus "Custom":
 * the shell a plain shell tab runs, and the terminal application "Open in
 * external terminal" starts, with a Windows Terminal profile when that is the
 * one. The settings are only written here; main reads them from settings.json
 * when a tab or a window opens, so nothing the renderer sends at that moment
 * names a program.
 *
 * A value this machine does not have (a setting synced from another one) is
 * kept and shown as missing rather than silently replaced: picking something
 * else is the user's call.
 *
 * Mounted by SettingsPanel into `#terminal-shell-settings-root`, and saves its
 * own fields, so the panel's big save handler does not need to know about it.
 */

'use strict';

const { t } = require('../../i18n');
const { escapeHtml } = require('../../utils');
const settingsStore = require('../../state/settings.state');

function optionHtml(value, label, selected, extra = '') {
  return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}${extra}>${escapeHtml(label)}</option>`;
}

/** The options of one select, with a missing current value kept visible. */
function selectOptions(defaultLabel, entries, current) {
  const ids = new Set(entries.map((e) => e.id));
  let html = optionHtml('', defaultLabel, !current);
  html += entries.map((e) => optionHtml(e.id, e.label, current === e.id)).join('');
  if (current && current !== 'custom' && !ids.has(current)) {
    html += optionHtml(current, t('settings.shell.missing', { name: current }), true);
  }
  html += optionHtml('custom', t('settings.shell.custom'), current === 'custom');
  return html;
}

function render(options, settings) {
  const shells = options.shells || [];
  const terminals = options.externalTerminals || [];
  const isWindows = options.platform === 'win32';
  const defaultTerminal = terminals.find((x) => x.id === options.defaultExternalTerminal);
  const shellPlaceholder = isWindows ? 'C:\\msys64\\usr\\bin\\zsh.exe' : '/opt/homebrew/bin/nu';
  const argsPlaceholder = isWindows ? '--login -i' : '-l';
  const commandPlaceholder = isWindows
    ? '"C:\\Program Files\\Alacritty\\alacritty.exe" --working-directory {path}'
    : 'alacritty --working-directory {path}';

  return `
    <div class="settings-group-title">${escapeHtml(t('settings.shell.title'))}</div>
    <div class="settings-card terminal-shell-settings">
      <div class="settings-row">
        <div class="settings-label">
          <div id="terminal-shell-label">${escapeHtml(t('settings.shell.shell'))}</div>
          <div class="settings-desc" id="terminal-shell-desc">${escapeHtml(t('settings.shell.shellDesc'))}</div>
        </div>
        <select class="settings-select" id="terminal-shell-select" aria-labelledby="terminal-shell-label" aria-describedby="terminal-shell-desc">
          ${selectOptions(t('settings.shell.default', { name: options.defaultShell || '' }), shells, settings.terminalShell || '')}
        </select>
      </div>
      <div class="terminal-shell-sub" data-show-for="shell-custom">
        <label class="terminal-shell-field">
          <span>${escapeHtml(t('settings.shell.customPath'))}</span>
          <span class="terminal-shell-inline">
            <input type="text" class="settings-input-sm terminal-shell-input" id="terminal-shell-custom-path" spellcheck="false"
              value="${escapeHtml(settings.terminalShellCustomPath || '')}" placeholder="${escapeHtml(shellPlaceholder)}">
            <button type="button" class="btn-outline btn-sm" id="terminal-shell-browse">${escapeHtml(t('settings.shell.browse'))}</button>
          </span>
        </label>
        <label class="terminal-shell-field">
          <span>${escapeHtml(t('settings.shell.customArgs'))}</span>
          <input type="text" class="settings-input-sm terminal-shell-input" id="terminal-shell-custom-args" spellcheck="false"
            value="${escapeHtml(settings.terminalShellCustomArgs || '')}" placeholder="${escapeHtml(argsPlaceholder)}">
        </label>
      </div>
      <div class="settings-row">
        <div class="settings-label">
          <div id="external-terminal-label">${escapeHtml(t('settings.shell.external'))}</div>
          <div class="settings-desc" id="external-terminal-desc">${escapeHtml(t('settings.shell.externalDesc'))}</div>
        </div>
        <select class="settings-select" id="external-terminal-select" aria-labelledby="external-terminal-label" aria-describedby="external-terminal-desc">
          ${selectOptions(t('settings.shell.default', { name: defaultTerminal?.label || '-' }), terminals, settings.externalTerminal || '')}
        </select>
      </div>
      <div class="terminal-shell-sub" data-show-for="external-profile">
        <label class="terminal-shell-field">
          <span>${escapeHtml(t('settings.shell.profile'))}</span>
          <input type="text" class="settings-input-sm terminal-shell-input" id="external-terminal-profile" spellcheck="false" list="external-terminal-profiles"
            value="${escapeHtml(settings.externalTerminalProfile || '')}" placeholder="${escapeHtml(t('settings.shell.profilePlaceholder'))}">
          <datalist id="external-terminal-profiles">
            ${(options.terminalProfiles || []).map((name) => `<option value="${escapeHtml(name)}"></option>`).join('')}
          </datalist>
        </label>
      </div>
      <div class="terminal-shell-sub" data-show-for="external-custom">
        <label class="terminal-shell-field">
          <span>${escapeHtml(t('settings.shell.customCommand'))}</span>
          <input type="text" class="settings-input-sm terminal-shell-input" id="external-terminal-custom" spellcheck="false"
            value="${escapeHtml(settings.externalTerminalCustomCommand || '')}" placeholder="${escapeHtml(commandPlaceholder)}">
        </label>
        <div class="settings-desc">${escapeHtml(t('settings.shell.customCommandHint'))}</div>
      </div>
      <div class="terminal-shell-actions">
        <button type="button" class="btn-outline btn-sm" id="external-terminal-test">${escapeHtml(t('settings.shell.test'))}</button>
        <span class="terminal-shell-status" role="status" aria-live="polite"></span>
      </div>
    </div>`;
}

/**
 * Which sub-rows apply to the current picks.
 * @returns {{ shellCustom: boolean, externalCustom: boolean, externalProfile: boolean }}
 */
function visibleRows(options, shellValue, externalValue) {
  const effective = externalValue || options.defaultExternalTerminal || '';
  const entry = (options.externalTerminals || []).find((x) => x.id === effective);
  return {
    shellCustom: shellValue === 'custom',
    externalCustom: externalValue === 'custom',
    externalProfile: !!entry?.supportsProfile,
  };
}

/**
 * @param {HTMLElement} root
 * @param {{ api: object }} deps
 * @returns {Promise<void>}
 */
async function mountTerminalShellSettings(root, { api }) {
  if (!root || !api?.terminal?.shellOptions) return;
  let options;
  try {
    options = await api.terminal.shellOptions();
  } catch (e) {
    options = { shells: [], externalTerminals: [], terminalProfiles: [] };
  }
  if (!root.isConnected) return;
  const settings = settingsStore.getSettings();
  root.innerHTML = render(options || {}, settings);

  const $ = (sel) => root.querySelector(sel);
  const shellSelect = $('#terminal-shell-select');
  const externalSelect = $('#external-terminal-select');
  const status = $('.terminal-shell-status');

  const refreshRows = () => {
    const rows = visibleRows(options, shellSelect.value, externalSelect.value);
    root.querySelector('[data-show-for="shell-custom"]').hidden = !rows.shellCustom;
    root.querySelector('[data-show-for="external-custom"]').hidden = !rows.externalCustom;
    root.querySelector('[data-show-for="external-profile"]').hidden = !rows.externalProfile;
  };

  const save = () => {
    settingsStore.updateSettings({
      terminalShell: shellSelect.value,
      terminalShellCustomPath: $('#terminal-shell-custom-path').value.trim(),
      terminalShellCustomArgs: $('#terminal-shell-custom-args').value.trim(),
      externalTerminal: externalSelect.value,
      externalTerminalProfile: $('#external-terminal-profile').value.trim(),
      externalTerminalCustomCommand: $('#external-terminal-custom').value.trim(),
    });
  };

  // `change`, not `input`: a path typed one key at a time is not saved half-typed.
  for (const el of root.querySelectorAll('select, input')) {
    el.addEventListener('change', () => { refreshRows(); save(); });
  }

  $('#terminal-shell-browse').addEventListener('click', async () => {
    const isWindows = options.platform === 'win32';
    const file = await api.dialog.selectFile({
      filters: isWindows
        ? [{ name: t('settings.shell.programs'), extensions: ['exe', 'cmd', 'bat'] }, { name: '*', extensions: ['*'] }]
        : [{ name: '*', extensions: ['*'] }],
    });
    if (!file) return;
    $('#terminal-shell-custom-path').value = file;
    save();
  });

  $('#external-terminal-test').addEventListener('click', async () => {
    // What is on screen is what gets tested, even before the change event.
    save();
    const home = window.electron_nodeModules?.os?.homedir?.();
    status.textContent = '';
    status.classList.remove('error');
    const { openExternalTerminal, failureMessage } = require('../../utils/externalTerminal');
    const result = await openExternalTerminal(home, { silent: true });
    if (!root.isConnected) return;
    if (result?.success) {
      status.textContent = t('settings.shell.testOk');
    } else {
      status.textContent = failureMessage(result);
      status.classList.add('error');
    }
  });

  refreshRows();
}

module.exports = { mountTerminalShellSettings, visibleRows, selectOptions };
