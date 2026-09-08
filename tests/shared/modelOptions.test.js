// model-options — the id-matching rules the chat model picker depends on.
//
// These exist because the CLI and the app do not speak the same ids: the CLI
// advertises aliases with context-variant suffixes ('opus[1m]'), while settings
// persist whatever the user picked, which may be a canonical wire id or a
// legacy id the CLI no longer lists.

const {
  baseModelId,
  matchModel,
  recommendedModelId,
  dropDefaultAlias,
  resolveModelSelection,
  dedupeLegacy,
  hasOneMContext,
  normalizeModelRow,
  orderPrimary,
  modelFamily,
  modelTier,
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

// What every menu actually renders: the CLI payload minus its `default` alias.
// Nothing downstream of the catalog ever sees that row, so this — not
// CLI_MODELS — is the list the matching rules run against.
const MENU_MODELS = dropDefaultAlias(CLI_MODELS);

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
    expect(matchModel(MENU_MODELS, 'sonnet').displayName).toBe('Sonnet');
  });

  test('matches a canonical id via resolvedModel', () => {
    // What a settings file written before the CLI advertised builds would hold.
    expect(matchModel(MENU_MODELS, 'claude-haiku-4-5-20251001').displayName).toBe('Haiku');
  });

  test('matches across a context-variant suffix', () => {
    // Persisted 'claude-opus-5' must find the row whose resolvedModel is
    // 'claude-opus-5[1m]' — otherwise a stored choice silently resets.
    expect(matchModel(MENU_MODELS, 'claude-opus-5')).not.toBeNull();
  });

  test('prefers an exact value over a base-id match', () => {
    expect(matchModel(MENU_MODELS, 'opus[1m]').value).toBe('opus[1m]');
  });

  test('the init id and the API id land on the same row', () => {
    // One turn, two spellings of one model. The label must not move between
    // them, whichever order the events arrive in.
    expect(matchModel(MENU_MODELS, 'claude-opus-5[1m]')).toBe(matchModel(MENU_MODELS, 'claude-opus-5'));
  });

  test('no id lands on a row whose target moves between releases', () => {
    // The alias covered claude-opus-5 too, and sat first. Dropping it upstream
    // of every menu is what removes the ambiguity for good: the id the init
    // message reports resolves to the build the user is actually running.
    expect(MENU_MODELS.find(m => m.value === DEFAULT_ALIAS)).toBeUndefined();
    expect(matchModel(MENU_MODELS, 'claude-opus-5[1m]').value).toBe('opus[1m]');
    expect(matchModel(MENU_MODELS, 'claude-opus-5').value).toBe('opus[1m]');
  });
});

describe('the CLI default alias', () => {
  test('names the model it points at', () => {
    // Read before the row is dropped: it is how the picker can show the model
    // a fresh install runs on, by name, without offering the alias as a choice.
    expect(recommendedModelId(CLI_MODELS)).toBe('claude-opus-5[1m]');
  });

  test('reports nothing when no alias row exists', () => {
    // Offline, and on any CLI that stops advertising one.
    expect(recommendedModelId(FALLBACK_PRIMARY)).toBe('');
    expect(recommendedModelId(MENU_MODELS)).toBe('');
    expect(recommendedModelId(null)).toBe('');
  });

  test('is dropped without disturbing the other rows', () => {
    expect(dropDefaultAlias(CLI_MODELS).map(m => m.value))
      .toEqual(CLI_MODELS.slice(1).map(m => m.value));
    expect(dropDefaultAlias(null)).toEqual([]);
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

  test('keeps a row whose lead segment is prose rather than a name', () => {
    // The CLI's `default` row reads that way. The catalog drops it before this
    // runs, but the guard is what stops a future row of the same shape being
    // labelled with its own description.
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
    expect(matchModel(MENU_MODELS, 'gpt-4')).toBeNull();
  });

  test('returns null on empty input rather than throwing', () => {
    expect(matchModel(MENU_MODELS, '')).toBeNull();
    expect(matchModel(null, 'sonnet')).toBeNull();
  });

  test('single-row form answers "does this row cover the selection"', () => {
    // How the renderer marks the active row.
    const row = MENU_MODELS[0];
    expect(matchModel([row], 'claude-opus-5')).toBe(row);
    expect(matchModel([row], 'sonnet')).toBeNull();
  });
});

describe('orderPrimary', () => {
  test('puts Fable above Opus, against the CLI order', () => {
    // The CLI ships Opus first; we surface the more capable model first.
    const ordered = orderPrimary(MENU_MODELS).map(m => m.value);
    expect(ordered.indexOf('claude-fable-5-1[1m]')).toBeLessThan(ordered.indexOf('opus[1m]'));
  });

  test('orders the families fable → opus → sonnet → haiku', () => {
    expect(orderPrimary(MENU_MODELS).map(m => m.value)).toEqual([
      'claude-fable-5-1[1m]', 'opus[1m]', 'sonnet', 'haiku',
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
    const rows = [...MENU_MODELS];
    orderPrimary(rows);
    expect(rows).toEqual(MENU_MODELS);
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
    expect(dedupeLegacy(MENU_MODELS, LEGACY_MODELS)).toHaveLength(LEGACY_MODELS.length);
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
  const FALLBACK = [...orderPrimary(FALLBACK_PRIMARY), ...dedupeLegacy(FALLBACK_PRIMARY, LEGACY_MODELS)];
  const CLI = [...orderPrimary(MENU_MODELS), ...dedupeLegacy(MENU_MODELS, LEGACY_MODELS)];

  test('shows the model the CLI recommends, by name', () => {
    // With nothing chosen the caller passes the CLI's recommendation as the
    // preference, so the chip names a model instead of reading "Default
    // (recommended)" for whichever one the CLI happens to favour.
    const res = resolveModelSelection(CLI, recommendedModelId(CLI_MODELS), false);
    expect(res.value).toBe('opus[1m]');
    expect(res.persist).toBe(false);
  });

  test('never resolves an unchosen state onto a premium model', () => {
    // Offline there is no recommendation to resolve, and the menu order leads
    // with Fable — which draws on a usage limit of its own. A state nobody
    // chose must not be one of those.
    const cold = resolveModelSelection(FALLBACK, '', false);
    expect(modelTier(cold.value)).toBe('standard');
    expect(cold.persist).toBe(false);
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
  test('no tier offers the CLI default alias', () => {
    // The picker lists models by name; "make this the default for new
    // conversations" covers what the alias row was there for.
    expect(FALLBACK_PRIMARY.find(m => m.value === DEFAULT_ALIAS)).toBeUndefined();
    expect(LEGACY_MODELS.find(m => m.value === DEFAULT_ALIAS)).toBeUndefined();
    expect(dropDefaultAlias(CLI_MODELS).find(m => m.value === DEFAULT_ALIAS)).toBeUndefined();
  });

  test('the offline tier can still name a standard-tier model', () => {
    // What `resolveModelSelection` falls back to when no recommendation exists.
    expect(FALLBACK_PRIMARY.some(m => modelTier(m) === 'standard')).toBe(true);
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

describe('modelFamily / modelTier', () => {
  test('reads the family off the resolved id, not the advertised value', () => {
    // The CLI's `default` row is the extreme case: its value names no family at
    // all, and `recommended` is read off exactly this.
    expect(modelFamily(CLI_MODELS[0])).toBe('opus');
    expect(modelFamily('claude-fable-5-1[1m]')).toBe('fable');
    expect(modelFamily({ value: 'sonnet' })).toBe('sonnet');
    expect(modelFamily('claude-haiku-4-5-20251001')).toBe('haiku');
  });

  test('flags Fable as premium in both tiers, everything else as standard', () => {
    expect(modelTier(CLI_MODELS[2])).toBe('premium');
    expect(modelTier(LEGACY_MODELS.find(m => m.value === 'claude-fable-5'))).toBe('premium');
    expect(modelTier(CLI_MODELS[1])).toBe('standard');
    expect(modelTier(MENU_MODELS[0])).toBe('standard');
    expect(modelTier('haiku')).toBe('standard');
  });

  test('an id it cannot place has no family and is never dressed up as costly', () => {
    expect(modelFamily('gpt-5')).toBe('');
    expect(modelTier('')).toBe('standard');
    expect(modelTier(null)).toBe('standard');
  });
});
