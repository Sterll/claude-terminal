// Regression tests for assertSafeUrl — the SSRF guard used by workflow HTTP nodes.
// Exported from src/main/workflow-nodes/_registry.js.

const { assertSafeUrl } = require('../../src/main/workflow-nodes/_registry');

describe('assertSafeUrl', () => {
  describe('accepts safe public URLs', () => {
    test('https public host returns a URL object', () => {
      const url = assertSafeUrl('https://example.com');
      expect(url).toBeInstanceOf(URL);
      expect(url.hostname).toBe('example.com');
    });

    test('http public host is allowed', () => {
      expect(() => assertSafeUrl('http://example.com/path?q=1')).not.toThrow();
    });

    test('public host with port is allowed', () => {
      expect(() => assertSafeUrl('https://api.github.com:443/repos')).not.toThrow();
    });

    test('a public IP is allowed', () => {
      expect(() => assertSafeUrl('http://93.184.216.34/')).not.toThrow();
    });
  });

  describe('rejects malformed URLs', () => {
    test('garbage string throws Invalid URL', () => {
      expect(() => assertSafeUrl('not a url')).toThrow(/Invalid URL/);
    });

    test('empty string throws', () => {
      expect(() => assertSafeUrl('')).toThrow(/Invalid URL/);
    });
  });

  describe('rejects non-http(s) protocols', () => {
    test('file: is blocked', () => {
      expect(() => assertSafeUrl('file:///etc/passwd')).toThrow(/protocol/);
    });

    test('ftp: is blocked', () => {
      expect(() => assertSafeUrl('ftp://example.com/file')).toThrow(/protocol/);
    });
  });

  describe('blocks loopback', () => {
    test('localhost', () => {
      expect(() => assertSafeUrl('http://localhost/')).toThrow(/loopback/);
    });

    test('127.0.0.1', () => {
      expect(() => assertSafeUrl('http://127.0.0.1:8080/')).toThrow(/loopback/);
    });

    test('anything in 127/8 (127.1.2.3)', () => {
      expect(() => assertSafeUrl('http://127.1.2.3/')).toThrow(/loopback/);
    });

    test('0.0.0.0', () => {
      expect(() => assertSafeUrl('http://0.0.0.0/')).toThrow(/loopback/);
    });

    test('IPv6 loopback ::1 (bracketed)', () => {
      expect(() => assertSafeUrl('http://[::1]/')).toThrow(/loopback/);
    });
  });

  describe('blocks RFC-1918 private ranges', () => {
    test('10.0.0.0/8', () => {
      expect(() => assertSafeUrl('http://10.1.2.3/')).toThrow(/private/);
    });

    test('172.16.0.0/12 lower bound', () => {
      expect(() => assertSafeUrl('http://172.16.0.1/')).toThrow(/private/);
    });

    test('172.31.x within /12', () => {
      expect(() => assertSafeUrl('http://172.31.255.254/')).toThrow(/private/);
    });

    test('172.15.x is NOT private (just below range)', () => {
      expect(() => assertSafeUrl('http://172.15.0.1/')).not.toThrow();
    });

    test('172.32.x is NOT private (just above range)', () => {
      expect(() => assertSafeUrl('http://172.32.0.1/')).not.toThrow();
    });

    test('192.168.0.0/16', () => {
      expect(() => assertSafeUrl('http://192.168.1.1/')).toThrow(/private/);
    });
  });

  describe('blocks link-local', () => {
    test('169.254.0.0/16', () => {
      expect(() => assertSafeUrl('http://169.254.169.254/latest/meta-data/')).toThrow(/link-local/);
    });
  });

  describe('blocks IPv6 private / link-local literals', () => {
    test('fc00::/7 unique-local (fc..)', () => {
      expect(() => assertSafeUrl('http://[fc00::1]/')).toThrow(/private/);
    });

    test('fc00::/7 unique-local (fd..)', () => {
      expect(() => assertSafeUrl('http://[fd12::1]/')).toThrow(/private/);
    });

    test('fe80::/10 link-local', () => {
      expect(() => assertSafeUrl('http://[fe80::1]/')).toThrow(/link-local/);
    });
  });

  describe('rejects invalid IPv4 octets', () => {
    // Depending on the Node URL parser, an out-of-range octet is rejected either
    // at URL-parse time ("Invalid URL") or by the octet range check ("Invalid IP").
    // Either way it must throw — never be treated as a safe host.
    test('octet > 255 throws', () => {
      expect(() => assertSafeUrl('http://999.1.1.1/')).toThrow();
    });
  });
});
