/**
 * Diff Renderer
 *
 * Renders a unified diff the way GitHub does: two gutters (old line, new line),
 * hunk headers, syntax highlighting inside the code, and word-level marks on the
 * parts of a line that actually changed.
 *
 * The input is Claude Code's `structuredPatch`, which every file-editing tool
 * call already carries in the session transcript:
 *
 *   { oldStart, oldLines, newStart, newLines, lines: ["  ctx", "-old", "+new"] }
 *
 * That matters more than it sounds. The patch is computed by the tool that made
 * the edit, so the line numbers are exact — no guessing an anchor's position in
 * a file that has moved on since. Everything here is a rendering concern.
 */

const { escapeHtml, highlight } = require('../utils');
const { t } = require('../i18n');

// A single view can hold several files; past this many lines a diff is folded
// behind a "show the rest" affordance instead of mounting all of it.
const MAX_LINES_RENDERED = 1200;

function extOf(filePath) {
  const base = String(filePath || '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * Highlight one line of code, falling back to plain escaping. highlight.js
 * needs whole tokens, so a lone line can trip it; escaping is always correct.
 */
function highlightLine(text, ext) {
  if (!text) return '';
  try {
    return highlight(text, ext);
  } catch {
    return escapeHtml(text);
  }
}

// ── Word-level marks ─────────────────────────────────────────────────────────

function tokenize(text) {
  // Split on word boundaries but keep the separators, so joining restores the
  // original exactly.
  return text.match(/(\w+|\s+|[^\w\s])/g) || [];
}

/**
 * Common prefix/suffix of two token lists, in token counts. Cheap, and enough
 * for the "what part of this line moved" cue — a full word-diff would be
 * heavier for a marginal gain at this size.
 */
function tokenAffixes(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return { start, endA, endB };
}

/**
 * Wrap the changed middle of a line in <mark>. Returns escaped HTML, so it is
 * used instead of syntax highlighting rather than on top of it: nesting marks
 * inside highlight.js spans would mean parsing its output.
 */
function markedLine(text, counterpart) {
  const mine = tokenize(text);
  const theirs = tokenize(counterpart);
  const { start, endA } = tokenAffixes(mine, theirs);
  if (start === 0 && endA === mine.length) return escapeHtml(text);
  const head = escapeHtml(mine.slice(0, start).join(''));
  const mid = escapeHtml(mine.slice(start, endA).join(''));
  const tail = escapeHtml(mine.slice(endA).join(''));
  return `${head}${mid ? `<mark class="dr-word">${mid}</mark>` : ''}${tail}`;
}

/**
 * Pair each `-` with the `+` that replaced it, within one run of changes, so
 * word marks only appear where a line was rewritten rather than added outright.
 * @returns {Map<number, number>} index of a line -> index of its counterpart
 */
function pairRuns(lines) {
  const pairs = new Map();
  let i = 0;
  while (i < lines.length) {
    if (lines[i][0] !== '-') { i++; continue; }
    let dels = i;
    while (dels < lines.length && lines[dels][0] === '-') dels++;
    let adds = dels;
    while (adds < lines.length && lines[adds][0] === '+') adds++;
    const delCount = dels - i;
    const addCount = adds - dels;
    // Only pair a balanced run: 3 lines replaced by 1 has no line-to-line story.
    if (delCount === addCount) {
      for (let k = 0; k < delCount; k++) {
        pairs.set(i + k, dels + k);
        pairs.set(dels + k, i + k);
      }
    }
    i = adds > i ? adds : i + 1;
  }
  return pairs;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function row(cls, oldNo, newNo, sign, html) {
  return `<div class="dr-row${cls ? ' ' + cls : ''}">`
    + `<span class="dr-ln dr-ln-old">${oldNo == null ? '' : oldNo}</span>`
    + `<span class="dr-ln dr-ln-new">${newNo == null ? '' : newNo}</span>`
    + `<span class="dr-sign">${sign}</span>`
    + `<span class="dr-code">${html}</span>`
    + '</div>';
}

function hunkHeaderRow(hunk) {
  const label = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  return `<div class="dr-row dr-hunk">`
    + `<span class="dr-ln dr-ln-old"></span><span class="dr-ln dr-ln-new"></span>`
    + `<span class="dr-sign"></span>`
    + `<span class="dr-code">${escapeHtml(label)}</span></div>`;
}

/**
 * One hunk as unified rows.
 * @param {{oldStart:number, oldLines:number, newStart:number, newLines:number, lines:string[]}} hunk
 */
function renderHunkUnified(hunk, ext) {
  const lines = hunk.lines || [];
  const pairs = pairRuns(lines);
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  const out = [hunkHeaderRow(hunk)];

  lines.forEach((line, i) => {
    const sign = line[0];
    const text = line.slice(1);
    if (sign === '-') {
      const mate = pairs.get(i);
      const html = mate == null ? highlightLine(text, ext) : markedLine(text, lines[mate].slice(1));
      out.push(row('dr-del', oldNo++, null, '-', html));
    } else if (sign === '+') {
      const mate = pairs.get(i);
      const html = mate == null ? highlightLine(text, ext) : markedLine(text, lines[mate].slice(1));
      out.push(row('dr-add', null, newNo++, '+', html));
    } else {
      out.push(row('', oldNo++, newNo++, ' ', highlightLine(text, ext)));
    }
  });

  return out;
}

/** Side-by-side: old on the left, new on the right, aligned per changed run. */
function renderHunkSplit(hunk, ext) {
  const lines = hunk.lines || [];
  const pairs = pairRuns(lines);
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  const out = [hunkHeaderRow(hunk)];

  function side(cls, no, sign, html) {
    return `<span class="dr-side${cls ? ' ' + cls : ''}">`
      + `<span class="dr-ln">${no == null ? '' : no}</span>`
      + `<span class="dr-sign">${sign}</span>`
      + `<span class="dr-code">${html}</span></span>`;
  }

  let i = 0;
  while (i < lines.length) {
    const sign = lines[i][0];
    if (sign === ' ') {
      const html = highlightLine(lines[i].slice(1), ext);
      out.push(`<div class="dr-row dr-split">${side('', oldNo++, ' ', html)}${side('', newNo++, ' ', html)}</div>`);
      i++;
      continue;
    }
    // Collect the whole run of -/+ so the two columns stay level.
    let dels = i;
    while (dels < lines.length && lines[dels][0] === '-') dels++;
    let adds = dels;
    while (adds < lines.length && lines[adds][0] === '+') adds++;
    const delLines = lines.slice(i, dels);
    const addLines = lines.slice(dels, adds);

    for (let k = 0; k < Math.max(delLines.length, addLines.length); k++) {
      const d = delLines[k];
      const a = addLines[k];
      const left = d == null
        ? side('dr-empty', null, '', '')
        : side('dr-del', oldNo++, '-', a == null ? highlightLine(d.slice(1), ext) : markedLine(d.slice(1), a.slice(1)));
      const right = a == null
        ? side('dr-empty', null, '', '')
        : side('dr-add', newNo++, '+', d == null ? highlightLine(a.slice(1), ext) : markedLine(a.slice(1), d.slice(1)));
      out.push(`<div class="dr-row dr-split">${left}${right}</div>`);
    }
    i = adds > i ? adds : i + 1;
  }
  return out;
}

/**
 * Render a file's hunks.
 * @param {Array} hunks - structuredPatch hunks
 * @param {object} [opts]
 * @param {string} [opts.filePath] - drives syntax highlighting
 * @param {'unified'|'split'} [opts.mode]
 * @returns {string} HTML
 */
function renderPatch(hunks, opts = {}) {
  if (!Array.isArray(hunks) || !hunks.length) {
    return `<div class="dr-empty">${escapeHtml(t('chat.noDiffAvailable'))}</div>`;
  }
  const ext = extOf(opts.filePath);
  const split = opts.mode === 'split';
  let rows = [];
  for (const hunk of hunks) {
    if (!hunk || !Array.isArray(hunk.lines)) continue;
    rows = rows.concat(split ? renderHunkSplit(hunk, ext) : renderHunkUnified(hunk, ext));
  }
  if (!rows.length) {
    return `<div class="dr-empty">${escapeHtml(t('chat.noDiffAvailable'))}</div>`;
  }
  let note = '';
  if (rows.length > MAX_LINES_RENDERED) {
    const hidden = rows.length - MAX_LINES_RENDERED;
    rows = rows.slice(0, MAX_LINES_RENDERED);
    note = `<div class="dr-truncated">${escapeHtml(t('chat.diffMoreLines', { count: hidden }))}</div>`;
  }
  return `<div class="dr-diff${split ? ' dr-diff--split' : ''}">${rows.join('')}${note}</div>`;
}

/** Total +/- across a file's hunks. */
function countPatch(hunks) {
  let additions = 0, deletions = 0;
  for (const hunk of hunks || []) {
    for (const line of hunk.lines || []) {
      if (line[0] === '+') additions++;
      else if (line[0] === '-') deletions++;
    }
  }
  return { additions, deletions };
}

module.exports = { renderPatch, countPatch, MAX_LINES_RENDERED };
