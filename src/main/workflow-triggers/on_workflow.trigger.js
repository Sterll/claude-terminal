'use strict';

module.exports = {
  type:  'on_workflow',
  label: 'After workflow',
  desc:  'Triggers when another workflow finishes',

  shouldFire(config, context) {
    if (!config.triggerValue || !context.completedWorkflowId) return false;
    return context.completedWorkflowId === config.triggerValue;
  },

  setup(_config, _onFire) {
    // Managed by WorkflowRunner, which listens to workflow completion events.
    return () => {};
  },
};
