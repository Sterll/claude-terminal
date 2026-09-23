// ModelCatalogClient — the renderer's one copy of the model catalog, and how it
// stays current after the first load.
//
// The window loads the catalog once and shares that answer for the rest of its
// life. That is right for the round trip and wrong for the content: after a CLI
// upgrade the first session start corrects the catalog in main, and nothing
// carried the correction here, so the chip kept naming the previous model.
// Main now pushes it; these tests pin down how the push is taken.

const ModelCatalog = require('../../src/renderer/services/ModelCatalogClient');

const row = (value, displayName) => ({ value, displayName });
const OPUS_5 = { success: true, primary: [row('opus[1m]', 'Opus 5')], legacy: [], recommended: 'claude-opus-5[1m]', source: 'cache' };
const OPUS_5_5 = { success: true, primary: [row('opus[1m]', 'Opus 5.5')], legacy: [row('claude-opus-5', 'Opus 5')], recommended: 'claude-opus-5-5[1m]', source: 'cli' };

/** A bridge whose push channel the test can fire by hand. */
function makeApi(answer = OPUS_5) {
  let push = null;
  return {
    chat: {
      modelCatalog: jest.fn(async () => answer),
      onModelCatalogChanged: jest.fn((cb) => { push = cb; return () => { push = null; }; }),
    },
    push: (payload) => push(payload),
  };
}

beforeEach(() => {
  ModelCatalog._reset();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  console.warn.mockRestore();
});

describe('pushed catalogs', () => {
  test('adopts a catalog main pushes after the first load', async () => {
    const api = makeApi();
    await ModelCatalog.load(api);
    expect(ModelCatalog.allModels()[0].displayName).toBe('Opus 5');

    api.push(OPUS_5_5);

    expect(ModelCatalog.allModels().map(m => m.displayName)).toEqual(['Opus 5.5', 'Opus 5']);
    expect(ModelCatalog.getCatalog().recommended).toBe('claude-opus-5-5[1m]');
  });

  test('tells subscribers, so a picker can repaint', async () => {
    const api = makeApi();
    await ModelCatalog.load(api);
    const listener = jest.fn();
    ModelCatalog.subscribe(listener);

    api.push(OPUS_5_5);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].primary[0].displayName).toBe('Opus 5.5');
  });

  test('a later load answers with the pushed catalog, without another round trip', async () => {
    const api = makeApi();
    await ModelCatalog.load(api);
    api.push(OPUS_5_5);

    const catalog = await ModelCatalog.load(api);

    expect(catalog.primary[0].displayName).toBe('Opus 5.5');
    expect(api.chat.modelCatalog).toHaveBeenCalledTimes(1);
  });

  test('a load still in flight when a push lands does not overwrite it', async () => {
    // Main pushes what the running CLI just said. A load answered from the old
    // cache (its refetch failed) must not put the previous model back.
    let answer;
    const api = makeApi();
    api.chat.modelCatalog = jest.fn(() => new Promise((resolve) => { answer = resolve; }));
    const pending = ModelCatalog.load(api);

    api.push(OPUS_5_5);
    answer(OPUS_5);
    await pending;

    expect(ModelCatalog.allModels()[0].displayName).toBe('Opus 5.5');
  });

  test('ignores an empty or failed push', async () => {
    const api = makeApi();
    await ModelCatalog.load(api);
    const listener = jest.fn();
    ModelCatalog.subscribe(listener);

    api.push({ success: false, error: 'boom' });
    api.push({ success: true, primary: [] });

    expect(listener).not.toHaveBeenCalled();
    expect(ModelCatalog.allModels()[0].displayName).toBe('Opus 5');
  });

  test('subscribes to the bridge once, however many pickers load', async () => {
    const api = makeApi();
    await Promise.all([ModelCatalog.load(api), ModelCatalog.load(api), ModelCatalog.load(api)]);

    expect(api.chat.onModelCatalogChanged).toHaveBeenCalledTimes(1);
  });

  test('a throwing subscriber does not stop the others', async () => {
    const api = makeApi();
    await ModelCatalog.load(api);
    const healthy = jest.fn();
    ModelCatalog.subscribe(() => { throw new Error('boom'); });
    ModelCatalog.subscribe(healthy);

    expect(() => api.push(OPUS_5_5)).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  test('unsubscribing stops the calls', async () => {
    const api = makeApi();
    await ModelCatalog.load(api);
    const listener = jest.fn();
    const off = ModelCatalog.subscribe(listener);
    off();

    api.push(OPUS_5_5);

    expect(listener).not.toHaveBeenCalled();
  });

  test('still loads over a bridge that has no push channel', async () => {
    const api = { chat: { modelCatalog: jest.fn(async () => OPUS_5_5) } };

    const catalog = await ModelCatalog.load(api);

    expect(catalog.primary[0].displayName).toBe('Opus 5.5');
  });
});
