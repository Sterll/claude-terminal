/**
 * Artifact detection test suite.
 *
 * The fixtures are built by the REAL block renderers from
 * src/renderer/services/markdown/blocks/code.js rather than by hand-written
 * HTML. That is the point of the suite: detection reads the rendered DOM, so
 * the thing worth guarding against is the renderer changing its markup out from
 * under the selectors. A hand-written fixture would keep passing while the app
 * silently stopped finding artifacts.
 */

jest.mock('../../src/renderer/i18n', () => ({
  t: (key) => key,
}));

const {
  renderHtmlPreviewBlock,
  renderSvgBlock,
  renderMermaidBlock,
  renderDiffBlock,
} = require('../../src/renderer/services/markdown/blocks/code');

const {
  detect,
  fromFileTool,
  deriveTitle,
  readCodeSource,
  createRegistry,
  MIN_CODE_LINES,
} = require('../../src/renderer/services/ArtifactService');

const { computeId } = require('../../src/shared/artifact-schema');

/** Mount HTML into a detached container the way ChatView hands nodes to detect(). */
function mount(html) {
  const el = document.createElement('div');
  el.className = 'chat-msg-content';
  el.innerHTML = html;
  return el;
}

/**
 * Reproduce the standard code block markup from configure.js: every line in a
 * <span class="code-line">, joined by newlines, blank lines rendered as a space.
 */
function codeBlockHtml(source, lang, filename = '') {
  const lines = source.split('\n')
    .map((line, i) => `<span class="code-line" data-line="${i + 1}">${line || ' '}</span>`)
    .join('\n');
  const filenameHtml = filename ? `<span class="chat-code-filename">${filename}</span>` : '';
  return `<div class="chat-code-block"><div class="chat-code-header">${filenameHtml}`
    + `<span class="chat-code-lang">${lang}</span></div>`
    + `<pre><code class="line-numbers-off">${lines}</code></pre></div>`;
}

describe('artifact detection', () => {
  it('finds an HTML preview and titles it from <title>', () => {
    const source = '<html><head><title>Sales dashboard</title></head><body><p>hi</p></body></html>';
    const found = detect(mount(renderHtmlPreviewBlock(source, '')));

    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('html');
    expect(found[0].title).toBe('Sales dashboard');
    expect(found[0].source).toBe(source);
  });

  it('prefers an explicit filename over the document title', () => {
    const source = '<html><title>Ignored</title></html>';
    const found = detect(mount(renderHtmlPreviewBlock(source, 'report.html')));

    expect(found[0].title).toBe('report.html');
  });

  it('finds an SVG and recovers its unsanitized source', () => {
    const source = '<svg viewBox="0 0 10 10"><title>Logo</title><circle cx="5" cy="5" r="4"/></svg>';
    const found = detect(mount(renderSvgBlock(source)));

    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('svg');
    expect(found[0].title).toBe('Logo');
    // The rendered SVG is sanitized for display; the artifact keeps the original.
    expect(found[0].source).toBe(source);
  });

  it('finds a Mermaid diagram and names it by diagram type', () => {
    const found = detect(mount(renderMermaidBlock('graph LR\n  A --> B')));

    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('mermaid');
    expect(found[0].title).toBe('Flowchart');
  });

  it('uses an explicit mermaid title when the diagram declares one', () => {
    const found = detect(mount(renderMermaidBlock('---\ntitle: Deploy pipeline\n---\ngraph LR\n A-->B')));

    expect(found[0].title).toBe('Deploy pipeline');
  });

  it('ignores diff blocks, which are a view of a change rather than a thing', () => {
    const diff = renderDiffBlock('- old line\n+ new line\n'.repeat(20), 'app.js');

    expect(detect(mount(diff))).toHaveLength(0);
  });

  describe('code blocks', () => {
    const longSource = Array.from({ length: 25 }, (_, i) => `const x${i} = ${i};`).join('\n');

    it('promotes a long block with a known language', () => {
      const found = detect(mount(codeBlockHtml(longSource, 'javascript', 'app.js')));

      expect(found).toHaveLength(1);
      expect(found[0].kind).toBe('code');
      expect(found[0].lang).toBe('javascript');
      expect(found[0].title).toBe('app.js');
    });

    it('recovers the source, restoring blank lines the renderer padded', () => {
      const withBlanks = `line one\n\nline three${'\nx'.repeat(MIN_CODE_LINES)}`;
      const found = detect(mount(codeBlockHtml(withBlanks, 'javascript')));

      expect(found[0].source).toBe(withBlanks);
    });

    it('skips a block shorter than the threshold', () => {
      const short = Array.from({ length: MIN_CODE_LINES - 1 }, () => 'x').join('\n');

      expect(detect(mount(codeBlockHtml(short, 'python')))).toHaveLength(0);
    });

    it('skips a block with no language, which is usually pasted output', () => {
      expect(detect(mount(codeBlockHtml(longSource, 'text')))).toHaveLength(0);
    });

    it('falls back to the first comment line for an unnamed block', () => {
      const commented = `# Parse the changelog into releases\n${longSource}`;
      const found = detect(mount(codeBlockHtml(commented, 'python')));

      expect(found[0].title).toBe('Parse the changelog into releases');
    });

    it('does not double-count the code view inside an HTML preview', () => {
      const source = `<div>\n${longSource}\n</div>`;
      const found = detect(mount(renderHtmlPreviewBlock(source, 'page.html')));

      expect(found).toHaveLength(1);
      expect(found[0].kind).toBe('html');
    });
  });

  it('returns artifacts in document order across a batch of nodes', () => {
    const nodes = [
      mount(renderMermaidBlock('graph LR\n A-->B')),
      mount(renderSvgBlock('<svg><title>Second</title></svg>')),
    ];
    const found = detect(nodes);

    expect(found.map((a) => a.kind)).toEqual(['mermaid', 'svg']);
  });

  it('assigns content-derived ids, so the same content always yields the same id', () => {
    const source = '<html><title>Stable</title></html>';
    const first = detect(mount(renderHtmlPreviewBlock(source, '')));
    const second = detect(mount(renderHtmlPreviewBlock(source, '')));

    expect(first[0].id).toBe(second[0].id);
    expect(first[0].id).toBe(computeId('html', source));
  });

  it('carries the message index through, so the UI can jump back to the message', () => {
    const found = detect(mount(renderMermaidBlock('pie title Votes\n "a": 1')), { messageIndex: 7 });

    expect(found[0].messageIndex).toBe(7);
  });

  it('tolerates a malformed node instead of losing the whole batch', () => {
    const broken = mount('<div class="chat-preview-container"></div>');
    const good = mount(renderMermaidBlock('graph LR\n A-->B'));

    expect(detect([broken, good])).toHaveLength(1);
  });
});

describe('fromFileTool', () => {
  it('turns a Write call into a file artifact named after the basename', () => {
    const artifact = fromFileTool('Write', { file_path: '/repo/src/util/parse.js', content: 'export const a = 1;' });

    expect(artifact).toMatchObject({ kind: 'file', title: 'parse.js', path: '/repo/src/util/parse.js' });
  });

  it('ignores tools that are not a full file write', () => {
    expect(fromFileTool('Edit', { file_path: '/a.js', old_string: 'a', new_string: 'b' })).toBeNull();
    expect(fromFileTool('Read', { file_path: '/a.js' })).toBeNull();
    expect(fromFileTool('Write', { file_path: '/a.js' })).toBeNull();
  });
});

describe('deriveTitle', () => {
  it('falls back through the chain for HTML', () => {
    expect(deriveTitle('html', '<h1>Only a heading</h1>')).toBe('Only a heading');
    expect(deriveTitle('html', '<div>nothing</div>')).toBe('Preview');
  });

  it('names a snippet after its language when nothing better exists', () => {
    expect(deriveTitle('code', 'a = 1', { lang: 'ruby' })).toBe('ruby snippet');
  });

  it('rejects a decorative comment as a title', () => {
    expect(deriveTitle('code', '// ------------\nconst a = 1;', { lang: 'js' })).toBe('js snippet');
  });
});

describe('readCodeSource', () => {
  it('returns an empty string rather than throwing on a missing node', () => {
    expect(readCodeSource(null)).toBe('');
  });
});

describe('session registry', () => {
  let saveMany;

  beforeEach(() => {
    jest.useFakeTimers();
    saveMany = jest.fn().mockResolvedValue({ created: [], skipped: 0 });
    window.electron_api = { artifacts: { saveMany } };
  });

  afterEach(() => {
    jest.useRealTimers();
    delete window.electron_api;
  });

  const artifact = (id) => ({ id, kind: 'code', title: `t${id}`, lang: 'js', source: 'x', messageIndex: 1 });

  it('deduplicates by id across repeated harvests', () => {
    const registry = createRegistry({ project: { id: 'p1', name: 'Proj' } });

    expect(registry.add([artifact('a'), artifact('b')])).toBe(2);
    expect(registry.add([artifact('a'), artifact('b')])).toBe(0);
    expect(registry.size).toBe(2);
  });

  it('notifies only when something new arrived', () => {
    const onChange = jest.fn();
    const registry = createRegistry({ onChange });

    registry.add(artifact('a'));
    registry.add(artifact('a'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('persists one batch per burst rather than one call per artifact', () => {
    const registry = createRegistry({
      project: { id: 'p1', name: 'Proj' },
      getSessionId: () => 'sess-1',
    });

    registry.add(artifact('a'));
    registry.add(artifact('b'));
    expect(saveMany).not.toHaveBeenCalled();

    jest.advanceTimersByTime(500);

    expect(saveMany).toHaveBeenCalledTimes(1);
    const batch = saveMany.mock.calls[0][0];
    expect(batch).toHaveLength(2);
    expect(batch[0]).toMatchObject({ projectId: 'p1', projectName: 'Proj', sessionId: 'sess-1' });
  });

  it('still tracks artifacts when the persistence bridge is absent', () => {
    delete window.electron_api;
    const registry = createRegistry({});

    registry.add(artifact('a'));
    jest.advanceTimersByTime(500);

    expect(registry.list()).toHaveLength(1);
  });

  it('drops everything on clear, including work not yet flushed', () => {
    const registry = createRegistry({});

    registry.add(artifact('a'));
    registry.clear();
    jest.advanceTimersByTime(500);

    expect(registry.size).toBe(0);
    expect(saveMany).not.toHaveBeenCalled();
  });
});
