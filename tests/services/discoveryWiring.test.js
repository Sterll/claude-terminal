/**
 * The suggestions wired to the real renderer state: a third Claude tab on a
 * project raises the Control Tower suggestion, a turn running holds it, and
 * opening Control Tower first keeps it from ever showing.
 */

const flush = () => new Promise((r) => setTimeout(r, 5));

function setupDom() {
  document.body.innerHTML = '<div id="toast-container" class="toast-container"></div>';
  document.hasFocus = () => true;
}

async function boot({ storeContent } = {}) {
  jest.resetModules();
  setupDom();
  const fsp = window.electron_nodeModules.fs.promises;
  fsp.readFile.mockReset();
  if (storeContent === undefined) {
    fsp.readFile.mockImplementation(async () => { const e = new Error('absent'); e.code = 'ENOENT'; throw e; });
  } else {
    fsp.readFile.mockImplementation(async () => storeContent);
  }
  const Discovery = require('../../src/renderer/services/discovery');
  const { terminalsState } = require('../../src/renderer/state/terminals.state');
  const engine = await Discovery.init({ api: window.electron_api, startupGraceMs: 0 });
  return { Discovery, terminalsState, engine };
}

function setTabs(terminalsState, entries) {
  terminalsState.setProp('terminals', new Map(entries.map((e, i) => [i + 1, e])));
}

const project = { id: 'p1', name: 'Shop', path: '/w/shop' };

afterEach(() => {
  try { require('../../src/renderer/services/discovery').destroy(); } catch { /* not loaded */ }
});

test('a third Claude tab on one project shows the Control Tower suggestion', async () => {
  const { terminalsState } = await boot();
  setTabs(terminalsState, [{ project, status: 'ready' }, { project, status: 'ready' }]);
  await flush();
  expect(document.querySelector('.toast-suggestion')).toBeNull();

  setTabs(terminalsState, [{ project, status: 'ready' }, { project, status: 'ready' }, { project, status: 'ready', mode: 'chat' }]);
  await flush();
  const card = document.querySelector('.toast-suggestion');
  expect(card).not.toBeNull();
  expect(card.querySelector('.toast-title').textContent).toContain('3');
});

test('held while a turn runs, shown when it ends', async () => {
  const { terminalsState } = await boot();
  setTabs(terminalsState, [{ project, status: 'working' }, { project, status: 'ready' }, { project, status: 'ready' }]);
  await flush();
  expect(document.querySelector('.toast-suggestion')).toBeNull();

  setTabs(terminalsState, [{ project, status: 'ready' }, { project, status: 'ready' }, { project, status: 'ready' }]);
  await flush();
  expect(document.querySelector('.toast-suggestion')).not.toBeNull();
});

test('never for someone who already opened Control Tower', async () => {
  const { terminalsState } = await boot();
  document.body.dataset.activeTab = 'control-tower';
  await flush();
  setTabs(terminalsState, [{ project }, { project }, { project }]);
  await flush();
  expect(document.querySelector('.toast-suggestion')).toBeNull();
  delete document.body.dataset.activeTab;
});

test('an unreadable discovery.json keeps every suggestion off', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const { terminalsState } = await boot({ storeContent: '{"rules": {' });
  setTabs(terminalsState, [{ project }, { project }, { project }]);
  await flush();
  expect(document.querySelector('.toast-suggestion')).toBeNull();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('store unreadable'));
  warn.mockRestore();
});

test('the Settings switch turns them all off', async () => {
  const { terminalsState } = await boot();
  require('../../src/renderer/state/settings.state').settingsState.setProp('discoverySuggestionsEnabled', false);
  setTabs(terminalsState, [{ project }, { project }, { project }]);
  await flush();
  expect(document.querySelector('.toast-suggestion')).toBeNull();
});
