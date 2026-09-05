// DiffRenderer turns a structuredPatch into GitHub-shaped rows.
//
// The line numbers come from the patch, so what these tests really pin is the
// arithmetic that walks them: a deletion advances only the old gutter, an
// addition only the new one. Getting that wrong is invisible on a one-line
// change and badly wrong on a long hunk.

const DiffRenderer = require('../../src/renderer/services/DiffRenderer');

function hunk(oldStart, newStart, lines) {
  return {
    oldStart,
    oldLines: lines.filter(l => l[0] !== '+').length,
    newStart,
    newLines: lines.filter(l => l[0] !== '-').length,
    lines,
  };
}

/** Rows as [oldNo, newNo, sign, text], with HTML stripped. */
function rows(html) {
  return [...html.matchAll(/<div class="dr-row([^"]*)">(.*?)<\/div>(?=<div class="dr-row|<div class="dr-truncated|$)/gs)]
    .map(m => {
      const body = m[2];
      const cells = [...body.matchAll(/<span class="dr-(?:ln[^"]*|sign|code)">(.*?)<\/span>/gs)].map(c => c[1]);
      return { cls: m[1].trim(), cells };
    });
}

describe('DiffRenderer.renderPatch', () => {
  test('reports nothing to draw for an empty patch', () => {
    expect(DiffRenderer.renderPatch([])).toContain('dr-empty');
    expect(DiffRenderer.renderPatch(null)).toContain('dr-empty');
  });

  test('emits a hunk header with the patch coordinates', () => {
    const html = DiffRenderer.renderPatch([hunk(633, 633, [' a', '-b', '+c'])]);
    expect(html).toContain('@@ -633,2 +633,2 @@');
    expect(html).toContain('dr-hunk');
  });

  test('advances the old gutter on deletions and the new one on additions', () => {
    // 10: context, 11: deleted, then two added lines, then context.
    const html = DiffRenderer.renderPatch([hunk(10, 10, [' keep', '-gone', '+one', '+two', ' tail'])]);
    const body = rows(html).filter(r => !r.cls.includes('dr-hunk'));

    // [oldNo, newNo, sign, code]
    expect(body.map(r => [r.cells[0], r.cells[1], r.cells[2]])).toEqual([
      ['10', '10', ' '],   // context advances both
      ['11', '', '-'],     // deletion: old only
      ['', '11', '+'],     // additions: new only
      ['', '12', '+'],
      ['12', '13', ' '],   // context resumes, gutters now offset by one
    ]);
  });

  test('honours a newStart that differs from oldStart', () => {
    const html = DiffRenderer.renderPatch([hunk(5, 40, [' a', '+b'])]);
    const body = rows(html).filter(r => !r.cls.includes('dr-hunk'));
    expect(body[0].cells.slice(0, 2)).toEqual(['5', '40']);
    expect(body[1].cells.slice(0, 2)).toEqual(['', '41']);
  });

  test('marks the changed words of a rewritten line', () => {
    const html = DiffRenderer.renderPatch([hunk(1, 1, ['-const a = 1;', '+const a = 2;'])]);
    // Only the token that moved is wrapped, not the whole line.
    expect(html).toContain('<mark class="dr-word">');
    expect(html).toMatch(/<mark class="dr-word">1<\/mark>/);
    expect(html).toMatch(/<mark class="dr-word">2<\/mark>/);
  });

  test('leaves a pure addition unmarked', () => {
    // Nothing was replaced, so there is no "what changed within the line".
    const html = DiffRenderer.renderPatch([hunk(1, 1, [' ctx', '+brand new'])]);
    expect(html).not.toContain('dr-word');
  });

  test('does not pair an unbalanced run', () => {
    // 3 lines replaced by 1 has no line-to-line story to tell.
    const html = DiffRenderer.renderPatch([hunk(1, 1, ['-a', '-b', '-c', '+z'])]);
    expect(html).not.toContain('dr-word');
  });

  test('escapes code so a diff cannot inject markup', () => {
    const html = DiffRenderer.renderPatch([hunk(1, 1, ['-<img src=x onerror=alert(1)>', '+<b>ok</b>'])]);
    // The payload must survive as text — that is the point of a diff viewer —
    // while the only real tags are the ones the renderer emits itself. A word
    // mark can land between "&lt;" and the tag name, so assert on tags rather
    // than on any particular escaped string.
    const tags = [...html.matchAll(/<([a-zA-Z][\w-]*)/g)].map(m => m[1]);
    expect(new Set(tags)).toEqual(new Set(['div', 'span', 'mark']));
  });

  test('split mode pairs the two columns', () => {
    const html = DiffRenderer.renderPatch([hunk(1, 1, [' a', '-b', '+c'])], { mode: 'split' });
    expect(html).toContain('dr-diff--split');
    expect(html).toContain('dr-side');
  });

  test('split mode leaves a blank cell opposite an unmatched line', () => {
    const html = DiffRenderer.renderPatch([hunk(1, 1, ['+only an addition'])], { mode: 'split' });
    expect(html).toContain('dr-empty');
  });

  test('truncates beyond the row cap and says so', () => {
    const lines = Array.from({ length: DiffRenderer.MAX_LINES_RENDERED + 50 }, (_, i) => `+line ${i}`);
    const html = DiffRenderer.renderPatch([hunk(1, 1, lines)]);
    expect(html).toContain('dr-truncated');
  });

  test('skips malformed hunks instead of throwing', () => {
    const html = DiffRenderer.renderPatch([null, { lines: null }, hunk(1, 1, ['+ok'])]);
    expect(html).toContain('dr-row');
    expect(html).not.toContain('dr-empty');
  });
});

describe('DiffRenderer.countPatch', () => {
  test('counts additions and deletions across hunks', () => {
    expect(DiffRenderer.countPatch([
      hunk(1, 1, ['-a', '+b', '+c']),
      hunk(9, 9, [' x', '-y']),
    ])).toEqual({ additions: 2, deletions: 2 });
  });

  test('is zero for nothing', () => {
    expect(DiffRenderer.countPatch(null)).toEqual({ additions: 0, deletions: 0 });
  });
});
