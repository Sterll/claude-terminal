/**
 * Settings → Terminal font size, driven through the real input.
 *
 * The panel autosaves on every change without re-rendering, so the "did it
 * change?" check before applying the size to open terminals must compare
 * against live state, not the `settings` snapshot taken when the tab was
 * rendered. With the snapshot, 14 → 16 → 14 saved the second change but never
 * applied it: the value equalled the snapshot again.
 *
 * The general tab reaches into a wide API surface on render (accounts,
 * GitHub, workspaces, app version); every call is answered with an empty
 * result, and the render wraps each one in its own try/catch.
 */

// The Library tab (rendered alongside General) lists context packs and prompt
// templates from disk; nothing here needs them.
jest.mock('../../src/renderer/services/ContextPromptService', () => ({
  getContextPacks: () => [],
  getPromptTemplates: () => [],
}));

const { SettingsPanel } = require('../../src/renderer/ui/panels/SettingsPanel');
const { settingsState } = require('../../src/renderer/state/settings.state');
const themes = require('../../src/renderer/ui/themes/terminal-themes');

const TERMINAL_THEMES = themes.TERMINAL_THEMES || themes;

/** Every `api.<namespace>.<method>()` resolves to an empty object. */
function permissiveApi() {
  const method = () => jest.fn(async () => ({}));
  const namespace = () => new Proxy({}, { get: (_, key) => (typeof key === 'string' ? method() : undefined) });
  return new Proxy({}, { get: (_, key) => (typeof key === 'string' ? namespace() : undefined) });
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

let panel;
let ctx;

beforeEach(async () => {
  document.body.innerHTML = '<div id="tab-settings"></div>';
  settingsState.set({ ...settingsState.get(), terminalFontSize: 14, terminalTheme: 'claude' });

  ctx = {
    settingsState,
    saveSettings: jest.fn(),
    saveSettingsImmediate: jest.fn(),
    applyAccentColor: jest.fn(),
    TerminalManager: { updateAllTerminalsFontSize: jest.fn(), updateAllTerminalsTheme: jest.fn() },
    TERMINAL_THEMES,
    QuickActions: { QUICK_ACTION_ICONS: { play: '>' } },
    ShortcutsManager: { renderShortcutsPanel: () => '', setupShortcutsPanelHandlers: () => {} },
  };
  panel = new SettingsPanel(document.getElementById('tab-settings'), { api: permissiveApi(), ctx });
  await panel.renderSettingsTab('general');
});

function fontSizeInput() {
  const input = document.getElementById('terminal-font-size-input');
  if (!input) throw new Error('terminal-font-size-input not rendered');
  return input;
}

async function typeFontSize(value) {
  const input = fontSizeInput();
  input.value = String(value);
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

test('renders the input at the saved size with an associated label', () => {
  const input = fontSizeInput();
  expect(input.value).toBe('14');
  // Named via aria-labelledby rather than a <label for>: the row title has to
  // stay a plain <div> (see the filter test below), and a <label> wrapping that
  // div would be the only such row in the panel.
  expect(input.getAttribute('aria-labelledby')).toBe('terminal-font-size-label');
  expect(document.getElementById('terminal-font-size-label').textContent.trim()).not.toBe('');
  expect(input.getAttribute('aria-describedby')).toBe('terminal-font-size-desc');
  expect(document.getElementById('terminal-font-size-desc')).not.toBeNull();
});

/**
 * The in-panel filter reads `.settings-label > div:first-child`, and
 * `styles/settings.css` sizes the row title through that same selector. A
 * `<label>` there satisfies neither: the row rendered at the 16px UA default and
 * searching its own title hid it, because `readSettingRow()` saw an empty label
 * and `substringMatch` is a contiguous match that the description does not
 * satisfy.
 */
test('the row title is findable by the settings filter', () => {
  const { readSettingRow, settingMatches } = require('../../src/renderer/ui/panels/SettingsPanel');
  const row = fontSizeInput().closest('.settings-row');
  const parts = readSettingRow(row);

  expect(parts.labelEl).not.toBeNull();
  expect(parts.label).toBe('Terminal font size');
  expect(settingMatches(parts, 'terminal font')).toBe(true);
});

test('14 → 16 → 14 applies both changes without re-rendering the tab', async () => {
  await typeFontSize(16);
  await typeFontSize(14);

  expect(ctx.TerminalManager.updateAllTerminalsFontSize.mock.calls).toEqual([[16], [14]]);
  expect(settingsState.get().terminalFontSize).toBe(14);
});

test('does not re-apply when the value did not change', async () => {
  await typeFontSize(14);

  expect(ctx.TerminalManager.updateAllTerminalsFontSize).not.toHaveBeenCalled();
});

test('clamps an out-of-range entry and echoes the applied value back into the field', async () => {
  await typeFontSize(99);

  expect(ctx.TerminalManager.updateAllTerminalsFontSize).toHaveBeenCalledWith(24);
  expect(settingsState.get().terminalFontSize).toBe(24);
  expect(fontSizeInput().value).toBe('24');
});
