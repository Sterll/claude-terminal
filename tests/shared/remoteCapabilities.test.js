const fs = require('fs');
const path = require('path');
const {
  can, canOpenInEditor, editorFamily, REMOTE_EDITORS, isRemoteProject, sameProject, CAPABILITIES,
  REMOTE_UNSUPPORTED, refusal, refusalError, assertLocalPaths,
} = require('../../src/shared/remote-capabilities');

const LOCALES = ['en', 'fr', 'es', 'id', 'zh-CN', 'pt-BR'];
const DASHES = /[\u2013\u2014]/;
const lookup = (obj, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

/**
 * The rows of design/remote-ssh.md section 8: each row's feature text and the
 * capability keys its Capability column names.
 */
function designSection8Rows() {
  const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'design', 'remote-ssh.md'), 'utf8').replace(/\r\n/g, '\n');
  const start = doc.indexOf('## 8. Disabled for remote projects');
  const end = doc.indexOf('\n## 9.', start);
  expect(start).toBeGreaterThan(-1);
  return doc.slice(start, end).split('\n')
    .filter(line => line.startsWith('| ') && !line.startsWith('| Feature'))
    .map((line) => {
      const cells = line.split(' | ');
      return {
        feature: cells[0].replace(/^\| /, ''),
        keys: [...cells[1].matchAll(/`([A-Za-z]+)`/g)].map(m => m[1]),
      };
    });
}

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
    for (const row of Object.values(CAPABILITIES)) expect(Object.isFrozen(row)).toBe(true);
  });

  test('every shipped row has a reason translated in all six locales', () => {
    const rows = Object.entries(CAPABILITIES);
    expect(rows.length).toBeGreaterThan(0);
    for (const locale of LOCALES) {
      const strings = require(`../../src/renderer/i18n/locales/${locale}.json`);
      for (const [feature, row] of rows) {
        expect(row.remote).toBe(false);
        const text = lookup(strings, row.reasonKey);
        if (typeof text !== 'string' || !text) throw new Error(`${locale}: ${feature} -> ${row.reasonKey} is missing`);
        if (DASHES.test(text)) throw new Error(`${locale}: ${feature} -> ${row.reasonKey} has an en or em dash`);
      }
      expect(lookup(strings, 'ssh.workflow.remoteOption')).toContain('{name}');
    }
  });

  test('every row of design section 8 names capability rows, and every row is in that table', () => {
    const rows = designSection8Rows();
    expect(rows.length).toBeGreaterThanOrEqual(16);
    const named = new Set();
    for (const row of rows) {
      if (!row.keys.length) throw new Error(`design section 8 row without a capability: ${row.feature}`);
      for (const key of row.keys) {
        if (!CAPABILITIES[key]) throw new Error(`design section 8 names an unknown capability: ${key}`);
        named.add(key);
      }
    }
    for (const key of Object.keys(CAPABILITIES)) {
      if (!named.has(key)) throw new Error(`capability ${key} is missing from design section 8`);
    }
  });

  test('every row carries an English message for the main process', () => {
    for (const [feature, row] of Object.entries(CAPABILITIES)) {
      expect(typeof row.message).toBe('string');
      expect(row.message.length).toBeGreaterThan(10);
      if (DASHES.test(row.message)) throw new Error(`${feature}: en or em dash in its message`);
    }
  });

  test('refusal() and refusalError() carry the code, the feature and the reason key', () => {
    expect(refusal('workflowNodes')).toEqual({
      code: REMOTE_UNSUPPORTED,
      feature: 'workflowNodes',
      reasonKey: 'ssh.disabled.workflowNodes',
      message: 'Remote projects are not supported by workflow nodes yet',
    });
    const err = refusalError('parallelTasks');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(CAPABILITIES.parallelTasks.message);
    expect(err.code).toBe('REMOTE_UNSUPPORTED');
    expect(err.feature).toBe('parallelTasks');
    expect(err.reasonKey).toBe('ssh.disabled.parallelTasks');
    expect(() => refusal('noSuchFeature')).toThrow(/Unknown remote capability/);
  });

  test('assertLocalPaths() refuses a URI and lets anything else through', () => {
    expect(() => assertLocalPaths('workflowNodes', 'C:\\code\\app', '/home/u/app', '', null, undefined, 42)).not.toThrow();
    expect(() => assertLocalPaths('workflowNodes', '/home/u/app', 'ssh-remote://abcd1234/srv/app'))
      .toThrow('Remote projects are not supported by workflow nodes yet');
  });

  test('the local-only features of section 8 refuse a remote project and leave a local one alone', () => {
    for (const feature of ['typeDashboards', 'parallelTasks', 'workflowNodes', 'workflowTriggers', 'localMcpTools', 'hooks',
      'localMentions', 'overviewAutoExpand', 'projectMcpConfig', 'databaseDetect', 'mcpProjectTools']) {
      expect(can(remote, feature).ok).toBe(false);
      expect(can(local, feature)).toEqual({ ok: true });
    }
    // The chat header note and the row share one reason.
    expect(can(remote, 'localMcpTools').reasonKey).toBe('ssh.chat.localToolsTooltip');
  });

  test('the project-level actions refuse a remote project and leave a local one alone', () => {
    for (const feature of ['openInExplorer', 'openInEditor', 'accountBinding', 'cloudUpload', 'sessionMove', 'pathAttachment']) {
      expect(can(remote, feature).ok).toBe(false);
      expect(can(local, feature)).toEqual({ ok: true });
    }
  });

  test('the session move refusal keeps the message main already returned', () => {
    expect(CAPABILITIES.sessionMove.message)
      .toBe('Sessions of remote projects cannot be moved: their transcripts live on the remote host');
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
