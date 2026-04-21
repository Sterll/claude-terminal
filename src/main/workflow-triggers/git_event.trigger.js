'use strict';

/**
 * git_event trigger
 * Fires on git activity in a project (commit, push, branch change).
 * Detection is owned by WorkflowScheduler via a watcher on `.git/logs/HEAD`.
 */
module.exports = {
  type:  'git_event',
  label: 'Git event',
  desc:  'Triggered when a commit, push or branch change is detected in a project',

  shouldFire(_config, _context) {
    // Push-based — WorkflowScheduler.onGitEvent() dispatches.
    return false;
  },

  setup(_config, _onFire) {
    return () => {};
  },
};
