/**
 * Everything the PWA renders goes through string concatenation into innerHTML,
 * so escHtml is the whole of the first defence. Its output is also what the
 * syntax highlighter pattern-matches against — the two have to agree, and for
 * two of the three string rules they did not.
 */

const { loadPwa, teardownPwa } = require('./harness');

let pwa;

beforeEach(() => {
  pwa = loadPwa();
});

afterEach(() => {
  teardownPwa(pwa);
});

describe('escHtml', () => {
  test('neutralises a tag', () => {
    expect(pwa.escHtml('<img src=x onerror=alert(1)>'))
      .toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  test('escapes both quote characters', () => {
    // Single quotes matter because the highlighter matches on the entity, and
    // because nothing guarantees every future attribute uses double quotes.
    expect(pwa.escHtml(`a"b'c`)).toBe('a&quot;b&#x27;c');
  });

  test('escapes the ampersand first, so entities are not double-decoded', () => {
    expect(pwa.escHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('syntax highlighting reaches every string form', () => {
  test('a single-quoted string is highlighted', () => {
    const out = pwa.syntaxHighlight("const a = 'hello';", 'javascript');
    expect(out).toContain('syn-str');
  });

  test('a template literal is highlighted', () => {
    const out = pwa.syntaxHighlight('const a = `hello`;', 'javascript');
    expect(out).toContain('syn-str');
  });

  test('a double-quoted string is highlighted', () => {
    const out = pwa.syntaxHighlight('const a = "hello";', 'javascript');
    expect(out).toContain('syn-str');
  });

  test('markup inside a highlighted string is still inert', () => {
    const out = pwa.syntaxHighlight(`const a = '<script>x</script>';`, 'javascript');
    expect(out).not.toContain('<script>');
  });
});

describe('renderMarkdown', () => {
  test('inline code still works — escaping backticks would have broken it', () => {
    expect(pwa.renderMarkdown('use `npm ci` here')).toContain('<code>npm ci</code>');
  });

  test('an injected tag does not survive', () => {
    expect(pwa.renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });
});

describe('project colours', () => {
  test('a colour that is not a hex literal cannot reach the style attribute', () => {
    pwa.state.projects = [{
      id: 'p1', name: 'Evil', path: '/tmp/p1',
      color: 'red;background-image:url(https://example.com/track.png)',
    }];
    pwa.state.rootOrder = [];
    pwa.renderProjectsList();

    const html = document.getElementById('projects-list').innerHTML;
    expect(html).not.toContain('background-image');
    expect(html).toContain('#d97706');
  });
});
