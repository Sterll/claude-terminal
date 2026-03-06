'use strict';

module.exports = {
  type:  'on_workflow',
  label: 'Après un workflow',
  desc:  'Se déclenche à la fin d\'un autre workflow',

  shouldFire(config, context) {
    if (!config.triggerValue || !context.completedWorkflowId) return false;
    return context.completedWorkflowId === config.triggerValue;
  },

  setup(_config, _onFire) {
    // Géré par WorkflowRunner qui écoute les events de fin de workflow.
    return () => {};
  },
};
