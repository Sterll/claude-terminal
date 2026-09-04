// model-options — the id-matching rules the chat model picker depends on.
//
// These exist because the CLI and the app do not speak the same ids: the CLI
// advertises aliases with context-variant suffixes ('opus[1m]'), while settings
// persist whatever the user picked, which may be a canonical wire id or a
// legacy id the CLI no longer lists.

const {
  baseModelId,
  matchModel,
  resolveModelSelection,
  dedupeLegacy,
  hasOneMContext,
  normalizeModelRow,
  orderPrimary,
  CLAUDE_MODEL_VALUES,
  LEGACY_MODELS,
  FALLBACK_PRIMARY,
  DEFAULT_ALIAS,
} = require('../../src/shared/model-options');

// Shaped like the CLI's real init payload.
const CLI_MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
  { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
];

describe('baseModelId', () => {
  test('strips a context-variant suffix', () => {
    expect(baseModelId('claude-opus-5[1m]')).toBe('claude-opus-5');
    expect(baseModelId('opus[1m]')).toBe('opus');
  });

  test('leaves a plain id alone', () => {
    expect(baseModelId('claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  test('tolerates non-strings rather than throwing', () => {
    expect(baseModelId(undefined)).toBe('');
    expect(baseModelId(null)).toBe('');
  });
});

describe('matchModel', () => {
  test('matches an exact advertised value', () => {
    expect(matchModel(CLI_MODELS, 'sonnet').displayName).toBe('Sonnet');
  });

  test('matches a canonical id via resolvedModel', () => {
    // What a settings file written before the alias existed would hold.
    expect(matchModel(CLI_MODELS, 'claude-haiku-4-5-20251001').displayName).toBe('Haiku');
  });

  test('matches across a context-variant suffix', () => {
    // Persisted 'claude-opus-5' must find the row whose resolvedModel is
    // 'claude-opus-5[1m]' — otherwise a stored choice silently resets.
    expect(matchModel(CLI_MODELS, 'claude-opus-5')).not.toBeNull();
  });

  test('prefers an exact value over a base-id match', () => {
    // 'default' and 'opus[1m]' both resolve to claude-opus-5; asking for
    // 'opus[1m]' must not hand back the 'default' alias, whose target can move.
    expect(matchModel(CLI_MODELS, 'opus[1m]').value).toBe('opus[1m]');
  });

  test('prefers a concrete row over the default alias', () => {
    // 'default' sits first in the CLI payload and also covers claude-opus-5.
    // Resolving onto it would let the next CLI release silently re-point a
    // stored choice, so the concrete build has to win.
    expect(matchModel(CLI_MODELS, 'claude-opus-5').value).toBe('opus[1m]');
  });

  test('still resolves default when it is the only cover', () => {
    const onlyDefault = [CLI_MODELS[0]];
    expect(matchModel(onlyDefault, 'claude-opus-5').value).toBe('default');
  });

  test('an explicit default pick resolves to itself', () => {
    expect(matchModel(CLI_MODELS, 'default').value).toBe('default');
  });
});

describe('normalizeModelRow', () => {
  // Verbatim payloads from Claude Code 2.1.260 — the CLI added the pricing
  // segment in a patch release, which is exactly the kind of drift this
  // normalization has to absorb without a code change.
  const cases = [
    {
      raw: { value: 'opus[1m]', displayName: 'Opus (1M context)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks · $5/$25 per Mtok' },
      displayName: 'Opus 5',
      description: 'Best for everyday, complex tasks',
    },
    {
      raw: { value: 'claude-fable-5-1[1m]', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks' },
      displayName: 'Fable 5.1',
      description: 'Most capable for your hardest and longest-running tasks',
    },
    {
      raw: { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks · $2/$10 per Mtok' },
      displayName: 'Sonnet 5',
      description: 'Efficient for routine tasks',
    },
    {
      raw: { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok' },
      displayName: 'Haiku 4.5',
      description: 'Fastest for quick answers',
    },
  ];

  test.each(cases)('promotes the version into $displayName', ({ raw, displayName, description }) => {
    const out = normalizeModelRow(raw);
    expect(out.displayName).toBe(displayName);
    expect(out.description).toBe(description);
  });

  test('never leaves pricing in the description', () => {
    for (const { raw } of cases) {
      expect(normalizeModelRow(raw).description).not.toMatch(/\$|Mtok/i);
    }
  });

  test('keeps the default alias label and its prose', () => {
    // Its lead segment describes the alias, it does not name the family — so
    // promoting it would produce the label "Use the default model (…)".
    const out = normalizeModelRow({
      value: 'default',
      displayName: 'Default (recommended)',
      description: 'Use the default model (currently Opus 5 (1M context)) · $5/$25 per Mtok',
    });
    expect(out.displayName).toBe('Default (recommended)');
    expect(out.description).toBe('Use the default model (currently Opus 5 (1M context))');
  });

  test('leaves the identifying fields untouched', () => {
    const raw = { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus', description: 'Opus 5 · x', supportsAdaptiveThinking: true };
    const out = normalizeModelRow(raw);
    expect(out.value).toBe('opus[1m]');
    expect(out.resolvedModel).toBe('claude-opus-5[1m]');
    expect(out.supportsAdaptiveThinking).toBe(true);
  });

  test('handles a row with no description', () => {
    const out = normalizeModelRow({ value: 'x', displayName: 'Opus 4.8' });
    expect(out.displayName).toBe('Opus 4.8');
    expect(out.description).toBe('');
  });

  test('passes through non-objects', () => {
    expect(normalizeModelRow(null)).toBeNull();
  });
});

describe('hasOneMContext', () => {
  test('detects the CLI 1M build suffix', () => {
    expect(hasOneMContext('claude-opus-5[1m]')).toBe(true);
    expect(hasOneMContext('opus[1m]')).toBe(true);
  });

  test('is false for a plain id', () => {
    expect(hasOneMContext('claude-opus-5')).toBe(false);
    expect(hasOneMContext('haiku')).toBe(false);
  });

  test('tolerates non-strings', () => {
    expect(hasOneMContext(undefined)).toBe(false);
    expect(hasOneMContext(null)).toBe(false);
  });
});

describe('matchModel — misses and single-row form', () => {
  test('returns null for an unknown id', () => {
    expect(matchModel(CLI_MODELS, 'gpt-4')).toBeNull();
  });

  test('returns null on empty input rather than throwing', () => {
    expect(matchModel(CLI_MODELS, '')).toBeNull();
    expect(matchModel(null, 'sonnet')).toBeNull();
  });

  test('single-row form answers "does this row cover the selection"', () => {
    // How the renderer marks the active row.
    const row = CLI_MODELS[1];
    expect(matchModel([row], 'claude-opus-5')).toBe(row);
    expect(matchModel([row], 'sonnet')).toBeNull();
  });
});

describe('orderPrimary', () => {
  test('puts Fable above Opus, against the CLI order', () => {
    // The CLI ships Opus first; we surface the more capable model first.
    const ordered = orderPrimary(CLI_MODELS).map(m => m.value);
    expect(ordered.indexOf('claude-fable-5-1[1m]')).toBeLessThan(ordered.indexOf('opus[1m]'));
  });

  test('keeps the recommended alias at the top', () => {
    expect(orderPrimary(CLI_MODELS)[0].value).toBe('default');
  });

  test('orders the families fable → opus → sonnet → haiku', () => {
    expect(orderPrimary(CLI_MODELS).map(m => m.value)).toEqual([
      'default', 'claude-fable-5-1[1m]', 'opus[1m]', 'sonnet', 'haiku',
    ]);
  });

  test('is stable within a family', () => {
    // Two Opus builds keep the order the CLI gave them.
    const rows = [
      { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]' },
      { value: 'opus', resolvedModel: 'claude-opus-5' },
    ];
    expect(orderPrimary(rows).map(m => m.value)).toEqual(['opus[1m]', 'opus']);
  });

  test('sorts an unrecognised family last without dropping it', () => {
    const rows = [{ value: 'mystery-model' }, { value: 'sonnet', resolvedModel: 'claude-sonnet-5' }];
    expect(orderPrimary(rows).map(m => m.value)).toEqual(['sonnet', 'mystery-model']);
  });

  test('does not mutate its input', () => {
    const rows = [...CLI_MODELS];
    orderPrimary(rows);
    expect(rows).toEqual(CLI_MODELS);
  });

  test('tolerates a non-array', () => {
    expect(orderPrimary(null)).toEqual([]);
  });
});

describe('dedupeLegacy', () => {
  test('drops a legacy entry the primary tier already covers', () => {
    const primary = [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8' }];
    const result = dedupeLegacy(primary, LEGACY_MODELS);
    expect(result.find(m => m.value === 'claude-opus-4-8')).toBeUndefined();
    expect(result.find(m => m.value === 'claude-opus-4-7')).toBeDefined();
  });

  test('matches on resolvedModel, not just value', () => {
    // The real promotion case: the CLI lists Fable 5.1 as 'claude-fable-5-1[1m]'
    // while the legacy list holds the plain id of the model it replaced.
    const primary = [{ value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5' }];
    const result = dedupeLegacy(primary, LEGACY_MODELS);
    expect(result.find(m => m.value === 'claude-fable-5')).toBeUndefined();
  });

  test('keeps the whole legacy tier when nothing overlaps', () => {
    expect(dedupeLegacy(CLI_MODELS, LEGACY_MODELS)).toHaveLength(LEGACY_MODELS.length);
  });

  test('tolerates missing arguments', () => {
    expect(dedupeLegacy(null, null)).toEqual([]);
    expect(dedupeLegacy([], LEGACY_MODELS)).toHaveLength(LEGACY_MODELS.length);
  });
});

describe('resolveModelSelection', () => {
  // The footer paints twice: once on whatever catalog is loaded, once after the
  // CLI answers. Both passes go through here, so the interesting cases are the
  // ones where the two passes see different catalogs.
  const FALLBACK = [...FALLBACK_PRIMARY, ...dedupeLegacy(FALLBACK_PRIMARY, LEGACY_MODELS)];
  const CLI = [...orderPrimary(CLI_MODELS), ...dedupeLegacy(CLI_MODELS, LEGACY_MODELS)];

  test('labels an unchosen model the same on either tier', () => {
    // The reported glitch: the same fresh install read "Opus 5" when the footer
    // painted before the catalog IPC landed, and "Default (recommended)" when
    // it landed first. Which one you got depended on the reload.
    const cold = resolveModelSelection(FALLBACK, '', false);
    const warm = resolveModelSelection(CLI, '', false);
    expect(cold.label).toBe(warm.label);
    expect(cold.value).toBe(DEFAULT_ALIAS);
    expect(warm.value).toBe(DEFAULT_ALIAS);
  });

  test('never persists a selection nobody made', () => {
    // Second pass of a cold start: `preferred` is the id the first pass derived,
    // not a preference. Storing it froze the race into settings.json.
    const derived = resolveModelSelection(FALLBACK, '', false);
    const second = resolveModelSelection(CLI, derived.value, false);
    expect(derived.persist).toBe(false);
    expect(second.persist).toBe(false);
  });

  test('still upgrades a stored id to the build the CLI advertises', () => {
    // The one case that *should* write: a real choice of 'claude-opus-5' adopts
    // the CLI's 'opus[1m]' row, so the footer stops claiming the wrong context.
    const res = resolveModelSelection(CLI, 'claude-opus-5', true);
    expect(res.value).toBe('opus[1m]');
    expect(res.persist).toBe(true);
  });

  test('does not rewrite a choice that already matches', () => {
    const res = resolveModelSelection(CLI, 'sonnet', true);
    expect(res.value).toBe('sonnet');
    expect(res.persist).toBe(false);
  });

  test('shows an id the catalog does not cover rather than swapping it', () => {
    const res = resolveModelSelection(CLI, 'claude-opus-3', true);
    expect(res.label).toBe('opus-3');
    expect(res.value).toBe('claude-opus-3');
    expect(res.persist).toBe(false);
  });

  test('returns null when there is nothing at all to paint', () => {
    expect(resolveModelSelection([], '', false)).toBeNull();
    expect(resolveModelSelection(null, '', false)).toBeNull();
  });
});

describe('catalog contents', () => {
  test('both tiers lead with the recommended alias', () => {
    // What keeps the two passes above agreeing. `orderPrimary` is applied to the
    // fallback too (ModelCatalogService._shape), so assert it survives ordering.
    expect(FALLBACK_PRIMARY[0].value).toBe(DEFAULT_ALIAS);
    expect(orderPrimary(FALLBACK_PRIMARY)[0].value).toBe(DEFAULT_ALIAS);
    expect(orderPrimary(CLI_MODELS)[0].value).toBe(DEFAULT_ALIAS);
  });

  test('the offline alias does not soak up a concrete id', () => {
    // It carries no resolvedModel, so matchModel must still prefer a real row.
    expect(matchModel(FALLBACK_PRIMARY, 'claude-opus-5').value).toBe('claude-opus-5');
  });

  test('the workflow node accepts the current Fable id', () => {
    // Regression guard: this list gates `claude` node validation, and Fable 5.1
    // was rejected there while only Fable 5 was listed.
    expect(CLAUDE_MODEL_VALUES).toContain('claude-fable-5-1');
  });

  test('every catalog row carries what the picker renders', () => {
    for (const m of [...FALLBACK_PRIMARY, ...LEGACY_MODELS]) {
      expect(typeof m.value).toBe('string');
      expect(m.value.length).toBeGreaterThan(0);
      expect(typeof m.displayName).toBe('string');
    }
  });

});
