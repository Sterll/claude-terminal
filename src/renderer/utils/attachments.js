/**
 * Classification of files dropped onto, or picked into, the chat composer.
 *
 * The chat used to accept images and nothing else, so a markdown file dragged
 * from the desktop was dropped on the floor without a word. What a file may
 * become is decided here, in one pure function, because the three entry points
 * that need the answer — the file picker, the drop handler and the paste
 * handler — must all agree, and because the routing rules are worth testing
 * without a DOM.
 *
 * Three destinations, each matching a content block the Claude Code binary
 * already understands:
 *
 *   'image' -> an `image` block, base64. Only the four media types the
 *              Messages API accepts; anything else is not an image to Claude.
 *   'pdf'   -> a `document` block, base64 `application/pdf`. This is the exact
 *              shape the binary itself builds when its Read tool opens a PDF.
 *   'text'  -> a plain `text` block carrying the file's contents, the same
 *              channel `@file` mentions have always used.
 *
 * Anything else (.docx, .xlsx, .zip, a binary) returns null: the Messages API
 * rejects binary formats in document blocks, and silently sending a mangled
 * UTF-8 decode of a zip container would be worse than saying no.
 */

/** Media types the Messages API accepts in an `image` block. */
const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * Extensions read as text. Deliberately broad — the cost of treating an odd
 * config file as text is a slightly noisy paste, while the cost of refusing it
 * is the bug this module exists to fix.
 */
const TEXT_EXTENSIONS = new Set([
  // Prose and docs
  'md', 'markdown', 'mdx', 'txt', 'text', 'rst', 'adoc', 'org', 'tex', 'bib',
  // Data and config
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'properties', 'csv', 'tsv', 'xml', 'plist', 'lock',
  // Web
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
  // Code
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'pyi', 'rb', 'go', 'rs', 'java',
  'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'php', 'swift', 'm', 'mm',
  'scala', 'lua', 'r', 'jl', 'dart', 'ex', 'exs', 'erl', 'hs', 'clj', 'cljs',
  'pl', 'pm', 'vim', 'el',
  // Shell and build
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'mk', 'gradle', 'cmake',
  // Infra
  'tf', 'tfvars', 'hcl', 'nix', 'service',
  // Query and schema
  'sql', 'graphql', 'gql', 'proto', 'prisma',
  // Diffs and subtitles
  'patch', 'diff', 'log', 'srt', 'vtt',
]);

/**
 * Extension-less filenames that are still text. Matched case-insensitively on
 * the whole name, since `Dockerfile` and `Makefile` carry no suffix at all.
 */
const TEXT_FILENAMES = new Set([
  'dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile', 'brewfile',
  'license', 'licence', 'readme', 'changelog', 'authors', 'contributors',
  'notice', 'codeowners', 'jenkinsfile', 'vagrantfile', 'caddyfile',
]);

/**
 * Media types that mean text even when the extension is unknown. The browser
 * leaves `File.type` empty for most of the extensions above, so this is a
 * fallback rather than the primary signal.
 */
const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_TYPES = new Set([
  'application/json', 'application/xml', 'application/xhtml+xml',
  'application/javascript', 'application/x-javascript', 'application/ecmascript',
  'application/yaml', 'application/x-yaml', 'application/toml',
  'application/sql', 'application/x-sh', 'application/graphql',
  'application/x-httpd-php',
]);

/** Ceiling for a base64 image block, matching what the composer accepted before. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Ceiling for a base64 PDF block. The Messages API caps the whole request at
 * 32 MB, and base64 inflates by a third, so a PDF past this point would risk
 * blowing the request open on its own. Larger ones are handed over as a path.
 */
const MAX_PDF_BYTES = 20 * 1024 * 1024;

/**
 * Past this size a text file is referenced by path instead of being inlined:
 * roughly 32k tokens of context, which is already a large share of a turn.
 * Beyond it the agent's Read tool does a better job than we would — it can
 * seek, page and skip, where an inlined blob can only sit there being paid for.
 */
const MAX_INLINE_TEXT_BYTES = 128 * 1024;

/** Lowercased extension without the dot, or '' when the name carries none. */
function extensionOf(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  // A leading dot means a dotfile (`.gitignore`), not an extension.
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** Lowercased filename with no directory part. */
function baseNameOf(name) {
  return String(name || '').split(/[\\/]/).pop().toLowerCase();
}

/**
 * What a file should become in the composer.
 *
 * @param {{ name?: string, type?: string }} file - a `File`, or anything
 *   carrying its `name` and MIME `type`.
 * @returns {'image'|'pdf'|'text'|null} null when the format cannot be sent.
 */
function classifyFile(file) {
  const name = file?.name || '';
  const type = (file?.type || '').toLowerCase();

  if (IMAGE_MIME_TYPES.includes(type)) return 'image';

  const ext = extensionOf(name);
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';

  // An image the browser failed to type, recovered from its extension. Kept
  // narrow: only the four the API accepts, so a .bmp still lands as null
  // rather than being sent as an image block the API would reject.
  if (ext === 'png') return 'image';
  if (ext === 'jpg' || ext === 'jpeg') return 'image';
  if (ext === 'gif') return 'image';
  if (ext === 'webp') return 'image';

  if (TEXT_EXTENSIONS.has(ext)) return 'text';

  const base = baseNameOf(name);
  if (TEXT_FILENAMES.has(base)) return 'text';
  // Dotfiles with no extension: .gitignore, .env, .npmrc, .editorconfig…
  if (base.startsWith('.') && !base.slice(1).includes('.')) return 'text';

  if (type) {
    if (TEXT_MIME_PREFIXES.some(p => type.startsWith(p))) return 'text';
    if (TEXT_MIME_TYPES.has(type)) return 'text';
  }

  return null;
}

/**
 * Should this text file be inlined, or handed over as a path for the Read tool?
 * A file with no path on disk (pasted, or produced in memory) has to be
 * inlined — there is nothing for Read to open.
 */
function shouldInlineText({ size = 0, path = '' } = {}) {
  if (!path) return true;
  return size <= MAX_INLINE_TEXT_BYTES;
}

/** Human-readable size, for chip labels and the "too large" notice. */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = {
  IMAGE_MIME_TYPES,
  TEXT_EXTENSIONS,
  TEXT_FILENAMES,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  MAX_INLINE_TEXT_BYTES,
  classifyFile,
  shouldInlineText,
  extensionOf,
  formatBytes,
};
