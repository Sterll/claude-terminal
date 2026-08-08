/**
 * TerminalOutputCapture
 *
 * Persists a rolling tail of each project's terminal output to
 * `~/.claude-terminal/terminals/output/<projectId>.log`.
 *
 * That path was already read by the MCP `terminal_read_output` tool and by the
 * `terminal` workflow node, but nothing ever wrote it — so both always came
 * back empty. This is the missing writer.
 *
 * Design constraints that shaped it:
 *   - Terminal output is high volume. Writes are buffered and flushed on a
 *     timer, never once per PTY chunk.
 *   - A build can emit megabytes. The file is capped and trimmed from the
 *     FRONT, because every reader wants the tail.
 *   - Readers are an LLM and a workflow. Raw ANSI colour and cursor control
 *     would be noise, so escape sequences are stripped and carriage-return
 *     overwrites (progress bars) are collapsed to their final state.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

/**
 * Resolved per call, not captured at require time. A module-level constant
 * would freeze whatever the home directory was when this file first loaded,
 * which makes the module untestable in isolation and is a latent footgun for
 * anything that relocates the data directory.
 */
function outputDir() {
  return path.join(os.homedir(), '.claude-terminal', 'terminals', 'output');
}

const FLUSH_INTERVAL   = 1000;          // ms between disk writes
const MAX_FILE_BYTES   = 256 * 1024;    // rolling tail kept per project
const MAX_BUFFER_CHARS = 512 * 1024;    // hard cap so a runaway PTY cannot grow memory

// projectId → pending text not yet written
const _buffers = new Map();
let _timer = null;

/**
 * Strip ANSI/VT control sequences and resolve carriage-return overwrites.
 *
 * A progress bar writes "10%\r20%\r30%" to repaint one line; keeping the raw
 * text would make the log read like three lines of nonsense. Only the final
 * state of each line is kept, which is what a reader actually wants.
 *
 * @param {string} text
 * @returns {string}
 */
function cleanOutput(text) {
  const stripped = String(text)
    // CSI sequences (colours, cursor movement, erase)
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    // OSC sequences (window title, hyperlinks), terminated by BEL or ST
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    // Remaining two-character escapes
    .replace(/\x1B[@-Z\\-_]/g, '')
    // Other C0 controls except tab, newline and carriage return
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Normalise real CRLF line endings FIRST. Doing the overwrite-collapse on
  // raw CRLF text would treat every Windows line ending as a repaint and keep
  // only the empty string after the \r — which is to say, it would erase
  // essentially all output on the platform this app targets.
  return stripped
    .replace(/\r\n/g, '\n')
    .split('\n')
    // A bare \r left over is a genuine same-line repaint (progress bars):
    // keep only what was painted last.
    .map(line => (line.includes('\r') ? line.split('\r').pop() : line))
    .join('\n');
}

function logFileFor(projectId) {
  return path.join(outputDir(), `${projectId}.log`);
}

/**
 * Append one project's buffered text, keeping the file under the size cap.
 * @param {string} projectId
 * @param {string} text
 */
function writeChunk(projectId, text) {
  const file = logFileFor(projectId);
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { /* first write */ }

  let merged = existing + text;
  if (Buffer.byteLength(merged, 'utf8') > MAX_FILE_BYTES) {
    // Trim from the front, then drop the partial first line so the log never
    // starts mid-sentence.
    merged = merged.slice(-MAX_FILE_BYTES);
    const nl = merged.indexOf('\n');
    if (nl > -1) merged = merged.slice(nl + 1);
  }
  fs.writeFileSync(file, merged, 'utf8');
}

/** Write every pending buffer to disk. Safe to call at any time. */
function flush() {
  if (!_buffers.size) return;

  try { fs.mkdirSync(outputDir(), { recursive: true }); }
  catch (e) {
    console.warn('[TerminalCapture] cannot create output dir:', e.message);
    _buffers.clear();
    return;
  }

  for (const [projectId, text] of _buffers) {
    if (!text) continue;
    try { writeChunk(projectId, text); }
    catch (e) { console.warn(`[TerminalCapture] write failed for ${projectId}:`, e.message); }
  }
  _buffers.clear();
}

/**
 * Record a chunk of terminal output for a project.
 *
 * No-ops when the terminal is not attached to a project — the log is keyed by
 * project, so there would be nowhere to file it.
 *
 * @param {string|null} projectId
 * @param {string} data raw PTY output
 */
function record(projectId, data) {
  if (!projectId || !data) return;

  const cleaned = cleanOutput(data);
  if (!cleaned) return;

  const current = _buffers.get(projectId) || '';
  const next = current + cleaned;
  // Drop the oldest half rather than growing without bound if flushing stalls.
  _buffers.set(projectId, next.length > MAX_BUFFER_CHARS ? next.slice(-MAX_BUFFER_CHARS / 2) : next);

  if (!_timer) {
    _timer = setTimeout(() => { _timer = null; flush(); }, FLUSH_INTERVAL);
    if (typeof _timer.unref === 'function') _timer.unref();
  }
}

/** Flush and stop the timer — call on app quit. */
function shutdown() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  flush();
}

/** Remove a project's captured log. */
function clear(projectId) {
  _buffers.delete(projectId);
  try { fs.unlinkSync(logFileFor(projectId)); } catch { /* nothing to remove */ }
}

module.exports = {
  record, flush, shutdown, clear, cleanOutput, logFileFor, outputDir,
  MAX_FILE_BYTES,
};
