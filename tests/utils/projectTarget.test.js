/**
 * @jest-environment node
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTargetResolver, readProjectsFile } = require('../../src/main/utils/projectTarget');

const PROFILE = { id: 'abcd1234', host: 'build.example.com', user: 'yanis', port: 22 };

const PROJECTS = [
  { id: 'p_local', name: 'local', type: 'general', path: 'C:\\code\\local' },
  { id: 'p_api', name: 'api', type: 'general', path: 'ssh-remote://abcd1234/home/yanis/api', remote: { profileId: 'abcd1234', path: '/home/yanis/api' } },
  { id: 'p_nested', name: 'nested', type: 'general', path: 'ssh-remote://abcd1234/home/yanis/api/packages/core', remote: { profileId: 'abcd1234', path: '/home/yanis/api/packages/core' } },
  { id: 'p_other', name: 'other', type: 'general', path: 'ssh-remote://zzzz9999/srv/app', remote: { profileId: 'zzzz9999', path: '/srv/app' } },
];

function resolver({ profiles = [PROFILE], projects = PROJECTS } = {}) {
  return createTargetResolver({
    getProfile: async (id) => profiles.find((p) => p.id === id) || null,
    loadProjects: async () => projects,
  });
}

describe('projectTarget.resolveTarget', () => {
  test.each([
    'C:\\code\\local',
    '/home/yanis/api',
    'relative/path',
    '',
  ])('a local path %j comes back unchanged as kind local', async (p) => {
    expect(await resolver().resolveTarget(p)).toEqual({ kind: 'local', path: p });
  });

  test('a URI inside a registered remote project resolves to its host', async () => {
    const t = await resolver().resolveTarget('ssh-remote://abcd1234/home/yanis/api/src/index.js');
    expect(t).toMatchObject({
      kind: 'remote',
      profileId: 'abcd1234',
      remotePath: '/home/yanis/api/src/index.js',
      projectRoot: '/home/yanis/api',
      host: 'yanis@build.example.com',
    });
    expect(t.project.id).toBe('p_api');
    expect(t.profile).toBe(PROFILE);
  });

  test('the most specific registered project wins', async () => {
    const t = await resolver().resolveTarget('ssh-remote://abcd1234/home/yanis/api/packages/core/x');
    expect(t.project.id).toBe('p_nested');
  });

  test('a URI with an unknown profile is refused', async () => {
    await expect(resolver({ profiles: [] }).resolveTarget('ssh-remote://abcd1234/home/yanis/api'))
      .rejects.toMatchObject({ code: 'REMOTE_PROFILE_UNKNOWN' });
  });

  test('a URI outside every registered project is refused', async () => {
    const r = resolver();
    await expect(r.resolveTarget('ssh-remote://abcd1234/etc/passwd')).rejects.toMatchObject({ code: 'REMOTE_PATH_NOT_IN_PROJECT' });
    await expect(r.resolveTarget('ssh-remote://abcd1234/home/yanis/api2')).rejects.toMatchObject({ code: 'REMOTE_PATH_NOT_IN_PROJECT' });
    await expect(r.resolveTarget('ssh-remote://abcd1234/home/yanis')).rejects.toMatchObject({ code: 'REMOTE_PATH_NOT_IN_PROJECT' });
  });

  test("another profile's project does not authorise this profile", async () => {
    const r = resolver({ profiles: [PROFILE, { id: 'zzzz9999', host: 'other' }] });
    await expect(r.resolveTarget('ssh-remote://abcd1234/srv/app')).rejects.toMatchObject({ code: 'REMOTE_PATH_NOT_IN_PROJECT' });
    expect((await r.resolveTarget('ssh-remote://zzzz9999/srv/app/x')).project.id).toBe('p_other');
  });

  test('a project whose remote block names another profile is not trusted', async () => {
    const projects = [{ id: 'p_x', path: 'ssh-remote://abcd1234/home/yanis/api', remote: { profileId: 'zzzz9999' } }];
    await expect(resolver({ projects }).resolveTarget('ssh-remote://abcd1234/home/yanis/api')).rejects.toMatchObject({ code: 'REMOTE_PATH_NOT_IN_PROJECT' });
  });

  test("'..' escaping the root and control characters are refused", async () => {
    await expect(resolver().resolveTarget('ssh-remote://abcd1234/../../etc')).rejects.toMatchObject({ code: 'REMOTE_PATH_ESCAPE' });
    await expect(resolver().resolveTarget('ssh-remote://abcd1234/home/yanis/api/a\nb')).rejects.toThrow(/control/);
  });

  test('a ".." that stays inside is normalised before the containment check', async () => {
    const t = await resolver().resolveTarget('ssh-remote://abcd1234/home/yanis/api/src/../lib');
    expect(t.remotePath).toBe('/home/yanis/api/lib');
    await expect(resolver().resolveTarget('ssh-remote://abcd1234/home/yanis/api/../secrets')).rejects.toMatchObject({ code: 'REMOTE_PATH_NOT_IN_PROJECT' });
  });
});

describe('projectTarget.resolveBrowseTarget and resolveProjectTarget', () => {
  test('browse needs a known profile and an absolute path, but no project', async () => {
    const r = resolver();
    expect(await r.resolveBrowseTarget('abcd1234', '/etc/../srv')).toMatchObject({ kind: 'remote', browse: true, remotePath: '/srv' });
    expect(await r.resolveBrowseTarget('abcd1234', '')).toMatchObject({ remotePath: null });
    await expect(r.resolveBrowseTarget('abcd1234', 'relative')).rejects.toMatchObject({ code: 'REMOTE_PATH_INVALID' });
    await expect(r.resolveBrowseTarget('nope', '/srv')).rejects.toMatchObject({ code: 'REMOTE_PROFILE_UNKNOWN' });
    await expect(resolver({ profiles: [] }).resolveBrowseTarget('abcd1234', '/srv')).rejects.toMatchObject({ code: 'REMOTE_PROFILE_UNKNOWN' });
  });

  test('a project id resolves to local or remote', async () => {
    const r = resolver();
    expect(await r.resolveProjectTarget('p_local')).toMatchObject({ kind: 'local', path: 'C:\\code\\local' });
    expect(await r.resolveProjectTarget('p_api')).toMatchObject({ kind: 'remote', remotePath: '/home/yanis/api' });
    await expect(r.resolveProjectTarget('p_missing')).rejects.toMatchObject({ code: 'PROJECT_UNKNOWN' });
  });
});

describe('readProjectsFile', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-pt-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('absent is an empty list, both file shapes are read', async () => {
    expect(await readProjectsFile(path.join(dir, 'missing.json'))).toEqual([]);
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ projects: [{ id: 'x' }] }));
    expect(await readProjectsFile(path.join(dir, 'a.json'))).toEqual([{ id: 'x' }]);
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify([{ id: 'y' }]));
    expect(await readProjectsFile(path.join(dir, 'b.json'))).toEqual([{ id: 'y' }]);
  });

  test('an unparseable projects.json refuses instead of reading as empty', async () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{"projects": [');
    await expect(readProjectsFile(path.join(dir, 'bad.json'))).rejects.toMatchObject({ code: 'PROJECTS_UNREADABLE' });
  });
});
