// MentionSourceRegistry: the fan-out the command palette runs on.
//
// The palette gained five more sources, several of them IPC-backed. Two
// properties stop that from making it worse than it was: one broken source
// must cost only its own group, and results from a query the user has already
// typed past must never land. Both are tested here rather than in the palette,
// because both belong to the registry.

const registry = require('../../src/renderer/services/MentionSourceRegistry');

/** Minimal conforming source. `getData` may be sync, async, or explode. */
function makeSource(id, getData, extra = {}) {
  return {
    id,
    keyword: `@${id}`,
    prefix: null,
    surfaces: ['palette'],
    scope: 'global',
    label: () => id,
    icon: '<svg></svg>',
    getData,
    render: (item) => ({ label: item.label, sublabel: item.sublabel || '' }),
    onSelect: () => {},
    ...extra,
  };
}

const item = (label, sublabel) => ({ id: label, label, sublabel });
const defer = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(r => setTimeout(r, 0));

afterEach(() => {
  for (const source of registry.getAll()) registry.unregister(source.id);
});

describe('folding', () => {
  test('foldForSearch strips diacritics and case', () => {
    expect(registry.foldForSearch('Télémétrie')).toBe('telemetrie');
    expect(registry.foldForSearch('AÑADIR')).toBe('anadir');
    expect(registry.foldForSearch(null)).toBe('');
  });

  test('foldWithMap keeps every folded char pointing back at its source char', () => {
    const { folded, map } = registry.foldWithMap('Éa');
    expect(folded).toBe('ea');
    expect(map).toEqual([0, 1]);
  });

  test('a combining mark contributes nothing but does not shift the map', () => {
    // "e" + U+0301, i.e. the decomposed spelling of "é".
    const { folded, map } = registry.foldWithMap('ét');
    expect(folded).toBe('et');
    expect(map).toEqual([0, 2]);
  });

  test('substringMatch reports indices into the original string', () => {
    const r = registry.substringMatch('lemet', 'Télémétrie');
    expect(r.match).toBe(true);
    // Indices are positions in "Télémétrie", accents included, so a highlighter
    // wraps the accented characters the user is actually looking at.
    expect('Télémétrie'.slice(r.indices[0], r.indices[r.indices.length - 1] + 1)).toBe('lémét');
  });

  test('substringMatch is a substring match, not a subsequence one', () => {
    expect(registry.substringMatch('tlm', 'Télémétrie').match).toBe(false);
    expect(registry.substringMatch('', 'anything').match).toBe(true);
  });

  test('fuzzyMatch ignores accents too, and still maps back to the original', () => {
    const r = registry.fuzzyMatch('tel', 'Télémétrie');
    expect(r.match).toBe(true);
    expect(r.indices).toEqual([0, 1, 2]);
    expect(registry.fuzzyMatch('zzz', 'Télémétrie').match).toBe(false);
  });
});

describe('runSources — isolation', () => {
  test('a source that throws synchronously degrades to zero results for its group', async () => {
    registry.register(makeSource('ok', () => [item('kept')]));
    registry.register(makeSource('boom', () => { throw new Error('sync blow-up'); }));

    const seen = {};
    const run = registry.runSources('palette', { query: '' }, {
      onSource: (src, items, error) => { seen[src.id] = { items, error }; },
    });
    await run.done;

    expect(seen.boom.items).toEqual([]);
    expect(seen.boom.error).toBeInstanceOf(Error);
    // The healthy source is untouched.
    expect(seen.ok.error).toBeNull();
    expect(seen.ok.items.map(i => i.label)).toEqual(['kept']);
  });

  test('a source whose promise rejects is reported the same way', async () => {
    registry.register(makeSource('ok', () => [item('kept')]));
    registry.register(makeSource('reject', async () => { throw new Error('ipc down'); }));

    const seen = {};
    await registry.runSources('palette', { query: '' }, {
      onSource: (src, items, error) => { seen[src.id] = { items, error }; },
    }).done;

    expect(seen.reject).toEqual({ items: [], error: expect.any(Error) });
    expect(seen.ok.items).toHaveLength(1);
  });

  test('a source that throws inside render loses only its own group', async () => {
    registry.register(makeSource('ok', () => [item('kept')]));
    registry.register(makeSource('badRender', () => [item('x')], {
      render: () => { throw new Error('render blew up'); },
    }));

    const seen = {};
    await registry.runSources('palette', { query: '' }, {
      onSource: (src, items, error) => { seen[src.id] = { items, error }; },
    }).done;

    expect(seen.badRender.items).toEqual([]);
    expect(seen.ok.items).toHaveLength(1);
  });

  test('the whole run resolves even when every source fails', async () => {
    registry.register(makeSource('a', () => { throw new Error('a'); }));
    registry.register(makeSource('b', async () => { throw new Error('b'); }));
    await expect(registry.runSources('palette', {}, {}).done).resolves.toBeUndefined();
  });

  test('a consumer that throws in onSource does not break the other sources', async () => {
    registry.register(makeSource('a', () => [item('a')]));
    registry.register(makeSource('b', () => [item('b')]));

    const seen = [];
    await registry.runSources('palette', {}, {
      onSource: (src) => {
        seen.push(src.id);
        if (src.id === 'a') throw new Error('consumer bug');
      },
    }).done;

    expect(seen.sort()).toEqual(['a', 'b']);
  });

  test('a non-array getData is treated as empty rather than crashing', async () => {
    registry.register(makeSource('weird', () => null));
    const seen = {};
    await registry.runSources('palette', {}, {
      onSource: (src, items, error) => { seen[src.id] = { items, error }; },
    }).done;
    expect(seen.weird).toEqual({ items: [], error: null });
  });
});

describe('runSources — staleness and pacing', () => {
  test('cancelling drops results that arrive afterwards', async () => {
    const gate = defer();
    registry.register(makeSource('slow', () => gate.promise.then(() => [item('late')])));

    const seen = [];
    const run = registry.runSources('palette', { query: 'a' }, {
      onSource: (src, items) => seen.push([src.id, items]),
    });

    run.cancel();
    gate.resolve();
    await run.done;

    expect(seen).toEqual([]);
  });

  test('a stale run cannot repaint over the run that superseded it', async () => {
    const slowGate = defer();
    registry.register(makeSource('src', (ctx) => (
      ctx.query === 'stale' ? slowGate.promise.then(() => [item('stale result')]) : [item('fresh result')]
    )));

    const painted = [];
    const record = (src, items) => painted.push(items.map(i => i.label));

    // First query starts and hangs; the user keeps typing and a second starts.
    const staleRun = registry.runSources('palette', { query: 'stale' }, { onSource: record });
    staleRun.cancel();
    const freshRun = registry.runSources('palette', { query: 'fresh' }, { onSource: record });
    await freshRun.done;

    // Only then does the abandoned query answer.
    slowGate.resolve();
    await staleRun.done;

    expect(painted).toEqual([['fresh result']]);
  });

  test('a slow source does not hold back a fast one', async () => {
    const gate = defer();
    registry.register(makeSource('fast', () => [item('fast')]));
    registry.register(makeSource('slow', () => gate.promise.then(() => [item('slow')])));

    const order = [];
    const run = registry.runSources('palette', {}, { onSource: (src) => order.push(src.id) });

    await flush();
    expect(order).toEqual(['fast']); // delivered without waiting on `slow`

    gate.resolve();
    await run.done;
    expect(order).toEqual(['fast', 'slow']);
  });

  test('filterSource keeps ineligible sources from being queried at all', async () => {
    const queried = [];
    registry.register(makeSource('global', () => { queried.push('global'); return []; }));
    registry.register(makeSource('projectOnly', () => { queried.push('projectOnly'); return []; },
      { scope: 'project' }));

    const run = registry.runSources('palette', {}, {
      filterSource: (s) => s.scope !== 'project',
      onSource: () => {},
    });
    await run.done;

    expect(queried).toEqual(['global']);
    expect(run.sources.map(s => s.id)).toEqual(['global']);
  });

  test('a filterSource that throws excludes the source instead of the run', async () => {
    registry.register(makeSource('a', () => []));
    const run = registry.runSources('palette', {}, {
      filterSource: () => { throw new Error('bad predicate'); },
    });
    await run.done;
    expect(run.sources).toEqual([]);
  });
});

describe('filtering and capping', () => {
  test('the default filter matches label then sublabel, sorted by score', async () => {
    registry.register(makeSource('s', () => [
      item('zzz', 'kanban board'),
      item('kanban'),
      item('nothing to see'),
    ]));
    const results = await registry.query('s', { query: 'kanban' });
    expect(results.map(r => r.label)).toEqual(['kanban', 'zzz']);
  });

  test('a source keeps its own filter — the registry does not second-guess it', async () => {
    // Sessions match on transcript text their label never shows.
    registry.register(makeSource('s', () => [item('untitled session')], {
      filter: (items) => items,
    }));
    const results = await registry.query('s', { query: 'something in the body' });
    expect(results.map(r => r.label)).toEqual(['untitled session']);
  });

  test('results are capped', async () => {
    registry.register(makeSource('s', () => Array.from({ length: 100 }, (_, i) => item(`item ${i}`))));
    const seen = {};
    await registry.runSources('palette', { query: '' }, {
      max: 5,
      onSource: (src, items) => { seen[src.id] = items; },
    }).done;
    expect(seen.s).toHaveLength(5);
  });

  test('query() on a failing source returns nothing rather than rejecting', async () => {
    registry.register(makeSource('boom', () => { throw new Error('nope'); }));
    await expect(registry.query('boom', { query: 'x' })).resolves.toEqual([]);
    await expect(registry.query('does-not-exist', {})).resolves.toEqual([]);
  });
});

describe('registration', () => {
  test('forSurface only returns sources that declared the surface', () => {
    registry.register(makeSource('paletteOnly', () => []));
    registry.register(makeSource('mentionOnly', () => [], { surfaces: ['mention'] }));
    expect(registry.forSurface('palette').map(s => s.id)).toEqual(['paletteOnly']);
    expect(registry.forSurface('mention').map(s => s.id)).toEqual(['mentionOnly']);
  });

  test('a source without surfaces is rejected outright', () => {
    expect(() => registry.register({ id: 'x' })).toThrow(/surfaces/);
    expect(() => registry.register({ surfaces: ['palette'] })).toThrow(/id/);
  });
});
