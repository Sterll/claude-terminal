/**
 * @jest-environment node
 *
 * Remote (SSH) terminal tabs in the main process (design/remote-ssh.md 5.1).
 *
 * A remote tab is node-pty running the system ssh: `-tt`, the profile's
 * flags, the keepalives, `--`, the destination and exactly one remote command
 * element. What has to hold, and what this pins:
 *
 * - the remote command is built with q(), so a directory holding `'`, `\`,
 *   `$` and spaces reaches `cd` intact through the user's login shell and
 *   /bin/sh (run for real through a local sh here);
 * - the `--resume` id check of a local tab applies to a remote one too;
 * - ssh's own failure (exit 255) is a lost connection, not an exit: the tab
 *   is told `terminal-disconnected`, no `terminal_exit_code` workflow fires,
 *   and respawn() brings it back under the same id;
 * - the local path is byte-identical to what it was: same program, argv, cwd
 *   fallback and environment.
 */

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
}), { virtual: true });

jest.mock('../../src/main/services/TerminalOutputCapture', () => ({ record: jest.fn(), flush: jest.fn() }));
jest.mock('../../src/main/services/RemoteControlService', () => ({ launchesTerminalsConnected: () => false }));

const spawned = [];

jest.mock('node-pty', () => ({
  spawn: jest.fn((file, args, options) => {
    const dataListeners = [];
    const exitListeners = [];
    const pty = {
      pid: 4321,
      file,
      args,
      options,
      on: jest.fn(),
      onData: jest.fn((cb) => { dataListeners.push(cb); return { dispose() {} }; }),
      onExit: jest.fn((cb) => { exitListeners.push(cb); return { dispose() {} }; }),
      write: jest.fn(),
      resize: jest.fn(),
      kill: jest.fn(),
      emitData(text) { for (const cb of dataListeners) cb(text); },
      emitExit(exitCode, signal = null) { for (const cb of exitListeners) cb({ exitCode, signal }); },
    };
    spawned.push(pty);
    return pty;
  }),
}));

const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const pty = require('node-pty');
const terminalService = require('../../src/main/services/TerminalService');
const { findSh } = require('../helpers/fake-ssh');

const PROFILE = {
  id: 'abcd1234',
  host: 'build.example.com',
  user: 'yanis',
  port: 2222,
  identityFile: process.platform === 'win32' ? 'C:\\keys\\id_ed25519' : '/keys/id_ed25519',
  proxyJump: 'bastion.example.com',
  forwardAgent: true,
  tmuxSessions: false,
  remoteClaudePath: null,
};

const URI = 'ssh-remote://abcd1234/home/yanis/api';
/** What a shell tab becomes on the host. Split so it is not read as a template placeholder. */
const LOGIN = 'exec "$' + '{SHELL:-/bin/sh}" -l';

function remoteContext(overrides = {}) {
  return {
    profileId: 'abcd1234',
    profile: PROFILE,
    command: '/usr/bin/ssh',
    prefixArgs: [],
    env: null,
    capabilities: null,
    controlDir: null,
    platform: 'win32',
    remotePath: '/home/yanis/api',
    uri: URI,
    sessionKey: 'tab_r1_1',
    ...overrides,
  };
}

function createRemote(options = {}, contextOverrides = {}) {
  return terminalService.create({
    cwd: URI,
    projectId: 'r1',
    projectPath: URI,
    runClaude: false,
    ...options,
    remote: remoteContext(contextOverrides),
  });
}

const last = () => spawned[spawned.length - 1];
/** The one remote command element: everything after `--` and the destination. */
const remoteCommandOf = (args) => args.slice(args.indexOf('--') + 2);

let sent;

beforeEach(() => {
  spawned.length = 0;
  pty.spawn.mockClear();
  sent = [];
  terminalService.setMainWindow({
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  });
  terminalService.onExitCallback = jest.fn();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  terminalService.terminals.clear();
  terminalService.disconnected.clear();
  terminalService.onExitCallback = null;
  terminalService.setMainWindow(null);
  jest.restoreAllMocks();
});

describe('remote create', () => {
  test('spawns the ssh binary with -tt, the profile flags, keepalives, --, the destination and one remote command', () => {
    const res = createRemote();
    expect(res.success).toBe(true);
    const { file, args } = last();
    expect(file).toBe('/usr/bin/ssh');
    expect(args[0]).toBe('-tt');
    expect(args).toEqual(expect.arrayContaining(['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3']));
    expect(args.join(' ')).toContain('-p 2222');
    expect(args.join(' ')).toContain('-l yanis');
    expect(args.join(' ')).toContain(`-i ${PROFILE.identityFile}`);
    expect(args.join(' ')).toContain('-J bastion.example.com');
    expect(args).toContain('-A');
    // A PTY may prompt (password, host key): no BatchMode, and never a relaxed host key check.
    expect(args).not.toContain('BatchMode=yes');
    expect(args.join(' ')).not.toMatch(/StrictHostKeyChecking/);
    const dashdash = args.indexOf('--');
    expect(args[dashdash + 1]).toBe('build.example.com');
    const remote = remoteCommandOf(args);
    expect(remote).toHaveLength(1);
    expect(remote[0].startsWith('/bin/sh -c ')).toBe(true);
    expect(remote[0]).toContain(LOGIN);
  });

  test('carries ControlMaster on a POSIX client only', () => {
    createRemote({}, { platform: 'linux', controlDir: '/home/me/.claude-terminal/ssh' });
    expect(last().args.join(' ')).toContain('ControlMaster=auto');
    createRemote({}, { platform: 'win32', controlDir: '/home/me/.claude-terminal/ssh' });
    expect(last().args.join(' ')).not.toContain('ControlMaster');
  });

  test('never looks at the local filesystem and never applies an account overlay', () => {
    const exists = jest.spyOn(fs, 'existsSync');
    const stat = jest.spyOn(fs, 'statSync');
    createRemote({ accountEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/acc' } });
    expect(exists).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    const { options } = last();
    expect(options.cwd).toBe(os.homedir());
    expect(options.env).toBe(process.env);
    expect(options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
  });

  test('a Claude tab runs the CLI through the login shell, with the same --resume check as a local tab', () => {
    createRemote({ runClaude: true, skipPermissions: true, resumeSessionId: '0f1e2d3c-aaaa-bbbb-cccc-1234567890ab' });
    let element = remoteCommandOf(last().args)[0];
    expect(element).toContain('-l -c');
    expect(element).toContain('--resume');
    expect(element).toContain('0f1e2d3c-aaaa-bbbb-cccc-1234567890ab');
    expect(element).toContain('--dangerously-skip-permissions');

    createRemote({ runClaude: true, resumeSessionId: 'abc; rm -rf ~' });
    element = remoteCommandOf(last().args)[0];
    expect(element).not.toContain('--resume');
    expect(element).not.toContain('rm -rf');
  });

  test('a profile can name the remote claude binary', () => {
    createRemote({ runClaude: true }, { profile: { ...PROFILE, remoteClaudePath: '/opt/claude/bin/claude' } });
    expect(remoteCommandOf(last().args)[0]).toContain('/opt/claude/bin/claude');
  });

  test('tags the PTY with its project, like a local one', () => {
    createRemote();
    expect(last().options.name).toBe('xterm-256color');
    const id = [...terminalService.terminals.keys()].pop();
    expect(terminalService.terminals.get(id)._meta).toMatchObject({ projectId: 'r1', projectPath: URI });
  });

  test('an incomplete context is refused without spawning', () => {
    const res = terminalService.create({ cwd: URI, remote: { profile: PROFILE } });
    expect(res.success).toBe(false);
    expect(pty.spawn).not.toHaveBeenCalled();
  });

  const SH = findSh();
  (SH ? test : test.skip)('a cwd with quotes, backslashes, $ and spaces reaches cd intact through sh', () => {
    const dir = `/home/u/it's a \\ "$HOME" $(id) \`x\` dir`;
    createRemote({}, { remotePath: dir });
    const element = remoteCommandOf(last().args)[0];
    // sshd hands the remote command to the login shell as one string; feed it
    // to a real sh the same way, with `cd` swapped for a printf of its operand
    // and the login shell for a no-op.
    const probe = element.replace('cd -- ', 'printf %s ').replace(LOGIN, ':');
    expect(probe).not.toContain('cd -- ');
    expect(probe).not.toContain('SHELL');
    const r = spawnSync(SH, ['-s'], { input: `exec ${probe}\n`, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(dir);
  });
});

describe('the local path is unchanged', () => {
  const existing = os.tmpdir();
  const missing = `${existing}${process.platform === 'win32' ? '\\' : '/'}ct-does-not-exist-${Date.now()}`;

  test.each([
    ['an existing cwd', { cwd: existing }, existing],
    ['a missing cwd falls back to home', { cwd: missing }, os.homedir()],
    ['no cwd', { cwd: null }, os.homedir()],
  ])('%s', (_label, params, expectedCwd) => {
    terminalService.create({ ...params, runClaude: false });
    const [file, args, options] = pty.spawn.mock.calls[pty.spawn.mock.calls.length - 1];
    expect({ file, args, options }).toEqual({
      file: process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'),
      args: process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : [],
      options: { name: 'xterm-256color', cols: 120, rows: 30, cwd: expectedCwd, env: process.env },
    });
    expect(options.env).toBe(process.env);
  });

  test('an account overlay is merged over the environment, as before', () => {
    terminalService.create({ cwd: existing, runClaude: false, accountEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/acc' } });
    const options = pty.spawn.mock.calls[pty.spawn.mock.calls.length - 1][2];
    expect(options.env).toEqual({ ...process.env, CLAUDE_SECURESTORAGE_CONFIG_DIR: '/acc' });
  });

  (process.platform === 'win32' ? test : test.skip)('a Claude tab on Windows is cmd.exe /c claude with the same flags', () => {
    terminalService.create({ cwd: existing, runClaude: true, skipPermissions: true, resumeSessionId: '0f1e2d3c-aaaa' });
    const [file, args] = pty.spawn.mock.calls[pty.spawn.mock.calls.length - 1];
    expect(file).toBe('cmd.exe');
    expect(args).toEqual(['/c', 'claude', '--resume', '0f1e2d3c-aaaa', '--dangerously-skip-permissions']);
  });

  test('a local exit is still terminal-exit with its code, and fires the workflow callback', () => {
    const { id } = terminalService.create({ cwd: existing, runClaude: false, projectId: 'p1' });
    last().emitExit(255);
    expect(sent.find(m => m.channel === 'terminal-exit')).toEqual({ channel: 'terminal-exit', payload: { id, exitCode: 255, signal: null } });
    expect(sent.some(m => m.channel === 'terminal-disconnected')).toBe(false);
    expect(terminalService.onExitCallback).toHaveBeenCalledWith(expect.objectContaining({ terminalId: id, exitCode: 255 }));
  });
});

describe('remote exit and reconnect', () => {
  test('exit 255 is a lost connection: terminal-disconnected, no terminal-exit, no workflow trigger', () => {
    const { id } = createRemote();
    last().emitData('client_loop: send disconnect: Connection reset\r\n');
    last().emitExit(255);
    expect(sent.some(m => m.channel === 'terminal-exit')).toBe(false);
    const msg = sent.find(m => m.channel === 'terminal-disconnected');
    expect(msg.payload).toEqual({ id, exitCode: 255, kind: 'network', profileId: 'abcd1234' });
    expect(terminalService.onExitCallback).not.toHaveBeenCalled();
    expect(terminalService.has(id)).toBe(false);
    expect(terminalService.remoteContext(id)).toMatchObject({ remotePath: '/home/yanis/api' });
  });

  test('the failure kind comes from what ssh printed', () => {
    createRemote();
    last().emitData('yanis@build.example.com: Permission denied (publickey,password).\r\n');
    last().emitExit(255);
    expect(sent.find(m => m.channel === 'terminal-disconnected').payload.kind).toBe('auth');
  });

  test('a normal exit still emits terminal-exit with its code and fires the workflow trigger', () => {
    const { id } = createRemote();
    last().emitExit(1);
    expect(sent.find(m => m.channel === 'terminal-exit').payload).toEqual({ id, exitCode: 1, signal: null });
    expect(sent.some(m => m.channel === 'terminal-disconnected')).toBe(false);
    expect(terminalService.onExitCallback).toHaveBeenCalledWith(expect.objectContaining({ terminalId: id, exitCode: 1, projectId: 'r1' }));
    expect(terminalService.remoteContext(id)).toBeNull();
  });

  test('a Claude tab respawns under the same id with --resume <claudeSessionId>', () => {
    const { id } = createRemote({ runClaude: true });
    expect(remoteCommandOf(last().args)[0]).not.toContain('--resume');
    last().emitExit(255);

    const res = terminalService.respawn(id, { remote: remoteContext(), resumeSessionId: 'aaaabbbb-1111-2222-3333-444455556666' });
    expect(res).toEqual({ success: true, id });
    expect(terminalService.has(id)).toBe(true);
    expect(remoteCommandOf(last().args)[0]).toContain('--resume');
    expect(remoteCommandOf(last().args)[0]).toContain('aaaabbbb-1111-2222-3333-444455556666');
  });

  test('a respawn without a session id keeps the one the tab started with', () => {
    const { id } = createRemote({ runClaude: true, resumeSessionId: '0f1e2d3c-aaaa' });
    last().emitExit(255);
    terminalService.respawn(id, { remote: remoteContext(), resumeSessionId: 'not a session; id' });
    expect(remoteCommandOf(last().args)[0]).toContain('0f1e2d3c-aaaa');
    expect(remoteCommandOf(last().args)[0]).not.toContain('not a session');
  });

  test('a shell tab respawns in the same directory, at the size it last had', () => {
    const { id } = createRemote({}, { remotePath: '/srv/app/sub dir' });
    terminalService.resize(id, 200, 50);
    last().emitExit(255);
    // The fresh launch context cannot move the tab somewhere else.
    terminalService.respawn(id, { remote: remoteContext({ remotePath: '/etc' }) });
    const element = remoteCommandOf(last().args)[0];
    expect(element).toContain('/srv/app/sub dir');
    expect(element).not.toContain('/etc');
    expect(last().options).toMatchObject({ cols: 200, rows: 50 });
  });

  test('with tmuxSessions the shell attaches to tmux new-session -A -s ct-<key>', () => {
    const { id } = createRemote({}, { profile: { ...PROFILE, tmuxSessions: true }, sessionKey: 'tab_r1_42' });
    let element = remoteCommandOf(last().args)[0];
    expect(element).toContain('tmux new-session -A -s ct-tab_r1_42');
    expect(terminalService.remoteContext(id).tmuxSession).toBe('ct-tab_r1_42');

    last().emitExit(255);
    terminalService.respawn(id, { remote: remoteContext({ profile: { ...PROFILE, tmuxSessions: true }, sessionKey: 'other' }) });
    element = remoteCommandOf(last().args)[0];
    expect(element).toContain('tmux new-session -A -s ct-tab_r1_42');
  });

  test('tmux is left out when the host is known not to have it, and for Claude tabs', () => {
    createRemote({}, { profile: { ...PROFILE, tmuxSessions: true }, capabilities: { tools: ['git'], path: '/usr/bin' } });
    expect(remoteCommandOf(last().args)[0]).not.toContain('tmux');
    createRemote({ runClaude: true }, { profile: { ...PROFILE, tmuxSessions: true } });
    expect(remoteCommandOf(last().args)[0]).not.toContain('tmux');
  });

  test('an invalid session key is replaced rather than passed on', () => {
    createRemote({}, { profile: { ...PROFILE, tmuxSessions: true }, sessionKey: 'x; reboot' });
    expect(remoteCommandOf(last().args)[0]).not.toContain('reboot');
    expect(remoteCommandOf(last().args)[0]).toMatch(/tmux new-session -A -s ct-[A-Za-z0-9_-]+/);
  });

  test('respawn refuses a terminal that is not waiting to reconnect', () => {
    const { id } = createRemote();
    expect(terminalService.respawn(id, { remote: remoteContext() }).success).toBe(false);
    expect(terminalService.respawn(9999, { remote: remoteContext() }).success).toBe(false);
  });

  test('closing a disconnected tab drops it and says so', () => {
    const { id } = createRemote();
    last().emitExit(255);
    sent.length = 0;
    terminalService.kill(id);
    expect(sent).toEqual([{ channel: 'terminal-exit', payload: { id } }]);
    expect(terminalService.remoteContext(id)).toBeNull();
    expect(terminalService.respawn(id, { remote: remoteContext() }).success).toBe(false);
  });
});
