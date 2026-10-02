const { can, isRemoteProject, CAPABILITIES } = require('../../src/shared/remote-capabilities');

describe('remote-capabilities', () => {
  const local = { id: 'p1', path: 'C:\\code\\app' };
  const remote = { id: 'p2', path: 'ssh-remote://abcd1234/srv/app', remote: { profileId: 'abcd1234', path: '/srv/app' } };
  const table = { parallelTasks: { remote: false, reasonKey: 'remote.disabled.parallelTasks' } };

  test('a project is remote by its remote block or its URI path', () => {
    expect(isRemoteProject(remote)).toBe(true);
    expect(isRemoteProject({ path: 'ssh-remote://abcd1234/x' })).toBe(true);
    expect(isRemoteProject(local)).toBe(false);
    expect(isRemoteProject(null)).toBe(false);
  });

  test('a local project is never affected by the table', () => {
    expect(can(local, 'parallelTasks', table)).toEqual({ ok: true });
  });

  test('a disabled row refuses a remote project with its reason key', () => {
    expect(can(remote, 'parallelTasks', table)).toEqual({ ok: false, reasonKey: 'remote.disabled.parallelTasks' });
    expect(can(remote, 'somethingElse', table)).toEqual({ ok: true });
  });

  test('the shipped table is frozen', () => {
    expect(Object.isFrozen(CAPABILITIES)).toBe(true);
  });
});
