/**
 * Reading a tool_result back out of the transcript.
 *
 * A result block carries either a string or an array of text parts, and its
 * payload may or may not be JSON — so both readers are best-effort by
 * contract and return null rather than throw.
 *
 * TaskCreate is the awkward one: it answers in prose, not JSON. The id it
 * hands back is the one every later TaskUpdate addresses, so failing to read
 * it files the task under its tool_use_id instead and freezes the progress
 * bar at 0/N.
 */

// Parse a tool_result content block into plain text.
function extractResultText(block) {
  if (!block) return '';
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content.map((b) => (b && (b.text || '')) || '').join('\n');
  }
  return '';
}

// Try to extract structured data from a tool_result text (best-effort).
function parseResultJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try { return JSON.parse(trimmed); } catch (_) { return null; }
}

// TaskCreate answers with a plain sentence — "Task #3 created successfully: <subject>" —
// not JSON. The id it hands back is the one every later TaskUpdate addresses, so failing
// to read it leaves the task filed under its tool_use_id and freezes the bar at 0/N.
const TASK_CREATED_RE = /task\s*#?\s*([A-Za-z0-9_-]+)\s+created/i;

/** @returns {string|null} The task id a TaskCreate result reports, JSON or prose. */
function parseCreatedTaskId(text) {
  const parsed = parseResultJson(text);
  const jsonId = parsed?.task?.id ?? parsed?.taskId ?? parsed?.id;
  if (jsonId != null) return String(jsonId);
  const match = TASK_CREATED_RE.exec(text || '');
  return match ? match[1] : null;
}

module.exports = { extractResultText, parseResultJson, parseCreatedTaskId };
