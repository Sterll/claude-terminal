'use strict';

module.exports = {
  type: 'on_workflow',
  label: 'Après un workflow',
  fields: [
    {
      type: 'select',
      key: 'triggerValue',
      label: 'Workflow source',
      hint: 'Se déclenche à la fin de ce workflow',
      options: [], // Rempli dynamiquement par le panel
      placeholder: 'Sélectionner un workflow…',
    },
  ],
};