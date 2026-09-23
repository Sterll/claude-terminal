/**
 * What the MCP `usage_get` tool actually prints.
 *
 * The tool reads the `usage.json` UsageService mirrors. Three things it got
 * wrong once the file finally existed, each of which makes it state something
 * untrue rather than merely say less:
 *
 *  - the printed percentage was clamped to 100, so extra usage beyond the plan
 *    read as exactly at the limit — the one case worth seeing;
 *  - staleness came only from the `stale` flag snapshotted at write time, and
 *    the poller stops with the window minimised, so hours-old figures were
 *    served with no marker;
 *  - the output never named the account, so in a multi-account install a
 *    session bound to one was handed another's quota as its own.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let dataDir;
let tool;

function load() {
  jest.resetModules();
  process.env.CT_DATA_DIR = dataDir;
  return require('../../resources/mcp-servers/tools/usage.js');
}

function writeMirror(payload) {
  fs.writeFileSync(path.join(dataDir, 'usage.json'), JSON.stringify(payload), 'utf8');
}

const fresh = (extra = {}) => ({
  accountId: 'work',
  lastFetch: new Date().toISOString(),
  stale: false,
  error: null,
  buckets: [{ id: 'session', type: 'session', label: 'Session', utilization: 42, resetsAt: null }],
  extraUsage: null,
  ...extra,
});

async function runGet() {
  const res = await tool.handle('usage_get', {});
  return res.content[0].text;
}

let prevDataDir;

beforeEach(() => {
  prevDataDir = process.env.CT_DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-usage-tool-'));
  tool = load();
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.CT_DATA_DIR;
  else process.env.CT_DATA_DIR = prevDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  jest.resetModules();
});

describe('usage_get', () => {
  test('renders a bucket as a bar with its percentage', async () => {
    writeMirror(fresh());
    const out = await runGet();

    expect(out).toContain('Session');
    expect(out).toContain('42%');
  });

  // The titlebar chip makes the same split deliberately: the bar is clamped so
  // the row cannot break, the number is not so the overage stays legible.
  test('does not clamp a percentage past 100 down to 100', async () => {
    writeMirror(fresh({
      buckets: [{ id: 'session', type: 'session', label: 'Session', utilization: 137, resetsAt: null }],
    }));
    const out = await runGet();

    expect(out).toContain('137%');
    expect(out).not.toContain('100%');
  });

  test('the bar itself stays ten cells wide at any overage', async () => {
    writeMirror(fresh({
      buckets: [{ id: 'session', type: 'session', label: 'Session', utilization: 400, resetsAt: null }],
    }));
    const out = await runGet();

    const bar = out.match(/\[([#-]*)\]/);
    expect(bar).not.toBeNull();
    expect(bar[1]).toHaveLength(10);
  });

  test('names the account, so another one is not read as this one', async () => {
    writeMirror(fresh({ accountId: 'personal' }));
    const out = await runGet();

    expect(out).toContain('personal');
  });

  test('figures the poller stopped refreshing are marked stale on age alone', async () => {
    writeMirror(fresh({
      // Written while everything was fine, then the window was minimised.
      stale: false,
      lastFetch: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    }));
    const out = await runGet();

    expect(out).toContain('STALE');
  });

  test('recent figures are not marked stale', async () => {
    writeMirror(fresh());
    const out = await runGet();

    expect(out).not.toContain('STALE');
  });

  test('says the file is missing rather than inventing an answer', async () => {
    const out = await runGet();
    expect(out).toContain('No usage data available');
  });
});

describe('usage_refresh', () => {
  test('drops a request the app can consume', async () => {
    await tool.handle('usage_refresh', {});

    const dir = path.join(dataDir, 'usage', 'triggers');
    expect(fs.readdirSync(dir).filter(f => f.startsWith('refresh_'))).toHaveLength(1);
  });

  // The MCP server is registered globally, so it runs whether or not Claude
  // Terminal is open. Asserting the app will pick this up would be the same
  // false assurance the tool was fixed for.
  test('does not promise the app is listening', async () => {
    const res = await tool.handle('usage_refresh', {});
    const text = res.content[0].text;

    expect(text).toMatch(/if claude terminal is running/i);
  });
});
