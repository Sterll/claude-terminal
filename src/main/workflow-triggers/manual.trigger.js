'use strict';

module.exports = {
  type:  'manual',
  label: 'Manuel',
  desc:  'Déclenché manuellement via le bouton play',

  /**
   * Vérifie si le trigger doit se déclencher.
   * Pour manual, jamais via polling — déclenché directement.
   */
  shouldFire(_config, _context) {
    return false;
  },

  /**
   * Setup au démarrage (retourne une fonction teardown).
   * Pour manual, rien à faire.
   */
  setup(_config, _onFire) {
    return () => {}; // teardown no-op
  },
};
