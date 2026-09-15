/** @jest-environment node */
const { net } = require('electron');
jest.mock('electron', () => ({ net: { fetch: jest.fn() } }));
const { httpsGet } = require('../../src/main/utils/httpCache');
afterEach(() => { jest.useRealTimers(); jest.resetAllMocks(); });

test('catalog requests use the native network stack and preserve JSON, status and URL', async () => {
  net.fetch.mockResolvedValue({ status: 200, text: async () => '{"servers":[]}' });
  await expect(httpsGet('https://registry.example:8443/servers?q=hello%20world')).resolves.toEqual({ status: 200, data: { servers: [] } });
  expect(net.fetch).toHaveBeenCalledWith('https://registry.example:8443/servers?q=hello%20world', expect.objectContaining({
    credentials: 'omit', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'ClaudeTerminal' }
  }));
  net.fetch.mockResolvedValue({ status: 503, text: async () => 'temporarily unavailable' });
  await expect(httpsGet('https://registry.example/')).resolves.toEqual({ status: 503, data: 'temporarily unavailable' });
});

test('certificate failures propagate without a retry or relaxed validation', async () => {
  net.fetch.mockRejectedValue(new Error('net::ERR_CERT_AUTHORITY_INVALID'));
  await expect(httpsGet('https://registry.example/')).rejects.toThrow('ERR_CERT_AUTHORITY_INVALID');
  expect(net.fetch).toHaveBeenCalledTimes(1);
  await expect(httpsGet('file:///etc/passwd')).rejects.toThrow('HTTPS URL required');
  await expect(httpsGet('http://registry.example/')).rejects.toThrow('HTTPS URL required');
  expect(net.fetch).toHaveBeenCalledTimes(1);
});

test('the deadline cancels a stalled response body as well as connection setup', async () => {
  jest.useFakeTimers();
  net.fetch.mockImplementation(async (_url, { signal }) => ({ status: 200, text: () => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) }));
  const request = expect(httpsGet('https://registry.example/')).rejects.toThrow('Request timeout');
  await jest.advanceTimersByTimeAsync(15000);
  await request;
  expect(net.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});
