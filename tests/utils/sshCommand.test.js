/**
 * @jest-environment node
 */
const path = require('path');
const {
  buildSshArgs, channelArgs, chatArgs, oneShotArgs, findSshBinary, destination, displayDestination,
  assertProxyJump,
} = require('../../src/main/utils/sshCommand');

const IDENTITY = process.platform === 'win32' ? 'C:\\Users\\y\\.ssh\\id_ed25519' : '/home/y/.ssh/id_ed25519';

const profile = (over = {}) => ({
  id: 'abcd1234',
  host: 'build.example.com',
  user: 'yanis',
  port: 2222,
  identityFile: IDENTITY,
  proxyJump: 'bastion.example.com',
  forwardAgent: false,
  ...over,
});

function optionValues(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '-o') out.push(args[i + 1]);
  return out;
}

describe('ssh argv builder', () => {
  test.each(['win32', 'linux', 'darwin'])('channel argv on %s: BatchMode, keepalives, -- right before the destination', (platform) => {
    const args = channelArgs(profile(), { platform, controlDir: '/home/y/.claude-terminal/ssh' });
    const opts = optionValues(args);
    expect(opts).toContain('BatchMode=yes');
    expect(opts).toContain('ServerAliveInterval=15');
    expect(opts).toContain('ServerAliveCountMax=3');
    expect(args).toContain('-T');
    const dd = args.indexOf('--');
    expect(args[dd + 1]).toBe('build.example.com');
    expect(args.slice(dd + 2)).toEqual(['/bin/sh', '-s']);
    expect(args.slice(0, dd)).toEqual(expect.arrayContaining(['-p', '2222', '-l', 'yanis', '-i', IDENTITY, '-J', 'bastion.example.com']));
  });

  test('chat argv carries BatchMode and a single remote command element', () => {
    const args = chatArgs(profile(), "/bin/sh -c 'exec claude'", { platform: 'win32' });
    expect(optionValues(args)).toContain('BatchMode=yes');
    const dd = args.indexOf('--');
    expect(args[dd + 1]).toBe('build.example.com');
    expect(args.slice(dd + 2)).toEqual(["/bin/sh -c 'exec claude'"]);
  });

  test('never StrictHostKeyChecking=no, never a redirected known_hosts, in any mode', () => {
    for (const mode of ['channel', 'chat', 'oneshot', 'pty', 'verify']) {
      for (const platform of ['win32', 'linux']) {
        const joined = buildSshArgs(profile({ forwardAgent: true }), { mode, platform, controlDir: '/tmp/cm', remoteCommand: ['x'] }).join(' ');
        expect(joined).not.toMatch(/StrictHostKeyChecking=no/i);
        expect(joined).not.toMatch(/UserKnownHostsFile/i);
      }
    }
  });

  test('verify mode asks for the host key and runs `exit`', () => {
    const args = buildSshArgs(profile(), { mode: 'verify', platform: 'win32' });
    expect(optionValues(args)).toContain('StrictHostKeyChecking=ask');
    expect(optionValues(args)).not.toContain('BatchMode=yes');
    expect(args.slice(-3)).toEqual(['--', 'build.example.com', 'exit']);
  });

  test('pty mode uses -tt and no BatchMode, so a password prompt can reach the user', () => {
    const args = buildSshArgs(profile(), { mode: 'pty', platform: 'linux', remoteCommand: ['cmd'] });
    expect(args[0]).toBe('-tt');
    expect(optionValues(args)).not.toContain('BatchMode=yes');
  });

  test('ControlMaster only on non-win32 clients', () => {
    const win = channelArgs(profile(), { platform: 'win32', controlDir: 'C:\\x' });
    expect(win.join(' ')).not.toMatch(/Control(Master|Path|Persist)/);
    for (const platform of ['linux', 'darwin']) {
      const opts = optionValues(oneShotArgs(profile(), 'true', { platform, controlDir: '/home/y/.claude-terminal/ssh' }));
      expect(opts).toContain('ControlMaster=auto');
      expect(opts).toContain('ControlPath=/home/y/.claude-terminal/ssh/cm-%C');
      expect(opts).toContain('ControlPersist=60');
    }
  });

  test('ControlPath escapes % and quotes whitespace', () => {
    const opts = optionValues(channelArgs(profile(), { platform: 'linux', controlDir: '/home/my user/100%/ssh' }));
    expect(opts).toContain('ControlPath="/home/my user/100%%/ssh/cm-%C"');
  });

  test('-A only when forwardAgent is true', () => {
    expect(channelArgs(profile(), { platform: 'linux' })).not.toContain('-A');
    expect(channelArgs(profile({ forwardAgent: 'yes' }), { platform: 'linux' })).not.toContain('-A');
    expect(channelArgs(profile({ forwardAgent: true }), { platform: 'linux' })).toContain('-A');
  });

  test('an ssh_config alias is the destination and host fields are optional', () => {
    const args = channelArgs({ id: 'abcd1234', sshConfigAlias: 'buildbox' }, { platform: 'win32' });
    const dd = args.indexOf('--');
    expect(args[dd + 1]).toBe('buildbox');
    expect(args).not.toContain('-p');
    expect(args).not.toContain('-l');
  });

  test('IPv6 literals lose their brackets in the destination', () => {
    expect(destination({ host: '[fe80::1]' })).toBe('fe80::1');
    expect(displayDestination({ host: 'h', user: 'u', port: 22 })).toBe('u@h');
    expect(displayDestination({ host: 'h', user: 'u', port: 2222 })).toBe('u@h:2222');
  });

  test.each([
    ['host', { host: '-oProxyCommand=calc' }],
    ['alias', { host: null, sshConfigAlias: '-F/tmp/evil' }],
    ['jump host', { proxyJump: '-oProxyCommand=calc' }],
    ['second jump host', { proxyJump: 'bastion,-evil' }],
    ['jump host user', { proxyJump: '-u@bastion' }],
    ['user', { user: '-oProxyCommand=calc' }],
    ['host with a space', { host: 'a b' }],
    ['host with a shell character', { host: 'a;calc' }],
    ['port', { port: 70000 }],
    ['relative identity file', { identityFile: 'id_rsa' }],
  ])('a %s that could become an option throws', (_label, over) => {
    expect(() => channelArgs(profile(over), { platform: 'linux' })).toThrow();
  });

  test('proxyJump accepts user@host:port lists', () => {
    expect(assertProxyJump('alice@bastion:2200,jump2')).toBe('alice@bastion:2200,jump2');
  });

  test('unknown modes are refused', () => {
    expect(() => buildSshArgs(profile(), { mode: 'shell' })).toThrow();
  });
});

describe('findSshBinary', () => {
  test('win32 prefers the System32 OpenSSH client', async () => {
    const builtin = path.win32.join('C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    const found = await findSshBinary({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, existsSync: (p) => p === builtin, execFileImpl: () => { throw new Error('not called'); } });
    expect(found).toBe(builtin);
  });

  test('win32 falls back to where.exe', async () => {
    const git = 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe';
    const execFileImpl = jest.fn((file, args, opts, cb) => cb(null, `${git}\r\n`));
    const found = await findSshBinary({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, existsSync: (p) => p === git, execFileImpl });
    expect(execFileImpl).toHaveBeenCalledWith('where.exe', ['ssh'], expect.any(Object), expect.any(Function));
    expect(found).toBe(git);
  });

  test('POSIX: /usr/bin/ssh, then command -v', async () => {
    expect(await findSshBinary({ platform: 'linux', existsSync: (p) => p === '/usr/bin/ssh' })).toBe('/usr/bin/ssh');
    const execFileImpl = jest.fn((file, args, opts, cb) => cb(null, '/opt/homebrew/bin/ssh\n'));
    expect(await findSshBinary({ platform: 'darwin', existsSync: (p) => p === '/opt/homebrew/bin/ssh', execFileImpl })).toBe('/opt/homebrew/bin/ssh');
  });

  test('an existing override wins, a missing one is ignored', async () => {
    expect(await findSshBinary({ override: '/custom/ssh', platform: 'linux', existsSync: (p) => p === '/custom/ssh' || p === '/usr/bin/ssh' })).toBe('/custom/ssh');
    expect(await findSshBinary({ override: '/gone/ssh', platform: 'linux', existsSync: (p) => p === '/usr/bin/ssh' })).toBe('/usr/bin/ssh');
  });

  test('nothing found is null', async () => {
    const execFileImpl = (file, args, opts, cb) => cb(new Error('nope'));
    expect(await findSshBinary({ platform: 'linux', existsSync: () => false, execFileImpl })).toBeNull();
  });
});
