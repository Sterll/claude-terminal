/**
 * The units lifted out of ChatView's 9k-line closure.
 *
 * None of this was reachable from a test before the split — it lived in local
 * functions of `createChatView`, so covering it meant standing up the whole
 * component. That is the point of the extraction, so the cover comes with it.
 */

const {
  formatTokenCount,
  contextSummaryText,
  contextUsageRows,
} = require('../../src/renderer/ui/components/chat/contextUsage');
const { buildExport } = require('../../src/renderer/ui/components/chat/exportConversation');
const { parseCreatedTaskId, extractResultText, parseResultJson } =
  require('../../src/renderer/ui/components/chat/resultParsing');
const { createLightbox } = require('../../src/renderer/ui/components/chat/lightbox');

describe('contextUsage — token formatting', () => {
  test.each([
    [820, '820'],
    [1000, '1k'],
    [371_300, '371.3k'],
    [1_000_000, '1M'],
    [1_450_000, '1.5M'],
    [0, '0'],
  ])('formats %i as %s', (n, expected) => {
    expect(formatTokenCount(n)).toBe(expected);
  });

  test('summarises used against the window', () => {
    expect(contextSummaryText(371_300, 1_000_000)).toBe('371.3k / 1M (37%)');
  });

  test('a zero window reports 0% rather than NaN', () => {
    expect(contextSummaryText(100, 0)).toBe('100 / 0 (0%)');
  });
});

describe('contextUsage — which rows count as used', () => {
  test('reads the array shape the CLI actually returns', () => {
    const rows = contextUsageRows({
      categories: [
        { name: 'Messages', tokens: 5000 },
        { name: 'System prompt', tokens: 1200 },
      ],
    });
    expect(rows.map((r) => r.name)).toEqual(['Messages', 'System prompt']);
  });

  test('still reads the older map-of-numbers shape', () => {
    const rows = contextUsageRows({ breakdown: { system_prompt: 1200, messages: 5000 } });
    expect(rows).toEqual([
      { name: 'messages', tokens: 5000 },
      { name: 'system prompt', tokens: 1200 },
    ]);
  });

  test('drops what belongs to the window but is not occupancy', () => {
    const rows = contextUsageRows({
      categories: [
        { name: 'Messages', tokens: 5000 },
        { name: 'Free space', tokens: 90_000 },
        { name: 'Autocompact buffer', tokens: 20_000 },
        { name: 'Compaction reserve', tokens: 10_000 },
      ],
    });
    expect(rows.map((r) => r.name)).toEqual(['Messages']);
  });

  test('an explicit kind beats the name heuristic', () => {
    // A row named like a free row is still used when the CLI says so, and a
    // plainly-named row is not when it says otherwise.
    const rows = contextUsageRows({
      categories: [
        { name: 'freeform notes', tokens: 100, kind: 'used' },
        { name: 'Messages', tokens: 5000, kind: 'free' },
      ],
    });
    expect(rows.map((r) => r.name)).toEqual(['freeform notes']);
  });

  test('drops deferred and empty rows, and sorts biggest first', () => {
    const rows = contextUsageRows({
      categories: [
        { name: 'Small', tokens: 10 },
        { name: 'Empty', tokens: 0 },
        { name: 'Deferred', tokens: 9999, isDeferred: true },
        { name: 'Big', tokens: 500 },
      ],
    });
    expect(rows.map((r) => r.name)).toEqual(['Big', 'Small']);
  });

  test('a response with no categories at all yields no rows', () => {
    expect(contextUsageRows({})).toEqual([]);
  });
});

describe('exportConversation — formats', () => {
  const history = [
    { role: 'user', content: 'fix <script>alert(1)</script>' },
    { role: 'assistant', content: 'Done.' },
  ];

  test('json round-trips the transcript as stored', () => {
    const { content, ext, mime } = buildExport(history, 'json');
    expect(JSON.parse(content)).toEqual(history);
    expect([ext, mime]).toEqual(['json', 'application/json']);
  });

  test('markdown labels each turn and separates them', () => {
    const { content, ext } = buildExport(history, 'markdown');
    expect(content).toContain('## You');
    expect(content).toContain('## Claude');
    expect(content).toContain('\n---\n');
    expect(ext).toBe('md');
  });

  test('an unknown format falls back to markdown rather than throwing', () => {
    expect(buildExport(history, 'rtf').ext).toBe('md');
  });

  test('html escapes the user turn instead of rendering it', () => {
    const { content } = buildExport(history, 'html');
    expect(content).toContain('&lt;script&gt;');
    expect(content).not.toContain('<script>alert(1)</script>');
  });

  test('html is a standalone document, not a fragment', () => {
    const { content, mime } = buildExport(history, 'html');
    expect(content.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(content).toContain('<style>'); // its own CSS: no app variables out there
    expect(mime).toBe('text/html');
  });

  test('an empty conversation still produces a valid document', () => {
    expect(() => buildExport([], 'html')).not.toThrow();
    expect(buildExport([], 'json').content).toBe('[]');
  });
});

describe('resultParsing', () => {
  test('reads a string result and an array-of-parts result alike', () => {
    expect(extractResultText({ content: 'hello' })).toBe('hello');
    expect(extractResultText({ content: [{ text: 'a' }, { text: 'b' }] })).toBe('a\nb');
    expect(extractResultText(null)).toBe('');
  });

  test('parseResultJson returns null rather than throwing on prose', () => {
    expect(parseResultJson('not json')).toBeNull();
    expect(parseResultJson('{ broken')).toBeNull();
    expect(parseResultJson('{"a":1}')).toEqual({ a: 1 });
  });

  test('reads the task id TaskCreate reports in prose', () => {
    // The id here is what every later TaskUpdate addresses; missing it files
    // the task under its tool_use_id and freezes the bar at 0/N.
    expect(parseCreatedTaskId('Task #3 created successfully: ship it')).toBe('3');
    expect(parseCreatedTaskId('task abc-1 created')).toBe('abc-1');
  });

  test('prefers the id when the result did come back as JSON', () => {
    expect(parseCreatedTaskId(JSON.stringify({ task: { id: 42 } }))).toBe('42');
    expect(parseCreatedTaskId(JSON.stringify({ taskId: 'x1' }))).toBe('x1');
  });

  test('reports nothing when there is no id to read', () => {
    expect(parseCreatedTaskId('something else entirely')).toBeNull();
    expect(parseCreatedTaskId('')).toBeNull();
  });
});

describe('lightbox', () => {
  afterEach(() => {
    document.querySelectorAll('.chat-lightbox').forEach((el) => el.remove());
  });

  test('builds nothing until it is opened', () => {
    createLightbox();
    expect(document.querySelector('.chat-lightbox')).toBeNull();
  });

  test('shows a counter and arrows only for more than one image', () => {
    const lb = createLightbox();
    lb.open(['a.png'], 0);
    const el = document.querySelector('.chat-lightbox');
    expect(el.querySelector('.chat-lightbox-counter').style.display).toBe('none');
    expect(el.querySelector('.chat-lightbox-prev').style.display).toBe('none');

    lb.open(['a.png', 'b.png'], 0);
    expect(el.querySelector('.chat-lightbox-counter').textContent).toBe('1 / 2');
    expect(el.querySelector('.chat-lightbox-prev').style.display).toBe('');
  });

  test('arrow keys wrap around the list', () => {
    const lb = createLightbox();
    lb.open(['a.png', 'b.png', 'c.png'], 0);
    const counter = () => document.querySelector('.chat-lightbox-counter').textContent;

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(counter()).toBe('3 / 3');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(counter()).toBe('1 / 3');
  });

  test('a closed lightbox stops answering Escape', () => {
    const lb = createLightbox();
    lb.open(['a.png'], 0);
    const el = document.querySelector('.chat-lightbox');
    el.classList.add('active');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(el.classList.contains('active')).toBe(false);

    // The listener has to be gone, or it swallows Escape from whatever has
    // focus next — the composer, a modal, the search bar.
    el.classList.add('active');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(el.classList.contains('active')).toBe(true);
  });

  test('destroy takes the element and its listener with it', () => {
    const lb = createLightbox();
    lb.open(['a.png'], 0);
    lb.destroy();
    expect(document.querySelector('.chat-lightbox')).toBeNull();
    expect(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))).not.toThrow();
  });
});
