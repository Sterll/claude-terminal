/**
 * permission-modes.js
 * Single source of truth for the permission modes a conversation can run in.
 *
 * Two vocabularies meet here. The SDK speaks `PermissionMode`
 * ('default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto'); the
 * app's stored `executionMode` setting predates the per-conversation picker
 * and spells the same ideas 'safe' | 'auto' | 'dangerous'. The two modes the
 * setting never had are stored under their SDK names.
 *
 * The mode is decided per conversation, in the chat footer. The setting is
 * only what a new tab starts from — see `selectedMode` in ChatView.
 */

'use strict';

// Menu order. Desktop numbers the first four and keeps bypass apart, below a
// separator: it is the one mode with no safety net, so it gets no shortcut.
const PERMISSION_MODES = [
  { id: 'auto', setting: 'auto', labelKey: 'chat.modeAuto', descKey: 'chat.modeAutoDesc' },
  { id: 'default', setting: 'safe', labelKey: 'chat.modeManual', descKey: 'chat.modeManualDesc' },
  { id: 'acceptEdits', setting: 'acceptEdits', labelKey: 'chat.modeAcceptEdits', descKey: 'chat.modeAcceptEditsDesc' },
  { id: 'plan', setting: 'plan', labelKey: 'chat.modePlan', descKey: 'chat.modePlanDesc' },
  { id: 'bypassPermissions', setting: 'dangerous', labelKey: 'chat.modeBypass', descKey: 'chat.modeBypassDesc', danger: true },
];

const PERMISSION_MODE_IDS = PERMISSION_MODES.map(m => m.id);

/** The row for an SDK mode id; unknown ids land on 'default' (ask first). */
function permissionModeInfo(id) {
  return PERMISSION_MODES.find(m => m.id === id) || PERMISSION_MODES.find(m => m.id === 'default');
}

/** Stored `executionMode` -> SDK mode. Absent or unknown -> 'default'. */
function modeFromSetting(value) {
  const hit = PERMISSION_MODES.find(m => m.setting === value);
  return hit ? hit.id : 'default';
}

/** SDK mode -> the value to store in `executionMode`. */
function settingFromMode(id) {
  return permissionModeInfo(id).setting;
}

function isPermissionMode(id) {
  return PERMISSION_MODE_IDS.includes(id);
}

module.exports = {
  PERMISSION_MODES,
  PERMISSION_MODE_IDS,
  permissionModeInfo,
  modeFromSetting,
  settingFromMode,
  isPermissionMode,
};
