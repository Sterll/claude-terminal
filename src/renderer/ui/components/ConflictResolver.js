/**
 * ConflictResolver
 * Modal for resolving sync conflicts between local and cloud data.
 * Shows each conflict with local vs cloud values and lets user choose.
 */

const { createModal, closeModal } = require('./Modal');
const { t } = require('../../i18n');

/**
 * Show sync conflict resolution modal.
 * @param {Array<{entityType, entityId, localValue, cloudValue, cloudTimestamp, localTimestamp}>} conflicts
 * @returns {Promise<Array<{entityType, entityId, choice: 'local'|'cloud', localValue, cloudValue}>>}
 */
function showConflictResolver(conflicts) {
  return new Promise((resolve) => {
    const resolutions = new Map();

    // Default all to cloud (most recent usually)
    for (const conflict of conflicts) {
      const key = `${conflict.entityType}.${conflict.entityId}`;
      resolutions.set(key, 'cloud');
    }

    const content = buildConflictHtml(conflicts);

    const modal = createModal({
      id: 'sync-conflict-modal',
      title: t('sync.conflictTitle'),
      content,
      size: 'medium',
      buttons: [
        { label: t('sync.applyResolutions'), action: 'apply', primary: true },
        { label: t('sync.useAllLocal'), action: 'all-local' },
        { label: t('sync.useAllCloud'), action: 'all-cloud' },
      ],
      onClose: () => {
        // On close without resolution, default to cloud
        const result = conflicts.map(c => ({
          entityType: c.entityType,
          entityId: c.entityId,
          choice: resolutions.get(`${c.entityType}.${c.entityId}`) || 'cloud',
          localValue: c.localValue,
          cloudValue: c.cloudValue,
        }));
        resolve(result);
      },
    });

    document.body.appendChild(modal);

    // Bind choice buttons
    modal.querySelectorAll('.conflict-choice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.conflictKey;
        const choice = btn.dataset.choice;
        resolutions.set(key, choice);

        // Update visual state
        const row = btn.closest('.conflict-row');
        row.querySelectorAll('.conflict-choice-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Bind action buttons
    modal.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;

        if (action === 'all-local') {
          for (const conflict of conflicts) {
            resolutions.set(`${conflict.entityType}.${conflict.entityId}`, 'local');
          }
        } else if (action === 'all-cloud') {
          for (const conflict of conflicts) {
            resolutions.set(`${conflict.entityType}.${conflict.entityId}`, 'cloud');
          }
        }

        if (action === 'apply' || action === 'all-local' || action === 'all-cloud') {
          const result = conflicts.map(c => ({
            entityType: c.entityType,
            entityId: c.entityId,
            choice: resolutions.get(`${c.entityType}.${c.entityId}`) || 'cloud',
            localValue: c.localValue,
            cloudValue: c.cloudValue,
          }));
          closeModal('sync-conflict-modal');
          resolve(result);
        }
      });
    });
  });
}

function buildConflictHtml(conflicts) {
  const rows = conflicts.map(conflict => {
    const key = `${conflict.entityType}.${conflict.entityId}`;
    const localPreview = formatValue(conflict.localValue);
    const cloudPreview = formatValue(conflict.cloudValue);
    const cloudTime = conflict.cloudTimestamp ? formatRelativeTime(conflict.cloudTimestamp) : '?';
    const localTime = conflict.localTimestamp ? formatRelativeTime(conflict.localTimestamp) : '?';
    const label = formatEntityLabel(conflict.entityType, conflict.entityId);

    return `
      <div class="conflict-row">
        <div class="conflict-header">
          <span class="conflict-entity-badge">${conflict.entityType}</span>
          <span class="conflict-entity-name">${label}</span>
        </div>
        <div class="conflict-options">
          <button class="conflict-choice-btn" data-conflict-key="${key}" data-choice="local">
            <div class="conflict-choice-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>
            </div>
            <div class="conflict-choice-label">${t('sync.keepLocal')}</div>
            <div class="conflict-choice-time">${localTime}</div>
            <div class="conflict-choice-preview">${localPreview}</div>
          </button>
          <button class="conflict-choice-btn active" data-conflict-key="${key}" data-choice="cloud">
            <div class="conflict-choice-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>
            </div>
            <div class="conflict-choice-label">${t('sync.keepCloud')}</div>
            <div class="conflict-choice-time">${cloudTime}</div>
            <div class="conflict-choice-preview">${cloudPreview}</div>
          </button>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="conflict-resolver">
      <div class="conflict-description">${t('sync.conflictDescription')}</div>
      <div class="conflict-list">${rows}</div>
    </div>
  `;
}

function formatValue(value) {
  if (value === null || value === undefined) return `<em>${t('sync.nullValue')}</em>`;
  if (typeof value === 'string') return escapeHtml(value.length > 60 ? value.slice(0, 60) + '...' : value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return escapeHtml(json.length > 60 ? json.slice(0, 60) + '...' : json);
  }
  return String(value);
}

function formatEntityLabel(entityType, entityId) {
  if (entityType === 'settings') {
    // Convert camelCase to readable: accentColor → Accent Color
    return entityId.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
  }
  if (entityType === 'projects') {
    return entityId;
  }
  if (entityType === 'mcpConfigs') {
    return t('sync.entityLabelMcp', { id: entityId });
  }
  if (entityType === 'keybindings') {
    return t('sync.entityLabelKeybindings');
  }
  if (entityType === 'memory') {
    return t('sync.entityLabelMemory');
  }
  if (entityType === 'hooksConfig') {
    return t('sync.entityLabelHooksConfig');
  }
  if (entityType === 'timeTracking' || entityType === 'timeTrackingArchives') {
    return t('sync.entityLabelTimeTracking');
  }
  if (entityType === 'conversations') {
    return t('sync.entityLabelConversations');
  }
  if (entityType === 'skills') {
    return t('sync.entityLabelSkills', { id: entityId || '' });
  }
  if (entityType === 'agents') {
    return t('sync.entityLabelAgents', { id: entityId || '' });
  }
  if (entityType === 'installedPlugins') {
    return t('sync.entityLabelPlugins');
  }
  return `${entityType}${entityId ? '.' + entityId : ''}`;
}

function formatRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t('sync.justNow');
  if (minutes < 60) return t('sync.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('sync.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return t('sync.daysAgo', { count: days });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { showConflictResolver };
