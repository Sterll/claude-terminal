/** @jest-environment node */
/**
 * What an automation step spent, and the gate that keeps one from running.
 *
 * An automation step runs in a throwaway Claude session whose transcript is
 * deleted as soon as it ends, so CostService prices it from that transcript
 * just before the deletion and keeps the figure per automation. These tests
 * drive that with real files in a temp home, including the two cases that
 * would quietly inflate the figure: a resumed conversation's copied history,
 * and Claude Code's repeated streaming lines.
 *
 * The usage gate is driven through WorkflowService.trigger, with the usage
 * figures and the workflow store mocked.
 */

const fs = require('fs');
const path = require('path');

const mockHome = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ct-auto-cost-'));

jest.mock('os', () => {
  const realOs = jest.requireActual('os');
  return { ...realOs, homedir: jest.fn(() => mockHome) };
});

const CostService = require('../../src/main/services/CostService');
const { costOf } = require('../../src/shared/model-pricing');
const { accountsUsedBy, claudeStepsOf, compileTask, normalizeSimple, PROJECT_ACCOUNT } = require('../../src/shared/simple-task');

const DATA = path.join(mockHome, '.claude-terminal');
const RUNS_FILE = path.join(DATA, 'cost', 'automation-runs.jsonl');

function line({ id, t, model = 'claude-sonnet-5', input = 0, output = 0, requestId = `req-${id}` }) {
  return JSON.stringify({
    type: 'assistant', sessionId: 'auto-1', requestId, timestamp: new Date(t).toISOString(),
    message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
}

function transcript(name, lines) {
  const file = path.join(mockHome, `${name}.jsonl`);
  fs.writeFileSync(file, lines.map(l => `${l}\n`).join(''));
  return file;
}

function writeAccounts(accounts) {
  fs.mkdirSync(path.join(DATA, 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'accounts', 'index.json'), JSON.stringify({ accounts, defaultId: accounts[0]?.id || null }));
}

beforeEach(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
  CostService._reset();
  writeAccounts([{ id: 'acc-work', name: 'Work' }, { id: 'acc-perso', name: 'Perso' }]);
});

afterAll(() => fs.rmSync(mockHome, { recursive: true, force: true }));

describe('recording a step', () => {
  test('the step is priced from its transcript, per automation', async () => {
    const start = Date.parse('2026-10-05T09:00:00Z');
    const file = transcript('a', [
      line({ id: 'm1', t: start + 1000, input: 1000, output: 500 }),
      line({ id: 'm2', t: start + 2000, input: 2000, output: 100 }),
    ]);
    const rec = await CostService.recordAutomationRun({
      files: [file], since: start, workflowId: 'wf-1', workflowName: 'Daily recap', runId: 'run-1', accountId: 'acc-work', at: start + 5000,
    });
    expect(rec.buckets).toEqual([expect.objectContaining({ m: 'claude-sonnet-5', i: 3000, o: 600, n: 2 })]);

    const report = CostService.getAutomationReport();
    expect(report.automations).toHaveLength(1);
    expect(report.automations[0]).toMatchObject({ workflowId: 'wf-1', name: 'Daily recap', runs: 1 });
    expect(report.automations[0].cost).toBeCloseTo(costOf('claude-sonnet-5', { input: 3000, output: 600 }), 10);
    expect(report.automations[0].byAccount).toHaveProperty('acc-work');
  });

  test("a resumed conversation's copied history is not counted again", async () => {
    const start = Date.parse('2026-10-05T09:00:00Z');
    const file = transcript('fork', [
      // Turns copied from the chat the automation resumed: already spent there.
      line({ id: 'old1', t: start - 60_000, input: 50_000, output: 9_000 }),
      line({ id: 'new1', t: start + 1000, input: 100, output: 10 }),
    ]);
    const rec = await CostService.recordAutomationRun({ files: [file], since: start, workflowId: 'wf-1', at: start + 2000 });
    expect(rec.buckets[0]).toMatchObject({ i: 100, o: 10, n: 1 });
  });

  test('repeated streaming lines of one message count once, at their final size', async () => {
    const start = Date.parse('2026-10-05T09:00:00Z');
    const file = transcript('stream', [
      line({ id: 'm1', t: start + 1000, input: 10, output: 3 }),
      line({ id: 'm1', t: start + 1000, input: 10, output: 40 }),
    ]);
    const rec = await CostService.recordAutomationRun({ files: [file], since: start, workflowId: 'wf-1' });
    expect(rec.buckets[0]).toMatchObject({ i: 10, o: 40, n: 1 });
  });

  test('a step that used no tokens records nothing', async () => {
    expect(await CostService.recordAutomationRun({ files: [path.join(mockHome, 'missing.jsonl')], workflowId: 'wf-1' })).toBeNull();
    expect(fs.existsSync(RUNS_FILE)).toBe(false);
  });

  test('a torn last line costs that step only', async () => {
    const start = Date.parse('2026-10-05T09:00:00Z');
    const file = transcript('t', [line({ id: 'm1', t: start + 1, input: 100 })]);
    await CostService.recordAutomationRun({ files: [file], since: start, workflowId: 'wf-1', runId: 'r1', at: start + 10 });
    fs.appendFileSync(RUNS_FILE, '{"v":1,"at":');
    expect(CostService.getAutomationReport().totals.steps).toBe(1);
  });
});

describe('the automation report', () => {
  async function step(workflowId, runId, at, accountId, input) {
    const file = transcript(`${workflowId}-${runId}-${at}`, [line({ id: `${runId}-${at}`, t: at, input })]);
    await CostService.recordAutomationRun({ files: [file], since: at - 1, workflowId, workflowName: workflowId, runId, accountId, at });
  }

  test('two Claude steps of one run are one run', async () => {
    const t0 = Date.parse('2026-10-05T09:00:00Z');
    await step('wf-1', 'run-1', t0, 'acc-work', 100);
    await step('wf-1', 'run-1', t0 + 1000, 'acc-work', 100);
    await step('wf-1', 'run-2', t0 + 60_000, 'acc-work', 100);
    const [a] = CostService.getAutomationReport().automations;
    expect(a.runs).toBe(2);
    expect(a.avgPerRun).toBeCloseTo(a.cost / 2, 12);
  });

  test('filters by period and by account', async () => {
    const t0 = Date.parse('2026-10-05T09:00:00Z');
    await step('wf-1', 'r1', t0, 'acc-work', 100);
    await step('wf-2', 'r2', t0 + 10_000, 'acc-perso', 100);
    expect(CostService.getAutomationReport({ from: t0 + 1 }).automations.map(a => a.workflowId)).toEqual(['wf-2']);
    expect(CostService.getAutomationReport({ accountId: 'acc-work' }).automations.map(a => a.workflowId)).toEqual(['wf-1']);
  });

  test('a step on an account that was removed since is reported as unknown', async () => {
    await step('wf-1', 'r1', Date.parse('2026-10-05T09:00:00Z'), 'acc-gone', 100);
    expect(Object.keys(CostService.getAutomationReport().automations[0].byAccount)).toEqual([CostService.UNKNOWN_ACCOUNT]);
  });
});

describe('which accounts a workflow names', () => {
  test('explicit ids only: the default and the project account name no account', () => {
    const task = (account) => compileTask({ name: 'T', simple: { prompt: 'x', account } });
    expect(accountsUsedBy(task('acc-work'))).toEqual(['acc-work']);
    expect(accountsUsedBy(task(''))).toEqual([]);
    expect(accountsUsedBy(task(PROJECT_ACCOUNT))).toEqual([]);
  });

  test('a hand-built graph is read from its Claude nodes', () => {
    const wf = { graph: { nodes: [
      { id: 1, type: 'workflow/trigger', properties: {} },
      { id: 2, type: 'workflow/claude', properties: { account: 'acc-a' } },
      { id: 3, type: 'workflow/claude', properties: { account: 'acc-b', maxUsage: 90 } },
    ] } };
    expect(accountsUsedBy(wf).sort()).toEqual(['acc-a', 'acc-b']);
    expect(claudeStepsOf(wf).map(s => s.maxUsage)).toEqual([undefined, 90]);
  });

  test('the usage limit defaults to off and reaches the Claude node', () => {
    expect(normalizeSimple({ prompt: 'x' }).maxUsage).toBe(0);
    const wf = compileTask({ name: 'T', simple: { prompt: 'x', maxUsage: 90 } });
    expect(wf.graph.nodes.find(n => n.type === 'workflow/claude').properties.maxUsage).toBe(90);
  });
});

describe('the usage gate', () => {
  let service;
  let storage;
  let usage;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('chokidar', () => ({
      watch: jest.fn(() => Object.assign(new (require('events').EventEmitter)(), { close: jest.fn() })),
    }));
    storage = {
      getWorkflow: jest.fn(),
      appendRun: jest.fn(async () => {}),
      updateRun: jest.fn(async () => {}),
      loadWorkflows: jest.fn(async () => []),
    };
    jest.doMock('../../src/main/services/WorkflowStorage', () => new Proxy(storage, {
      get: (target, prop) => (prop in target ? target[prop] : () => {}),
    }));
    usage = { buckets: [] };
    jest.doMock('../../src/main/services/UsageService', () => ({
      usageForAccount: jest.fn(async () => ({ data: usage })),
    }));
    jest.doMock('../../src/main/services/AccountManager', () => ({
      listAccounts: jest.fn(async () => ({ accounts: [], liveId: 'acc-live' })),
    }));
    service = require('../../src/main/services/WorkflowService');
    service._send = jest.fn();
    service._startRun = jest.fn(async () => ({ success: true, runId: 'started' }));
  });

  const future = () => new Date(Date.now() + 3600_000).toISOString();
  const task = (maxUsage) => ({ id: 'wf-1', enabled: true, ...compileTask({ name: 'Recap', simple: { prompt: 'x', maxUsage } }) });

  test('over the limit: no run starts, a skipped run says why', async () => {
    storage.getWorkflow.mockResolvedValue(task(90));
    usage.buckets = [
      { type: 'session', utilization: 40, resetsAt: future() },
      { type: 'weekly', utilization: 93, resetsAt: future() },
    ];
    const res = await service.trigger('wf-1', { source: 'cron' });
    expect(res).toMatchObject({ success: false, skipped: true });
    expect(service._startRun).not.toHaveBeenCalled();
    const run = storage.appendRun.mock.calls[0][0];
    expect(run).toMatchObject({ status: 'skipped', skip: { reason: 'usage', bucket: 'weekly', utilization: 93, threshold: 90 }, accounts: ['acc-live'] });
    expect(service._send).toHaveBeenCalledWith('workflow-run-end', expect.objectContaining({ status: 'skipped' }));
  });

  test('under the limit, or with no limit, the run starts', async () => {
    usage.buckets = [{ type: 'session', utilization: 89, resetsAt: future() }];
    storage.getWorkflow.mockResolvedValue(task(90));
    await service.trigger('wf-1', { source: 'cron' });
    storage.getWorkflow.mockResolvedValue(task(0));
    usage.buckets = [{ type: 'session', utilization: 100, resetsAt: future() }];
    await service.trigger('wf-1', { source: 'cron' });
    expect(service._startRun).toHaveBeenCalledTimes(2);
  });

  test('a window past its reset no longer counts', async () => {
    storage.getWorkflow.mockResolvedValue(task(90));
    usage.buckets = [{ type: 'session', utilization: 100, resetsAt: new Date(Date.now() - 1000).toISOString() }];
    await service.trigger('wf-1', { source: 'cron' });
    expect(service._startRun).toHaveBeenCalled();
  });

  test('running it by hand, or from the MCP tools, is never gated', async () => {
    storage.getWorkflow.mockResolvedValue(task(50));
    usage.buckets = [{ type: 'weekly', utilization: 99, resetsAt: future() }];
    await service.trigger('wf-1', { source: 'manual' });
    await service.trigger('wf-1', { source: 'mcp' });
    expect(service._startRun).toHaveBeenCalledTimes(2);
  });

  test('no usage figures: the run goes ahead rather than every automation stopping', async () => {
    storage.getWorkflow.mockResolvedValue(task(50));
    usage = null;
    await service.trigger('wf-1', { source: 'cron' });
    expect(service._startRun).toHaveBeenCalled();
  });
});
