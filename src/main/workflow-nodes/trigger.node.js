'use strict';

module.exports = {
  type:      'workflow/trigger',
  title:     'Trigger',
  desc:      'Point de départ',
  color:     'success',
  width:     200,
  category:  'actions',
  icon:      'play',
  removable: false,

  inputs:  [],
  outputs: [{ name: 'Start', type: 'exec' }],

  props: { triggerType: 'manual', triggerValue: '', hookType: 'PostToolUse' },

  fields: [
    { type: 'trigger-config', key: 'triggerType', label: 'wfn.trigger.label' },
  ],

  badge: (n) => (n.properties.triggerType || 'manual').toUpperCase(),

  // No run() — trigger nodes are the starting point, not executed as steps
};
