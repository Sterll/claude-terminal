function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function makeApi(calls, responses = {}) {
  return new Proxy({}, { get: (_t, ns) => new Proxy({}, {
    get: (_t, method) => (...args) => {
      if (method.startsWith('on')) return () => {};
      calls.push({ ns, method, args });
      return `${ns}.${method}` in responses ? responses[`${ns}.${method}`] : Promise.resolve({ success: true, messages: [] });
    }
  }) });
}
Object.defineProperty(global, 'crypto', { value: { randomUUID: require('node:crypto').randomUUID }, configurable: true });
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
let view;
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  view?.destroy(); view = null;
  jest.clearAllTimers(); jest.useRealTimers();
  jest.dontMock('../../src/renderer/state/settings.state');
});
function setup(settings = {}, responses = {}, options = {}) {
  jest.resetModules();
  jest.doMock('../../src/renderer/state/settings.state', () => ({
    ...jest.requireActual('../../src/renderer/state/settings.state'),
    getSetting: key => ({ autoClaudeMdUpdate: false, ...settings })[key],
  }));
  const calls = [];
  window.electron_api = makeApi(calls, responses);
  const wrapper = document.createElement('div');
  document.body.replaceChildren(wrapper);
  view = require('../../src/renderer/ui/components/ChatView').createChatView(wrapper, { id: 'p', name: 'Fixture', path: '/tmp/fixture' }, options);
  return { calls, wrapper, chatCalls: method => calls.filter(c => c.ns === 'chat' && c.method === method) };
}
it('cancels the initial prompt when the tab closes before its timer fires', async () => {
  const { chatCalls } = setup({}, {}, { initialPrompt: 'fixture' });
  view.destroy();
  await jest.advanceTimersByTimeAsync(150);
  expect(chatCalls('start')).toHaveLength(0);
});
it('still submits an initial prompt and closes an active tab exactly once', async () => {
  const { chatCalls } = setup({}, {}, { initialPrompt: 'fixture' });
  await jest.advanceTimersByTimeAsync(150);
  expect(chatCalls('start')).toHaveLength(1);
  view.destroy(); view.destroy();
  expect(chatCalls('close')).toHaveLength(1);
});
it.each([true, false])('does not start after pending enhancement settles (success=%s)', async success => {
  const enhancement = deferred();
  const { chatCalls } = setup({ enhancePrompts: true }, { 'chat.enhancePrompt': enhancement.promise });
  view.sendMessage('fixture');
  await jest.advanceTimersByTimeAsync(0);
  expect(chatCalls('enhancePrompt')).toHaveLength(1);
  view.destroy();
  enhancement.resolve({ success, enhanced: 'enhanced fixture' });
  await jest.advanceTimersByTimeAsync(0);
  expect(chatCalls('start')).toHaveLength(0);
});
it('closes a successful start response that arrives after the view was destroyed', async () => {
  const start = deferred();
  const { chatCalls, wrapper } = setup({}, { 'chat.start': start.promise });
  view.sendMessage('fixture');
  await jest.advanceTimersByTimeAsync(0);
  const sessionId = chatCalls('start')[0].args[0].sessionId;
  view.destroy();
  start.resolve({ success: true, sessionId });
  await jest.advanceTimersByTimeAsync(0);
  expect(chatCalls('close').map(c => c.args[0])).toEqual([{ sessionId }, { sessionId }]);
  expect(wrapper.innerHTML).toBe('');
});
it('does not restart when account-switch preparation finishes after close', async () => {
  const preparation = deferred();
  const { chatCalls } = setup({}, { 'chat.prepareSwitchAccount': preparation.promise });
  view.sendMessage('fixture');
  await jest.advanceTimersByTimeAsync(0);
  const switching = view.switchAccount('another-account');
  view.destroy();
  preparation.resolve({ success: true });
  await expect(switching).resolves.toBe(false);
  expect(chatCalls('start')).toHaveLength(1);
});
it('drops a history response after the view has been destroyed', async () => {
  const history = deferred();
  const { wrapper } = setup({}, { 'chat.loadHistory': history.promise }, { resumeSessionId: 'old-session' });
  view.destroy();
  history.resolve({ success: true, messages: [{ type: 'user', content: 'old prompt' }] });
  await jest.advanceTimersByTimeAsync(150);
  expect(wrapper.innerHTML).toBe('');
});
