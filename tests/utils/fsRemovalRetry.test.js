const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  REMOVAL_RETRY,
  withRemovalRetry,
  installFsRemovalRetry,
} = require('../helpers/fsRemovalRetry');

describe('withRemovalRetry', () => {
  it('gives a recursive removal a retry policy', () => {
    expect(withRemovalRetry({ recursive: true, force: true })).toEqual({
      recursive: true,
      force: true,
      ...REMOVAL_RETRY,
    });
  });

  it('leaves a caller that chose its own retry alone', () => {
    const options = { recursive: true, force: true, maxRetries: 2, retryDelay: 10 };
    expect(withRemovalRetry(options)).toEqual(options);
  });

  it('leaves a single-file removal alone', () => {
    expect(withRemovalRetry({ force: true })).toEqual({ force: true });
    expect(withRemovalRetry(undefined)).toBeUndefined();
  });
});

describe('installFsRemovalRetry', () => {
  const fakeFs = () => ({
    rmSync: jest.fn(),
    rm: jest.fn(),
    promises: { rm: jest.fn() },
  });

  it('injects the retry into rmSync, rm and promises.rm', () => {
    const target = fakeFs();
    const { rmSync, rm, promises } = { ...target, promises: { ...target.promises } };
    installFsRemovalRetry(target);

    const callback = () => {};
    target.rmSync('/tmp/tree', { recursive: true, force: true });
    target.rm('/tmp/tree', { recursive: true }, callback);
    target.promises.rm('/tmp/tree', { recursive: true });

    expect(rmSync).toHaveBeenCalledWith('/tmp/tree', {
      recursive: true,
      force: true,
      ...REMOVAL_RETRY,
    });
    expect(rm).toHaveBeenCalledWith('/tmp/tree', { recursive: true, ...REMOVAL_RETRY }, callback);
    expect(promises.rm).toHaveBeenCalledWith('/tmp/tree', { recursive: true, ...REMOVAL_RETRY });
  });

  it('passes a callback-only rm through untouched', () => {
    const target = fakeFs();
    const { rm } = target;
    installFsRemovalRetry(target);

    const callback = () => {};
    target.rm('/tmp/tree', callback);

    expect(rm).toHaveBeenCalledWith('/tmp/tree', callback, undefined);
  });

  it('does not wrap twice', () => {
    const target = fakeFs();
    installFsRemovalRetry(target);
    const wrapped = target.rmSync;
    installFsRemovalRetry(target);

    expect(target.rmSync).toBe(wrapped);
  });
});

describe('the installed default', () => {
  it('is already in place for every suite, via tests/setup.js', () => {
    expect(fs[Symbol.for('claude-terminal.tests.fsRemovalRetry')]).toBe(true);
  });

  it('still removes the tree it is given', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-removal-retry-'));
    fs.mkdirSync(path.join(root, 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(root, 'nested', 'deeper', 'file.txt'), 'x');

    fs.rmSync(root, { recursive: true, force: true });

    expect(fs.existsSync(root)).toBe(false);
  });
});
