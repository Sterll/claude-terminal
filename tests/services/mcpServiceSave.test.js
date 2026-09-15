// McpService.saveMcps — what it is allowed to remove from ~/.claude.json.
//
// That file belongs to the Claude CLI, not to this app: it carries the
// projects map, oauthAccount, per-project mcpServers and history alongside the
// global mcpServers the panel edits. saveMcps used to rebuild mcpServers from
// scratch on every save, so anything that appeared between loadMcps() and the
// save — `claude mcp add`, a cloud pull, another window — was dropped.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-mcp-save-'));
const mockClaudeConfigFile = path.join(tmpDir, '.claude.json');
const mockLegacyMcpsFile = path.join(tmpDir, 'mcps.json');
const mockHandlers = new Map();
jest.mock('electron', () => ({ ipcMain: { handle: (name, handler) => mockHandlers.set(name, handler) } }), { virtual: true });
jest.mock('../../src/main/services/McpService', () => ({}));
jest.mock('../../src/main/services/TelemetryService', () => ({ sendFeaturePing: jest.fn() }));

jest.mock('../../src/renderer/utils/paths', () => ({
  claudeConfigFile: mockClaudeConfigFile,
  legacyMcpsFile: mockLegacyMcpsFile,
}));

const { McpService } = require('../../src/renderer/services/McpService');
const { ApiProvider } = require('../../src/renderer/core/ApiProvider');
require('../../src/main/ipc/mcp.ipc').registerMcpHandlers();

function makeService() {
  const api = new ApiProvider(
    { mcp: { saveConfig: (...args) => mockHandlers.get('mcp-save-config')({}, ...args) } },
    { fs: { promises: fs.promises }, path, os, process }
  );
  return new McpService(api);
}

function writeConfig(config) {
  fs.writeFileSync(mockClaudeConfigFile, JSON.stringify(config, null, 2), 'utf8');
}

function readConfig() {
  return JSON.parse(fs.readFileSync(mockClaudeConfigFile, 'utf8'));
}

beforeEach(() => {
  jest.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  for (const name of fs.readdirSync(tmpDir)) {
    fs.rmSync(path.join(tmpDir, name), { recursive: true, force: true });
  }
});
afterEach(() => jest.restoreAllMocks());

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('saveMcps', () => {
  test('keeps unrelated top-level keys', async () => {
    writeConfig({
      oauthAccount: { emailAddress: 'someone@example.com' },
      projects: { '/some/path': { mcpServers: { local: { command: 'x' } } } },
      mcpServers: {},
    });

    const service = makeService();
    await service.saveMcps([
      { id: 'mine', scope: 'global', type: 'stdio', command: 'node', args: [] },
    ]);

    const config = readConfig();
    expect(config.oauthAccount.emailAddress).toBe('someone@example.com');
    expect(config.projects['/some/path'].mcpServers.local.command).toBe('x');
    expect(config.mcpServers.mine).toBeDefined();
  });

  test('keeps a server this panel never loaded', async () => {
    writeConfig({ mcpServers: { mine: { type: 'stdio', command: 'node' } } });

    const service = makeService();
    await service.loadMcps();

    // Someone else adds a server after the panel loaded.
    const config = readConfig();
    config.mcpServers['added-elsewhere'] = { type: 'stdio', command: 'other' };
    writeConfig(config);

    await service.saveMcps([
      { id: 'mine', scope: 'global', type: 'stdio', command: 'node', args: [] },
    ]);

    expect(readConfig().mcpServers['added-elsewhere'].command).toBe('other');
  });

  test('removes a server the user deleted in the panel', async () => {
    writeConfig({
      mcpServers: {
        keep: { type: 'stdio', command: 'node' },
        drop: { type: 'stdio', command: 'node' },
      },
    });

    const service = makeService();
    await service.loadMcps();

    await service.saveMcps([
      { id: 'keep', scope: 'global', type: 'stdio', command: 'node', args: [] },
    ]);

    const config = readConfig();
    expect(config.mcpServers.keep).toBeDefined();
    expect(config.mcpServers.drop).toBeUndefined();
  });

  test('leaves an unparseable config untouched', async () => {
    fs.writeFileSync(mockClaudeConfigFile, '{not valid json!!!', 'utf8');

    const service = makeService();
    await service.saveMcps([
      { id: 'mine', scope: 'global', type: 'stdio', command: 'node', args: [] },
    ]);

    expect(fs.readFileSync(mockClaudeConfigFile, 'utf8')).toBe('{not valid json!!!');
  });

  test('project-scoped servers are not written to the global map', async () => {
    writeConfig({ mcpServers: {} });

    const service = makeService();
    await service.saveMcps([
      { id: 'global-one', scope: 'global', type: 'stdio', command: 'node', args: [] },
      { id: 'project-one', scope: 'project', projectPath: '/p', type: 'stdio', command: 'node' },
    ]);

    const config = readConfig();
    expect(config.mcpServers['global-one']).toBeDefined();
    expect(config.mcpServers['project-one']).toBeUndefined();
  });
});
