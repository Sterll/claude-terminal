/**
 * Incremental streaming renderer for real-time markdown display.
 *
 * Streaming markdown is rendered into two sibling elements:
 *   .stream-stable  — completed blocks, appended once and never touched again
 *   .stream-active  — the tail that may still change, re-rendered every frame
 *
 * The stable side is grown by *appending* the newly completed blocks and
 * advancing a running offset (`cache.committedLen`). Each append parses only
 * `text.slice(committedLen, boundary)`, so the total work over a stream is
 * linear in the length of the message instead of quadratic.
 *
 * Correctness constraint: `parse(a) + parse(b)` must equal `parse(a + b)` for
 * every split point we commit at, otherwise the transcript would render
 * differently from a full render. Most markdown blocks are independent, but a
 * few constructs survive a blank line and would be silently split in half:
 *
 *   - loose lists          `- a\n\n- b`      → one list, not two
 *   - indented code        `    a\n\n    b`  → one <pre>, not two
 *   - link ref definitions `[x]: url`        → resolved document-wide
 *   - raw HTML types 1-5   `<!-- a\n\nb -->` → one HTML block
 *   - <details> spoilers                     → renderer emits unbalanced divs
 *
 * `_scanLines` tracks exactly these hazards and only reports a boundary as
 * committable when neither side can merge across it. Anything not provably
 * safe simply stays in the active element and is re-rendered as before — the
 * output is never allowed to differ, only the amount of repeated work changes.
 */

const { marked } = require('marked');
const DOMPurify = require('dompurify');
const { escapeHtml } = require('../../utils');
const { configure, PURIFY_CONFIG } = require('./configure');

/** A list item marker at a container-level indent (0-3 spaces). */
const LIST_MARKER_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
/** Link reference definition — forces a full re-parse (may be referenced anywhere). */
const REF_DEF_RE = /^ {0,3}\[[^\]\n]+\]:/;
/** Opening fence, CommonMark-style (up to 3 leading spaces). */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
/** CommonMark raw-HTML blocks of type 1-5: these can span blank lines. */
const RAW_HTML_START_RE = /^ {0,3}<(!--|\?|!\[CDATA\[|![A-Za-z]|(script|pre|style|textarea)\b)/i;

/**
 * Create a stream cache for incremental rendering.
 * One cache per streaming message.
 *
 * Only the four public fields are created here; the incremental scanner state
 * is attached lazily on the first `renderIncremental` call.
 */
function createStreamCache() {
  return { stableEl: null, activeEl: null, stableText: '', initialized: false };
}

/** Visual indentation of a line, tabs counted as 4 columns. */
function indentOf(line) {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') n++;
    else if (c === '\t') n += 4;
    else break;
  }
  return n;
}

/**
 * A line is "continuation-prone" when it can belong to a list or an indented
 * code block. A blank line between two such lines does NOT end the block, so
 * splitting there would change the rendered output.
 */
function isContinuationProne(line) {
  return line != null && (LIST_MARKER_RE.test(line) || indentOf(line) >= 2);
}

/**
 * Consume every *complete* line added since the last call and update the
 * scanner state on the cache. Records the last committable boundary found in
 * `cache.safeBoundary` (an offset into `text`, or -1).
 *
 * A trailing partial line (no newline yet) is deliberately left unscanned: it
 * can still grow, so no decision may depend on it.
 */
function _scanLines(text, cache) {
  while (cache.scanPos < text.length) {
    const nl = text.indexOf('\n', cache.scanPos);
    if (nl === -1) break; // partial line — wait for the rest
    const lineStart = cache.scanPos;
    const line = text.slice(lineStart, nl);
    cache.scanPos = nl + 1;

    // ── Inside a raw HTML block (types 1-5): no boundaries until it closes ──
    if (cache.rawHtmlEnd) {
      if (cache.rawHtmlEnd.test(line)) cache.rawHtmlEnd = null;
      if (line.trim()) cache.prevContentLine = line;
      continue;
    }

    // ── Fenced code blocks ──
    const fence = line.match(FENCE_OPEN_RE);
    if (fence) {
      const char = fence[1][0];
      const len = fence[1].length;
      if (!cache.inFence) {
        cache.inFence = true;
        cache.fenceChar = char;
        cache.fenceLen = len;
      } else if (char === cache.fenceChar && len >= cache.fenceLen
        && new RegExp('^ {0,3}[' + char + ']{' + cache.fenceLen + ',}[ \\t]*$').test(line)) {
        cache.inFence = false;
      }
      cache.prevContentLine = line;
      cache.sawBlank = false;
      continue;
    }
    if (cache.inFence) {
      cache.prevContentLine = line;
      cache.sawBlank = false;
      continue;
    }

    // ── Link reference definitions poison every split point ──
    if (REF_DEF_RE.test(line)) cache.hasRefDef = true;

    // ── <details> spoilers: the custom renderer emits unbalanced divs, so a
    //    split inside one would be "repaired" differently by DOMPurify ──
    if (/<details[\s>]/i.test(line)) cache.detailsDepth++;
    if (/<\/details>/i.test(line)) cache.detailsDepth = Math.max(0, cache.detailsDepth - 1);

    // ── Raw HTML block openers that can swallow blank lines ──
    const rawStart = line.match(RAW_HTML_START_RE);
    if (rawStart) {
      const kind = rawStart[1].toLowerCase();
      const end = kind === '!--' ? /-->/
        : kind === '?' ? /\?>/
          : kind.indexOf('![cdata[') === 0 ? /\]\]>/
            : kind.charAt(0) === '!' ? />/
              : new RegExp('</' + rawStart[2] + '>', 'i');
      if (!end.test(line.slice(rawStart[0].length))) cache.rawHtmlEnd = end;
    }

    // ── Blank line: arms a boundary candidate for the next content line ──
    if (!line.trim()) {
      if (cache.prevContentLine !== null) cache.sawBlank = true;
      continue;
    }

    if (cache.sawBlank) {
      cache.sawBlank = false;
      const mergeable = isContinuationProne(line) && isContinuationProne(cache.prevContentLine);
      if (!mergeable && cache.detailsDepth === 0 && !cache.rawHtmlEnd) {
        cache.safeBoundary = lineStart;
      }
    }
    cache.prevContentLine = line;
  }
}

/** Parse + sanitize a self-contained chunk of markdown, with a plain-text fallback. */
function _renderChunk(chunk) {
  try {
    return DOMPurify.sanitize(marked.parse(chunk), PURIFY_CONFIG);
  } catch (err) {
    console.warn('[StreamRenderer] Stable block parse failed:', err.message);
    return `<pre>${escapeHtml(chunk)}</pre>`;
  }
}

/**
 * Render incrementally: append newly completed blocks to the stable element and
 * only re-render the last (incomplete) block.
 * @param {string} text - Full accumulated markdown text
 * @param {HTMLElement} container - The .chat-msg-content element
 * @param {object} cache - Stream cache from createStreamCache()
 */
function renderIncremental(text, container, cache) {
  configure();

  // Initialize container with stable + active elements
  if (!cache.initialized) {
    cache.stableEl = document.createElement('div');
    cache.stableEl.className = 'stream-stable';
    cache.activeEl = document.createElement('div');
    cache.activeEl.className = 'stream-active';
    container.innerHTML = '';
    container.appendChild(cache.stableEl);
    container.appendChild(cache.activeEl);
    cache.initialized = true;
    cache.stableText = '';

    // Incremental scanner state (kept off createStreamCache's public shape)
    cache.committedLen = 0;    // chars already appended to stableEl
    cache.scanPos = 0;         // chars consumed by _scanLines
    cache.safeBoundary = -1;   // last committable boundary
    cache.inFence = false;
    cache.fenceChar = '';
    cache.fenceLen = 0;
    cache.rawHtmlEnd = null;
    cache.detailsDepth = 0;
    cache.prevContentLine = null;
    cache.sawBlank = false;
    cache.hasRefDef = false;
    cache.fullReparse = false;
    cache.activeText = null;   // memo of the last activeEl input
  }

  _scanLines(text, cache);

  // A link reference definition can be referenced from anywhere in the message
  // (including backwards), so incremental appends stop being sound. Fall back
  // to re-rendering the whole stable prefix, exactly like a non-incremental run.
  if (cache.hasRefDef && !cache.fullReparse) {
    cache.fullReparse = true;
    cache.committedLen = 0;
    cache.stableText = '';
    cache.stableEl.innerHTML = '';
    cache.activeText = null;
  }

  let activeText;

  if (cache.fullReparse) {
    const splitIdx = findStableBlockBoundary(text);
    const stableText = splitIdx > 0 ? text.substring(0, splitIdx) : '';
    activeText = splitIdx > 0 ? text.substring(splitIdx) : text;
    if (stableText && stableText !== cache.stableText) {
      cache.stableText = stableText;
      cache.stableEl.innerHTML = _renderChunk(stableText);
    }
  } else {
    // Append only the blocks that completed since the last commit.
    if (cache.safeBoundary > cache.committedLen) {
      const chunk = text.slice(cache.committedLen, cache.safeBoundary);
      cache.committedLen = cache.safeBoundary;
      cache.safeBoundary = -1;
      cache.stableText = text.slice(0, cache.committedLen);
      cache.stableEl.insertAdjacentHTML('beforeend', _renderChunk(chunk));
    }
    activeText = cache.committedLen > 0 ? text.slice(cache.committedLen) : text;
  }

  // The active element is a pure function of activeText, so an unchanged
  // activeText means the DOM is already correct.
  if (activeText === cache.activeText) return;
  cache.activeText = activeText;

  try {
    const parsedActive = activeText ? marked.parse(activeText) : '';
    cache.activeEl.innerHTML = DOMPurify.sanitize(
      parsedActive + '<span class="chat-cursor"></span>',
      PURIFY_CONFIG
    );
  } catch (err) {
    console.warn('[StreamRenderer] Active block parse failed:', err.message);
    cache.activeEl.innerHTML = `<pre>${escapeHtml(activeText)}</pre><span class="chat-cursor"></span>`;
    cache.activeText = null; // don't memoize a fallback render
  }
}

/**
 * Find the last "block boundary" in text - a double-newline NOT inside a fenced code block.
 * Returns the character index after the boundary, or -1 if none found.
 *
 * Retained as the public helper and used by the link-reference fallback path;
 * the incremental path uses the stateful `_scanLines` scanner instead.
 */
function findStableBlockBoundary(text) {
  let inCodeBlock = false;
  let lastBoundary = -1;
  const len = text.length;

  for (let i = 0; i < len - 1; i++) {
    // Track fenced code blocks (```)
    if (i + 2 < len && text[i] === '`' && text[i + 1] === '`' && text[i + 2] === '`') {
      if (!inCodeBlock) {
        inCodeBlock = true;
        while (i < len && text[i] !== '\n') i++;
      } else {
        inCodeBlock = false;
        while (i < len && text[i] !== '\n') i++;
      }
      continue;
    }

    // Track double-newlines outside code blocks
    if (!inCodeBlock && text[i] === '\n' && text[i + 1] === '\n') {
      lastBoundary = i + 2;
    }
  }

  return lastBoundary;
}

module.exports = {
  createStreamCache,
  renderIncremental,
  findStableBlockBoundary,
};
