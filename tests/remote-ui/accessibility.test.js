/**
 * The PWA is almost entirely icon buttons. An unlabelled one is announced as
 * just "button" — indistinguishable from the fourteen next to it — so this
 * asserts every control the user can reach has a name, and that pinch-zoom is
 * not blocked.
 */

const { loadPwa, teardownPwa } = require('./harness');

let pwa;

/** The name a screen reader would announce, by the rules that apply here. */
function accessibleName(el) {
  return (
    el.getAttribute('aria-label')
    || el.getAttribute('title')
    || el.textContent.trim()
  );
}

beforeEach(() => {
  pwa = loadPwa();
});

afterEach(() => {
  teardownPwa(pwa);
});

describe('accessible names', () => {
  test('every button has one', () => {
    const unnamed = [...document.querySelectorAll('button')]
      .filter(b => !accessibleName(b))
      .map(b => b.id || b.className || b.outerHTML.slice(0, 60));

    expect(unnamed).toEqual([]);
  });

  test('every form control has one', () => {
    const unnamed = [...document.querySelectorAll('input, select, textarea')]
      // The file inputs are clicked programmatically by the plus menu and are
      // out of the accessibility tree — naming them would only add noise.
      .filter(el => el.getAttribute('aria-hidden') !== 'true')
      .filter(el => !(
        accessibleName(el)
        || el.getAttribute('placeholder')
        || document.querySelector(`label[for="${el.id}"]`)
      ))
      .map(el => el.id || el.outerHTML.slice(0, 60));

    expect(unnamed).toEqual([]);
  });
});

describe('the chat transcript is announced', () => {
  test('it is a polite live region', () => {
    const chat = document.getElementById('chat-messages');
    expect(chat.getAttribute('role')).toBe('log');
    expect(chat.getAttribute('aria-live')).toBe('polite');
  });
});

describe('the plus menu reports its state', () => {
  test('aria-expanded follows the menu', () => {
    const btn = document.getElementById('plus-menu-btn');
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    btn.click();
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    btn.click();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('viewport', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'remote-ui', 'index.html'), 'utf8');

  test('pinch-zoom is not blocked', () => {
    // WCAG 2.1 SC 1.4.4. The 16px font-size on inputs is what actually stops
    // iOS auto-zoom; maximum-scale only ever cost users the ability to zoom.
    const meta = html.match(/<meta name="viewport" content="([^"]+)"/)[1];
    expect(meta).not.toMatch(/maximum-scale/);
    expect(meta).not.toMatch(/user-scalable\s*=\s*no/);
  });

  test('the layout viewport reacts to the on-screen keyboard', () => {
    const meta = html.match(/<meta name="viewport" content="([^"]+)"/)[1];
    expect(meta).toContain('interactive-widget=resizes-content');
  });
});
