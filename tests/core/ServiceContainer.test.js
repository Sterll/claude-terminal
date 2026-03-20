const { ServiceContainer } = require('../../src/renderer/core/ServiceContainer');

describe('ServiceContainer', () => {
  let container;

  beforeEach(() => {
    container = new ServiceContainer();
  });

  test('register() and resolve() return the same instance', () => {
    const svc = { doSomething: jest.fn() };
    container.register('myService', svc);
    expect(container.resolve('myService')).toBe(svc);
  });

  test('resolve() throws for unknown service', () => {
    expect(() => container.resolve('unknown')).toThrow('[ServiceContainer] Service not found: unknown');
  });

  test('has() returns true for registered services', () => {
    container.register('svc', {});
    expect(container.has('svc')).toBe(true);
    expect(container.has('other')).toBe(false);
  });

  test('registerFactory() creates instance lazily on first resolve()', () => {
    const factory = jest.fn((c) => ({ name: 'lazy' }));
    container.registerFactory('lazy', factory);

    expect(factory).not.toHaveBeenCalled();
    expect(container.has('lazy')).toBe(true);

    const instance = container.resolve('lazy');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(container);
    expect(instance).toEqual({ name: 'lazy' });
  });

  test('factory result is cached — second resolve() returns same instance', () => {
    container.registerFactory('cached', () => ({ id: Math.random() }));
    const first = container.resolve('cached');
    const second = container.resolve('cached');
    expect(first).toBe(second);
  });

  test('register() overwrites existing service', () => {
    container.register('svc', { v: 1 });
    container.register('svc', { v: 2 });
    expect(container.resolve('svc')).toEqual({ v: 2 });
  });

  test('keys() lists all registered names', () => {
    container.register('a', {});
    container.registerFactory('b', () => ({}));
    expect(container.keys().sort()).toEqual(['a', 'b']);
  });

  test('keys() deduplicates after factory resolution', () => {
    container.registerFactory('svc', () => ({}));
    container.resolve('svc'); // moves from factories to services
    expect(container.keys()).toEqual(['svc']);
  });
});
