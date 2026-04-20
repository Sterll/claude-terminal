'use strict';

/**
 * claude_session_end trigger
 * Fires when a Claude chat session ends (chat-done or chat-error).
 * Optional projectId filter limits to a specific project.
 * Optional statusFilter: any | success | error
 */
module.exports = {
  type:  'claude_session_end',
  label: 'Claude session end',
  desc:  'Triggered when a Claude chat session ends',

  shouldFire(_config, _context) {
    return false;
  },

  setup(_config, _onFire) {
    return () => {};
  },
};
