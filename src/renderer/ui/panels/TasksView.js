/**
 * TasksView
 * The "simple mode" tab of the workflow panel.
 *
 * A task is a workflow with `mode: 'simple'`. The user edits three things —
 * what / when / where — and everything else (cron expression, LiteGraph graph,
 * steps) is compiled by src/shared/simple-task.js. Nothing here talks to the
 * scheduler or the runner: it writes the same workflow object the advanced
 * editor writes, through the same `workflow.save` IPC.
 *
 * Dependencies are injected by WorkflowPanel (see `deps`) so this module never
 * imports the panel back.
 */

const { escapeHtml } = require('../../utils');
const { t, getCurrentLanguage } = require('../../i18n');
const { projectsState } = require('../../state/projects.state');
const { showContextMenu } = require('../components/ContextMenu');
const { upgradeSelectsToDropdowns } = require('./WorkflowHelpers');
const { MODEL_OPTIONS, EFFORT_OPTIONS } = require('../../../shared/model-options');
const {
  TASK_PRESETS, MAX_MONTH_DAY, DEFAULT_SIMPLE,
  normalizeSimple, compileTask, describeSchedule, nextRunForTask,
  isSimpleTask, validateTask, scheduleToCron, splitTime,
} = require('../../../shared/simple-task');

const { nextRunAt } = require('../../../shared/cron');

/* ─── Formatting helpers ───────────────────────────────────────────────────── */

/** Localized weekday names, Sunday-first (index 0 = Sunday, matching cron). */
function weekdayNames() {
  const fmt = new Intl.DateTimeFormat(getCurrentLanguage(), { weekday: 'long' });
  // 2024-01-07 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => {
    const label = fmt.format(new Date(2024, 0, 7 + i));
    return label.charAt(0).toUpperCase() + label.slice(1);
  });
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/** "Today 09:00" / "Tomorrow 09:00" / "Mon 12 Aug 09:00" */
function formatNextRun(date) {
  if (!date) return null;
  const lang = getCurrentLanguage();
  const now  = new Date();
  const time = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(date);

  if (sameDay(date, now)) return t('automation.nextRun.today', { time });

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(date, tomorrow)) return t('automation.nextRun.tomorrow', { time });

  const day = new Intl.DateTimeFormat(lang, { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
  return t('automation.nextRun.on', { day, time });
}

/** Human-readable schedule label, e.g. "Every day at 09:00". */
function scheduleLabel(simple) {
  const { key, params } = describeSchedule(simple?.schedule);
  if (key === 'automation.schedule.desc.weekly') {
    return t(key, { ...params, weekday: weekdayNames()[params.weekday] || '' });
  }
  return t(key, params);
}

function projectName(projectId) {
  if (!projectId) return null;
  const list = projectsState.get().projects || [];
  return list.find(p => p.id === projectId)?.name || null;
}

/* ─── Icons ────────────────────────────────────────────────────────────────── */

const ICONS = {
  git:     '<path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/>',
  pr:      '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12"/>',
  check:   '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  clock:   '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  package: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>',
  beaker:  '<path d="M9 3h6M10 3v6L4.5 18A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-3L14 9V3"/>',
  task:    '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
};

/** Tick drawn inside the custom checkbox — the native control cannot be themed. */
const CHECK_MARK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

function icon(name, size = 14) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.task}</svg>`;
}

/* ─── List ─────────────────────────────────────────────────────────────────── */

/** Extract the tasks out of the panel's workflow list. */
function getTasks(workflows) {
  return (workflows || []).filter(isSimpleTask);
}

function taskCardHtml(wf, runs) {
  const simple   = normalizeSimple(wf.simple);
  const lastRun  = runs.find(r => r.workflowId === wf.id);
  const next     = formatNextRun(nextRunForTask(wf));
  const proj     = projectName(simple.projectId);
  const isRunning = lastRun?.status === 'running';

  const statusClass = lastRun ? `auto-card-status--${escapeHtml(lastRun.status)}` : '';

  return `
    <div class="auto-card ${wf.enabled ? '' : 'auto-card--off'}" data-id="${escapeHtml(wf.id)}">
      <div class="auto-card-main">
        <div class="auto-card-head">
          <span class="auto-card-name">${escapeHtml(wf.name)}</span>
          ${lastRun ? `<span class="auto-card-status ${statusClass}"></span>` : ''}
        </div>
        <p class="auto-card-prompt">${escapeHtml(simple.prompt)}</p>
        <div class="auto-card-meta">
          <span class="auto-chip auto-chip--schedule">${icon('clock', 11)} ${escapeHtml(scheduleLabel(simple))}</span>
          ${proj ? `<span class="auto-chip">${escapeHtml(proj)}</span>` : ''}
          ${wf.enabled && next
            ? `<span class="auto-chip auto-chip--next">${escapeHtml(next)}</span>`
            : `<span class="auto-chip auto-chip--muted">${escapeHtml(t('automation.card.paused'))}</span>`}
        </div>
      </div>
      <div class="auto-card-actions">
        <label class="wf-switch auto-card-switch">
          <input type="checkbox" class="auto-toggle" ${wf.enabled ? 'checked' : ''}
            aria-label="${escapeHtml(t('automation.card.toggleAria', { name: wf.name }))}">
          <span class="wf-switch-track"></span>
        </label>
        ${isRunning
          ? `<button class="auto-btn auto-btn--stop" data-run-id="${escapeHtml(lastRun.id)}" title="${escapeHtml(t('workflow.stopTitle'))}">
               <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
             </button>`
          : `<button class="auto-btn auto-btn--run" title="${escapeHtml(t('automation.card.runNow'))}">
               <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
             </button>`}
        <button class="auto-btn auto-btn--more" title="${escapeHtml(t('automation.card.more'))}" aria-haspopup="menu">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
      </div>
    </div>
  `;
}

function emptyStateHtml() {
  const cards = TASK_PRESETS.map(p => `
    <button class="auto-preset" data-preset="${escapeHtml(p.id)}">
      <span class="auto-preset-icon">${icon(p.icon, 15)}</span>
      <span class="auto-preset-text">
        <span class="auto-preset-title">${escapeHtml(t(p.titleKey))}</span>
        <span class="auto-preset-desc">${escapeHtml(t(p.descKey))}</span>
      </span>
    </button>
  `).join('');

  return `
    <div class="auto-empty">
      <div class="auto-empty-head">
        <p class="auto-empty-title">${escapeHtml(t('automation.empty.title'))}</p>
        <p class="auto-empty-sub">${escapeHtml(t('automation.empty.sub'))}</p>
      </div>
      <div class="auto-preset-grid">${cards}</div>
      <button class="wf-create-btn auto-empty-blank" id="auto-empty-blank">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        ${escapeHtml(t('automation.empty.blank'))}
      </button>
    </div>
  `;
}

/**
 * Render the Tasks tab.
 * @param {HTMLElement} el
 * @param {Object} deps  { state, api, refresh, openEditor, trigger, toggle, confirmDelete, toast }
 */
function render(el, deps) {
  const tasks = getTasks(deps.state.workflows);

  if (!tasks.length) {
    el.innerHTML = emptyStateHtml();
    el.querySelector('#auto-empty-blank')?.addEventListener('click', () => openTaskModal(deps, null));
    el.querySelectorAll('.auto-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = TASK_PRESETS.find(p => p.id === btn.dataset.preset);
        if (preset) openTaskModal(deps, null, preset);
      });
    });
    return;
  }

  const list = document.createElement('div');
  list.className = 'auto-list';
  list.innerHTML = tasks.map(wf => taskCardHtml(wf, deps.state.runs)).join('');
  el.replaceChildren(list);

  const taskById = (id) => deps.state.workflows.find(w => w.id === id);

  list.addEventListener('click', (e) => {
    const card = e.target.closest('.auto-card[data-id]');
    if (!card) return;
    const id = card.dataset.id;

    if (e.target.closest('.wf-switch')) return;           // handled by 'change'
    if (e.target.closest('.auto-btn--run'))  { e.stopPropagation(); deps.trigger(id); return; }
    if (e.target.closest('.auto-btn--stop')) {
      e.stopPropagation();
      const runId = e.target.closest('.auto-btn--stop').dataset.runId;
      if (runId) deps.api?.cancel(runId);
      return;
    }
    const more = e.target.closest('.auto-btn--more');
    if (more) {
      e.stopPropagation();
      const rect = more.getBoundingClientRect();
      openCardMenu(rect.left, rect.bottom + 4, id, deps);
      return;
    }
    const wf = taskById(id);
    if (wf) openTaskModal(deps, wf);
  });

  list.addEventListener('change', (e) => {
    const toggle = e.target.closest('.auto-toggle');
    if (!toggle) return;
    const id = toggle.closest('.auto-card[data-id]')?.dataset.id;
    if (id) deps.toggle(id, toggle.checked);
  });

  list.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.auto-card[data-id]');
    if (!card) return;
    e.preventDefault();
    openCardMenu(e.clientX, e.clientY, card.dataset.id, deps);
  });
}

function openCardMenu(x, y, id, deps) {
  const wf = deps.state.workflows.find(w => w.id === id);
  if (!wf) return;

  showContextMenu({
    x, y,
    items: [
      { label: t('automation.menu.edit'),    onClick: () => openTaskModal(deps, wf) },
      { label: t('automation.menu.runNow'),  onClick: () => deps.trigger(id) },
      { label: t('automation.menu.history'), onClick: () => deps.openHistory(id) },
      { separator: true },
      { label: t('automation.menu.convert'), onClick: () => confirmConvert(wf, deps) },
      { separator: true },
      { label: t('automation.menu.delete'), danger: true, onClick: () => deps.confirmDelete(id, wf.name) },
    ],
  });
}

/**
 * Promote a task to a full workflow. One-way on purpose: once the graph is
 * hand-edited it can no longer be re-derived from the `simple` payload, so
 * keeping a "back to simple" path would silently discard the user's edits.
 */
async function confirmConvert(wf, deps) {
  const ok = await deps.confirm({
    title:   t('automation.convert.title'),
    message: t('automation.convert.message', { name: wf.name }),
    confirmLabel: t('automation.convert.confirm'),
  });
  if (!ok) return;

  const promoted = { ...wf };
  delete promoted.mode;
  delete promoted.simple;

  const res = await deps.api.save(promoted);
  if (!res?.success) {
    deps.toast(res?.error || t('workflow.toast.saveFailed'), 'error');
    return;
  }
  await deps.refresh();
  deps.openEditor(wf.id);
}

/* ─── Create / edit modal ──────────────────────────────────────────────────── */

// Written out rather than built as `'automation.schedule.kind.' + kind` so the
// i18n usage scanner (tests/i18n/i18n-usage.test.js) can see every key.
const SCHEDULE_TABS = [
  { kind: 'once',    label: () => t('automation.schedule.kind.once') },
  { kind: 'hourly',  label: () => t('automation.schedule.kind.hourly') },
  { kind: 'daily',   label: () => t('automation.schedule.kind.daily') },
  { kind: 'weekly',  label: () => t('automation.schedule.kind.weekly') },
  { kind: 'monthly', label: () => t('automation.schedule.kind.monthly') },
  { kind: 'custom',  label: () => t('automation.schedule.kind.custom') },
];

/** Local "YYYY-MM-DDTHH:MM" one hour from now, for the <input type="datetime-local"> default. */
function defaultOnceValue() {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Hour + minute as two themed dropdowns.
 *
 * `<input type="time">` opens an OS-drawn spinner that no CSS can reach — white
 * panel, system-blue selection — which looked nothing like the rest of the
 * sheet. Two selects reuse the dropdown widget the editor already ships, so the
 * picker is themed, keyboard-navigable, and still allows any minute rather than
 * snapping to a coarse step.
 *
 * @param {string} time "HH:MM"
 * @param {{ hourOnly?: boolean, minuteOnly?: boolean }} [opts]
 */
function timePartsHtml(time, opts = {}) {
  const [h, m] = splitTime(time);
  const pad = (n) => String(n).padStart(2, '0');
  const options = (count, selected) => Array.from({ length: count }, (_, i) =>
    `<option value="${i}"${i === selected ? ' selected' : ''}>${pad(i)}</option>`).join('');

  const hour = `<select class="auto-input auto-time-part" data-dropdown data-sched-h>${options(24, h)}</select>`;
  const min  = `<select class="auto-input auto-time-part" data-dropdown data-sched-m>${options(60, m)}</select>`;

  if (opts.hourOnly)   return `<span class="auto-time">${hour}</span>`;
  if (opts.minuteOnly) return `<span class="auto-time">${min}</span>`;
  return `<span class="auto-time">${hour}<span class="auto-time-sep">:</span>${min}</span>`;
}

function scheduleFieldsHtml(schedule) {
  const days = weekdayNames();
  const timeInput = (label) => `
    <div class="auto-field auto-field--inline">
      <span class="auto-field-label">${escapeHtml(label)}</span>
      ${timePartsHtml(schedule.time)}
    </div>`;

  switch (schedule.kind) {
    case 'once': {
      const at = schedule.at || defaultOnceValue();
      const [datePart, timePart] = at.split('T');
      return `
        <div class="auto-field auto-field--inline">
          <span class="auto-field-label">${escapeHtml(t('automation.form.onceAt'))}</span>
          <input type="date" class="auto-input auto-input--date" data-sched-date value="${escapeHtml(datePart || '')}">
          ${timePartsHtml(timePart || '09:00')}
        </div>`;
    }

    case 'hourly':
      return `
        <div class="auto-field auto-field--inline">
          <span class="auto-field-label">${escapeHtml(t('automation.form.hourlyMinute'))}</span>
          ${timePartsHtml(schedule.time, { minuteOnly: true })}
        </div>
        <p class="auto-field-hint">${escapeHtml(t('automation.form.hourlyHint'))}</p>`;

    case 'daily':
      return timeInput(t('automation.form.at'));

    case 'weekly':
      return `
        <div class="auto-field auto-field--inline">
          <span class="auto-field-label">${escapeHtml(t('automation.form.onDay'))}</span>
          <select class="auto-input" data-dropdown data-sched="weekday">
            ${days.map((d, i) => `<option value="${i}"${Number(schedule.weekday) === i ? ' selected' : ''}>${escapeHtml(d)}</option>`).join('')}
          </select>
        </div>
        ${timeInput(t('automation.form.at'))}`;

    case 'monthly':
      return `
        <div class="auto-field auto-field--inline">
          <span class="auto-field-label">${escapeHtml(t('automation.form.onDayOfMonth'))}</span>
          <select class="auto-input" data-dropdown data-sched="day">
            ${Array.from({ length: MAX_MONTH_DAY }, (_, i) => i + 1)
              .map(d => `<option value="${d}"${Number(schedule.day) === d ? ' selected' : ''}>${d}</option>`).join('')}
          </select>
        </div>
        ${timeInput(t('automation.form.at'))}
        <p class="auto-field-hint">${escapeHtml(t('automation.form.monthlyHint', { max: MAX_MONTH_DAY }))}</p>`;

    case 'custom':
      return `
        <label class="auto-field auto-field--inline">
          <span class="auto-field-label">${escapeHtml(t('automation.form.cronExpr'))}</span>
          <input type="text" class="auto-input auto-input--mono" data-sched="cron"
            placeholder="*/15 * * * *" value="${escapeHtml(schedule.cron)}">
        </label>
        <p class="auto-field-hint">${escapeHtml(t('automation.form.cronHint'))}</p>`;

    default:
      return '';
  }
}

function projectOptionsHtml(selectedId) {
  const list = projectsState.get().projects || [];
  return [
    `<option value=""${!selectedId ? ' selected' : ''}>${escapeHtml(t('automation.form.noProject'))}</option>`,
    ...list.map(p => `<option value="${escapeHtml(p.id)}"${selectedId === p.id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`),
  ].join('');
}

/**
 * Open the create/edit sheet.
 * @param {Object} deps
 * @param {Object|null} existing  workflow being edited, or null to create
 * @param {Object|null} preset    optional TASK_PRESETS entry to pre-fill from
 */
function openTaskModal(deps, existing, preset = null) {
  const editing = !!existing;

  let name   = editing ? existing.name : (preset ? t(preset.titleKey) : '');
  const base = editing ? existing.simple : { ...DEFAULT_SIMPLE };
  const simple = normalizeSimple({
    ...base,
    ...(preset ? { prompt: t(preset.promptKey), schedule: { ...DEFAULT_SIMPLE.schedule, ...preset.schedule } } : {}),
  });
  if (simple.schedule.kind === 'once' && !simple.schedule.at) {
    simple.schedule.at = defaultOnceValue();
  }

  const overlay = document.createElement('div');
  overlay.className = 'wf-overlay auto-overlay';
  overlay.innerHTML = `
    <div class="auto-modal" role="dialog" aria-modal="true" aria-labelledby="auto-modal-title">
      <header class="auto-modal-hd">
        <h2 class="auto-modal-title" id="auto-modal-title">
          ${escapeHtml(editing ? t('automation.form.editTitle') : t('automation.form.createTitle'))}
        </h2>
        <button class="auto-modal-close" aria-label="${escapeHtml(t('common.close'))}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </header>

      <div class="auto-modal-body">
        <label class="auto-field">
          <span class="auto-field-label">${escapeHtml(t('automation.form.nameLabel'))}</span>
          <input type="text" class="auto-input" id="auto-name" maxlength="80"
            placeholder="${escapeHtml(t('automation.form.namePlaceholder'))}" value="${escapeHtml(name)}">
        </label>

        <label class="auto-field">
          <span class="auto-field-label">${escapeHtml(t('automation.form.promptLabel'))}</span>
          <span class="auto-field-hint">${escapeHtml(t('automation.form.promptHint'))}</span>
          <textarea class="auto-input auto-textarea" id="auto-prompt" rows="4"
            placeholder="${escapeHtml(t('automation.form.promptPlaceholder'))}">${escapeHtml(simple.prompt)}</textarea>
        </label>

        <div class="auto-field">
          <span class="auto-field-label">${escapeHtml(t('automation.form.whenLabel'))}</span>
          <div class="auto-tabs" role="tablist">
            ${SCHEDULE_TABS.map(({ kind, label }) => `
              <button class="auto-tab${simple.schedule.kind === kind ? ' active' : ''}" data-kind="${kind}" role="tab"
                aria-selected="${simple.schedule.kind === kind}">${escapeHtml(label())}</button>
            `).join('')}
          </div>
          <div class="auto-sched-fields" id="auto-sched-fields">${scheduleFieldsHtml(simple.schedule)}</div>
          <p class="auto-next-preview" id="auto-next-preview"></p>
        </div>

        <div class="auto-field">
          <span class="auto-field-label">${escapeHtml(t('automation.form.projectLabel'))}</span>
          <span class="auto-field-hint">${escapeHtml(t('automation.form.projectHint'))}</span>
          <select class="auto-input" data-dropdown id="auto-project">${projectOptionsHtml(simple.projectId)}</select>
        </div>

        <div class="auto-field">
          <span class="auto-field-label">${escapeHtml(t('automation.form.notifyLabel'))}</span>
          <label class="auto-check">
            <input type="checkbox" id="auto-notify-desktop" ${simple.notify.desktop ? 'checked' : ''}>
            <span class="auto-check-box">${CHECK_MARK}</span>
            <span class="auto-check-text">${escapeHtml(t('automation.form.notifyDesktop'))}</span>
          </label>
          <label class="auto-check">
            <input type="checkbox" id="auto-notify-result" ${simple.notify.includeResult ? 'checked' : ''}>
            <span class="auto-check-box">${CHECK_MARK}</span>
            <span class="auto-check-text">${escapeHtml(t('automation.form.notifyResult'))}</span>
          </label>
        </div>

        <details class="auto-advanced"${simple.model !== DEFAULT_SIMPLE.model || simple.effort !== DEFAULT_SIMPLE.effort ? ' open' : ''}>
          <summary class="auto-advanced-summary">${escapeHtml(t('automation.form.advanced'))}</summary>
          <div class="auto-advanced-body">
            <div class="auto-field auto-field--inline">
              <span class="auto-field-label">${escapeHtml(t('automation.form.model'))}</span>
              <select class="auto-input" data-dropdown id="auto-model">
                ${MODEL_OPTIONS.map(o =>
                  `<option value="${escapeHtml(o.value)}"${simple.model === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
              </select>
            </div>
            <div class="auto-field auto-field--inline">
              <span class="auto-field-label">${escapeHtml(t('automation.form.effort'))}</span>
              <select class="auto-input" data-dropdown id="auto-effort">
                ${EFFORT_OPTIONS.map(o =>
                  `<option value="${escapeHtml(o.value)}"${simple.effort === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
              </select>
            </div>
            <label class="auto-field auto-field--inline">
              <span class="auto-field-label">${escapeHtml(t('automation.form.discord'))}</span>
              <input type="text" class="auto-input auto-input--mono" id="auto-discord"
                placeholder="https://discord.com/api/webhooks/..." value="${escapeHtml(simple.notify.discord)}">
            </label>
          </div>
        </details>

        <p class="auto-error" id="auto-error" role="alert" hidden></p>
      </div>

      <footer class="auto-modal-ft">
        <button class="auto-btn-secondary" id="auto-cancel">${escapeHtml(t('common.cancel'))}</button>
        <button class="auto-btn-primary" id="auto-save">${escapeHtml(editing ? t('common.save') : t('automation.form.create'))}</button>
      </footer>
    </div>
  `;
  document.body.appendChild(overlay);

  // Swap every native <select> for the shared dropdown widget: the OS listbox
  // ignores the app theme entirely (system blue highlight, system font), which
  // is glaring on a project list of twenty entries.
  upgradeSelectsToDropdowns(overlay);

  const $ = (sel) => overlay.querySelector(sel);
  const errorEl   = $('#auto-error');
  const previewEl = $('#auto-next-preview');
  const fieldsEl  = $('#auto-sched-fields');

  /* — schedule editing — */

  function readScheduleFields() {
    fieldsEl.querySelectorAll('[data-sched]').forEach(input => {
      const key = input.dataset.sched;
      simple.schedule[key] = (key === 'weekday' || key === 'day')
        ? parseInt(input.value, 10)
        : input.value;
    });

    // Hour and minute are two dropdowns; recompose them into "HH:MM". The
    // hourly kind only renders a minute picker, so the hour falls back to the
    // current value (scheduleToCron ignores it for that kind anyway).
    const pad = (n) => String(n).padStart(2, '0');
    const hEl = fieldsEl.querySelector('[data-sched-h]');
    const mEl = fieldsEl.querySelector('[data-sched-m]');
    if (hEl || mEl) {
      const [curH, curM] = splitTime(simple.schedule.time);
      const h = hEl ? parseInt(hEl.value, 10) : curH;
      const m = mEl ? parseInt(mEl.value, 10) : curM;
      simple.schedule.time = `${pad(h)}:${pad(m)}`;
    }

    // The one-shot kind is a date input plus those same pickers.
    const dEl = fieldsEl.querySelector('[data-sched-date]');
    if (dEl) {
      simple.schedule.at = dEl.value ? `${dEl.value}T${simple.schedule.time}` : '';
    }
  }

  function updatePreview() {
    const expr = scheduleToCron(simple.schedule);
    if (!expr) {
      previewEl.textContent = t('automation.form.previewInvalid');
      previewEl.classList.add('auto-next-preview--invalid');
      return;
    }
    previewEl.classList.remove('auto-next-preview--invalid');
    const next = nextRunAt(expr);
    previewEl.textContent = next
      ? t('automation.form.previewNext', { when: formatNextRun(next) })
      : t('automation.form.previewNever');
  }

  function rerenderSchedule() {
    fieldsEl.innerHTML = scheduleFieldsHtml(simple.schedule);
    // The weekly/monthly pickers are rebuilt here, so they need upgrading again.
    upgradeSelectsToDropdowns(fieldsEl);
    updatePreview();
  }

  fieldsEl.addEventListener('input', () => { readScheduleFields(); updatePreview(); });
  fieldsEl.addEventListener('change', () => { readScheduleFields(); updatePreview(); });

  overlay.querySelectorAll('.auto-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      overlay.querySelectorAll('.auto-tab').forEach(x => {
        x.classList.remove('active');
        x.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      simple.schedule.kind = tab.dataset.kind;
      if (simple.schedule.kind === 'once' && !simple.schedule.at) {
        simple.schedule.at = defaultOnceValue();
      }
      rerenderSchedule();
    });
  });

  updatePreview();

  /* — close / focus trap — */

  const previouslyFocused = document.activeElement;

  function close() {
    document.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
  }

  function onKeydown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
    )].filter(el => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  document.addEventListener('keydown', onKeydown, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  $('.auto-modal-close').addEventListener('click', close);
  $('#auto-cancel').addEventListener('click', close);

  /* — save — */

  async function save() {
    readScheduleFields();

    const projectId = $('#auto-project').value;
    const project   = (projectsState.get().projects || []).find(p => p.id === projectId);

    const draft = {
      ...(editing ? { id: existing.id } : {}),
      name: $('#auto-name').value.trim(),
      enabled: editing ? existing.enabled : true,
      favorite: editing ? existing.favorite : false,
      simple: {
        ...simple,
        prompt: $('#auto-prompt').value,
        projectId,
        // Store the resolved path too: claude.node.js executes in `cwd`, and a
        // cron run has no "current project" to fall back on.
        cwd: project?.path || '',
        model:  $('#auto-model').value,
        effort: $('#auto-effort').value,
        notify: {
          desktop:       $('#auto-notify-desktop').checked,
          includeResult: $('#auto-notify-result').checked,
          discord:       $('#auto-discord').value.trim(),
        },
      },
    };

    const check = validateTask(draft);
    if (!check.valid) {
      errorEl.textContent = t(check.errorKey);
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    const saveBtn = $('#auto-save');
    saveBtn.disabled = true;

    const res = await deps.api.save(compileTask(draft));
    if (!res?.success) {
      saveBtn.disabled = false;
      errorEl.textContent = res?.error || t('workflow.toast.saveFailed');
      errorEl.hidden = false;
      return;
    }

    close();
    await deps.refresh();
    deps.toast(editing ? t('automation.toast.updated') : t('automation.toast.created'), 'success');
  }

  $('#auto-save').addEventListener('click', save);

  overlay.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
  });

  $('#auto-name').focus();
}

module.exports = { render, openTaskModal, getTasks };
