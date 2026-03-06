'use strict';

const HOOK_TYPES = [
  { value: 'PreToolUse',       label: 'Pre Tool Use',       desc: 'Avant chaque appel d\'outil' },
  { value: 'PostToolUse',      label: 'Post Tool Use',      desc: 'Après chaque appel d\'outil' },
  { value: 'UserPromptSubmit', label: 'User Prompt Submit', desc: 'À chaque message utilisateur' },
  { value: 'Notification',     label: 'Notification',       desc: 'Sur notification Claude' },
  { value: 'Stop',             label: 'Stop',               desc: 'Quand Claude termine' },
];

module.exports = {
  type: 'hook',
  label: 'Hook Claude',
  fields: [
    {
      type: 'select',
      key: 'hookType',
      label: 'Type de hook',
      hint: 'Événement Claude qui déclenche ce workflow',
      options: HOOK_TYPES.map(h => ({ value: h.value, label: `${h.label} — ${h.desc}` })),
    },
  ],
};