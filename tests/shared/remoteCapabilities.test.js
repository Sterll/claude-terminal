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

  test('every shipped row has a reason translated in all six locales', () => {
    const lookup = (obj, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
    const rows = Object.entries(CAPABILITIES);
    expect(rows.length).toBeGreaterThan(0);
    for (const locale of ['en', 'fr', 'es', 'id', 'zh-CN', 'pt-BR']) {
      const strings = require(`../../src/renderer/i18n/locales/${locale}.json`);
      for (const [feature, row] of rows) {
        expect(row.remote).toBe(false);
        const text = lookup(strings, row.reasonKey);
        if (typeof text !== 'string' || !text) throw new Error(`${locale}: ${feature} -> ${row.reasonKey} is missing`);
      }
    }
  });

  test('the project-level actions of this slice refuse a remote project and leave a local one alone', () => {
    for (const feature of ['openInExplorer', 'openInEditor', 'accountBinding', 'cloudUpload', 'terminals', 'chat']) {
      expect(can(remote, feature).ok).toBe(false);
      expect(can(local, feature)).toEqual({ ok: true });
    }
  });
});
