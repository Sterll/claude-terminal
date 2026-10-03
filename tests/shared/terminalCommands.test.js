const { TERMINAL_COMMANDS, parseTerminalCommand, terminalCommandArgv } = require('../../src/shared/terminal-commands');

describe('parseTerminalCommand', () => {
  test('recognises the commands the CLI only runs interactively', () => {
    expect(parseTerminalCommand('/design-login')).toEqual({ name: 'design-login', args: [], valid: true });
    expect(parseTerminalCommand('  /login  ')).toEqual({ name: 'login', args: [], valid: true });
    expect(parseTerminalCommand('/plugin install foo@bar')).toEqual({ name: 'plugin', args: ['install', 'foo@bar'], valid: true });
  });

  test('leaves alone what the chat already handles or the CLI runs headless', () => {
    for (const text of ['/design consent', '/design', '/model opus', '/config', '/mcp', '/remote-control', '/compact', 'login', 'run /login please']) {
      expect(parseTerminalCommand(text)).toBeNull();
    }
  });

  test('a prefix of a listed command is not that command', () => {
    expect(parseTerminalCommand('/design-login-now')).toBeNull();
    expect(parseTerminalCommand('/log')).toBeNull();
  });

  test('marks arguments a shell could interpret as invalid, without dropping the command', () => {
    for (const text of ['/login & calc', '/login "x"', '/login %TEMP%', '/login $HOME', '/login a;b', '/login `id`', '/login a>b']) {
      const parsed = parseTerminalCommand(text);
      expect(parsed).not.toBeNull();
      expect(parsed.valid).toBe(false);
    }
  });

  test('every listed command is a plain slug', () => {
    for (const name of TERMINAL_COMMANDS) expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

describe('terminalCommandArgv', () => {
  test('is the argv to append to claude', () => {
    expect(terminalCommandArgv('/design-login')).toEqual(['/design-login']);
    expect(terminalCommandArgv('/plugin  install   foo@bar')).toEqual(['/plugin', 'install', 'foo@bar']);
  });

  test('is null for anything that must not reach a shell', () => {
    expect(terminalCommandArgv('/login & calc')).toBeNull();
    expect(terminalCommandArgv('/model opus')).toBeNull();
    expect(terminalCommandArgv('')).toBeNull();
    expect(terminalCommandArgv(null)).toBeNull();
  });
});
