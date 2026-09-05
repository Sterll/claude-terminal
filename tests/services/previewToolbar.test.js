/**
 * HTML preview toolbar behaviour.
 *
 * The toolbar has two independent groups: Preview/Code, which swaps what the
 * block shows, and the three viewport widths. The Preview/Code pair moved its
 * `.active` highlight from the start; the viewport buttons changed the frame
 * width but never moved the highlight, so the selected width was invisible.
 *
 * Fixtures come from the real renderHtmlPreviewBlock so a markup change in the
 * toolbar fails here rather than silently detaching the handler.
 */

jest.mock('../../src/renderer/i18n', () => ({ t: (key) => key }));

const { renderHtmlPreviewBlock } = require('../../src/renderer/services/markdown/blocks/code');
const { attachInteractivity } = require('../../src/renderer/services/markdown/interactivity');

function mountPreview() {
  const container = document.createElement('div');
  container.innerHTML = renderHtmlPreviewBlock('<p>hello</p>', 'page.html');
  document.body.appendChild(container);
  attachInteractivity(container);
  return container;
}

const btn = (root, action) => root.querySelector(`.chat-preview-btn[data-action="${action}"]`);
const activeActions = (root) =>
  [...root.querySelectorAll('.chat-preview-btn.active')].map((b) => b.dataset.action).sort();

beforeEach(() => {
  document.body.innerHTML = '';
  // Clicking Preview initializes the iframe, which registers the document over
  // the ct-preview:// scheme. Stubbed so the suite exercises the toolbar rather
  // than warning about a bridge jsdom cannot have.
  window.electron_api = { preview: { register: jest.fn().mockResolvedValue({ url: 'ct-preview://test' }) } };
});

afterEach(() => {
  delete window.electron_api;
});

describe('viewport selector', () => {
  it('starts on desktop, which is the width the block renders at', () => {
    const root = mountPreview();

    expect(btn(root, 'viewport-desktop').classList.contains('active')).toBe(true);
    expect(btn(root, 'viewport-tablet').classList.contains('active')).toBe(false);
    expect(btn(root, 'viewport-mobile').classList.contains('active')).toBe(false);
  });

  it('moves the highlight to the clicked width', () => {
    const root = mountPreview();

    btn(root, 'viewport-mobile').click();

    expect(btn(root, 'viewport-mobile').classList.contains('active')).toBe(true);
    expect(btn(root, 'viewport-desktop').classList.contains('active')).toBe(false);
  });

  it('keeps exactly one width highlighted across several switches', () => {
    const root = mountPreview();

    btn(root, 'viewport-tablet').click();
    btn(root, 'viewport-mobile').click();
    btn(root, 'viewport-desktop').click();

    const active = [...root.querySelectorAll('.chat-preview-btn[data-action^="viewport-"].active')];
    expect(active).toHaveLength(1);
    expect(active[0].dataset.action).toBe('viewport-desktop');
  });

  it('still drives the frame width it always did', () => {
    const root = mountPreview();
    const preview = root.querySelector('.chat-preview-container');

    btn(root, 'viewport-tablet').click();
    expect(preview.classList.contains('viewport-tablet')).toBe(true);

    // Desktop is the absence of a modifier, not a class of its own.
    btn(root, 'viewport-desktop').click();
    expect(preview.className).not.toMatch(/viewport-/);
  });
});

describe('the two toolbar groups are independent', () => {
  it('switching width does not disturb the Preview/Code selection', () => {
    const root = mountPreview();

    btn(root, 'code').click();
    btn(root, 'viewport-mobile').click();

    expect(activeActions(root)).toEqual(['code', 'viewport-mobile']);
  });

  it('switching to Code does not disturb the selected width', () => {
    const root = mountPreview();

    btn(root, 'viewport-tablet').click();
    btn(root, 'code').click();

    expect(activeActions(root)).toEqual(['code', 'viewport-tablet']);
  });

  it('swaps the preview and code panes as before', () => {
    const root = mountPreview();
    const iframeWrap = root.querySelector('.chat-preview-iframe-wrap');
    const codeWrap = root.querySelector('.chat-preview-code-wrap');

    btn(root, 'code').click();
    expect(iframeWrap.style.display).toBe('none');
    expect(codeWrap.style.display).toBe('');

    btn(root, 'preview').click();
    expect(iframeWrap.style.display).toBe('');
    expect(codeWrap.style.display).toBe('none');
  });
});
