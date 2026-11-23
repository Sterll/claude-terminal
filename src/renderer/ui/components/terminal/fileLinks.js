/**
 * Clickable file paths in the terminal.
 *
 * Claude Code prints paths in prose ("Conferi o pedido em /home/me/x.md contra
 * ..."), in tool summaries and in error output. xterm.js only links what an app
 * marks with OSC 8, and even those go through its default handler, which
 * refuses anything that is not http(s). So a path on screen was plain text: no
 * pointer, no click, and the only way to read the file was to copy it out.
 *
 * This registers a link provider that finds path-shaped text on the hovered
 * line, checks the file actually exists (so prose like "and/or" is never
 * underlined), and hands a click to `onOpen` with the absolute path. OSC 8
 * `file://` links are routed to the same place through `linkHandler`; web links
 * keep opening in the browser.
 *
 * Detection is a pure function (`findPathCandidates`) so it can be tested
 * without a terminal.
 */

// Characters that end a path. Quotes, brackets and the usual prose separators;
// a path containing them is legal but rare enough that underlining the common
// case wins.
const STOP = ' \\t\'"`<>()\\[\\]{}|,;*?';

// An absolute POSIX path, a home-relative one, a dot-relative one, a Windows
// drive path, or a bare relative path that has at least one separator.
// Lookbehind keeps `//host/x` out of URLs and `a/b` out of the middle of words.
const PATH_RE = new RegExp(
  '(?<![\\w:/.~\\\\-])' +
  '(' +
    '~[\\/\\\\][^' + STOP + ']+' +                 // ~/foo
    '|\\.{1,2}[\\/\\\\][^' + STOP + ']+' +          // ./foo  ../foo
    '|[A-Za-z]:[\\/\\\\][^' + STOP + ']+' +         // C:\foo  C:/foo
    '|\\/[^' + STOP + '\\/][^' + STOP + ']*' +      // /foo
    '|[\\w@.-]+[\\/\\\\][^' + STOP + ']+' +         // src/foo.js
  ')',
  'g'
);

// Trailing punctuation that belongs to the sentence, not to the path.
const TRAILING = /[.,:;!?'")\]}>]+$/;
// `file.js:12` or `file.js:12:3` — kept out of the path, reported separately.
const LINE_SUFFIX = /:(\d+)(?::(\d+))?$/;

/**
 * Find path-shaped substrings in a line of text.
 * @param {string} text
 * @returns {{ start: number, end: number, text: string, path: string, line: number|null }[]}
 *   `start`/`end` are string offsets (end exclusive) of the whole match including
 *   any `:line[:col]` suffix; `path` is the part that names the file.
 */
function findPathCandidates(text) {
  const out = [];
  if (!text) return out;
  PATH_RE.lastIndex = 0;
  let m;
  while ((m = PATH_RE.exec(text)) !== null) {
    let raw = m[1];
    const start = m.index;
    raw = raw.replace(TRAILING, '');
    let line = null;
    let pathPart = raw;
    const suffix = raw.match(LINE_SUFFIX);
    if (suffix) {
      line = parseInt(suffix[1], 10);
      pathPart = raw.slice(0, raw.length - suffix[0].length);
    }
    pathPart = pathPart.replace(TRAILING, '');
    // A bare relative path ("and/or", "km/h") needs something that looks like
    // a file name at the end before it is worth a stat.
    const bareRelative = !/^([~./\\]|[A-Za-z]:)/.test(pathPart);
    if (bareRelative && !/\.[A-Za-z0-9]{1,10}$/.test(pathPart)) continue;
    if (pathPart.length < 2 || /^[/\\]+$/.test(pathPart)) continue;
    out.push({ start, end: start + raw.length, text: raw, path: pathPart, line });
  }
  return out;
}

/**
 * Resolve a candidate against the terminal's cwd and the home directory.
 * Pure string work: the path bridge is a synchronous IPC per call, and this
 * runs on every hovered line.
 * @param {string} p
 * @param {{ cwd?: string|null, home?: string|null }} ctx
 * @returns {string|null}
 */
function resolveCandidate(p, { cwd, home } = {}) {
  const win = /^[A-Za-z]:[\\/]/.test(p) || (cwd && /^[A-Za-z]:[\\/]/.test(cwd));
  const sep = win ? '\\' : '/';
  let abs;
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/')) abs = p;
  else if (/^~[\\/]/.test(p)) { if (!home) return null; abs = home + sep + p.slice(2); }
  else { if (!cwd) return null; abs = cwd + sep + p; }

  // Normalise `.` and `..` segments.
  const parts = abs.split(/[\\/]+/);
  const head = parts.shift(); // '' for POSIX, 'C:' for Windows
  const stack = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { stack.pop(); continue; }
    stack.push(part);
  }
  return (win ? head + '\\' : '/') + stack.join(sep);
}

/**
 * Read a logical line (a row plus the rows soft-wrapped onto it) as text, with
 * a map from each string offset back to its buffer cell. Wide characters take
 * two cells and one or two code units, so string offsets and columns diverge.
 */
function readLogicalLine(buffer, y) {
  let top = y;
  while (top > 0 && buffer.getLine(top)?.isWrapped) top--;
  let bottom = y;
  while (buffer.getLine(bottom + 1)?.isWrapped) bottom++;

  let text = '';
  const cells = []; // cells[i] = { x, y } (1-based) for text[i]
  for (let row = top; row <= bottom; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const width = cell.getWidth();
      if (width === 0) continue; // trailing half of a wide char
      const chars = cell.getChars() || ' ';
      for (let k = 0; k < chars.length; k++) cells.push({ x: x + 1, y: row + 1, w: width });
      text += chars;
    }
  }
  // Drop the trailing blank cells of the last row; they are not content.
  const trimmed = text.replace(/\s+$/, '');
  return { text: trimmed, cells: cells.slice(0, trimmed.length), top: top + 1, bottom: bottom + 1 };
}

const EXISTS_TTL_MS = 10_000;

/**
 * Register file-path links on a terminal.
 * @param {import('@xterm/xterm').Terminal} terminal
 * @param {Object} opts
 * @param {() => (string|null)} opts.getCwd - directory relative paths resolve against
 * @param {(absPath: string, info: { line: number|null }) => void} opts.onOpen
 * @param {(url: string) => void} [opts.onOpenUrl] - OSC 8 http(s) links
 * @param {(absPath: string) => Promise<boolean>} [opts.isFile] - override for tests
 * @returns {{ dispose: () => void }}
 */
function registerFileLinks(terminal, { getCwd, onOpen, onOpenUrl, isFile } = {}) {
  const nm = (typeof window !== 'undefined' && window.electron_nodeModules) || {};
  const home = nm.os?.homedir?.() || null;
  const cache = new Map(); // absPath -> { ok, at }

  const checkFile = isFile || (async (abs) => {
    const hit = cache.get(abs);
    if (hit && Date.now() - hit.at < EXISTS_TTL_MS) return hit.ok;
    let ok;
    try {
      const st = await nm.fs.promises.stat(abs);
      ok = !!st && st.isFile();
    } catch { ok = false; }
    if (cache.size > 500) cache.clear();
    cache.set(abs, { ok, at: Date.now() });
    return ok;
  });

  const provider = {
    provideLinks(bufferLineNumber, callback) {
      const buffer = terminal.buffer.active;
      const { text, cells } = readLogicalLine(buffer, bufferLineNumber - 1);
      const candidates = findPathCandidates(text);
      if (!candidates.length) { callback(undefined); return; }

      const cwd = (() => { try { return getCwd?.() || null; } catch { return null; } })();
      Promise.all(candidates.map(async (c) => {
        const abs = resolveCandidate(c.path, { cwd, home });
        if (!abs || !(await checkFile(abs))) return null;
        const first = cells[c.start];
        const last = cells[c.end - 1];
        if (!first || !last) return null;
        // Only report links that touch the row being asked about; xterm asks
        // for each row of a wrapped line separately.
        if (first.y > bufferLineNumber || last.y < bufferLineNumber) return null;
        return {
          range: { start: { x: first.x, y: first.y }, end: { x: last.x + (last.w > 1 ? 1 : 0), y: last.y } },
          text: c.text,
          decorations: { pointerCursor: true, underline: true },
          activate: (event) => {
            if (event?.button && event.button !== 0) return;
            onOpen?.(abs, { line: c.line });
          },
        };
      })).then(links => {
        const found = links.filter(Boolean);
        callback(found.length ? found : undefined);
      }, () => callback(undefined));
    },
  };

  const registration = terminal.registerLinkProvider(provider);

  // OSC 8 hyperlinks. The default handler only opens http(s) and asks for
  // confirmation first; a `file://` link from the CLI went nowhere.
  terminal.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: (event, uri) => {
      if (/^https?:\/\//i.test(uri)) { onOpenUrl?.(uri); return; }
      if (/^file:\/\//i.test(uri)) {
        let p;
        try {
          p = decodeURIComponent(new URL(uri).pathname);
        } catch { return; }
        // file:///C:/x -> /C:/x on Windows
        if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
        const lineMatch = uri.match(/#L?(\d+)$/);
        onOpen?.(p, { line: lineMatch ? parseInt(lineMatch[1], 10) : null });
      }
    },
  };

  return { dispose: () => registration.dispose() };
}

module.exports = { registerFileLinks, findPathCandidates, resolveCandidate, readLogicalLine };
