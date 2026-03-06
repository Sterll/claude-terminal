'use strict';

module.exports = {
  type:  'manual',
  label: 'Manual',
  desc:  'Triggered manually via the play button',

  /**
   * Checks whether the trigger should fire.
   * For manual, never via polling — fired directly.
   */
  shouldFire(_config, _context) {
    return false;
  },

  /**
   * Startup setup (returns a teardown function).
   * For manual, nothing to do.
   */
  setup(_config, _onFire) {
    return () => {}; // teardown no-op
  },
};
