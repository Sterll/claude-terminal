/**
 * Find-in-conversation, lifted out of ChatView and covered for the first time.
 *
 * jsdom reports `offsetParent` as null for everything and has no
 * `scrollIntoView`, and the subject reads both — so the fixture models them
 * rather than stubbing the subject. `offsetParent` returning null is exactly
 * how the real code recognises a collapsed tool card, which is behaviour
 * worth testing, not worth bypassing.
 */

const { createTranscriptSearch } = require('../../src/renderer/ui/components/chat/transcriptSearch');

let restoreOffsetParent;

beforeAll(() => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      if (this.hidden || this.style.display === 'none') return null;
      return document.body;
    },
  });
  HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  restoreOffsetParent = () => {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'offsetParent', descriptor);
  };
});

afterAll(() => restoreOffsetParent());

function mount(transcriptHtml) {
  const chatView = document.createElement('div');
  chatView.className = 'chat-view';
  chatView.innerHTML = `
    <div class="chat-tabbar"><button class="chat-tab" data-tab="conversation"></button></div>
    <div class="chat-search" hidden>
      <input class="chat-search-input" />
      <span class="chat-search-count"></span>
      <button class="chat-search-prev"></button>
      <button class="chat-search-next"></button>
      <button class="chat-search-close"></button>
    </div>
    <button class="chat-search-btn"></button>
    <div class="chat-messages">${transcriptHtml}</div>
    <textarea class="chat-input"></textarea>
  `;
  document.body.appendChild(chatView);

  const messagesEl = chatView.querySelector('.chat-messages');
  const pruner = {
    suspend: jest.fn(),
    resume: jest.fn(),
    mountAll: jest.fn(),
  };
  const search = createTranscriptSearch({
    chatView,
    messagesEl,
    tabbarEl: chatView.querySelector('.chat-tabbar'),
    getInputEl: () => chatView.querySelector('.chat-input'),
    getPruner: () => pruner,
  });

  return {
    search,
    chatView,
    messagesEl,
    pruner,
    input: chatView.querySelector('.chat-search-input'),
    count: () => chatView.querySelector('.chat-search-count').textContent,
    bar: chatView.querySelector('.chat-search'),
    marks: () => Array.from(messagesEl.querySelectorAll('mark.chat-search-hit')),
    current: () => messagesEl.querySelector('mark.chat-search-hit.current'),
    type(value) {
      this.input.value = value;
      this.input.dispatchEvent(new Event('input'));
      jest.advanceTimersByTime(200); // the 180ms debounce
    },
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  document.querySelectorAll('.chat-view').forEach((el) => el.remove());
});

describe('transcript search', () => {
  test('wraps every match and counts them', () => {
    const f = mount('<div>alpha beta alpha</div><div>ALPHA again</div>');
    f.search.open();
    f.type('alpha');

    expect(f.marks()).toHaveLength(3);
    expect(f.count()).toBe('1/3');
  });

  test('matching is case-insensitive but the original text is preserved', () => {
    const f = mount('<div>Alpha and ALPHA</div>');
    f.search.open();
    f.type('alpha');

    expect(f.marks().map((m) => m.textContent)).toEqual(['Alpha', 'ALPHA']);
  });

  test('a one-character needle is ignored', () => {
    const f = mount('<div>aaaa</div>');
    f.search.open();
    f.type('a');

    expect(f.marks()).toHaveLength(0);
    expect(f.count()).toBe('');
  });

  test('reports no results without marking anything', () => {
    const f = mount('<div>alpha</div>');
    f.search.open();
    f.type('zzz');

    expect(f.marks()).toHaveLength(0);
    expect(f.bar.classList.contains('no-results')).toBe(true);
  });

  test('skips text inside a collapsed card, which cannot be scrolled to', () => {
    const f = mount('<div>alpha</div><div style="display:none"><span>alpha</span></div>');
    f.search.open();
    f.type('alpha');

    // Counting the hidden one would inflate the counter past what the reader
    // can ever reach with next/prev.
    expect(f.marks()).toHaveLength(1);
    expect(f.count()).toBe('1/1');
  });

  test('skips a hidden panel and script text', () => {
    const f = mount('<div hidden>alpha</div><script>var alpha = 1;</script><div>alpha</div>');
    f.search.open();
    f.type('alpha');

    expect(f.marks()).toHaveLength(1);
  });

  test('next and previous wrap around the hits', () => {
    const f = mount('<div>alpha alpha alpha</div>');
    f.search.open();
    f.type('alpha');
    const next = f.chatView.querySelector('.chat-search-next');
    const prev = f.chatView.querySelector('.chat-search-prev');

    expect(f.count()).toBe('1/3');
    next.click(); expect(f.count()).toBe('2/3');
    next.click(); expect(f.count()).toBe('3/3');
    next.click(); expect(f.count()).toBe('1/3');
    prev.click(); expect(f.count()).toBe('3/3');
  });

  test('only one hit is current at a time', () => {
    const f = mount('<div>alpha alpha</div>');
    f.search.open();
    f.type('alpha');
    f.chatView.querySelector('.chat-search-next').click();

    expect(f.messagesEl.querySelectorAll('mark.current')).toHaveLength(1);
    expect(f.current().textContent).toBe('alpha');
  });

  test('closing restores the transcript text exactly', () => {
    const f = mount('<div>alpha beta alpha</div>');
    const before = f.messagesEl.innerHTML;

    f.search.open();
    f.type('alpha');
    expect(f.messagesEl.innerHTML).not.toBe(before);

    f.search.close();

    // Unwrapped and re-normalised: no leftover marks, and no text node split
    // where a mark used to be.
    expect(f.messagesEl.innerHTML).toBe(before);
    expect(f.messagesEl.firstChild.childNodes).toHaveLength(1);
  });

  test('the pruner is suspended and fully mounted for the bar\'s lifetime', () => {
    const f = mount('<div>alpha</div>');

    f.search.open();
    // Search walks the mounted tree, so anything the pruner detached has to be
    // back before it runs, or matches in older messages silently do not exist.
    expect(f.pruner.suspend).toHaveBeenCalled();
    expect(f.pruner.mountAll).toHaveBeenCalled();
    expect(f.pruner.resume).not.toHaveBeenCalled();

    f.search.close();
    expect(f.pruner.resume).toHaveBeenCalled();
  });

  test('closing twice is harmless', () => {
    const f = mount('<div>alpha</div>');
    f.search.open();
    f.search.close();
    f.search.close();
    expect(f.pruner.resume).toHaveBeenCalledTimes(1);
  });

  test('navigation re-runs the search when streaming detached the marks', () => {
    const f = mount('<div id="a">alpha</div><div id="b">alpha</div>');
    f.search.open();
    f.type('alpha');
    expect(f.count()).toBe('1/2');

    // What streaming does: replace a message node, orphaning the mark inside.
    f.messagesEl.querySelector('#b').innerHTML = 'alpha rewritten';

    f.chatView.querySelector('.chat-search-next').click();

    // The stale hit was noticed and the search re-ran rather than focusing a
    // mark that is no longer in the document. The re-run keeps the reader's
    // place, then the requested step is applied on top of it.
    expect(f.marks()).toHaveLength(2);
    expect(f.marks().every((m) => m.isConnected)).toBe(true);
    expect(f.count()).toBe('2/2');
  });

  test('Escape in the field closes the bar', () => {
    const f = mount('<div>alpha</div>');
    f.search.open();
    f.type('alpha');

    f.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(f.bar.hidden).toBe(true);
    expect(f.marks()).toHaveLength(0);
  });

  test('Enter navigates once the query has settled', () => {
    const f = mount('<div>alpha alpha</div>');
    f.search.open();
    f.type('alpha');

    f.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(f.count()).toBe('2/2');

    f.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(f.count()).toBe('1/2');
  });

  test('destroy releases the global shortcut listener', () => {
    const f = mount('<div>alpha</div>');
    f.search.destroy();
    f.chatView.remove();

    // Nothing left bound to document that reaches a detached pane.
    expect(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }));
    }).not.toThrow();
  });
});
