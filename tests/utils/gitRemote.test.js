/**
 * @jest-environment node
 *
 * git.js for remote (SSH) projects (design/remote-ssh.md section 5.4).
 *
 * Two levels:
 *   - a scripted executor stands in for SshHostService, so the exact script,
 *     the read/write flag, the cache and the failure mapping can be asserted;
 *   - a real local `sh` runs the very scripts git.js builds against real
 *     repositories, the way the remote driver would (`eval` of one line), so
 *     the quoting, the stats and TODO scans and the untracked-head reader are
 *     exercised for real. Skipped where no sh or git is installed.
 *
 * The local side is pinned separately by tests/utils/gitLocalArgv.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const git = require('../../src/main/utils/git');
const remotePath = require('../../src/shared/remote-path');
const { createTargetResolver, createWorktreeRegistry } = require('../../src/main/utils/projectTarget');
const { findSh, toShPath } = require('../helpers/fake-ssh');

const PROFILE = 'abcd1234';
const URI = `ssh-remote://${PROFILE}/home/u/api`;

/** A scripted executor: every request is recorded and answered by `respond`. */
function scriptedExecutor(respond = () => ({ ok: true, code: 0, stdout: '', stderr: '' })) {
  const calls = [];
  return {
    calls,
    resolve: jest.fn(async (uri) => {
      const { profileId, path: p } = remotePath.parse(uri);
      return { kind: 'remote', profileId, remotePath: p, uri };
    }),
    exec: jest.fn(async (target, script, options) => {
      calls.push({ target, script, options });
      const res = await respond(script, options, target);
      return {
        ok: !!res.ok,
        code: res.code === undefined ? (res.ok ? 0 : 1) : res.code,
        reason: res.reason,
        stdout: Buffer.from(res.stdout || ''),
        stderr: Buffer.from(res.stderr || ''),
      };
    }),
    isConnected: () => true,
  };
}

let clock = 1_000_000;
beforeEach(() => {
  clock = 1_000_000;
  git._remoteInternals.reset();
  git._remoteInternals.setNow(() => clock);
});
afterAll(() => {
  git._remoteInternals.setExecutor(null);
  git._remoteInternals.setNow(null);
});

function use(executor) {
  git._remoteInternals.setExecutor(executor);
  return executor;
}

// ── Script construction ─────────────────────────────────────────────────────

describe('remote command construction', () => {
  test('execGitResult runs `cd -- dir && GIT_TERMINAL_PROMPT=0 exec git -c protocol.ext.allow=never <args>` on the host', async () => {
    const ex = use(scriptedExecutor(() => ({ ok: true, stdout: 'main\n' })));
    const res = await git.execGitResult(URI, ['checkout', "feat/it's $HOME x"]);
    expect(res).toEqual({ ok: true, output: 'main', reason: null, error: null });
    expect(ex.exec).toHaveBeenCalledTimes(1);
    const { script, options, target } = ex.calls[0];
    expect(target.profileId).toBe(PROFILE);
    expect(script).toBe(
      "[ -d '/home/u/api' ] || exit 96; cd -- '/home/u/api' && GIT_TERMINAL_PROMPT=0 exec git -c protocol.ext.allow=never 'checkout' 'feat/it'\\''s $HOME x'"
    );
    expect(script).not.toContain('safe.directory');
    expect(options.write).toBe(true);
    expect(options.timeoutMs).toBe(10000);
  });

  test('a repository path with spaces, quotes and $ is quoted as one word', async () => {
    const ex = use(scriptedExecutor());
    const uri = `ssh-remote://${PROFILE}/home/u/my 'proj' $dir`;
    await git.execGitResult(uri, ['status', '--porcelain']);
    expect(ex.calls[0].script).toContain("cd -- '/home/u/my '\\''proj'\\'' $dir' && GIT_TERMINAL_PROMPT=0 exec git -c protocol.ext.allow=never 'status' '--porcelain'");
    expect(ex.calls[0].options.write).toBe(false);
  });

  test('spawnGit routes the same way and keeps its { success, output } contract', async () => {
    const ex = use(scriptedExecutor(() => ({ ok: true, stdout: '', stderr: "Switched to branch 'x'" })));
    const res = await git.spawnGit(URI, ['checkout', 'x']);
    expect(res).toEqual({ success: true, output: "Switched to branch 'x'" });
    expect(ex.calls[0].script).toContain("exec git -c protocol.ext.allow=never 'checkout' 'x'");
    expect(ex.calls[0].options.timeoutMs).toBe(15000);
  });

  test('a control character in an argument is refused before anything is sent', async () => {
    const ex = use(scriptedExecutor());
    const res = await git.execGitResult(URI, ['checkout', 'two\nlines']);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('badargs');
    expect(ex.exec).not.toHaveBeenCalled();
  });

  test('a multi-line commit message travels on stdin as `-F -`, never on the command line', async () => {
    const ex = use(scriptedExecutor(() => ({ ok: true, stdout: '[main abc1234] feat: subject\n' })));
    const message = 'feat: subject\n\n- first point\n\tindented';
    const res = await git.gitCommit(URI, message);
    expect(res.success).toBe(true);
    const { script, options } = ex.calls[0];
    expect(script).toContain("exec git -c protocol.ext.allow=never 'commit' '-F' '-'");
    expect(script).not.toContain('first point');
    expect(Buffer.isBuffer(options.input)).toBe(true);
    expect(options.input.toString('utf8')).toBe(message);
    expect(options.write).toBe(true);
  });

  test('a one-line commit message keeps its `-m` script and sends no stdin', async () => {
    const ex = use(scriptedExecutor(() => ({ ok: true })));
    await git.gitCommit(URI, 'fix: one line');
    expect(ex.calls[0].script).toContain("'commit' '-m' 'fix: one line'");
    expect(ex.calls[0].options.input).toBeUndefined();
  });

  test('an annotated tag with a multi-line message uses `-F -` as well', async () => {
    const ex = use(scriptedExecutor(() => ({ ok: true })));
    await git.createTag(URI, 'v1.0.0', 'Release 1.0\n\nNotes');
    expect(ex.calls[0].script).toContain("'tag' '-a' 'v1.0.0' '-F' '-'");
    expect(ex.calls[0].options.input.toString('utf8')).toBe('Release 1.0\n\nNotes');
  });

  test('a path refused by the resolver never reaches the host and reads as nodir', async () => {
    const ex = use(scriptedExecutor());
    ex.resolve.mockRejectedValueOnce(Object.assign(new Error('Remote path is not inside a registered remote project'), { code: 'REMOTE_PATH_NOT_IN_PROJECT' }));
    const res = await git.execGitResult(`ssh-remote://${PROFILE}/etc`, ['status']);
    expect(res).toMatchObject({ ok: false, reason: 'nodir' });
    expect(ex.exec).not.toHaveBeenCalled();
  });
});

// ── Failure mapping ─────────────────────────────────────────────────────────

describe('failure mapping', () => {
  const cases = [
    ['a missing directory (exit 96)', { ok: false, code: 96, stderr: '' }, 'nodir'],
    ['git not installed (exit 127)', { ok: false, code: 127, stderr: 'sh: exec: git: not found' }, 'enoent'],
    ['the transport being down', { ok: false, code: null, reason: 'disconnected' }, 'disconnected'],
    ['a timeout', { ok: false, code: null, reason: 'timeout' }, 'timeout'],
    ['an ordinary git failure', { ok: false, code: 128, stderr: 'fatal: not a git repository' }, 'exit'],
  ];

  test.each(cases)('%s', async (_name, answer, reason) => {
    use(scriptedExecutor(() => answer));
    const res = await git.execGitResult(URI, ['status']);
    expect(Object.keys(res).sort()).toEqual(['error', 'ok', 'output', 'reason']);
    expect(res).toMatchObject({ ok: false, output: '', reason });
    expect(typeof res.error).toBe('string');

    git._remoteInternals.reset();
    const spawned = await git.spawnGit(URI, ['push']);
    expect(Object.keys(spawned).sort()).toEqual(['error', 'reason', 'success']);
    expect(spawned).toMatchObject({ success: false, reason });
  });

  test('git stderr is the error of an ordinary failure', async () => {
    use(scriptedExecutor(() => ({ ok: false, code: 128, stderr: 'fatal: not a git repository\n' })));
    const res = await git.execGitResult(URI, ['status']);
    expect(res.error).toBe('fatal: not a git repository');
  });

  test('a disconnected host is not "not a git repository"', async () => {
    use(scriptedExecutor(() => ({ ok: false, code: null, reason: 'disconnected' })));
    expect(await git.getGitStatusDetailed(URI)).toMatchObject({ success: false, reason: 'disconnected' });
    expect(await git.getGitInfo(URI)).toMatchObject({ isGitRepo: false, disconnected: true, reason: 'disconnected' });
    expect(await git.getGitStatusQuick(URI)).toMatchObject({ isGitRepo: false, disconnected: true });
  });
});

// ── Read cache ──────────────────────────────────────────────────────────────

describe('read cache', () => {
  test('classifies reads and writes', () => {
    const reads = [
      ['status', '--porcelain'], ['rev-parse', '--abbrev-ref', 'HEAD'], ['branch', '--format=%(refname:short)'],
      ['branch', '-r', '--format=%(refname:short)'], ['log', '-1'], ['diff', '--numstat'], ['remote', 'get-url', 'origin'],
      ['remote', '-v'], ['stash', 'list'], ['tag', '-l'], ['worktree', 'list', '--porcelain'], ['shortlog', '-sn'],
    ];
    const writes = [
      ['checkout', 'x'], ['branch', '-D', 'x'], ['branch', '-m', 'a', 'b'], ['commit', '-m', 'x'], ['push'], ['fetch'],
      ['stash'], ['stash', 'pop'], ['tag', 'v1'], ['remote', 'add', 'o', 'u'], ['worktree', 'add', 'p'], ['reset', '--hard'],
      ['clean', '-f'], ['init'], ['something-new'],
    ];
    for (const a of reads) expect([a, git.isReadOnlyGitCommand(a)]).toEqual([a, true]);
    for (const a of writes) expect([a, git.isReadOnlyGitCommand(a)]).toEqual([a, false]);
  });

  test('the Git panel and the file explorer polling the same status share one request within 2 s', async () => {
    const ex = use(scriptedExecutor((script) => ({ ok: true, stdout: script.includes("'status'") ? ' M a.js\n' : '' })));
    // FileExplorer and GitChangesPanel both call git-status-detailed: 3 git
    // commands each, issued at the same time and again a second later.
    await Promise.all([git.getGitStatusDetailed(URI), git.getGitStatusDetailed(URI)]);
    clock += 1000;
    const again = await git.getGitStatusDetailed(URI);
    expect(again).toMatchObject({ success: true, files: [{ path: 'a.js', status: 'M' }] });
    expect(ex.exec).toHaveBeenCalledTimes(3);

    clock += 2500;
    await git.getGitStatusDetailed(URI);
    expect(ex.exec).toHaveBeenCalledTimes(6);
  });

  test('a write on the host drops the cache, so the next read is fresh', async () => {
    const ex = use(scriptedExecutor());
    await git.execGitResult(URI, ['status', '--porcelain']);
    await git.execGitResult(URI, ['status', '--porcelain']);
    expect(ex.exec).toHaveBeenCalledTimes(1);
    await git.gitStageFiles(URI, ['a.js']);
    expect(ex.calls[1].options.write).toBe(true);
    await git.execGitResult(URI, ['status', '--porcelain']);
    expect(ex.exec).toHaveBeenCalledTimes(3);
  });

  test('a read that was in flight while a write ran is not cached', async () => {
    let releaseRead = null;
    let held = false;
    const ex = use(scriptedExecutor((script) => {
      if (script.includes("'status'") && !held) {
        held = true;
        return new Promise((resolve) => { releaseRead = () => resolve({ ok: true, stdout: 'old' }); });
      }
      return { ok: true, stdout: 'new' };
    }));
    const read = git.execGitResult(URI, ['status']);
    await new Promise((r) => setImmediate(r));
    await git.spawnGit(URI, ['commit', '-m', 'x']);
    releaseRead();
    expect((await read).output).toBe('old');
    expect((await git.execGitResult(URI, ['status'])).output).toBe('new');
    expect(ex.calls.filter((c) => c.script.includes("'status'"))).toHaveLength(2);
  });

  test('a dropped connection or a timeout is never cached', async () => {
    let answer = { ok: false, code: null, reason: 'disconnected' };
    const ex = use(scriptedExecutor(() => answer));
    expect((await git.execGitResult(URI, ['status'])).reason).toBe('disconnected');
    answer = { ok: true, stdout: 'clean' };
    expect((await git.execGitResult(URI, ['status'])).output).toBe('clean');
    expect(ex.exec).toHaveBeenCalledTimes(2);
  });

  test('two directories on the same host do not share answers', async () => {
    const ex = use(scriptedExecutor());
    await git.execGitResult(URI, ['status']);
    await git.execGitResult(`ssh-remote://${PROFILE}/home/u/other`, ['status']);
    expect(ex.exec).toHaveBeenCalledTimes(2);
  });
});

// ── Cancellation ────────────────────────────────────────────────────────────

describe('killAllGitProcesses', () => {
  test('cancels in-flight remote requests', async () => {
    const seen = [];
    use(scriptedExecutor((_script, options) => new Promise((resolve) => {
      seen.push(options.signal);
      options.signal.addEventListener('abort', () => resolve({ ok: false, code: null, reason: 'cancelled' }));
    })));
    const read = git.execGitResult(URI, ['log', '-1']);
    const write = git.spawnGit(URI, ['fetch']);
    await new Promise((r) => setImmediate(r));
    expect(git._remoteInternals.pending()).toBe(2);
    git.killAllGitProcesses();
    expect(seen.every((s) => s.aborted)).toBe(true);
    expect(await read).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(await write).toMatchObject({ success: false, reason: 'cancelled' });
    expect(git._remoteInternals.pending()).toBe(0);
  });

  test('answers at once even when the transport ignores the signal', async () => {
    use(scriptedExecutor(() => new Promise(() => {})));
    const read = git.execGitResult(URI, ['status']);
    await new Promise((r) => setImmediate(r));
    git.killAllGitProcesses();
    expect(await read).toMatchObject({ ok: false, reason: 'cancelled' });
  });
});

// ── Remote-only variants of the local-fs helpers ────────────────────────────

describe('pure-git variants', () => {
  test('isMergeInProgress asks for MERGE_HEAD instead of statting a local file', async () => {
    const ex = use(scriptedExecutor(() => ({ ok: true, stdout: 'abc123\n' })));
    expect(await git.isMergeInProgress(URI)).toBe(true);
    expect(ex.calls[0].script).toContain("'rev-parse' '-q' '--verify' 'MERGE_HEAD'");
  });

  test('isRebaseInProgress checks both rebase directories in one request', async () => {
    const ex = use(scriptedExecutor(() => ({ ok: false, code: 1 })));
    expect(await git.isRebaseInProgress(URI)).toBe(false);
    expect(ex.exec).toHaveBeenCalledTimes(1);
    expect(ex.calls[0].script).toContain('rev-parse --git-path rebase-merge');
    expect(ex.calls[0].script).toContain('rev-parse --git-path rebase-apply');
    expect(ex.calls[0].options.write).toBe(false);
  });

  test('detectWorktree resolves POSIX paths and answers with a URI', async () => {
    use(scriptedExecutor((script) => ({
      ok: true,
      stdout: script.includes('--git-common-dir') ? '/home/u/api/.git' : '/home/u/api/.git/worktrees/feat',
    })));
    const uri = `ssh-remote://${PROFILE}/home/u/api-feat`;
    expect(await git.detectWorktree(uri)).toEqual({ isWorktree: true, mainRepoPath: URI });
  });

  test('detectWorktree on a main repository with relative git dirs', async () => {
    use(scriptedExecutor(() => ({ ok: true, stdout: '.git' })));
    expect(await git.detectWorktree(URI)).toEqual({ isWorktree: false });
  });

  test('gitDiscardFiles removes untracked paths with git clean, never a local rm', async () => {
    const ex = use(scriptedExecutor((script) => ({
      ok: true,
      stdout: script.includes("'status'") ? ' M tracked.js\u0000?? new file.js\u0000?? build/\u0000' : '',
    })));
    const res = await git.gitDiscardFiles(URI, ['tracked.js', 'new file.js', 'build/']);
    expect(res).toEqual({ success: true, output: 'Discarded 3 file(s)' });
    const scripts = ex.calls.map((c) => c.script);
    expect(scripts.some((s) => s.includes("'restore' '--' 'tracked.js'"))).toBe(true);
    expect(scripts.some((s) => s.includes("'clean' '-f' '-d' '--' 'new file.js' 'build/'"))).toBe(true);
  });
});

// ── Worktrees ───────────────────────────────────────────────────────────────

describe('worktrees', () => {
  const LIST = [
    'worktree /home/u/api', 'HEAD 1111', 'branch refs/heads/main', '',
    "worktree /home/u/api-it's feat", 'HEAD 2222', 'branch refs/heads/feat', '',
  ].join('\n');

  test('getWorktrees answers with URIs on the same host', async () => {
    use(scriptedExecutor(() => ({ ok: true, stdout: LIST })));
    const trees = await git.getWorktrees(URI);
    expect(trees.map((t) => t.path)).toEqual([URI, `ssh-remote://${PROFILE}/home/u/api-it's feat`]);
    expect(trees[0].isMain).toBe(true);
  });

  test('createWorktree sends the POSIX path of a URI on the same host', async () => {
    const ex = use(scriptedExecutor(() => ({ ok: true, stderr: 'Preparing worktree' })));
    const res = await git.createWorktree(URI, `ssh-remote://${PROFILE}/home/u/api-feat`, { newBranch: 'feat', startPoint: 'main' });
    expect(res).toEqual({ success: true, output: 'Preparing worktree' });
    expect(ex.calls[0].script).toContain("exec git -c protocol.ext.allow=never 'worktree' 'add' '-b' 'feat' '/home/u/api-feat' 'main'");
    expect(ex.calls[0].options.write).toBe(true);
  });

  test('a worktree on another host, a local path or the root is refused before anything runs', async () => {
    const ex = use(scriptedExecutor());
    for (const bad of ['ssh-remote://zzzz9999/home/u/x', 'C:\\work\\x', '/home/u/x', `ssh-remote://${PROFILE}/`]) {
      const res = await git.createWorktree(URI, bad, { branch: 'b' });
      expect(res.success).toBe(false);
      expect((await git.removeWorktree(URI, bad, true)).success).toBe(false);
      expect((await git.lockWorktree(URI, bad)).success).toBe(false);
      expect((await git.unlockWorktree(URI, bad)).success).toBe(false);
    }
    expect(ex.exec).not.toHaveBeenCalled();
  });

  test('remove, lock, unlock and prune run on the host with the POSIX path', async () => {
    const ex = use(scriptedExecutor());
    const tree = `ssh-remote://${PROFILE}/home/u/api-feat`;
    expect(await git.removeWorktree(URI, tree, git.FORCE_UNLOCK)).toEqual({ success: true, output: 'Worktree removed' });
    expect(await git.lockWorktree(URI, tree, 'busy')).toEqual({ success: true, output: 'Worktree locked' });
    expect(await git.unlockWorktree(URI, tree)).toEqual({ success: true, output: 'Worktree unlocked' });
    expect(await git.pruneWorktrees(URI)).toEqual({ success: true, output: 'Worktrees pruned' });
    const scripts = ex.calls.map((c) => c.script);
    expect(scripts[0]).toContain("'worktree' 'remove' '--force' '--force' '/home/u/api-feat'");
    expect(scripts[1]).toContain("'worktree' 'lock' '--reason' 'busy' '/home/u/api-feat'");
    expect(scripts[2]).toContain("'worktree' 'unlock' '/home/u/api-feat'");
    expect(scripts[3]).toContain("'worktree' 'prune'");
  });

  test('execGitCallback emulates execFile errors for a remote path', async () => {
    use(scriptedExecutor(() => ({ ok: false, code: 128, stderr: 'fatal: invalid reference' })));
    const { error, stderr } = await new Promise((resolve) => {
      git.execGitCallback(URI, ['-c', 'safe.directory=x'], ['branch', '-D', 'gone'], { timeout: 10000 }, (e, out, err) => resolve({ error: e, stderr: err }));
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(128);
    expect(error.reason).toBe('exit');
    expect(stderr).toBe('fatal: invalid reference');
  });

  test('a worktree learned from git resolves like its project, and only then', async () => {
    const worktrees = createWorktreeRegistry();
    const projects = [{ id: 'p1', path: URI, remote: { profileId: PROFILE, path: '/home/u/api' } }];
    const discoverWorktrees = jest.fn(async (profileId, uris) => {
      expect(uris).toEqual([URI]);
      worktrees.note(profileId, ['/home/u/api', '/home/u/api-feat', '/']);
    });
    const resolver = createTargetResolver({
      getProfile: async (id) => (id === PROFILE ? { id, host: 'h' } : null),
      loadProjects: async () => projects,
      worktrees,
      discoverWorktrees,
    });
    const target = await resolver.resolveTarget(`ssh-remote://${PROFILE}/home/u/api-feat/src`);
    expect(target).toMatchObject({ kind: 'remote', remotePath: '/home/u/api-feat/src', projectRoot: '/home/u/api-feat', project: projects[0] });
    expect(discoverWorktrees).toHaveBeenCalledTimes(1);
    // `/` is never a worktree root, so the rest of the host stays out of reach.
    await expect(resolver.resolveTarget(`ssh-remote://${PROFILE}/etc`)).rejects.toMatchObject({ code: 'REMOTE_PATH_NOT_IN_PROJECT' });
  });
});

// ── Stats ───────────────────────────────────────────────────────────────────

describe('remote project stats', () => {
  test('parses the stats output, skipping wc totals', () => {
    const out = [
      '@@CT-STATS-ENTRIES@@', 'package.json', 'src', 'Cargo.toml',
      '@@CT-STATS-PACKAGE@@', '{"dependencies":{"react":"1"},"devDependencies":{"jest":"1"}}',
      '@@CT-STATS-LINES@@', '  10 src/a.js', '   4 ./b.PY', '  14 total', '   2 total', '',
    ].join('\n');
    expect(git.parseRemoteStats(out)).toEqual({
      total: 16, files: 2,
      byExtension: { '.js': { files: 1, lines: 11 }, '.py': { files: 1, lines: 5 } },
      rootEntries: ['package.json', 'src', 'Cargo.toml'],
      packageDeps: ['react', 'jest'],
    });
  });

  test('one request, cached for a minute, with the type-detection extras', async () => {
    const out = '@@CT-STATS-ENTRIES@@\ngo.mod\n@@CT-STATS-PACKAGE@@\n\n@@CT-STATS-LINES@@\n  3 main.go\n';
    const ex = use(scriptedExecutor(() => ({ ok: true, stdout: out })));
    const stats = await git.getProjectStats(URI);
    expect(stats).toEqual({ lines: 4, files: 1, byExtension: { '.go': { files: 1, lines: 4 } }, remote: true, rootEntries: ['go.mod'], packageDeps: [] });
    await git.getProjectStats(URI);
    expect(ex.exec).toHaveBeenCalledTimes(1);
    expect(ex.calls[0].options.write).toBe(false);
  });

  test('a host that cannot answer gives zeros and the reason', async () => {
    use(scriptedExecutor(() => ({ ok: false, code: null, reason: 'disconnected' })));
    expect(await git.getProjectStats(URI)).toMatchObject({ lines: 0, files: 0, reason: 'disconnected' });
  });
});

// ── Against a real sh ───────────────────────────────────────────────────────

const SH = findSh();
let GIT_OK = false;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); GIT_OK = true; } catch { /* no git */ }
const describeSh = SH && GIT_OK ? describe : describe.skip;

/** Run one script the way the remote driver does: a local sh reading one line. */
function shExecutor() {
  return {
    resolve: async (uri) => {
      const { profileId, path: p } = remotePath.parse(uri);
      return { kind: 'remote', profileId, remotePath: p, uri };
    },
    exec: async (_target, script, options = {}) => {
      const env = { ...process.env, LC_ALL: 'C' };
      if (options.input) {
        // A PUT: the script reads the bytes on stdin, so the script itself
        // goes through a file rather than through the same stdin.
        const file = path.join(os.tmpdir(), `ct-git-remote-${process.pid}-${Date.now()}.sh`);
        fs.writeFileSync(file, `${script}\n`);
        try {
          const r = spawnSync(SH, [toShPath(file)], { input: options.input, encoding: 'buffer', env, maxBuffer: 64 * 1024 * 1024 });
          return { ok: r.status === 0, code: r.status, stdout: r.stdout, stderr: r.stderr };
        } finally {
          try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
        }
      }
      // On stdin, as the driver receives it: an argv would be re-parsed by the
      // Windows command line (msys reads backslashes there), which no host does.
      const r = spawnSync(SH, ['-s'], { input: Buffer.from(`${script}\n`), encoding: 'buffer', env, maxBuffer: 64 * 1024 * 1024 });
      return { ok: r.status === 0, code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    isConnected: () => true,
  };
}

function gitIn(dir, ...args) {
  return execFileSync('git', ['-c', `safe.directory=${dir.replace(/\\/g, '/')}`, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describeSh('scripts executed by a real sh', () => {
  let root;
  let repo;
  let uri;

  beforeAll(() => {
    // Canonical from the start: git reports resolved paths, and the temp dir
    // is behind a symlink on macOS (/var -> /private/var).
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ct-git-remote-')));
    repo = path.join(root, "my 'repo' $x");
    fs.mkdirSync(repo);
    gitIn(repo, 'init', '-q');
    gitIn(repo, 'config', 'user.email', 't@example.com');
    gitIn(repo, 'config', 'user.name', 'T');
    gitIn(repo, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(repo, 'a.js'), '// TODO: first\nconst x = 1;\n');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'b.py'), 'x = 1\n# FIXME broken\n\n');
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.writeFileSync(path.join(repo, 'node_modules', 'dep.js'), '// TODO: not mine\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { express: '1' } }));
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-q', '-m', 'init');
    uri = remotePath.format(PROFILE, toShPath(repo));
  });

  afterAll(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(() => use(shExecutor()));

  test("a branch named with ' and $ survives the quoting both ways", async () => {
    const branch = "it's-$HOME-x";
    expect(await git.createBranch(uri, branch)).toMatchObject({ success: true });
    expect(await git.getCurrentBranch(uri)).toBe(branch);
    expect(gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch);
  });

  test('a commit message with a body is committed whole, through stdin', async () => {
    fs.writeFileSync(path.join(repo, 'c.txt'), 'body test\n');
    gitIn(repo, 'add', 'c.txt');
    const message = "feat: it's a $HOME subject\n\n- first point\n- second point";
    expect(await git.gitCommit(uri, message)).toMatchObject({ success: true });
    expect(gitIn(repo, 'log', '-1', '--format=%B').trim()).toBe(message);
  });

  test('a missing directory is nodir', async () => {
    const res = await git.execGitResult(remotePath.format(PROFILE, toShPath(path.join(root, 'gone'))), ['status']);
    expect(res).toMatchObject({ ok: false, reason: 'nodir' });
  });

  test('stats match the local count of the same tree', async () => {
    const remote = await git.getProjectStats(uri);
    const local = await git.getProjectStats(repo);
    expect({ lines: remote.lines, files: remote.files, byExtension: remote.byExtension })
      .toEqual({ lines: local.lines, files: local.files, byExtension: local.byExtension });
    expect(remote.rootEntries).toEqual(expect.arrayContaining(['a.js', 'src', 'package.json']));
    expect(remote.packageDeps).toEqual(['express']);
  });

  test('the TODO grep finds tracked and untracked lines and skips node_modules', async () => {
    fs.writeFileSync(path.join(repo, 'new.ts'), 'let a; // HACK: untracked\n');
    const res = await git.grepTodoCandidates(uri, { extensions: ['.js', '.ts', '.py'], ignoreDirs: ['node_modules', 'dist'] });
    fs.rmSync(path.join(repo, 'new.ts'));
    expect(res.ok).toBe(true);
    const files = res.lines.map((l) => `${l.file}:${l.line}`).sort();
    expect(files).toEqual(['a.js:1', 'new.ts:1', 'src/b.py:2']);
  });

  test('the TODO grep falls back to grep outside a repository', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(path.join(plain, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(plain, 'x.js'), 'ok\n/* XXX check */\n');
    fs.writeFileSync(path.join(plain, 'dist', 'y.js'), '// TODO built\n');
    const res = await git.grepTodoCandidates(remotePath.format(PROFILE, toShPath(plain)), { extensions: ['.js'], ignoreDirs: ['dist'] });
    expect(res.lines).toEqual([{ file: 'x.js', line: 2, text: '/* XXX check */' }]);
  });

  test('untracked heads: directories, large files, the first bytes, missing and odd names', async () => {
    fs.mkdirSync(path.join(repo, 'newdir'));
    fs.writeFileSync(path.join(repo, 'newdir', 'k'), 'k');
    fs.writeFileSync(path.join(repo, 'big.bin'), Buffer.alloc(600000, 0x61));
    fs.writeFileSync(path.join(repo, "it's a file.txt"), 'x'.repeat(5000));
    fs.writeFileSync(path.join(repo, 'empty.txt'), '');
    const heads = await git.readUntrackedHeads(uri, ['newdir/', 'big.bin', "it's a file.txt", 'empty.txt', 'nope.txt', '../escape', '/etc/passwd']);
    expect(heads.get('newdir/')).toEqual({ kind: 'dir' });
    expect(heads.get('big.bin')).toEqual({ kind: 'large', size: 600000 });
    expect(heads.get("it's a file.txt")).toEqual({ kind: 'file', size: 5000, content: 'x'.repeat(3000) });
    expect(heads.get('empty.txt')).toEqual({ kind: 'file', size: 0, content: '' });
    expect(heads.get('nope.txt')).toEqual({ kind: 'missing' });
    expect(heads.get('../escape')).toEqual({ kind: 'missing' });
    expect(heads.get('/etc/passwd')).toEqual({ kind: 'missing' });
    for (const p of ['newdir', 'big.bin', "it's a file.txt", 'empty.txt']) fs.rmSync(path.join(repo, p), { recursive: true, force: true });
  });

  test('discarding an untracked file and directory goes through git clean', async () => {
    fs.writeFileSync(path.join(repo, 'junk.js'), 'x');
    fs.mkdirSync(path.join(repo, 'junkdir'));
    fs.writeFileSync(path.join(repo, 'junkdir', 'f'), 'x');
    fs.writeFileSync(path.join(repo, 'a.js'), 'changed\n');
    const res = await git.gitDiscardFiles(uri, ['junk.js', 'junkdir/', 'a.js']);
    expect(res).toEqual({ success: true, output: 'Discarded 3 file(s)' });
    expect(fs.existsSync(path.join(repo, 'junk.js'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'junkdir'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'a.js'), 'utf8')).toBe('// TODO: first\nconst x = 1;\n');
  });

  test('rebase and merge probes on a clean repository', async () => {
    expect(await git.isRebaseInProgress(uri)).toBe(false);
    expect(await git.isMergeInProgress(uri)).toBe(false);
  });

  // git for Windows prints drive-letter paths (C:/...), which no POSIX host
  // does; the POSIX CI runners exercise this one.
  const posixTest = process.platform === 'win32' ? test.skip : test;
  posixTest('a real worktree is detected and listed as URIs', async () => {
    const wt = path.join(root, 'wt-feat');
    expect(await git.createWorktree(uri, remotePath.format(PROFILE, toShPath(wt)), { newBranch: 'wt-feat' })).toMatchObject({ success: true });
    const wtUri = remotePath.format(PROFILE, toShPath(wt));
    expect(await git.detectWorktree(wtUri)).toEqual({ isWorktree: true, mainRepoPath: uri });
    const trees = await git.getWorktrees(uri);
    expect(trees.map((t) => t.path)).toEqual([uri, wtUri]);
    expect(await git.removeWorktree(uri, wtUri, true)).toMatchObject({ success: true });
  });
});
