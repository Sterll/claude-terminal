/**
 * Python Wizard hooks
 * Custom fields for project creation
 */

function getWizardFields() {
  return `
    <div class="python-config" style="display:none;">
      <div class="form-group">
        <label data-i18n="python.venvPathLabel">Virtual environment path</label>
        <input type="text" id="python-venv-path" placeholder=".venv" class="form-input" />
        <small style="color: var(--text-secondary); margin-top: 4px; display: block;" data-i18n="python.venvPathHint">
          Leave empty to auto-detect (.venv, venv, env)
        </small>
      </div>
      <div class="form-group">
        <label data-i18n="python.mainScriptLabel">Main script</label>
        <input type="text" id="python-main-script" placeholder="main.py" class="form-input" />
        <small style="color: var(--text-secondary); margin-top: 4px; display: block;" data-i18n="python.mainScriptHint">
          Leave empty to auto-detect
        </small>
      </div>
    </div>
  `;
}

function onWizardTypeSelected(form, isSelected) {
  const config = form.querySelector('.python-config');
  if (config) {
    config.style.display = isSelected ? 'block' : 'none';
  }
}

function bindWizardEvents(form, api) {
  // No special events needed
}

function getWizardConfig(form) {
  const venvPath = form.querySelector('#python-venv-path')?.value?.trim() || '';
  const mainScript = form.querySelector('#python-main-script')?.value?.trim() || '';
  return {
    venvPath: venvPath || undefined,
    mainScript: mainScript || undefined
  };
}

module.exports = { getWizardFields, onWizardTypeSelected, bindWizardEvents, getWizardConfig };
