/**
 * Tests for the settings payload the setup wizard hands to the main process.
 *
 * The wizard's answers are the only thing that reaches settings.json on a
 * fresh install, so the payload is the contract. navigationMode matters
 * doubly: the app's first-launch navigation chooser only runs while that
 * setting is unset, so an answer that never makes it into the payload means a
 * new user is asked the same question twice in a row.
 *
 * As in SetupWizardNavigation.test.js, the real functions are extracted from
 * setup-wizard.html and run against the shipped markup.
 */

const {
  readWizardHtml,
  extractFunction,
  mountWizardMarkup,
} = require('./wizardSource');

const html = readWizardHtml();

/**
 * Mount the wizard markup and return its real getSettings(), with the two
 * module-level values it closes over injected.
 * @returns {() => Object}
 */
function createSettingsReader() {
  mountWizardMarkup(html);
  const source = [
    extractFunction(html, 'function selectedMode(groupId, fallback) {'),
    extractFunction(html, 'function getSettings() {'),
  ].join('\n');
  return new Function('selectedLang', 'selectedColor', `${source}\nreturn getSettings;`)('en', '#d97706');
}

/** The real card-picker wiring, run against the mounted markup. */
function wireCards() {
  const source = extractFunction(html, 'function wireModeCards() {');
  new Function(`${source}\nreturn wireModeCards;`)()();
}

/**
 * Click a card the way a user would.
 * @param {string} groupId
 * @param {string} mode
 */
function pick(groupId, mode) {
  document.querySelector(`#${groupId} [data-mode="${mode}"]`).click();
}

describe('setup wizard settings payload', () => {
  test('the payload carries a navigation mode', () => {
    const getSettings = createSettingsReader();
    expect(getSettings().navigationMode).toBe('tabs');
  });

  test('the navigation answer reaches the payload', () => {
    const getSettings = createSettingsReader();
    wireCards();
    pick('navigation-mode-options', 'sidebar');
    expect(getSettings().navigationMode).toBe('sidebar');
  });

  test('the two mode steps do not clear each other', () => {
    // Both steps share the .mode-card class. A document-wide deselect would
    // wipe the terminal mode answer the moment the navigation card is clicked.
    const getSettings = createSettingsReader();
    wireCards();
    pick('terminal-mode-options', 'chat');
    pick('navigation-mode-options', 'sidebar');

    const settings = getSettings();
    expect(settings.defaultTerminalMode).toBe('chat');
    expect(settings.navigationMode).toBe('sidebar');
  });

  test('an unanswered group falls back to the app default', () => {
    const getSettings = createSettingsReader();
    document.querySelectorAll('.mode-card.selected').forEach(c => c.classList.remove('selected'));

    const settings = getSettings();
    // These have to match the app's own defaults, or clicking through the
    // wizard silently changes behaviour the user never chose.
    expect(settings.defaultTerminalMode).toBe('terminal');
    expect(settings.navigationMode).toBe('tabs');
  });

  test('completing the wizard marks setup done and consent as shown', () => {
    const getSettings = createSettingsReader();
    const settings = getSettings();
    expect(settings.setupCompleted).toBe(true);
    expect(settings.hooksConsentShown).toBe(true);
    expect(settings.telemetryConsentShown).toBe(true);
  });
});
