/**
 * Mermaid failure containment.
 *
 * mermaid's render() always draws into a temp div appended to <body>, and on a
 * parse failure it throws the exception one line *before* removing that div.
 * Every diagram that failed to parse - including the partial ones a message
 * produces while it is still streaming - therefore left mermaid's full-size
 * "Syntax error in text" bomb graphic stranded at the bottom of the window,
 * outside the chat and impossible to dismiss. On a tall screen there was room
 * below the composer for it to be plainly visible.
 *
 * Two things keep that contained, and neither is visible until a diagram fails:
 * the `suppressErrorRendering` flag in MERMAID_CONFIG, and the explicit removal
 * of the temp elements in drawMermaidBlock()'s catch. This suite pins both, so
 * that losing one is a red test rather than a screenshot from a user.
 */

jest.mock('../../src/renderer/i18n', () => ({
  t: (key) => ({
    'chat.mermaid.loading': 'Rendering diagram...',
    'chat.mermaid.error': 'Diagram render failed',
    'chat.mermaid.showSource': 'Show source',
  })[key] || key,
}));

const { MERMAID_CONFIG, drawMermaidBlock } = require('../../src/renderer/services/markdown/postProcess');
const { renderMermaidBlock } = require('../../src/renderer/services/markdown/blocks/code');

/** Build a real .chat-mermaid-block, attached to the document. */
function mountBlock(source) {
  const host = document.createElement('div');
  host.innerHTML = renderMermaidBlock(source);
  document.body.appendChild(host);
  return host.querySelector('.chat-mermaid-block');
}

/**
 * A stub standing in for mermaid at the moment it gives up: it has already
 * appended its temp div to <body> - which the real render() does before it
 * parses anything - and then throws. That is exactly the state the bomb was
 * stranded in.
 */
function failingMermaid() {
  return {
    render: jest.fn(async (id) => {
      const temp = document.createElement('div');
      temp.id = 'd' + id;
      temp.innerHTML = `<svg id="${id}"><text>Syntax error in text</text></svg>`;
      document.body.appendChild(temp);
      throw new Error('Parse error on line 2');
    }),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('MERMAID_CONFIG', () => {
  it('suppresses mermaid\'s own error rendering', () => {
    // Without this, mermaid draws the bomb graphic into its temp div on <body>
    // and only then rethrows. The block renders its own error card instead.
    expect(MERMAID_CONFIG.suppressErrorRendering).toBe(true);
  });

  it('never starts on load, so nothing renders outside a block', () => {
    expect(MERMAID_CONFIG.startOnLoad).toBe(false);
  });

  it('keeps the strict security level', () => {
    // Diagrams come from model output: loose would let a label inject HTML.
    expect(MERMAID_CONFIG.securityLevel).toBe('strict');
  });
});

describe('drawMermaidBlock on a diagram that fails to render', () => {
  it('leaves nothing of mermaid behind on <body>', async () => {
    const block = mountBlock('graph TD\n  A--');
    const id = block.dataset.mermaidId;

    await drawMermaidBlock(failingMermaid(), block);

    expect(document.getElementById('d' + id)).toBeNull();
    expect(document.getElementById(id)).toBeNull();
    expect(document.body.textContent).not.toContain('Syntax error in text');
  });

  it('shows the block\'s own error card with the source', async () => {
    const block = mountBlock('graph TD\n  A--');

    await drawMermaidBlock(failingMermaid(), block);

    const error = block.querySelector('.chat-mermaid-error');
    expect(error.style.display).not.toBe('none');
    expect(error.textContent).toContain('Diagram render failed');
    expect(error.querySelector('details pre code').textContent).toBe('graph TD\n  A--');
    expect(block.querySelector('.chat-mermaid-render').innerHTML).toBe('');
    expect(block.querySelector('.chat-mermaid-loading').style.display).toBe('none');
  });

  it('does not retry the same block, so a stale partial cannot render twice', async () => {
    const block = mountBlock('graph TD\n  A--');
    const mermaid = failingMermaid();

    await drawMermaidBlock(mermaid, block);
    await drawMermaidBlock(mermaid, block);

    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });
});

describe('drawMermaidBlock on a diagram that renders', () => {
  it('puts the svg in the block and hides the error card', async () => {
    const block = mountBlock('graph TD\n  A-->B\n  %% unique ' + Date.now());
    const mermaid = { render: jest.fn(async () => ({ svg: '<svg id="ok"></svg>' })) };

    await drawMermaidBlock(mermaid, block);

    expect(block.querySelector('.chat-mermaid-render').innerHTML).toBe('<svg id="ok"></svg>');
    expect(block.querySelector('.chat-mermaid-loading').style.display).toBe('none');
    expect(block.querySelector('.chat-mermaid-error').style.display).toBe('none');
  });
});
