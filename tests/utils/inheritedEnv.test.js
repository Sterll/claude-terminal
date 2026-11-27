/**
 * The Agent SDK sets NoDefaultCurrentDirectoryInExePath in this process when it
 * loads; a terminal tab must get the value the app started with instead, or
 * `cmd` stops running a .bat from the current directory (node-gyp's winpty
 * build, `npm run build`).
 */

const KEY = 'NoDefaultCurrentDirectoryInExePath';

function loadWith(startValue) {
  jest.resetModules();
  if (startValue === undefined) delete process.env[KEY];
  else process.env[KEY] = startValue;
  const mod = require('../../src/main/utils/inheritedEnv');
  // What the SDK does once it is imported.
  process.env[KEY] = '1';
  return mod;
}

describe('inheritedEnv.shellEnv', () => {
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  test('drops the variable the SDK set when the app started without it', () => {
    const { shellEnv } = loadWith(undefined);
    expect(shellEnv()).not.toHaveProperty(KEY);
    expect(process.env[KEY]).toBe('1');
  });

  test('keeps a value the user had set themselves', () => {
    const { shellEnv } = loadWith('0');
    expect(shellEnv()[KEY]).toBe('0');
  });

  test('passes the rest of the environment and the extras through', () => {
    const { shellEnv } = loadWith(undefined);
    const env = shellEnv({ CT_EXTRA: 'x' });
    expect(env.CT_EXTRA).toBe('x');
    // A plain copy keeps the real spelling of each name: `Path` on a Windows
    // runner, which process.env.PATH finds and env.PATH does not.
    const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
    expect(pathKey).toBeDefined();
    expect(env[pathKey]).toBe(process.env.PATH);
  });

  test('drops the variable under any spelling of its name', () => {
    const { shellEnv } = loadWith(undefined);
    const original = process.env;
    // process.env on Windows answers to any case; a plain object stands in for
    // a copy that kept another spelling.
    process.env = { ...original, nodefaultcurrentdirectoryinexepath: '1' };
    try {
      const env = shellEnv();
      expect(Object.keys(env).some((name) => name.toLowerCase() === KEY.toLowerCase())).toBe(false);
    } finally {
      process.env = original;
    }
  });

  test('never mutates process.env', () => {
    const { shellEnv } = loadWith(undefined);
    shellEnv({ CT_EXTRA: 'x' });
    expect(process.env.CT_EXTRA).toBeUndefined();
    expect(process.env[KEY]).toBe('1');
  });
});
