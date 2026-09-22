/**
 * The Files viewer's three readings of a file, and the reload button.
 *
 * Three regressions are pinned here, all of them things the pane painted
 * without them working:
 *
 *  - Markdown came out under `class="fv-markdown chat-markdown"`. No
 *    stylesheet in the app defines `.chat-markdown`; every markdown rule is
 *    scoped to `.chat-msg-content`. The markup was correct and the typography
 *    was the browser's, which is what "the markdown rendering is broken"
 *    looked like from the outside.
 *  - There was no way back to the source. The mode group only appeared for a
 *    file the selected session had touched, and only ever offered content vs
 *    diff, so a README could be read rendered and no other way.
 *  - Nothing re-read the file. The pane holds no cache, so the fix is a
 *    button, but there was no button.
 */

const path = require('path');

let FileViewer;
let readFileMock;
let statMock;

beforeAll(() => {
  readFileMock = jest.fn(async () => '');
  statMock = jest.fn(async () => ({ size: 100, isDirectory: () => false }));
  window.electron_nodeModules = {
    ...window.electron_nodeModules,
    path,
    fs: {
      ...(window.electron_nodeModules?.fs || {}),
      existsSync: () => true,
      promises: { stat: statMock, readFile: readFileMock },
    },
  };
  window.electron_api = {
    ...window.electron_api,
    dialog: { openInEditor: jest.fn(async () => ({ success: true })), openExternal: jest.fn() },
  };

  FileViewer = require('../../src/renderer/ui/components/FileViewer');
});

let container;

beforeEach(() => {
  document.body.innerHTML = '<div id="pane"></div>';
  container = document.getElementById('pane');
  readFileMock.mockClear();
  window.electron_api.dialog.openInEditor.mockClear();
  require('../../src/renderer/state/settings.state').setSetting('filesMarkdownMode', 'rendered');
});

const DOC = ['# Title', '', 'Some *body* text.', ''].join('\n');

async function open(file, opts = {}) {
  await FileViewer.render(container, file, { project: { id: 'p1', path: '/p' }, ...opts });
}

function modes() {
  return [...container.querySelectorAll('.fv-mode')].map(b => b.dataset.mode);
}

describe('markdown typography', () => {
  test('the rendered container carries the class the markdown CSS is scoped to', async () => {
    readFileMock.mockResolvedValue(DOC);
    await open('/p/README.md');

    const md = container.querySelector('.fv-markdown');
    expect(md).not.toBeNull();
    // The whole point: `chat-markdown` matched no rule anywhere.
    expect(md.classList.contains('chat-msg-content')).toBe(true);
    expect(md.classList.contains('chat-markdown')).toBe(false);
    expect(md.querySelector('h1')).not.toBeNull();
  });
});

describe('rendered / source toggle', () => {
  test('a markdown file offers both readings', async () => {
    readFileMock.mockResolvedValue(DOC);
    await open('/p/README.md');

    expect(modes()).toEqual(['content', 'source']);
  });

  test('switching to source shows the raw text, not the rendered tree', async () => {
    readFileMock.mockResolvedValue(DOC);
    await open('/p/README.md');

    container.querySelector('.fv-mode[data-mode="source"]').click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector('.fv-markdown')).toBeNull();
    expect(container.querySelector('.fv-code')).not.toBeNull();
    expect(container.querySelector('.fv-pre').textContent).toContain('# Title');
  });

  test('the choice carries to the next markdown file opened', async () => {
    readFileMock.mockResolvedValue(DOC);
    await open('/p/README.md');
    container.querySelector('.fv-mode[data-mode="source"]').click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await open('/p/CHANGELOG.md');

    expect(container.querySelector('.fv-mode.active').dataset.mode).toBe('source');
  });

  test('a plain source file gets no one-button tablist', async () => {
    readFileMock.mockResolvedValue('const a = 1;\n');
    await open('/p/app.js');

    expect(container.querySelector('.fv-modes')).toBeNull();
  });

  test('a touched markdown file can be read three ways', async () => {
    readFileMock.mockResolvedValue(DOC);
    await open('/p/README.md', {
      change: { additions: 2, deletions: 1, edits: 1, hunks: [] },
      initialMode: 'diff',
    });

    expect(modes()).toEqual(['content', 'source', 'diff']);
    expect(container.querySelector('.fv-mode.active').dataset.mode).toBe('diff');
  });
});

describe('reload', () => {
  test('the button re-reads the file from disk', async () => {
    readFileMock.mockResolvedValue('first');
    await open('/p/notes.txt');
    expect(container.querySelector('.fv-pre').textContent).toContain('first');

    readFileMock.mockResolvedValue('second');
    container.querySelector('[data-action="reload"]').click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector('.fv-pre').textContent).toContain('second');
  });

  test('it is offered for every file, diff or not', async () => {
    readFileMock.mockResolvedValue('x');
    await open('/p/app.js');
    expect(container.querySelector('[data-action="reload"]')).not.toBeNull();

    readFileMock.mockResolvedValue(DOC);
    await open('/p/README.md');
    expect(container.querySelector('[data-action="reload"]')).not.toBeNull();
  });
});

describe('open in editor', () => {
  test('the header button goes through the bridge that reports failures', async () => {
    readFileMock.mockResolvedValue('x');
    await open('/p/app.js');

    container.querySelector('[data-action="open-editor"]').click();
    await Promise.resolve();

    expect(window.electron_api.dialog.openInEditor).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/p/app.js' })
    );
  });
});
