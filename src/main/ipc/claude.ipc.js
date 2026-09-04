/**
 * Claude IPC Handlers
 * Handles Claude Code session-related IPC communication
 */

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

/**
 * Encode project path to match Claude's folder naming convention.
 * Uses a broad [^a-zA-Z0-9] class (instead of the old 3-char class)
 * so that dots, spaces, and other special characters are replaced.
 * This fixes session lookup for projects
 * whose paths contain dots or other special chars (e.g. "ConfigHub.Server").
 *
 * @param {string} projectPath - The project path
 * @returns {string} - Encoded path for folder name
 */
function encodeProjectPath(projectPath) {
  const MAX_LEN = 200;
  const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= MAX_LEN) return encoded;
  // For paths exceeding 200 chars: truncate + append a simple hash
  // (mirrors Claude Code's hMK hash — DJB2-style string hash in base36)
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash + projectPath.charCodeAt(i)) | 0;
  }
  return `${encoded.slice(0, MAX_LEN)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Get the project sessions directory path
 * @param {string} projectPath - The project path
 * @returns {string} - Path to project sessions directory
 */
function getProjectSessionsDir(projectPath) {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const encodedPath = encodeProjectPath(projectPath);
  return path.join(claudeDir, encodedPath);
}

/**
 * Extract first user prompt from a .jsonl session file (reads only first few lines)
 * @param {string} filePath - Path to the .jsonl file
 * @returns {Promise<{firstPrompt: string, sessionId: string, isSidechain: boolean, gitBranch: string}>}
 */
async function extractSessionInfo(filePath) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let firstPrompt = '';
    let sessionId = '';
    let isSidechain = false;
    let gitBranch = '';
    let messageCount = 0;
    let linesRead = 0;
    const maxLines = 30; // Only read first 30 lines for speed

    rl.on('line', (line) => {
      linesRead++;
      try {
        const obj = JSON.parse(line);

        if (obj.type === 'user' || obj.type === 'assistant') {
          messageCount++;
        }

        // Extract info from first user message
        if (obj.type === 'user' && !firstPrompt) {
          sessionId = obj.sessionId || '';
          isSidechain = obj.isSidechain || false;
          gitBranch = obj.gitBranch || '';

          const content = obj.message?.content;
          if (typeof content === 'string') {
            firstPrompt = content;
          } else if (Array.isArray(content)) {
            const textBlock = content.find(b => b.type === 'text');
            if (textBlock) firstPrompt = textBlock.text;
          }
        }
      } catch (e) { /* skip malformed lines */ }

      if (linesRead >= maxLines) {
        rl.close();
        stream.destroy();
      }
    });

    rl.on('close', () => {
      resolve({ firstPrompt, sessionId, isSidechain, gitBranch, messageCount });
    });

    rl.on('error', () => {
      resolve({ firstPrompt: '', sessionId: '', isSidechain: false, gitBranch: '', messageCount: 0 });
    });
  });
}

// Claude Code appends `custom-title` (renamed by the user) and `ai-title`
// (generated) lines as the session goes, so the current title is near the END of
// the file. Reading forward to find it would mean streaming the whole transcript,
// which reaches 200 MB — so only the tail is read.
const TITLE_TAIL_BYTES = 128 * 1024;

/**
 * Read the session's current title and last activity from the tail of its JSONL file.
 * `lastActivity` is the timestamp of the last message line. File mtime is not
 * reliable for ordering: Claude Code keeps appending housekeeping lines
 * (titles, file-history snapshots…) well after the last real message, so an
 * idle session can look more recent than one the user just worked in.
 * @param {string} filePath
 * @param {number} size - File size in bytes (from a stat the caller already did)
 * @returns {Promise<{customTitle: string, aiTitle: string, lastActivity: string}>}
 */
async function readSessionTitle(filePath, size) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const length = Math.min(size, TITLE_TAIL_BYTES);
    const start = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);

    const lines = buffer.toString('utf8').split('\n');
    // The first line is cut in half unless the read started at the beginning
    if (start > 0) lines.shift();

    let customTitle = '';
    let aiTitle = '';
    let lastActivity = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      const isTitleLine = line.indexOf('-title"') !== -1;
      const mayHaveTimestamp = !lastActivity && line.indexOf('"timestamp"') !== -1;
      if (!isTitleLine && !mayHaveTimestamp) continue; // cheap pre-filter
      try {
        const obj = JSON.parse(line);
        if (!customTitle && obj.type === 'custom-title' && obj.customTitle) customTitle = obj.customTitle;
        else if (!aiTitle && obj.type === 'ai-title' && obj.aiTitle) aiTitle = obj.aiTitle;
        if (!lastActivity && obj.timestamp) lastActivity = obj.timestamp;
        if (customTitle && aiTitle && lastActivity) break;
      } catch { /* skip malformed lines */ }
    }
    return { customTitle, aiTitle, lastActivity };
  } catch {
    return { customTitle: '', aiTitle: '', lastActivity: '' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Get Claude sessions for a project by scanning .jsonl files directly
 * @param {string} projectPath - The project path
 * @returns {Promise<Array>} - Array of session objects
 */
// Opening the session list, the quick picker and an `@session` mention each ask
// for the same listing, and a listing stats every transcript in the project then
// reads the tail of the fifty it returns. Holding the result briefly collapses
// those bursts into one scan.
//
// A cached listing is only reused while the sessions directory has not been
// touched: its mtime moves when a transcript is created, renamed or deleted, so
// a session appearing from anywhere is picked up on the next call rather than up
// to a timeout later. The time bound is what covers appends to an existing
// transcript, which change the file but not the directory.
const SESSIONS_CACHE_MS = 5000;
const _sessionsCache = new Map(); // projectPath -> { at, dirMtimeMs, sessions }

/** Drop a project's cached listing, or every project's when called bare. */
function invalidateSessionsCache(projectPath) {
  if (projectPath) _sessionsCache.delete(projectPath);
  else _sessionsCache.clear();
}

/** mtime of the sessions directory, or null when it cannot be read. */
async function _sessionsDirMtime(sessionsDir) {
  try {
    return (await fs.promises.stat(sessionsDir)).mtimeMs;
  } catch {
    return null;
  }
}

async function getClaudeSessions(projectPath) {
  const sessionsDirForCache = getProjectSessionsDir(projectPath);
  const cached = _sessionsCache.get(projectPath);
  if (cached && Date.now() - cached.at < SESSIONS_CACHE_MS) {
    const mtime = await _sessionsDirMtime(sessionsDirForCache);
    if (mtime !== null && mtime === cached.dirMtimeMs) return cached.sessions;
  }

  try {
    const sessionsDir = sessionsDirForCache;

    let files;
    try {
      files = await fs.promises.readdir(sessionsDir);
    } catch {
      return [];
    }

    // Filter .jsonl files only
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

    if (jsonlFiles.length === 0) return [];

    // Get file stats and parse session info in parallel
    const sessionsPromises = jsonlFiles.map(async (file) => {
      const filePath = path.join(sessionsDir, file);
      try {
        const [stat, info] = await Promise.all([
          fs.promises.stat(filePath),
          extractSessionInfo(filePath)
        ]);

        // Skip sidechain sessions
        if (info.isSidechain) return null;

        // Skip files that are too small (empty/aborted sessions)
        if (stat.size < 200) return null;

        const sessionId = info.sessionId || file.replace('.jsonl', '');

        return {
          sessionId,
          summary: '',
          title: '',
          customTitle: '',
          aiTitle: '',
          firstPrompt: info.firstPrompt || '',
          messageCount: info.messageCount || 0,
          modified: stat.mtime.toISOString(),
          size: stat.size,
          filePath,
          gitBranch: info.gitBranch
        };
      } catch {
        return null;
      }
    });

    const allSessions = (await Promise.all(sessionsPromises)).filter(Boolean);

    // Try to enrich with summaries from sessions-index.json
    try {
      const indexPath = path.join(sessionsDir, 'sessions-index.json');
      const rawData = await fs.promises.readFile(indexPath, 'utf8');
      const data = JSON.parse(rawData);
      if (data.entries && Array.isArray(data.entries)) {
        const indexMap = new Map(data.entries.map(e => [e.sessionId, e]));
        for (const session of allSessions) {
          const indexed = indexMap.get(session.sessionId);
          if (indexed) {
            session.summary = indexed.summary || '';
            if (indexed.messageCount) session.messageCount = indexed.messageCount;
          }
        }
      }
    } catch { /* index may not exist or be stale, that's ok */ }

    // Pre-rank by mtime and read tails only for the head of that ranking: a
    // 128 KB tail read per file is wasted on sessions that can't make the cut.
    // The margin over 50 absorbs mtime drift (appends only push mtime forward,
    // so a session with recent real activity is always near the top by mtime).
    const candidates = allSessions
      .sort((a, b) => new Date(b.modified) - new Date(a.modified))
      .slice(0, 80);

    await Promise.all(candidates.map(async (session) => {
      const { customTitle, aiTitle, lastActivity } = await readSessionTitle(session.filePath, session.size);
      session.title = customTitle || aiTitle || '';
      session.customTitle = customTitle;
      session.aiTitle = aiTitle;
      // Order and time labels follow the conversation, not file housekeeping
      if (lastActivity) session.modified = lastActivity;
    }));

    // Final order by real last activity (most recent first), limit to 50
    const top = candidates
      .sort((a, b) => new Date(b.modified) - new Date(a.modified))
      .slice(0, 50);

    const sessions = top.map(({ size, filePath, ...session }) => session);
    _sessionsCache.set(projectPath, {
      at: Date.now(),
      dirMtimeMs: await _sessionsDirMtime(sessionsDir),
      sessions,
    });
    return sessions;
  } catch (error) {
    console.error('Error reading Claude sessions:', error);
    return [];
  }
}

// Replaying every message of a very long session melts both processes: the array
// crosses IPC by structured clone and then becomes one DOM node per entry. Sessions
// in the wild reach 70k lines / 200 MB, so only the tail is loaded by default and
// the UI asks for more on demand.
const DEFAULT_HISTORY_LIMIT = 400;

/**
 * Load conversation history from a session JSONL file.
 * Returns the last `limit` simplified messages for the chat UI replay.
 * @param {string} projectPath - The project path
 * @param {string} sessionId - The session ID (UUID)
 * @param {object} [options]
 * @param {number} [options.limit] - Max messages to return (tail). 0 = no limit.
 * @param {string} [options.until] - Stop reading after this message uuid (fork point).
 * @returns {Promise<{messages: Array, total: number, truncated: boolean}>}
 */
async function loadSessionHistory(projectPath, sessionId, options = {}) {
  const sessionsDir = getProjectSessionsDir(projectPath);
  const limit = options.limit === 0 ? 0 : (options.limit || DEFAULT_HISTORY_LIMIT);
  const until = options.until || null;

  // Find the JSONL file — uses indexed lookup
  const filePath = await resolveSessionFile(sessionsDir, sessionId);
  if (!filePath) return { messages: [], total: 0, truncated: false };

  // Read the JSONL file, keeping only a bounded window of messages in memory
  return new Promise((resolve) => {
    const messages = [];
    // Keep some slack above `limit` so the tail can be realigned onto a user-turn
    // boundary without re-reading the file.
    const maxKept = limit ? limit * 2 : Infinity;
    let total = 0;
    let dropped = 0;
    let done = false;
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const push = (msg) => {
      total++;
      messages.push(msg);
      if (messages.length > maxKept) {
        const excess = messages.length - limit;
        messages.splice(0, excess);
        dropped += excess;
      }
    };

    const finish = () => {
      if (done) return;
      done = true;
      rl.close();
      stream.destroy();
    };

    rl.on('line', (line) => {
      if (done) return;
      try {
        const obj = JSON.parse(line);

        // User message
        if (obj.type === 'user' && obj.message) {
          let text = '';
          const images = [];
          const content = obj.message.content;
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
            for (const block of content) {
              if (block.type === 'image' && block.source?.type === 'base64') {
                images.push({
                  base64: block.source.data,
                  mediaType: block.source.media_type || 'image/png'
                });
              }
            }
          }
          if (text || images.length > 0) {
            const msg = { role: 'user', text: text || '' };
            if (images.length > 0) msg.images = images;
            // Carried so a fork can name the turn it discards (resumeDropsTurn)
            if (obj.uuid) msg.uuid = obj.uuid;
            push(msg);
          }
        }

        // Assistant message
        if ((obj.type === 'assistant' || (!obj.type && obj.message?.role === 'assistant')) && obj.message?.content) {
          const blocks = obj.message.content;
          for (const block of blocks) {
            if (block.type === 'text' && block.text) {
              push({ role: 'assistant', type: 'text', text: block.text, ...(obj.uuid ? { uuid: obj.uuid } : {}) });
            } else if (block.type === 'tool_use') {
              push({
                role: 'assistant',
                type: 'tool_use',
                toolName: block.name,
                toolInput: block.input,
                toolUseId: block.id
              });
            } else if (block.type === 'thinking' && block.thinking) {
              push({ role: 'assistant', type: 'thinking', text: block.thinking });
            }
          }
        }

        // Tool result
        if (obj.type === 'tool_result' || (obj.message?.role === 'user' && Array.isArray(obj.message?.content))) {
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                const output = typeof block.content === 'string' ? block.content
                  : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('\n') : '';
                push({
                  role: 'tool_result',
                  toolUseId: block.tool_use_id,
                  output: output.slice(0, 2000) // Limit output size for IPC
                });
              }
            }
          }
        }

        // Fork point reached — everything after it is discarded by the fork anyway
        if (until && obj.uuid === until) finish();
      } catch { /* skip malformed lines */ }
    });

    rl.on('close', () => {
      // Realign the tail onto a user turn so the replay never opens mid tool-run
      // `dropped > 0` matters on its own: a trim leaves exactly `limit` entries, so a
      // file ending right on a trim boundary would otherwise skip the realignment and
      // open mid tool-run.
      let window = messages;
      if (limit && (messages.length > limit || dropped > 0)) {
        let start = Math.max(0, messages.length - limit);
        for (let i = start; i < messages.length; i++) {
          if (messages[i].role === 'user') { start = i; break; }
        }
        dropped += start;
        window = messages.slice(start);
      }
      resolve({ messages: window, total, truncated: dropped > 0 });
    });
    rl.on('error', () => resolve({ messages: [], total: 0, truncated: false }));
  });
}

/**
 * Read first N lines from a file
 */
async function readFirstLines(filePath, n) {
  return new Promise((resolve) => {
    const lines = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      lines.push(line);
      if (lines.length >= n) { rl.close(); stream.destroy(); }
    });
    rl.on('close', () => resolve(lines));
    rl.on('error', () => resolve([]));
  });
}

/**
 * Extract a human-readable file path from a tool's input object.
 * @param {string} toolName
 * @param {object} input
 * @returns {string|null}
 */
function extractFilePath(toolName, input) {
  if (!input) return null;
  // Direct file path keys
  if (input.file_path) return input.file_path;
  if (input.notebook_path) return input.notebook_path;
  if (input.path) return input.path;
  // Bash: try to find first path-like token in command
  if (toolName === 'Bash' && typeof input.command === 'string') {
    const match = input.command.match(/(?:^|\s)((?:\/|\.\.?\/|~\/|[A-Za-z]:\\)[^\s"']+)/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Truncate tool input for safe IPC transfer (prevents oversized payloads).
 * @param {object} input
 * @returns {object}
 */
function sanitizeToolInput(input) {
  if (!input) return {};
  const str = JSON.stringify(input);
  if (str.length > 2000) {
    return { _truncated: true, _preview: str.slice(0, 300) + '...' };
  }
  return input;
}

// The replay panel scrubs a whole session, but a session can hold tens of
// thousands of steps. Counters are computed over the entire file; only a window
// of steps is materialized and shipped to the renderer.
const DEFAULT_REPLAY_LIMIT = 2000;
// Tool results follow their call within a line or two, so this cap only matters
// for calls whose result never arrives (session cut mid-run).
const MAX_PENDING_TOOLS = 500;

/**
 * Parse a session JSONL file into a flat, ordered list of replay steps.
 * Each step is one of: prompt | tool | response | thinking
 * @param {string} projectPath
 * @param {string} sessionId
 * @param {object} [options]
 * @param {number} [options.offset] - Index of the first step to return
 * @param {number} [options.limit] - Max steps to return. 0 = no limit.
 * @returns {Promise<{steps: Array, summary: object}>}
 */
async function parseSessionReplay(projectPath, sessionId, options = {}) {
  const sessionsDir = getProjectSessionsDir(projectPath);
  const offset = Math.max(0, options.offset || 0);
  const limit = options.limit === 0 ? 0 : (options.limit || DEFAULT_REPLAY_LIMIT);

  const emptySummary = () => ({
    totalSteps: 0, totalEstimatedTokens: 0, uniqueFileCount: 0,
    toolBreakdown: {}, offset, returned: 0, truncated: false
  });

  // Find the JSONL file — uses indexed lookup
  const filePath = await resolveSessionFile(sessionsDir, sessionId);
  if (!filePath) return { steps: [], summary: emptySummary() };

  // Single streaming pass: summary counters cover the whole file, but only the
  // requested window of steps is materialized. Buffering the raw lines first
  // retained 546 MB of heap on a 207 MB session before parsing even started.
  return new Promise((resolve) => {
    const steps = [];
    // Map toolUseId -> step object, so a later tool_result can be attached to it.
    // Holds out-of-window steps too, so their output still counts toward the summary.
    const pendingTools = new Map();
    const uniqueFiles = new Set();
    const toolBreakdown = {};
    let totalSteps = 0;
    let totalEstimatedTokens = 0;

    /** True when the step at this global index belongs to the requested window. */
    function keeps(index) {
      return limit === 0 || (index >= offset && steps.length < limit);
    }

    /** Count a text-ish step, and materialize it only if it is in the window. */
    function addTextStep(type, text, maxLen) {
      const index = totalSteps++;
      const tokens = Math.ceil(text.length / 4);
      totalEstimatedTokens += tokens;
      if (!keeps(index)) return;
      steps.push({ index, type, text: text.slice(0, maxLen), estimatedTokens: tokens });
    }

    function trackPendingTool(id, step) {
      if (id === undefined || id === null) return;
      pendingTools.set(id, step);
      // Results follow their call almost immediately; this only bounds the map
      // when a session was cut mid-call and a result never arrives.
      if (pendingTools.size > MAX_PENDING_TOOLS) {
        pendingTools.delete(pendingTools.keys().next().value);
      }
    }

    function attachToolResult(block) {
      const pending = pendingTools.get(block.tool_use_id);
      if (!pending) return;
      const out = typeof block.content === 'string' ? block.content
        : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('\n') : '';
      pending.toolOutput = out.slice(0, 3000);
      pending.estimatedOutputTokens = Math.ceil(out.length / 4);
      totalEstimatedTokens += pending.estimatedOutputTokens;
      pendingTools.delete(block.tool_use_id);
    }

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);

        // ── User message ────────────────────────────────────────────────────
        if (obj.type === 'user' && obj.message) {
          const content = obj.message.content;
          if (typeof content === 'string') {
            if (content.trim()) addTextStep('prompt', content, 5000);
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') attachToolResult(block);
            }
            // Any plain text blocks are user prompts (rare but possible)
            const textBlocks = content.filter(b => b.type === 'text');
            if (textBlocks.length > 0) {
              const text = textBlocks.map(b => b.text).join('\n');
              if (text.trim()) addTextStep('prompt', text, 5000);
            }
          }
        }

        // ── Assistant message ───────────────────────────────────────────────
        if ((obj.type === 'assistant' || (!obj.type && obj.message?.role === 'assistant')) && obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type === 'text' && block.text && block.text.trim()) {
              addTextStep('response', block.text, 5000);
            } else if (block.type === 'tool_use') {
              const index = totalSteps++;
              const fp = extractFilePath(block.name, block.input);
              const inputStr = JSON.stringify(block.input || {});
              const estimatedInputTokens = Math.ceil(inputStr.length / 4);
              totalEstimatedTokens += estimatedInputTokens;
              toolBreakdown[block.name] = (toolBreakdown[block.name] || 0) + 1;
              if (fp) uniqueFiles.add(fp);
              // Built even out of window: its result still feeds the token total,
              // and pendingTools is the only thing holding it.
              const step = {
                index, type: 'tool',
                toolName: block.name,
                toolInput: sanitizeToolInput(block.input),
                toolOutput: null,
                filePath: fp,
                estimatedInputTokens,
                estimatedOutputTokens: 0
              };
              if (keeps(index)) steps.push(step);
              trackPendingTool(block.id, step);
            } else if (block.type === 'thinking' && block.thinking) {
              addTextStep('thinking', block.thinking, 3000);
            }
          }
        }

        // ── Standalone tool_result (alternate JSONL format) ─────────────────
        if (obj.type === 'tool_result' && obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type === 'tool_result') attachToolResult(block);
          }
        }
      } catch { /* skip malformed lines */ }
    });

    rl.on('close', () => resolve({
      steps,
      summary: {
        totalSteps,
        totalEstimatedTokens,
        uniqueFileCount: uniqueFiles.size,
        toolBreakdown,
        offset,
        returned: steps.length,
        truncated: limit > 0 && steps.length < totalSteps
      }
    }));
    rl.on('error', () => resolve({ steps: [], summary: emptySummary() }));
  });
}

// ─── Session index cache ────────────────────────────────────────────────────
// Maps sessionId -> filePath, built per sessions directory on first scan.
// Avoids O(N) sequential file reads on every session lookup.
const _sessionIndex = new Map(); // sessionId -> filePath
const _indexedDirs = new Set();  // directories already indexed

async function buildSessionIndex(sessionsDir) {
  if (_indexedDirs.has(sessionsDir)) return;
  try {
    const files = await fs.promises.readdir(sessionsDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    await Promise.all(jsonlFiles.map(async f => {
      const filePath = path.join(sessionsDir, f);
      try {
        const head = await readFirstLines(filePath, 5);
        for (const line of head) {
          try {
            const obj = JSON.parse(line);
            if (obj.sessionId) {
              _sessionIndex.set(obj.sessionId, filePath);
              break;
            }
          } catch { /* skip malformed */ }
        }
      } catch { /* skip unreadable */ }
    }));
    _indexedDirs.add(sessionsDir);
  } catch { /* dir not found */ }
}

/**
 * Resolve the .jsonl file path for a given sessionId.
 * Tries sessionId.jsonl first, then uses an in-memory index (built on first scan).
 * If not found in the index, rebuilds it once (handles newly created sessions).
 * @param {string} sessionsDir
 * @param {string} sessionId
 * @returns {Promise<string|null>}
 */
async function resolveSessionFile(sessionsDir, sessionId) {
  // Try direct path first
  const direct = path.join(sessionsDir, `${sessionId}.jsonl`);
  try {
    await fs.promises.access(direct);
    return direct;
  } catch { /* not found by name */ }

  // Try index
  await buildSessionIndex(sessionsDir);
  const cached = _sessionIndex.get(sessionId);
  if (cached) return cached;

  // Not found — invalidate and rebuild once (session may be new)
  _indexedDirs.delete(sessionsDir);
  await buildSessionIndex(sessionsDir);
  return _sessionIndex.get(sessionId) || null;
}

/**
 * Delete a session .jsonl file
 * @param {string} projectPath
 * @param {string} sessionId
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteSession(projectPath, sessionId) {
  const sessionsDir = getProjectSessionsDir(projectPath);
  const filePath = await resolveSessionFile(sessionsDir, sessionId);
  if (!filePath) {
    return { success: false, error: 'Session file not found' };
  }
  await fs.promises.unlink(filePath);
  invalidateSessionsCache(projectPath);
  return { success: true };
}

// ─── Moving a session between projects ──────────────────────────────────────
//
// Claude Code files a session under the directory encoding of the cwd it was
// started in, and finds it again by encoding the cwd it is launched with. The
// runtime cwd comes from the spawn (TerminalService passes `cwd: project.path`
// alongside `--resume <id>`), NOT from the transcript — so re-filing the
// transcript is enough to make a session resumable from another project, and
// the `cwd` recorded on each line is left alone as the historical record it is.
//
// A session is not one file: `<uuid>.jsonl` usually has a sibling `<uuid>/`
// directory holding subagent transcripts, workflow scripts and tool results.
// Both move together.

/** Byte size of a file. */
async function fileSize(filePath) {
  return (await fs.promises.stat(filePath)).size;
}

/** True when the path exists. */
async function exists(target) {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively move a directory. Falls back to copy+remove across devices, and
 * also when the target already exists: a session that ran in the target project
 * too has left a sidecar there, and both sets of files belong to that same
 * session, so they are merged rather than refused.
 */
async function moveDirectory(from, to) {
  if (!(await exists(to))) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
    }
  }
  await fs.promises.cp(from, to, { recursive: true, force: true });
  await fs.promises.rm(from, { recursive: true, force: true });
}

/**
 * Put a moved sidecar back where it came from.
 * When the target already held one the two were merged, and merged files cannot
 * be told apart again — the sidecar then stays put and the caller says so.
 * @returns {Promise<boolean>} true when the source sidecar was restored
 */
async function rollbackSidecar(sourceSidecar, targetSidecar, targetSidecarPreexisted) {
  if (targetSidecarPreexisted) return false;
  try {
    await moveDirectory(targetSidecar, sourceSidecar);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a session's transcript (and its sidecar directory) to another project.
 *
 * Copies before deleting rather than renaming: the two directories can sit on
 * different volumes, and a half-finished rename would lose the transcript.
 * Nothing is published in the target until the sidecar is across, and anything
 * already published is undone if a later step fails.
 *
 * @param {string} sessionId
 * @param {string} fromProjectPath
 * @param {string} toProjectPath
 * @returns {Promise<{success: boolean, error?: string, code?: string, movedSidecar?: boolean, warnings?: string[]}>}
 */
async function moveSession(sessionId, fromProjectPath, toProjectPath) {
  if (!sessionId || !fromProjectPath || !toProjectPath) {
    return { success: false, code: 'bad-request', error: 'sessionId, fromProjectPath and toProjectPath are required' };
  }

  const fromDir = getProjectSessionsDir(fromProjectPath);
  const toDir = getProjectSessionsDir(toProjectPath);
  if (fromDir === toDir) {
    return { success: false, code: 'same-project', error: 'Source and target project are the same' };
  }

  const sourceFile = await resolveSessionFile(fromDir, sessionId);
  if (!sourceFile) {
    return { success: false, code: 'not-found', error: 'Session file not found' };
  }

  const fileName = path.basename(sourceFile);
  const targetFile = path.join(toDir, fileName);
  try {
    await fs.promises.access(targetFile);
    return { success: false, code: 'collision', error: 'A session with this id already exists in the target project' };
  } catch { /* free, as expected */ }

  await fs.promises.mkdir(toDir, { recursive: true });

  const warnings = [];
  const tempFile = `${targetFile}.moving`;
  const sourceSidecar = path.join(fromDir, sessionId);
  const targetSidecar = path.join(toDir, sessionId);
  let movedSidecar = false;
  // The target may already hold a sidecar from a run that happened there. If it
  // does, a rollback must not touch it — those files predate this move.
  const targetSidecarPreexisted = await exists(targetSidecar);
  let published = false;

  try {
    // Claude Code appends to the transcript of a live session. Comparing the
    // size on both sides of the copy catches that, and a stat costs nothing
    // next to reading a file that can reach 200 MB.
    const sizeBefore = await fileSize(sourceFile);
    await fs.promises.copyFile(sourceFile, tempFile);
    const sizeAfter = await fileSize(sourceFile);
    if (sizeBefore !== sizeAfter) {
      await fs.promises.rm(tempFile, { force: true });
      return { success: false, code: 'session-live', error: 'The session was written to while copying — close it and try again' };
    }

    const copiedSize = await fileSize(tempFile);
    if (copiedSize !== sizeBefore) {
      await fs.promises.rm(tempFile, { force: true });
      return { success: false, code: 'verify-failed', error: `Copy is incomplete (${copiedSize}/${sizeBefore} bytes)` };
    }

    // Sidecar first: subagent transcripts, workflow scripts, tool results. It is
    // the one step that is not atomic, so it runs while nothing is published yet
    // and a failure can still abort cleanly.
    let hasSidecar = false;
    try {
      hasSidecar = (await fs.promises.stat(sourceSidecar)).isDirectory();
    } catch { /* no sidecar, which is normal for short sessions */ }
    if (hasSidecar) {
      await moveDirectory(sourceSidecar, targetSidecar);
      movedSidecar = true;
    }

    // Re-check: the first look happened before the copy, which is not instant
    if (await exists(targetFile)) {
      await fs.promises.rm(tempFile, { force: true });
      if (movedSidecar) await rollbackSidecar(sourceSidecar, targetSidecar, targetSidecarPreexisted);
      return { success: false, code: 'collision', error: 'A session with this id already exists in the target project' };
    }

    await fs.promises.rename(tempFile, targetFile);
    published = true;

    // Only now is the source expendable
    await fs.promises.unlink(sourceFile);
  } catch (err) {
    // Undo what was already published: without this a failing unlink would
    // leave the session sitting in both projects at once.
    await fs.promises.rm(tempFile, { force: true }).catch(() => {});
    if (published) await fs.promises.rm(targetFile, { force: true }).catch(() => {});
    if (movedSidecar) {
      const restored = await rollbackSidecar(sourceSidecar, targetSidecar, targetSidecarPreexisted);
      if (!restored) warnings.push('sidecar-not-restored');
    }
    return { success: false, code: 'io-error', error: err.message, warnings };
  }

  // resolveSessionFile memoizes sessionId -> filePath per directory
  _sessionIndex.delete(sessionId);
  _indexedDirs.delete(fromDir);
  _indexedDirs.delete(toDir);
  // Both listings changed, and the move is exactly when the user looks at them
  invalidateSessionsCache(fromProjectPath);
  invalidateSessionsCache(toProjectPath);

  // A session that ran across several worktrees leaves sidecars in each of
  // those projects. They belong to the runs that happened there, so they stay.
  const strays = await findStraySidecars(sessionId, [fromDir, toDir]);
  if (strays.length > 0) {
    warnings.push(`left-sidecars:${strays.length}`);
  }

  return { success: true, movedSidecar, warnings, targetFile };
}

/**
 * Sidecar directories for this session sitting under other projects.
 * @param {string} sessionId
 * @param {string[]} ignoredDirs
 * @returns {Promise<string[]>}
 */
async function findStraySidecars(sessionId, ignoredDirs = []) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const ignored = new Set(ignoredDirs);
  let entries;
  try {
    entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return null;
    const dir = path.join(projectsDir, entry.name);
    if (ignored.has(dir)) return null;
    const sidecar = path.join(dir, sessionId);
    try {
      const stat = await fs.promises.stat(sidecar);
      return stat.isDirectory() ? sidecar : null;
    } catch {
      return null;
    }
  }));
  return found.filter(Boolean);
}

/**
 * Export a session as Markdown or JSON
 * @param {string} projectPath
 * @param {string} sessionId
 * @param {'markdown'|'json'} format
 * @returns {Promise<{success: boolean, content?: string, error?: string}>}
 */
async function exportSession(projectPath, sessionId, format) {
  const { steps, summary } = await parseSessionReplay(projectPath, sessionId);

  if (format === 'json') {
    return { success: true, content: JSON.stringify({ sessionId, summary, steps }, null, 2) };
  }

  // Markdown format
  const lines = [];
  lines.push(`# Session Replay: ${sessionId}`);
  lines.push('');
  lines.push(`- **Steps:** ${summary.totalSteps}`);
  lines.push(`- **Estimated tokens:** ~${summary.totalEstimatedTokens}`);
  lines.push(`- **Files touched:** ${summary.uniqueFileCount}`);
  if (summary.toolBreakdown) {
    const tools = Object.entries(summary.toolBreakdown).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c})`).join(', ');
    lines.push(`- **Tools:** ${tools}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const step of steps) {
    if (step.type === 'prompt') {
      lines.push(`## User Prompt`);
      lines.push('');
      lines.push(`> ${step.text.replace(/\n/g, '\n> ')}`);
      lines.push('');
    } else if (step.type === 'response') {
      lines.push(`## Assistant Response`);
      lines.push('');
      lines.push(step.text);
      lines.push('');
    } else if (step.type === 'thinking') {
      lines.push(`<details><summary>Thinking</summary>`);
      lines.push('');
      lines.push(step.text);
      lines.push('');
      lines.push('</details>');
      lines.push('');
    } else if (step.type === 'tool') {
      lines.push(`### Tool: ${step.toolName}${step.filePath ? ` — \`${step.filePath}\`` : ''}`);
      lines.push('');
      if (step.toolInput && !step.toolInput._truncated) {
        lines.push('```json');
        lines.push(JSON.stringify(step.toolInput, null, 2));
        lines.push('```');
      }
      if (step.toolOutput) {
        lines.push('');
        lines.push('<details><summary>Output</summary>');
        lines.push('');
        lines.push('```');
        lines.push(step.toolOutput);
        lines.push('```');
        lines.push('');
        lines.push('</details>');
      }
      lines.push('');
    }
  }

  return { success: true, content: lines.join('\n') };
}

/**
 * Register Claude IPC handlers
 */
function registerClaudeHandlers() {
  // Get Claude sessions for a project
  ipcMain.handle('claude-sessions', async (event, projectPath) => {
    return getClaudeSessions(projectPath);
  });

  // Load full session history for chat UI replay
  ipcMain.handle('chat-load-history', async (event, { projectPath, sessionId, limit, until }) => {
    try {
      const { messages, total, truncated } = await loadSessionHistory(projectPath, sessionId, { limit, until });
      return { success: true, messages, total, truncated };
    } catch (err) {
      console.error('[chat-load-history] Error:', err.message);
      return { success: false, error: err.message, messages: [], total: 0, truncated: false };
    }
  });

  // Parse a session JSONL into ordered replay steps for the Session Replay panel
  ipcMain.handle('claude-session-replay', async (event, { projectPath, sessionId, offset, limit }) => {
    try {
      return { success: true, ...(await parseSessionReplay(projectPath, sessionId, { offset, limit })) };
    } catch (err) {
      console.error('[claude-session-replay] Error:', err.message);
      return { success: false, error: err.message, steps: [], summary: {} };
    }
  });

  // Delete a session .jsonl file
  ipcMain.handle('claude-delete-session', async (event, { projectPath, sessionId }) => {
    try {
      return await deleteSession(projectPath, sessionId);
    } catch (err) {
      console.error('[claude-delete-session] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Move a session (transcript + sidecar) to another project
  ipcMain.handle('claude-move-session', async (event, { sessionId, fromProjectPath, toProjectPath }) => {
    try {
      return await moveSession(sessionId, fromProjectPath, toProjectPath);
    } catch (err) {
      console.error('[claude-move-session] Error:', err.message);
      return { success: false, code: 'io-error', error: err.message };
    }
  });

  // Export a session as Markdown or JSON
  ipcMain.handle('claude-export-session', async (event, { projectPath, sessionId, format }) => {
    try {
      return await exportSession(projectPath, sessionId, format || 'markdown');
    } catch (err) {
      console.error('[claude-export-session] Error:', err.message);
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerClaudeHandlers, getClaudeSessions, loadSessionHistory, parseSessionReplay, moveSession, findStraySidecars, readSessionTitle, invalidateSessionsCache };
