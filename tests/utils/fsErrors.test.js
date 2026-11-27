/**
 * Reading an fs error's code on the renderer side of the preload bridge,
 * where contextBridge has dropped `err.code` and only the message is left.
 */
const { errorCode, isMissingFile } = require('../../src/renderer/utils/fsErrors');

describe('errorCode', () => {
  test('a code that survived is used as is', () => {
    expect(errorCode(Object.assign(new Error('whatever'), { code: 'EACCES' }))).toBe('EACCES');
  });

  test('a bridged Node fs error is read from the head of its message', () => {
    expect(errorCode(new Error("ENOENT: no such file or directory, open '/x/discovery.json'"))).toBe('ENOENT');
    expect(errorCode(new Error('EACCES: Access denied: path is outside authorized project/app data'))).toBe('EACCES');
  });

  test('a message that does not start with a code has none', () => {
    expect(errorCode(new Error('Access denied'))).toBeUndefined();
    expect(errorCode(new Error('failed: ENOENT somewhere'))).toBeUndefined();
    expect(errorCode(new Error('Error: boom'))).toBeUndefined();
  });

  test('anything that is not an error object has none', () => {
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode(undefined)).toBeUndefined();
    expect(errorCode('ENOENT: text')).toBeUndefined();
  });

  test('isMissingFile', () => {
    expect(isMissingFile(new Error('ENOENT: no such file'))).toBe(true);
    expect(isMissingFile(new Error('EPERM: operation not permitted'))).toBe(false);
  });
});
