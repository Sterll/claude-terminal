'use strict';

/**
 * claude_session_start trigger
 * Fires when a Claude chat session starts (first prompt submitted).
 * Optional projectId filter limits to a specific project.
 */
module.exports = {
  type:  'claude_session_start',
  label: 'Claude session start',
  desc:  'Triggered when a Claude chat session starts',

  shouldFire(_config, _context) {
    return false;
  },

  setup(_config, _onFire) {
    return () => {};
  },
};
