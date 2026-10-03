/**
 * @jest-environment node
 *
 * Main-side refusals for the local-only features of design/remote-ssh.md
 * section 8 that are reached over IPC: cloud upload (zip and git) and
 * database detection refuse an ssh-remote:// path with the capability's
 * English message and code before touching the disk, git or the network.
 * A local path takes the same route as before.
 */

const mockHandlers = new Map();
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, fn) => mockHandlers.set(channel, fn),
    on: (channel, fn) => mockHandlers.set(channel, fn),
  },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
}));

const mockZip = jest.fn(async () => undefined);
jest.mock('../../src/main/utils/zipProject', () => ({ zipProject: (...a) => mockZip(...a) }));
const mockExecGit = jest.fn(async () => 'https://github.com/u/r.git');
jest.mock('../../src/main/utils/git', () => ({ execGit: (...a) => mockExecGit(...a) }));
const mockToken = jest.fn(async () => 'token');
jest.mock('../../src/main/services/GitHubAuthService', () => ({ getTokenForGit: (...a) => mockToken(...a) }));
const mockFetchCloud = jest.fn();
jest.mock('../../src/main/ipc/cloud-shared', () => ({
  _getCloudConfig: () => ({ url: 'https://cloud.example', key: 'k' }),
  _fetchCloud: (...a) => mockFetchCloud(...a),
  FETCH_DOWNLOAD_TIMEOUT_MS: 1000,
}));
const mockDetect = jest.fn(async () => []);
jest.mock('../../src/main/services/DatabaseService', () => ({ detectDatabases: (...a) => mockDetect(...a) }));
jest.mock('../../src/main/utils/cancellableOperation', () => ({ handle: jest.fn() }));

const fs = require('fs');
const { registerCloudProjectsHandlers } = require('../../src/main/ipc/cloud-projects.ipc');
const { registerDatabaseHandlers } = require('../../src/main/ipc/database.ipc');

beforeAll(() => {
  registerCloudProjectsHandlers();
  registerDatabaseHandlers();
});
beforeEach(() => jest.clearAllMocks());

const invoke = (channel, ...args) => mockHandlers.get(channel)({ sender: {} }, ...args);
const URI = 'ssh-remote://abcd1234/home/yanis/api';
const UPLOAD_REFUSED = 'Cloud upload zips a local folder, so remote projects cannot be uploaded';

describe('cloud upload', () => {
  test('the zip upload refuses a remote project before any fs or zip call', async () => {
    const exists = jest.spyOn(fs, 'existsSync');
    const err = await invoke('cloud:upload-project', { projectId: 'r1', projectName: 'api', projectPath: URI }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(UPLOAD_REFUSED);
    expect(err.code).toBe('REMOTE_UNSUPPORTED');
    expect(exists).not.toHaveBeenCalledWith(URI);
    expect(mockZip).not.toHaveBeenCalled();
    exists.mockRestore();
  });

  test('the git upload refuses a remote project too, without fetching a token or asking git', async () => {
    await expect(invoke('cloud:upload-project-git', { projectId: 'r1', projectName: 'api', projectPath: URI }))
      .rejects.toThrow(UPLOAD_REFUSED);
    expect(mockToken).not.toHaveBeenCalled();
    expect(mockExecGit).not.toHaveBeenCalled();
    expect(mockFetchCloud).not.toHaveBeenCalled();
  });

  test('checking the git remote of a remote project asks nothing', async () => {
    await expect(invoke('cloud:check-git-remote', { projectPath: URI })).resolves.toEqual({ hasGitHub: false });
    expect(mockExecGit).not.toHaveBeenCalled();
  });

  test('a local path keeps its own route: the existsSync check, then git', async () => {
    await expect(invoke('cloud:upload-project', { projectId: 'l1', projectName: 'app', projectPath: '/definitely/not/here' }))
      .rejects.toThrow('Project directory not found: /definitely/not/here');
    await expect(invoke('cloud:check-git-remote', { projectPath: '/code/app' }))
      .resolves.toEqual({ hasGitHub: true, remoteUrl: 'https://github.com/u/r.git' });
    expect(mockExecGit).toHaveBeenCalledWith('/code/app', 'remote get-url origin');
  });
});

describe('database detection', () => {
  test('refuses a remote project with the reason, without scanning', async () => {
    await expect(invoke('database-detect', { projectPath: URI })).resolves.toEqual({
      success: false,
      error: 'Database detection reads local project files and is not available for remote projects',
      code: 'REMOTE_UNSUPPORTED',
      reasonKey: 'ssh.disabled.databaseDetect',
    });
    expect(mockDetect).not.toHaveBeenCalled();
  });

  test('a local project is scanned as before', async () => {
    await invoke('database-detect', { projectPath: '/code/app' });
    expect(mockDetect).toHaveBeenCalledWith('/code/app');
  });
});
