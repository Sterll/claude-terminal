// The five palette sources added on top of projects / commands / quick actions,
// and the grouping the palette lays them out with.
//
// The point of the grouping test is that five more sources must not turn the
// palette into one undifferentiated list: every row still arrives under a named
// group, and a group that failed contributes nothing rather than an error row.

const registry = require('../../src/renderer/services/MentionSourceRegistry');
const settingsSource = require('../../src/renderer/services/mention-sources/settings.source');
const knowledgeSource = require('../../src/renderer/services/mention-sources/knowledge.source');

const flush = () => new Promise(r => setTimeout(r, 0));

describe('settings source', () => {
  test('is palette-only — a preference is not chat context', () => {
    expect(settingsSource.surfaces).toEqual(['palette']);
    expect(settingsSource.getChipData).toBeUndefined();
  });

  test('every catalog entry carries a label key and a tab', () => {
    for (const entry of settingsSource._catalog) {
      expect(typeof entry.labelKey).toBe('string');
      expect(entry.labelKey).toContain('.');
      expect(entry.tab).toBeTruthy();
    }
  });

  test('catalog ids are unique', () => {
    const ids = settingsSource._catalog.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('contributes nothing until something is typed', () => {
    // Forty preferences is not a browsable list; dumping them into the palette's
    // default view would push projects and commands past the visible cap.
    expect(settingsSource.getData({})).toEqual([]);
    expect(settingsSource.getData({ query: '   ' })).toEqual([]);
    expect(settingsSource.getData({ query: 'a' }).length).toBeGreaterThan(0);
  });

  test('rows are labelled with the translated setting and subtitled with its tab', () => {
    const rows = settingsSource.getData({ query: 'a' });
    const language = rows.find(r => r.id === 'language');
    expect(language.label).toBe('Language');           // t('settings.language')
    const rendered = settingsSource.render(language);
    expect(rendered.label).toBe('Language');
    expect(rendered.sublabel).toContain('General');    // t('settings.tabGeneral')
  });

  test('a raw i18n key never leaks into the UI as a sublabel', () => {
    for (const rendered of settingsSource.getData({ query: 'a' }).map(r => settingsSource.render(r))) {
      expect(rendered.label).not.toMatch(/^settings\./);
      expect(rendered.sublabel).not.toMatch(/^settings\./);
    }
  });

  test('matches on the label the panel renders, so it works per locale', async () => {
    registry.register(settingsSource);
    try {
      const results = await registry.query('settings', { query: 'dotfiles' });
      expect(results.map(r => r.label)).toContain('Show dotfiles');
    } finally {
      registry.unregister('settings');
    }
  });

  test('selecting a row deep-links into the panel with the filter pre-filled', () => {
    const SettingsPanel = require('../../src/renderer/ui/panels/SettingsPanel');
    const spy = jest.spyOn(SettingsPanel, 'focusSetting').mockImplementation(() => {});
    try {
      const row = settingsSource.getData({ query: 'a' }).find(r => r.id === 'showDotfiles');
      settingsSource.onSelect(row, 'palette');
      expect(spy).toHaveBeenCalledWith({
        tab: 'general',
        query: row.label,
        anchor: 'show-dotfiles-toggle',
      });
    } finally {
      spy.mockRestore();
    }
  });

  test('does nothing on the mention surface it never declared', () => {
    const SettingsPanel = require('../../src/renderer/ui/panels/SettingsPanel');
    const spy = jest.spyOn(SettingsPanel, 'focusSetting').mockImplementation(() => {});
    settingsSource.onSelect(settingsSource.getData({ query: 'a' })[0], 'mention');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('knowledge source', () => {
  beforeEach(() => {
    knowledgeSource._resetCache();
    window.electron_api.knowledge = {
      list: jest.fn(async () => ({ success: true, entries: [{ id: 'a', title: 'Deploy runbook' }] })),
      search: jest.fn(async () => ({
        success: true,
        results: [{ id: 'b', title: 'Release policy', snippet: 'never  ship\n on  a Friday' }],
      })),
    };
  });
  afterEach(() => { delete window.electron_api.knowledge; });

  test('browses with list() and searches bodies with search()', async () => {
    expect((await knowledgeSource.getData({ query: '' })).map(e => e.id)).toEqual(['a']);
    expect(window.electron_api.knowledge.search).not.toHaveBeenCalled();

    expect((await knowledgeSource.getData({ query: 'friday' })).map(e => e.id)).toEqual(['b']);
    expect(window.electron_api.knowledge.search).toHaveBeenCalledWith('friday');
  });

  test('keeps body-only hits the label filter would have thrown away', async () => {
    registry.register(knowledgeSource);
    try {
      // "friday" appears nowhere in "Release policy" — only in the entry body.
      const results = await registry.query('knowledge', { query: 'friday' });
      expect(results.map(r => r.label)).toEqual(['Release policy']);
      expect(results[0].sublabel).toBe('never ship on a Friday');
    } finally {
      registry.unregister('knowledge');
    }
  });

  test('the browse list is cached, the query is not', async () => {
    await knowledgeSource.getData({ query: '' });
    await knowledgeSource.getData({ query: '' });
    expect(window.electron_api.knowledge.list).toHaveBeenCalledTimes(1);

    await knowledgeSource.getData({ query: 'x' });
    await knowledgeSource.getData({ query: 'x' });
    expect(window.electron_api.knowledge.search).toHaveBeenCalledTimes(2);
  });

  test('an unsuccessful IPC answer yields no rows rather than an exception', async () => {
    window.electron_api.knowledge.list.mockResolvedValue({ success: false, error: 'nope' });
    knowledgeSource._resetCache();
    await expect(knowledgeSource.getData({ query: '' })).resolves.toEqual([]);
  });

  test('a rejecting IPC call is contained by the registry, not by the palette', async () => {
    window.electron_api.knowledge.search.mockRejectedValue(new Error('main is gone'));
    registry.register(knowledgeSource);
    try {
      const seen = {};
      await registry.runSources('palette', { query: 'x' }, {
        onSource: (src, items, error) => { seen[src.id] = { items, error }; },
      }).done;
      expect(seen.knowledge).toEqual({ items: [], error: expect.any(Error) });
    } finally {
      registry.unregister('knowledge');
    }
  });
});

describe('palette grouping', () => {
  const { refreshPaletteSources, buildSourceSections, quickPickerState } =
    require('../../src/renderer/features/QuickPicker');

  const stub = (id, getData, extra = {}) => ({
    id, keyword: `@${id}`, prefix: null, surfaces: ['palette'], scope: 'global',
    label: () => `Group ${id}`, icon: '<svg></svg>',
    getData,
    render: (item) => ({ label: item.label, sublabel: item.sublabel || '' }),
    onSelect: () => {},
    ...extra,
  });

  beforeEach(() => {
    for (const s of registry.getAll()) registry.unregister(s.id);
    quickPickerState.sourceResults = {};
    quickPickerState.sourceToken = 0;
  });
  afterEach(() => {
    for (const s of registry.getAll()) registry.unregister(s.id);
  });

  test('each source becomes its own labelled section', async () => {
    registry.register(stub('alpha', () => [{ id: '1', label: 'kanban card' }]));
    registry.register(stub('beta', () => [{ id: '2', label: 'kanban doc' }]));

    refreshPaletteSources('kanban', 'all', null, () => {});
    await flush();

    const sections = buildSourceSections('kanban', 'all', null);
    expect(sections.map(s => s.label)).toEqual(['Group alpha', 'Group beta']);
    expect(sections.every(s => s.items.length === 1)).toBe(true);
  });

  test('a failing source contributes no section at all', async () => {
    registry.register(stub('good', () => [{ id: '1', label: 'here' }]));
    registry.register(stub('bad', () => { throw new Error('down'); }));
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    refreshPaletteSources('here', 'all', null, () => {});
    await flush();

    const sections = buildSourceSections('here', 'all', null);
    expect(sections.map(s => s.key)).toEqual(['good']);
    console.warn.mockRestore();
  });

  test('the matched substring is highlighted the way the palette does elsewhere', async () => {
    registry.register(stub('s', () => [{ id: '1', label: 'Télémétrie' }]));
    refreshPaletteSources('telemetrie', 'all', null, () => {});
    await flush();

    const [section] = buildSourceSections('telemetrie', 'all', null);
    expect(section.items[0].labelHtml).toBe('<mark class="qp-hl">Télémétrie</mark>');
  });

  test('rows a source kept through its own filter are not re-filtered away', async () => {
    registry.register(stub('s', () => [{ id: '1', label: 'untitled' }], {
      filter: (items) => items, // matched on hidden text
    }));
    refreshPaletteSources('body text', 'all', null, () => {});
    await flush();

    const [section] = buildSourceSections('body text', 'all', null);
    expect(section.items.map(i => i.label)).toEqual(['untitled']);
    expect(section.items[0].labelHtml).toBeNull(); // nothing to highlight
  });

  test('a project-scoped source is skipped when no project is open', async () => {
    registry.register(stub('proj', () => [{ id: '1', label: 'x' }], { scope: 'project' }));
    refreshPaletteSources('x', 'all', null, () => {});
    await flush();
    expect(buildSourceSections('x', 'all', null)).toEqual([]);

    refreshPaletteSources('x', 'all', { id: 'p', path: '/p' }, () => {});
    await flush();
    expect(buildSourceSections('x', 'all', { id: 'p', path: '/p' })).toHaveLength(1);
  });

  test('a first load shows a skeleton; a re-query keeps the previous rows instead', async () => {
    let resolve;
    const gate = () => new Promise(r => { resolve = r; });
    registry.register(stub('s', () => gate().then(() => [{ id: '1', label: 'row' }])));

    refreshPaletteSources('r', 'all', null, () => {});
    expect(buildSourceSections('r', 'all', null)[0]).toMatchObject({ loading: true, items: [] });

    // getData runs on a microtask, so the gate only exists after a turn.
    await flush();
    resolve();
    await flush();
    expect(buildSourceSections('r', 'all', null)[0].items).toHaveLength(1);

    // Second pass: still in flight, but the list does not flash back to a skeleton.
    refreshPaletteSources('ro', 'all', null, () => {});
    const section = buildSourceSections('ro', 'all', null)[0];
    expect(section.loading).toBeUndefined();
    expect(section.items).toHaveLength(1);
    await flush();
    resolve();
    await flush();
  });

  test('a superseded pass cannot paint over the newer one', async () => {
    const gates = [];
    registry.register(stub('s', () => new Promise(r => gates.push(r))));

    const painted = [];
    // Each pass is let through a microtask so it registers its gate before the
    // next one supersedes it — the shape of a user typing through a slow source.
    refreshPaletteSources('old', 'all', null, () => painted.push('old'));
    await flush();
    refreshPaletteSources('new', 'all', null, () => painted.push('new'));
    await flush();

    gates[1]([{ id: '2', label: 'new row' }]);
    await flush();
    gates[0]([{ id: '1', label: 'old row' }]);
    await flush();

    expect(painted).toEqual(['new']);
    expect(buildSourceSections('new', 'all', null)[0].items.map(i => i.label)).toEqual(['new row']);
  });
});
