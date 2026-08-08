'use strict';

/**
 * git node — exercised against a throwaway repo created by sb.gitRepo().
 *
 * No remote exists in the sandbox, so `pull` and `push` are only covered to the
 * extent of proving they fail fast instead of hanging on a network dial.
 */

const { assert } = require('../sandbox');

/** Current branch of the sandbox repo, via the raw git helper. */
function currentBranch(sb) {
  return sb.git('rev-parse', '--abbrev-ref', 'HEAD').trim();
}

/** Number of commits reachable from HEAD. */
function commitCount(sb) {
  return parseInt(sb.git('rev-list', '--count', 'HEAD').trim(), 10);
}

/** Porcelain status, trimmed — empty string means a clean working tree. */
function status(sb) {
  return sb.git('status', '--porcelain').trim();
}

module.exports = {
  type: 'git',
  scenarios: [
    {
      name: 'commit stages the working tree and records it in history',
      async setup(sb) {
        sb.git = sb.gitRepo().git;
        sb.file('feature.txt', 'new work\n');
      },
      config: (sb) => ({ action: 'commit', message: 'feat(lab): add feature', projectId: sb.dir }),
      assert(out, sb) {
        assert.strictEqual(out.success, true, `commit failed: ${JSON.stringify(out)}`);
        assert.strictEqual(out.action, 'commit');
        assert.strictEqual(sb.git('log', '-1', '--format=%s').trim(), 'feat(lab): add feature');
        assert.strictEqual(status(sb), '', 'working tree should be clean after commit');
        assert.strictEqual(commitCount(sb), 2);
      },
    },
    {
      name: 'commit only stages the files it was told to',
      async setup(sb) {
        sb.git = sb.gitRepo().git;
        sb.file('wanted.txt', 'in\n');
        sb.file('unwanted.txt', 'out\n');
      },
      config: (sb) => ({ action: 'commit', message: 'chore: partial', files: 'wanted.txt', projectId: sb.dir }),
      assert(out, sb) {
        assert.strictEqual(out.success, true, `commit failed: ${JSON.stringify(out)}`);
        const committed = sb.git('show', '--name-only', '--format=', 'HEAD').trim();
        assert.strictEqual(committed, 'wanted.txt', `unexpected files in commit: ${committed}`);
        assert.match(status(sb), /unwanted\.txt/, 'unwanted.txt should still be uncommitted');
      },
    },
    {
      name: 'commit with nothing to stage fails instead of creating an empty commit',
      async setup(sb) { sb.git = sb.gitRepo().git; },
      config: (sb) => ({ action: 'commit', message: 'chore: nothing', projectId: sb.dir }),
      assert(out, sb) {
        assert.strictEqual(out.success, false, 'an empty commit should not be reported as a success');
        assert.strictEqual(commitCount(sb), 1, 'history grew despite there being nothing to commit');
      },
    },
    {
      name: 'checkout switches HEAD to an existing branch',
      async setup(sb) {
        sb.git = sb.gitRepo().git;
        sb.git('branch', 'feature/x');
      },
      config: (sb) => ({ action: 'checkout', branch: 'feature/x', projectId: sb.dir }),
      assert(out, sb) {
        assert.strictEqual(out.success, true, `checkout failed: ${JSON.stringify(out)}`);
        assert.strictEqual(currentBranch(sb), 'feature/x');
      },
    },
    {
      name: 'checkout of a branch that does not exist fails and leaves HEAD where it was',
      async setup(sb) { sb.git = sb.gitRepo().git; },
      config: (sb) => ({ action: 'checkout', branch: 'does/not/exist', projectId: sb.dir }),
      assert(out, sb) {
        assert.strictEqual(out.success, false, 'checkout of a missing branch was reported as a success');
        assert.strictEqual(currentBranch(sb), 'main', 'HEAD moved despite the failed checkout');
      },
    },
    {
      name: 'a failed git action says why it failed',
      async setup(sb) { sb.gitRepo(); },
      config: (sb) => ({ action: 'checkout', branch: 'does/not/exist', projectId: sb.dir }),
      assert(out) {
        assert.strictEqual(out.success, false);
        // git itself reports "pathspec 'does/not/exist' did not match any file(s)
        // known to git". The node drops that text, so a workflow run log shows a
        // failed step with no reason at all.
        const reason = out.error || out.output || '';
        assert.ok(reason.trim().length > 0,
          `failed git step carried no diagnostic: ${JSON.stringify(out)}`);
      },
    },
    {
      name: 'the node refuses to create a branch it was asked to check out',
      async setup(sb) { sb.git = sb.gitRepo().git; },
      config: (sb) => ({ action: 'checkout', branch: 'feature/new', projectId: sb.dir }),
      assert(out, sb) {
        // There is no create-branch action: `checkout` is a plain `git checkout`,
        // so a workflow cannot open a new branch. Pinned so the limitation is
        // visible rather than discovered at runtime.
        assert.strictEqual(out.success, false);
        const branches = sb.git('branch', '--format=%(refname:short)').trim().split('\n');
        assert.deepStrictEqual(branches, ['main'], 'a branch was created unexpectedly');
      },
    },
    {
      name: 'stash clears uncommitted work off the working tree',
      async setup(sb) {
        sb.git = sb.gitRepo().git;
        sb.file('README.md', '# sandbox\nedited\n');
      },
      config: (sb) => ({ action: 'stash', projectId: sb.dir }),
      assert(out, sb) {
        assert.strictEqual(out.success, true, `stash failed: ${JSON.stringify(out)}`);
        assert.strictEqual(status(sb), '', 'working tree still dirty after stash');
        assert.strictEqual(sb.git('stash', 'list').trim().split('\n').length, 1);
      },
    },
    {
      name: 'reset discards uncommitted changes and restores the last commit',
      async setup(sb) {
        sb.git = sb.gitRepo().git;
        sb.file('README.md', '# sandbox\nvandalised\n');
      },
      config: (sb) => ({ action: 'reset', projectId: sb.dir }),
      assert(out, sb) {
        assert.strictEqual(out.success, true, `reset failed: ${JSON.stringify(out)}`);
        assert.strictEqual(sb.read('README.md'), '# sandbox\n');
        assert.strictEqual(status(sb), '');
      },
    },
    {
      name: 'push with no remote configured fails cleanly instead of hanging',
      async setup(sb) { sb.gitRepo(); },
      config: (sb) => ({ action: 'push', projectId: sb.dir }),
      assert(out) {
        assert.strictEqual(out.success, false, 'push without a remote should not report success');
      },
    },
    {
      name: 'pull with no remote configured fails cleanly instead of hanging',
      async setup(sb) { sb.gitRepo(); },
      config: (sb) => ({ action: 'pull', projectId: sb.dir }),
      assert(out) {
        assert.strictEqual(out.success, false, 'pull without a remote should not report success');
      },
    },
    {
      name: 'an unknown action is rejected rather than silently doing nothing',
      async setup(sb) { sb.gitRepo(); },
      config: (sb) => ({ action: 'rebase', projectId: sb.dir }),
      assert(out) {
        assert.strictEqual(out.success, false, 'an unsupported action was reported as a success');
      },
    },
    {
      name: 'a working directory that does not exist rejects before running git',
      config: (sb) => ({ action: 'reset', projectId: `${sb.dir}-gone` }),
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /valid project working directory/i);
      },
    },
    {
      name: 'the ctx project is used when no projectId is configured',
      async setup(sb) {
        sb.git = sb.gitRepo().git;
        sb.file('from-ctx.txt', 'x\n');
      },
      // sb.vars already carries ctx = { project: sb.dir }
      config: () => ({ action: 'commit', message: 'chore: via ctx' }),
      assert(out, sb) {
        assert.strictEqual(out.success, true, `commit failed: ${JSON.stringify(out)}`);
        assert.strictEqual(sb.git('log', '-1', '--format=%s').trim(), 'chore: via ctx');
      },
    },
  ],
};
