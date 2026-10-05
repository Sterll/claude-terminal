/**
 * Cost IPC Handlers
 * API-equivalent cost of local Claude Code usage, per account / project / model / day.
 */

const { ipcMain } = require('electron');
const CostService = require('../services/CostService');
const AccountManager = require('../services/AccountManager');
const UsageService = require('../services/UsageService');

function registerCostHandlers() {
  // Record every change of the account holding the machine-wide login, so
  // unbound work can be attributed to the account that was live at the time.
  AccountManager.onLiveChange(CostService.noteLiveAccount);
  // Every weekly reading is kept: pairs of them are what separate this
  // machine's share of a shared account from everyone else's.
  UsageService.onSample((data, accountId) => CostService.noteUsageSample(accountId, data));

  ipcMain.handle('cost-get-report', (_event, range = {}) => {
    const from = Number.isFinite(range?.from) ? range.from : 0;
    const to = Number.isFinite(range?.to) ? range.to : Infinity;
    const accountId = typeof range?.accountId === 'string' ? range.accountId : null;
    const projectId = typeof range?.projectId === 'string' ? range.projectId : null;
    return CostService.getReport({ from, to, accountId, projectId });
  });

  // Per automation. Names are taken from the current definitions where the
  // automation still exists, so a rename shows up; a deleted one keeps the
  // name it ran under and is flagged.
  ipcMain.handle('cost-get-automations', async (_event, range = {}) => {
    const from = Number.isFinite(range?.from) ? range.from : 0;
    const to = Number.isFinite(range?.to) ? range.to : Infinity;
    const accountId = typeof range?.accountId === 'string' ? range.accountId : null;
    const report = CostService.getAutomationReport({ from, to, accountId });
    let workflows = [];
    try {
      workflows = await require('../services/WorkflowStorage').loadWorkflows();
    } catch { /* names stay as recorded */ }
    const byId = new Map((Array.isArray(workflows) ? workflows : []).map(wf => [wf.id, wf]));
    for (const a of report.automations) {
      const wf = byId.get(a.workflowId);
      a.deleted = !wf;
      if (wf?.name) a.name = wf.name;
      a.simple = wf?.mode === 'simple';
    }
    return report;
  });

  ipcMain.handle('cost-get-quota', (_event, args = {}) => {
    if (typeof args?.accountId !== 'string') return null;
    return CostService.getQuotaEstimate({
      accountId: args.accountId,
      utilization: typeof args.utilization === 'number' ? args.utilization : undefined,
      resetsAt: typeof args.resetsAt === 'string' ? args.resetsAt : undefined,
    });
  });
}

module.exports = { registerCostHandlers };
