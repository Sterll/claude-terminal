/**
 * "Is git installed at all": asked of a local `git --version` at startup, so
 * a fresh install hears about a missing git before its first project's Git
 * tab comes up empty, and the Git tab offers to install it.
 */
jest.mock('../../src/renderer/ui/components/Toast', () => ({ showToast: jest.fn() }));

const git = require('../../src/main/utils/git');
const { warnIfGitMissing, gitUnavailableStateHtml } = require('../../src/renderer/services/GitTabService');

describe('checkGitAvailable', () => {
  /** git.js over a child_process whose execFile answers like a missing binary. */
  function gitWithoutBinary() {
    let mod;
    jest.isolateModules(() => {
      jest.doMock('child_process', () => ({
        ...jest.requireActual('child_process'),
        execFile: jest.fn((file, args, opts, cb) => {
          const err = Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
          cb(err, '', '');
          return { on: jest.fn() };
        }),
      }));
      mod = require('../../src/main/utils/git');
    });
    jest.dontMock('child_process');
    return mod;
  }

  test('a git that cannot be spawned is enoent', async () => {
    const status = await gitWithoutBinary().checkGitAvailable({ force: true });
    expect(status).toMatchObject({ available: false, reason: 'enoent' });
    expect(status.message).toMatch(/not installed/i);
  });

  test('is asked once and shared by every caller', () => {
    const a = git.checkGitAvailable();
    expect(git.checkGitAvailable()).toBe(a);
    expect(git.checkGitAvailable({ force: true })).not.toBe(a);
  });
});

describe('warnIfGitMissing', () => {
  const run = (status) => {
    const toast = jest.fn();
    const api = { git: { availability: jest.fn(async () => status) }, dialog: { openExternal: jest.fn() } };
    window.electron_api = { ...window.electron_api, ...api };
    return warnIfGitMissing({ api, toast }).then(shown => ({ shown, toast, api }));
  };

  test('a missing git is said once, with a way to install it', async () => {
    const { shown, toast, api } = await run({ available: false, reason: 'enoent' });
    expect(shown).toBe(true);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toMatchObject({ type: 'warning', action: 'Install Git' });
    toast.mock.calls[0][0].onAction();
    expect(api.dialog.openExternal).toHaveBeenCalledWith('https://git-scm.com/downloads');
  });

  test('git present, or merely slow to answer, says nothing', async () => {
    expect((await run({ available: true, version: '2.47.0' })).toast).not.toHaveBeenCalled();
    expect((await run({ available: false, reason: 'timeout' })).toast).not.toHaveBeenCalled();
  });
});

describe('the Git tab when git could not run', () => {
  test('offers to install git only when it is missing', () => {
    expect(gitUnavailableStateHtml('Git is not installed', 'enoent')).toContain('data-git-install');
    expect(gitUnavailableStateHtml('Git command timed out', 'timeout')).not.toContain('data-git-install');
  });
});
