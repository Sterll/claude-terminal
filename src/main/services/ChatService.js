/**
 * ChatService - Claude Agent SDK Wrapper
 * Manages chat sessions using streaming input mode for multi-turn conversations.
 * Handles permissions via canUseTool callback, forwarding to renderer.
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { execFileSync } = require('child_process');

let sdkPromise = null;
let resolvedRuntime = null;

async function loadSDK() {
  if (!sdkPromise) {
    sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  }
  return sdkPromise;
}

/**
 * Resolve the path to the SDK's cli.js.
 * In packaged mode, asarUnpack puts it outside the asar at app.asar.unpacked/
 */
function getSdkCliPath() {
  const sdkRelative = path.join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
  if (app.isPackaged) {
    return path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), sdkRelative);
  }
  return path.join(app.getAppPath(), sdkRelative);
}

/**
 * Detect the best available JS runtime for the Agent SDK.
 * Returns { executable, env } where:
 * - executable is the SDK enum ('node'|'bun'|'deno')
 * - env is a fresh copy of process.env with the runtime's dir prepended to PATH
 *
 * Detection result is cached, but env is rebuilt each call so callers
 * can safely mutate process.env beforehand (e.g. removing CLAUDECODE).
 *
 * Priority: bun > deno > node (bun spawns fastest, deno second).
 * On macOS/Linux, apps launched from Finder don't inherit shell PATH,
 * so we probe common install locations and inject them into env.PATH.
 */
function resolveRuntime() {
  // Cache hit — only rebuild env
  if (resolvedRuntime) {
    return {
      executable: resolvedRuntime.executable,
      env: buildEnv(resolvedRuntime.pathDir),
    };
  }

  const isWin = process.platform === 'win32';
  const home = process.env.HOME || require('os').homedir();

  // Runtime definitions: name (SDK enum), binary name, and search locations
  // Note: deno is excluded — cli.js requires env access that deno blocks without --allow-env
  const runtimes = [
    {
      name: 'bun',
      bin: isWin ? 'bun.exe' : 'bun',
      locations: isWin
        ? [path.join(home, '.bun', 'bin')]
        : [
            path.join(home, '.bun', 'bin'),
            '/usr/local/bin',
            '/opt/homebrew/bin',
          ],
    },
    {
      name: 'node',
      bin: isWin ? 'node.exe' : 'node',
      locations: isWin
        ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs')]
        : [
            '/usr/local/bin',
            '/opt/homebrew/bin',
            '/usr/bin',
            path.join(home, '.nvm/current/bin'),
            path.join(home, '.volta/bin'),
            path.join(home, '.fnm/aliases/default/bin'),
            path.join(home, '.local/share/fnm/aliases/default/bin'),
          ],
    },
  ];

  // 1. Try shell lookup (most reliable, gets user's actual PATH)
  for (const rt of runtimes) {
    const found = shellLookup(rt.name, isWin);
    if (found) {
      const dir = path.dirname(found);
      resolvedRuntime = { executable: rt.name, pathDir: dir };
      console.log(`[ChatService] Runtime: ${rt.name} (shell lookup: ${found})`);
      return { executable: rt.name, env: buildEnv(dir) };
    }
  }

  // 2. Probe known install locations
  for (const rt of runtimes) {
    for (const dir of rt.locations) {
      try {
        if (fs.existsSync(path.join(dir, rt.bin))) {
          resolvedRuntime = { executable: rt.name, pathDir: dir };
          console.log(`[ChatService] Runtime: ${rt.name} (found at ${dir})`);
          return { executable: rt.name, env: buildEnv(dir) };
        }
      } catch { /* skip */ }
    }
  }

  // 3. Fallback — let the SDK try "node" and hope it's in PATH
  console.warn('[ChatService] No runtime found, falling back to node');
  resolvedRuntime = { executable: 'node', pathDir: null };
  return { executable: 'node', env: { ...process.env } };
}

/** Build a fresh env with the given dir prepended to PATH. */
function buildEnv(dir) {
  if (!dir) return { ...process.env };
  const sep = process.platform === 'win32' ? ';' : ':';
  return { ...process.env, PATH: dir + sep + (process.env.PATH || '') };
}

/** Use shell to locate a binary (handles login-shell PATHs on macOS/Linux). */
function shellLookup(name, isWin) {
  if (isWin) {
    try {
      return execFileSync('where.exe', [name], {
        encoding: 'utf8', timeout: 5000,
      }).trim().split(/\r?\n/)[0] || null;
    } catch { return null; }
  }
  for (const shell of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (!fs.existsSync(shell)) continue;
    try {
      const result = execFileSync(shell, ['-lc', `which ${name}`], {
        encoding: 'utf8', timeout: 5000,
        env: { ...process.env, HOME: process.env.HOME || require('os').homedir() },
      }).trim();
      if (result && fs.existsSync(result)) return result;
    } catch { /* continue */ }
  }
  return null;
}

/**
 * Async message queue for streaming input mode.
 * The SDK reads from this iterable; we push user messages into it.
 * @param {Function} onIdle - Called when SDK pulls next message (previous turn done)
 */
function createMessageQueue(onIdle) {
  const queue = [];
  let waitResolve = null;
  let done = false;
  let pullCount = 0;

  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          pullCount++;
          // After first pull, each subsequent pull means SDK finished a turn
          if (pullCount > 1 && onIdle) {
            onIdle();
          }
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise(resolve => { waitResolve = resolve; });
        },
        return() {
          done = true;
          return Promise.resolve({ value: undefined, done: true });
        }
      };
    }
  };

  return {
    push(message) {
      if (waitResolve) {
        const resolve = waitResolve;
        waitResolve = null;
        resolve({ value: message, done: false });
      } else {
        queue.push(message);
      }
    },
    close() {
      done = true;
      if (waitResolve) {
        const resolve = waitResolve;
        waitResolve = null;
        resolve({ value: undefined, done: true });
      }
    },
    iterable
  };
}

class ChatService {
  constructor() {
    /** @type {Map<string, Object>} */
    this.sessions = new Map();
    /** @type {Map<string, { resolve: Function, reject: Function }>} */
    this.pendingPermissions = new Map();
    /** @type {Map<string, { abortController: AbortController, type: string }>} */
    this.backgroundGenerations = new Map();
    /** @type {BrowserWindow|null} */
    this.mainWindow = null;

    // Catch SDK internal "ProcessTransport is not ready" errors that bubble as
    // unhandled rejections when a permission response is resolved after the
    // underlying CLI process has already exited.
    this._unhandledRejectionHandler = (reason) => {
      if (reason?.message?.includes('ProcessTransport is not ready')) {
        console.warn('[ChatService] Suppressed SDK ProcessTransport error (CLI process already exited)');
        return;
      }
    };
    process.on('unhandledRejection', this._unhandledRejectionHandler);
  }

  setMainWindow(window) {
    this.mainWindow = window;
  }

  setRemoteEventCallback(fn) {
    this._remoteEventCallback = fn || null;
  }

  _send(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
    if (this._remoteEventCallback) {
      this._remoteEventCallback(channel, data);
    }
  }

  /**
   * Start a new chat session using streaming input mode
   * @param {Object} params
   * @param {string} params.cwd - Working directory
   * @param {string} params.prompt - Initial prompt
   * @param {string} [params.permissionMode] - Permission mode
   * @param {string} [params.resumeSessionId] - Session ID to resume
   * @returns {Promise<string>} Session ID
   */
  async startSession({ cwd, prompt, permissionMode = 'default', resumeSessionId = null, sessionId = null, images = [], mentions = [], model = null, enable1MContext = false, forkSession = false, resumeSessionAt = null, effort = null }) {
    const sdk = await loadSDK();
    if (!sessionId) sessionId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const messageQueue = createMessageQueue(() => {
      this._send('chat-idle', { sessionId });
    });

    // Always push initial prompt (even for resume — SDK needs a message to process)
    if (prompt) {
      messageQueue.push({
        type: 'user',
        message: { role: 'user', content: this._buildContent(prompt, images, mentions) },
        parent_tool_use_id: null,
        session_id: sessionId
      });
      // Relay initial user message to remote clients
      if (this._remoteEventCallback) {
        this._remoteEventCallback('chat-user-message', { sessionId, text: prompt, images: images.length });
      }
    }

    const abortController = new AbortController();

    // Remove CLAUDECODE env to avoid nested session detection
    const prevClaudeCode = process.env.CLAUDECODE;
    delete process.env.CLAUDECODE;

    try {
      const runtime = resolveRuntime();

      const options = {
        cwd,
        abortController,
        maxTurns: 100,
        includePartialMessages: true,
        permissionMode,
        executable: runtime.executable,
        env: runtime.env,
        pathToClaudeCodeExecutable: getSdkCliPath(),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        canUseTool: async (toolName, input, opts) => {
          return this._handlePermission(sessionId, toolName, input, opts);
        },
        stderr: (data) => { console.error(`[ChatService][stderr] ${data}`); }
      };

      // Set model if specified
      if (model) {
        options.model = model;
      }

      // Set effort level if specified
      if (effort) {
        options.effort = effort;
      }

      // Enable 1M token context window (beta)
      if (enable1MContext) {
        options.betas = ['context-1m-2025-08-07'];
      }

      // Resume existing session if requested
      if (resumeSessionId) {
        options.resume = resumeSessionId;
        if (forkSession) {
          options.forkSession = true;
        }
        if (resumeSessionAt) {
          options.resumeSessionAt = resumeSessionAt;
        }
      }

      const queryStream = sdk.query({
        prompt: messageQueue.iterable,
        options,
      });

      this.sessions.set(sessionId, {
        abortController,
        messageQueue,
        queryStream,
        alwaysAllow: permissionMode === 'bypassPermissions',
        cwd,
      });

      this._processStream(sessionId, queryStream);
      return sessionId;
    } catch (err) {
      console.error(`[ChatService] startSession error:`, err.message);
      this.sessions.delete(sessionId);
      const humanized = this._humanizeError(err.message);
      throw humanized === err.message ? err : new Error(humanized);
    } finally {
      if (prevClaudeCode) {
        process.env.CLAUDECODE = prevClaudeCode;
      }
    }
  }

  /**
   * Send a follow-up message (push to async iterable queue)
   */
  sendMessage(sessionId, text, images = [], mentions = []) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    try {
      session.messageQueue.push({
        type: 'user',
        message: { role: 'user', content: this._buildContent(text, images, mentions) },
        parent_tool_use_id: null,
        session_id: sessionId
      });
      // Relay user message to remote clients so mobile sees it
      if (this._remoteEventCallback) {
        this._remoteEventCallback('chat-user-message', { sessionId, text, images: images.length });
      }
    } catch (err) {
      console.error(`[ChatService] sendMessage error (transport not ready):`, err.message);
      // Session transport died — clean up
      this.closeSession(sessionId);
      throw new Error('Session has ended. Please start a new chat.');
    }
  }

  /**
   * Build message content: plain string if text-only, content blocks array if images/mentions attached
   * @param {string} text
   * @param {Array} images - Array of { base64, mediaType } objects
   * @param {Array} mentions - Array of { label, content } resolved context blocks
   * @returns {string|Array}
   */
  _buildContent(text, images, mentions = []) {
    const hasImages = images && images.length > 0;
    const hasMentions = mentions && mentions.length > 0;

    if (!hasImages && !hasMentions) return text;

    const content = [];

    // Context blocks first — so Claude sees the context before the question
    for (const mention of (mentions || [])) {
      content.push({ type: 'text', text: `[Context: ${mention.label}]\n${mention.content}` });
    }

    // User's actual message
    if (text) {
      content.push({ type: 'text', text });
    }

    // Images last
    for (const img of (images || [])) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType,
          data: img.base64
        }
      });
    }

    return content;
  }

  /**
   * Handle permission request from SDK's canUseTool callback.
   * Forwards to renderer and waits for user response.
   */
  async _handlePermission(sessionId, toolName, input, options) {
    // These tools always require user interaction, never auto-approve
    const INTERACTIVE_TOOLS = ['ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion'];

    // Auto-approve if session has alwaysAllow enabled (except interactive tools)
    const session = this.sessions.get(sessionId);
    if (session?.alwaysAllow && !INTERACTIVE_TOOLS.includes(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }

    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      this.pendingPermissions.set(requestId, { resolve, reject, sessionId });

      this._send('chat-permission-request', {
        sessionId,
        requestId,
        toolName,
        input: this._safeSerialize(input),
        suggestions: options.suggestions,
        decisionReason: options.decisionReason,
        toolUseID: options.toolUseID,
      });

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          this.pendingPermissions.delete(requestId);
          reject(new Error('Aborted'));
        }, { once: true });
      }
    });
  }

  /**
   * Resolve a pending permission request (called from IPC)
   */
  resolvePermission(requestId, result) {
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      this.pendingPermissions.delete(requestId);
      // Check that session is still alive before resolving — the SDK will try to
      // write the response to ProcessTransport which may already be closed.
      const session = this.sessions.get(pending.sessionId);
      if (!session) {
        console.warn(`[ChatService] Permission ${requestId} resolved but session ${pending.sessionId} already closed, ignoring`);
        return;
      }
      pending.resolve(result);
    }
  }

  /**
   * Enable always-allow mode for a session (auto-approve all permissions)
   */
  setAlwaysAllow(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.alwaysAllow = true;
    }
  }

  /**
   * Interrupt (not abort) the current turn. Preserves session.
   */
  interrupt(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.interrupting = true;
      if (session.queryStream?.interrupt) {
        session.queryStream.interrupt().catch(() => {});
      }
    }
  }

  /**
   * Change model mid-session via SDK queryStream.setModel()
   */
  async setModel(sessionId, model) {
    const session = this.sessions.get(sessionId);
    if (!session?.queryStream?.setModel) {
      throw new Error('Session not found or setModel not available');
    }
    await session.queryStream.setModel(model || undefined);
  }

  /**
   * Change effort (thinking budget) mid-session via SDK queryStream.setMaxThinkingTokens()
   * Maps effort levels to token budgets.
   */
  async setEffort(sessionId, effort) {
    const session = this.sessions.get(sessionId);
    if (!session?.queryStream?.setMaxThinkingTokens) {
      throw new Error('Session not found or setMaxThinkingTokens not available');
    }
    const effortMap = { low: 1024, medium: 8192, high: null };
    const tokens = effort in effortMap ? effortMap[effort] : null;
    await session.queryStream.setMaxThinkingTokens(tokens);
  }



  /**
   * Reject all pending permission requests for a session.
   * Called when the stream ends or errors to unblock the UI.
   */
  _rejectPendingPermissions(sessionId, reason) {
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.sessionId === sessionId) {
        this.pendingPermissions.delete(id);
        pending.reject(new Error(reason));
      }
    }
  }

  /**
   * Process the SDK query stream and forward all messages to renderer
   */
  async _processStream(sessionId, queryStream) {
    let msgCount = 0;
    const session = this.sessions.get(sessionId);
    try {
      for await (const message of queryStream) {
        msgCount++;
        this._send('chat-message', { sessionId, message });
      }
      this._send('chat-done', { sessionId });
    } catch (err) {
      const wasInterrupted = session?.interrupting
        || err.name === 'AbortError'
        || err.message === 'Aborted'
        || err.message?.includes('Request was aborted');
      if (wasInterrupted) {
        this._send('chat-done', { sessionId, aborted: true });
      } else {
        console.error(`[ChatService] Stream error after ${msgCount} msgs:`, err.message);
        const errorMsg = this._humanizeError(err.message);
        this._send('chat-error', { sessionId, error: errorMsg });
      }
    } finally {
      if (session) session.interrupting = false;
      this._rejectPendingPermissions(sessionId, 'Stream ended');
      // Mark session as stream-ended so closeSession won't emit duplicate session:closed
      if (session) session._streamEnded = true;
      // Notify remote clients that this session's stream has ended
      if (this._remoteEventCallback) {
        this._remoteEventCallback('session:closed', { sessionId });
      }
    }
  }

  /**
   * Convert raw SDK/process errors into user-friendly messages.
   */
  _humanizeError(raw) {
    if (!raw) return 'An unknown error occurred.';

    // Node.js not found
    if (raw.includes('ENOENT')) {
      return 'Node.js not found. Please install Node.js (https://nodejs.org) and restart the app.';
    }

    // SDK process crashed at startup (exit code 1, 0 messages)
    if (raw.includes('exited with code')) {
      const code = raw.match(/exited with code (\d+)/)?.[1] || '?';
      return `Claude Code process crashed (exit code ${code}). Please ensure Node.js is installed and up to date, then restart the app.\n\nIf the problem persists, try running "claude" in a terminal to check for errors.`;
    }

    // Process killed by signal
    if (raw.includes('terminated by signal')) {
      return 'Claude Code process was terminated unexpectedly. This may be caused by an antivirus or insufficient memory.';
    }

    // Executable not found
    if (raw.includes('executable not found') || raw.includes('not found at')) {
      return 'Claude Code SDK executable not found. Try reinstalling Claude Terminal.';
    }

    // Non-JSON output (usually startup crash with error printed to stdout)
    if (raw.includes('not valid JSON')) {
      return 'Claude Code failed to start properly. Please ensure you are logged in by running "claude" in a terminal.';
    }

    // Auth / API errors
    if (raw.includes('401') || raw.includes('Unauthorized') || raw.includes('authentication')) {
      return 'Authentication error. Please log in again by running "claude" in a terminal.';
    }

    // Rate limit
    if (raw.includes('429') || raw.includes('rate limit') || raw.includes('Too Many Requests')) {
      return 'Rate limit reached. Please wait a moment before trying again.';
    }

    // Network errors
    if (raw.includes('ECONNREFUSED') || raw.includes('ENOTFOUND') || raw.includes('ETIMEDOUT') || raw.includes('fetch failed')) {
      return 'Network error. Please check your internet connection and try again.';
    }

    return raw;
  }

  _safeSerialize(obj) {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch {
      return { _raw: String(obj) };
    }
  }

  // ── Persistent haiku naming session ──

  /**
   * Ensure the persistent haiku naming session is running.
   * One session for ALL tab rename requests — stays warm, near-instant after init.
   */
  async _ensureNamingSession() {
    if (this._namingReady) return;
    if (this._namingStarting) return this._namingStarting;

    this._namingStarting = (async () => {
      const sdk = await loadSDK();
      // No onIdle callback — we resolve directly from the stream
      this._namingQueue = createMessageQueue();

      const runtime = resolveRuntime();
      const stream = sdk.query({
        prompt: this._namingQueue.iterable,
        options: {
          maxTurns: 1,
          allowedTools: [],
          model: 'haiku',
          executable: runtime.executable,
          env: runtime.env,
          pathToClaudeCodeExecutable: getSdkCliPath(),
          systemPrompt: 'You generate very short tab titles (2-4 words, no quotes, no punctuation). Reply in the SAME language as the user message. Only output the title, nothing else.'
        }
      });

      // Process stream — resolve tab name directly when assistant responds
      (async () => {
        try {
          for await (const msg of stream) {
            if (msg.type === 'assistant' && msg.message?.content) {
              let text = '';
              for (const block of msg.message.content) {
                if (block.type === 'text') text += block.text;
              }
              if (text && this._namingResolve) {
                const resolve = this._namingResolve;
                this._namingResolve = null;
                resolve(text);
              }
            }
          }
        } catch (err) {
          console.error('[ChatService] Naming session error:', err.message);
        } finally {
          this._namingReady = false;
          this._namingStarting = null;
        }
      })();

      this._namingReady = true;
      this._namingStarting = null;
    })();

    return this._namingStarting;
  }

  /**
   * Generate a short tab name via the persistent haiku session.
   */
  async generateTabName(userMessage) {
    try {
      await this._ensureNamingSession();
      if (!this._namingQueue) return null;

      return new Promise((resolve) => {
        // Timeout: if haiku doesn't respond in 4s, give up
        const timeout = setTimeout(() => {
          this._namingResolve = null;
          resolve(null);
        }, 4000);

        this._namingResolve = (rawText) => {
          clearTimeout(timeout);
          const name = (rawText || '').trim().replace(/^["'`]+|["'`]+$/g, '').split('\n')[0].slice(0, 40);
          resolve(name || null);
        };

        try {
          this._namingQueue.push({
            type: 'user',
            message: { role: 'user', content: `Title for: "${userMessage.slice(0, 200)}"` }
          });
        } catch (pushErr) {
          // Transport died — reset naming session so next call recreates it
          console.error('[ChatService] Naming transport dead, resetting:', pushErr.message);
          this._namingReady = false;
          this._namingStarting = null;
          this._namingQueue = null;
          clearTimeout(timeout);
          resolve(null);
        }
      });
    } catch (err) {
      console.error('[ChatService] generateTabName error:', err.message);
      this._namingReady = false;
      this._namingStarting = null;
      return null;
    }
  }

  // ── Background skill/agent generation ──

  /**
   * Run a background SDK session to generate a skill or agent.
   * Does NOT forward messages to renderer — runs silently.
   * @param {Object} params
   * @param {'skill'|'agent'} params.type
   * @param {string} params.description
   * @param {string} params.cwd - Working directory for SDK context
   * @param {string} [params.model]
   * @returns {Promise<{success: boolean, type: string, error?: string, genId: string}>}
   */
  async generateSkillOrAgent({ type, description, cwd, model }) {
    const sdk = await loadSDK();
    const genId = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const abortController = new AbortController();

    // The SDK loads the skill guide (create-skill or create-agents) from ~/.claude/skills/
    // which are installed at app startup by installBundledSkills()
    const skillName = type === 'skill' ? 'create-skill' : 'create-agents';
    const prompt = `${description}\n\nCreate the files immediately without asking for clarification.`;

    const messageQueue = createMessageQueue();
    messageQueue.push({
      type: 'user',
      message: { role: 'user', content: prompt }
    });

    const prevClaudeCode = process.env.CLAUDECODE;
    delete process.env.CLAUDECODE;

    this.backgroundGenerations.set(genId, { abortController, type, description });

    try {
      const runtime = resolveRuntime();

      const queryStream = sdk.query({
        prompt: messageQueue.iterable,
        options: {
          cwd,
          abortController,
          maxTurns: 20,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          executable: runtime.executable,
          env: runtime.env,
          pathToClaudeCodeExecutable: getSdkCliPath(),
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          model: model || 'sonnet',
          skills: [skillName],
          disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'],
        }
      });

      // Consume stream silently
      for await (const _msg of queryStream) {
        // No-op — we just need to drive the async generator to completion
      }

      messageQueue.close();
      return { success: true, type, genId };
    } catch (err) {
      const wasCancelled = err.name === 'AbortError'
        || err.message === 'Aborted'
        || err.message?.includes('Request was aborted');
      if (wasCancelled) {
        return { success: false, type, error: 'Cancelled', genId };
      }
      console.error(`[ChatService] Background generation error:`, err.message);
      return { success: false, type, error: err.message, genId };
    } finally {
      messageQueue.close();
      this.backgroundGenerations.delete(genId);
      if (prevClaudeCode) process.env.CLAUDECODE = prevClaudeCode;
    }
  }

  /**
   * Cancel an in-progress background generation
   */
  cancelGeneration(genId) {
    const gen = this.backgroundGenerations.get(genId);
    if (gen) gen.abortController.abort();
  }

  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.abortController) session.abortController.abort();
      if (session.queryStream?.close) session.queryStream.close();
      if (session.messageQueue) session.messageQueue.close();
      // Reject pending permissions for this session
      for (const [id, pending] of this.pendingPermissions) {
        if (pending.sessionId === sessionId) {
          this.pendingPermissions.delete(id);
          pending.reject(new Error('Session closed'));
        }
      }
      const alreadyNotified = session._streamEnded;
      this.sessions.delete(sessionId);
      // Notify remote clients (skip if _processStream already sent session:closed)
      if (!alreadyNotified && this._remoteEventCallback) {
        this._remoteEventCallback('session:closed', { sessionId });
      }
    }
  }

  getActiveSessions() {
    const result = [];
    for (const [sessionId, session] of this.sessions) {
      if (!session._streamEnded) {
        result.push({ sessionId, cwd: session.cwd || null });
      }
    }
    return result;
  }

  getSessionInfo(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return { sessionId, cwd: session.cwd || null };
  }

  closeAll() {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      this.closeSession(id);
    }
    // Close naming session
    if (this._namingQueue) {
      this._namingQueue.close();
      this._namingReady = false;
    }
    // Cancel all background generations
    for (const [, gen] of this.backgroundGenerations) {
      gen.abortController.abort();
    }
    this.backgroundGenerations.clear();
    // Remove global listener to prevent memory leak
    if (this._unhandledRejectionHandler) {
      process.removeListener('unhandledRejection', this._unhandledRejectionHandler);
    }
  }
}

module.exports = new ChatService();
