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

  test('turns the weekly percentage into dollars per percent', async () => {
    window.electron_api.accounts.usage.mockResolvedValue({
      success: true,
      data: {
        a2: { data: { buckets: [{ type: 'weekly', utilization: 20, resetsAt: new Date(Date.now() + 2 * 86400e3).toISOString() }] } },
      },
    });
    const root = document.createElement('div');
    CostPanel.loadPanel(root);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));

    // The mocked report says 75 dollars since the reset, against 20%.
    const card = [...root.querySelectorAll('.cost-quota-row')];
    expect(card).toHaveLength(1);
    // Decimal separator follows the UI language.
    expect(card[0].textContent).toMatch(/3[.,]75/);
    const since = window.electron_api.cost.getReport.mock.calls.find(([arg]) => arg.accountId === 'a2')[0];
    expect(since.from).toBeCloseTo(Date.now() - 5 * 86400e3, -5);
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
