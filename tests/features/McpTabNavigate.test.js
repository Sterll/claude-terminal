/**
 * MCP tab navigation handler (renderer.js -> api.mcpTab.onNavigate).
 *
 * The handler is registered inline in renderer.js, which cannot be require()d in
 * jsdom (it boots the whole app). So the callback is extracted from the real
 * source text and executed against a fake DOM — the assertions run against the
 * shipped code, not a copy of it. Same approach as the smoke suite, which also
 * analyses renderer.js as text.
 */

const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', '..', 'renderer.js');

/** Pull `api.mcpTab.onNavigate((data) => { ... })` out of renderer.js. */
function extractNavigateHandler() {
  const source = fs.readFileSync(RENDERER, 'utf8');
  const anchor = 'api.mcpTab.onNavigate(';
  const start = source.indexOf(anchor);
  if (start === -1) throw new Error('api.mcpTab.onNavigate not found in renderer.js');

  const bodyStart = source.indexOf('{', source.indexOf('=>', start));
  if (bodyStart === -1) throw new Error('Could not locate the handler body');

  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error('Unbalanced braces in the handler body');

  return source.slice(bodyStart + 1, end);
}

const HANDLER_BODY = extractNavigateHandler();

/** Build a callable handler with injected collaborators. */
function makeHandler(writeResponse) {
  const cssShim = (typeof CSS !== 'undefined' && CSS.escape)
    ? CSS
    : { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };

  const fn = new Function(
    'data', 'document', 'CSS', '_writeTabResponse', 'console',
    HANDLER_BODY
  );
  return (data) => fn(
    data,
    global.document,
    cssShim,
    writeResponse,
    { error: () => {} }
  );
}

function setupDom() {
  document.body.innerHTML = `
    <div class="nav-tabs">
      <div class="nav-tab active" data-tab="claude"></div>
      <div class="nav-tab" data-tab="git"></div>
      <div class="nav-tab nav-tab--hidden" data-tab="errorlog"></div>
      <div id="btn-settings"></div>
    </div>`;

  const clicks = [];
  document.querySelectorAll('.nav-tab[data-tab], #btn-settings').forEach((el) => {
    el.addEventListener('click', () => {
      clicks.push(el.dataset.tab || el.id);
    });
  });
  return clicks;
}

describe('MCP tab navigation handler', () => {
  let responses;
  let clicks;
  let navigate;

  beforeEach(() => {
    responses = [];
    clicks = setupDom();
    navigate = makeHandler((requestId, payload) => responses.push({ requestId, payload }));
  });

  test('switches to a visible tab and reports where it came from', () => {
    navigate({ requestId: 'r1', tab: 'git' });

    expect(clicks).toEqual(['git']);
    expect(responses).toHaveLength(1);
    expect(responses[0].requestId).toBe('r1');
    expect(responses[0].payload).toMatchObject({
      ok: true,
      from: 'claude',
      to: 'git',
      wasHidden: false,
    });
  });

  test('reports wasHidden for a tab parked in the More menu', () => {
    navigate({ requestId: 'r2', tab: 'errorlog' });

    expect(clicks).toEqual(['errorlog']);
    expect(responses[0].payload).toMatchObject({ ok: true, to: 'errorlog', wasHidden: true });
  });

  test('routes settings to its standalone button, not a nav tab', () => {
    navigate({ requestId: 'r3', tab: 'settings' });

    expect(clicks).toEqual(['btn-settings']);
    expect(responses[0].payload).toMatchObject({ ok: true, to: 'settings' });
  });

  test('rejects an unknown tab and lists what exists', () => {
    navigate({ requestId: 'r4', tab: 'does-not-exist' });

    expect(clicks).toEqual([]);
    expect(responses[0].payload.ok).toBe(false);
    expect(responses[0].payload.error).toMatch(/does-not-exist/);
    expect(responses[0].payload.available).toEqual(['claude', 'git', 'errorlog']);
  });

  test('rejects a missing tab parameter without touching the DOM', () => {
    navigate({ requestId: 'r5' });

    expect(clicks).toEqual([]);
    expect(responses[0].payload).toMatchObject({ ok: false });
    expect(responses[0].payload.error).toMatch(/tab/i);
  });

  test('never throws, even with a hostile selector', () => {
    expect(() => navigate({ requestId: 'r6', tab: '"], script' })).not.toThrow();
    expect(responses[0].payload.ok).toBe(false);
    expect(clicks).toEqual([]);
  });
});
