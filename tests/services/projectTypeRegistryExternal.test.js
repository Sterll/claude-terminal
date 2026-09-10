/**
 * The renderer half: turning a validated manifest into a registered type, and
 * the loader that decides whether to ask for one at all.
 *
 * Two things these tests are really about:
 *
 *   1. Nothing an extension supplies becomes code. A manifest carrying a
 *      function-shaped field must not end up callable, and a manifest carrying
 *      markup must not end up in the DOM.
 *   2. `registerExternal` and `loadExtensions` are on the renderer's boot path,
 *      so neither may throw. An exception there is a window that never renders.
 */

'use strict';

const registry = require('../../src/project-types/registry');
const { createExternalType } = require('../../src/project-types/external-type');

const VALID_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 3 7v10z"/></svg>';

/** A manifest in the shape listExtensions() returns, i.e. already validated. */
const entry = (over = {}) => ({
  manifest: 1,
  id: 'rust',
  typeId: 'ext-rust',
  name: 'Rust',
  description: 'Cargo-based Rust project',
  badge: 'Cargo',
  category: 'general',
  color: '#dea584',
  icon: VALID_ICON,
  engines: { claudeTerminal: '*' },
  detect: { files: ['Cargo.toml'], dirs: ['src'] },
  dirName: 'rust',
  translations: {},
  status: 'enabled',
  ...over,
});

beforeEach(() => {
  registry.discoverAll();
  document.head.innerHTML = '';
});

afterEach(() => {
  registry.clearExternal();
});

// ── Building a descriptor ────────────────────────────────────────────────────

describe('createExternalType', () => {
  it('produces a descriptor with every base hook present', () => {
    const type = createExternalType(entry());

    expect(type.id).toBe('ext-rust');
    expect(type.nameKey).toBe('ext.rust.name');
    expect(type.descKey).toBe('ext.rust.description');
    expect(type.external).toBe(true);
    expect(type.extensionId).toBe('rust');
    // Inherited no-ops, so no caller has to know this type is external.
    expect(typeof type.getWizardFields).toBe('function');
    expect(type.getWizardFields()).toBe('');
    expect(type.getTerminalPanels({})).toEqual([]);
    expect(type.getPreloadBridge()).toBeNull();
    expect(type.mainModule()).toBeNull();
  });

  it('cannot be given behaviour by the manifest', () => {
    // Every hook on the descriptor must be this repo's code. A manifest field
    // that collides with a hook name is data and stays data — if any of these
    // came through, an extension would have gained a callback the app invokes.
    const hostile = entry({
      initialize: 'attacker',
      getWizardFields: '<script>alert(1)</script>',
      mainModule: { registerHandlers: 'x' },
      getStyles: 'body { display: none }',
      getPreloadBridge: { namespace: 'evil', channels: { invoke: ['*'] } },
    });

    const type = createExternalType(hostile);

    expect(type.getWizardFields()).toBe('');
    expect(type.getPreloadBridge()).toBeNull();
    expect(type.mainModule()).toBeNull();
    expect(() => type.initialize({})).not.toThrow();
    expect(type.getStyles()).not.toContain('display: none');
  });

  it('falls back to a built-in icon rather than rendering a hostile one', () => {
    const type = createExternalType(entry({ icon: '<svg onload="alert(1)"></svg>' }));
    expect(type.icon).not.toContain('onload');
    expect(type.icon.startsWith('<svg')).toBe(true);

    const noIcon = createExternalType(entry({ icon: null }));
    expect(noIcon.icon.startsWith('<svg')).toBe(true);
  });

  it('generates scoped CSS from the colour and nothing else', () => {
    const css = createExternalType(entry()).getStyles();

    expect(css).toContain('#dea584');
    expect(css).toContain('.project-type-icon.ext-rust');
    // Every selector is scoped to this type's own class.
    const selectors = css.match(/^\.[^\s{,]+/gm) || [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const sel of selectors) expect(sel).toContain('ext-rust');
    expect(css).not.toContain('</style>');
  });

  it('emits no stylesheet at all when there is no colour', () => {
    expect(createExternalType(entry({ color: null })).getStyles()).toBeNull();
  });

  it('namespaces translations under ext.<id> and falls back per locale', () => {
    const type = createExternalType(entry({
      translations: { fr: { name: 'Rust', description: 'Projet Cargo' } },
    }));
    const bundle = type.getTranslations();

    expect(Object.keys(bundle.fr)).toEqual(['ext']);
    expect(bundle.fr.ext.rust).toEqual({ name: 'Rust', description: 'Projet Cargo' });
    // No French-only leak into the other locales, and no missing entries either.
    expect(bundle.es.ext.rust.description).toBe('Cargo-based Rust project');
    expect(bundle['zh-CN'].ext.rust.name).toBe('Rust');
  });

  it('ignores a translation override that is not plain text', () => {
    const type = createExternalType(entry({
      translations: { fr: { name: '<img src=x onerror=alert(1)>' } },
    }));
    expect(type.getTranslations().fr.ext.rust.name).toBe('Rust');
  });

  it('refuses a typeId that is not ext-prefixed', () => {
    // Shadowing a built-in must not be reachable, even if a manifest gets here
    // without having gone through validateManifest().
    expect(() => createExternalType(entry({ typeId: 'fivem' }))).toThrow(/typeId/);
    expect(() => createExternalType(entry({ typeId: 'ext-../evil' }))).toThrow(/typeId/);
    expect(() => createExternalType(entry({ typeId: undefined }))).toThrow(/typeId/);
    expect(() => createExternalType(null)).toThrow();
  });
});

// ── Registering ──────────────────────────────────────────────────────────────

describe('registry.registerExternal', () => {
  it('registers an enabled extension alongside the built-ins', () => {
    const before = registry.getAll().length;
    const result = registry.registerExternal([entry()]);

    expect(result.registered).toEqual(['ext-rust']);
    expect(result.failed).toEqual([]);
    expect(registry.getAll()).toHaveLength(before + 1);
    expect(registry.get('ext-rust').nameKey).toBe('ext.rust.name');
    expect(registry.isExternal('ext-rust')).toBe(true);
    expect(registry.isExternal('fivem')).toBe(false);
  });

  it('skips entries that are not enabled', () => {
    const result = registry.registerExternal([
      entry({ status: 'disabled' }),
      entry({ id: 'go', typeId: 'ext-go', name: 'Go', status: 'incompatible' }),
    ]);

    expect(result.registered).toEqual([]);
    expect(registry.getExternalIds()).toEqual([]);
  });

  it('lets one broken entry fail without taking the others with it', () => {
    const result = registry.registerExternal([
      entry({ id: 'good', typeId: 'ext-good', name: 'Good' }),
      entry({ typeId: 'not-prefixed' }),
      entry({ id: 'alsogood', typeId: 'ext-alsogood', name: 'Also Good' }),
    ]);

    expect(result.registered).toEqual(['ext-good', 'ext-alsogood']);
    expect(result.failed).toHaveLength(1);
    expect(registry.get('ext-good').id).toBe('ext-good');
  });

  it('never throws, whatever it is handed', () => {
    for (const junk of [null, undefined, 'nonsense', 42, {}, [null], [undefined], [[]]]) {
      expect(() => registry.registerExternal(junk)).not.toThrow();
    }
    expect(registry.getExternalIds()).toEqual([]);
    // The built-ins are untouched by any of it.
    expect(registry.get('standalone').id).toBe('standalone');
  });

  it('injects the stylesheet and takes it away again on clear', () => {
    registry.registerExternal([entry()]);
    const tag = document.querySelector('style[data-project-type="ext-rust"]');
    expect(tag).not.toBeNull();
    expect(tag.textContent).toContain('#dea584');

    registry.clearExternal();
    expect(document.querySelector('style[data-project-type="ext-rust"]')).toBeNull();
    expect(registry.get('ext-rust').id).toBe('standalone'); // falls back
  });

  it('replaces the previous set rather than accumulating', () => {
    registry.registerExternal([entry()]);
    registry.registerExternal([entry({ id: 'go', typeId: 'ext-go', name: 'Go' })]);

    expect(registry.getExternalIds()).toEqual(['ext-go']);
    expect(document.querySelectorAll('style[data-project-type^="ext-"]')).toHaveLength(1);
  });

  it('leaves the built-ins alone when discoverAll runs again', () => {
    registry.registerExternal([entry()]);
    registry.discoverAll();
    expect(registry.getExternalIds()).toEqual([]);
    expect(registry.get('standalone').id).toBe('standalone');
  });

  it('merges translations through the callback, one call per locale', () => {
    const mergeTranslations = jest.fn();
    registry.registerExternal([entry()], { mergeTranslations });

    expect(mergeTranslations).toHaveBeenCalledTimes(5);
    const langs = mergeTranslations.mock.calls.map((c) => c[0]).sort();
    expect(langs).toEqual(['en', 'es', 'fr', 'id', 'zh-CN']);
    for (const [, bundle] of mergeTranslations.mock.calls) {
      expect(Object.keys(bundle)).toEqual(['ext']);
    }
  });

  it('still registers the type when merging a locale throws', () => {
    const mergeTranslations = jest.fn(() => { throw new Error('i18n exploded'); });
    const result = registry.registerExternal([entry()], { mergeTranslations });

    expect(result.registered).toEqual(['ext-rust']);
  });

  it('groups an external type into the wizard categories', () => {
    registry.registerExternal([entry({ category: 'gamedev' })]);
    const gamedev = registry.getByCategory().find((g) => g.category.id === 'gamedev');
    expect(gamedev.types.map((t) => t.id)).toContain('ext-rust');
  });
});

// ── The loader ───────────────────────────────────────────────────────────────

describe('ProjectTypeExtensionLoader', () => {
  let loader;
  let settings;

  beforeEach(() => {
    jest.resetModules();
    settings = { projectTypeExtensionsEnabled: false, enabledProjectTypeExtensions: [] };
    jest.doMock('../../src/renderer/state/settings.state', () => ({
      getSetting: (key) => settings[key],
    }));
    // Mirrors the real `t()`: a known key returns its string, an unknown key
    // returns itself. `describeProblem` distinguishes the two, so a mock that
    // always echoed the key would only ever exercise the fallback branch.
    const KNOWN = new Set([
      'projectTypes.problem.title',
      'projectTypes.problem.andMore',
      'projectTypes.problem.bad-id',
      'projectTypes.problem.incompatible',
      'projectTypes.problem.no-manifest',
      'projectTypes.problem.threw',
    ]);
    jest.doMock('../../src/renderer/i18n', () => ({
      t: (key) => (KNOWN.has(key) ? `translated(${key})` : key),
    }));
    loader = require('../../src/renderer/services/ProjectTypeExtensionLoader');
  });

  afterEach(() => {
    jest.dontMock('../../src/renderer/state/settings.state');
    jest.dontMock('../../src/renderer/i18n');
  });

  it('does not even ask when the setting is off — which it is by default', async () => {
    const listExtensions = jest.fn();
    const result = await loader.loadExtensions({ api: { projectTypes: { listExtensions } } });

    expect(result.skipped).toBe('disabled');
    expect(listExtensions).not.toHaveBeenCalled();
    expect(result.registered).toEqual([]);
  });

  it('confirms the default really is off in the shipped settings', () => {
    const { defaultSettings } = jest.requireActual('../../src/renderer/state/settings.state');
    expect(defaultSettings.projectTypeExtensionsEnabled).toBe(false);
    expect(defaultSettings.enabledProjectTypeExtensions).toEqual([]);
  });

  it('registers what the main process returns once enabled', async () => {
    settings.projectTypeExtensionsEnabled = true;
    const listExtensions = jest.fn().mockResolvedValue({
      dir: '/home/.claude-terminal/project-types',
      enabled: true,
      extensions: [entry()],
      problems: [],
    });
    const toast = { showWarning: jest.fn() };

    const result = await loader.loadExtensions({ api: { projectTypes: { listExtensions } }, toast });

    expect(listExtensions).toHaveBeenCalled();
    expect(result.registered).toEqual(['ext-rust']);
    expect(toast.showWarning).not.toHaveBeenCalled();
  });

  it('folds every problem into one toast rather than a stack of them', async () => {
    settings.projectTypeExtensionsEnabled = true;
    const listExtensions = jest.fn().mockResolvedValue({
      extensions: [],
      problems: [
        { id: 'a', reason: 'bad-id', detail: 'x' },
        { id: 'b', reason: 'incompatible', detail: 'y' },
        { id: 'c', reason: 'no-manifest', detail: 'z' },
        { id: 'd', reason: 'threw', detail: 'w' },
      ],
    });
    const toast = { showWarning: jest.fn() };

    await loader.loadExtensions({ api: { projectTypes: { listExtensions } }, toast });

    expect(toast.showWarning).toHaveBeenCalledTimes(1);
    const [message] = toast.showWarning.mock.calls[0];
    expect(message).toContain('projectTypes.problem.title');
    expect(message).toContain('a:');
    expect(message).toContain('projectTypes.problem.andMore');
  });

  it('reports a rejected IPC call instead of propagating it', async () => {
    settings.projectTypeExtensionsEnabled = true;
    const listExtensions = jest.fn().mockRejectedValue(new Error('main is on fire'));

    const result = await loader.loadExtensions({ api: { projectTypes: { listExtensions } } });
    expect(result.skipped).toBe('error');
    expect(result.registered).toEqual([]);
  });

  it('copes with a malformed IPC payload', async () => {
    settings.projectTypeExtensionsEnabled = true;
    for (const payload of [null, undefined, 'nope', {}, { extensions: 'not an array' }]) {
      const listExtensions = jest.fn().mockResolvedValue(payload);
      const result = await loader.loadExtensions({ api: { projectTypes: { listExtensions } } });
      expect(result.registered).toEqual([]);
      expect(result.skipped).toBeUndefined();
    }
  });

  it('degrades quietly when the preload bridge is absent', async () => {
    settings.projectTypeExtensionsEnabled = true;
    expect((await loader.loadExtensions({ api: null })).skipped).toBe('no-bridge');
    expect((await loader.loadExtensions({ api: {} })).skipped).toBe('no-bridge');
    expect((await loader.loadExtensions({ api: { projectTypes: {} } })).skipped).toBe('no-bridge');
  });

  it('names the extension in the problem line it shows', () => {
    expect(loader.describeProblem({ id: 'rust', reason: 'bad-id', detail: 'x' }))
      .toBe('rust: translated(projectTypes.problem.bad-id)');
    // An unknown code falls back to the developer-facing detail rather than to
    // an empty bubble.
    expect(loader.describeProblem({ id: null, reason: 'brand-new-code', detail: 'the details' }))
      .toBe('the details');
  });
});
