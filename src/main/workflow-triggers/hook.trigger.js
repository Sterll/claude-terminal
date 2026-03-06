'use strict';

/**
 * Trigger déclenché par les hooks Claude (PreToolUse, PostToolUse, etc.)
 * L'app reçoit des events HTTP depuis le hook handler et les transmet.
 */
module.exports = {
  type:  'hook',
  label: 'Hook Claude',
  desc:  'Déclenché par un événement hook Claude',

  shouldFire(config, context) {
    if (!config.hookType || !context.hookEvent) return false;
    return context.hookEvent.type === config.hookType;
  },

  setup(config, onFire) {
    // Le hook event est géré par HookEventServer dans l'app principale.
    // WorkflowRunner s'abonne aux events via l'IPC.
    // Ce setup est un no-op — WorkflowRunner gère le binding.
    return () => {};
  },
};
