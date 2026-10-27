/**
 * Which `claude` a terminal tab runs, and the installer the setup wizard starts.
 *
 * Terminal tabs used to run a bare `claude` and nothing else, so on a machine
 * where Claude Code was never installed every Claude terminal tab died on
 * "'claude' is not recognized", while the chat, which runs the SDK's binary,
 * worked. The order below is what keeps both cases right: the user's own CLI
 * by name whenever the shell can find it, unchanged from before.
 */

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
}));

const mockSdk = { path: null };
jest.mock('../../src/main/utils/sdkCli', () => ({
  getSdkCliPath: () => mockSdk.path,
  getSdkCliVersion: () => null,
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const claudeCode = require('../../src/main/utils/claudeCode');

const isWin = process.platform === 'win32';
const binName = isWin ? 'claude.exe' : 'claude';

let tmp;
let savedPath;
let savedAppData;

function makeBinary(dir, name = binName) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, isWin ? '' : '#!/bin/sh\necho "2.1.300 (Claude Code)"\n');
  if (!isWin) fs.chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-claude-code-'));
  savedPath = process.env.PATH;
  savedAppData = process.env.APPDATA;
  // Nothing of the machine's own: an empty PATH, a home with nothing in it.
  process.env.PATH = path.join(tmp, 'empty-path');
  process.env.APPDATA = path.join(tmp, 'appdata');
  jest.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
  mockSdk.path = null;
  claudeCode.invalidate();
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = savedAppData;
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('resolveTerminalClaude', () => {
  test('a claude on the PATH is launched by name, as before', () => {
    const bin = path.join(tmp, 'bin');
    makeBinary(bin);
    process.env.PATH = bin;
    mockSdk.path = path.join(tmp, 'sdk', binName);
    expect(claudeCode.resolveTerminalClaude()).toEqual({ source: 'path', file: null, env: null });
  });

  test('an install the PATH does not reach yet is launched by its path', () => {
    const file = makeBinary(path.join(tmp, 'home', '.local', 'bin'));
    mockSdk.path = path.join(tmp, 'sdk', binName);
    expect(claudeCode.resolveTerminalClaude()).toEqual({ source: 'install', file, env: null });
  });

  test('with nothing installed, the SDK binary runs with its updater off', () => {
    mockSdk.path = path.join(tmp, 'sdk', binName);
    expect(claudeCode.resolveTerminalClaude()).toEqual({
      source: 'bundled',
      file: mockSdk.path,
      env: { DISABLE_AUTOUPDATER: '1' },
    });
  });

  test('with nothing at all, it is still claude by name, and the shell says why', () => {
    expect(claudeCode.resolveTerminalClaude()).toEqual({ source: 'missing', file: null, env: null });
  });

  test('a directory named claude is not a binary', () => {
    fs.mkdirSync(path.join(tmp, 'bin', binName), { recursive: true });
    process.env.PATH = path.join(tmp, 'bin');
    expect(claudeCode.findOnPath()).toBeNull();
  });

  (isWin ? test : test.skip)('the npm shim counts on Windows', () => {
    const file = makeBinary(path.join(tmp, 'appdata', 'npm'), 'claude.cmd');
    expect(claudeCode.findInstalled()).toEqual({ file, onPath: false });
  });
});

describe('getStatus', () => {
  test('says not installed, without throwing, on an empty machine', async () => {
    const status = await claudeCode.getStatus();
    expect(status).toEqual({ installed: false, path: null, onPath: false, version: null, bundledVersion: null });
  });

  (isWin ? test.skip : test)('reads the version the binary prints', async () => {
    const bin = path.join(tmp, 'bin');
    const file = makeBinary(bin);
    process.env.PATH = bin;
    const status = await claudeCode.getStatus();
    expect(status).toMatchObject({ installed: true, path: file, onPath: true, version: '2.1.300' });
  });
});

describe('installerCommand', () => {
  test('is the official installer from claude.ai and nothing else', () => {
    const { file, args } = claudeCode.installerCommand();
    const line = args.join(' ');
    if (isWin) {
      expect(file).toBe('powershell.exe');
      expect(line).toContain('irm https://claude.ai/install.ps1 | iex');
    } else {
      expect(file).toBe('/bin/bash');
      expect(line).toContain('curl -fsSL https://claude.ai/install.sh | bash');
      // A failed download must fail the install, not pipe nothing into bash.
      expect(line).toContain('pipefail');
    }
  });
});

describe('exposeOnPath', () => {
  test('puts the binary directory first, once', () => {
    const file = path.join(tmp, 'home', '.local', 'bin', binName);
    claudeCode.exposeOnPath(file);
    claudeCode.exposeOnPath(file);
    const entries = process.env.PATH.split(path.delimiter);
    expect(entries[0]).toBe(path.dirname(file));
    expect(entries.filter(e => e === path.dirname(file))).toHaveLength(1);
  });
});
