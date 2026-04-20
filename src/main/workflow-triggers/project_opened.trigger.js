'use strict';

/**
 * project_opened trigger
 * Fires when the user opens a project in Claude Terminal.
 * An optional projectId filter limits the trigger to a specific project.
 */
module.exports = {
  type:  'project_opened',
  label: 'Project opened',
  desc:  'Triggered when a project is opened in the app',

  shouldFire(_config, _context) {
    // Push-based — WorkflowScheduler.onProjectOpened() dispatches.
    return false;
  },

  setup(_config, _onFire) {
    return () => {};
  },
};
