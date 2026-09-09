/**
 * The PWA renders markdown written by a model. Escaping is the first line of
 * defence; the CSP is the one that holds when escaping misses a case. It is
 * only worth anything while script-src stays free of 'unsafe-inline', which in
 * turn is only possible while the markup carries no inline handlers.
 */

const fs = require('fs');
const path = require('path');

const PWA_DIR = path.join(__dirname, '..', '..', 'remote-ui');
const HTML = fs.readFileSync(path.join(PWA_DIR, 'index.html'), 'utf8');
const SERVER = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'main', 'services', 'RemoteServer.js'), 'utf8');

/** Parse a `k v; k v` policy into a directive → sources map. */
function parsePolicy(text) {
  const out = {};
  for (const part of text.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name] = sources;
  }
  return out;
}

const metaPolicy = parsePolicy(
  HTML.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]);

describe('the document policy', () => {
  test('scripts may not be inline or eval', () => {
    expect(metaPolicy['script-src']).toEqual(["'self'"]);
  });

  test('the page cannot be framed or retargeted', () => {
    expect(metaPolicy['frame-ancestors']).toEqual(["'none'"]);
    expect(metaPolicy['object-src']).toEqual(["'none'"]);
    expect(metaPolicy['base-uri']).toEqual(["'none'"]);
  });

  test('it still permits what the app genuinely needs', () => {
    // Attached images arrive as data: URLs; relay mode talks to a user-supplied
    // cloud origin; the service worker and manifest are same-origin.
    expect(metaPolicy['img-src']).toContain('data:');
    expect(metaPolicy['connect-src']).toEqual(expect.arrayContaining(['wss:', 'https:']));
    expect(metaPolicy['worker-src']).toEqual(["'self'"]);
  });
});

describe('the markup honours it', () => {
  test('no inline event handlers survive', () => {
    const handlers = [...HTML.matchAll(/\son[a-z]+=/gi)].map(m => m[0].trim());
    expect(handlers).toEqual([]);
  });

  test('no inline script blocks', () => {
    const inline = [...HTML.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/gi)].map(m => m[0]);
    expect(inline).toEqual([]);
  });
});

describe('the server sends the same policy', () => {
  test('every static response carries it', () => {
    expect(SERVER).toContain("res.setHeader('Content-Security-Policy', PWA_CSP)");
    expect(SERVER).toContain("res.setHeader('X-Content-Type-Options', 'nosniff')");
  });

  test('header and meta tag agree', () => {
    // They are maintained separately — the cloud relay serves these files from
    // a process this one does not control — so drift is the failure mode.
    const listed = [...SERVER.matchAll(/^\s*"([a-z-]+ [^"]*)",$/gm)].map(m => m[1]);
    const headerPolicy = parsePolicy(listed.join('; '));
    expect(headerPolicy).toEqual(metaPolicy);
  });
});

describe('offline shell', () => {
  const SW = fs.readFileSync(path.join(PWA_DIR, 'sw.js'), 'utf8');

  test('precaches everything a cold offline start renders', () => {
    for (const asset of ['/', '/index.html', '/app.js', '/i18n.js', '/style.css']) {
      expect(SW).toContain(`'${asset}'`);
    }
  });
});
