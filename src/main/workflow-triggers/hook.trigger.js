'use strict';

/**
 * Trigger fired by Claude hooks (PreToolUse, PostToolUse, etc.)
 * The app receives HTTP events from the hook handler and forwards them.
 */
module.exports = {
  type:  'hook',
  label: 'Hook Claude',
  desc:  'Triggered by a Claude hook event',

  shouldFire(config, context) {
    if (!config.hookType || !context.hookEvent) return false;
    return context.hookEvent.type === config.hookType;
  },

  setup(config, onFire) {
    // Hook events are managed by HookEventServer in the main app.
    // WorkflowRunner s'abonne aux events via l'IPC.
    // This setup is a no-op — WorkflowRunner handles binding.
    return () => {};
  },
};
