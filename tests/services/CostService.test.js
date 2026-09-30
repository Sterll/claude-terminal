// CostService: per-account / per-project cost from local Claude Code transcripts.
//
// Real files in a temp home, because what matters is what the scanner makes of
// transcripts as Claude Code writes them: duplicated streaming lines, files that
// grow between scans, sessions that change account midway.

const fs = require('fs');
const path = require('path');

const mockHome = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ct-cost-'));

jest.mock('os', () => {
  const realOs = jest.requireActual('os');
  return { ...realOs, homedir: jest.fn(() => mockHome) };
});

const CostService = require('../../src/main/services/CostService');
const { encodeProjectPath } = require('../../src/shared/session-dirs');

const PROJECTS = path.join(mockHome, '.claude', 'projects');
const DATA = path.join(mockHome, '.claude-terminal');
const PERSONAL = 'acc-personal';
const WORK = 'acc-work';

function assistantLine({ id, requestId = `req-${id}`, sessionId = 's1', t, model = 'claude-opus-5', input = 0, output = 0, cacheRead = 0, write5m = 0, write1h = 0 }) {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    requestId,
    timestamp: new Date(t).toISOString(),
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: write5m + write1h,
        cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
      },
    },
  });
}

function writeTranscript(projectPath, sessionId, lines, { append = false } = {}) {
  const dir = path.join(PROJECTS, encodeProjectPath(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const text = lines.map(l => `${l}\n`).join('');
  if (append) fs.appendFileSync(file, text);
  else fs.writeFileSync(file, text);
  return file;
}

function writeJson(rel, value) {
  const file = path.join(DATA, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

const T0 = Date.parse('2026-09-21T10:00:00Z');
const HOUR = 3600 * 1000;

beforeEach(() => {
  fs.rmSync(path.join(mockHome, '.claude'), { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
  CostService._reset();
  writeJson('accounts/index.json', {
    accounts: [{ id: PERSONAL, name: 'Personal' }, { id: WORK, name: 'Work' }],
    defaultId: PERSONAL,
    liveId: PERSONAL,
  });
  writeJson('projects.json', {
    projects: [
      { id: 'p-side', name: 'Side', path: '/code/side' },
      { id: 'p-job', name: 'Job', path: '/code/job', accountId: WORK },
    ],
  });
});

afterAll(() => {
  fs.rmSync(mockHome, { recursive: true, force: true });
});

describe('CostService', () => {
  test('keeps the largest copy of a message written several times while streaming', async () => {
    writeTranscript('/code/side', 's1', [
      assistantLine({ id: 'm1', t: T0, output: 10 }),
      assistantLine({ id: 'm1', t: T0, output: 400 }),
      assistantLine({ id: 'm1', t: T0, output: 1000 }),
    ]);
    const report = await CostService.getReport();
    expect(report.totals.messages).toBe(1);
    expect(report.totals.output).toBe(1000);
    // Opus 5 output: $25 per million tokens.
    expect(report.totals.cost).toBeCloseTo(0.025);
  });

  test('attributes a bound project to its account and the rest to the live login', async () => {
    writeTranscript('/code/side', 's1', [assistantLine({ id: 'a', t: T0, output: 1e6 })]);
    writeTranscript('/code/job', 's2', [assistantLine({ id: 'b', sessionId: 's2', t: T0, output: 2e6 })]);

    const report = await CostService.getReport();
    const byId = Object.fromEntries(report.byAccount.map(a => [a.id, a.cost]));
    expect(byId[PERSONAL]).toBeCloseTo(25);
    expect(byId[WORK]).toBeCloseTo(50);

    const job = report.byProject.find(p => p.name === 'Job');
    expect(job.boundAccountId).toBe(WORK);
  });

  test('flags work older than the tracking start as estimated', async () => {
    writeTranscript('/code/side', 's1', [assistantLine({ id: 'a', t: T0, output: 1e6 })]);
    const report = await CostService.getReport();
    // T0 predates the timeline this first call just created.
    expect(report.attribution.estimatedCost).toBeCloseTo(25);
  });

  test('follows the live account across a switch', async () => {
    const switchedAt = Date.now();
    // Seeds the timeline with the account live at the time, then records the switch.
    CostService.noteLiveAccount(WORK);

    writeTranscript('/code/side', 's1', [
      assistantLine({ id: 'before', t: switchedAt - HOUR, output: 1e6 }),
      assistantLine({ id: 'after', t: Date.now() + HOUR, output: 1e6 }),
    ]);
    const report = await CostService.getReport();
    const byId = Object.fromEntries(report.byAccount.map(a => [a.id, a.cost]));
    expect(byId[PERSONAL]).toBeCloseTo(25);
    expect(byId[WORK]).toBeCloseTo(25);
  });

  test('a session recorded on an account wins over the project binding', async () => {
    await CostService.scan();
    const start = Date.now();
    CostService.noteSessionAccount('s9', PERSONAL);
    writeTranscript('/code/job', 's9', [assistantLine({ id: 'x', sessionId: 's9', t: start + HOUR, output: 1e6 })]);

    const report = await CostService.getReport();
    expect(report.byAccount).toEqual([expect.objectContaining({ id: PERSONAL })]);
  });

  test('filters by date range and by account', async () => {
    writeTranscript('/code/side', 's1', [
      assistantLine({ id: 'old', t: T0 - 48 * HOUR, output: 1e6 }),
      assistantLine({ id: 'new', t: T0, output: 1e6 }),
    ]);
    writeTranscript('/code/job', 's2', [assistantLine({ id: 'w', sessionId: 's2', t: T0, output: 1e6 })]);

    const ranged = await CostService.getReport({ from: T0 - HOUR, to: T0 + HOUR });
    expect(ranged.totals.messages).toBe(2);

    const work = await CostService.getReport({ accountId: WORK });
    expect(work.totals.messages).toBe(1);
    expect(work.byProject.map(p => p.name)).toEqual(['Job']);
  });

  test('reads only what was appended since the last scan', async () => {
    writeTranscript('/code/side', 's1', [assistantLine({ id: 'a', t: T0, output: 1e6 })]);
    expect((await CostService.getReport()).totals.messages).toBe(1);

    writeTranscript('/code/side', 's1', [assistantLine({ id: 'b', t: T0 + HOUR, output: 1e6 })], { append: true });
    const report = await CostService.getReport();
    expect(report.totals.messages).toBe(2);
    expect(report.totals.cost).toBeCloseTo(50);
  });

  test('leaves a half-written last line for the next scan', async () => {
    const file = writeTranscript('/code/side', 's1', [assistantLine({ id: 'a', t: T0, output: 1e6 })]);
    const partial = assistantLine({ id: 'b', t: T0, output: 1e6 });
    fs.appendFileSync(file, partial.slice(0, 40));
    expect((await CostService.getReport()).totals.messages).toBe(1);

    fs.appendFileSync(file, `${partial.slice(40)}\n`);
    expect((await CostService.getReport()).totals.messages).toBe(2);
  });

  test('names unregistered directories and reports unpriced models', async () => {
    const dir = path.join(PROJECTS, `${encodeProjectPath(mockHome)}-scratch`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's.jsonl'), `${assistantLine({ id: 'z', t: T0, model: 'mystery-model', output: 5 })}\n`);

    const report = await CostService.getReport();
    expect(report.byProject[0].name).toBe('scratch');
    expect(report.unpricedModels).toEqual(['mystery-model']);
  });

  describe('weekly quota share', () => {
    const DAY = 24 * HOUR;
    const weekly = (utilization, resetsAt) => ({ buckets: [{ type: 'weekly', utilization, resetsAt: new Date(resetsAt).toISOString() }] });

    test('with one reading it cannot tell this machine from the others', async () => {
      const now = Date.now();
      writeTranscript('/code/job', 's2', [assistantLine({ id: 'a', sessionId: 's2', t: now - 2 * DAY, output: 4e6 })]);
      const estimate = await CostService.getQuotaEstimate({
        accountId: WORK, utilization: 20, resetsAt: new Date(now + 2 * DAY).toISOString(),
      });
      expect(estimate.calibrated).toBe(false);
      expect(estimate.spent).toBeCloseTo(100);
      expect(estimate.thisMachineMax).toBe(20);
      expect(estimate.othersMin).toBe(0);
    });

    test('a stretch where only this machine worked bounds everyone else from below', async () => {
      const now = Date.now();
      const resetsAt = now + 2 * DAY;
      // Someone else took the account from 0% to 10% while this machine spent $10;
      // then this machine alone spent $100 while it went from 10% to 20%.
      writeTranscript('/code/job', 's2', [
        assistantLine({ id: 'early', sessionId: 's2', t: now - 4 * DAY, output: 0.4e6 }),
        assistantLine({ id: 'late', sessionId: 's2', t: now - 2 * DAY, output: 4e6 }),
      ]);
      CostService.noteUsageSample(WORK, weekly(10, resetsAt), now - 3 * DAY);
      CostService.noteUsageSample(WORK, weekly(20, resetsAt), now - 1 * DAY);

      const estimate = await CostService.getQuotaEstimate({ accountId: WORK });
      expect(estimate.calibrated).toBe(true);
      // $100 over a 10-point rise, widened by one point for rounding.
      expect(estimate.pricePerPercentFloor).toBeCloseTo(100 / 11);
      expect(estimate.thisMachineMax).toBeCloseTo(110 / (100 / 11));
      expect(estimate.othersMin).toBeCloseTo(20 - 110 / (100 / 11));
      expect(estimate.samples).toBe(2);
    });

    test('ignores rises too small to be more than rounding', async () => {
      const now = Date.now();
      const resetsAt = now + 2 * DAY;
      writeTranscript('/code/job', 's2', [assistantLine({ id: 'x', sessionId: 's2', t: now - 2 * DAY, output: 4e6 })]);
      CostService.noteUsageSample(WORK, weekly(10, resetsAt), now - 3 * DAY);
      CostService.noteUsageSample(WORK, weekly(12, resetsAt), now - 1 * DAY);

      const estimate = await CostService.getQuotaEstimate({ accountId: WORK });
      // Only the window-opening pairs qualify, and the best of those runs to
      // the latest reading, which cannot separate anyone.
      expect(estimate.pricePerPercentFloor).toBeCloseTo(100 / 13);
      expect(estimate.calibrated).toBe(false);
    });

    test('a reading of the machine-wide login is filed under the live account', () => {
      CostService.noteUsageSample(null, weekly(5, Date.now() + DAY));
      const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'cost', 'usage-samples.json'), 'utf8'));
      expect(Object.keys(saved.accounts)).toEqual([PERSONAL]);
    });
  });

  test('never overwrites an unreadable timeline', async () => {
    const file = path.join(DATA, 'cost', 'account-timeline.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"live": [');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await CostService.getReport();
    CostService.noteLiveAccount(WORK);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"live": [');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
