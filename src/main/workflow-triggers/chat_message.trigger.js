'use strict';

/**
 * chat_message trigger
 * Fires when a Claude chat message (user prompt or assistant response) matches a pattern.
 * Detection is pushed by ChatService lifecycle callback.
 */
module.exports = {
  type:  'chat_message',
  label: 'Chat message',
  desc:  'Triggered when a Claude chat message matches a pattern',

  shouldFire(_config, _context) {
    return false;
  },

  setup(_config, _onFire) {
    return () => {};
  },
};
