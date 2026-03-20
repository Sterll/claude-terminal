const { BaseComponent } = require('../../src/renderer/core/BaseComponent');

describe('BaseComponent', () => {
  let el;

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
  });

  test('constructor stores el and options', () => {
    const opts = { foo: 'bar' };
    const comp = new BaseComponent(el, opts);
    expect(comp.el).toBe(el);
    expect(comp.options).toBe(opts);
    expect(comp._destroyed).toBe(false);
  });

  test('html() sets innerHTML', () => {
    const comp = new BaseComponent(el);
    comp.html('<span class="test">hello</span>');
    expect(el.innerHTML).toBe('<span class="test">hello</span>');
  });

  test('$() scopes querySelector to el', () => {
    const comp = new BaseComponent(el);
    comp.html('<span class="a">1</span><span class="b">2</span>');
    expect(comp.$('.a').textContent).toBe('1');
    expect(comp.$('.b').textContent).toBe('2');
    expect(comp.$('.c')).toBeNull();
  });

  test('$$() scopes querySelectorAll to el', () => {
    const comp = new BaseComponent(el);
    comp.html('<span class="x">1</span><span class="x">2</span><span class="x">3</span>');
    expect(comp.$$('.x').length).toBe(3);
  });

  test('on() tracks event listeners and they fire', () => {
    const comp = new BaseComponent(el);
    const handler = jest.fn();
    const btn = document.createElement('button');
    el.appendChild(btn);

    comp.on(btn, 'click', handler);
    btn.click();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('destroy() removes all tracked event listeners', () => {
    const comp = new BaseComponent(el);
    const handler = jest.fn();
    const btn = document.createElement('button');
    el.appendChild(btn);

    comp.on(btn, 'click', handler);
    btn.click();
    expect(handler).toHaveBeenCalledTimes(1);

    comp.destroy();
    btn.click();
    expect(handler).toHaveBeenCalledTimes(1); // not called again
    expect(comp._destroyed).toBe(true);
  });

  test('subscribe() tracks subscriptions and destroy() unsubscribes', () => {
    const comp = new BaseComponent(el);
    const unsub = jest.fn();
    const mockState = {
      subscribe: jest.fn(() => unsub),
    };
    const handler = jest.fn();

    comp.subscribe(mockState, handler);
    expect(mockState.subscribe).toHaveBeenCalledWith(handler);

    comp.destroy();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  test('addChild() registers child, destroy() destroys children', () => {
    const parent = new BaseComponent(el);
    const childEl = document.createElement('div');
    const child = new BaseComponent(childEl);
    child.destroy = jest.fn();

    parent.addChild(child);
    parent.destroy();

    expect(child.destroy).toHaveBeenCalledTimes(1);
  });

  test('destroy() can be called multiple times safely', () => {
    const comp = new BaseComponent(el);
    const handler = jest.fn();
    const btn = document.createElement('button');
    el.appendChild(btn);
    comp.on(btn, 'click', handler);

    comp.destroy();
    comp.destroy(); // should not throw
    expect(comp._destroyed).toBe(true);
  });

  test('render() is a no-op by default', () => {
    const comp = new BaseComponent(el);
    expect(() => comp.render()).not.toThrow();
  });
});
