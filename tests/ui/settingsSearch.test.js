// Settings filter: what a query matches, and what the panel does with the answer.
//
// The panel renders nine groups over seven sub-tabs and the filter reads the
// *rendered* text, so these tests build the shapes the panel actually emits
// (.settings-row with a .settings-label + .settings-desc, .settings-toggle-row
// with a .settings-toggle-label + .settings-toggle-desc) rather than mocking a
// model that does not exist.

const {
  applySettingsFilter,
  settingMatches,
  readSettingRow,
  highlightSettingText,
} = require('../../src/renderer/ui/panels/SettingsPanel');

/** A .settings-row as renderSettingsTab writes it. */
function row(label, desc) {
  return `
    <div class="settings-row">
      <div class="settings-label">
        <div>${label}</div>
        <div class="settings-desc">${desc}</div>
      </div>
      <button class="btn-outline">Change</button>
    </div>`;
}

/** A .settings-toggle-row, the other half of the panel. */
function toggleRow(label, desc) {
  return `
    <div class="settings-toggle-row">
      <div class="settings-toggle-label">
        <div>${label}</div>
        <div class="settings-toggle-desc">${desc}</div>
      </div>
      <label class="settings-toggle"><input type="checkbox"></label>
    </div>`;
}

function buildDom() {
  document.body.innerHTML = `
    <div id="tab-settings">
      <div class="settings-inline-wrapper">
        <div class="settings-search">
          <input id="settings-search-input" type="text">
          <button id="settings-search-clear" hidden></button>
          <span id="settings-search-status"></span>
        </div>
        <div class="settings-search-empty" hidden>
          <p class="settings-search-empty-title"></p>
        </div>
        <div class="settings-tabs">
          <button class="settings-tab active" data-tab="general">Général</button>
          <button class="settings-tab" data-tab="claude">Claude</button>
        </div>
        <div class="settings-content">
          <div class="settings-panel active" data-panel="general">
            <div class="settings-group" data-section="appearance">
              <div class="settings-group-title">Apparence</div>
              <div class="settings-card">
                ${row('Langue', "Langue de l'interface")}
                ${row('Couleur d\'accentuation', 'Teinte principale de l\'application')}
                <div class="color-picker"><button class="color-swatch"></button></div>
              </div>
            </div>
            <div class="settings-group" data-section="telemetry">
              <div class="settings-group-title">Télémétrie</div>
              <div class="settings-card">
                ${toggleRow('Statistiques anonymes', 'Envoyer des mesures d\'usage anonymes')}
              </div>
            </div>
          </div>
          <div class="settings-panel" data-panel="claude">
            <div class="settings-group">
              <div class="settings-group-title">Terminal</div>
              <div class="settings-card">
                ${toggleRow('Restaurer les sessions', 'Rouvrir les onglets au démarrage')}
              </div>
            </div>
            <div class="settings-group">
              <div class="settings-group-title">Mode d'exécution</div>
              <div class="settings-card">
                <div class="execution-mode-card" data-mode="safe">Sûr</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  return document.getElementById('tab-settings');
}

const isHidden = (el) => el.classList.contains('settings-search-hidden');
const visibleRows = (root) =>
  [...root.querySelectorAll('.settings-row, .settings-toggle-row')]
    .filter(r => !isHidden(r))
    .map(r => r.querySelector('.settings-label > div, .settings-toggle-label > div').textContent);

let container;
beforeEach(() => { container = buildDom(); });

describe('settingMatches', () => {
  const parts = { label: 'Télémétrie', desc: "Envoyer des mesures d'usage anonymes" };

  test('an empty query matches everything', () => {
    expect(settingMatches(parts, '')).toBe(true);
    expect(settingMatches(parts, '   ')).toBe(true);
    expect(settingMatches({}, '')).toBe(true);
  });

  test('matches the visible label', () => {
    expect(settingMatches(parts, 'Télé')).toBe(true);
  });

  test('matches the help text under the label, not just the label', () => {
    expect(settingMatches(parts, 'anonymes')).toBe(true);
    expect(settingMatches(parts, 'usage')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(settingMatches(parts, 'TÉLÉMÉTRIE')).toBe(true);
    expect(settingMatches({ label: 'Language' }, 'LANG')).toBe(true);
  });

  // The author writes French and the app ships Spanish: a filter that needs
  // the accent typed correctly is a filter nobody in those locales can use.
  test('is diacritic-insensitive both ways', () => {
    expect(settingMatches({ label: 'Télémétrie' }, 'telemetrie')).toBe(true);
    expect(settingMatches({ label: 'Telemetrie' }, 'télémétrie')).toBe(true);
    expect(settingMatches({ label: 'Réglages généraux' }, 'generaux')).toBe(true);
    expect(settingMatches({ label: 'Añadir atajo' }, 'anadir')).toBe(true);
    expect(settingMatches({ desc: "Couleur d'accentuation" }, 'ACCENTUATION')).toBe(true);
  });

  test('matches a decomposed accent typed as base letter + combining mark', () => {
    const decomposed = 'Télémétrie';
    expect(settingMatches({ label: decomposed }, 'telemetrie')).toBe(true);
    expect(settingMatches({ label: 'Télémétrie' }, decomposed)).toBe(true);
  });

  test('a substring is required — it is not a fuzzy subsequence match', () => {
    expect(settingMatches({ label: 'Télémétrie' }, 'tlm')).toBe(false);
    expect(settingMatches(parts, 'zzz')).toBe(false);
  });

  test('a row with no label or description still matches on what it renders', () => {
    expect(settingMatches({ fallback: 'Rejouer l\'assistant' }, 'assistant')).toBe(true);
  });
});

describe('readSettingRow', () => {
  test('reads the label and the description separately', () => {
    const el = container.querySelector('.settings-row');
    const parts = readSettingRow(el);
    expect(parts.label).toBe('Langue');
    expect(parts.desc).toBe("Langue de l'interface");
    // The <button> inside the row is not folded into either string.
    expect(parts.label).not.toContain('Change');
    expect(parts.fallback).toBe('');
  });

  test('falls back to the whole row when it has neither', () => {
    const el = document.createElement('div');
    el.className = 'settings-row';
    el.textContent = 'Rejouer l\'assistant';
    expect(readSettingRow(el).fallback).toBe('Rejouer l\'assistant');
  });
});

describe('applySettingsFilter', () => {
  test('an empty query restores every row and leaves search mode', () => {
    applySettingsFilter(container, 'anonymes');
    applySettingsFilter(container, '');
    const wrapper = container.querySelector('.settings-inline-wrapper');
    expect(wrapper.classList.contains('settings-search-active')).toBe(false);
    expect(visibleRows(container)).toHaveLength(4);
    expect([...container.querySelectorAll('.settings-group')].every(g => !isHidden(g))).toBe(true);
  });

  test('hides the rows that do not match', () => {
    applySettingsFilter(container, 'langue');
    expect(visibleRows(container)).toEqual(['Langue']);
  });

  test('hides a group left without a single visible row', () => {
    applySettingsFilter(container, 'langue');
    const telemetry = container.querySelector('[data-section="telemetry"]');
    expect(isHidden(telemetry)).toBe(true);
    expect(isHidden(container.querySelector('[data-section="appearance"]'))).toBe(false);
  });

  test('searches every sub-tab, not only the visible one', () => {
    // "Restaurer les sessions" lives in the Claude panel, which is not .active.
    const result = applySettingsFilter(container, 'restaurer');
    expect(visibleRows(container)).toEqual(['Restaurer les sessions']);
    const claudePanel = container.querySelector('[data-panel="claude"]');
    expect(claudePanel.classList.contains('settings-search-match')).toBe(true);
    expect(container.querySelector('[data-panel="general"]').classList.contains('settings-search-match')).toBe(false);
    expect(result.panels).toBe(1);
  });

  test('a matching group title keeps the whole section', () => {
    applySettingsFilter(container, 'apparence');
    expect(visibleRows(container)).toEqual(['Langue', "Couleur d'accentuation"]);
    // …including furniture that is not a row, like the colour picker.
    expect(isHidden(container.querySelector('.color-picker'))).toBe(false);
  });

  test('a group kept by one row hides its non-row furniture', () => {
    applySettingsFilter(container, 'langue');
    expect(isHidden(container.querySelector('.color-picker'))).toBe(true);
  });

  test('a rowless group is still reachable by its title', () => {
    const result = applySettingsFilter(container, "exécution");
    const groups = [...container.querySelectorAll('.settings-group')].filter(g => !isHidden(g));
    expect(groups).toHaveLength(1);
    expect(groups[0].querySelector('.settings-group-title').textContent).toContain("exécution");
    expect(result.groups).toBe(1);
  });

  test('reports nothing visible when nothing matches', () => {
    const result = applySettingsFilter(container, 'zzzz');
    expect(result).toEqual({ rows: 0, groups: 0, panels: 0 });
    expect([...container.querySelectorAll('.settings-group')].every(isHidden)).toBe(true);
  });

  test('matching ignores accents in the panel as well as in the query', () => {
    applySettingsFilter(container, 'telemetrie');
    const telemetry = container.querySelector('[data-section="telemetry"]');
    expect(isHidden(telemetry)).toBe(false);
    expect(visibleRows(container)).toEqual(['Statistiques anonymes']);
  });
});

describe('highlighting', () => {
  test('wraps the matched substring in the palette mark', () => {
    applySettingsFilter(container, 'lang');
    const label = container.querySelector('.settings-row .settings-label > div');
    expect(label.innerHTML).toBe('<mark class="qp-hl">Lang</mark>ue');
  });

  test('marks the accented original when the query is unaccented', () => {
    applySettingsFilter(container, 'telemetrie');
    const title = container.querySelector('[data-section="telemetry"] .settings-group-title');
    expect(title.innerHTML).toBe('<mark class="qp-hl">Télémétrie</mark>');
    expect(title.textContent).toBe('Télémétrie');
  });

  test('highlights the description when the match is only there', () => {
    applySettingsFilter(container, 'anonymes');
    const desc = container.querySelector('[data-section="telemetry"] .settings-toggle-desc');
    expect(desc.innerHTML).toContain('<mark class="qp-hl">anonymes</mark>');
  });

  test('clearing the query restores the exact original text', () => {
    const label = container.querySelector('.settings-row .settings-label > div');
    const before = label.innerHTML;
    applySettingsFilter(container, 'lang');
    applySettingsFilter(container, '');
    expect(label.innerHTML).toBe(before);
    expect(label.querySelector('mark')).toBeNull();
  });

  test('narrowing then widening the query re-marks from the original, not the marked-up copy', () => {
    const label = container.querySelector('.settings-row .settings-label > div');
    applySettingsFilter(container, 'lang');
    applySettingsFilter(container, 'gue');
    expect(label.textContent).toBe('Langue');
    expect(label.innerHTML).toBe('Lan<mark class="qp-hl">gue</mark>');
  });

  test('escapes the text it re-emits', () => {
    const el = document.createElement('div');
    el.textContent = '<img src=x onerror=alert(1)> ok';
    highlightSettingText(el, 'img');
    expect(el.querySelector('img')).toBeNull();
    expect(el.innerHTML).toContain('&lt;');
    expect(el.textContent).toBe('<img src=x onerror=alert(1)> ok');
  });

  test('leaves a node containing real markup alone rather than flattening it', () => {
    const el = document.createElement('div');
    el.innerHTML = 'Langue <span class="badge">beta</span>';
    const before = el.innerHTML;
    highlightSettingText(el, 'lang');
    expect(el.innerHTML).toBe(before);
  });
});
