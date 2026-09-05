/**
 * Focused-tab marker in the tabs MCP tool.
 *
 * "Send this to the current conversation" is only resolvable if something says
 * which tab the user is looking at. The renderer stamps activeTabId into
 * tabs.json; tab_list must surface it, and must not fall back to guessing from
 * activity timestamps when the field is absent.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-tabs-'));
process.env.CT_DATA_DIR = DATA_DIR;

const tabs = require('../../resources/mcp-servers/tools/tabs.js');

function writeSnapshot(snapshot) {
  fs.writeFileSync(path.join(DATA_DIR, 'tabs.json'), JSON.stringify(snapshot), 'utf8');
}

const TAB_A = {
  tabId: 'tab_a', ptyId: 1, projectId: 'p1', projectName: 'marvel-quiz',
  mode: 'chat', title: 'marvel-quiz', status: 'idle',
  createdAt: '2026-09-01T10:00:00Z', lastActivityAt: '2026-09-01T10:00:00Z', details: {},
};
const TAB_B = {
  tabId: 'tab_b', ptyId: 2, projectId: 'p2', projectName: 'spacebot',
  mode: 'chat', title: 'spacebot', status: 'working',
  // More recent activity than tab_a — the trap the marker exists to avoid.
  createdAt: '2026-09-01T11:00:00Z', lastActivityAt: '2026-09-01T12:00:00Z', details: {},
};

const textOf = (r) => r.content[0].text;

afterAll(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('tab_list focus marker', () => {
  test('flags the focused tab even when another is more recently active', async () => {
    writeSnapshot({ updatedAt: Date.now(), activeTabId: 'tab_a', tabs: [TAB_A, TAB_B] });

    const out = textOf(await tabs.handle('tab_list', {}));
    const lineA = out.split('\n').find(l => l.startsWith('tab_a'));
    const lineB = out.split('\n').find(l => l.startsWith('tab_b'));

    expect(lineA).toContain('FOCUSED');
    expect(lineB).not.toContain('FOCUSED');
  });

  test('marks nothing when the snapshot has no activeTabId', async () => {
    writeSnapshot({ updatedAt: Date.now(), tabs: [TAB_A, TAB_B] });

    const out = textOf(await tabs.handle('tab_list', {}));

    expect(out).not.toContain('FOCUSED');
  });

  test('marks nothing when the focused tab is not in the list', async () => {
    writeSnapshot({ updatedAt: Date.now(), activeTabId: 'tab_gone', tabs: [TAB_A] });

    const out = textOf(await tabs.handle('tab_list', {}));

    expect(out).not.toContain('FOCUSED');
  });
});
