/**
 * Markdown rendered by the Files pane must be as interactive as markdown in chat.
 *
 * `MarkdownRenderer.render()` emits a copy button and a line-numbers toggle in
 * every code block, but neither does anything on its own: both rely on the
 * delegated click handler `attachInteractivity()` installs on the container.
 * FileViewer never called it, so the buttons were painted, hoverable and inert.
 * `postProcess()` was missing for the same reason, leaving mermaid diagrams
 * stuck on their loading placeholder.
 */

const path = require('path');

let FileViewer;
let MarkdownRenderer;
let readFileMock;

beforeAll(() => {
  readFileMock = jest.fn(async () => '');
  window.electron_nodeModules = {
    ...window.electron_nodeModules,
    path,
    fs: {
      ...(window.electron_nodeModules?.fs || {}),
      existsSync: () => true,
      promises: {
        stat: async () => ({ size: 100, isDirectory: () => false }),
        readFile: readFileMock,
      },
    },
  };
  window.electron_api = {
    ...window.electron_api,
    dialog: { openInEditor: jest.fn(), openExternal: jest.fn() },
  };

  MarkdownRenderer = require('../../src/renderer/services/MarkdownRenderer');
  FileViewer = require('../../src/renderer/ui/components/FileViewer');
});

let container;
let writeText;

beforeEach(() => {
  document.body.innerHTML = '<div id="pane"></div>';
  container = document.getElementById('pane');
  writeText = jest.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText }, configurable: true, writable: true,
  });
});

async function renderMarkdown(source) {
  readFileMock.mockResolvedValue(source);
  await FileViewer.render(container, '/p/notes.md', { project: { id: 'p1', path: '/p' } });
  return container.querySelector('.fv-markdown');
}

const DOC = ['Intro', '', '```js', 'const a = 1;', '```', ''].join('\n');

test('a markdown file renders a code block with its action buttons', async () => {
  const md = await renderMarkdown(DOC);

  expect(md).not.toBeNull();
  expect(md.querySelector('.chat-code-block')).not.toBeNull();
  expect(md.querySelector('.chat-code-copy')).not.toBeNull();
});

test('the copy button puts the code on the clipboard', async () => {
  await renderMarkdown(DOC);

  container.querySelector('.chat-code-copy').click();

  // The regression: no delegated handler was attached to this container, so
  // the click reached nothing and the clipboard was never written.
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText.mock.calls[0][0]).toContain('const a = 1;');
});

test('the line-numbers toggle flips the code element', async () => {
  await renderMarkdown(DOC);
  const code = container.querySelector('.chat-code-block code');
  expect(code.classList.contains('line-numbers-off')).toBe(true);

  container.querySelector('.chat-code-line-toggle').click();

  expect(code.classList.contains('line-numbers-on')).toBe(true);
});

test('repainting the pane does not stack duplicate handlers', async () => {
  await renderMarkdown(DOC);
  await renderMarkdown(DOC);

  container.querySelector('.chat-code-copy').click();

  // A second attach on the same container would copy twice per click.
  expect(writeText).toHaveBeenCalledTimes(1);
});

test('postProcess runs on the rendered file', async () => {
  const spy = jest.spyOn(MarkdownRenderer, 'postProcess');
  try {
    await renderMarkdown(DOC);
    expect(spy).toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
