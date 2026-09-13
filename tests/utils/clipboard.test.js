/**
 * The clipboard helper.
 *
 * The bug it exists for: main.js gates permissions with an allowlist, and while
 * 'clipboard-sanitized-write' was missing from it, Chromium rejected every
 * navigator.clipboard.writeText() promise. Nothing threw and nothing logged —
 * every copy button in the app just stopped working. So the assertion that
 * matters here is the order: the Electron bridge first, the web API only as a
 * fallback, since the bridge answers to no permission and no focus rule.
 */

const { copyText, readText } = require('../../src/renderer/utils/clipboard');

describe('clipboard helper', () => {
  let bridgeWrite, bridgeRead, navWrite, navRead;

  beforeEach(() => {
    bridgeWrite = jest.fn().mockResolvedValue(undefined);
    bridgeRead = jest.fn().mockResolvedValue('from bridge');
    navWrite = jest.fn().mockResolvedValue(undefined);
    navRead = jest.fn().mockResolvedValue('from navigator');

    window.electron_api = { app: { clipboardWrite: bridgeWrite, clipboardRead: bridgeRead } };
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: navWrite, readText: navRead },
      configurable: true,
    });
  });

  describe('copyText', () => {
    it('writes through the Electron bridge, not the web API', async () => {
      await expect(copyText('hello')).resolves.toBe(true);

      expect(bridgeWrite).toHaveBeenCalledWith('hello');
      expect(navWrite).not.toHaveBeenCalled();
    });

    it('falls back to the web API when the bridge rejects', async () => {
      bridgeWrite.mockRejectedValue(new Error('no ipc'));

      await expect(copyText('hello')).resolves.toBe(true);
      expect(navWrite).toHaveBeenCalledWith('hello');
    });

    it('falls back to the web API when there is no bridge at all', async () => {
      window.electron_api = {};

      await expect(copyText('hello')).resolves.toBe(true);
      expect(navWrite).toHaveBeenCalledWith('hello');
    });

    it('reports failure instead of throwing when both paths fail', async () => {
      bridgeWrite.mockRejectedValue(new Error('no ipc'));
      navWrite.mockRejectedValue(new Error('denied'));

      await expect(copyText('hello')).resolves.toBe(false);
    });

    it('does nothing for an empty string', async () => {
      await expect(copyText('')).resolves.toBe(false);
      expect(bridgeWrite).not.toHaveBeenCalled();
    });
  });

  describe('readText', () => {
    it('reads through the bridge', async () => {
      await expect(readText()).resolves.toBe('from bridge');
      expect(navRead).not.toHaveBeenCalled();
    });

    it('falls back to the web API when the bridge rejects', async () => {
      bridgeRead.mockRejectedValue(new Error('no ipc'));

      await expect(readText()).resolves.toBe('from navigator');
    });

    it('returns an empty string rather than throwing when both fail', async () => {
      bridgeRead.mockRejectedValue(new Error('no ipc'));
      navRead.mockRejectedValue(new Error('denied'));

      await expect(readText()).resolves.toBe('');
    });
  });
});
