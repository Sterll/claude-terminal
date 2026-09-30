// CostPanel: the period chips have to mean what they say, in local time, and
// the panel has to render a report without throwing.

const CostPanel = require('../../src/renderer/ui/panels/CostPanel');

describe('CostPanel.periodRange', () => {
  // Wednesday 30 September 2026, 15:00 local.
  const now = new Date(2026, 8, 30, 15, 0, 0);

  test('this week starts on Monday at midnight', () => {
    const { from, to } = CostPanel.periodRange('thisWeek', now);
    expect(new Date(from)).toEqual(new Date(2026, 8, 28));
    expect(to).toBeNull();
  });

  test('last week is the full Monday to Sunday before it', () => {
    const { from, to } = CostPanel.periodRange('lastWeek', now);
    expect(new Date(from)).toEqual(new Date(2026, 8, 21));
    expect(new Date(to)).toEqual(new Date(2026, 8, 28));
  });

  test('a Sunday still belongs to the week that started six days earlier', () => {
    const sunday = new Date(2026, 9, 4, 22, 0, 0);
    expect(new Date(CostPanel.periodRange('thisWeek', sunday).from)).toEqual(new Date(2026, 8, 28));
  });

  test('this month and all time', () => {
    expect(new Date(CostPanel.periodRange('thisMonth', now).from)).toEqual(new Date(2026, 8, 1));
    expect(CostPanel.periodRange('all', now)).toEqual({ from: null, to: null });
  });
});

describe('CostPanel rendering', () => {
  const report = {
    generatedAt: Date.now(),
    firstSeen: Date.now() - 3600e3,
    lastSeen: Date.now(),
    totals: { cost: 75, tokens: 3e6, input: 0, output: 3e6, cacheWrite: 0, cacheRead: 0, messages: 3 },
    accounts: [{ id: 'a1', name: 'Personal' }, { id: 'a2', name: 'Work' }],
    byAccount: [{ id: 'a2', cost: 50 }, { id: 'a1', cost: 25 }],
    byProject: [
      { key: 'k1', name: 'Job <script>', cost: 50, tokens: 2e6, boundAccountId: 'a2', byAccount: { a2: 50 } },
      { key: 'k2', name: 'Side', cost: 25, tokens: 1e6, boundAccountId: null, byAccount: { a1: 25 } },
    ],
    byModel: [{ model: 'claude-opus-5', cost: 75, tokens: 3e6, estimatedPrice: false }],
    byDay: [{ date: '2026-09-30', cost: 75, byAccount: { a1: 25, a2: 50 } }],
    attribution: { trackedSince: Date.now(), estimatedCost: 0 },
    unpricedModels: [],
  };

  beforeEach(() => {
    window.electron_api.cost = { getReport: jest.fn().mockResolvedValue(report) };
    window.electron_api.accounts = { usage: jest.fn().mockResolvedValue({ success: true, data: {} }) };
  });

  afterEach(() => {
    CostPanel.cleanup();
  });

  test('renders accounts, projects and models, escaping names', async () => {
    const root = document.createElement('div');
    CostPanel.loadPanel(root);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(root.querySelector('.cost-panel')).not.toBeNull();
    expect(root.querySelectorAll('.cost-account-row')).toHaveLength(2);
    expect(root.querySelectorAll('.cost-table tbody tr')).toHaveLength(3);
    expect(root.innerHTML).not.toContain('<script>');
    expect(root.textContent).toContain('Job <script>');
  });

  test('splits the weekly percentage between this machine and everyone else', async () => {
    const resetsAt = new Date(Date.now() + 2 * 86400e3).toISOString();
    window.electron_api.accounts.usage.mockResolvedValue({
      success: true,
      data: { a2: { data: { buckets: [{ type: 'weekly', utilization: 20, resetsAt }] } } },
    });
    window.electron_api.cost.getQuota = jest.fn().mockResolvedValue({
      accountId: 'a2', utilization: 20, windowStart: Date.now() - 5 * 86400e3, spent: 110,
      samples: 12, calibrated: true, pricePerPercentFloor: 10, thisMachineMax: 11, othersMin: 9,
    });
    const root = document.createElement('div');
    CostPanel.loadPanel(root);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));

    // The current reading travels with the request, so main records it.
    expect(window.electron_api.cost.getQuota).toHaveBeenCalledWith({ accountId: 'a2', utilization: 20, resetsAt });
    const rows = [...root.querySelectorAll('.cost-quota-row')];
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('.cost-quota-bar .cost-bar-fill')).toHaveLength(2);
    expect(rows[0].querySelector('.cost-bar-others').style.width).toBe('9%');
    expect(rows[0].textContent).toMatch(/11/);
  });

  test('says so when it cannot separate the shares yet', async () => {
    window.electron_api.accounts.usage.mockResolvedValue({
      success: true,
      data: { a1: { data: { buckets: [{ type: 'weekly', utilization: 16, resetsAt: new Date(Date.now() + 86400e3).toISOString() }] } } },
    });
    window.electron_api.cost.getQuota = jest.fn().mockResolvedValue({
      accountId: 'a1', utilization: 16, windowStart: Date.now() - 6 * 86400e3, spent: 60,
      samples: 1, calibrated: false, pricePerPercentFloor: 3.5, thisMachineMax: 16, othersMin: 0,
    });
    const root = document.createElement('div');
    CostPanel.loadPanel(root);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));

    const row = root.querySelector('.cost-quota-row');
    expect(row.querySelector('.cost-bar-others')).toBeNull();
    expect(row.textContent).toContain(require('../../src/renderer/i18n').t('cost.quota.calibrating'));
  });

  test('asks the service again for the chosen account', async () => {
    const root = document.createElement('div');
    CostPanel.loadPanel(root);
    await new Promise(resolve => setTimeout(resolve, 0));

    root.querySelector('[data-account="a2"]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const lastCall = window.electron_api.cost.getReport.mock.calls.at(-1)[0];
    expect(lastCall.accountId).toBe('a2');
  });
});
