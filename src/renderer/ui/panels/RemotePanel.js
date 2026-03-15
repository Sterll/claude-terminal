/**
 * RemotePanel
 * Local Wi-Fi remote control panel — PIN auth, QR code, server start/stop.
 * Cloud functionality moved to dedicated CloudPanel.
 */

const { t } = require('../../i18n');
const QRCode = require('qrcode');

let _ctx = null;
let _pinRefreshInterval = null;
let _statusInterval = null;

function buildHtml(settings) {
  const remoteEnabled = settings.remoteEnabled || false;
  const remotePort = settings.remotePort || 3712;
  const showLocal = remoteEnabled ? '' : 'display:none';

  return `
    <!-- ═══ Master Toggle ═══ -->
    <div class="rp-master-toggle">
      <div class="rp-master-toggle-content">
        <div class="rp-master-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
            <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
            <line x1="12" y1="20" x2="12.01" y2="20"/>
          </svg>
        </div>
        <div class="rp-master-text">
          <div class="rp-master-title">${t('remote.enable')}</div>
          <div class="rp-master-desc">${t('remote.enableDesc')}</div>
        </div>
      </div>
      <div class="rp-master-actions">
        <button class="rp-help-btn" id="rp-help-btn" type="button" title="${t('remote.helpTitle')}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </button>
        <label class="settings-toggle">
          <input type="checkbox" id="remote-enabled-toggle" ${remoteEnabled ? 'checked' : ''}>
          <span class="settings-toggle-slider"></span>
        </label>
      </div>
    </div>

    <!-- ═══ Help Guide Overlay ═══ -->
    <div class="rp-help-overlay" id="rp-help-overlay" style="display:none">
      <div class="rp-help-panel">
        <div class="rp-help-header">
          <h3 class="rp-help-heading">${t('remote.helpTitle')}</h3>
          <button class="rp-help-close" id="rp-help-close" type="button">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <p class="rp-help-intro">${t('remote.helpIntro')}</p>

        <div class="rp-help-section">
          <div class="rp-help-section-icon rp-help-icon-local">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>
            </svg>
          </div>
          <div class="rp-help-section-content">
            <h4>${t('remote.helpLocalTitle')}</h4>
            <ol class="rp-help-steps">
              <li>${t('remote.helpLocalStep1')}</li>
              <li>${t('remote.helpLocalStep2')}</li>
              <li>${t('remote.helpLocalStep3')}</li>
              <li>${t('remote.helpLocalStep4')}</li>
            </ol>
            <div class="rp-help-note">${t('remote.helpLocalNote')}</div>
          </div>
        </div>

        <div class="rp-help-section rp-help-section-security">
          <div class="rp-help-section-icon rp-help-icon-security">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <div class="rp-help-section-content">
            <h4>${t('remote.helpSecurityTitle')}</h4>
            <ul class="rp-help-list">
              <li>${t('remote.helpSecurityPoint1')}</li>
              <li>${t('remote.helpSecurityPoint2')}</li>
              <li>${t('remote.helpSecurityPoint3')}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ Connection Zone ═══ -->
    <div id="rp-connection-zones" style="${showLocal}">

      <!-- ═══ LOCAL ZONE ═══ -->
      <div class="rp-zone" id="rp-zone-local">

        <!-- How it works -->
        <div class="rp-info-banner">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
          <span>${t('remote.localInfoBanner')}</span>
        </div>

        <!-- Server status + action -->
        <div class="rp-server-card">
          <div class="rp-server-header">
            <div class="rp-server-status-area">
              <span class="rp-status-indicator" id="remote-status-indicator"></span>
              <span class="rp-server-status-label" id="remote-status-text">${t('remote.serverStopped')}</span>
            </div>
            <button class="rp-server-btn" id="remote-toggle-server-btn">${t('remote.startServer')}</button>
          </div>
          <div class="rp-server-url" id="rp-server-url-display"></div>
        </div>

        <!-- QR + PIN side by side -->
        <div class="rp-pair-zone" id="rp-pair-zone" style="display:none">
          <div class="rp-pair-title">${t('remote.pairTitle')}</div>
          <div class="rp-pair-grid">

            <!-- QR Column -->
            <div class="rp-pair-col rp-qr-col">
              <div class="rp-pair-step-label">${t('remote.stepScan')}</div>
              <div class="rp-qr-wrapper">
                <canvas id="remote-qr-canvas"></canvas>
              </div>
              <div class="rp-qr-url-mini" id="remote-qr-url"></div>
            </div>

            <!-- Divider -->
            <div class="rp-pair-divider">
              <span>${t('remote.or')}</span>
            </div>

            <!-- PIN Column -->
            <div class="rp-pair-col rp-pin-col">
              <div class="rp-pair-step-label">${t('remote.stepPin')}</div>
              <div class="rp-pin-display" id="remote-pin-display">
                <span class="rp-pin-digit" id="pin-d0">-</span>
                <span class="rp-pin-digit" id="pin-d1">-</span>
                <span class="rp-pin-digit" id="pin-d2">-</span>
                <span class="rp-pin-sep"></span>
                <span class="rp-pin-digit" id="pin-d3">-</span>
                <span class="rp-pin-digit" id="pin-d4">-</span>
                <span class="rp-pin-digit" id="pin-d5">-</span>
              </div>
              <div class="rp-pin-countdown" id="remote-pin-countdown"></div>
              <button class="rp-pin-refresh" id="remote-pin-refresh-btn">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
                ${t('remote.pinRefresh')}
              </button>
            </div>

          </div>
        </div>

        <!-- Advanced settings (collapsed) -->
        <details class="rp-advanced">
          <summary>${t('remote.advancedSettings')}</summary>
          <div class="rp-advanced-body">
            <div class="rp-advanced-row">
              <div class="rp-advanced-label">${t('remote.port')}</div>
              <input type="number" id="remote-port-input" class="rp-input-sm" value="${remotePort}" min="1024" max="65535">
            </div>
            <div class="rp-advanced-row">
              <div class="rp-advanced-label">${t('remote.networkInterface')}</div>
              <select id="remote-iface-select" class="rp-select-sm">
                <option value="">${t('remote.networkInterfaceAuto')}</option>
              </select>
            </div>
          </div>
        </details>

      </div>

    </div>
  `;
}


function setupHandlers(context) {
  _ctx = context;

  const toggle = document.getElementById('remote-enabled-toggle');
  const zones = document.getElementById('rp-connection-zones');
  const portInput = document.getElementById('remote-port-input');
  const ifaceSelect = document.getElementById('remote-iface-select');
  const refreshBtn = document.getElementById('remote-pin-refresh-btn');

  if (!toggle) return;

  // ── Help guide ──
  const helpBtn = document.getElementById('rp-help-btn');
  const helpOverlay = document.getElementById('rp-help-overlay');
  const helpClose = document.getElementById('rp-help-close');

  if (helpBtn && helpOverlay) {
    helpBtn.addEventListener('click', () => {
      helpOverlay.style.display = '';
    });
  }
  if (helpClose && helpOverlay) {
    helpClose.addEventListener('click', () => {
      helpOverlay.style.display = 'none';
    });
  }
  if (helpOverlay) {
    helpOverlay.addEventListener('click', (e) => {
      if (e.target === helpOverlay) helpOverlay.style.display = 'none';
    });
  }

  async function populateIfaceSelect() {
    if (!ifaceSelect) return;
    try {
      const info = await window.electron_api.remote.getServerInfo();
      const ifaces = info.networkInterfaces || [];
      const savedIp = _ctx.settingsState.get().remoteSelectedIp || '';
      while (ifaceSelect.options.length > 1) ifaceSelect.remove(1);
      for (const { ifaceName, address } of ifaces) {
        const opt = document.createElement('option');
        opt.value = address;
        opt.textContent = `${address} (${ifaceName})`;
        if (address === savedIp) opt.selected = true;
        ifaceSelect.appendChild(opt);
      }
      if (!savedIp) ifaceSelect.value = '';
    } catch (e) {}
  }

  // ── Master toggle ──
  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;
    _ctx.settingsState.setProp('remoteEnabled', enabled);
    _ctx.saveSettings();

    if (zones) zones.style.display = enabled ? '' : 'none';

    if (enabled) {
      await populateIfaceSelect();
      await refreshServerStatus();
      _startPinPolling();
    } else {
      _stopPinPolling();
    }
  });

  if (portInput) {
    portInput.addEventListener('change', () => {
      const port = parseInt(portInput.value) || 3712;
      _ctx.settingsState.setProp('remotePort', port);
      _ctx.saveSettings();
    });
  }

  if (ifaceSelect) {
    ifaceSelect.addEventListener('change', () => {
      const ip = ifaceSelect.value || null;
      _ctx.settingsState.setProp('remoteSelectedIp', ip);
      _ctx.saveSettings();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.classList.add('spinning');
      await window.electron_api.remote.generatePin();
      await _loadAndShowPin();
      setTimeout(() => refreshBtn.classList.remove('spinning'), 400);
    });
  }

  const toggleServerBtn = document.getElementById('remote-toggle-server-btn');
  if (toggleServerBtn) {
    toggleServerBtn.addEventListener('click', async () => {
      toggleServerBtn.disabled = true;
      try {
        const info = await window.electron_api.remote.getServerInfo();
        if (info.running) {
          await window.electron_api.remote.stopServer();
        } else {
          await window.electron_api.remote.startServer();
        }
        await refreshServerStatus();
      } finally {
        toggleServerBtn.disabled = false;
      }
    });
  }

  if (_ctx.settingsState.get().remoteEnabled) {
    populateIfaceSelect();
    refreshServerStatus();
    _startPinPolling();
  }

  // Server status refresh every 10s
  if (_statusInterval) clearInterval(_statusInterval);
  _statusInterval = setInterval(() => {
    if (!document.getElementById('remote-enabled-toggle')) {
      clearInterval(_statusInterval);
      _statusInterval = null;
      _stopPinPolling();
      return;
    }
    if (_ctx.settingsState.get().remoteEnabled) refreshServerStatus();
  }, 10000);
}

async function _startPinPolling() {
  _stopPinPolling();
  await window.electron_api.remote.generatePin();
  _loadAndShowPin();
  _pinRefreshInterval = setInterval(() => {
    if (!document.getElementById('remote-pin-display')) { _stopPinPolling(); return; }
    _loadAndShowPin();
  }, 5000);
}

function _stopPinPolling() {
  if (_pinRefreshInterval) { clearInterval(_pinRefreshInterval); _pinRefreshInterval = null; }
}

async function _loadAndShowPin() {
  try {
    const result = await window.electron_api.remote.getPin();
    if (!result.success) return;
    if (!result.pin || Date.now() >= result.expiresAt) {
      await window.electron_api.remote.generatePin();
      const fresh = await window.electron_api.remote.getPin();
      if (fresh.success) _showPin(fresh.pin, fresh.expiresAt);
      return;
    }
    _showPin(result.pin, result.expiresAt);
  } catch (e) {}
}

function _showPin(pin, expiresAt) {
  const pinStr = String(pin).padStart(6, '0');
  ['pin-d0', 'pin-d1', 'pin-d2', 'pin-d3', 'pin-d4', 'pin-d5'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.textContent = pinStr[i] || '-';
  });

  const countdown = document.getElementById('remote-pin-countdown');
  if (!countdown) return;
  const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  if (remaining <= 0) {
    countdown.textContent = t('remote.pinExpired');
    countdown.classList.add('expired');
  } else {
    countdown.textContent = t('remote.pinExpires', { seconds: remaining });
    countdown.classList.remove('expired');
  }
}

async function refreshServerStatus() {
  const indicator = document.getElementById('remote-status-indicator');
  const statusText = document.getElementById('remote-status-text');
  const toggleBtn = document.getElementById('remote-toggle-server-btn');
  const urlDisplay = document.getElementById('rp-server-url-display');
  const pairZone = document.getElementById('rp-pair-zone');
  if (!indicator || !statusText) return;
  try {
    const info = await window.electron_api.remote.getServerInfo();
    if (info.running) {
      indicator.classList.add('online');
      statusText.textContent = t('remote.serverRunning');
      if (toggleBtn) {
        toggleBtn.textContent = t('remote.stopServer');
        toggleBtn.classList.add('rp-btn-danger');
      }
      if (urlDisplay) urlDisplay.textContent = info.address || '';
      if (pairZone) pairZone.style.display = '';
      _renderQrCode(info.address);
    } else {
      indicator.classList.remove('online');
      statusText.textContent = t('remote.serverStopped');
      if (toggleBtn) {
        toggleBtn.textContent = t('remote.startServer');
        toggleBtn.classList.remove('rp-btn-danger');
      }
      if (urlDisplay) urlDisplay.textContent = '';
      if (pairZone) pairZone.style.display = 'none';
      _renderQrCode(null);
    }
  } catch (e) {
    statusText.textContent = t('remote.serverStopped');
    if (toggleBtn) {
      toggleBtn.textContent = t('remote.startServer');
      toggleBtn.classList.remove('rp-btn-danger');
    }
    if (urlDisplay) urlDisplay.textContent = '';
    if (pairZone) pairZone.style.display = 'none';
    _renderQrCode(null);
  }
}

let _lastQrUrl = null;
function _renderQrCode(url) {
  const canvas = document.getElementById('remote-qr-canvas');
  const urlEl = document.getElementById('remote-qr-url');
  if (!canvas) return;

  if (!url) {
    canvas.style.display = 'none';
    if (urlEl) urlEl.textContent = '';
    _lastQrUrl = null;
    return;
  }

  if (url === _lastQrUrl) return;
  _lastQrUrl = url;

  canvas.style.display = 'block';
  if (urlEl) urlEl.textContent = url;

  QRCode.toCanvas(canvas, url, {
    width: 150,
    margin: 2,
    color: { dark: '#e0e0e0', light: '#00000000' },
    errorCorrectionLevel: 'M',
  }).catch(() => {});
}

module.exports = { buildHtml, setupHandlers };
