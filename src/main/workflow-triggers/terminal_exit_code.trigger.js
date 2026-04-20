'use strict';

/**
 * terminal_exit_code trigger
 * Fires when a terminal PTY exits with a code matching the configured filter.
 * Filter accepts: "any" | "success" (0) | "error" (non-zero) | "1,2,127" (list).
 */
module.exports = {
  type:  'terminal_exit_code',
  label: 'Terminal exit code',
  desc:  'Triggered when a terminal closes with a matching exit code',

  shouldFire(_config, _context) {
    // Push-based — WorkflowScheduler.onTerminalExit() dispatches.
    return false;
  },

  setup(_config, _onFire) {
    return () => {};
  },
};
