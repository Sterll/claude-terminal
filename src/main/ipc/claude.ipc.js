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

/**
 * Get Claude sessions for a project by scanning .jsonl files directly
 * @param {string} projectPath - The project path
 * @returns {Promise<Array>} - Array of session objects
 */
async function getClaudeSessions(projectPath) {
  try {
    const sessionsDir = getProjectSessionsDir(projectPath);

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
          firstPrompt: info.firstPrompt || '',
          messageCount: info.messageCount || 0,
          modified: stat.mtime.toISOString(),
          size: stat.size,
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

    // Sort by modified date (most recent first) and limit to 50
    return allSessions
      .sort((a, b) => new Date(b.modified) - new Date(a.modified))
      .slice(0, 50)
      .map(({ size, ...session }) => session);
  } catch (error) {
    console.error('Error reading Claude sessions:', error);
    return [];
  }
}

/**
 * Load full conversation history from a session JSONL file.
 * Returns an array of simplified messages for the chat UI replay.
 * @param {string} projectPath - The project path
 * @param {string} sessionId - The session ID (UUID)
 * @returns {Promise<Array>} - Array of { role, type, content, toolName, toolInput, toolOutput, thinking, ... }
 */
async function loadSessionHistory(projectPath, sessionId) {
  const sessionsDir = getProjectSessionsDir(projectPath);

  // Find the JSONL file — could be sessionId.jsonl or another file containing this sessionId
  let filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
  try {
    await fs.promises.access(filePath);
  } catch {
    // Session file not found — scan directory for matching sessionId
    try {
      const files = await fs.promises.readdir(sessionsDir);
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
      for (const f of jsonlFiles) {
        const candidate = path.join(sessionsDir, f);
        const head = await readFirstLines(candidate, 5);
        for (const line of head) {
          try {
            const obj = JSON.parse(line);
            if (obj.sessionId === sessionId) {
              filePath = candidate;
              break;
            }
          } catch (_) {
            // Malformed JSON line — skip
          }
        }
      }
    } catch (e) {
      console.warn('[claude.ipc] Failed to scan sessions directory:', e);
      return [];
    }
  }

  // Read all lines from the JSONL file
  return new Promise((resolve) => {
    const messages = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line);

        // User message
        if (obj.type === 'user' && obj.message) {
          let text = '';
          const content = obj.message.content;
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          }
          if (text) {
            messages.push({ role: 'user', text });
          }
        }

        // Assistant message
        if ((obj.type === 'assistant' || (!obj.type && obj.message?.role === 'assistant')) && obj.message?.content) {
          const blocks = obj.message.content;
          for (const block of blocks) {
            if (block.type === 'text' && block.text) {
              messages.push({ role: 'assistant', type: 'text', text: block.text, ...(obj.uuid ? { uuid: obj.uuid } : {}) });
            } else if (block.type === 'tool_use') {
              messages.push({
                role: 'assistant',
                type: 'tool_use',
                toolName: block.name,
                toolInput: block.input,
                toolUseId: block.id
              });
            } else if (block.type === 'thinking' && block.thinking) {
              messages.push({ role: 'assistant', type: 'thinking', text: block.thinking });
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
                messages.push({
                  role: 'tool_result',
                  toolUseId: block.tool_use_id,
                  output: output.slice(0, 2000) // Limit output size for IPC
                });
              }
            }
          }
        }
      } catch { /* skip malformed lines */ }
    });

    rl.on('close', () => resolve(messages));
    rl.on('error', () => resolve([]));
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

/**
 * Parse a session JSONL file into a flat, ordered list of replay steps.
 * Each step is one of: prompt | tool | response | thinking
 * @param {string} projectPath
 * @param {string} sessionId
 * @returns {Promise<{steps: Array, summary: object}>}
 */
async function parseSessionReplay(projectPath, sessionId) {
  const sessionsDir = getProjectSessionsDir(projectPath);
  let filePath = path.join(sessionsDir, `${sessionId}.jsonl`);

  // Try to find the JSONL file (filename may differ from sessionId)
  try {
    await fs.promises.access(filePath);
  } catch {
    try {
      const files = await fs.promises.readdir(sessionsDir);
      for (const f of files.filter(f => f.endsWith('.jsonl'))) {
        const candidate = path.join(sessionsDir, f);
        const head = await readFirstLines(candidate, 5);
        let found = false;
        for (const line of head) {
          try {
            const obj = JSON.parse(line);
            if (obj.sessionId === sessionId) { filePath = candidate; found = true; break; }
          } catch (_) { /* skip */ }
        }
        if (found) break;
      }
    } catch (e) {
      console.warn('[claude-session-replay] Failed to scan sessions dir:', e);
    }
  }

  // Read all lines from the JSONL file
  const rawLines = await new Promise((resolve) => {
    const lines = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', line => { if (line.trim()) lines.push(line); });
    rl.on('close', () => resolve(lines));
    rl.on('error', () => resolve([]));
  });

  const steps = [];
  // Map toolUseId -> step object (already in steps array) for result attachment
  const pendingTools = new Map();

  for (const line of rawLines) {
    try {
      const obj = JSON.parse(line);

      // ── User message ──────────────────────────────────────────────────────
      if (obj.type === 'user' && obj.message) {
        const content = obj.message.content;
        if (typeof content === 'string') {
          if (content.trim()) {
            steps.push({
              index: steps.length, type: 'prompt',
              text: content.slice(0, 5000),
              estimatedTokens: Math.ceil(content.length / 4)
            });
          }
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              // Attach output to the matching pending tool step
              const pending = pendingTools.get(block.tool_use_id);
              if (pending) {
                const out = typeof block.content === 'string' ? block.content
                  : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('\n') : '';
                pending.toolOutput = out.slice(0, 3000);
                pending.estimatedOutputTokens = Math.ceil(out.length / 4);
                pendingTools.delete(block.tool_use_id);
              }
            }
          }
          // Any plain text blocks are user prompts (rare but possible)
          const textBlocks = content.filter(b => b.type === 'text');
          if (textBlocks.length > 0) {
            const text = textBlocks.map(b => b.text).join('\n');
            if (text.trim()) {
              steps.push({
                index: steps.length, type: 'prompt',
                text: text.slice(0, 5000),
                estimatedTokens: Math.ceil(text.length / 4)
              });
            }
          }
        }
      }

      // ── Assistant message ─────────────────────────────────────────────────
      if ((obj.type === 'assistant' || (!obj.type && obj.message?.role === 'assistant')) && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text && block.text.trim()) {
            steps.push({
              index: steps.length, type: 'response',
              text: block.text.slice(0, 5000),
              estimatedTokens: Math.ceil(block.text.length / 4)
            });
          } else if (block.type === 'tool_use') {
            const fp = extractFilePath(block.name, block.input);
            const inputStr = JSON.stringify(block.input || {});
            const step = {
              index: steps.length, type: 'tool',
              toolName: block.name,
              toolInput: sanitizeToolInput(block.input),
              toolOutput: null,
              filePath: fp,
              estimatedInputTokens: Math.ceil(inputStr.length / 4),
              estimatedOutputTokens: 0
            };
            steps.push(step);
            pendingTools.set(block.id, step);
          } else if (block.type === 'thinking' && block.thinking) {
            steps.push({
              index: steps.length, type: 'thinking',
              text: block.thinking.slice(0, 3000),
              estimatedTokens: Math.ceil(block.thinking.length / 4)
            });
          }
        }
      }

      // ── Standalone tool_result (alternate JSONL format) ───────────────────
      if (obj.type === 'tool_result' && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block.type === 'tool_result') {
            const pending = pendingTools.get(block.tool_use_id);
            if (pending) {
              const out = typeof block.content === 'string' ? block.content
                : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('\n') : '';
              pending.toolOutput = out.slice(0, 3000);
              pending.estimatedOutputTokens = Math.ceil(out.length / 4);
              pendingTools.delete(block.tool_use_id);
            }
          }
        }
      }
    } catch { /* skip malformed lines */ }
  }

  // Compute summary statistics
  const totalEstimatedTokens = steps.reduce((acc, s) =>
    acc + (s.estimatedInputTokens || 0) + (s.estimatedOutputTokens || s.estimatedTokens || 0), 0);
  const uniqueFiles = new Set(steps.filter(s => s.filePath).map(s => s.filePath));
  const toolBreakdown = {};
  for (const s of steps.filter(s => s.type === 'tool')) {
    toolBreakdown[s.toolName] = (toolBreakdown[s.toolName] || 0) + 1;
  }

  return {
    steps,
    summary: {
      totalSteps: steps.length,
      totalEstimatedTokens,
      uniqueFileCount: uniqueFiles.size,
      toolBreakdown
    }
  };
}

/**
 * Resolve the .jsonl file path for a given sessionId.
 * Tries sessionId.jsonl first, then scans the directory.
 * @param {string} sessionsDir
 * @param {string} sessionId
 * @returns {Promise<string|null>}
 */
async function resolveSessionFile(sessionsDir, sessionId) {
  const direct = path.join(sessionsDir, `${sessionId}.jsonl`);
  try {
    await fs.promises.access(direct);
    return direct;
  } catch { /* not found by name */ }

  // Scan directory for matching sessionId in first 5 lines
  try {
    const files = await fs.promises.readdir(sessionsDir);
    for (const f of files.filter(f => f.endsWith('.jsonl'))) {
      const candidate = path.join(sessionsDir, f);
      const head = await readFirstLines(candidate, 5);
      for (const line of head) {
        try {
          const obj = JSON.parse(line);
          if (obj.sessionId === sessionId) return candidate;
        } catch { /* skip */ }
      }
    }
  } catch { /* dir not found */ }
  return null;
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
  return { success: true };
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
  ipcMain.handle('chat-load-history', async (event, { projectPath, sessionId }) => {
    try {
      return { success: true, messages: await loadSessionHistory(projectPath, sessionId) };
    } catch (err) {
      console.error('[chat-load-history] Error:', err.message);
      return { success: false, error: err.message, messages: [] };
    }
  });

  // Parse a session JSONL into ordered replay steps for the Session Replay panel
  ipcMain.handle('claude-session-replay', async (event, { projectPath, sessionId }) => {
    try {
      return { success: true, ...(await parseSessionReplay(projectPath, sessionId)) };
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

module.exports = { registerClaudeHandlers, getClaudeSessions };
