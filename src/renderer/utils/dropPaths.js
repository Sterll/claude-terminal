/**
 * Parse a text/plain drop payload (newline-separated absolute paths).
 * Used by ChatView to accept files dragged from the internal FileExplorer.
 *
 * @param {string} text - Raw text/plain payload from DataTransfer
 * @param {object} deps - { fs, path, projectRoot? }
 * @returns {{ files: {path:string, fullPath:string}[], missing: string[], directories: string[] } | null}
 *   null when the payload does not look like a list of absolute paths.
 */
function parseDroppedPathsPayload(text, { fs, path, projectRoot = '' } = {}) {
  const rawPaths = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!rawPaths.length) return null;
  const looksLikePath = rawPaths.every(p => /^([a-zA-Z]:[\\/]|[\\/])/.test(p));
  if (!looksLikePath) return null;

  const files = [];
  const missing = [];
  const directories = [];
  for (const rawPath of rawPaths) {
    const absPath = path.normalize(rawPath);
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch (err) {
      missing.push(rawPath);
      continue;
    }
    if (stat.isDirectory()) {
      directories.push(absPath);
      continue;
    }
    let relPath = projectRoot ? path.relative(projectRoot, absPath) : absPath;
    if (!relPath || relPath.startsWith('..')) relPath = absPath;
    relPath = relPath.replace(/\\/g, '/');
    files.push({ path: relPath, fullPath: absPath });
  }
  return { files, missing, directories };
}

module.exports = { parseDroppedPathsPayload };
