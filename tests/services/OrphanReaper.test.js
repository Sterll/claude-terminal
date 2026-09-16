// OrphanReaper unit tests — pure classification over `ps` listings, plus the
// confirm-then-kill cycle with every process call injected.

const {
  OrphanReaper,
  parsePsOutput,
  classify,
  describeCommand,
  _internals,
} = require('../../src/main/services/OrphanReaper');

const { RULE_LEFTOVER_LOOP, RULE_ABANDONED_SHELL, KILL_GRACE_MS } = _internals;

// The wrapper Claude Code puts around every Bash tool call, verbatim from a
// macOS process listing on 2026-09-16.
const SNAPSHOT = '/Users/me/.claude/shell-snapshots/snapshot-zsh-1789505608918-gp6lr3.sh';
function toolShellArgs(command, cwdFile = '/tmp/claude-684c-cwd') {
  const escaped = command.replace(/'/g, "'\\''");
  return `/bin/zsh -c source ${SNAPSHOT} 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval '${escaped}' < /dev/null && pwd -P >| ${cwdFile}`;
}

const STRESS_CMD = "cd /tmp/narvi-mut && for i in $(seq 1 $((nproc*3))); do (while :; do :; done) & done; go test -race -count=40 -run 'TestPumpOnce$' ./internal/app/automerge/ 2>&1 | tail -20; kill $(jobs -p) 2>/dev/null";

function row(pid, ppid, pgid, cpu, args) {
  return { pid, ppid, pgid, cpu, args };
}

const LAUNCHD = row(1, 0, 1, 0.1, '/sbin/launchd');
const APP = row(500, 1, 500, 3.0, '/Applications/Claude Terminal.app/Contents/MacOS/Claude Terminal');
const CLI = row(600, 500, 500, 0.5, '/Applications/Claude Terminal.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --output-format stream-json');

// ── parsePsOutput ─────────────────────────────────────────────────────────

describe('parsePsOutput', () => {
  test('reads the right-aligned numeric columns and keeps args whole', () => {
    const text = [
      '    1     0     1   0.4 /sbin/launchd',
      '78078     1 78071  20.7 ' + toolShellArgs(STRESS_CMD),
      '',
    ].join('\n');
    const rows = parsePsOutput(text);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ pid: 78078, ppid: 1, pgid: 78071, cpu: 20.7 });
    expect(rows[1].args.startsWith('/bin/zsh -c source ')).toBe(true);
    expect(rows[1].args.endsWith('/tmp/claude-684c-cwd')).toBe(true);
  });

  test('skips lines that do not look like a process row', () => {
    expect(parsePsOutput('  PID  PPID  PGID %CPU ARGS\ngarbage\n')).toEqual([]);
  });
});

// ── describeCommand ───────────────────────────────────────────────────────

describe('describeCommand', () => {
  test('lifts the eval-ed command out of the wrapper and restores its quotes', () => {
    expect(describeCommand(toolShellArgs("echo 'hi' && sleep 1"))).toBe("echo 'hi' && sleep 1");
  });

  test('truncates a long command', () => {
    const long = 'x'.repeat(300);
    const desc = describeCommand(toolShellArgs(long));
    expect(desc.length).toBe(120);
    expect(desc.endsWith('…')).toBe(true);
  });

  test('falls back to the raw args when there is no wrapper', () => {
    expect(describeCommand('/bin/zsh -c   while :; do :; done')).toBe('/bin/zsh -c while :; do :; done');
  });
});

// ── classify ──────────────────────────────────────────────────────────────

describe('classify', () => {
  test('the incident: orphaned childless busy loops of a finished command (R1)', () => {
    const loops = [];
    for (let i = 0; i < 38; i++) loops.push(row(78100 + i, 1, 78071, 20.7, toolShellArgs(STRESS_CMD)));
    const out = classify([LAUNCHD, APP, CLI, ...loops]);
    expect(out).toHaveLength(38);
    expect(new Set(out.map(o => o.rule))).toEqual(new Set([RULE_LEFTOVER_LOOP]));
    expect(out[0].command.startsWith('cd /tmp/narvi-mut && for i in')).toBe(true);
  });

  test('the tool shell of a running command is left alone: its CLI is alive', () => {
    const shell = row(700, CLI.pid, 700, 0.3, toolShellArgs('go test -race ./...'));
    const goTest = row(701, 700, 700, 380, 'go test -race ./...');
    expect(classify([LAUNCHD, APP, CLI, shell, goTest])).toEqual([]);
  });

  test('a busy loop whose tool shell is still alive belongs to the CLI, not to us', () => {
    const shell = row(700, CLI.pid, 700, 0.0, toolShellArgs('(while :; do :; done) & sleep 30'));
    const loop = row(701, 700, 700, 99, toolShellArgs('(while :; do :; done) & sleep 30'));
    const sleep = row(702, 700, 700, 0, 'sleep 30');
    expect(classify([LAUNCHD, APP, CLI, shell, loop, sleep])).toEqual([]);
  });

  test('an idle orphan is not touched, even childless', () => {
    const poll = row(800, 1, 790, 0.2, toolShellArgs('(while :; do gh pr checks 1; sleep 45; done) &'));
    expect(classify([LAUNCHD, APP, poll])).toEqual([]);
  });

  test('an orphaned dev server is not touched: the subshell is idle and has a child', () => {
    const sub = row(810, 1, 805, 0.0, toolShellArgs('(cd web && npm run dev) &'));
    const node = row(811, 810, 805, 65, 'node next dev');
    expect(classify([LAUNCHD, APP, sub, node])).toEqual([]);
  });

  test('a hot orphaned leaf that is not a Claude tool shell is none of our business', () => {
    const stranger = row(900, 1, 900, 100, '/bin/zsh -c while :; do :; done');
    expect(classify([LAUNCHD, APP, stranger])).toEqual([]);
  });

  test('an abandoned tool shell whose group burns CPU dies as a group (R2)', () => {
    // The CLI (pid 600) is gone: its tool shell is re-parented and still runs the tests.
    const shell = row(700, 1, 700, 0.3, toolShellArgs('go test -race ./...'));
    const goTest = row(701, 700, 700, 380, 'go test -race ./...');
    const out = classify([LAUNCHD, APP, shell, goTest]);
    expect(out).toEqual([
      expect.objectContaining({ pid: 700, pgid: 700, rule: RULE_ABANDONED_SHELL, cpu: 380.3 }),
    ]);
  });

  test('an abandoned tool shell whose group is idle is left alone', () => {
    const shell = row(700, 1, 700, 0.0, toolShellArgs('npm run dev'));
    const node = row(701, 700, 700, 1.2, 'node next dev');
    expect(classify([LAUNCHD, APP, shell, node])).toEqual([]);
  });

  test('recognises a tool shell by the cwd file alone when snapshots are off', () => {
    const args = "/bin/zsh -c eval 'while :; do :; done' < /dev/null && pwd -P >| /tmp/claude-a1b2-cwd";
    expect(classify([LAUNCHD, row(950, 1, 940, 98, args)])).toHaveLength(1);
  });

  test('the parent being missing from the listing counts as orphaned', () => {
    const loop = row(78100, 77000, 78071, 50, toolShellArgs(STRESS_CMD));
    expect(classify([LAUNCHD, APP, loop])).toHaveLength(1);
  });

  test('honours a custom CPU threshold', () => {
    const loop = row(78100, 1, 78071, 10, toolShellArgs(STRESS_CMD));
    expect(classify([LAUNCHD, loop], { cpuThreshold: 20 })).toEqual([]);
    expect(classify([LAUNCHD, loop], { cpuThreshold: 10 })).toHaveLength(1);
  });
});

// ── sweep ─────────────────────────────────────────────────────────────────

function makeReaper(listings, overrides = {}) {
  let i = 0;
  const kills = [];
  const alive = new Set();
  const reaper = new OrphanReaper({
    listProcesses: async () => listings[Math.min(i++, listings.length - 1)],
    kill: (pid, signal) => { kills.push([pid, signal]); },
    isAlive: pid => alive.has(pid),
    isEnabled: () => true,
    delay: async () => {},
    ...overrides,
  });
  return { reaper, kills, alive };
}

describe('OrphanReaper.sweep', () => {
  const loop = row(78100, 1, 78071, 40, toolShellArgs(STRESS_CMD));
  const listing = [LAUNCHD, APP, CLI, loop];

  test('kills nothing on first sight, then SIGTERMs on the confirming sweep', async () => {
    const { reaper, kills } = makeReaper([listing, listing]);
    expect((await reaper.sweep()).reaped).toEqual([]);
    expect(kills).toEqual([]);
    const second = await reaper.sweep();
    expect(kills).toEqual([[78100, 'SIGTERM']]);
    expect(second.reaped).toEqual([expect.objectContaining({ pid: 78100, rule: RULE_LEFTOVER_LOOP, cpu: 40 })]);
    expect(second.reaped[0]).not.toHaveProperty('target');
  });

  test('a suspect that vanished between sweeps starts over', async () => {
    const { reaper, kills } = makeReaper([listing, [LAUNCHD, APP, CLI], listing]);
    await reaper.sweep();
    await reaper.sweep();
    await reaper.sweep();
    expect(kills).toEqual([]);
  });

  test('a suspect whose rule changed starts over', async () => {
    // First seen as a leaf loop, then it forked a child and became a group leader.
    const asLeader = row(78100, 1, 78100, 40, toolShellArgs(STRESS_CMD));
    const child = row(78101, 78100, 78100, 0, 'sleep 5');
    const { reaper, kills } = makeReaper([listing, [LAUNCHD, asLeader, child]]);
    await reaper.sweep();
    await reaper.sweep();
    expect(kills).toEqual([]);
  });

  test('escalates to SIGKILL for what survives the grace', async () => {
    const { reaper, kills, alive } = makeReaper([listing, listing]);
    alive.add(78100);
    await reaper.sweep();
    await reaper.sweep();
    expect(kills).toEqual([[78100, 'SIGTERM'], [78100, 'SIGKILL']]);
  });

  test('addresses an abandoned shell by its process group', async () => {
    const shell = row(700, 1, 700, 0.3, toolShellArgs('go test -race ./...'));
    const goTest = row(701, 700, 700, 380, 'go test -race ./...');
    const l = [LAUNCHD, APP, shell, goTest];
    const { reaper, kills } = makeReaper([l, l]);
    await reaper.sweep();
    const { reaped } = await reaper.sweep();
    expect(kills).toEqual([[-700, 'SIGTERM']]);
    expect(reaped).toEqual([expect.objectContaining({ pid: 700, rule: RULE_ABANDONED_SHELL })]);
  });

  test('a kill that throws is dropped from the report', async () => {
    const { reaper } = makeReaper([listing, listing], {
      kill: () => { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; },
    });
    await reaper.sweep();
    expect((await reaper.sweep()).reaped).toEqual([]);
  });

  test('reports what it stopped to listeners and to the window', async () => {
    const { reaper } = makeReaper([listing, listing]);
    const seen = [];
    reaper.onReaped(r => seen.push(r));
    const send = jest.fn();
    reaper.setMainWindow({ isDestroyed: () => false, webContents: { send } });
    await reaper.sweep();
    await reaper.sweep();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ items: [expect.objectContaining({ pid: 78100 })], totalCpu: 40 });
    expect(send).toHaveBeenCalledWith('orphan-reaper:reaped', seen[0]);
  });

  test('does nothing while the setting is off, and forgets its suspects', async () => {
    let enabled = false;
    const { reaper, kills } = makeReaper([listing, listing, listing], { isEnabled: () => enabled });
    await reaper.sweep();
    enabled = true;
    await reaper.sweep();
    expect(kills).toEqual([]);
    await reaper.sweep();
    expect(kills).toEqual([[78100, 'SIGTERM']]);
  });

  test('waits the grace before checking survivors', async () => {
    const delays = [];
    const { reaper } = makeReaper([listing, listing], { delay: async ms => { delays.push(ms); } });
    await reaper.sweep();
    await reaper.sweep();
    expect(delays).toEqual([KILL_GRACE_MS]);
  });
});

// `start()` branches on the platform, so both branches are pinned to a stubbed
// one: read off the runner instead, each assertion would only ever exercise the
// half that runner happens to be — and the Windows leg of CI would run the
// POSIX expectations against a real win32 no-op.
function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

describe('OrphanReaper.start', () => {
  test('is a no-op on Windows', () => {
    withPlatform('win32', () => {
      const reaper = new OrphanReaper({ listProcesses: async () => [] });
      reaper.start();
      expect(reaper._timer).toBeNull();
      expect(reaper._firstTimer).toBeNull();
      reaper.stop();
    });
  });

  test('arms the first sweep on POSIX, and stop() disarms it', () => {
    jest.useFakeTimers();
    try {
      withPlatform('darwin', () => {
        const reaper = new OrphanReaper({ listProcesses: async () => [] });
        reaper.start();
        expect(reaper._firstTimer).not.toBeNull();
        reaper.stop();
        expect(reaper._firstTimer).toBeNull();
        expect(reaper._timer).toBeNull();
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
