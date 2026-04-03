/**
 * ConnectivityPanel
 * Unified "Connectivity" tab — merges Local Wi-Fi (RemotePanel) and
 * Cloud relay (CloudPanel) into a single panel with sub-tabs.
 */

const { t } = require('../../i18n');
const RemotePanel = require('./RemotePanel');
const CloudPanel = require('./CloudPanel');

let _activeSubTab = 'cloud'; // default sub-tab

function buildHtml(settings) {
  return `
    <div class="cn-panel">
      <!-- Sub-tab bar -->
      <div class="cn-tab-bar">
        <button class="cn-tab ${_activeSubTab === 'local' ? 'active' : ''}" data-cn-tab="local">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
            <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
            <line x1="12" y1="20" x2="12.01" y2="20"/>
          </svg>
          <span>${t('connectivity.localTab', 'Local')}</span>
        </button>
        <button class="cn-tab ${_activeSubTab === 'cloud' ? 'active' : ''}" data-cn-tab="cloud">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
          </svg>
          <span>${t('connectivity.cloudTab', 'Cloud')}</span>
        </button>
      </div>

      <!-- Sub-tab content -->
      <div class="cn-content">
        <div class="cn-sub-panel ${_activeSubTab === 'local' ? 'active' : ''}" data-cn-panel="local">
          <div class="cn-sub-panel-inner cn-local-content">
            ${RemotePanel.buildHtml(settings)}
          </div>
        </div>
        <div class="cn-sub-panel ${_activeSubTab === 'cloud' ? 'active' : ''}" data-cn-panel="cloud">
          <div class="cn-sub-panel-inner">
            ${CloudPanel.buildHtml(settings)}
          </div>
        </div>
      </div>
    </div>
  `;
}

function setupHandlers(context) {
  // Wire sub-tab switching
  const tabBtns = document.querySelectorAll('.cn-tab[data-cn-tab]');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.cnTab;
      _activeSubTab = target;

      // Update tab active state
      tabBtns.forEach(b => b.classList.toggle('active', b.dataset.cnTab === target));

      // Update panel visibility
      document.querySelectorAll('.cn-sub-panel[data-cn-panel]').forEach(panel => {
        panel.classList.toggle('active', panel.dataset.cnPanel === target);
      });
    });
  });

  // Setup both sub-panels
  RemotePanel.setupHandlers(context);
  CloudPanel.setupHandlers(context);
}

function cleanup() {
  CloudPanel.cleanup();
}

module.exports = { buildHtml, setupHandlers, cleanup };
