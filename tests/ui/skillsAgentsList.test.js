// Skills and agents lists: one compact card per item, a filter that hides
// cards in place, and actions delegated from the list.

const mockSkills = [];
const mockAgents = [];

jest.mock('../../src/renderer/services/SkillService', () => ({
  loadSkills: jest.fn(async () => {}),
  getSkills: jest.fn(() => mockSkills),
  writeSkillContent: jest.fn(),
}));
jest.mock('../../src/renderer/services/AgentService', () => ({
  loadAgents: jest.fn(async () => {}),
  getAgents: jest.fn(() => mockAgents),
  writeAgentContent: jest.fn(),
}));
jest.mock('../../src/renderer/ui/components/Modal', () => ({
  showConfirm: jest.fn(async () => true),
  createModal: jest.fn(),
  showModal: jest.fn(),
  closeModal: jest.fn(),
}));

const { SkillsAgentsPanel } = require('../../src/renderer/ui/panels/SkillsAgentsPanel');
const { showConfirm } = require('../../src/renderer/ui/components/Modal');

function makePanel() {
  const api = {
    dialog: { openInExplorer: jest.fn() },
    fs: { promises: { rm: jest.fn(async () => {}) } },
    os: { homedir: () => '/home/me' },
  };
  const panel = new SkillsAgentsPanel(null, { api });
  panel._showEditorModal = jest.fn();
  return { panel, api };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="skills-list"></div><div id="agents-list"></div>';
  mockSkills.splice(0, mockSkills.length,
    { id: 'arsenal', name: 'arsenal', description: 'Arsenal expert.\n\nUse when deploying.', path: '/s/arsenal', filePath: '/s/arsenal/SKILL.md' },
    { id: 'cds', name: 'cds', description: 'CDS workflows.', path: '/s/cds', filePath: '/s/cds/SKILL.md' },
    { id: 'p1', name: 'from-plugin', description: 'Plugin skill', path: '/p/x', filePath: '/p/x/SKILL.md', isPlugin: true, sourceLabel: 'acme' },
  );
  mockAgents.splice(0, mockAgents.length,
    { id: 'explore', name: 'explore', description: 'Explores code.', path: '/a/explore.md', filePath: '/a/explore.md', tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch'] },
  );
  showConfirm.mockClear();
});

describe('skills list', () => {
  test('one card per skill, showing the opening of the description', async () => {
    const { panel } = makePanel();
    await panel._loadLocalSkills();
    const cards = document.querySelectorAll('#skills-list .sa-card');
    expect(cards).toHaveLength(3);
    expect(cards[0].querySelector('.sa-card-desc').textContent).toBe('Arsenal expert.');
    // Plugin skills are read-only: no edit, no delete.
    const plugin = [...cards].find(c => c.dataset.id === 'p1');
    expect(plugin.querySelector('[data-action="edit"]')).toBeNull();
    expect(plugin.querySelector('[data-action="delete"]')).toBeNull();
  });

  test('the filter hides cards and empty sections in place', async () => {
    const { panel } = makePanel();
    await panel._loadLocalSkills();
    const input = document.querySelector('#skills-list .sa-search-input');
    input.value = 'cds';
    input.dispatchEvent(new Event('input'));
    const visible = [...document.querySelectorAll('#skills-list .sa-card')].filter(c => !c.hidden);
    expect(visible.map(c => c.dataset.id)).toEqual(['cds']);
    expect(document.querySelectorAll('#skills-list .sa-section')[1].hidden).toBe(true);

    input.value = 'nothing-like-this';
    input.dispatchEvent(new Event('input'));
    expect(document.querySelector('#skills-list .sa-no-match').hidden).toBe(false);
  });

  test('a click on the card opens the editor, the folder icon opens the folder', async () => {
    const { panel, api } = makePanel();
    await panel._loadLocalSkills();
    const card = document.querySelector('#skills-list .sa-card[data-id="arsenal"]');
    card.querySelector('.sa-card-desc').click();
    expect(panel._showEditorModal).toHaveBeenCalledWith('skill', 'arsenal', '/s/arsenal/SKILL.md');

    card.querySelector('[data-action="open"]').click();
    expect(api.dialog.openInExplorer).toHaveBeenCalledWith('/s/arsenal');
  });

  test('delete asks first, then removes the folder', async () => {
    const { panel, api } = makePanel();
    await panel._loadLocalSkills();
    document.querySelector('#skills-list .sa-card[data-id="cds"] [data-action="delete"]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(showConfirm).toHaveBeenCalled();
    expect(api.fs.promises.rm).toHaveBeenCalledWith('/s/cds', { recursive: true, force: true });
  });

  test('a second render does not stack click handlers', async () => {
    const { panel } = makePanel();
    await panel._loadLocalSkills();
    await panel._loadLocalSkills();
    document.querySelector('#skills-list .sa-card[data-id="cds"]').click();
    expect(panel._showEditorModal).toHaveBeenCalledTimes(1);
  });
});

describe('agents list', () => {
  test('tools show as chips, the rest folded into a count', async () => {
    const { panel } = makePanel();
    await panel.loadAgents();
    const chips = [...document.querySelectorAll('#agents-list .sa-chip')].map(c => c.textContent);
    expect(chips).toEqual(['Read', 'Grep', 'Glob', 'Bash', '+2']);
  });

  test('the filter matches a tool name', async () => {
    const { panel } = makePanel();
    await panel.loadAgents();
    const input = document.querySelector('#agents-list .sa-search-input');
    input.value = 'webfetch';
    input.dispatchEvent(new Event('input'));
    expect(document.querySelector('#agents-list .sa-card').hidden).toBe(false);
  });
});
