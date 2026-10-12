'use strict';
/**
 * Where a Claude session actually worked, read back from its transcript.
 *
 * A session rarely stays in the folder it was opened in: it enters worktrees
 * and edits files there, and opens pull requests from them. The Git tab used
 * to read the project folder's branch, so every session of a project showed
 * the same branch and the same pull request, whatever it had worked on.
 *
 * Only fields the transcript already structures are read:
 *  - the `cwd` of every entry, which follows `EnterWorktree`;
 *  - the worktree `EnterWorktree` reports it entered;
 *  - the files `Edit` / `Write` / `MultiEdit` / `NotebookEdit` touched, and their folders;
 *  - the pull request URL `gh pr create` printed on a line of its own.
 * A URL merely appearing in some output (a test fixture, release notes) is not
 * a pull request of the session: a real transcript had 18 of them for the 2
 * actually opened.
 *
 * Read incrementally: the file only grows, so each call reads the bytes added
 * since the last one. Claude Code moves the whole file when the session's cwd
 * changes directory, so a file that vanished is looked up again.
 */

const fsp = require('fs').promises;
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { listProjectSessionDirs } = require('../../shared/session-dirs');

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const CHUNK_BYTES = 1 << 20;
const MAX_PENDING = 200;
const MAX_PRS = 50;
const MAX_EDITS = 500;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PR_URL_LINE = /^\s*https:\/\/([^/\s]+)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\s*$/;
// "Entered worktree at <path> on branch <branch>. …": the path may hold spaces
// and be a Windows one; a branch may hold dots (release/1.2).
const ENTERED = /Entered worktree at (.+?)(?: on branch (\S+?))?\.(?:\s|$)/;

function createActivity() {
  return { dirs: new Map(), prs: new Map(), pending: new Map(), branches: new Map(), edits: new Map() };
}

function note(activity, dir, kind, at) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return;
  const key = path.normalize(dir).replace(/[\\/]+$/, '') || path.sep;
  const entry = activity.dirs.get(key) || { at: 0, kinds: new Set() };
  entry.at = Math.max(entry.at, at);
  entry.kinds.add(kind);
  activity.dirs.set(key, entry);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
}

/** One parsed transcript entry. */
function readEntry(activity, entry) {
  if (!entry || typeof entry !== 'object') return;
  const at = Date.parse(entry.timestamp) || 0;
  if (typeof entry.cwd === 'string') note(activity, entry.cwd, 'cwd', at);
  const content = entry.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block?.type === 'tool_use') {
      const input = block.input || {};
      if (EDIT_TOOLS.has(block.name)) {
        const file = input.file_path || input.notebook_path;
        if (typeof file === 'string' && path.isAbsolute(file)) {
          note(activity, path.dirname(file), 'edit', at);
          // The files themselves too: a note written in the project folder is
          // not work on its branch, and only git can tell the two apart.
          const key = path.normalize(file);
          activity.edits.delete(key);
          activity.edits.set(key, at);
          if (activity.edits.size > MAX_EDITS) activity.edits.delete(activity.edits.keys().next().value);
        }
      } else if (block.name === 'EnterWorktree'
        || (block.name === 'Bash' && String(input.command || '').includes('gh pr create'))) {
        activity.pending.set(block.id, { name: block.name, input, at });
        if (activity.pending.size > MAX_PENDING) activity.pending.delete(activity.pending.keys().next().value);
      }
    } else if (block?.type === 'tool_result') {
      const use = activity.pending.get(block.tool_use_id);
      if (!use) continue;
      activity.pending.delete(block.tool_use_id);
      if (block.is_error) continue;
      const text = textOf(block.content);
      if (use.name === 'EnterWorktree') {
        const m = ENTERED.exec(text);
        const dir = m?.[1] || use.input.path;
        note(activity, dir, 'enter', use.at);
        // Kept for when the worktree is gone: its branch still names a pull request.
        if (m?.[2] && typeof dir === 'string') activity.branches.set(path.normalize(dir).replace(/[\\/]+$/, ''), m[2]);
      } else {
        for (const line of text.split('\n')) {
          const m = PR_URL_LINE.exec(line);
          if (!m || activity.prs.size >= MAX_PRS) continue;
          const [, host, owner, repo, number] = m;
          const key = `${host}/${owner}/${repo}#${number}`.toLowerCase();
          if (!activity.prs.has(key)) activity.prs.set(key, { host, owner, repo, number: Number(number), url: line.trim(), at: use.at });
        }
      }
    }
  }
}

/** Plain data for the caller: directories newest first, pull requests in order. */
function summarize(activity) {
  return {
    dirs: [...activity.dirs.entries()]
      .map(([dir, e]) => ({ dir, at: e.at, kinds: [...e.kinds], branch: activity.branches.get(dir) || null }))
      .sort((a, b) => b.at - a.at),
    prs: [...activity.prs.values()],
    edits: [...activity.edits.entries()].map(([file, at]) => ({ file, at })).reverse(),
  };
}

/**
 * @param {object} [deps]
 * @param {(projectPath: string) => Array<{ dir: string }>} [deps.dirsFor] where the project's transcripts live
 */
function createSessionActivityService({ dirsFor = listProjectSessionDirs } = {}) {
  const cache = new Map(); // sessionId → { file, offset, rest, activity }

  async function locate(projectPath, sessionId) {
    for (const { dir } of dirsFor(projectPath)) {
      const file = path.join(dir, `${sessionId}.jsonl`);
      try {
        await fsp.access(file);
        return file;
      } catch {
        // not filed here
      }
    }
    return null;
  }

  async function size(file) {
    try {
      return (await fsp.stat(file)).size;
    } catch {
      return null;
    }
  }

  /**
   * What the session did, or null when it has no transcript yet (a tab the
   * CLI has not named, a session from another machine).
   * @param {string} projectPath
   * @param {string} sessionId the CLI session id
   */
  async function read(projectPath, sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || typeof projectPath !== 'string') return null;
    const fresh = (file) => ({ file, offset: 0, rest: '', decoder: new StringDecoder('utf8'), activity: createActivity() });
    let state = cache.get(sessionId);
    let bytes = state ? await size(state.file) : null;
    if (bytes === null) {
      // First read, or the file moved with the session's cwd: read it whole.
      const file = await locate(projectPath, sessionId);
      if (!file) return null;
      bytes = await size(file);
      if (bytes === null) return null;
      state = fresh(file);
    } else if (bytes < state.offset) {
      state = fresh(state.file);
    }

    if (bytes > state.offset) {
      const handle = await fsp.open(state.file, 'r');
      try {
        const buffer = Buffer.alloc(CHUNK_BYTES);
        while (state.offset < bytes) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, bytes - state.offset), state.offset);
          if (!bytesRead) break;
          state.offset += bytesRead;
          // The decoder holds a character split across two reads.
          const lines = (state.rest + state.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
          state.rest = lines.pop();
          for (const line of lines) {
            if (!line) continue;
            try {
              readEntry(state.activity, JSON.parse(line));
            } catch {
              // a line being written, or not JSON: skipped
            }
          }
        }
      } finally {
        await handle.close();
      }
    }
    cache.set(sessionId, state);
    return summarize(state.activity);
  }

  return { read, _reset: () => cache.clear() };
}

let instance = null;
function service() {
  if (!instance) instance = createSessionActivityService();
  return instance;
}

module.exports = {
  createSessionActivityService,
  read: (projectPath, sessionId) => service().read(projectPath, sessionId),
  _internals: { createActivity, readEntry, summarize },
};
