/**
 * ClaudeMdSuggestionModal
 * Modal pour proposer des mises à jour du CLAUDE.md après une session chat.
 */

const { t } = require('../../i18n');
const { escapeHtml } = require('../../utils');

/**
 * Show the CLAUDE.md suggestion modal.
 * @param {Array<{title: string, section: string, content: string}>} suggestions
 * @param {boolean} claudeMdExists - Whether CLAUDE.md already exists
 * @param {string} projectPath - Absolute path to project
 * @returns {void}
 */
function showClaudeMdSuggestionModal(suggestions, claudeMdExists, projectPath) {
  if (!suggestions || suggestions.length === 0) return;

  const api = window.electron_api;

  // Remove existing modal if any
  const existing = document.getElementById('claude-md-suggestion-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'claude-md-suggestion-modal';
  overlay.className = 'modal-overlay';

  const suggestionsHtml = suggestions.map((s, i) => `
    <div class="claude-md-suggestion-item">
      <label class="claude-md-suggestion-label">
        <input type="checkbox" class="claude-md-suggestion-check" data-index="${i}" checked>
        <div class="claude-md-suggestion-info">
          <div class="claude-md-suggestion-title">${escapeHtml(s.title)}</div>
          <div class="claude-md-suggestion-section">${escapeHtml(s.section)}</div>
          <pre class="claude-md-suggestion-preview">${escapeHtml(s.content)}</pre>
        </div>
      </label>
    </div>
  `).join('');

  overlay.innerHTML = `
    <div class="modal modal-medium">
      <div class="modal-header">
        <div class="modal-title">${t('claudeMdUpdate.modalTitle')}</div>
        <button class="modal-close" id="claude-md-modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <p class="claude-md-modal-subtitle">${t('claudeMdUpdate.modalSubtitle')}</p>
        ${!claudeMdExists ? `<div class="claude-md-will-create">${t('claudeMdUpdate.willCreate')}</div>` : ''}
        <div class="claude-md-toggle-row">
          <button class="btn-text" id="claude-md-select-all">${t('claudeMdUpdate.selectAll')}</button>
          <button class="btn-text" id="claude-md-deselect-all">${t('claudeMdUpdate.deselectAll')}</button>
        </div>
        <div class="claude-md-suggestions-list">
          ${suggestionsHtml}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="claude-md-modal-dismiss">${t('claudeMdUpdate.dismiss')}</button>
        <button class="btn btn-primary" id="claude-md-modal-apply">
          ${claudeMdExists ? t('claudeMdUpdate.apply') : t('claudeMdUpdate.create')}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Close handlers
  function close() { overlay.remove(); }

  document.getElementById('claude-md-modal-close').addEventListener('click', close);
  document.getElementById('claude-md-modal-dismiss').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Select / deselect all
  document.getElementById('claude-md-select-all').addEventListener('click', () => {
    overlay.querySelectorAll('.claude-md-suggestion-check').forEach(cb => { cb.checked = true; });
  });
  document.getElementById('claude-md-deselect-all').addEventListener('click', () => {
    overlay.querySelectorAll('.claude-md-suggestion-check').forEach(cb => { cb.checked = false; });
  });

  // Apply
  document.getElementById('claude-md-modal-apply').addEventListener('click', async () => {
    const selected = [];
    overlay.querySelectorAll('.claude-md-suggestion-check').forEach(cb => {
      if (cb.checked) {
        const idx = parseInt(cb.dataset.index, 10);
        selected.push(suggestions[idx]);
      }
    });

    if (selected.length === 0) { close(); return; }

    const result = await api.chat.applyClaudeMd({ projectPath, sections: selected });
    if (result.success) {
      close();
    } else {
      console.error('[ClaudeMdSuggestionModal] Apply failed:', result.error);
      close();
    }
  });
}

module.exports = { showClaudeMdSuggestionModal };
