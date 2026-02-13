/**
 * API Wizard hooks
 * Custom fields for project creation
 */

function getWizardFields() {
  return `
    <div class="api-config" style="display:none;">
      <div class="form-group">
        <label data-i18n="api.devCommandLabel">Dev command</label>
        <input type="text" id="api-dev-command" placeholder="npm run dev" class="form-input" />
        <small style="color: var(--text-secondary); margin-top: 4px; display: block;" data-i18n="api.devCommandHint">
          Leave empty to auto-detect (Express, FastAPI, Django, etc.)
        </small>
      </div>
    </div>
  `;
}

function onWizardTypeSelected(form, isSelected) {
  const config = form.querySelector('.api-config');
  if (config) {
    config.style.display = isSelected ? 'block' : 'none';
  }
}

function bindWizardEvents(form, api) {
  // No special events needed
}

function getWizardConfig(form) {
  const devCommand = form.querySelector('#api-dev-command')?.value?.trim() || '';
  return {
    devCommand: devCommand || undefined
  };
}

module.exports = { getWizardFields, onWizardTypeSelected, bindWizardEvents, getWizardConfig };
