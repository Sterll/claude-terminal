/**
 * Characterization — what the composer accepts, and what it refuses.
 *
 * `classifyFile` is already covered as a pure function in
 * tests/utils/attachments.test.js. What is not covered is the layer above it:
 * the routing in ChatView's `addFiles`, and the ceilings each destination
 * applies. That layer is the one that decides whether a refusal is *said out
 * loud* — the bug its comments describe is files being "dropped on the floor
 * without a word", which is a behaviour no pure-function test can see.
 *
 * Everything below drives the real file input, so the path under test is the
 * one a user's picker takes. FileReader is jsdom's, which resolves on a
 * macrotask; the helpers await it rather than using fake timers.
 *
 * Note on a size mismatch found while writing this: an oversize *image* is
 * refused outright, while an oversize PDF or text file with a `path` is handed
 * over as a path attachment instead. Pinned as-is below; see the task report.
 */

/** api mock: `on*` captures its callback, everything else resolves to a bare success. */
function makeApiMock(listeners) {
  const ns = () => new Proxy({}, {
    get: (_t, method) => (...args) => {
      if (typeof method === 'string' && method.startsWith('on')) {
        listeners[method] = args[0];
        return () => {};
      }
      return Promise.resolve({ success: true, messages: [] });
    }
  });
  return new Proxy({}, { get: () => ns() });
}

let uuidSeq = 0;
Object.defineProperty(global, 'crypto', {
  value: { ...(global.crypto || {}), randomUUID: () => `attach-uuid-${++uuidSeq}` },
  configurable: true,
});

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

// Toasts are the only channel a refusal has, so they are the assertion.
const toasts = [];
jest.mock('../../src/renderer/ui/components/Toast', () => ({
  showToast: (opts) => toasts.push(opts),
  hideToast: () => {},
}));

const { MAX_IMAGE_BYTES } = require('../../src/renderer/utils/attachments');

describe('chat composer attachments (characterization)', () => {
  let listeners, wrapper, view;

  // A fixed number of macrotask drains, not a wall-clock wait: jsdom's
  // readAsText settles a few ticks later than readAsDataURL, and the count has
  // to clear the slowest of them. Load-independent, so CI cannot make it flake.
  const flush = async () => { for (let i = 0; i < 25; i++) await new Promise(r => setTimeout(r, 0)); };

  /**
   * A File whose `size` is forced, so a 25 MB image costs 25 bytes of heap.
   * `type` and `name` are what classifyFile actually reads.
   */
  const makeFile = (name, type, size = 8, extra = {}) => {
    const file = new File(['x'], name, { type });
    Object.defineProperty(file, 'size', { value: size, configurable: true });
    for (const [k, v] of Object.entries(extra)) {
      Object.defineProperty(file, k, { value: v, configurable: true });
    }
    return file;
  };

  /** Drive the real file input, the way the paperclip button does. */
  const pick = async (...files) => {
    const input = wrapper.querySelector('.chat-file-input');
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change'));
    await flush();
  };

  const thumbs = () => wrapper.querySelectorAll('.chat-image-thumb');
  const chips = () => Array.from(wrapper.querySelectorAll('.chat-inline-chip'));
  const lastToast = () => toasts[toasts.length - 1];

  beforeEach(async () => {
    jest.resetModules();
    toasts.length = 0;
    listeners = {};
    window.electron_api = makeApiMock(listeners);
    document.body.innerHTML = '';
    // A chip is inserted at the caret, and jsdom keeps the document selection
    // alive across `body.innerHTML = ''` — so without this a chip lands in the
    // *previous* test's detached composer. A harness artifact, not the app's:
    // nothing tears the composer down under a live selection at runtime.
    window.getSelection().removeAllRanges();
    wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' });
    await flush();
  });

  afterEach(() => {
    try { view?.destroy?.(); } catch (_) { /* teardown is best effort */ }
  });

  // ── Accepted ──

  describe('accepted types', () => {
    it('takes a PNG as an inline image thumbnail', async () => {
      await pick(makeFile('shot.png', 'image/png'));

      expect(thumbs()).toHaveLength(1);
      expect(toasts).toHaveLength(0);
    });

    it('takes each of the four image media types the Messages API allows', async () => {
      await pick(
        makeFile('a.png', 'image/png'),
        makeFile('b.jpg', 'image/jpeg'),
        makeFile('c.gif', 'image/gif'),
        makeFile('d.webp', 'image/webp'),
      );

      expect(thumbs()).toHaveLength(4);
      expect(toasts).toHaveLength(0);
    });

    it('takes a PDF as a composer chip rather than a thumbnail', async () => {
      await pick(makeFile('spec.pdf', 'application/pdf'));

      expect(thumbs()).toHaveLength(0);
      expect(chips()).toHaveLength(1);
      expect(toasts).toHaveLength(0);
    });

    it('takes a text file as a chip too', async () => {
      await pick(makeFile('notes.md', 'text/markdown'));

      expect(chips()).toHaveLength(1);
      expect(toasts).toHaveLength(0);
    });
  });

  // ── Refused, out loud ──

  describe('refusals', () => {
    it('refuses an unsupported binary and says so', async () => {
      await pick(makeFile('archive.zip', 'application/zip'));

      expect(chips()).toHaveLength(0);
      expect(thumbs()).toHaveLength(0);
      expect(toasts).toHaveLength(1);
      expect(lastToast().message).toContain('archive.zip');
    });

    it('refuses a credential file by name, even though it would read as text', async () => {
      await pick(makeFile('.env', ''));

      expect(chips()).toHaveLength(0);
      expect(toasts).toHaveLength(1);
      expect(lastToast().message).toContain('.env');
    });

    it('says something for every refused file in a batch', async () => {
      await pick(
        makeFile('a.zip', 'application/zip'),
        makeFile('b.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      );

      expect(toasts).toHaveLength(2);
    });
  });

  // ── The image ceiling ──

  describe('the 20 MB image ceiling', () => {
    it('is 20 MB', () => {
      // Pinned as a number so a change to the constant is a deliberate act.
      expect(MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024);
    });

    it('takes an image exactly on the line', async () => {
      await pick(makeFile('big.png', 'image/png', MAX_IMAGE_BYTES));

      expect(thumbs()).toHaveLength(1);
      expect(toasts).toHaveLength(0);
    });

    it('refuses one byte over, with a toast naming the file and the cap', async () => {
      await pick(makeFile('huge.png', 'image/png', MAX_IMAGE_BYTES + 1));

      expect(thumbs()).toHaveLength(0);
      expect(toasts).toHaveLength(1);
      expect(lastToast().message).toContain('huge.png');
      expect(lastToast().message).toContain('20');
    });

    it('refuses an oversize image outright even when it has a path on disk', async () => {
      // Characterization, not endorsement: the PDF and text paths hand an
      // oversize file over as a path attachment instead of refusing it. The
      // image path has no such fallback. Reported, not fixed.
      await pick(makeFile('huge.png', 'image/png', MAX_IMAGE_BYTES + 1, { path: '/tmp/test/huge.png' }));

      expect(thumbs()).toHaveLength(0);
      expect(chips()).toHaveLength(0);
      expect(toasts).toHaveLength(1);
    });

    it('lets the rest of a batch through when one file is too big', async () => {
      await pick(
        makeFile('huge.png', 'image/png', MAX_IMAGE_BYTES + 1),
        makeFile('fine.png', 'image/png'),
      );

      expect(thumbs()).toHaveLength(1);
      expect(toasts).toHaveLength(1);
    });
  });

  // ── The count ceiling ──

  describe('the pending-image count ceiling', () => {
    it('accepts five images and refuses the sixth', async () => {
      // The cap is checked against landed *plus in-flight* count, so a single
      // batch of six must not slip five past an asynchronous FileReader.
      await pick(...Array.from({ length: 6 }, (_, i) => makeFile(`img${i}.png`, 'image/png')));

      expect(thumbs()).toHaveLength(5);
      expect(toasts).toHaveLength(1);
    });

    it('is checked before the size ceiling', async () => {
      // Order matters for the message the user gets: at five already pending,
      // a sixth oversize image is refused as "too many", not as "too large".
      await pick(...Array.from({ length: 5 }, (_, i) => makeFile(`img${i}.png`, 'image/png')));
      expect(thumbs()).toHaveLength(5);
      toasts.length = 0;

      await pick(makeFile('huge.png', 'image/png', MAX_IMAGE_BYTES + 1));

      expect(toasts).toHaveLength(1);
      expect(lastToast().message).not.toContain('huge.png');
    });
  });
});
