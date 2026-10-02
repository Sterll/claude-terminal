/**
 * @jest-environment node
 */
const fs = require('fs');
const { spawnSync, execFileSync } = require('child_process');
const {
  q, qArgs, assertOneLine, script, cdAnd, gitScript, shC, withPath,
  terminalShellScript, terminalClaudeScript, tmuxKillScript,
  classifySshFailure, isTerminalFailure,
} = require('../../src/shared/remote-shell');
const { findSh } = require('../helpers/fake-ssh');

const SAMPLES = [
  'plain',
  'with spaces  and  runs',
  "it's",
  "''",
  'say "hi"',
  'back\\slash',
  'trailing\\',
  '\\"\\',
  "mixed '\\' and \"\\\"",
  '$HOME and $' + '{PATH}', // split so it is not read as a template placeholder
  '`id` and $(id)',
  '*',
  '?[a-z]*',
  '-n',
  '--',
  '%s %d',
  '!event !! ^x',
  'semi; colon && pipe | amp &',
  '~/tilde',
  '#hash',
  'café 日本 🚀',
  '',
];

const SH = findSh();
const describeSh = SH ? describe : describe.skip;

/**
 * Run `printf '%s' <q(value)>` through `/bin/sh -c`, the way the remote side
 * receives it: the outer shell parses `/bin/sh -c <q(inner)>`, the inner one
 * parses `q(value)`. Fed on stdin so Windows argv rules (MSVCRT, then msys)
 * never touch the bytes; on POSIX the direct argv form is checked as well.
 */
function throughSh(value) {
  const inner = `printf '%s' ${q(value)}`;
  const nested = spawnSync(SH, ['-s'], { input: `exec /bin/sh -c ${q(inner)}\n`, encoding: 'utf8' });
  return nested.stdout;
}

function findShell(name) {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
    return out && fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

describe('q()', () => {
  test('wraps in single quotes and moves quotes and backslashes outside', () => {
    expect(q('a b')).toBe("'a b'");
    expect(q("it's")).toBe("'it'\\''s'");
    expect(q('a\\b')).toBe("'a'\\\\'b'");
    expect(q('')).toBe("''");
    expect(q(42)).toBe("'42'");
  });

  test('refuses newline, carriage return, NUL and other control characters', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\u0000b', 'a\tb', 'a\u001bb', 'a\u007fb', 'a\u0085b']) {
      expect(() => q(bad)).toThrow(/control character/);
    }
    expect(() => q(null)).toThrow();
    expect(() => q(undefined)).toThrow();
  });

  test('qArgs quotes every element', () => {
    expect(qArgs(['git', 'commit', '-m', "it's"])).toBe("'git' 'commit' '-m' 'it'\\''s'");
  });
});

describeSh('q() round trip through a real /bin/sh -c', () => {
  test.each(SAMPLES.map((s) => [s]))('%j', (value) => {
    expect(throughSh(value)).toBe(value);
  });

  if (process.platform !== 'win32') {
    test('direct argv form', () => {
      for (const value of SAMPLES) {
        const r = spawnSync(SH, ['-c', `printf '%s' ${q(value)}`], { encoding: 'utf8' });
        expect(r.stdout).toBe(value);
      }
    });
  }

  test('shC builds a remote command the shell runs as one word', () => {
    const inner = script(`cd -- ${q('/')}`, `printf '%s|%s' ${q('a b')} ${q("c'd")}`);
    const r = spawnSync(SH, ['-s'], { input: `exec ${shC(inner)}\n`, encoding: 'utf8' });
    expect(r.stdout).toBe("a b|c'd");
  });

  test('withPath exports the given PATH to the script', () => {
    const r = spawnSync(SH, ['-s'], { input: `${withPath('/opt/x bin:/usr/bin:/bin', 'printf %s "$PATH"')}\n`, encoding: 'utf8' });
    expect(r.stdout).toBe('/opt/x bin:/usr/bin:/bin');
  });
});

for (const name of ['fish', 'tcsh']) {
  const shell = findShell(name);
  (shell ? describe : describe.skip)(`q() round trip through ${name} -c`, () => {
    test('every sample survives', () => {
      for (const value of SAMPLES) {
        const r = spawnSync(shell, ['-c', `printf '%s' ${q(value)}`], { encoding: 'utf8' });
        expect(r.stdout).toBe(value);
      }
    });
  });
}

describe('script builders', () => {
  test('assertOneLine refuses multi-line scripts', () => {
    expect(() => assertOneLine('a\nb')).toThrow(/single line/);
    expect(() => assertOneLine('a\rb')).toThrow(/single line/);
    expect(() => assertOneLine('')).toThrow();
    expect(assertOneLine('echo ok')).toBe('echo ok');
  });

  test('script joins with "; " and drops empty parts', () => {
    expect(script('a', '', null, 'b')).toBe('a; b');
  });

  test('cdAnd and gitScript put -- before paths and quote every argument', () => {
    expect(cdAnd('/srv/a b', 'pwd')).toBe("cd -- '/srv/a b' && pwd");
    const g = gitScript('/srv/repo', ['log', '--format=%H', '--', "it's.txt"]);
    expect(g).toContain("cd -- '/srv/repo' && ");
    expect(g).toContain('GIT_TERMINAL_PROMPT=0');
    expect(g).toContain('-c protocol.ext.allow=never');
    expect(g).toContain("'log' '--format=%H' '--' 'it'\\''s.txt'");
  });
});

describe('classifySshFailure', () => {
  const samples = [
    ['auth', 255, 'yanis@build.example.com: Permission denied (publickey,password).\r\n'],
    ['auth', 255, 'Received disconnect from 10.0.0.2 port 22:2: Too many authentication failures\r\n'],
    ['hostkey-unknown', 255, 'No ED25519 host key is known for build.example.com and you have requested strict checking.\r\nHost key verification failed.\r\n'],
    ['hostkey-changed', 255, '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\nHost key verification failed.\r\n'],
    ['dns', 255, 'ssh: Could not resolve hostname build.example.com: Name or service not known\r\n'],
    ['dns', 255, 'ssh: Could not resolve hostname nope: No such host is known. \r\n'],
    ['dns', 255, 'ssh: Could not resolve hostname nope: nodename nor servname provided, or not known\r\n'],
    ['timeout', 255, 'ssh: connect to host build.example.com port 22: Connection timed out\r\n'],
    ['timeout', 255, 'ssh: connect to host 10.0.0.9 port 22: Operation timed out\r\n'],
    ['timeout', 255, 'Connection timed out during banner exchange\r\n'],
    ['timeout', 255, 'Timeout, server build.example.com not responding.\r\n'],
    ['refused', 255, 'ssh: connect to host build.example.com port 2222: Connection refused\r\n'],
    ['network', 255, 'client_loop: send disconnect: Connection reset\r\n'],
    ['network', 255, 'Connection closed by 10.0.0.2 port 22\r\n'],
    ['network', 255, 'packet_write_wait: Connection to 10.0.0.2 port 22: Broken pipe\r\n'],
    ['network', 255, 'ssh: connect to host 10.0.0.2 port 22: Network is unreachable\r\n'],
    ['network', 255, 'kex_exchange_identification: read: Connection reset by peer\r\n'],
    ['network', 255, ''],
    ['not-installed', 127, 'sh: 1: claude: not found\n'],
    ['not-installed', 127, 'bash: line 1: claude: command not found\n'],
  ];

  test.each(samples)('%s from %j', (kind, code, stderr) => {
    expect(classifySshFailure(code, stderr)).toBe(kind);
  });

  test('a remote command failing on its own is not an ssh failure', () => {
    expect(classifySshFailure(1, 'fatal: not a git repository\n')).toBeNull();
    expect(classifySshFailure(0, '')).toBeNull();
  });

  test('only auth and host key failures are terminal', () => {
    expect(isTerminalFailure('auth')).toBe(true);
    expect(isTerminalFailure('hostkey-unknown')).toBe(true);
    expect(isTerminalFailure('hostkey-changed')).toBe(true);
    for (const kind of ['dns', 'timeout', 'refused', 'network', 'not-installed']) expect(isTerminalFailure(kind)).toBe(false);
  });
});

describe('terminal scripts', () => {
  const LOGIN = 'exec "$' + '{SHELL:-/bin/sh}" -l'; // split: not a template placeholder

  test('a shell tab enters the directory and becomes the login shell, on one line', () => {
    const line = terminalShellScript("/srv/it's here");
    expect(line).toBe(`cd -- ${q("/srv/it's here")} && ${LOGIN}`);
    expect(() => assertOneLine(line)).not.toThrow();
  });

  test('with a tmux session it attaches or creates it, and falls back to the shell without tmux', () => {
    const line = terminalShellScript('/srv/app', { tmuxSession: 'ct-tab_p1_9', path: '/usr/local/bin:/usr/bin' });
    expect(line).toContain('tmux new-session -A -s ct-tab_p1_9');
    expect(line).toContain('command -v tmux');
    expect(line).toContain(`PATH=${q('/usr/local/bin:/usr/bin')}`);
    expect(line.endsWith(`else ${LOGIN}; fi`)).toBe(true);
  });

  test('a tmux session name outside ct-[A-Za-z0-9_-] is refused', () => {
    expect(() => terminalShellScript('/srv', { tmuxSession: 'ct-a;reboot' })).toThrow();
    expect(() => terminalShellScript('/srv', { tmuxSession: 'other' })).toThrow();
    expect(() => tmuxKillScript('ct-$(id)')).toThrow();
    expect(tmuxKillScript('ct-tab_1')).toBe('tmux kill-session -t ct-tab_1 2>/dev/null; :');
  });

  test('a Claude tab needs a command line', () => {
    expect(() => terminalClaudeScript('/srv', [])).toThrow();
  });

  (SH ? test : test.skip)('a Claude tab hands the login shell the CLI argv intact', () => {
    const argv = ['/opt/my claude/claude', '--resume', '0f1e2d3c-aaaa', "it's", '$HOME'];
    const line = terminalClaudeScript('/srv/app', argv);
    // Run the remote side through a real sh: `cd` becomes a no-op and the
    // login shell a printf of the one word it would be given to run.
    const probe = shC(line).replace('cd -- ', ': ').replace(`${LOGIN} -c `, 'printf %s ');
    const r = spawnSync(SH, ['-s'], { input: `SHELL=/bin/sh; export SHELL; exec ${probe}\n`, encoding: 'utf8' });
    expect(r.stdout).toBe(qArgs(argv));
    // And that word, parsed by a shell, is the argv again.
    const back = spawnSync(SH, ['-s'], { input: `printf '<%s>' ${r.stdout}\n`, encoding: 'utf8' });
    expect(back.stdout).toBe(argv.map((a) => `<${a}>`).join(''));
  });

  (SH ? test : test.skip)('csh and tcsh get -c without -l, which they refuse', () => {
    const line = terminalClaudeScript('/srv/app', ['claude']);
    const probe = shC(line).replace('cd -- ', ': ').replace('exec "$SHELL" -c ', 'printf csh:%s ');
    const r = spawnSync(SH, ['-s'], { input: `SHELL=/bin/tcsh; export SHELL; exec ${probe}\n`, encoding: 'utf8' });
    expect(r.stdout).toBe("csh:'claude'");
  });
});
