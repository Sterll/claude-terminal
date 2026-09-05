/**
 * ArtifactService (renderer)
 *
 * Turns rendered chat markdown into a list of artifacts: the self-contained
 * things Claude produced in a conversation, worth pulling out of the transcript
 * and keeping (an HTML page, an SVG, a Mermaid diagram, a substantial code
 * block, a file it wrote).
 *
 * Detection runs on the RENDERED DOM rather than on the markdown source. That
 * is deliberate: the markdown renderer has already decided what each fenced
 * block is (`blocks/code.js`), so scanning its output means never
 * re-implementing that dispatch, and it means anything the renderer learns to
 * render becomes harvestable by adding one selector below.
 *
 * The pass must only ever run on FINALIZED content — never mid-stream, where a
 * half-written ```html block would be captured as a truncated page. ChatView
 * calls harvest() right after MarkdownRenderer.postProcess(), which is exactly
 * the set of moments where content is settled: end of stream, block edit, and
 * history replay.
 *
 * Ids come from a content hash (src/shared/artifact-store.js), so re-harvesting
 * the same conversation on every session resume is idempotent and needs no
 * bookkeeping on either side.
 */

const { computeId } = require('../../shared/artifact-schema');

// A fenced code block becomes an artifact from this many lines up. Below it,
// a snippet is part of the prose, and promoting it would drown the real
// artifacts in noise.
const MIN_CODE_LINES = 20;

// `text` is what the renderer prints when a fence carried no language. Those
// blocks are usually pasted output, not authored code.
const IGNORED_LANGS = new Set(['text', '']);

// ── Source recovery ──────────────────────────────────────────────────────────

/**
 * Recover the source of a standard code block from its highlighted DOM.
 *
 * configure.js wraps every line in <span class="code-line"> joined by '\n', and
 * substitutes a single space for empty lines so they keep their height. Reading
 * textContent therefore returns the original text with one artefact: blank
 * lines come back as ' '. Restoring exactly those (a line that is a lone space)
 * is safe, because a source line of exactly one space is not a thing worth
 * preserving.
 */
function readCodeSource(codeEl) {
  if (!codeEl) return '';
  return codeEl.textContent.replace(/^ $/gm, '');
}

/** Text of the first matching descendant, or ''. */
function textOf(root, selector) {
  const el = root.querySelector(selector);
  return el ? el.textContent : '';
}

// ── Title derivation ─────────────────────────────────────────────────────────

function firstMatch(source, regex) {
  const m = String(source).match(regex);
  return m && m[1] ? m[1].trim() : '';
}

const MERMAID_KINDS = [
  [/^\s*(graph|flowchart)\b/i, 'Flowchart'],
  [/^\s*sequenceDiagram\b/i, 'Sequence diagram'],
  [/^\s*classDiagram\b/i, 'Class diagram'],
  [/^\s*stateDiagram/i, 'State diagram'],
  [/^\s*erDiagram\b/i, 'ER diagram'],
  [/^\s*gantt\b/i, 'Gantt chart'],
  [/^\s*pie\b/i, 'Pie chart'],
  [/^\s*journey\b/i, 'User journey'],
  [/^\s*mindmap\b/i, 'Mind map'],
];

/** First non-trivial comment line of a snippet, used as a fallback title. */
function firstCommentTitle(source) {
  for (const line of String(source).split('\n', 12)) {
    const m = line.match(/^\s*(?:\/\/|#|--|\*|<!--)\s*(.{3,80}?)\s*(?:-->)?\s*$/);
    if (m && !/^[-=*_#\s]+$/.test(m[1])) return m[1];
  }
  return '';
}

/**
 * A human-readable name for the artifact. This is also what groups versions
 * together, so it has to be stable across rewrites of the same thing: prefer
 * an explicit name the author gave (filename, <title>) over anything derived
 * from the body, which changes on every edit.
 */
function deriveTitle(kind, source, hints = {}) {
  if (hints.filename) return hints.filename;

  switch (kind) {
    case 'html': {
      return firstMatch(source, /<title[^>]*>([^<]+)<\/title>/i)
        || firstMatch(source, /<h1[^>]*>([^<]+)<\/h1>/i)
        || 'Preview';
    }
    case 'svg': {
      return firstMatch(source, /<title[^>]*>([^<]+)<\/title>/i)
        || firstMatch(source, /aria-label="([^"]+)"/i)
        || 'SVG';
    }
    case 'mermaid': {
      const explicit = firstMatch(source, /^\s*title:\s*(.+)$/im);
      if (explicit) return explicit;
      const kindMatch = MERMAID_KINDS.find(([re]) => re.test(source));
      return kindMatch ? kindMatch[1] : 'Diagram';
    }
    case 'file':
      return String(hints.path || '').split(/[\\/]/).pop() || 'File';
    default: {
      const comment = firstCommentTitle(source);
      if (comment) return comment;
      return hints.lang ? `${hints.lang} snippet` : 'Snippet';
    }
  }
}

// ── Detection ────────────────────────────────────────────────────────────────

/** Extract the artifact carried by one DOM node, or null. */
function readNode(node) {
  if (node.classList.contains('chat-preview-container')) {
    const source = textOf(node, '.chat-preview-source');
    if (!source.trim()) return null;
    const filename = node.dataset.filename || '';
    return { kind: 'html', lang: 'html', source, title: deriveTitle('html', source, { filename }) };
  }

  if (node.classList.contains('chat-svg-block')) {
    const source = textOf(node, '.chat-svg-source pre code');
    if (!source.trim()) return null;
    return { kind: 'svg', lang: 'svg', source, title: deriveTitle('svg', source) };
  }

  if (node.classList.contains('chat-mermaid-block')) {
    const source = textOf(node, '.chat-mermaid-source');
    if (!source.trim()) return null;
    return { kind: 'mermaid', lang: 'mermaid', source, title: deriveTitle('mermaid', source) };
  }

  if (node.classList.contains('chat-code-block')) {
    // Diff blocks share the class but carry no recoverable source (the +/- are
    // stripped into separate spans), and they are already a view of a change
    // rather than a thing in their own right.
    if (node.classList.contains('chat-diff-block')) return null;
    const lang = textOf(node, '.chat-code-lang').trim().toLowerCase();
    if (IGNORED_LANGS.has(lang)) return null;

    const codeEl = node.querySelector('pre code');
    if (!codeEl) return null;
    // Reject on the line threshold BEFORE serializing the block. The renderer
    // emits exactly one <span class="code-line"> per line as a direct child of
    // <code>, so childElementCount is the line count for free — reading
    // textContent first meant every short snippet in the transcript paid a full
    // string build only to be thrown away. A live count beats querySelectorAll
    // here, which walks the whole subtree.
    const lineCount = codeEl.childElementCount;
    if (lineCount && lineCount < MIN_CODE_LINES) return null;

    const source = readCodeSource(codeEl);
    // Fallback for markup without per-line spans, where the count above is 0.
    if (source.split('\n').length < MIN_CODE_LINES) return null;
    const filename = textOf(node, '.chat-code-filename').trim();
    return { kind: 'code', lang, source, title: deriveTitle('code', source, { filename, lang }) };
  }

  return null;
}

const ARTIFACT_SELECTOR = '.chat-preview-container, .chat-svg-block, .chat-mermaid-block, .chat-code-block';

/**
 * Scan already-rendered nodes for artifacts.
 *
 * @param {Element|Element[]} roots  a message element, or the batch of elements
 *                                   postProcess() was just handed
 * @param {{messageIndex?: number}} [context]
 * @returns {object[]} artifacts in document order, without store metadata
 */
function detect(roots, context = {}) {
  const list = Array.isArray(roots) ? roots : [roots];
  const found = [];

  for (const root of list) {
    if (!root || root.nodeType !== 1) continue;
    const nodes = [];
    if (root.matches?.(ARTIFACT_SELECTOR)) nodes.push(root);
    nodes.push(...root.querySelectorAll(ARTIFACT_SELECTOR));

    for (const node of nodes) {
      // A preview container holds its own code view; a code block nested in one
      // is a rendering detail, not a second artifact.
      if (node.classList.contains('chat-code-block') && node.closest('.chat-preview-container')) continue;
      let artifact;
      try {
        artifact = readNode(node);
      } catch (e) {
        console.warn('[Artifacts] node read failed:', e.message);
        continue;
      }
      if (!artifact) continue;
      artifact.id = computeId(artifact.kind, artifact.source);
      artifact.messageIndex = context.messageIndex ?? null;
      // Session-only: lets the UI scroll back to where the artifact came from.
      // Deliberately not persisted — the registry copies named fields into the
      // store, so a DOM node never reaches the structured-clone boundary.
      artifact.node = node;
      found.push(artifact);
    }
  }
  return found;
}

/**
 * Artifacts produced by a file-editing tool call. These have no DOM of their
 * own worth scanning: the interesting content is the tool input.
 */
function fromFileTool(toolName, input) {
  if (!input) return null;
  if (toolName === 'Write' && input.file_path && input.content) {
    const source = String(input.content);
    return {
      kind: 'file',
      lang: null,
      source,
      title: deriveTitle('file', source, { path: input.file_path }),
      path: input.file_path,
      id: computeId('file', source),
    };
  }
  return null;
}

// ── Published artifacts (the Agent SDK `Artifact` tool) ──────────────────────

/**
 * Is this tool call a publish worth capturing?
 *
 * The tool has two actions: `publish` (the default) uploads a file, and `list`
 * merely enumerates the gallery. Only the former produces anything.
 */
function isArtifactPublish(toolName, input) {
  return toolName === 'Artifact'
    && !!input
    && input.action !== 'list'
    && !!input.file_path;
}

/**
 * Build a `published` artifact from an `Artifact` tool call.
 *
 * The tool takes a path, never inline content ("Content always comes from
 * file_path — there is no inline content parameter"), so the caller reads the
 * file and passes it in. `url` arrives later, with the tool result, and is
 * optional: an artifact captured from replayed history has no result to wait
 * for and is still worth keeping.
 *
 * Titles follow the tool's own rule: HTML prefers its <title>, Markdown pages
 * "keep their filename identity".
 */
function fromArtifactTool(input, source, url = null) {
  if (!input?.file_path) return null;
  const filename = String(input.file_path).split(/[\\/]/).pop();
  const isMarkdown = /\.md$/i.test(filename);

  const title = isMarkdown
    ? filename
    : (firstMatch(source, /<title[^>]*>([^<]+)<\/title>/i) || input.title || filename);

  return {
    kind: 'published',
    lang: isMarkdown ? 'markdown' : 'html',
    source,
    title,
    path: input.file_path,
    url: url || null,
    description: input.description || null,
    favicon: input.favicon || null,
    id: computeId('published', source),
  };
}

// ── Session registry ─────────────────────────────────────────────────────────

/**
 * One registry per ChatView instance. Holds what the current conversation has
 * produced, in order, deduplicated by content id, and pushes new entries to the
 * persistent store in batches.
 */
function createRegistry({ project, getSessionId, onChange } = {}) {
  const byId = new Map();
  // Artifacts seen but not yet persisted. Flushing is debounced because a
  // history replay calls add() once per batch of messages.
  let pending = [];
  let flushTimer = null;

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!pending.length) return;
    const batch = pending.map((a) => ({
      id: a.id,
      projectId: project?.id || null,
      projectName: project?.name || null,
      sessionId: typeof getSessionId === 'function' ? getSessionId() : null,
      kind: a.kind,
      title: a.title,
      lang: a.lang,
      source: a.source,
      messageIndex: a.messageIndex,
      // Named explicitly rather than spread: `node` must never reach the
      // structured-clone boundary, and a DOM node would throw there.
      url: a.url || null,
      description: a.description || null,
      favicon: a.favicon || null,
      path: a.path || null,
    }));
    pending = [];
    const api = window.electron_api?.artifacts;
    if (!api) return; // persistence is optional; the session list still works
    api.saveMany(batch).catch((e) => console.warn('[Artifacts] persist failed:', e.message));
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 500);
  }

  return {
    /** @returns {number} how many were new */
    add(artifacts) {
      const list = Array.isArray(artifacts) ? artifacts : [artifacts];
      let added = 0;
      for (const artifact of list) {
        if (!artifact || byId.has(artifact.id)) continue;
        byId.set(artifact.id, { ...artifact, createdAt: new Date().toISOString() });
        pending.push(artifact);
        added++;
      }
      if (added) {
        scheduleFlush();
        onChange?.(added);
      }
      return added;
    },

    /** Everything this session produced, in the order it was produced. */
    list() {
      return [...byId.values()];
    },

    get(id) {
      return byId.get(id) || null;
    },

    get size() {
      return byId.size;
    },

    clear() {
      byId.clear();
      pending = [];
      clearTimeout(flushTimer);
      flushTimer = null;
    },

    /** Persist immediately, e.g. before the view is destroyed. */
    flush,
  };
}

module.exports = {
  MIN_CODE_LINES,
  detect,
  fromFileTool,
  fromArtifactTool,
  isArtifactPublish,
  deriveTitle,
  readCodeSource,
  createRegistry,
};
