'use strict';

/**
 * file_change trigger
 * Fires when files in a watched directory change (add/modify/delete).
 * Setup is managed by WorkflowScheduler which spawns/tears down a chokidar
 * watcher per workflow based on its config.
 */
module.exports = {
  type:  'file_change',
  label: 'File change',
  desc:  'Triggered when files matching a pattern are added, modified or deleted',

  shouldFire(_config, _context) {
    // Delivered via WorkflowScheduler.onFileChange (push) — never polled.
    return false;
  },

  setup(_config, _onFire) {
    // Watcher lifecycle is owned by WorkflowScheduler._rebuildFileWatchers().
    return () => {};
  },
};
