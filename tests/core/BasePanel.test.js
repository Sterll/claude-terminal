const { BasePanel } = require('../../src/renderer/core/BasePanel');
const { ServiceContainer } = require('../../src/renderer/core/ServiceContainer');

describe('BasePanel', () => {
  let el;
  let container;
  let mockApi;

  beforeEach(() => {
    el = document.createElement('div');
    container = new ServiceContainer();
    mockApi = { git: { status: jest.fn() } };
  });

  test('constructor stores api and container from options', () => {
    const panel = new BasePanel(el, { api: mockApi, container });
    expect(panel.api).toBe(mockApi);
    expect(panel.container).toBe(container);
    expect(panel.isActive).toBe(false);
  });

  test('onActivate() sets active and calls render()', () => {
    const panel = new BasePanel(el, { api: mockApi, container });
    panel.render = jest.fn();

    panel.onActivate();
    expect(panel.isActive).toBe(true);
    expect(panel.render).toHaveBeenCalledTimes(1);
  });

  test('onDeactivate() sets inactive', () => {
    const panel = new BasePanel(el, { api: mockApi, container });
    panel.onActivate();
    expect(panel.isActive).toBe(true);

    panel.onDeactivate();
    expect(panel.isActive).toBe(false);
  });

  test('getService() delegates to container.resolve()', () => {
    const svc = { load: jest.fn() };
    container.register('McpService', svc);

    const panel = new BasePanel(el, { api: mockApi, container });
    expect(panel.getService('McpService')).toBe(svc);
  });

  test('getService() throws for unknown service', () => {
    const panel = new BasePanel(el, { api: mockApi, container });
    expect(() => panel.getService('unknown')).toThrow();
  });

  test('inherits BaseComponent lifecycle (on, subscribe, destroy)', () => {
    const panel = new BasePanel(el, { api: mockApi, container });
    const handler = jest.fn();
    const btn = document.createElement('button');
    el.appendChild(btn);

    panel.on(btn, 'click', handler);
    btn.click();
    expect(handler).toHaveBeenCalledTimes(1);

    panel.destroy();
    btn.click();
    expect(handler).toHaveBeenCalledTimes(1); // listener removed
    expect(panel._destroyed).toBe(true);
  });

  test('html() and $() inherited from BaseComponent', () => {
    const panel = new BasePanel(el, { api: mockApi, container });
    panel.html('<div class="content">Test</div>');
    expect(panel.$('.content').textContent).toBe('Test');
  });
});
