/**
 * git refuses to remove a worktree twice over: once for uncommitted changes,
 * once for a lock — and the second refusal needs a *second* --force
 * (`worktree remove -f -f`). The lock is often git's own, since `worktree add`
 * holds one with reason "initializing" and an interrupted add never releases
 * it, so "remove" has to be able to reach that case.
 */
jest.mock('child_process', () => ({
  execFile: jest.fn(),
  execFileSync: jest.fn(),
  exec: jest.fn()
}));

const { execFile } = require('child_process');
const { removeWorktree, FORCE_UNLOCK } = require('../../src/main/utils/git');

/** Arguments git was called with, minus the leading hardening/safe.directory flags. */
function gitArgs() {
  const args = execFile.mock.calls[0][1];
  return args.slice(args.indexOf('worktree'));
}

beforeEach(() => {
  execFile.mockReset();
  execFile.mockImplementation((cmd, args, opts, cb) => cb(null, 'ok', ''));
});

describe('removeWorktree', () => {
  test('passes no --force by default', async () => {
    await removeWorktree('/repo', '/repo/wt');
    expect(gitArgs()).toEqual(['worktree', 'remove', '/repo/wt']);
  });

  test('passes a single --force for a dirty worktree', async () => {
    await removeWorktree('/repo', '/repo/wt', true);
    expect(gitArgs()).toEqual(['worktree', 'remove', '--force', '/repo/wt']);
  });

  test('passes --force twice to override a lock', async () => {
    await removeWorktree('/repo', '/repo/wt', FORCE_UNLOCK);
    expect(gitArgs()).toEqual(['worktree', 'remove', '--force', '--force', '/repo/wt']);
  });

  test('never passes more than two --force', async () => {
    await removeWorktree('/repo', '/repo/wt', 99);
    expect(gitArgs().filter(a => a === '--force')).toHaveLength(2);
  });

  test('reports git stderr as the error', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) =>
      cb(new Error('exit 128'), '', "fatal: cannot remove a locked working tree,\nlock reason: initializing\nuse 'remove -f -f' to override or unlock first"));
    const result = await removeWorktree('/repo', '/repo/wt');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/locked working tree/);
  });
});
