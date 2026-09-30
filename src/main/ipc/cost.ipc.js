/**
 * Cost IPC Handlers
 * API-equivalent cost of local Claude Code usage, per account / project / model / day.
 */

const { ipcMain } = require('electron');
const CostService = require('../services/CostService');
const AccountManager = require('../services/AccountManager');

function registerCostHandlers() {
  // Record every change of the account holding the machine-wide login, so
  // unbound work can be attributed to the account that was live at the time.
  AccountManager.onLiveChange(CostService.noteLiveAccount);

  ipcMain.handle('cost-get-report', (_event, range = {}) => {
    const from = Number.isFinite(range?.from) ? range.from : 0;
    const to = Number.isFinite(range?.to) ? range.to : Infinity;
    const accountId = typeof range?.accountId === 'string' ? range.accountId : null;
    return CostService.getReport({ from, to, accountId });
  });
}

module.exports = { registerCostHandlers };
