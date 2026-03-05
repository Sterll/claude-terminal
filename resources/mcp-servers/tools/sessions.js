'use strict';

/**
 * Sessions Tools Module for Claude Terminal MCP
 *
 * Exposes Claude Code session history and replay to Claude agents.
 * Reads .jsonl session files from ~/.claude/projects/{encoded-path}/.
 *
 * Tools:
 *   session_list    — List recent sessions for a project
 *   session_replay  — Parse a session into an ordered audit trail of steps
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:sessions] ${args.join(' ')}\n`);
}

// -- Project path helpers (mirrored from claude.ipc.js) -----------------------

function encodeProjectPath(projectPath) {
  const MAX_LEN = 200;
  const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= MAX_LEN) return encoded;
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash + projectPath.charCodeAt(i)) | 0;
  }
  return `${encoded.slice(0, MAX_LEN)}-${Math.abs(hash).toString(36)}`;
}

function getProjectSessionsDir(projectPath) {
  return path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(projectPath));
}

// -- Utility: read first N lines of a file (sync-ish via readline) ------------

function readFirstLines(filePath, n) {
  return new Promise((resolve) => {
    const lines = [];
    try {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        lines.push(line);
        if (lines.length >= n) { rl.close(); stream.destroy(); }
      });
      rl.on('close', () => resolve(lines));
      rl.on('error', () => resolve(lines));
    } catch (e) {
      resolve(lines);
    }
  });
}

// -- Session listing (mirrored from getClaudeSessions in claude.ipc.js) -------

async function listSessions(projectPath, limit = 20) {
  const sessionsDir = getProjectSessionsDir(projectPath);

  let files;
  try {
    files = await fs.promises.readdir(sessionsDir);
  } catch {
    return [];
  }

  const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
  if (!jsonlFiles.length) return [];

  const sessionsPromises = jsonlFiles.map(async (file) => {
    const filePath = path.join(sessionsDir, file);
    try {
      const [stat, lines] = await Promise.all([
        fs.promises.stat(filePath),
        readFirstLines(filePath, 30),
      ]);

      if (stat.size < 200) return null;

      let firstPrompt = '';
      let sessionId = '';
      let isSidechain = false;
      let gitBranch = '';
      let messageCount = 0;

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'user' || obj.type === 'assistant') messageCount++;
          if (obj.type === 'user' && !firstPrompt) {
            sessionId = obj.sessionId || '';
            isSidechain = obj.isSidechain || false;
            gitBranch = obj.gitBranch || '';
            const content = obj.message?.content;
            if (typeof content === 'string') firstPrompt = content;
            else if (Array.isArray(content)) {
              const tb = content.find(b => b.type === 'text');
              if (tb) firstPrompt = tb.text;
            }
          }
        } catch (_) {}
      }

      if (isSidechain) return null;

      return {
        sessionId: sessionId || file.replace('.jsonl', ''),
        firstPrompt: (firstPrompt || '').slice(0, 200),
        messageCount,
        modified: stat.mtime.toISOString(),
        gitBranch,
      };
    } catch {
      return null;
    }
  });

  const sessions = (await Promise.all(sessionsPromises)).filter(Boolean);

  // Enrich with summaries from sessions-index.json if available
  try {
    const indexPath = path.join(sessionsDir, 'sessions-index.json');
    const data = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
    if (data.entries) {
      const map = new Map(data.entries.map(e => [e.sessionId, e]));
      for (const s of sessions) {
        const idx = map.get(s.sessionId);
        if (idx?.summary) s.summary = idx.summary;
        if (idx?.messageCount) s.messageCount = idx.messageCount;
      }
    }
  } catch (_) {}

  return sessions
    .sort((a, b) => new Date(b.modified) - new Date(a.modified))
    .slice(0, limit);
}

// -- Session replay parser (mirrored from parseSessionReplay in claude.ipc.js) -

function extractFilePath(toolName, input) {
  if (!input) return null;
  if (input.file_path) return input.file_path;
  if (input.notebook_path) return input.notebook_path;
  if (input.path) return input.path;
  if (toolName === 'Bash' && typeof input.command === 'string') {
    const match = input.command.match(/(?:^|\s)((?:\/|\.\.?\/|~\/|[A-Za-z]:\\)[^\s"']+)/);
    if (match) return match[1];
  }
  return null;
}

function sanitizeInput(input) {
  if (!input) return {};
  const str = JSON.stringify(input);
  if (str.length > 1000) return { _truncated: true, _preview: str.slice(0, 200) + '...' };
  return input;
}

async function parseReplay(projectPath, sessionId) {
  const sessionsDir = getProjectSessionsDir(projectPath);
  let filePath = path.join(sessionsDir, `${sessionId}.jsonl`);

  // Fall back to scanning for the sessionId in file headers
  try {
    await fs.promises.access(filePath);
  } catch {
    const files = (await fs.promises.readdir(sessionsDir).catch(() => []))
      .filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const candidate = path.join(sessionsDir, f);
      const head = await readFirstLines(candidate, 5);
      for (const line of head) {
        try {
          if (JSON.parse(line).sessionId === sessionId) { filePath = candidate; break; }
        } catch (_) {}
      }
    }
  }

  const rawLines = await new Promise((resolve) => {
    const lines = [];
    try {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', line => { if (line.trim()) lines.push(line); });
      rl.on('close', () => resolve(lines));
      rl.on('error', () => resolve([]));
    } catch {
      resolve([]);
    }
  });

  const steps = [];
  const pendingTools = new Map();

  for (const line of rawLines) {
    try {
      const obj = JSON.parse(line);

      if (obj.type === 'user' && obj.message) {
        const content = obj.message.content;
        if (typeof content === 'string' && content.trim()) {
          steps.push({ type: 'prompt', text: content.slice(0, 3000), estimatedTokens: Math.ceil(content.length / 4) });
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const pending = pendingTools.get(block.tool_use_id);
              if (pending) {
                const out = typeof block.content === 'string' ? block.content
                  : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('\n') : '';
                pending.toolOutput = out.slice(0, 2000);
                pending.estimatedOutputTokens = Math.ceil(out.length / 4);
                pendingTools.delete(block.tool_use_id);
              }
            }
          }
          const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          if (text.trim()) {
            steps.push({ type: 'prompt', text: text.slice(0, 3000), estimatedTokens: Math.ceil(text.length / 4) });
          }
        }
      }

      if ((obj.type === 'assistant' || (!obj.type && obj.message?.role === 'assistant')) && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text?.trim()) {
            steps.push({ type: 'response', text: block.text.slice(0, 3000), estimatedTokens: Math.ceil(block.text.length / 4) });
          } else if (block.type === 'tool_use') {
            const inputStr = JSON.stringify(block.input || {});
            const step = {
              type: 'tool',
              toolName: block.name,
              toolInput: sanitizeInput(block.input),
              toolOutput: null,
              filePath: extractFilePath(block.name, block.input),
              estimatedInputTokens: Math.ceil(inputStr.length / 4),
              estimatedOutputTokens: 0,
            };
            steps.push(step);
            pendingTools.set(block.id, step);
          } else if (block.type === 'thinking' && block.thinking) {
            steps.push({ type: 'thinking', text: block.thinking.slice(0, 2000), estimatedTokens: Math.ceil(block.thinking.length / 4) });
          }
        }
      }

      if (obj.type === 'tool_result' && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block.type === 'tool_result') {
            const pending = pendingTools.get(block.tool_use_id);
            if (pending) {
              const out = typeof block.content === 'string' ? block.content
                : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('\n') : '';
              pending.toolOutput = out.slice(0, 2000);
              pending.estimatedOutputTokens = Math.ceil(out.length / 4);
              pendingTools.delete(block.tool_use_id);
            }
          }
        }
      }
    } catch (_) {}
  }

  // Summary
  const totalTokens = steps.reduce((acc, s) =>
    acc + (s.estimatedInputTokens || 0) + (s.estimatedOutputTokens || s.estimatedTokens || 0), 0);
  const uniqueFiles = [...new Set(steps.filter(s => s.filePath).map(s => s.filePath))];
  const toolBreakdown = {};
  for (const s of steps.filter(s => s.type === 'tool')) {
    toolBreakdown[s.toolName] = (toolBreakdown[s.toolName] || 0) + 1;
  }

  return { steps, summary: { totalSteps: steps.length, totalEstimatedTokens: totalTokens, uniqueFiles, toolBreakdown } };
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'session_list',
    description: 'List recent Claude Code sessions for a project. Returns session IDs, first prompt, date, message count. Use session_replay to get the full step-by-step breakdown of a session.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Absolute path to the project. Defaults to CT_PROJECT_PATH env var (current project in Claude Terminal).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of sessions to return (default: 10, max: 50)',
        },
      },
    },
  },
  {
    name: 'session_replay',
    description: 'Parse a Claude Code session JSONL file into an ordered audit trail. Returns every step: user prompts, tool calls (with input/output), Claude responses, and thinking blocks. Includes a summary with estimated token usage, tool breakdown, and files touched. Useful for auditing what Claude did in a past session, debugging failed sessions, or understanding costs.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session UUID from session_list',
        },
        project_path: {
          type: 'string',
          description: 'Absolute path to the project. Defaults to CT_PROJECT_PATH.',
        },
        include_thinking: {
          type: 'boolean',
          description: 'Include extended thinking blocks in output (default: false — they can be very long)',
        },
        max_steps: {
          type: 'number',
          description: 'Limit output to first N steps (default: unlimited)',
        },
      },
      required: ['session_id'],
    },
  },
];

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  const projectPath = args.project_path || process.env.CT_PROJECT_PATH || '';

  try {
    // ── session_list ─────────────────────────────────────────────────────────
    if (name === 'session_list') {
      if (!projectPath) return fail('No project path provided. Pass project_path or set CT_PROJECT_PATH.');

      const limit = Math.min(args.limit || 10, 50);
      const sessions = await listSessions(projectPath, limit);

      if (!sessions.length) {
        return ok(`No Claude sessions found for project: ${projectPath}\n\nMake sure you have run Claude Code in this project directory.`);
      }

      const lines = sessions.map((s, i) => {
        const date = new Date(s.modified).toLocaleString();
        const label = s.summary || s.firstPrompt || '(no prompt)';
        return [
          `${i + 1}. ${s.sessionId}`,
          `   Date: ${date}`,
          `   Messages: ${s.messageCount}`,
          s.gitBranch ? `   Branch: ${s.gitBranch}` : '',
          `   Prompt: ${label.slice(0, 120)}`,
        ].filter(Boolean).join('\n');
      });

      return ok(`Sessions for ${path.basename(projectPath)} (${sessions.length}):\n\n${lines.join('\n\n')}\n\nUse session_replay with a session_id to get the full step-by-step audit trail.`);
    }

    // ── session_replay ───────────────────────────────────────────────────────
    if (name === 'session_replay') {
      if (!args.session_id) return fail('Missing required parameter: session_id');
      if (!projectPath) return fail('No project path provided. Pass project_path or set CT_PROJECT_PATH.');

      const { steps, summary } = await parseReplay(projectPath, args.session_id);

      if (!steps.length) return ok(`No steps found in session ${args.session_id}. The session may be empty or the file could not be read.`);

      const includeThinking = args.include_thinking === true;
      let filteredSteps = includeThinking ? steps : steps.filter(s => s.type !== 'thinking');
      if (args.max_steps && args.max_steps > 0) filteredSteps = filteredSteps.slice(0, args.max_steps);

      // Build summary section
      const topTools = Object.entries(summary.toolBreakdown)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `${name}×${count}`)
        .join(', ');

      let out = `# Session Replay: ${args.session_id}\n`;
      out += `${'─'.repeat(60)}\n`;
      out += `Total steps: ${summary.totalSteps}`;
      if (!includeThinking) out += ` (thinking hidden)`;
      out += `\n`;
      out += `Estimated tokens: ~${summary.totalEstimatedTokens.toLocaleString()}\n`;
      if (summary.uniqueFiles.length) out += `Files touched (${summary.uniqueFiles.length}): ${summary.uniqueFiles.slice(0, 10).join(', ')}${summary.uniqueFiles.length > 10 ? '…' : ''}\n`;
      if (topTools) out += `Tools used: ${topTools}\n`;
      out += `${'─'.repeat(60)}\n\n`;

      // Build step list
      filteredSteps.forEach((step, i) => {
        const num = String(i + 1).padStart(3, ' ');
        const tok = step.type === 'tool'
          ? `~${(step.estimatedInputTokens || 0) + (step.estimatedOutputTokens || 0)} tok`
          : `~${step.estimatedTokens || 0} tok`;

        if (step.type === 'prompt') {
          out += `${num}. [PROMPT] ${tok}\n${step.text.replace(/\n/g, ' ').slice(0, 200)}\n\n`;
        } else if (step.type === 'response') {
          out += `${num}. [RESPONSE] ${tok}\n${step.text.replace(/\n/g, ' ').slice(0, 200)}\n\n`;
        } else if (step.type === 'thinking') {
          out += `${num}. [THINKING] ${tok}\n(extended thinking — ${step.text.length} chars)\n\n`;
        } else if (step.type === 'tool') {
          out += `${num}. [TOOL: ${step.toolName}] ${tok}`;
          if (step.filePath) out += ` → ${step.filePath}`;
          out += '\n';
          // Show key input fields compactly
          if (step.toolInput && !step.toolInput._truncated) {
            const inputKeys = Object.keys(step.toolInput);
            const preview = inputKeys.slice(0, 3).map(k => {
              const v = String(step.toolInput[k] || '').slice(0, 80);
              return `  ${k}: ${v}`;
            }).join('\n');
            if (preview) out += preview + '\n';
          }
          if (step.toolOutput !== null && step.toolOutput !== undefined) {
            const outputPreview = (step.toolOutput || '(empty)').slice(0, 300).replace(/\n/g, '↵');
            out += `  → Output: ${outputPreview}\n`;
          }
          out += '\n';
        }
      });

      if (args.max_steps && filteredSteps.length >= args.max_steps) {
        out += `[Showing first ${args.max_steps} steps. Use max_steps to increase the limit.]\n`;
      }

      return ok(out);
    }

    return fail(`Unknown session tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Session error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
