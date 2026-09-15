// Exercise the shipped ChatView, including hidden restores and delayed layout.
describe('restored conversation scrolling', () => {
  let view, wrapper, messages, observers, calls, height, contentHeight, top, frames, nextFrame;
  const runFrame = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
  const flush = async (paint = true) => { for (let i = 0; i < 8; i++) { await new Promise(resolve => setTimeout(resolve, 0)); if (paint) runFrame(); } };
  const resize = () => observers.forEach(observer => observer.callback([]));
  beforeEach(async () => {
    jest.resetModules();
    observers = []; calls = []; height = 0; contentHeight = 0; top = 0;
    frames = new Map(); nextFrame = 0;
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame; });
    jest.spyOn(global, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id));
    global.ResizeObserver = class {
      constructor(callback) { this.callback = callback; this.observe = jest.fn(); this.unobserve = jest.fn(); this.disconnect = jest.fn(); observers.push(this); }
    };
    const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', type: 'text', uuid: 'message-' + i, text: 'A previous message ' + i }));
    const namespace = name => new Proxy({}, { get: (_target, method) => (...args) => {
      if (String(method).startsWith('on')) return () => {};
      calls.push({ name, method, args });
      return Promise.resolve(name === 'chat' && method === 'loadHistory'
        ? { success: true, messages: history, truncated: true, total: 200 }
        : { success: true, messages: [] });
    } });
    window.electron_api = new Proxy({}, { get: (_target, name) => namespace(name) });
    document.body.innerHTML = '<div id="restore"></div>';
    wrapper = document.getElementById('restore');
    view = require('../../src/renderer/ui/components/ChatView').createChatView(wrapper, { id: 'p1', name: 'Fixture', path: '/tmp/fixture' }, { resumeSessionId: 'old-session' });
    messages = wrapper.querySelector('.chat-messages');
    Object.defineProperties(messages, {
      clientHeight: { get: () => height },
      scrollHeight: { get: () => height ? contentHeight : 0 },
      scrollTop: { get: () => top, set: value => { top = height ? Math.min(Math.max(value, 0), Math.max(contentHeight - height, 0)) : 0; } }
    });
    await flush(false);
  });
  afterEach(() => { view?.destroy(); jest.restoreAllMocks(); delete global.ResizeObserver; });

  test('a reveal between the initial scroll frame and history prefetch does not load another page', async () => {
    runFrame(); // Hidden tail scroll is skipped; the second prefetch frame is queued.
    height = 400; contentHeight = 2200;
    view.focus(); // Its tail scroll is queued behind the older prefetch callback.
    await flush();
    expect(top).toBe(1800);
    expect(calls.filter(call => call.method === 'loadHistory')).toHaveLength(1);
  });

  test('revealing a history loaded while hidden lands at the end without fetching older pages', async () => {
    expect(calls.filter(call => call.method === 'loadHistory')).toHaveLength(1);
    height = 400; contentHeight = 2200;
    resize(); view.focus(); await flush();
    expect(top).toBe(1800);
    expect(calls.filter(call => call.method === 'loadHistory')).toHaveLength(1);
  });

  test('a short visible tail still prefetches earlier history', async () => {
    height = 400; contentHeight = 600;
    resize(); await flush();
    expect(calls.filter(call => call.method === 'loadHistory')).toHaveLength(2);
  });

  test('scrolling upward near the top still fetches earlier history', async () => {
    height = 400; contentHeight = 2200;
    resize(); await flush();
    messages.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -100 }));
    messages.scrollTop = 500; messages.dispatchEvent(new Event('scroll'));
    await flush();
    expect(calls.filter(call => call.method === 'loadHistory')).toHaveLength(2);
  });

  test('late layout follows the tail, while reading upward survives resize and tab focus', async () => {
    height = 400; contentHeight = 2200;
    resize(); await flush();
    contentHeight = 3000;
    messages.dispatchEvent(new Event('scroll')); // Browser layout adjustment.
    resize(); await flush();
    expect(top).toBe(2600);

    // An upward gesture cancels a bottom-scroll frame already queued.
    resize();
    messages.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -100 }));
    messages.scrollTop = 1500; messages.dispatchEvent(new Event('scroll'));
    contentHeight = 3300; resize(); view.focus(); await flush();
    expect(top).toBe(1500);
    wrapper.querySelector('.chat-scroll-to-bottom').click();
    expect(top).toBe(2900);
  });
});
