'use strict';
const { t } = require('../../i18n');
const { escapeHtml } = require('../../utils');

function collectIncidents(workflows, runs, triggers, conflicts) {
  const definitions = new Map(workflows.map(wf => [wf.id, wf]));
  const incidents = triggers.filter(item => item.status === 'error').map(item => ({ ...item, kind: 'trigger' }));
  const seen = new Set();
  // Storage returns newest first. A successful subsequent run clears the alert.
  for (const run of runs) {
    if (seen.has(run.workflowId)) continue;
    seen.add(run.workflowId);
    if (definitions.has(run.workflowId) && ['failed', 'error'].includes(run.status)) {
      incidents.push({ kind: 'run', workflowId: run.workflowId, runId: run.id, name: definitions.get(run.workflowId).name, error: run.error });
    }
  }
  for (const conflict of conflicts) incidents.push({ kind: 'sync', name: conflict.entityType });
  return incidents;
}
function mount(host) {
  const api = window.electron_api;
  let disposed = false, busy = false, again = false;
  const unsubs = [];
  async function refresh() {
    if (disposed) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const [definitions, history, triggers, conflicts] = await Promise.all([
        api.workflow.list(), api.workflow.getRecentRuns(200), api.workflow.getTriggerStatuses(), api.cloud?.getConflicts?.() || [],
      ]);
      if (disposed) return;
      if (!definitions.success || !history.success) throw new Error(definitions.error || history.error);
      const items = collectIncidents(definitions.workflows, history.runs, triggers, conflicts || []);
      host.hidden = items.length === 0;
      host.innerHTML = `<h3>${escapeHtml(t('controlTower.incidentsTitle', { count: items.length }))}</h3>` + items.map((item, index) => `
        <div class="ct-incident">
          <div><strong>${escapeHtml(item.name || item.workflowId)}</strong><span>${escapeHtml(t({ trigger: 'controlTower.incident_trigger', run: 'controlTower.incident_run', sync: 'controlTower.incident_sync' }[item.kind]))}${item.projectId ? ' · ' + escapeHtml(item.projectId) : ''}</span>
          ${item.error ? `<p>${escapeHtml(item.error)}</p>` : ''}</div>
          <div class="ct-incident-actions"><button data-open="${index}" class="ct-spawn-btn">${escapeHtml(t('controlTower.incidentOpen'))}</button>
          ${item.kind === 'trigger' ? `<button data-retry="${index}" class="ct-spawn-btn">${escapeHtml(t('controlTower.incidentRetry'))}</button>` : ''}</div>
        </div>`).join('');
      host.querySelectorAll('[data-open]').forEach(button => button.onclick = () => {
        const item = items[Number(button.dataset.open)];
        if (item.kind === 'sync') {
          require('../panels/ConnectivityPanel').openCloudConflicts();
        } else require('../panels/WorkflowPanel').openIncident(item.workflowId, item.runId);
      });
      host.querySelectorAll('[data-retry]').forEach(button => button.onclick = async () => {
        button.disabled = true;
        try {
          const result = await api.workflow.retryTrigger(items[Number(button.dataset.retry)].workflowId);
          if (!result.success) throw new Error(result.error);
          await refresh();
        } catch (error) {
          require('./Toast').showToast({ type: 'error', message: error.message });
        } finally { button.disabled = false; }
      });
    } catch (error) {
      if (disposed) return;
      host.hidden = false;
      host.innerHTML = `<p>${escapeHtml(t('controlTower.incidentsUnavailable'))}: ${escapeHtml(error.message)}</p><button class="ct-spawn-btn">${escapeHtml(t('controlTower.incidentRetry'))}</button>`;
      host.querySelector('button').onclick = refresh;
    } finally { busy = false; if (again) { again = false; refresh(); } }
  }
  for (const subscribe of [api.workflow?.onTriggerStatus, api.workflow?.onRunEnd, api.workflow?.onRunStart, api.workflow?.onListUpdated, api.cloud?.onSyncConflict, api.cloud?.onSyncStatus]) {
    if (subscribe) unsubs.push(subscribe(refresh));
  }
  refresh();
  return () => { disposed = true; unsubs.forEach(unsubscribe => unsubscribe?.()); };
}
module.exports = { mount, collectIncidents };
