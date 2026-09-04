/**
 * getUsageAccountForProject — what the usage bar names.
 *
 * The figures always belong to someone, so the label always has an answer:
 * the project's own account when it has one, otherwise whoever owns the
 * machine-wide store its CLI actually reads.
 */

const projects = [];
const state = { projects };

jest.mock('../../src/renderer/state/projects.state', () => ({
  getProjectAccount: jest.fn((id) => (projects.find(p => p.id === id) || {}).accountId || null),
  projectsState: { get: () => state, subscribe: jest.fn() }
}));

const {
  accountsState,
  getUsageAccountForProject
} = require('../../src/renderer/state/accounts.state');

const MAX = { id: 'a-max', name: 'Max 20x', color: '#ff5733' };
const TEAM = { id: 'a-team', name: 'Team', color: '#3b82f6' };

beforeEach(() => {
  projects.length = 0;
  accountsState.set({
    accounts: [MAX, TEAM],
    defaultId: MAX.id,
    liveId: MAX.id,
    hasCredentials: true,
    loaded: true
  });
});

test('a bound project names its own account', () => {
  projects.push({ id: 'p1', accountId: TEAM.id });

  const { account, isDefault } = getUsageAccountForProject('p1');

  expect(account.name).toBe('Team');
  expect(isDefault).toBe(false);
});

test('an unbound project still names an account, flagged as the default', () => {
  projects.push({ id: 'p1' });

  const { account, isDefault } = getUsageAccountForProject('p1');

  // The tab is tinted either way; a blank label next to a coloured tab was the
  // inconsistency this replaced.
  expect(account.name).toBe('Max 20x');
  expect(isDefault).toBe(true);
});

test('no project at all falls back to the machine-wide account', () => {
  const { account, isDefault } = getUsageAccountForProject(null);

  expect(account.name).toBe('Max 20x');
  expect(isDefault).toBe(true);
});

test('an unbound project names the live account, not the default, when they differ', () => {
  projects.push({ id: 'p1' });
  // A manual `claude /login` moved the machine-wide store off the default.
  accountsState.set({ defaultId: MAX.id, liveId: TEAM.id });

  const { account } = getUsageAccountForProject('p1');

  // The figures come from the machine-wide store, so naming the default would
  // attribute them to an account that did not produce them.
  expect(account.name).toBe('Team');
});

test('a binding to a deleted account falls back rather than blanking', () => {
  projects.push({ id: 'p1', accountId: 'gone' });

  const { account, isDefault } = getUsageAccountForProject('p1');

  expect(account.name).toBe('Max 20x');
  expect(isDefault).toBe(true);
});

test('no accounts at all yields nothing to name', () => {
  accountsState.set({ accounts: [], defaultId: null, liveId: null });
  projects.push({ id: 'p1' });

  expect(getUsageAccountForProject('p1').account).toBeNull();
});
