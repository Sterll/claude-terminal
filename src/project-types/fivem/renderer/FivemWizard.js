/**
 * FiveM Wizard Module
 * Provides wizard fields and config extraction for FiveM project creation
 */

const { t } = require('../../../renderer/i18n');

/**
 * Get HTML for FiveM-specific wizard fields
 * @returns {string} HTML string for form fields
 */
function getWizardFields() {
  return `
    <div class="fivem-config" style="display: none;">
      <div class="wizard-field">
        <label class="wizard-label">${t('newProject.launchScript')}</label>
        <div class="wizard-input-row">
          <input type="text" id="inp-fivem-cmd" placeholder="C:\\Serveur\\run.bat" class="wizard-input">
          <button type="button" id="btn-browse-fivem" class="wizard-browse-btn" title="${t('newProject.browse')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Called when a project type is selected in the wizard
 * Shows/hides FiveM-specific fields
 * @param {HTMLFormElement} form - The wizard form
 * @param {boolean} isSelected - Whether FiveM is the selected type
 */
function onWizardTypeSelected(form, isSelected) {
  const config = form.querySelector('.fivem-config');
  if (config) {
    config.style.display = isSelected ? 'block' : 'none';
  }
}

/**
 * Bind FiveM-specific wizard events (e.g., browse button)
 * @param {HTMLFormElement} form - The wizard form
 * @param {Object} api - The electron API
 */
function bindWizardEvents(form, api) {
  const browseBtn = form.querySelector('#btn-browse-fivem');
  if (browseBtn) {
    browseBtn.onclick = async () => {
      const file = await api.dialog.selectFile({
        filters: [{ name: 'Scripts', extensions: ['bat', 'cmd', 'sh', 'exe'] }]
      });
      if (file) {
        form.querySelector('#inp-fivem-cmd').value = file;
      }
    };
  }
}

/**
 * Extract FiveM-specific config from the wizard form
 * @param {HTMLFormElement} form - The wizard form
 * @returns {Object} Config to merge into the project
 */
function getWizardConfig(form) {
  const runCommand = form.querySelector('#inp-fivem-cmd')?.value?.trim() || '';
  return {
    fivemConfig: { runCommand }
  };
}

module.exports = {
  getWizardFields,
  onWizardTypeSelected,
  bindWizardEvents,
  getWizardConfig
};
