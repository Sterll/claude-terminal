/**
 * The suggestion engine's guarantees, each one a promise made to the user:
 * one suggestion a day at most, never in the middle of something, never again
 * once dismissed, never for a feature already in use, nothing at all when
 * switched off or when the store could not be read.
 */

const {
  createDiscoveryEngine,
  validateRule,
  DAY_MS,
  PENDING_TTL_MS,
} = require('../../src/renderer/services/discovery/engine');
const RULES = require('../../src/renderer/services/discovery/rules');

function memoryStore(initial) {
  let state = initial || { lastShownAt: 0, rules: {}, used: {} };
  let usable = true;
  return {
    isUsable: () => usable,
    get: () => state,
    update: (fn) => { if (usable) fn(state); },
    setUsable: (v) => { usable = v; },
    replace: (s) => { state = s; },
  };
}

function rule(id, overrides = {}) {
  return {
    id,
    triggers: ['ping'],
    titleKey: `t.${id}`,
    bodyKey: `b.${id}`,
    action: { type: 'tab', tab: id },
    condition: () => true,
    ...overrides,
  };
}

function setup({ rules = [rule('a')], busy = null, enabled = true, store = memoryStore(), grace = 0 } = {}) {
  let clock = 1_000_000;
  const presented = [];
  let busyNow = busy;
  let enabledNow = enabled;
  const engine = createDiscoveryEngine({
    rules,
    store,
    isEnabled: () => enabledNow,
    busyReason: () => busyNow,
    present: (suggestion, handlers) => presented.push({ suggestion, handlers }),
    now: () => clock,
    startupGraceMs: grace,
    log: { warn: () => {} },
  });
  return {
    engine,
    store,
    presented,
    advance: (ms) => { clock += ms; },
    setBusy: (v) => { busyNow = v; },
    setEnabled: (v) => { enabledNow = v; },
    /** Close whatever is on screen the way a timeout would. */
    hideCurrent: () => presented[presented.length - 1]?.handlers.onHide(),
  };
}

describe('discovery engine: showing', () => {
  test('a matching rule is presented with its keys, params and action', async () => {
    const { engine, presented } = setup({
      rules: [rule('a', { condition: () => ({ params: { n: 3 }, bodyKey: 'b.other' }) })],
    });
    expect(await engine.signal('ping', {})).toBe(true);
    expect(presented).toHaveLength(1);
    expect(presented[0].suggestion).toMatchObject({
      id: 'a', titleKey: 't.a', bodyKey: 'b.other', params: { n: 3 },
      actionLabelKey: 'discovery.showMe', action: { type: 'tab', tab: 'a' },
    });
  });

  test('a signal nobody listens to does nothing', async () => {
    const { engine, presented } = setup();
    expect(await engine.signal('other', {})).toBe(false);
    expect(presented).toHaveLength(0);
  });

  test('a false condition stays quiet', async () => {
    const { engine, presented } = setup({ rules: [rule('a', { condition: () => false })] });
    await engine.signal('ping');
    expect(presented).toHaveLength(0);
  });

  test('a condition that throws is contained', async () => {
    const { engine, presented } = setup({ rules: [rule('a', { condition: () => { throw new Error('boom'); } }), rule('b')] });
    await engine.signal('ping');
    expect(presented.map(p => p.suggestion.id)).toEqual(['b']);
  });

  test('the first rule in priority order wins a shared signal', async () => {
    const { engine, presented } = setup({ rules: [rule('first'), rule('second')] });
    await engine.signal('ping');
    expect(presented.map(p => p.suggestion.id)).toEqual(['first']);
  });

  test('the startup grace holds a match, then lets it through', async () => {
    const { engine, presented, advance } = setup({ grace: 60_000 });
    await engine.signal('ping');
    expect(presented).toHaveLength(0);
    expect(engine.hasPending()).toBe(true);
    advance(61_000);
    expect(engine.flush()).toBe(true);
    expect(presented).toHaveLength(1);
  });
});

describe('discovery engine: one a day', () => {
  test('a second rule is refused within 24 hours, whichever rule it is', async () => {
    const { engine, presented, advance, hideCurrent } = setup({
      rules: [rule('a'), rule('b', { triggers: ['pong'] })],
    });
    await engine.signal('ping');
    hideCurrent();
    advance(DAY_MS - 1000);
    await engine.signal('pong');
    expect(presented.map(p => p.suggestion.id)).toEqual(['a']);
    expect(engine.explain('b')).toBe('daily-cap');

    advance(2000);
    await engine.signal('pong');
    expect(presented.map(p => p.suggestion.id)).toEqual(['a', 'b']);
  });

  test('the cap survives a restart, since it lives in the store', async () => {
    const store = memoryStore();
    const first = setup({ store });
    await first.engine.signal('ping');
    const second = setup({ store, rules: [rule('b')] });
    await second.engine.signal('ping');
    expect(second.presented).toHaveLength(0);
  });

  test('nothing new is evaluated while a suggestion is on screen', async () => {
    const calls = [];
    const { engine } = setup({ rules: [rule('a'), rule('b', { triggers: ['pong'], condition: () => { calls.push(1); return true; } })] });
    await engine.signal('ping');
    expect(engine.showingId()).toBe('a');
    await engine.signal('pong');
    expect(calls).toHaveLength(0);
  });
});

describe('discovery engine: per-rule memory', () => {
  test('a rule waits out its own cooldown after being shown', async () => {
    const { engine, presented, advance, hideCurrent } = setup({ rules: [rule('a', { cooldownDays: 10 })] });
    await engine.signal('ping');
    hideCurrent();
    advance(5 * DAY_MS);
    await engine.signal('ping');
    expect(presented).toHaveLength(1);
    expect(engine.explain('a')).toBe('cooldown');
    advance(6 * DAY_MS);
    await engine.signal('ping');
    expect(presented).toHaveLength(2);
  });

  test('"Don\'t show again" is for good', async () => {
    const { engine, presented, advance } = setup({ rules: [rule('a', { cooldownDays: 1 })] });
    await engine.signal('ping');
    presented[0].handlers.onDismiss();
    advance(400 * DAY_MS);
    await engine.signal('ping');
    expect(presented).toHaveLength(1);
    expect(engine.explain('a')).toBe('dismissed');
  });

  test('"Show me" retires the rule too: the feature is known now', async () => {
    const { engine, presented, advance } = setup({ rules: [rule('a', { cooldownDays: 1 })] });
    await engine.signal('ping');
    presented[0].handlers.onAction();
    advance(400 * DAY_MS);
    await engine.signal('ping');
    expect(presented).toHaveLength(1);
    expect(engine.explain('a')).toBe('acted');
  });

  test('a rule ignored maxShows times retires itself', async () => {
    const { engine, presented, advance, hideCurrent } = setup({ rules: [rule('a', { cooldownDays: 1, maxShows: 2 })] });
    for (let i = 0; i < 4; i++) {
      await engine.signal('ping');
      hideCurrent();
      advance(2 * DAY_MS);
    }
    expect(presented).toHaveLength(2);
    expect(engine.explain('a')).toBe('retired');
  });

  test('ctx.memory persists a rule\'s own scratch data', async () => {
    const store = memoryStore();
    const counting = rule('a', {
      condition: (_p, ctx) => {
        const m = ctx.memory.get();
        ctx.memory.set({ n: (m.n || 0) + 1 });
        return m.n + 1 >= 3;
      },
    });
    const { engine, presented } = setup({ rules: [counting], store });
    await engine.signal('ping');
    await engine.signal('ping');
    expect(presented).toHaveLength(0);
    await engine.signal('ping');
    expect(presented).toHaveLength(1);
    expect(store.get().rules.a.data).toEqual({ n: 3 });
  });

  test('a counting rule keeps counting while another suggestion holds the day', async () => {
    const counting = rule('count', {
      triggers: ['pong'],
      countsWhileQuiet: true,
      condition: (_p, ctx) => {
        const n = (ctx.memory.get().n || 0) + 1;
        ctx.memory.set({ n });
        return n >= 2;
      },
    });
    const { engine, presented, advance, hideCurrent, store } = setup({ rules: [rule('a'), counting] });
    await engine.signal('ping');
    hideCurrent();
    await engine.signal('pong');
    await engine.signal('pong');
    expect(store.get().rules.count.data.n).toBe(2);
    expect(presented).toHaveLength(1);
    advance(DAY_MS + 1);
    await engine.signal('pong');
    expect(presented.map(p => p.suggestion.id)).toEqual(['a', 'count']);
  });
});

describe('discovery engine: not for a feature already in use', () => {
  test('a recorded usage key keeps the rule quiet', async () => {
    const { engine, presented } = setup({ rules: [rule('a', { usedWhen: ['tab:x'] })] });
    engine.markUsed('tab:x');
    await engine.signal('ping');
    expect(presented).toHaveLength(0);
    expect(engine.explain('a')).toBe('used');
  });

  test('markUsed drops a pending suggestion for that feature', async () => {
    const { engine, presented, setBusy } = setup({ rules: [rule('a', { usedWhen: ['tab:x'] })], busy: 'turn' });
    await engine.signal('ping');
    expect(engine.hasPending()).toBe(true);
    engine.markUsed('tab:x');
    setBusy(null);
    engine.flush();
    expect(presented).toHaveLength(0);
  });

  test('a live isUsed probe is asked once the condition holds, and remembered', async () => {
    const isUsed = jest.fn(async () => true);
    const condition = jest.fn(() => true);
    const { engine, presented, store } = setup({ rules: [rule('a', { isUsed, condition })] });
    await engine.signal('ping');
    expect(presented).toHaveLength(0);
    expect(store.get().rules.a.alreadyUses).toBe(true);
    await engine.signal('ping');
    expect(isUsed).toHaveBeenCalledTimes(1);
  });

  test('the probe is not asked when the condition is false', async () => {
    const isUsed = jest.fn(() => false);
    const { engine } = setup({ rules: [rule('a', { isUsed, condition: () => false })] });
    await engine.signal('ping');
    expect(isUsed).not.toHaveBeenCalled();
  });
});

describe('discovery engine: never at a bad moment', () => {
  test.each(['turn', 'waiting', 'modal', 'unfocused'])('held while %s, shown once free', async (reason) => {
    const { engine, presented, setBusy } = setup({ busy: reason });
    await engine.signal('ping');
    expect(presented).toHaveLength(0);
    expect(engine.flush()).toBe(false);
    setBusy(null);
    expect(engine.flush()).toBe(true);
    expect(presented).toHaveLength(1);
  });

  test('a held suggestion expires', async () => {
    const { engine, presented, setBusy, advance } = setup({ busy: 'turn' });
    await engine.signal('ping');
    advance(PENDING_TTL_MS + 1);
    setBusy(null);
    expect(engine.flush()).toBe(false);
    expect(engine.hasPending()).toBe(false);
    expect(presented).toHaveLength(0);
  });

  test('a busy check that throws counts as busy', async () => {
    const engine = createDiscoveryEngine({
      rules: [rule('a')],
      store: memoryStore(),
      isEnabled: () => true,
      busyReason: () => { throw new Error('no DOM'); },
      present: jest.fn(),
      startupGraceMs: 0,
    });
    await engine.signal('ping');
    expect(engine.flush()).toBe(false);
  });

  test('a presenter that throws frees the slot', async () => {
    const engine = createDiscoveryEngine({
      rules: [rule('a')],
      store: memoryStore(),
      isEnabled: () => true,
      busyReason: () => null,
      present: () => { throw new Error('no toast'); },
      startupGraceMs: 0,
      log: { warn: () => {} },
    });
    await engine.signal('ping');
    expect(engine.showingId()).toBe(null);
  });
});

describe('discovery engine: switched off', () => {
  test('the global setting silences every rule, without evaluating any', async () => {
    const condition = jest.fn(() => true);
    const { engine, presented } = setup({ enabled: false, rules: [rule('a', { condition })] });
    await engine.signal('ping');
    expect(condition).not.toHaveBeenCalled();
    expect(presented).toHaveLength(0);
  });

  test('turning it off drops what was pending', async () => {
    const { engine, presented, setBusy, setEnabled } = setup({ busy: 'turn' });
    await engine.signal('ping');
    setEnabled(false);
    setBusy(null);
    engine.flush();
    expect(presented).toHaveLength(0);
  });

  test('an unreadable store means nothing is shown and nothing recorded', async () => {
    const store = memoryStore();
    store.setUsable(false);
    const { engine, presented } = setup({ store });
    await engine.signal('ping');
    engine.markUsed('tab:x');
    expect(presented).toHaveLength(0);
    expect(store.get().used).toEqual({});
  });
});

describe('discovery rules: shape', () => {
  test('a malformed rule is refused at construction', () => {
    expect(() => validateRule({ id: 'x' })).toThrow(/triggers/);
    expect(() => validateRule(rule('x', { action: null }))).toThrow(/action/);
    expect(() => validateRule(rule('x', { usedWhen: 'tab:x' }))).toThrow(/usedWhen/);
    expect(() => createDiscoveryEngine({
      rules: [rule('x'), rule('x')], store: memoryStore(), isEnabled: () => true, busyReason: () => null, present: () => {},
    })).toThrow(/duplicate/);
  });

  test('every shipped rule is well formed and has a unique id', () => {
    for (const r of RULES) expect(() => validateRule(r)).not.toThrow();
    expect(new Set(RULES.map(r => r.id)).size).toBe(RULES.length);
  });

  test('every shipped rule\'s keys exist in all six locales', () => {
    const locales = ['en', 'fr', 'es', 'id', 'zh-CN', 'pt-BR'].map(l => require(`../../src/renderer/i18n/locales/${l}.json`));
    const resolve = (obj, key) => key.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
    const keys = ['discovery.showMe', 'discovery.dontShowAgain', 'discovery.settingLabel', 'discovery.settingDesc'];
    for (const r of RULES) {
      keys.push(r.titleKey, r.bodyKey);
      for (const k of Object.keys(resolve(locales[0], r.bodyKey.split('.').slice(0, -1).join('.')))) {
        keys.push(`${r.bodyKey.split('.').slice(0, -1).join('.')}.${k}`);
      }
    }
    for (const locale of locales) {
      for (const key of keys) {
        const value = resolve(locale, key);
        expect(typeof value).toBe('string');
        expect(value).not.toMatch(/[–—]/);
      }
    }
  });
});
