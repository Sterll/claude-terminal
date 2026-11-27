/**
 * Shell choice for terminal tabs and "Open in external terminal" (issue #255).
 *
 * Every platform is exercised on every platform: the module takes its file
 * system, environment and spawn as `deps`, so these tests describe Windows,
 * macOS and Linux machines as sets of existing files.
 */

const { EventEmitter } = require('events');
const shells = require('../../src/main/utils/terminalShells');

/** A fake machine: `files` and `dirs` exist, nothing else does. */
function machine({ platform, files = [], dirs = [], env = {}, read = {} }) {
  const norm = (p) => (platform === 'win32' ? p.toLowerCase() : p);
  const fileSet = new Set(files.map(norm));
  const dirSet = new Set(dirs.map(norm));
  const spawned = [];
  // The module copies `spawn` off the deps it is given, so it must not rely on `this`.
  const fake = {
    platform,
    env,
    isFile: (p) => fileSet.has(norm(p)),
    isDir: (p) => dirSet.has(norm(p)),
    readFile: (p) => {
      if (read[p] === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return read[p];
    },
    realpath: (p) => p,
    spawned,
    spawnBehaviour: { event: 'spawn', code: 0 },
    spawn(file, args, options) {
      const child = new EventEmitter();
      child.unref = jest.fn();
      spawned.push({ file, args, options, child });
      const b = fake.spawnBehaviour;
      setTimeout(() => {
        if (b.event === 'error') child.emit('error', new Error(b.message || 'spawn ENOENT'));
        else {
          child.emit('spawn');
          child.emit('exit', b.code);
        }
      }, 0);
      return child;
    },
  };
  return fake;
}

const WIN_ENV = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  Path: 'C:\\Windows\\System32;C:\\Tools',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
};

function windowsMachine(extraFiles = [], extra = {}) {
  return machine({
    platform: 'win32',
    env: WIN_ENV,
    dirs: ['C:\\code\\app', 'E:\\'],
    files: [
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ...extraFiles,
    ],
    ...extra,
  });
}

describe('parseCommandLine', () => {
  it('splits on whitespace and groups quotes, keeping backslashes', () => {
    expect(shells.parseCommandLine('"C:\\Program Files\\Tabby\\Tabby.exe" open {path}'))
      .toEqual(['C:\\Program Files\\Tabby\\Tabby.exe', 'open', '{path}']);
    expect(shells.parseCommandLine("  --login   -i 'a b'  ")).toEqual(['--login', '-i', 'a b']);
    expect(shells.parseCommandLine('--title ""')).toEqual(['--title', '']);
    expect(shells.parseCommandLine('')).toEqual([]);
    expect(shells.parseCommandLine(undefined)).toEqual([]);
  });
});

describe('which', () => {
  it('walks PATH with PATHEXT on Windows', () => {
    const m = windowsMachine(['C:\\Tools\\nu.exe']);
    expect(shells.which('nu', m)).toBe('C:\\Tools\\nu.exe');
    expect(shells.which('missing', m)).toBeNull();
  });

  it('only accepts an absolute path that exists', () => {
    const m = machine({ platform: 'linux', files: ['/usr/bin/fish'], env: { PATH: '/usr/bin' } });
    expect(shells.which('/usr/bin/fish', m)).toBe('/usr/bin/fish');
    expect(shells.which('fish', m)).toBe('/usr/bin/fish');
    expect(shells.which('/opt/fish', m)).toBeNull();
  });
});

describe('detectShells', () => {
  it('lists what a Windows machine has, Git Bash found through git on PATH', () => {
    const m = windowsMachine([
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'D:\\Git\\cmd\\git.exe',
      'D:\\Git\\bin\\bash.exe',
      'C:\\Windows\\System32\\wsl.exe',
    ], { env: { ...WIN_ENV, Path: 'C:\\Windows\\System32;D:\\Git\\cmd' } });
    const found = shells.detectShells(m);
    expect(found.map((s) => s.id)).toEqual(['pwsh', 'cmd', 'git-bash', 'wsl']);
    const bash = found.find((s) => s.id === 'git-bash');
    expect(bash.file).toBe('D:\\Git\\bin\\bash.exe');
    expect(bash.args).toEqual(['--login', '-i']);
    // Without it, Git Bash's profile moves the tab to $HOME.
    expect(bash.env).toEqual({ CHERE_INVOKING: '1' });
  });

  it('never takes System32\\bash.exe (WSL) for Git Bash', () => {
    const m = windowsMachine(['C:\\Windows\\System32\\bash.exe']);
    expect(shells.detectShells(m).map((s) => s.id)).not.toContain('git-bash');
  });

  it('reads /etc/shells on POSIX, one entry per shell, no nologin', () => {
    const m = machine({
      platform: 'linux',
      env: { SHELL: '/usr/bin/zsh', PATH: '/usr/bin' },
      files: ['/bin/bash', '/usr/bin/bash', '/usr/bin/zsh', '/usr/sbin/nologin', '/usr/bin/fish'],
      read: { '/etc/shells': '# comment\n/bin/sh\n/bin/bash\n/usr/bin/bash\n/usr/bin/zsh\n/usr/sbin/nologin\n/usr/bin/fish\n' },
    });
    const found = shells.detectShells(m);
    expect(found.map((s) => s.id)).toEqual(['bash', 'zsh', 'fish']);
    expect(found[0].file).toBe('/bin/bash');
    expect(found[1].label).toBe('Zsh (/usr/bin/zsh)');
  });
});

describe('resolveShell', () => {
  const m = windowsMachine(['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Tools\\nu.exe']);

  it('answers null for the default, which TerminalService keeps as it was', () => {
    expect(shells.resolveShell({}, m)).toBeNull();
    expect(shells.resolveShell({ terminalShell: '' }, m)).toBeNull();
    expect(shells.resolveShell(null, m)).toBeNull();
  });

  it('resolves a detected shell', () => {
    expect(shells.resolveShell({ terminalShell: 'pwsh' }, m)).toEqual({
      file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'], env: null, label: 'PowerShell 7',
    });
  });

  it('falls back with a notice for a shell this machine does not have (a synced setting)', () => {
    const res = shells.resolveShell({ terminalShell: 'zsh' }, m);
    expect(res.file).toBeUndefined();
    expect(res.notice).toMatch(/"zsh".*not available.*Windows PowerShell/);
  });

  it('resolves a custom program on PATH with its arguments', () => {
    expect(shells.resolveShell({ terminalShell: 'custom', terminalShellCustomPath: '"nu"', terminalShellCustomArgs: '--login --config "C:\\my cfg.nu"' }, m))
      .toEqual({ file: 'C:\\Tools\\nu.exe', args: ['--login', '--config', 'C:\\my cfg.nu'], env: null, label: 'nu' });
  });

  it('falls back with a notice for a custom program that does not exist', () => {
    expect(shells.resolveShell({ terminalShell: 'custom', terminalShellCustomPath: 'C:\\nope\\sh.exe' }, m).notice)
      .toMatch(/C:\\nope\\sh\.exe/);
    expect(shells.resolveShell({ terminalShell: 'custom', terminalShellCustomPath: '' }, m).notice).toBeTruthy();
  });
});

describe('external terminals', () => {
  const WT = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe';

  it('defaults to Windows Terminal when installed, else Windows PowerShell', () => {
    expect(shells.defaultExternalTerminalId(windowsMachine([WT]))).toBe('wt');
    expect(shells.defaultExternalTerminalId(windowsMachine())).toBe('powershell');
  });

  it('hands Windows Terminal the folder and the profile, escaping its ";" separator', () => {
    const m = windowsMachine([WT]);
    const launch = shells.buildExternalLaunch({ externalTerminal: 'wt', externalTerminalProfile: 'Git;Bash' }, 'C:\\code\\app', m);
    expect(launch.argv).toEqual([WT, '-d', 'C:\\code\\app', '-p', 'Git\\;Bash']);
  });

  it('never ends a folder on a backslash, which would escape the closing quote', () => {
    const launch = shells.buildExternalLaunch({ externalTerminal: 'wt' }, 'E:\\', windowsMachine([WT]));
    expect(launch.argv[2]).toBe('E:\\.');
  });

  it('ignores the profile for a terminal that has none', () => {
    const launch = shells.buildExternalLaunch({ externalTerminal: 'cmd', externalTerminalProfile: 'x' }, 'C:\\code\\app', windowsMachine());
    expect(launch.argv).toEqual(['C:\\Windows\\System32\\cmd.exe']);
  });

  it('opens macOS apps through open, by folder or by flag', () => {
    const m = machine({ platform: 'darwin', env: { HOME: '/Users/me' }, dirs: ['/Applications/Ghostty.app', '/System/Applications/Utilities/Terminal.app', '/work'] });
    expect(shells.detectExternalTerminals(m).map((x) => x.id)).toEqual(['terminal', 'ghostty']);
    expect(shells.buildExternalLaunch({}, '/work', m).argv).toEqual(['/usr/bin/open', '-a', 'Terminal', '/work']);
    expect(shells.buildExternalLaunch({ externalTerminal: 'ghostty' }, '/work', m).argv)
      .toEqual(['/usr/bin/open', '-na', 'Ghostty', '--args', '--working-directory=/work']);
  });

  it('prefers x-terminal-emulator on Linux and passes each terminal its own flag', () => {
    const m = machine({ platform: 'linux', env: { PATH: '/usr/bin' }, files: ['/usr/bin/konsole', '/usr/bin/x-terminal-emulator'] });
    expect(shells.defaultExternalTerminalId(m)).toBe('x-terminal-emulator');
    expect(shells.buildExternalLaunch({ externalTerminal: 'konsole' }, '/work', m).argv).toEqual(['/usr/bin/konsole', '--workdir', '/work']);
  });

  it('substitutes {path} in a custom command, without a shell', () => {
    const m = machine({ platform: 'linux', env: { PATH: '/usr/bin' }, files: ['/usr/bin/alacritty'] });
    expect(shells.buildExternalLaunch({ externalTerminal: 'custom', externalTerminalCustomCommand: 'alacritty --working-directory {path} -e "$SHELL"' }, '/my work', m).argv)
      .toEqual(['/usr/bin/alacritty', '--working-directory', '/my work', '-e', '$SHELL']);
  });

  it('says which terminal is missing, with a code the renderer translates', () => {
    const m = machine({ platform: 'linux', env: { PATH: '/usr/bin' } });
    expect(shells.buildExternalLaunch({ externalTerminal: 'kitty' }, '/w', m)).toMatchObject({ code: 'NOT_FOUND', name: 'kitty' });
    expect(shells.buildExternalLaunch({}, '/w', m)).toMatchObject({ code: 'NONE_FOUND' });
    expect(shells.buildExternalLaunch({ externalTerminal: 'custom' }, '/w', m)).toMatchObject({ code: 'NO_CUSTOM_COMMAND' });
    expect(shells.buildExternalLaunch({ externalTerminal: 'warp' }, '/w', m)).toMatchObject({ code: 'NOT_FOUND', name: 'warp' });
  });
});

describe('openExternalTerminal', () => {
  const WT = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe';

  it('goes through start on Windows, so the window gets a console outside the app', async () => {
    const m = windowsMachine([WT]);
    const res = await shells.openExternalTerminal('C:\\code\\app', { externalTerminal: 'wt', externalTerminalProfile: 'PowerShell' }, m);
    expect(res).toEqual({ success: true });
    const [call] = m.spawned;
    expect(call.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(call.args).toEqual(['/d', '/s', '/c', `"start "" /D "C:\\code\\app" "${WT}" "-d" "C:\\code\\app" "-p" "PowerShell""`]);
    expect(call.options).toMatchObject({ detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
  });

  it('refuses what cmd.exe would still read inside quotes', async () => {
    const m = windowsMachine([WT], { dirs: ['C:\\100%'] });
    const res = await shells.openExternalTerminal('C:\\100%', { externalTerminal: 'wt' }, m);
    expect(res).toMatchObject({ success: false, code: 'UNSAFE_PATH' });
    expect(m.spawned).toHaveLength(0);
  });

  it('starts the terminal directly on POSIX, detached, in the folder', async () => {
    const m = machine({ platform: 'linux', env: { PATH: '/usr/bin' }, files: ['/usr/bin/kitty'], dirs: ['/work'] });
    await expect(shells.openExternalTerminal('/work', { externalTerminal: 'kitty' }, m)).resolves.toEqual({ success: true });
    expect(m.spawned[0]).toMatchObject({ file: '/usr/bin/kitty', args: ['--directory', '/work'], options: { cwd: '/work', detached: true, stdio: 'ignore' } });
    expect(m.spawned[0].child.unref).toHaveBeenCalled();
  });

  it('reads a failed open -a from its exit code', async () => {
    const m = machine({ platform: 'darwin', env: {}, dirs: ['/System/Applications/Utilities/Terminal.app', '/work'] });
    m.spawnBehaviour = { event: 'spawn', code: 1 };
    await expect(shells.openExternalTerminal('/work', {}, m)).resolves.toMatchObject({ success: false, code: 'LAUNCH_FAILED', name: 'Terminal' });
  });

  it('reports a spawn error', async () => {
    const m = machine({ platform: 'linux', env: { PATH: '/usr/bin' }, files: ['/usr/bin/foot'], dirs: ['/work'] });
    m.spawnBehaviour = { event: 'error', message: 'spawn EACCES' };
    await expect(shells.openExternalTerminal('/work', { externalTerminal: 'foot' }, m)).resolves.toMatchObject({ success: false, code: 'LAUNCH_FAILED' });
  });

  it('refuses a folder that is not one, before spawning anything', async () => {
    const m = machine({ platform: 'linux', env: { PATH: '/usr/bin' }, files: ['/usr/bin/foot'] });
    await expect(shells.openExternalTerminal('/nope', {}, m)).resolves.toMatchObject({ success: false, code: 'NOT_A_FOLDER' });
    await expect(shells.openExternalTerminal('relative', {}, m)).resolves.toMatchObject({ code: 'NOT_A_FOLDER' });
    expect(m.spawned).toHaveLength(0);
  });
});

describe('Windows Terminal profiles', () => {
  it('reads the JSONC settings, skipping hidden profiles and duplicates', () => {
    const file = 'C:\\Users\\me\\AppData\\Local\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json';
    const m = windowsMachine([], {
      read: {
        [file]: `// generated
        {
          "defaultProfile": "{1}", /* block */
          "profiles": {
            "list": [
              { "name": "PowerShell", "guid": "{1}" },
              { "name": "Azure Cloud Shell", "hidden": true },
              { "name": "Git Bash", "commandline": "C://Git//bin//bash.exe", },
              { "name": "PowerShell" },
            ],
          },
        }`,
      },
    });
    expect(shells.listWindowsTerminalProfiles(m)).toEqual(['PowerShell', 'Git Bash']);
  });

  it('is empty, never an error, without Windows Terminal or off Windows', () => {
    expect(shells.listWindowsTerminalProfiles(windowsMachine())).toEqual([]);
    expect(shells.listWindowsTerminalProfiles(machine({ platform: 'linux' }))).toEqual([]);
  });

  it('strips comments but not "//" inside strings', () => {
    expect(JSON.parse(shells.stripJsonc('{"a": "http://x", // c\n "b": [1,],}'))).toEqual({ a: 'http://x', b: [1] });
  });
});
