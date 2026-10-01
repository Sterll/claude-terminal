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
