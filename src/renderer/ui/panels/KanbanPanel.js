'use strict';

const { t } = require('../../i18n');
const { escapeHtml } = require('../../utils/dom');
const { formatRelativeTime } = require('../../utils/format');
const { createModal, showModal, closeModal, showConfirm } = require('../components/Modal');
const {
  getTasks, addTask, updateTask, deleteTask, moveTask,
  getKanbanColumns, addKanbanColumn, updateKanbanColumn, deleteKanbanColumn,
  getKanbanLabels, addKanbanLabel, updateKanbanLabel, deleteKanbanLabel,
  migrateTasksToKanban, normalizeKanbanTaskFields,
} = require('../../state');

const LABEL_COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#8b5cf6','#ec4899','#6b7280'];

/**
 * Render the kanban board into a container element.
 * @param {HTMLElement} container
 * @param {Object} project
 * @param {Object} [options]
 * @param {Function} [options.onSessionOpen]  (project, sessionId) => void
 */
function render(container, project, options = {}) {
  // Cleanup previous drag listeners if any
  const board = container.querySelector('.kanban-board');
  if (board && board._kanbanCleanup) {
    board._kanbanCleanup();
  }

  migrateTasksToKanban(project.id);
  normalizeKanbanTaskFields(project.id);
  container.innerHTML = buildBoardHtml(project);
  attachEvents(container, project, options);
}

// ── HTML builders ────────────────────────────────────────────

function buildBoardHtml(project) {
  const cols = getKanbanColumns(project.id);
  return `
    <div class="kanban-board">
      <div class="kanban-toolbar">
        <button class="btn-kanban-labels" id="kanban-btn-labels">⚙ ${t('kanban.manageLabels')}</button>
        <button class="btn-kanban-add-col" id="kanban-btn-add-col">${t('kanban.addColumn')}</button>
      </div>
      <div class="kanban-columns" id="kanban-columns">
        ${cols.map(col => buildColumnHtml(project, col)).join('')}
      </div>
    </div>
  `;
}

function buildColumnHtml(project, col) {
  const tasks = getTasks(project.id)
    .filter(task => task.columnId === col.id)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  return `
    <div class="kanban-column" data-col-id="${escapeHtml(col.id)}">
      <div class="kanban-column-header">
        <span class="kanban-column-color" style="background:${escapeHtml(col.color)}"></span>
        <span class="kanban-column-title">${escapeHtml(col.title)}</span>
        <span class="kanban-column-count">${tasks.length}</span>
        <button class="btn-kanban-col-delete" data-col-id="${escapeHtml(col.id)}" title="${t('kanban.deleteColumn')}">✕</button>
      </div>
      <div class="kanban-cards" data-col-id="${escapeHtml(col.id)}">
        ${tasks.map(task => buildCardHtml(project, task)).join('')}
      </div>
      <button class="btn-kanban-add-card" data-col-id="${escapeHtml(col.id)}">${t('kanban.addCard')}</button>
    </div>
  `;
}

function getWorktreeBranchName(worktreePath) {
  if (!worktreePath) return '';
  return worktreePath.replace(/\\/g, '/').split('/').pop() || worktreePath;
}

function buildCardHtml(project, task) {
  const labels = getKanbanLabels(project.id);
  const labelsHtml = (task.labels || []).map(lid => {
    const lbl = labels.find(l => l.id === lid);
    if (!lbl) return '';
    return `<span class="kanban-label-chip" style="background:${escapeHtml(lbl.color)}">${escapeHtml(lbl.name)}</span>`;
  }).join('');

  const sessionIds = task.sessionIds || [];
  const worktreeHtml = task.worktreePath
    ? `<span class="kanban-card-worktree" title="${escapeHtml(task.worktreePath)}">⎇ ${escapeHtml(getWorktreeBranchName(task.worktreePath))}</span>`
    : '';
  const sessionsHtml = sessionIds.length > 0
    ? `<span class="kanban-card-sessions-count">💬 ${sessionIds.length}</span>`
    : '';

  return `
    <div class="kanban-card" data-task-id="${escapeHtml(task.id)}" data-col-id="${escapeHtml(task.columnId)}">
      <span class="kanban-card-drag-handle">⠿</span>
      <span class="kanban-card-title">${escapeHtml(task.title)}</span>
      ${labelsHtml ? `<div class="kanban-card-labels">${labelsHtml}</div>` : ''}
      ${worktreeHtml || sessionsHtml ? `<div class="kanban-card-meta">${worktreeHtml}${sessionsHtml}</div>` : ''}
      <button class="kanban-card-delete" data-task-id="${escapeHtml(task.id)}" title="${t('kanban.delete')}">✕</button>
    </div>
  `;
}

// ── Events ───────────────────────────────────────────────────

function attachEvents(container, project, options) {
  const board = container.querySelector('.kanban-board');
  if (!board) return;

  board.querySelector('#kanban-btn-add-col')?.addEventListener('click', () => {
    showAddColumnModal(container, project, options);
  });

  board.querySelector('#kanban-btn-labels')?.addEventListener('click', () => {
    showLabelsModal(container, project, options);
  });

  board.addEventListener('click', async (e) => {
    // Column delete
    const delColBtn = e.target.closest('.btn-kanban-col-delete');
    if (delColBtn) {
      const colId = delColBtn.dataset.colId;
      const col = getKanbanColumns(project.id).find(c => c.id === colId);
      if (!col) return;
      const tasks = getTasks(project.id).filter(task => task.columnId === colId);
      if (tasks.length > 0) {
        await showConfirm({
          title: t('kanban.deleteColumn'),
          message: t('kanban.deleteColumnDisabled'),
          confirmLabel: 'OK',
          cancelLabel: '',
        });
        return;
      }
      const ok = await showConfirm({
        title: t('kanban.deleteColumn'),
        message: t('kanban.deleteColumnConfirm').replace('{title}', escapeHtml(col.title)),
        confirmLabel: t('kanban.delete'),
        cancelLabel: t('kanban.cancel'),
        danger: true,
      });
      if (ok) {
        deleteKanbanColumn(project.id, colId);
        render(container, project, options);
      }
      return;
    }

    // Add card button
    const addCardBtn = e.target.closest('.btn-kanban-add-card');
    if (addCardBtn) {
      showInlineAddCard(container, project, addCardBtn.dataset.colId, options);
      return;
    }

    // Card delete
    const delCardBtn = e.target.closest('.kanban-card-delete');
    if (delCardBtn) {
      e.stopPropagation();
      const taskId = delCardBtn.dataset.taskId;
      const task = getTasks(project.id).find(task => task.id === taskId);
      if (!task) return;
      const ok = await showConfirm({
        title: t('kanban.delete'),
        message: t('kanban.confirmDeleteCard').replace('{title}', escapeHtml(task.title)),
        confirmLabel: t('kanban.delete'),
        cancelLabel: t('kanban.cancel'),
        danger: true,
      });
      if (ok) {
        deleteTask(project.id, taskId);
        render(container, project, options);
      }
      return;
    }

    // Card click → edit modal
    const card = e.target.closest('.kanban-card');
    if (card && !e.target.closest('.kanban-card-drag-handle') && !e.target.closest('.kanban-card-delete')) {
      showEditCardModal(container, project, card.dataset.taskId, options);
    }
  });

  // Column title rename (double-click)
  board.addEventListener('dblclick', (e) => {
    const title = e.target.closest('.kanban-column-title');
    if (!title) return;
    const colEl = title.closest('.kanban-column');
    if (!colEl) return;
    startRenameColumn(title, project, colEl.dataset.colId, container, options);
  });

  // Drag & drop
  initDragDrop(board, container, project, options);
}

// ── Column rename (inline) ────────────────────────────────────

function startRenameColumn(titleEl, project, colId, container, options) {
  const original = titleEl.textContent;
  titleEl.contentEditable = 'true';
  titleEl.focus();
  const range = document.createRange();
  range.selectNodeContents(titleEl);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);

  const commit = () => {
    titleEl.contentEditable = 'false';
    const newTitle = titleEl.textContent.trim();
    if (newTitle && newTitle !== original) {
      updateKanbanColumn(project.id, colId, { title: newTitle });
    } else {
      titleEl.textContent = original;
    }
  };

  titleEl.addEventListener('blur', commit, { once: true });
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
    if (e.key === 'Escape') { titleEl.textContent = original; titleEl.blur(); }
  }, { once: true });
}

// ── Inline add card form ──────────────────────────────────────

function showInlineAddCard(container, project, colId, options) {
  const colEl = container.querySelector(`.kanban-column[data-col-id="${colId}"]`);
  if (!colEl) return;
  const addBtn = colEl.querySelector('.btn-kanban-add-card');
  if (addBtn) addBtn.style.display = 'none';

  const form = document.createElement('div');
  form.className = 'kanban-add-card-form';
  form.innerHTML = `
    <input class="kanban-add-card-input" placeholder="${t('kanban.cardTitlePlaceholder')}" maxlength="120">
    <div class="kanban-add-card-actions">
      <button class="kanban-add-card-cancel">${t('kanban.cancel')}</button>
      <button class="kanban-add-card-confirm">${t('kanban.save')}</button>
    </div>
  `;

  colEl.insertBefore(form, addBtn);
  const input = form.querySelector('input');
  input.focus();

  const cancel = () => { form.remove(); if (addBtn) addBtn.style.display = ''; };
  const confirm = () => {
    const title = input.value.trim();
    if (!title) { cancel(); return; }
    addTask(project.id, { title, columnId: colId });
    render(container, project, options);
  };

  form.querySelector('.kanban-add-card-cancel').addEventListener('click', cancel);
  form.querySelector('.kanban-add-card-confirm').addEventListener('click', confirm);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') cancel();
  });
}

// ── Add column modal ──────────────────────────────────────────

function showAddColumnModal(container, project, options) {
  let selectedColor = LABEL_COLORS[4]; // blue

  const colorPresets = LABEL_COLORS.map(c =>
    `<div class="kanban-color-preset${c === selectedColor ? ' active' : ''}" data-color="${c}" style="background:${c};width:22px;height:22px;border-radius:50%;cursor:pointer;border:2px solid transparent;display:inline-block;margin:2px"></div>`
  ).join('');

  const modal = createModal({
    id: 'kanban-add-col-modal',
    title: t('kanban.addColumnTitle'),
    size: 'small',
    content: `
      <div style="display:flex;flex-direction:column;gap:12px">
        <div>
          <label style="font-size:var(--font-xs);color:var(--text-secondary)">${t('kanban.columnTitle')}</label>
          <input id="kanban-new-col-title" class="kanban-add-card-input" style="margin-top:4px"
            placeholder="${t('kanban.columnTitlePlaceholder')}" maxlength="40">
        </div>
        <div>
          <label style="font-size:var(--font-xs);color:var(--text-secondary)">${t('kanban.labelColor')}</label>
          <div id="kanban-col-colors" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">${colorPresets}</div>
        </div>
      </div>
    `,
    buttons: [
      { label: t('kanban.cancel'), action: 'cancel', onClick: (m) => closeModal(m) },
      { label: t('kanban.save'), action: 'confirm', primary: true, onClick: (m) => {
        const title = m.querySelector('#kanban-new-col-title')?.value.trim();
        if (!title) return;
        addKanbanColumn(project.id, { title, color: selectedColor });
        closeModal(m);
        render(container, project, options);
      }},
    ],
  });

  // Wire color picker
  modal.querySelector('#kanban-col-colors')?.addEventListener('click', (e) => {
    const preset = e.target.closest('[data-color]');
    if (!preset) return;
    selectedColor = preset.dataset.color;
    modal.querySelectorAll('[data-color]').forEach(p => {
      p.style.borderColor = p === preset ? 'var(--text-primary)' : 'transparent';
    });
  });

  showModal(modal);
}

// ── Edit card modal ───────────────────────────────────────────

async function showEditCardModal(container, project, taskId, options) {
  const task = getTasks(project.id).find(task => task.id === taskId);
  if (!task) return;
  const labels = getKanbanLabels(project.id);
  let selectedLabels = [...(task.labels || [])];
  let selectedWorktreePath = task.worktreePath || '';
  let selectedSessionIds = [...(task.sessionIds || [])];

  const labelsHtml = labels.length > 0
    ? labels.map(lbl => `
        <span class="kanban-modal-label-chip${selectedLabels.includes(lbl.id) ? ' selected' : ''}"
              data-label-id="${escapeHtml(lbl.id)}"
              style="background:${escapeHtml(lbl.color)}">
          ${escapeHtml(lbl.name)}
        </span>`).join('')
    : `<span style="font-size:var(--font-xs);color:var(--text-muted)">—</span>`;

  const modal = createModal({
    id: `kanban-edit-card-${taskId}`,
    title: t('kanban.editCard'),
    size: 'medium',
    content: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div>
          <label style="font-size:var(--font-xs);color:var(--text-secondary)">${t('kanban.cardTitle')}</label>
          <input id="kanban-edit-title" class="kanban-add-card-input" style="margin-top:4px"
            value="${escapeHtml(task.title)}" maxlength="120">
        </div>
        <div>
          <label style="font-size:var(--font-xs);color:var(--text-secondary)">${t('kanban.cardDescription')}</label>
          <textarea id="kanban-edit-desc" class="kanban-add-card-input" style="margin-top:4px;resize:vertical;min-height:70px"
            placeholder="${t('kanban.cardDescriptionPlaceholder')}">${escapeHtml(task.description || '')}</textarea>
        </div>
        ${labels.length > 0 ? `
        <div>
          <label style="font-size:var(--font-xs);color:var(--text-secondary)">${t('kanban.cardLabels')}</label>
          <div class="kanban-modal-label-picker" id="kanban-label-picker" style="margin-top:6px">${labelsHtml}</div>
        </div>` : ''}
        <div>
          <label style="font-size:var(--font-xs);color:var(--text-secondary)">${t('kanban.worktree')}</label>
          <select id="kanban-worktree-select" class="kanban-add-card-input" style="margin-top:4px">
            <option value="">${t('kanban.worktreeNone')}</option>
            <option value="__loading__" disabled>${t('kanban.sessionsLoading')}</option>
          </select>
        </div>
        <div>
          <label style="font-size:var(--font-xs);color:var(--text-secondary)">${t('kanban.sessions')}</label>
          <div id="kanban-session-picker" class="kanban-session-picker" style="margin-top:6px">
            <div class="kanban-sessions-empty">${t('kanban.sessionsLoading')}</div>
          </div>
        </div>
      </div>
    `,
    buttons: [
      { label: t('kanban.cancel'), action: 'cancel', onClick: (m) => closeModal(m) },
      { label: t('kanban.save'), action: 'confirm', primary: true, onClick: (m) => {
        const title = m.querySelector('#kanban-edit-title')?.value.trim();
        if (!title) return;
        const description = m.querySelector('#kanban-edit-desc')?.value || '';
        updateTask(project.id, taskId, {
          title, description, labels: selectedLabels,
          worktreePath: selectedWorktreePath || null,
          sessionIds: selectedSessionIds,
        });
        closeModal(m);
        render(container, project, options);
      }},
    ],
  });

  // Label toggle
  modal.querySelector('#kanban-label-picker')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.kanban-modal-label-chip');
    if (!chip) return;
    const lid = chip.dataset.labelId;
    if (selectedLabels.includes(lid)) {
      selectedLabels = selectedLabels.filter(id => id !== lid);
      chip.classList.remove('selected');
    } else {
      selectedLabels.push(lid);
      chip.classList.add('selected');
    }
  });

  showModal(modal);

  // ── Async: load worktrees ──────────────────────────────────
  const worktreeSelect = modal.querySelector('#kanban-worktree-select');
  const sessionPicker = modal.querySelector('#kanban-session-picker');

  try {
    const result = await window.electron_api.git.worktreeList({ projectPath: project.path });
    const worktrees = result?.success ? (result.worktrees || []) : [];
    worktreeSelect.innerHTML = `<option value="">${t('kanban.worktreeNone')}</option>` +
      worktrees.map(wt => {
        const raw = (wt.branch || '').replace('refs/heads/', '') || getWorktreeBranchName(wt.path || '');
        const label = wt.isMain ? `${raw} (main)` : raw;
        return `<option value="${escapeHtml(wt.path)}" ${wt.path === selectedWorktreePath ? 'selected' : ''}>${escapeHtml(label)}</option>`;
      }).join('');
  } catch (_) {
    worktreeSelect.innerHTML = `<option value="">${t('kanban.worktreeNone')}</option>`;
  }

  // ── Session picker ─────────────────────────────────────────
  const loadSessions = async (worktreePath) => {
    sessionPicker.innerHTML = `<div class="kanban-sessions-empty">${t('kanban.sessionsLoading')}</div>`;
    try {
      const searchPath = worktreePath || project.path;
      const sessions = await window.electron_api.claude.sessions(searchPath) || [];
      if (sessions.length === 0) {
        sessionPicker.innerHTML = `<div class="kanban-sessions-empty">${t('kanban.sessionsEmpty')}</div>`;
        return;
      }
      sessionPicker.innerHTML = sessions.map(s => {
        const isSelected = selectedSessionIds.includes(s.sessionId);
        const summary = escapeHtml(s.summary || s.firstPrompt || s.sessionId);
        const date = s.modified ? escapeHtml(formatRelativeTime(new Date(s.modified))) : '';
        return `
          <div class="kanban-session-item${isSelected ? ' selected' : ''}" data-session-id="${escapeHtml(s.sessionId)}">
            <span class="kanban-session-check">${isSelected ? '✓' : ''}</span>
            <span class="kanban-session-summary" title="${summary}">${summary}</span>
            <span class="kanban-session-date">${date}</span>
          </div>
        `;
      }).join('');
    } catch (_) {
      sessionPicker.innerHTML = `<div class="kanban-sessions-empty">${t('kanban.sessionsEmpty')}</div>`;
    }
  };

  // Session toggle
  sessionPicker.addEventListener('click', (e) => {
    const item = e.target.closest('.kanban-session-item');
    if (!item) return;
    const sid = item.dataset.sessionId;
    if (selectedSessionIds.includes(sid)) {
      selectedSessionIds = selectedSessionIds.filter(id => id !== sid);
      item.classList.remove('selected');
      item.querySelector('.kanban-session-check').textContent = '';
    } else {
      selectedSessionIds.push(sid);
      item.classList.add('selected');
      item.querySelector('.kanban-session-check').textContent = '✓';
    }
  });

  // Worktree change → reload sessions + reset selection
  worktreeSelect.addEventListener('change', () => {
    selectedWorktreePath = worktreeSelect.value;
    selectedSessionIds = [];
    loadSessions(selectedWorktreePath);
  });

  // Initial session load
  loadSessions(selectedWorktreePath);
}

// ── Labels manager modal ──────────────────────────────────────

function showLabelsModal(container, project, options) {
  const renderList = (modal) => {
    const labels = getKanbanLabels(project.id);
    const listEl = modal.querySelector('#kanban-labels-list');
    if (!listEl) return;
    listEl.innerHTML = labels.map(lbl => `
      <div class="kanban-label-row" data-label-id="${escapeHtml(lbl.id)}">
        <input type="color" class="kanban-label-color-swatch" value="${escapeHtml(lbl.color)}"
               data-label-id="${escapeHtml(lbl.id)}">
        <input class="kanban-label-name-input" value="${escapeHtml(lbl.name)}" maxlength="30"
               data-label-id="${escapeHtml(lbl.id)}" placeholder="${t('kanban.labelNamePlaceholder')}">
        <button class="btn-kanban-delete-label" data-label-id="${escapeHtml(lbl.id)}" title="${t('kanban.deleteLabel')}">✕</button>
      </div>
    `).join('');
  };

  const modal = createModal({
    id: 'kanban-labels-modal',
    title: t('kanban.manageLabelsTitle'),
    size: 'medium',
    content: `
      <div>
        <div class="kanban-labels-list" id="kanban-labels-list"></div>
        <button class="btn-kanban-add-label" id="kanban-btn-add-label">${t('kanban.addLabel')}</button>
      </div>
    `,
    buttons: [
      { label: t('kanban.cancel'), action: 'cancel', onClick: (m) => closeModal(m) },
      { label: t('kanban.save'), action: 'confirm', primary: true, onClick: (m) => {
        m.querySelectorAll('.kanban-label-row').forEach(row => {
          const lid = row.dataset.labelId;
          const name = row.querySelector('.kanban-label-name-input')?.value.trim();
          const color = row.querySelector('.kanban-label-color-swatch')?.value;
          if (name) updateKanbanLabel(project.id, lid, { name, color });
        });
        closeModal(m);
        render(container, project, options);
      }},
    ],
  });

  renderList(modal);

  modal.querySelector('#kanban-btn-add-label')?.addEventListener('click', () => {
    const color = LABEL_COLORS[getKanbanLabels(project.id).length % LABEL_COLORS.length];
    addKanbanLabel(project.id, { name: 'label', color });
    renderList(modal);
  });

  modal.querySelector('#kanban-labels-list')?.addEventListener('click', (e) => {
    const delBtn = e.target.closest('.btn-kanban-delete-label');
    if (!delBtn) return;
    deleteKanbanLabel(project.id, delBtn.dataset.labelId);
    renderList(modal);
  });

  showModal(modal);
}

// ── Drag & Drop ───────────────────────────────────────────────

function initDragDrop(board, container, project, options) {
  let dragging = null;

  const onMouseDown = (e) => {
    const handle = e.target.closest('.kanban-card-drag-handle');
    if (!handle) return;
    e.preventDefault();

    const card = handle.closest('.kanban-card');
    if (!card) return;
    const taskId = card.dataset.taskId;
    const rect = card.getBoundingClientRect();

    const clone = document.createElement('div');
    clone.className = 'kanban-drag-clone';
    clone.innerHTML = card.querySelector('.kanban-card-title')?.outerHTML || '';
    clone.style.left = rect.left + 'px';
    clone.style.top = rect.top + 'px';
    document.body.appendChild(clone);

    const placeholder = document.createElement('div');
    placeholder.className = 'kanban-drag-placeholder';
    card.after(placeholder);
    card.classList.add('dragging');

    dragging = {
      taskId,
      cardEl: card,
      clone,
      placeholder,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };
  };

  const onMouseMove = (e) => {
    if (!dragging) return;
    const { clone, placeholder, offsetX, offsetY } = dragging;
    clone.style.left = (e.clientX - offsetX) + 'px';
    clone.style.top = (e.clientY - offsetY) + 'px';

    const targetCardsEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.kanban-cards');
    if (!targetCardsEl) return;

    const cards = [...targetCardsEl.querySelectorAll('.kanban-card:not(.dragging)')];
    let insertBefore = null;
    for (const c of cards) {
      const { top, height } = c.getBoundingClientRect();
      if (e.clientY < top + height / 2) { insertBefore = c; break; }
    }

    if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
    insertBefore ? targetCardsEl.insertBefore(placeholder, insertBefore) : targetCardsEl.appendChild(placeholder);
  };

  const onMouseUp = () => {
    if (!dragging) return;
    const { taskId, cardEl, clone, placeholder } = dragging;
    dragging = null;
    clone.remove();
    cardEl.classList.remove('dragging');

    const targetCardsEl = placeholder.parentNode;
    const targetColId = targetCardsEl?.dataset.colId;

    if (targetCardsEl && targetColId) {
      let order = 0;
      for (const child of targetCardsEl.children) {
        if (child === placeholder) break;
        if (child.classList.contains('kanban-card')) order++;
      }
      moveTask(project.id, taskId, targetColId, order);
    }

    placeholder.remove();
    render(container, project, options);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && dragging) {
      const { cardEl, clone, placeholder } = dragging;
      dragging = null;
      clone.remove();
      placeholder.remove();
      cardEl.classList.remove('dragging');
    }
  };

  board.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown);

  // Cleanup fn stored on board element for re-render cleanup
  board._kanbanCleanup = () => {
    board.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', onKeyDown);
  };
}

module.exports = { render };
