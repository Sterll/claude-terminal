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

// -- Cross-project session search ---------------------------------------------

/**
 * Enumerate session files, newest first.
 *
 * Deliberately index-free: a full case-insensitive scan of ~600 MB of
 * transcripts costs ~4.5s, but files are walked newest-first and the caller
 * stops as soon as it has enough sessions, so real queries land well under a
 * second. No database means nothing to keep in sync and no stale results.
 */
function listAllSessionFiles(projectPath) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const dirs = [];

  if (projectPath) {
    dirs.push(path.join(root, encodeProjectPath(projectPath)));
  } else {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(path.join(root, entry.name));
    }
  }

  const files = [];
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(dir, name);
      try {
        const stat = fs.statSync(filePath);
        if (stat.size < 200) continue;
        files.push({ filePath, mtimeMs: stat.mtimeMs });
      } catch (_) {}
    }
  }

  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// System reminders are injected machinery, not something the user ever said.
// Matching inside them produces confusing hits.
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

// Synthetic entries the CLI writes into the transcript as if the user had typed
// them. Reporting these as things the user said is misleading.
const SYNTHETIC_USER_RE = /^\s*(\[Request interrupted[^\]]*\]|\[No response requested\]|<local-command-[a-z]+>)\s*$/;

/**
 * Pull only genuine conversation out of a JSONL entry: user prompts and Claude's
 * text replies. Tool inputs/outputs and thinking blocks are skipped — they are
 * 99% of the bytes and almost none of the meaning.
 */
function conversationalBlocks(obj) {
  const out = [];
  if (obj.isSidechain) return out;

  const message = obj.message;
  if (!message) return out;

  let role = null;
  if (obj.type === 'user') role = 'user';
  else if (obj.type === 'assistant' || message.role === 'assistant') role = 'assistant';
  if (!role) return out;

  const push = (text) => {
    const cleaned = String(text).replace(SYSTEM_REMINDER_RE, ' ').trim();
    if (!cleaned) return;
    if (role === 'user' && SYNTHETIC_USER_RE.test(cleaned)) return;
    out.push({ role, text: cleaned });
  };

  const content = message.content;
  if (typeof content === 'string') {
    push(content);
  } else if (Array.isArray(content)) {
    // type === 'text' only: this is what excludes tool_result blocks.
    for (const block of content) {
      if (block.type === 'text' && block.text) push(block.text);
    }
  }

  return out;
}

function makeSnippet(text, terms, radius = 130) {
  const lower = text.toLowerCase();
  let idx = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx === -1) idx = 0;

  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet += '…';
  return snippet;
}

async function searchSessions({ query, projectPath, days, limit, maxSnippets }) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) {
    return { sessions: [], scanned: 0, candidates: 0, total: 0, stoppedEarly: false };
  }

  const allFiles = listAllSessionFiles(projectPath);
  const total = allFiles.length;

  let files = allFiles;
  if (days && days > 0) {
    const cutoff = Date.now() - days * 86400000;
    files = files.filter(f => f.mtimeMs >= cutoff);
  }

  const sessions = [];
  let scanned = 0;
  let stoppedEarly = false;

  for (const file of files) {
    if (sessions.length >= limit) {
      stoppedEarly = true;
      break;
    }
    scanned++;

    let raw;
    try {
      raw = await fs.promises.readFile(file.filePath, 'utf8');
    } catch {
      continue;
    }

    // Cheap whole-file gate: every term must appear somewhere before we pay
    // for JSON parsing.
    const lower = raw.toLowerCase();
    if (!terms.every(term => lower.includes(term))) continue;

    const hits = [];
    let cwd = '';
    let sessionId = '';
    let gitBranch = '';
    let lastTimestamp = '';
    let firstUserText = null;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (!cwd && obj.cwd) cwd = obj.cwd;
      if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
      if (!gitBranch && obj.gitBranch) gitBranch = obj.gitBranch;
      if (obj.timestamp) lastTimestamp = obj.timestamp;

      for (const block of conversationalBlocks(obj)) {
        if (firstUserText === null && block.role === 'user') firstUserText = block.text;

        const blockLower = block.text.toLowerCase();
        const matched = terms.filter(term => blockLower.includes(term));
        if (!matched.length) continue;
        hits.push({
          role: block.role,
          score: matched.length,
          timestamp: obj.timestamp || '',
          text: block.text,
        });
      }
    }

    // The file matched only inside tool output or thinking — not a real hit.
    if (!hits.length) continue;

    // Claude Terminal's persistent tab-naming session (ChatService._ensureNamingSession)
    // replays the opening of every prompt the user ever writes, so it matches
    // almost any query. It is machinery, not a conversation.
    if (firstUserText && /^Title for: "/.test(firstUserText)) continue;

    hits.sort((a, b) => b.score - a.score);

    sessions.push({
      sessionId: sessionId || path.basename(file.filePath, '.jsonl'),
      projectPath: cwd,
      gitBranch,
      modified: new Date(file.mtimeMs).toISOString(),
      lastTimestamp,
      totalHits: hits.length,
      snippets: hits.slice(0, maxSnippets).map(h => ({
        role: h.role,
        timestamp: h.timestamp,
        snippet: makeSnippet(h.text, terms),
      })),
    });
  }

  return { sessions, scanned, candidates: files.length, total, stoppedEarly };
}

// -- Session recap ------------------------------------------------------------

/**
 * Resolve "this conversation" to a file: an explicit session id, else the most
 * recently touched session of the project.
 */
async function resolveSessionFile(projectPath, sessionId) {
  const sessionsDir = getProjectSessionsDir(projectPath);

  if (sessionId) {
    const direct = path.join(sessionsDir, `${sessionId}.jsonl`);
    try {
      await fs.promises.access(direct);
      return direct;
    } catch (_) {}

    const names = (await fs.promises.readdir(sessionsDir).catch(() => []))
      .filter(f => f.endsWith('.jsonl'));
    for (const name of names) {
      const candidate = path.join(sessionsDir, name);
      const head = await readFirstLines(candidate, 5);
      for (const line of head) {
        try {
          if (JSON.parse(line).sessionId === sessionId) return candidate;
        } catch (_) {}
      }
    }
    return null;
  }

  const names = (await fs.promises.readdir(sessionsDir).catch(() => []))
    .filter(f => f.endsWith('.jsonl'));
  let newest = null;
  for (const name of names) {
    const candidate = path.join(sessionsDir, name);
    try {
      const stat = await fs.promises.stat(candidate);
      if (stat.size < 200) continue;
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = { filePath: candidate, mtimeMs: stat.mtimeMs };
      }
    } catch (_) {}
  }
  return newest ? newest.filePath : null;
}

/**
 * One pass over a session, keeping only what is needed to say "here is where we
 * are": the goal, the recent exchanges, what was touched, and how it ended.
 * Deliberately does not summarise — the calling agent does that.
 */
async function parseRecap(filePath, recentCount) {
  const raw = await fs.promises.readFile(filePath, 'utf8').catch(() => '');
  if (!raw) return null;

  const exchanges = [];
  const files = new Set();
  const toolCounts = {};
  let sessionId = '';
  let cwd = '';
  let gitBranch = '';
  let firstTimestamp = '';
  let lastTimestamp = '';
  let userMessages = 0;
  let assistantMessages = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
    if (!cwd && obj.cwd) cwd = obj.cwd;
    if (obj.gitBranch) gitBranch = obj.gitBranch;
    if (obj.timestamp) {
      if (!firstTimestamp) firstTimestamp = obj.timestamp;
      lastTimestamp = obj.timestamp;
    }

    if (obj.isSidechain) continue;

    // Tool usage and touched files come from assistant tool_use blocks.
    const content = obj.message && obj.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          toolCounts[block.name] = (toolCounts[block.name] || 0) + 1;
          const fp = extractFilePath(block.name, block.input);
          if (fp) files.add(fp);
        }
      }
    }

    for (const block of conversationalBlocks(obj)) {
      if (block.role === 'user') userMessages++;
      else assistantMessages++;
      exchanges.push({
        role: block.role,
        timestamp: obj.timestamp || '',
        text: block.text,
      });
    }
  }

  if (!exchanges.length) return null;

  const goal = exchanges.find(e => e.role === 'user');
  const recent = exchanges.slice(-recentCount);
  const lastAssistant = [...exchanges].reverse().find(e => e.role === 'assistant');

  return {
    sessionId: sessionId || path.basename(filePath, '.jsonl'),
    cwd,
    gitBranch,
    firstTimestamp,
    lastTimestamp,
    userMessages,
    assistantMessages,
    goal: goal ? goal.text : '',
    recent,
    lastAssistant: lastAssistant ? lastAssistant.text : '',
    files: [...files],
    toolCounts,
  };
}

function formatDurationMs(ms) {
  if (!ms || ms < 0) return 'unknown';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}`;
}

function condense(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
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
    name: 'session_recap',
    description: 'Get a compact status digest of a conversation — answers "where are we at on this?" without replaying the whole thing. Defaults to the most recent session of the project, so it works for "what were we doing here?". Returns the original goal, how long it ran, the last few exchanges, files touched, tools used, and how it ended. Prefer this over session_replay when the user wants a status update rather than an audit trail; it is far shorter and is the right tool to answer out loud.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session UUID. Omit to recap the most recent session of the project (the usual case for "this conversation").',
        },
        project_path: {
          type: 'string',
          description: 'Absolute path to the project. Defaults to CT_PROJECT_PATH.',
        },
        recent_exchanges: {
          type: 'number',
          description: 'How many of the latest messages to include (default: 6, max: 20)',
        },
      },
    },
  },
  {
    name: 'session_search',
    description: 'Search past Claude Code conversations by keyword, across ALL projects by default. Use this to answer questions like "where did we leave the ninin bug?", "which project was I working on X in?", or "have we discussed this before?" — it is the only way to find something when you do not already know which project or session it is in. Searches user prompts and Claude replies only; tool output and thinking blocks are ignored, so hits are things that were actually said. Returns the session ID, real project path, date and matching excerpts. Follow up with session_replay for the full detail of a session.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to look for, case-insensitive. Multiple words are all required to appear somewhere in the session (e.g. "ninin bug").',
        },
        project_path: {
          type: 'string',
          description: 'Restrict the search to one project. Omit to search every project (the usual case).',
        },
        days: {
          type: 'number',
          description: 'Only search sessions touched in the last N days. Useful to cut noise on common words.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of sessions to return (default: 10, max: 30). Sessions are returned newest first.',
        },
        max_snippets: {
          type: 'number',
          description: 'Maximum excerpts shown per session (default: 3, max: 10)',
        },
      },
      required: ['query'],
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

    // ── session_recap ────────────────────────────────────────────────────────
    if (name === 'session_recap') {
      if (!projectPath) return fail('No project path provided. Pass project_path or set CT_PROJECT_PATH.');

      const recentCount = Math.min(Math.max(args.recent_exchanges || 6, 1), 20);
      const filePath = await resolveSessionFile(projectPath, args.session_id);

      if (!filePath) {
        return ok(args.session_id
          ? `Session ${args.session_id} not found in ${path.basename(projectPath)}.`
          : `No session found for ${path.basename(projectPath)}. Has Claude Code been run in this project?`);
      }

      const recap = await parseRecap(filePath, recentCount);
      if (!recap) return ok(`Session ${path.basename(filePath, '.jsonl')} has no readable conversation.`);

      const started = recap.firstTimestamp ? new Date(recap.firstTimestamp) : null;
      const ended = recap.lastTimestamp ? new Date(recap.lastTimestamp) : null;
      const duration = started && ended ? formatDurationMs(ended - started) : 'unknown';

      const topTools = Object.entries(recap.toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([tool, count]) => `${tool}×${count}`)
        .join(', ');

      let out = `# Recap: ${recap.sessionId}\n`;
      out += `${'─'.repeat(60)}\n`;
      out += `Project: ${recap.cwd || projectPath}\n`;
      if (recap.gitBranch) out += `Branch: ${recap.gitBranch}\n`;
      if (started) out += `Started: ${started.toLocaleString()}\n`;
      if (ended) out += `Last activity: ${ended.toLocaleString()}\n`;
      // Wall-clock between first and last message, NOT time actually worked —
      // a conversation resumed over three days spans 72h of mostly nothing.
      out += `Spans: ${duration} (first to last message)  |  ${recap.userMessages} user / ${recap.assistantMessages} assistant messages\n`;
      out += `${'─'.repeat(60)}\n\n`;

      out += `## Goal (opening request)\n${condense(recap.goal, 500) || '(none)'}\n\n`;

      out += `## Last ${recap.recent.length} exchange(s)\n`;
      for (const ex of recap.recent) {
        const stamp = ex.timestamp ? new Date(ex.timestamp).toLocaleString() : '';
        out += `[${ex.role}${stamp ? ' ' + stamp : ''}] ${condense(ex.text, 320)}\n`;
      }
      out += '\n';

      if (recap.files.length) {
        out += `## Files touched (${recap.files.length})\n`;
        out += recap.files.slice(0, 15).join('\n');
        if (recap.files.length > 15) out += `\n… and ${recap.files.length - 15} more`;
        out += '\n\n';
      }

      if (topTools) out += `## Tools used\n${topTools}\n\n`;

      out += `## Where it stopped\n${condense(recap.lastAssistant, 600) || '(no assistant reply)'}\n`;

      return ok(out);
    }

    // ── session_search ───────────────────────────────────────────────────────
    if (name === 'session_search') {
      if (!args.query || !String(args.query).trim()) {
        return fail('Missing required parameter: query');
      }

      const limit = Math.min(Math.max(args.limit || 10, 1), 30);
      const maxSnippets = Math.min(Math.max(args.max_snippets || 3, 1), 10);
      const scopePath = args.project_path || '';

      const started = Date.now();
      const { sessions, scanned, candidates, total, stoppedEarly } = await searchSessions({
        query: args.query,
        projectPath: scopePath,
        days: args.days,
        limit,
        maxSnippets,
      });
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);

      const scope = scopePath ? path.basename(scopePath) : `all projects (${total} sessions)`;

      if (!sessions.length) {
        let msg = `No conversation found matching "${args.query}" in ${scope}.\n\n`;
        msg += `Scanned ${scanned} session file(s) in ${elapsed}s.\n`;
        if (args.days) msg += `Only sessions from the last ${args.days} day(s) were searched — retry without "days" to widen.\n`;
        msg += `Note: tool output and thinking blocks are not searched, only what was actually said.`;
        return ok(msg);
      }

      let out = `# Sessions matching "${args.query}"\n`;
      out += `${'─'.repeat(60)}\n`;
      out += `Scope: ${scope}\n`;
      out += `Found ${sessions.length} session(s), scanned ${scanned}/${candidates} file(s) in ${elapsed}s\n`;
      out += `${'─'.repeat(60)}\n\n`;

      sessions.forEach((s, i) => {
        const when = s.lastTimestamp || s.modified;
        out += `${i + 1}. ${s.sessionId}\n`;
        out += `   Project: ${s.projectPath || '(unknown)'}\n`;
        out += `   Last activity: ${new Date(when).toLocaleString()}\n`;
        if (s.gitBranch) out += `   Branch: ${s.gitBranch}\n`;
        out += `   Matches: ${s.totalHits}\n`;
        for (const sn of s.snippets) {
          const stamp = sn.timestamp ? new Date(sn.timestamp).toLocaleDateString() : '';
          out += `   [${sn.role}${stamp ? ' ' + stamp : ''}] ${sn.snippet}\n`;
        }
        out += '\n';
      });

      if (stoppedEarly) {
        out += `[Stopped at ${limit} sessions — ${candidates - scanned} older file(s) were not searched. Raise "limit" or pass "days" to narrow.]\n\n`;
      }
      out += `Use session_replay with a session_id (and its Project path) for the full step-by-step detail.`;

      return ok(out);
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
