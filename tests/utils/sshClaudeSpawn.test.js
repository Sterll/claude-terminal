/**
 * @jest-environment node
 *
 * The spawn hook of remote chat sessions and the checks before it
 * (design/remote-ssh.md section 5.2).
 *
 * What matters most here is what reaches the remote command line: it is
 * visible to every user of the host through `ps`, so no local variable, no
 * token and no local path may ever be on it. The script is asserted as built,
 * and run for real through a local sh with a stand-in `claude`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const {
  ENV_ALLOWLIST,
  remoteEnvPairs,
  remoteClaudeArgs,
  buildRemoteChatScript,
  createRemoteSpawn,
  checkRemoteCli,
  describeSshFailure,
  classifyRemoteChatFailure,
  prepareRemoteChat,
  bundledCliVersion,
} = require('../../src/main/utils/sshClaudeSpawn');
const { shC } = require('../../src/shared/remote-shell');
const { findSh, toShPath } = require('../helpers/fake-ssh');

const FORBIDDEN = ['PATH', 'HOME', 'APPDATA', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];

/** The environment the SDK builds for its child: everything local, plus its own switches. */
const SDK_ENV = {
  PATH: 'C:\\Windows\\System32;C:\\Users\\yanis\\bin',
  HOME: 'C:\\Users\\yanis',
  APPDATA: 'C:\\Users\\yanis\\AppData\\Roaming',
  CLAUDE_CONFIG_DIR: 'C:\\Users\\yanis\\.claude',
  CLAUDE_SECURESTORAGE_CONFIG_DIR: 'C:\\Users\\yanis\\.claude-terminal\\accounts\\a1',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret',
  ANTHROPIC_API_KEY: 'sk-ant-api-secret',
  CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
  CLAUDE_AGENT_SDK_VERSION: '0.3.260',
};

const ARGS = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--model', 'claude-opus-5', '--resume=0f1e2d3c'];

describe('remote environment', () => {
  test('only the allowlist is forwarded, and it holds nothing credential-shaped or local', () => {
    const pairs = remoteEnvPairs(SDK_ENV);
    expect(pairs).toEqual([['CLAUDE_CODE_ENTRYPOINT', 'sdk-ts'], ['CLAUDE_AGENT_SDK_VERSION', '0.3.260']]);
    for (const name of FORBIDDEN) expect(ENV_ALLOWLIST).not.toContain(name);
  });

  test('a value with a control character is dropped rather than sent', () => {
    expect(remoteEnvPairs({ CLAUDE_CODE_ENTRYPOINT: 'a\nb' })).toEqual([]);
  });
});

describe('buildRemoteChatScript', () => {
  const script = buildRemoteChatScript({
    remotePath: '/home/yanis/my api',
    claude: '/home/yanis/.local/bin/claude',
    args: ARGS,
    env: SDK_ENV,
    loginPath: '/home/yanis/.local/bin:/usr/bin:/bin',
  });

  test('enters the project and execs env <allowlist> <claude> <args>', () => {
    expect(script).toContain("cd -- '/home/yanis/my api' && exec env CLAUDE_CODE_ENTRYPOINT='sdk-ts' CLAUDE_AGENT_SDK_VERSION='0.3.260' '/home/yanis/.local/bin/claude' '--output-format'");
    expect(script).toContain("'--resume=0f1e2d3c'");
    expect(script).not.toMatch(/[\r\n]/);
  });

  test('the env segment never carries a forbidden variable, and no secret is anywhere', () => {
    const envSegment = script.slice(script.indexOf('exec env '), script.indexOf("'/home/yanis/.local/bin/claude'"));
    for (const name of FORBIDDEN) expect(envSegment).not.toContain(`${name}=`);
    for (const name of FORBIDDEN.filter((n) => n !== 'PATH')) expect(script).not.toContain(`${name}=`);
    expect(script).not.toContain('sk-ant');
    expect(script).not.toContain('C:\\');
  });

  test('the only PATH is the login PATH the handshake captured on the host', () => {
    expect(script.startsWith("PATH='/home/yanis/.local/bin:/usr/bin:/bin'; export PATH; ")).toBe(true);
    expect(script.match(/PATH=/g)).toHaveLength(1);
  });

  test('an argument with a control character is refused, not mangled', () => {
    expect(() => buildRemoteChatScript({ remotePath: '/p', claude: 'claude', args: ['--append-system-prompt', 'a\nb'] }))
      .toThrow(/control character/);
  });

  test('the SDK argv keeps flags only', () => {
    expect(remoteClaudeArgs(['C:\\sdk\\cli.js', '--verbose', 'x'])).toEqual(['--verbose', 'x']);
    expect(remoteClaudeArgs(ARGS)).toEqual(ARGS);
    expect(remoteClaudeArgs(undefined)).toEqual([]);
  });
});

describe('createRemoteSpawn', () => {
  const LAUNCH = {
    command: '/usr/bin/ssh', prefixArgs: [], env: null, platform: 'linux', controlDir: null,
    profile: { id: 'abcd1234', host: 'build.example.com', user: 'yanis', port: 2222 },
  };

  function child() {
    const c = new EventEmitter();
    c.stdin = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    return c;
  }

  test('ignores options.command and options.cwd, spawns ssh -T with BatchMode and one remote command', () => {
    const spawnImpl = jest.fn(() => child());
    const hook = createRemoteSpawn({ launch: LAUNCH, remotePath: '/srv/app', claude: 'claude', spawnImpl, homedir: '/home/local' });
    hook({ command: 'C:\\app\\claude.exe', args: ARGS, cwd: 'C:\\Users\\yanis', env: SDK_ENV });
    const [command, args, opts] = spawnImpl.mock.calls[0];
    expect(command).toBe('/usr/bin/ssh');
    expect(args.slice(0, 3)).toEqual(['-T', '-o', 'BatchMode=yes']);
    expect(args).toEqual(expect.arrayContaining(['-p', '2222', '-l', 'yanis']));
    expect(args.slice(-3, -1)).toEqual(['--', 'build.example.com']);
    const expected = buildRemoteChatScript({ remotePath: '/srv/app', claude: 'claude', args: ARGS, env: SDK_ENV });
    expect(args[args.length - 1]).toBe(shC(expected));
    expect(args.join(' ')).not.toContain('claude.exe');
    expect(opts.cwd).toBe('/home/local');
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  test("pipes the child's stderr to the session sink", () => {
    const c = child();
    const seen = [];
    const hook = createRemoteSpawn({ launch: LAUNCH, remotePath: '/srv/app', claude: 'claude', spawnImpl: () => c, onStderr: (t) => seen.push(t) });
    expect(hook({ args: ARGS, env: {} })).toBe(c);
    c.stderr.emit('data', Buffer.from('ssh: connect to host build.example.com port 2222: Connection refused\n'));
    expect(seen.join('')).toContain('Connection refused');
  });

  test('forwards the SDK abort signal to the spawn', () => {
    const spawnImpl = jest.fn(() => child());
    const ac = new AbortController();
    createRemoteSpawn({ launch: LAUNCH, remotePath: '/srv/app', claude: 'claude', spawnImpl })({ args: ARGS, env: {}, signal: ac.signal });
    expect(spawnImpl.mock.calls[0][2].signal).toBe(ac.signal);
  });
});

const SH = findSh();
const describeSh = SH ? describe : describe.skip;

describeSh('the remote command run by a real sh', () => {
  let tmp;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-chat it's "));
    fs.mkdirSync(path.join(tmp, 'my project'));
    // A stand-in claude: prints where it runs, what it got and its environment
    fs.writeFileSync(path.join(tmp, 'claude'), [
      '#!/bin/sh',
      'printf "cwd=%s\\n" "$(pwd)"',
      'for a in "$@"; do printf "arg=%s\\n" "$a"; done',
      'printf "entry=%s\\n" "$CLAUDE_CODE_ENTRYPOINT"',
      'printf "key=%s\\n" "$ANTHROPIC_API_KEY"',
      '',
    ].join('\n'));
    fs.chmodSync(path.join(tmp, 'claude'), 0o755);
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('arguments with spaces and quotes arrive intact, in the project directory, with the allowlist only', () => {
    const args = ['--model', "it's \"opus\"", '--settings', '{"a":"b c"}', '$HOME', '`id`'];
    const script = buildRemoteChatScript({
      remotePath: `${toShPath(tmp)}/my project`,
      claude: `${toShPath(tmp)}/claude`,
      args,
      env: { ...SDK_ENV, ANTHROPIC_API_KEY: 'sk-ant-api-secret' },
    });
    // `/bin/sh -c <q(script)>` is what ssh hands the remote login shell
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const out = execFileSync(SH, ['-c', script], { encoding: 'utf8', env });
    const lines = out.trim().split('\n').map((l) => l.replace(/\r$/, ''));
    expect(lines[0]).toMatch(/my project$/);
    expect(lines.filter((l) => l.startsWith('arg=')).map((l) => l.slice(4))).toEqual(args);
    expect(lines).toContain('entry=sdk-ts');
    expect(lines).toContain('key=');
  });
});

describe('remote CLI checks', () => {
  test('no claude on the host is not-installed', () => {
    expect(checkRemoteCli({ claude: '' }, '2.1.260')).toEqual({ ok: false, code: 'not-installed' });
    expect(checkRemoteCli(null, '2.1.260')).toEqual({ ok: false, code: 'not-installed' });
  });

  test('an older remote CLI warns, naming both versions; a newer one does not', () => {
    const older = checkRemoteCli({ claude: '/usr/bin/claude', claudeVersion: '2.1.199 (Claude Code)' }, '2.1.260');
    expect(older).toEqual({ ok: true, claude: '/usr/bin/claude', warnings: [{ code: 'version-old', remote: '2.1.199', bundled: '2.1.260' }] });
    expect(checkRemoteCli({ claude: '/usr/bin/claude', claudeVersion: '2.2.0 (Claude Code)' }, '2.1.260').warnings).toEqual([]);
    expect(checkRemoteCli({ claude: '/usr/bin/claude', claudeVersion: '' }, '2.1.260').warnings).toEqual([]);
  });

  test('the bundled version is the CLI numbering, not the SDK package one', () => {
    const v = bundledCliVersion();
    expect(v === null || /^2\.\d+\.\d+/.test(v)).toBe(true);
  });
});

describe('remote failures', () => {
  test('exit 255 is classified from ssh stderr, 127 is a missing claude', () => {
    expect(classifyRemoteChatFailure('Claude Code process exited with code 255', 'Connection reset by 10.0.0.2 port 22')).toBe('network');
    expect(classifyRemoteChatFailure('Claude Code process exited with code 255', 'yanis@h: Permission denied (publickey).')).toBe('auth');
    expect(classifyRemoteChatFailure('Claude Code process exited with code 255', '')).toBe('network');
    expect(classifyRemoteChatFailure('Claude Code process exited with code 127', 'sh: 1: claude: not found')).toBe('not-installed');
  });

  test("any other exit is the CLI's own, even when its stderr mentions a refused connection", () => {
    expect(classifyRemoteChatFailure('Claude Code process exited with code 1', 'API Error: Connection refused')).toBeNull();
  });

  test('a broken pipe before any exit code uses ssh diagnostics only', () => {
    expect(classifyRemoteChatFailure('write EPIPE', 'client_loop: send disconnect: Broken pipe')).toBe('network');
    expect(classifyRemoteChatFailure('write EPIPE', '')).toBeNull();
  });

  test('the messages name the host', () => {
    expect(describeSshFailure('not-installed', 'build')).toMatch(/^Claude Code is not installed on build\. Install it there/);
    expect(describeSshFailure('network', 'build')).toBe('The connection to build was lost.');
    expect(describeSshFailure('something-else', 'build')).toBeNull();
  });
});

describe('prepareRemoteChat', () => {
  const URI = 'ssh-remote://abcd1234/home/yanis/api';
  const TARGET = { kind: 'remote', profileId: 'abcd1234', remotePath: '/home/yanis/api', host: 'yanis@build', project: { id: 'r1' } };
  const CAPS = { claude: '/home/yanis/.local/bin/claude', claudeVersion: '2.1.100 (Claude Code)', path: '/home/yanis/.local/bin:/usr/bin' };

  function deps(overrides = {}) {
    return {
      resolveTarget: jest.fn(async () => TARGET),
      getStatus: jest.fn(() => ({ state: 'connected', capabilities: CAPS })),
      connect: jest.fn(async () => ({ state: 'connected', capabilities: CAPS })),
      ptyLaunch: jest.fn(async () => ({ command: '/usr/bin/ssh', prefixArgs: [], profile: { id: 'abcd1234', host: 'build' }, capabilities: CAPS })),
      bundledVersion: () => '2.1.260',
      ...overrides,
    };
  }

  test('resolves the URI in main and returns the launch, the claude and a version warning', async () => {
    const d = deps();
    const res = await prepareRemoteChat({ cwd: URI, projectId: 'r1' }, d);
    expect(d.resolveTarget).toHaveBeenCalledWith(URI);
    expect(d.connect).not.toHaveBeenCalled();
    expect(res).toMatchObject({ profileId: 'abcd1234', host: 'yanis@build', remotePath: '/home/yanis/api', claude: CAPS.claude, loginPath: CAPS.path });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0].message).toContain('2.1.100');
    expect(res.warnings[0].message).toContain('2.1.260');
  });

  test('connects a host that is not connected yet', async () => {
    const d = deps({ getStatus: jest.fn(() => ({ state: 'idle' })) });
    await prepareRemoteChat({ cwd: URI }, d);
    expect(d.connect).toHaveBeenCalledWith('abcd1234');
  });

  test('a host that stays unreachable is connection_lost', async () => {
    const d = deps({ getStatus: jest.fn(() => ({ state: 'idle' })), connect: jest.fn(async () => ({ state: 'reconnecting' })) });
    await expect(prepareRemoteChat({ cwd: URI }, d)).rejects.toMatchObject({ errorType: 'connection_lost' });
    expect(d.ptyLaunch).not.toHaveBeenCalled();
  });

  test('an auth failure is said, and is not a connection to wait for', async () => {
    const d = deps({ getStatus: jest.fn(() => ({ state: 'authFailed' })), connect: jest.fn(async () => ({ state: 'authFailed' })) });
    await expect(prepareRemoteChat({ cwd: URI }, d)).rejects.toMatchObject({ errorType: 'generic', message: expect.stringMatching(/^Authentication to yanis@build failed/) });
  });

  test('no claude on the host: Claude Code is not installed on <host>', async () => {
    const d = deps({ ptyLaunch: jest.fn(async () => ({ command: '/usr/bin/ssh', profile: {}, capabilities: { claude: '' } })) });
    await expect(prepareRemoteChat({ cwd: URI }, d)).rejects.toMatchObject({ code: 'CLAUDE_NOT_INSTALLED', message: expect.stringMatching(/^Claude Code is not installed on yanis@build\./) });
  });

  test('a project id that does not own the URI is refused', async () => {
    await expect(prepareRemoteChat({ cwd: URI, projectId: 'other' }, deps())).rejects.toThrow(/does not match/);
  });

  test('a URI outside any registered project is refused by the resolver', async () => {
    const d = deps({ resolveTarget: jest.fn(async () => { throw Object.assign(new Error('Remote path is not inside a registered remote project'), { code: 'REMOTE_PATH_NOT_IN_PROJECT' }); }) });
    await expect(prepareRemoteChat({ cwd: 'ssh-remote://abcd1234/etc' }, d)).rejects.toMatchObject({ code: 'REMOTE_PATH_NOT_IN_PROJECT' });
  });
});
