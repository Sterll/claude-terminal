const { can, canOpenInEditor, editorFamily, REMOTE_EDITORS, isRemoteProject, sameProject, CAPABILITIES } = require('../../src/shared/remote-capabilities');

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

  test('the project-level actions refuse a remote project and leave a local one alone', () => {
    for (const feature of ['openInExplorer', 'openInEditor', 'accountBinding', 'cloudUpload', 'sessionMove', 'pathAttachment']) {
      expect(can(remote, feature).ok).toBe(false);
      expect(can(local, feature)).toEqual({ ok: true });
    }
  });

  test('moving files between a local and a remote tree is refused for a remote project', () => {
    expect(can(remote, 'crossRootTransfer')).toEqual({ ok: false, reasonKey: 'ssh.disabled.crossRootTransfer' });
    expect(can(local, 'crossRootTransfer')).toEqual({ ok: true });
  });

  test('the VS Code family opens a remote project over Remote-SSH, other editors do not', () => {
    expect(REMOTE_EDITORS).toEqual(['code', 'cursor', 'windsurf']);
    for (const editor of ['code', 'cursor', 'windsurf', 'Code.cmd', '/usr/local/bin/cursor', 'C:/Tools/Windsurf.exe']) {
      expect(canOpenInEditor(remote, editor)).toEqual({ ok: true });
    }
    for (const editor of ['webstorm', 'idea', 'subl', 'zed', '']) {
      expect(canOpenInEditor(remote, editor)).toEqual({ ok: false, reasonKey: 'ssh.disabled.openInEditor' });
    }
    expect(canOpenInEditor(local, 'webstorm')).toEqual({ ok: true });
    expect(editorFamily('C:/Program Files/Microsoft VS Code/bin/code.cmd')).toBe('code');
  });

  test('terminals and chat run over ssh, so they are no longer refused', () => {
    expect(CAPABILITIES.terminals).toBeUndefined();
    expect(can(remote, 'terminals')).toEqual({ ok: true });
    expect(CAPABILITIES.chat).toBeUndefined();
    expect(can(remote, 'chat')).toEqual({ ok: true });
  });

  describe('sameProject (tab ownership)', () => {
    test('a local and a remote project at the same POSIX path are different projects', () => {
      const localApp = { id: 'l1', path: '/home/u/app' };
      const remoteApp = { id: 'r1', path: 'ssh-remote://abcd1234/home/u/app', remote: { profileId: 'abcd1234', path: '/home/u/app' } };
      expect(sameProject(localApp, remoteApp)).toBe(false);
      expect(sameProject(remoteApp, localApp)).toBe(false);
    });

    test('a remote project is matched by id', () => {
      expect(sameProject(remote, { ...remote })).toBe(true);
      expect(sameProject(remote, { ...remote, id: 'other' })).toBe(false);
    });

    test('two local projects are still compared by path, as before', () => {
      expect(sameProject({ id: 'a', path: '/w/api' }, { id: 'b', path: '/w/api' })).toBe(true);
      expect(sameProject({ id: 'a', path: '/w/api' }, { id: 'a', path: '/w/api-legacy' })).toBe(false);
      expect(sameProject(null, local)).toBe(false);
    });
  });
});
