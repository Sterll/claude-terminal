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
 * Encode project path to match Claude's folder naming convention
 * @param {string} projectPath - The project path
 * @returns {string} - Encoded path for folder name
 */
function encodeProjectPath(projectPath) {
  // Claude uses path with : and \ replaced by -
  return projectPath.replace(/:/g, '-').replace(/\\/g, '-').replace(/\//g, '-');
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
              messages.push({ role: 'assistant', type: 'text', text: block.text });
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
}

module.exports = { registerClaudeHandlers };
