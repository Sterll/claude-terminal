/**
 * Settings palette source — jump straight to one setting.
 * -----------------------------------------------------------------------------
 * Palette-only: attaching a preference to a chat message means nothing, so this
 * source declares no keyword and no getChipData.
 *
 * Why a catalog rather than scraping the rendered panel: the Settings tab is
 * built on demand and is usually not in the DOM when the palette opens, so
 * there is nothing to scrape. The catalog holds *i18n keys*, never translated
 * strings — the label the user searches is the same `t()` output the panel
 * renders, in whichever of the five locales is active. Adding a setting to the
 * panel without adding it here costs nothing: it simply is not reachable from
 * the palette (the in-panel filter, which does read the DOM, still finds it).
 * -----------------------------------------------------------------------------
 */

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
  + '<circle cx="12" cy="12" r="3"/>'
  + '<path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6 1.65 1.65 0 0010 3.09V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.13.36.4.66.75.85H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>';

/**
 * One entry per reachable setting.
 *   tab      settings sub-tab holding it ('general' | 'claude' | 'github' | …)
 *   labelKey i18n key of the visible label — also what the palette matches on
 *   descKey  i18n key of the help text under it, shown as the sublabel
 *   anchor   element id to scroll to and flash once the panel has rendered
 */
const CATALOG = [
  // ── General ──
  { id: 'language', tab: 'general', labelKey: 'settings.language', descKey: 'settings.languageDesc', anchor: 'language-dropdown' },
  { id: 'accentColor', tab: 'general', labelKey: 'settings.accentColor', descKey: 'settings.accentColorDesc', anchor: 'custom-color-input' },
  { id: 'terminalTheme', tab: 'general', labelKey: 'settings.terminalTheme', descKey: 'settings.terminalThemeDesc', anchor: 'btn-go-themes' },
  { id: 'launchAtStartup', tab: 'general', labelKey: 'settings.launchAtStartup', descKey: 'settings.launchAtStartupDesc', anchor: 'launch-at-startup-toggle' },
  { id: 'navigationMode', tab: 'general', labelKey: 'navigationMode.settingsLabel', descKey: 'navigationMode.settingsHint', anchor: 'navigation-mode-dropdown' },
  { id: 'compactProjects', tab: 'general', labelKey: 'settings.compactProjects', descKey: 'settings.compactProjectsDesc', anchor: 'compact-projects-toggle' },
  { id: 'aiCommitMessages', tab: 'general', labelKey: 'settings.aiCommitMessages', descKey: 'settings.aiCommitMessagesDesc', anchor: 'ai-commit-toggle' },
  { id: 'editor', tab: 'general', labelKey: 'settings.editor', descKey: 'settings.editorDesc', anchor: 'editor-dropdown' },
  { id: 'closeWindow', tab: 'general', labelKey: 'settings.closeWindow', descKey: 'settings.closeWindowDesc', anchor: 'close-action-dropdown' },
  { id: 'filesDockedInChat', tab: 'general', labelKey: 'settings.filesDockedInChat', descKey: 'settings.filesDockedInChatDesc', anchor: 'files-docked-toggle' },
  { id: 'showDotfiles', tab: 'general', labelKey: 'settings.showDotfiles', descKey: 'settings.showDotfilesDesc', anchor: 'show-dotfiles-toggle' },
  { id: 'telemetry', tab: 'general', labelKey: 'settings.telemetryEnabled', descKey: 'settings.telemetryEnabledDesc', anchor: 'telemetry-enabled-toggle' },
  { id: 'parallelAutoKanban', tab: 'general', labelKey: 'settings.parallelAutoKanban', descKey: 'settings.parallelAutoKanbanDesc', anchor: 'parallel-auto-kanban-toggle' },
  { id: 'parallelAutoWorkspaceDoc', tab: 'general', labelKey: 'settings.parallelAutoWorkspaceDoc', descKey: 'settings.parallelAutoWorkspaceDocDesc', anchor: 'parallel-auto-workspace-toggle' },

  // ── Claude ──
  { id: 'executionMode', tab: 'claude', labelKey: 'settings.executionMode', descKey: null, anchor: null },
  { id: 'defaultTerminalMode', tab: 'claude', labelKey: 'settings.defaultTerminalMode', descKey: null, anchor: null },
  { id: 'restoreSessions', tab: 'claude', labelKey: 'settings.restoreTerminalSessions', descKey: 'settings.restoreTerminalSessionsDesc', anchor: 'restore-sessions-toggle' },
  { id: 'showTabModeToggle', tab: 'claude', labelKey: 'settings.showTabModeToggle', descKey: 'settings.showTabModeToggleDesc', anchor: 'show-tab-mode-toggle' },
  { id: 'tabRenameOnSlashCommand', tab: 'claude', labelKey: 'settings.tabRenameOnSlashCommand', descKey: 'settings.tabRenameOnSlashCommandDesc', anchor: 'tab-rename-slash-toggle' },
  { id: 'aiTabNaming', tab: 'claude', labelKey: 'settings.aiTabNaming', descKey: 'settings.aiTabNamingDesc', anchor: 'ai-tab-naming-toggle' },
  { id: 'followupSuggestions', tab: 'claude', labelKey: 'settings.enableFollowupSuggestions', descKey: 'settings.enableFollowupSuggestionsDesc', anchor: 'followup-suggestions-toggle' },
  { id: 'discordRpc', tab: 'claude', labelKey: 'settings.discordRpc', descKey: 'settings.discordRpcDesc', anchor: 'discord-rpc-toggle' },
  { id: 'enhancePrompts', tab: 'claude', labelKey: 'settings.enhancePrompts', descKey: 'settings.enhancePromptsDesc', anchor: 'enhance-prompts-toggle' },
  { id: 'autoClaudeMdUpdate', tab: 'claude', labelKey: 'settings.autoClaudeMdUpdate', descKey: 'settings.autoClaudeMdUpdateDesc', anchor: 'auto-claude-md-toggle' },
  { id: 'maxTurns', tab: 'claude', labelKey: 'settings.maxTurns', descKey: 'settings.maxTurnsDesc', anchor: 'max-turns-input' },
  { id: 'persona', tab: 'claude', labelKey: 'settings.personaGroup', descKey: 'settings.personaName', anchor: 'persona-name-input' },
  { id: 'accounts', tab: 'claude', labelKey: 'settings.accountsGroup', descKey: 'settings.accountsDesc', anchor: null },
  { id: 'chromeBridge', tab: 'claude', labelKey: 'settings.chrome.enable', descKey: 'settings.chrome.enableDesc', anchor: 'chrome-bridge-toggle' },
  { id: 'hooks', tab: 'claude', labelKey: 'settings.hooks.enable', descKey: 'settings.hooks.description', anchor: 'hooks-enabled-toggle' },
  { id: 'remoteControl', tab: 'claude', labelKey: 'claudeRemote.enable', descKey: 'claudeRemote.enableDesc', anchor: 'claude-remote-enabled-toggle' },
  { id: 'remoteControlDrive', tab: 'claude', labelKey: 'claudeRemote.allowDriving', descKey: 'claudeRemote.drivingDesc', anchor: 'claude-remote-drive-toggle' },
  { id: 'remoteControlTerminals', tab: 'claude', labelKey: 'claudeRemote.terminals', descKey: 'claudeRemote.terminalsDesc', anchor: 'claude-remote-terminals-toggle' },
  { id: 'ephemeralChats', tab: 'claude', labelKey: 'settings.ephemeralChats', descKey: 'settings.ephemeralChatsDesc', anchor: 'ephemeral-chats-toggle' },

  // ── GitHub ──
  { id: 'githubAccount', tab: 'github', labelKey: 'settings.githubAccount', descKey: 'settings.githubConnectDesc', anchor: null },
  { id: 'githubEnterprise', tab: 'github', labelKey: 'settings.githubEnterprise', descKey: null, anchor: null },

  // ── Other tabs ──
  { id: 'themes', tab: 'themes', labelKey: 'settings.themesTitle', descKey: 'settings.themesDesc', anchor: null },
  { id: 'shortcuts', tab: 'shortcuts', labelKey: 'settings.tabShortcuts', descKey: null, anchor: null },
  { id: 'library', tab: 'library', labelKey: 'settings.tabLibrary', descKey: 'settings.contextPacksDesc', anchor: null },
  { id: 'reduceMotion', tab: 'agents', labelKey: 'settings.reduceMotion', descKey: 'settings.reduceMotionDesc', anchor: 'reduce-motion-toggle' },
];

/** Translate a key, falling back to nothing rather than echoing the key back. */
function translate(key) {
  if (!key) return '';
  try {
    const value = require('../../i18n').t(key);
    // t() returns the key itself when it is missing — a raw dotted path in the
    // palette would be worse than an empty sublabel.
    return !value || value === key ? '' : value;
  } catch {
    return '';
  }
}

/** i18n label of the sub-tab an entry lives in, used as its sublabel prefix. */
function tabLabel(tab) {
  const KEYS = {
    general: 'settings.tabGeneral',
    claude: 'settings.tabClaude',
    github: 'settings.tabGitHub',
    themes: 'settings.tabThemes',
    shortcuts: 'settings.tabShortcuts',
    library: 'settings.tabLibrary',
    agents: 'settings.tabAgents',
  };
  return translate(KEYS[tab]) || tab;
}

module.exports = {
  id: 'settings',
  keyword: null,
  prefix: null,
  surfaces: ['palette'],
  scope: 'global',
  label: () => translate('settings.search.sourceLabel') || 'Settings',
  icon: ICON,

  getData(ctx = {}) {
    // Nothing on an empty query: forty preferences is not a browsable list, and
    // dumping them into the palette's default view would push the projects and
    // commands people actually open it for past the visible cap.
    if (!String(ctx.query || '').trim()) return [];

    return CATALOG.map(entry => {
      const label = translate(entry.labelKey);
      return {
        ...entry,
        // An untranslated entry keeps its id as a last-resort label so a locale
        // missing one key does not silently drop the row.
        label: label || entry.id,
        desc: translate(entry.descKey),
        tabName: tabLabel(entry.tab),
      };
    });
  },

  render(item) {
    const parts = [item.tabName, item.desc].filter(Boolean);
    return {
      icon: ICON,
      label: item.label,
      sublabel: parts.join(' · '),
    };
  },

  onSelect(item, consumer) {
    if (consumer !== 'palette') return;
    // Lazily required: SettingsPanel pulls in half the renderer, and loading it
    // at module scope would drag it into every surface that touches a source.
    const SettingsPanel = require('../../ui/panels/SettingsPanel');
    SettingsPanel.focusSetting({
      tab: item.tab,
      query: item.label,
      anchor: item.anchor,
    });
  },

  // Exposed for tests and for the Settings panel's own deep-link handling.
  _catalog: CATALOG,
};
