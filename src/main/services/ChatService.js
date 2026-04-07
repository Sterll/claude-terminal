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

    // Catch SDK internal errors that bubble as unhandled rejections when
    // the underlying CLI process has already exited or the session was closed.
    this._unhandledRejectionHandler = (reason) => {
      const msg = reason?.message || '';
      if (msg.includes('ProcessTransport is not ready')
          || msg === 'Session closed'
          || msg === 'Aborted'
          || msg.includes('Request was aborted')) {
        console.warn(`[ChatService] Suppressed post-close rejection: ${msg}`);
        return;
      }
    };
    process.on('unhandledRejection', this._unhandledRejectionHandler);

    // Catch low-level stream errors (write EOF, EPIPE) that occur when the
    // Agent SDK subprocess exits while Node is still writing to its stdin.
    // These surface as uncaughtExceptions and would otherwise crash the app.
    this._uncaughtExceptionHandler = (err) => {
      const msg = err?.message || '';
      if (msg.includes('write EOF')
          || msg.includes('EPIPE')
          || msg.includes('write after end')
          || msg.includes('This socket has been ended')) {
        console.warn(`[ChatService] Suppressed stream exception: ${msg}`);
        return;
      }
      // Re-throw non-stream errors so Electron's default handler shows them
      throw err;
    };
    process.on('uncaughtException', this._uncaughtExceptionHandler);
  }

  setMainWindow(window) {
    this.mainWindow = window;
  }

  setRemoteEventCallback(fn) {
    this._remoteEventCallback = fn || null;
  }

  /**
   * Register a per-session message interceptor.
   * When set, messages for that sessionId are routed to the interceptor
   * instead of the main window. Used by WorkflowRunner agent steps.
   * @param {string} sessionId
   * @param {Function} fn - (channel, data) => void
   * @returns {Function} unregister function
   */
  addSessionInterceptor(sessionId, fn) {
    if (!this._sessionInterceptors) this._sessionInterceptors = new Map();
    this._sessionInterceptors.set(sessionId, fn);
    return () => this._sessionInterceptors.delete(sessionId);
  }

  _send(channel, data) {
    // Route to session interceptor if one is registered
    if (this._sessionInterceptors && data?.sessionId) {
      const interceptor = this._sessionInterceptors.get(data.sessionId);
      if (interceptor) {
        interceptor(channel, data);
        return;
      }
    }
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
  async startSession({ cwd, prompt, permissionMode = 'default', resumeSessionId = null, sessionId = null, images = [], mentions = [], model = null, enable1MContext = false, forkSession = false, resumeSessionAt = null, effort = null, outputFormat = null, skills = null, systemPrompt = null, settingSources = null, maxTurns = null, cloud = false, cloudProjectName = null }) {
    if (!sessionId) sessionId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Cloud session: delegate to cloud server instead of local SDK
    if (cloud && cloudProjectName) {
      return this._startCloudSession({ sessionId, prompt, cloudProjectName, model, effort });
    }

    // Notify renderer that session is initializing (runtime resolution can take a few seconds)
    this._send('chat-initializing', { sessionId });

    const sdk = await loadSDK();

    const messageQueue = createMessageQueue(() => {
      this._send('chat-idle', { sessionId });
    });

    // Always push initial prompt (even for resume — SDK needs a message to process)
    const hasImages = images && images.length > 0;
    const hasMentions = mentions && mentions.length > 0;
    if (prompt || hasImages || hasMentions) {
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
      const effectiveCwd = cwd || require('os').homedir();

      const options = {
        cwd: effectiveCwd,
        abortController,
        maxTurns: maxTurns || 100,
        includePartialMessages: true,
        permissionMode,
        executable: runtime.executable,
        env: runtime.env,
        pathToClaudeCodeExecutable: getSdkCliPath(),
        systemPrompt: systemPrompt || { type: 'preset', preset: 'claude_code' },
        settingSources: settingSources !== null ? settingSources : ['user', 'project', 'local'],
        canUseTool: async (toolName, input, opts) => {
          return this._handlePermission(sessionId, toolName, input, opts);
        },
        stderr: (data) => {
          console.error(`[ChatService][stderr] ${data}`);
          // Accumulate stderr per session for better error diagnostics
          const s = this.sessions.get(sessionId);
          if (s) {
            s._stderr = (s._stderr || '') + data;
            // Cap at 4 KB to avoid memory leaks
            if (s._stderr.length > 4096) s._stderr = s._stderr.slice(-4096);
          }
        }
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

      // Structured output format (JSON schema)
      if (outputFormat) {
        options.outputFormat = outputFormat;
      }

      // Skills to load into the session
      if (skills && skills.length) {
        options.skills = skills;
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
        _stderr: '',
      });

      this._processStream(sessionId, queryStream);
      return sessionId;
    } catch (err) {
      console.error(`[ChatService] startSession error (cwd: ${cwd}, perm: ${permissionMode}):`, err.message, err.stack);
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

    if (session.isCloud) {
      this._sendCloudMessage(session, text);
      return;
    }

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
    const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingPermissions.has(requestId)) {
          this.pendingPermissions.delete(requestId);
          console.warn(`[ChatService] Permission ${requestId} timed out after 5 minutes, denying`);
          resolve({ behavior: 'deny' });
        }
      }, PERMISSION_TIMEOUT_MS);

      this.pendingPermissions.set(requestId, { resolve, reject, sessionId, timeoutId });

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
          clearTimeout(timeoutId);
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
      clearTimeout(pending.timeoutId);
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
    if (!session) return;

    if (session.isCloud) {
      this._interruptCloudSession(session);
      return;
    }

    session.interrupting = true;
    if (session.queryStream?.interrupt) {
      session.queryStream.interrupt().catch(() => {});
    }
  }

  /**
   * Change model mid-session via SDK queryStream.setModel()
   */
  async setModel(sessionId, model) {
    const session = this.sessions.get(sessionId);
    if (session?.isCloud) throw new Error('Model changes not supported for cloud sessions');
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
    if (session?.isCloud) throw new Error('Effort changes not supported for cloud sessions');
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
        // Swallow unhandled rejection before rejecting — the promise may not
        // have a .catch() handler attached yet, which would crash on Node 18+.
        pending.promise?.catch?.(() => {});
        try {
          pending.reject(new Error(reason));
        } catch (e) {
          // Already settled, ignore
        }
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
        this._send('chat-done', { sessionId, interrupted: true });
      } else {
        const stderrLog = session?._stderr || '';
        console.error(`[ChatService] Stream error after ${msgCount} msgs:`, err.message, stderrLog ? `\nstderr: ${stderrLog}` : '');
        let errorMsg = this._humanizeError(err.message);
        // Append stderr details for crash diagnostics (exit code errors)
        if (stderrLog && err.message?.includes('exited with code')) {
          errorMsg += `\n\nDetails: ${stderrLog.trim().slice(0, 500)}`;
        }
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

    // ENOENT — distinguish between spawn failures and file-not-found
    if (raw.includes('ENOENT')) {
      // Spawn failure (executable not found)
      if (raw.includes('spawn') || /ENOENT.*node|node.*ENOENT/i.test(raw) || /ENOENT.*bun|bun.*ENOENT/i.test(raw)) {
        return 'Node.js not found. Please install Node.js (https://nodejs.org) and restart the app.';
      }
      // File/directory not found — extract path if possible
      const pathMatch = raw.match(/ENOENT[^']*'([^']+)'/);
      const detail = pathMatch ? `: ${pathMatch[1]}` : '';
      return `File or directory not found${detail}. ${raw}`;
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

    // Stream/pipe errors (subprocess died mid-write)
    if (raw.includes('write EOF') || raw.includes('EPIPE') || raw.includes('write after end')) {
      return 'Claude Code process disconnected unexpectedly. Please try again.';
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
    // Queue: wait for any in-flight naming request to finish before starting ours
    if (this._namingInFlight) {
      await this._namingInFlight.catch(() => {});
    }

    const task = (async () => {
      try {
        await this._ensureNamingSession();
        if (!this._namingQueue) return null;

        return await new Promise((resolve) => {
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
    })();

    this._namingInFlight = task;
    try {
      return await task;
    } finally {
      if (this._namingInFlight === task) {
        this._namingInFlight = null;
      }
    }
  }

  // ── Prompt enhancement via Haiku ──

  /**
   * Ensure the persistent haiku prompt-enhancement session is running.
   * Same warm-session pattern as naming/suggestions.
   */
  async _ensureEnhanceSession() {
    if (this._enhanceReady) return;
    if (this._enhanceStarting) return this._enhanceStarting;

    this._enhanceStarting = (async () => {
      const sdk = await loadSDK();
      this._enhanceQueue = createMessageQueue();

      const runtime = resolveRuntime();
      const stream = sdk.query({
        prompt: this._enhanceQueue.iterable,
        options: {
          maxTurns: 1,
          allowedTools: [],
          model: 'haiku',
          executable: runtime.executable,
          env: runtime.env,
          pathToClaudeCodeExecutable: getSdkCliPath(),
          systemPrompt: [
            'You are a prompt engineering expert. Your job is to reformulate user prompts to be clearer, more specific, and better structured for an AI coding assistant (Claude Code).',
            '',
            'Rules:',
            '- Keep the EXACT same intent and requirements',
            '- Add structure (steps, constraints, expected output) when helpful',
            '- Clarify ambiguous parts',
            '- Reply in the SAME language as the input',
            '- Output ONLY the enhanced prompt, nothing else (no preamble, no explanation)',
            '- If the prompt is already well-structured, return it as-is with minimal changes',
            '- Do NOT add requirements the user did not ask for',
            '- Keep it concise - do not bloat simple requests',
          ].join('\n')
        }
      });

      (async () => {
        try {
          for await (const msg of stream) {
            if (msg.type === 'assistant' && msg.message?.content) {
              let text = '';
              for (const block of msg.message.content) {
                if (block.type === 'text') text += block.text;
              }
              if (text && this._enhanceResolve) {
                const resolve = this._enhanceResolve;
                this._enhanceResolve = null;
                resolve(text);
              }
            }
          }
        } catch (err) {
          console.error('[ChatService] Enhance session error:', err.message);
        } finally {
          this._enhanceReady = false;
          this._enhanceStarting = null;
        }
      })();

      this._enhanceReady = true;
      this._enhanceStarting = null;
    })();

    return this._enhanceStarting;
  }

  /**
   * Enhance a user prompt via the persistent haiku session.
   * Returns the enhanced text, or the original on failure/timeout.
   */
  async enhancePrompt(text) {
    if (!text || text.trim().length < 5) return text; // Too short to enhance

    if (this._enhanceInFlight) {
      await this._enhanceInFlight.catch(() => {});
    }

    const task = (async () => {
      try {
        await this._ensureEnhanceSession();
        if (!this._enhanceQueue) return text;

        return await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            this._enhanceResolve = null;
            resolve(text); // Fallback to original
          }, 5000);

          this._enhanceResolve = (rawText) => {
            clearTimeout(timeout);
            const enhanced = (rawText || '').trim();
            resolve(enhanced || text);
          };

          try {
            this._enhanceQueue.push({
              type: 'user',
              message: { role: 'user', content: text }
            });
          } catch (pushErr) {
            console.error('[ChatService] Enhance transport dead, resetting:', pushErr.message);
            this._enhanceReady = false;
            this._enhanceStarting = null;
            this._enhanceQueue = null;
            clearTimeout(timeout);
            resolve(text);
          }
        });
      } catch (err) {
        console.error('[ChatService] enhancePrompt error:', err.message);
        this._enhanceReady = false;
        this._enhanceStarting = null;
        return text;
      }
    })();

    this._enhanceInFlight = task;
    try {
      return await task;
    } finally {
      if (this._enhanceInFlight === task) {
        this._enhanceInFlight = null;
      }
    }
  }

  // ── Follow-up suggestion generation ──

  /**
   * Ensure the persistent suggestion session is running.
   * Reuses the same pattern as the naming session (single warm Haiku session).
   */
  async _ensureSuggestionSession() {
    if (this._suggestionReady) return;
    if (this._suggestionStarting) return this._suggestionStarting;

    this._suggestionStarting = (async () => {
      const sdk = await loadSDK();
      this._suggestionQueue = createMessageQueue();

      const runtime = resolveRuntime();
      const stream = sdk.query({
        prompt: this._suggestionQueue.iterable,
        options: {
          maxTurns: 1,
          allowedTools: [],
          model: 'haiku',
          executable: runtime.executable,
          env: runtime.env,
          pathToClaudeCodeExecutable: getSdkCliPath(),
          systemPrompt: [
            'You generate 2-3 short follow-up message suggestions for a developer chatting with Claude Code.',
            'Each suggestion should be a concrete, actionable developer question or instruction (max 8 words).',
            'Output ONLY a JSON array of strings, nothing else. Example: ["Explain this in detail","Give me an example","How do I test this?"]',
            'Vary the suggestions: one can go deeper, one can ask for an example, one can ask for a different approach.',
            'When project context is provided (name, type), tailor suggestions to that specific project domain.',
            'Reply in the SAME language as the conversation.',
          ].join(' ')
        }
      });

      (async () => {
        try {
          for await (const msg of stream) {
            if (msg.type === 'assistant' && msg.message?.content) {
              let text = '';
              for (const block of msg.message.content) {
                if (block.type === 'text') text += block.text;
              }
              if (text && this._suggestionResolve) {
                const resolve = this._suggestionResolve;
                this._suggestionResolve = null;
                resolve(text);
              }
            }
          }
        } catch (err) {
          console.error('[ChatService] Suggestion session error:', err.message);
        } finally {
          this._suggestionReady = false;
          this._suggestionStarting = null;
        }
      })();

      this._suggestionReady = true;
      this._suggestionStarting = null;
    })();

    return this._suggestionStarting;
  }

  /**
   * Generate 2-3 follow-up suggestions based on the last assistant message.
   * @param {string} lastAssistantText - The last assistant response text (truncated)
   * @param {string} lastUserText - The last user message for context
   * @returns {Promise<string[]>} Array of suggestion strings, or []
   */
  async generateSuggestions(lastAssistantText, lastUserText, projectContext) {
    try {
      await this._ensureSuggestionSession();
      if (!this._suggestionQueue) return [];

      return new Promise((resolve) => {
        // Reject any stale pending suggestion request (race condition: new request while old is waiting)
        if (this._suggestionResolve) {
          const staleResolve = this._suggestionResolve;
          this._suggestionResolve = null;
          staleResolve(null);
        }

        const timeout = setTimeout(() => {
          this._suggestionResolve = null;
          resolve([]);
        }, 6000);

        this._suggestionResolve = (rawText) => {
          clearTimeout(timeout);
          try {
            // Extract JSON array from the response
            const match = rawText.match(/\[[\s\S]*\]/);
            if (!match) { resolve([]); return; }
            const arr = JSON.parse(match[0]);
            if (!Array.isArray(arr)) { resolve([]); return; }
            const suggestions = arr
              .filter(s => typeof s === 'string' && s.trim().length > 0)
              .map(s => s.trim().slice(0, 80))
              .slice(0, 3);
            resolve(suggestions);
          } catch {
            resolve([]);
          }
        };

        try {
          const contextParts = [];
          if (projectContext) {
            const pCtx = [`Project: "${projectContext.name}"`];
            if (projectContext.type && projectContext.type !== 'general') pCtx.push(`type: ${projectContext.type}`);
            contextParts.push(pCtx.join(', '));
          }
          if (lastUserText) contextParts.push(`User asked: "${lastUserText.slice(0, 150)}"`);
          contextParts.push(`Claude replied: "${lastAssistantText.slice(0, 300)}"`);
          const context = contextParts.filter(Boolean).join('\n');
          this._suggestionQueue.push({
            type: 'user',
            message: { role: 'user', content: `Generate follow-up suggestions for this exchange:\n${context}` }
          });
        } catch (pushErr) {
          console.error('[ChatService] Suggestion transport dead, resetting:', pushErr.message);
          this._suggestionReady = false;
          this._suggestionStarting = null;
          this._suggestionQueue = null;
          clearTimeout(timeout);
          resolve([]);
        }
      });
    } catch (err) {
      console.error('[ChatService] generateSuggestions error:', err.message);
      this._suggestionReady = false;
      this._suggestionStarting = null;
      return [];
    }
  }

  // ── Background skill/agent generation ──

  /**
   * Run a background SDK session to generate a skill or agent.
   * Forwards progress messages to renderer via IPC events.
   * @param {Object} params
   * @param {'skill'|'agent'} params.type
   * @param {string} params.description
   * @param {string} params.cwd - Working directory for SDK context
   * @param {string} [params.model]
   * @param {string} params.genId - Unique generation ID (provided by IPC handler)
   * @returns {Promise<{success: boolean, type: string, error?: string, genId: string}>}
   */
  async generateSkillOrAgent({ type, description, cwd, model, genId }) {
    const sdk = await loadSDK();
    const abortController = new AbortController();

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

      // Forward progress messages to renderer
      for await (const msg of queryStream) {
        const summary = this._summarizeGenMessage(msg);
        if (summary) {
          this._send('chat-generation-progress', { genId, message: summary });
        }
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
   * Extract a lightweight progress summary from an SDK stream message.
   */
  _summarizeGenMessage(msg) {
    if (!msg) return null;

    if (msg.type === 'system' && msg.subtype === 'init') {
      return { step: 'init', text: 'Initializing...' };
    }
    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            return { step: 'tool', tool: block.name, text: `Using ${block.name}...` };
          }
          if (block.type === 'text' && block.text) {
            return { step: 'thinking', text: block.text.substring(0, 120) };
          }
        }
      }
    }
    if (msg.type === 'result') {
      return { step: 'done', text: 'Generation complete' };
    }
    return null;
  }

  /**
   * Run a single prompt through the SDK (no streaming input, no session to manage).
   * Used by WorkflowRunner for Claude/agent steps — the stream terminates on its own.
   * @param {Object} opts - { cwd, prompt, model, effort, maxTurns, permissionMode, outputFormat, skills, onMessage, signal }
   * @returns {Promise<{ output: string, success: boolean, ... }>}
   */
  async runSinglePrompt({ cwd, prompt, model, effort, maxTurns, permissionMode, outputFormat, skills, systemPrompt, disallowedTools, onMessage, onOutput, signal }) {
    const sdk = await loadSDK();
    const runtime = resolveRuntime();

    const abortController = new AbortController();
    if (signal) {
      signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    // Remove CLAUDECODE env to avoid nested session detection
    const prevClaudeCode = process.env.CLAUDECODE;
    delete process.env.CLAUDECODE;

    const resolvedCwd = cwd || require('os').homedir();
    let workflowSessionId = null;

    try {
      const options = {
        cwd: resolvedCwd,
        abortController,
        maxTurns: maxTurns || 30,
        permissionMode: permissionMode || 'bypassPermissions',
        executable: runtime.executable,
        env: runtime.env,
        pathToClaudeCodeExecutable: getSdkCliPath(),
        systemPrompt: systemPrompt || { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
      };

      if (model) options.model = model;
      if (effort) options.effort = effort;
      if (outputFormat) options.outputFormat = outputFormat;
      if (skills?.length) options.skills = skills;
      if (disallowedTools?.length) options.disallowedTools = disallowedTools;

      const queryStream = sdk.query({ prompt, options });

      let stdout = '';
      let structuredOutput = null;

      for await (const message of queryStream) {
        if (onMessage) onMessage(message);
        // Capture the SDK session_id from the init message to delete it after
        if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
          workflowSessionId = message.session_id;
        }
        if (message.type === 'assistant') {
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                stdout += block.text;
                if (onOutput) onOutput(block.text);
              }
            }
          }
        }
        if (message.type === 'result') {
          if (message.structured_output) structuredOutput = message.structured_output;
          // Fallback: if no text blocks were captured, use the result's text field
          if (!stdout && message.result && typeof message.result === 'string') {
            stdout = message.result;
          }
        }
      }

      const result = { output: stdout.trim(), success: true };
      if (structuredOutput && typeof structuredOutput === 'object') {
        Object.assign(result, structuredOutput);
      }
      return result;
    } finally {
      if (prevClaudeCode) process.env.CLAUDECODE = prevClaudeCode;
      // Delete the session file created by this workflow step to avoid polluting
      // the "Resume conversation" list — workflow runs are fire-and-forget
      if (workflowSessionId) {
        _deleteWorkflowSession(resolvedCwd, workflowSessionId);
      }
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
    if (!session) return;

    if (session.isCloud) {
      this._closeCloudSession(sessionId, session);
      return;
    }

    if (session.abortController) session.abortController.abort();
    if (session.queryStream?.close) session.queryStream.close();
    if (session.messageQueue) session.messageQueue.close();
    // Reject pending permissions for this session (wrap in try/catch
    // to prevent unhandled rejections if the SDK transport is gone)
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.sessionId === sessionId) {
        this.pendingPermissions.delete(id);
        try { pending.reject(new Error('Session closed')); } catch (_) {}
      }
    }
    const alreadyNotified = session._streamEnded;
    this.sessions.delete(sessionId);
    // Notify remote clients (skip if _processStream already sent session:closed)
    if (!alreadyNotified && this._remoteEventCallback) {
      this._remoteEventCallback('session:closed', { sessionId });
    }
  }

  // ── Cloud session methods ──

  async _startCloudSession({ sessionId, prompt, cloudProjectName, model, effort }) {
    const { _getCloudConfig, _fetchCloud } = require('../ipc/cloud-shared');
    const WebSocket = require('ws');

    this._send('chat-initializing', { sessionId });

    const { url, key } = _getCloudConfig();

    // Create cloud session via REST
    const resp = await _fetchCloud(`${url}/api/sessions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectName: cloudProjectName,
        prompt,
        model: model || undefined,
        effort: effort || undefined,
      }),
    }, 30000);

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Cloud session failed: ${resp.status} ${body.slice(0, 200)}`);
    }

    const { sessionId: cloudSessionId } = await resp.json();

    // Connect WebSocket for streaming
    const wsUrl = url.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsUrl}/api/sessions/${cloudSessionId}/stream?token=${key}`);

    const session = {
      isCloud: true,
      cloudSessionId,
      cloudProjectName,
      ws,
      alwaysAllow: true,
      cwd: null,
      _streamEnded: false,
    };
    this.sessions.set(sessionId, session);

    ws.on('open', () => {
      console.log(`[ChatService] Cloud WS connected for session ${sessionId}`);
    });

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        this._handleCloudMessage(sessionId, data);
      } catch (e) {
        console.error('[ChatService] Cloud WS parse error:', e.message);
      }
    });

    ws.on('close', (code) => {
      if (!session._streamEnded) {
        session._streamEnded = true;
        if (code === 1000) {
          this._send('chat-done', { sessionId });
        } else {
          this._send('chat-error', { sessionId, error: `Cloud connection closed (code ${code})` });
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[ChatService] Cloud WS error:', err.message);
      if (!session._streamEnded) {
        session._streamEnded = true;
        this._send('chat-error', { sessionId, error: `Cloud connection error: ${err.message}` });
      }
    });

    return sessionId;
  }

  _handleCloudMessage(sessionId, data) {
    const session = this.sessions.get(sessionId);
    switch (data.type) {
      case 'event':
        this._send('chat-message', { sessionId, message: data.event });
        break;
      case 'idle':
        this._send('chat-idle', { sessionId });
        break;
      case 'done':
        if (session) session._streamEnded = true;
        this._send('chat-done', { sessionId });
        break;
      case 'error':
        if (session) session._streamEnded = true;
        this._send('chat-error', { sessionId, error: data.error || 'Cloud session error' });
        break;
    }
  }

  async _sendCloudMessage(session, text) {
    const { _getCloudConfig, _fetchCloud } = require('../ipc/cloud-shared');
    const { url, key } = _getCloudConfig();
    const resp = await _fetchCloud(`${url}/api/sessions/${session.cloudSessionId}/send`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Failed to send cloud message: ${body.slice(0, 200)}`);
    }
  }

  async _interruptCloudSession(session) {
    try {
      const { _getCloudConfig, _fetchCloud } = require('../ipc/cloud-shared');
      const { url, key } = _getCloudConfig();
      await _fetchCloud(`${url}/api/sessions/${session.cloudSessionId}/interrupt`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error('[ChatService] Cloud interrupt error:', err.message);
    }
  }

  _closeCloudSession(sessionId, session) {
    // Close WebSocket
    if (session.ws) {
      session.ws.removeAllListeners();
      session.ws.close(1000);
    }
    this.sessions.delete(sessionId);
    // Delete cloud session in background
    const { _getCloudConfig, _fetchCloud } = require('../ipc/cloud-shared');
    try {
      const { url, key } = _getCloudConfig();
      _fetchCloud(`${url}/api/sessions/${session.cloudSessionId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${key}` },
      }).catch(err => console.warn('[ChatService] Cloud session cleanup error:', err.message));
    } catch (_) {}
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
    if (this._namingResolve) {
      this._namingResolve(null);
      this._namingResolve = null;
    }
    // Close suggestion session
    if (this._suggestionResolve) {
      this._suggestionResolve(null);
      this._suggestionResolve = null;
    }
    if (this._suggestionQueue) {
      this._suggestionQueue.close();
      this._suggestionQueue = null;
      this._suggestionReady = false;
    }
    // Cancel all background generations
    for (const [, gen] of this.backgroundGenerations) {
      gen.abortController.abort();
    }
    this.backgroundGenerations.clear();
    // Remove global listeners to prevent memory leak
    if (this._unhandledRejectionHandler) {
      process.removeListener('unhandledRejection', this._unhandledRejectionHandler);
    }
    if (this._uncaughtExceptionHandler) {
      process.removeListener('uncaughtException', this._uncaughtExceptionHandler);
    }
  }

  /**
   * Analyze a chat session conversation and suggest CLAUDE.md updates.
   * @param {Array<{role: string, content: string}>} messages - Conversation messages
   * @param {string} projectPath - Absolute path to the project
   * @returns {Promise<{suggestions: Array, claudeMdExists: boolean}>}
   */
  async analyzeSessionForClaudeMd(messages, projectPath) {
    // Read existing CLAUDE.md (or empty string if not found)
    const claudeMdPath = require('path').join(projectPath, 'CLAUDE.md');
    let existingContent = '';
    try {
      existingContent = require('fs').readFileSync(claudeMdPath, 'utf8');
    } catch { /* file doesn't exist */ }

    const claudeMdExists = existingContent.trim().length > 0;

    // Truncate to last 50 messages to stay within token limits
    const truncated = messages.slice(-50);

    // Build conversation text (skip very long tool outputs)
    const conversationText = truncated.map(m => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const truncContent = content.length > 2000 ? content.slice(0, 2000) + '...' : content;
      return `${m.role.toUpperCase()}: ${truncContent}`;
    }).join('\n\n');

    if (!conversationText.trim()) return { suggestions: [], claudeMdExists };

    const prompt = `You are analyzing a conversation between a user and Claude Code (an AI coding assistant).
Your goal: identify useful discoveries about the PROJECT that would help future Claude sessions.

Existing CLAUDE.md content (may be empty):
<existing_claude_md>
${existingContent || '(empty — file does not exist yet)'}
</existing_claude_md>

Conversation:
<conversation>
${conversationText}
</conversation>

Instructions:
- Identify 0-5 useful discoveries about the project (architecture, conventions, commands, dependencies, patterns, important files, gotchas).
- ONLY include information NOT already covered in the existing CLAUDE.md.
- Focus on facts that would help Claude work faster in future sessions on this project.
- Be concise. Each content block should be 1-5 lines of markdown.
- Return ONLY a valid JSON array, no other text:

[
  {
    "title": "Short title (5-8 words)",
    "section": "## Section Heading",
    "content": "Markdown content to add"
  }
]

If there are no new useful discoveries, return exactly: []`;

    try {
      // Use the Anthropic API key from Claude CLI credentials
      const claudeDir = process.env.CLAUDE_CONFIG_DIR || require('path').join(require('os').homedir(), '.claude');
      const credPath = require('path').join(claudeDir, '.credentials.json');
      let apiKey = null;
      try {
        const creds = JSON.parse(require('fs').readFileSync(credPath, 'utf8'));
        const oauthCreds = creds.claudeAiOauth;
        if (oauthCreds?.accessToken) {
          // Check token expiry (with 60s buffer)
          if (!oauthCreds.expiresAt || oauthCreds.expiresAt > Date.now() + 60000) {
            apiKey = oauthCreds.accessToken;
          }
        } else {
          apiKey = creds.accessToken || null;
        }
      } catch { /* no credentials */ }

      if (!apiKey) {
        console.warn('[ChatService] No Anthropic credentials found for CLAUDE.md analysis');
        return { suggestions: [], claudeMdExists };
      }

      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 15000);
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: abortController.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`[ChatService] CLAUDE.md analysis API error: ${response.status}`);
        return { suggestions: [], claudeMdExists };
      }

      const data = await response.json();
      const text = data.content?.[0]?.text || '[]';

      // Parse JSON safely
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return { suggestions: [], claudeMdExists };

      const suggestions = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(suggestions)) return { suggestions: [], claudeMdExists };

      // Validate structure
      const valid = suggestions.filter(s =>
        s && typeof s.title === 'string' && typeof s.section === 'string' && typeof s.content === 'string'
      );

      return { suggestions: valid, claudeMdExists };
    } catch (err) {
      console.warn('[ChatService] CLAUDE.md analysis failed:', err.message);
      return { suggestions: [], claudeMdExists };
    }
  }

  /**
   * Apply selected CLAUDE.md sections to the project.
   * Creates CLAUDE.md if it doesn't exist, appends sections otherwise.
   * @param {string} projectPath
   * @param {Array<{section: string, content: string}>} sections
   */
  applyClaudeMdSections(projectPath, sections) {
    if (!sections || sections.length === 0) return { success: true };

    const fs = require('fs');
    const path = require('path');
    const claudeMdPath = path.join(projectPath, 'CLAUDE.md');

    try {
      let existing = '';
      try { existing = fs.readFileSync(claudeMdPath, 'utf8'); } catch { /* new file */ }

      const toAppend = sections.map(s => `\n${s.section}\n\n${s.content}`).join('\n');
      const newContent = existing
        ? existing.trimEnd() + '\n' + toAppend + '\n'
        : toAppend.trimStart() + '\n';

      const tempPath = claudeMdPath + '.tmp';
      fs.writeFileSync(tempPath, newContent, 'utf8');
      fs.renameSync(tempPath, claudeMdPath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Analyze a chat session for workspace knowledge base enrichment.
   * Reads existing docs, asks Haiku to suggest new docs or updates.
   * @param {Array} messages - conversation history
   * @param {Object} workspace - { id, name, description }
   * @param {Array} existingDocs - [{ title, summary }]
   * @returns {{ suggestions: Array<{ title, content, isUpdate }> }}
   */
  async analyzeSessionForWorkspace(messages, workspace, existingDocs) {
    const truncated = messages.slice(-50);
    const conversationText = truncated.map(m => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const truncContent = content.length > 2000 ? content.slice(0, 2000) + '...' : content;
      return `${m.role.toUpperCase()}: ${truncContent}`;
    }).join('\n\n');

    if (!conversationText.trim()) return { suggestions: [] };

    const docsContext = existingDocs.length > 0
      ? existingDocs.map(d => `- "${d.title}": ${d.summary || '(no summary)'}`).join('\n')
      : '(no docs yet)';

    const prompt = `You are analyzing a conversation between a user and Claude Code (an AI coding assistant).
This conversation happened in the context of workspace "${workspace.name}" (${workspace.description || 'no description'}).

Existing knowledge base docs:
${docsContext}

Conversation:
<conversation>
${conversationText}
</conversation>

Instructions:
- Identify 0-3 pieces of knowledge that should be saved to the workspace knowledge base.
- Focus on: architecture decisions, API contracts, deployment procedures, conventions, important discoveries.
- If a doc already exists on the topic, suggest an UPDATE with the new information appended.
- If it's a new topic, suggest a NEW doc.
- Be concise. Each content should be useful markdown (3-15 lines).
- Return ONLY a valid JSON array:

[
  {
    "title": "Doc title",
    "content": "Markdown content",
    "isUpdate": false
  }
]

If there are no useful discoveries, return exactly: []`;

    try {
      const claudeDir = process.env.CLAUDE_CONFIG_DIR || require('path').join(require('os').homedir(), '.claude');
      const credPath = require('path').join(claudeDir, '.credentials.json');
      let apiKey = null;
      try {
        const creds = JSON.parse(require('fs').readFileSync(credPath, 'utf8'));
        const oauthCreds = creds.claudeAiOauth;
        if (oauthCreds?.accessToken) {
          if (!oauthCreds.expiresAt || oauthCreds.expiresAt > Date.now() + 60000) {
            apiKey = oauthCreds.accessToken;
          }
        } else {
          apiKey = creds.accessToken || null;
        }
      } catch { /* no credentials */ }

      if (!apiKey) {
        console.warn('[ChatService] No credentials for workspace enrichment');
        return { suggestions: [] };
      }

      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 15000);
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: abortController.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`[ChatService] Workspace enrichment API error: ${response.status}`);
        return { suggestions: [] };
      }

      const data = await response.json();
      const text = data.content?.[0]?.text || '[]';

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return { suggestions: [] };

      const suggestions = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(suggestions)) return { suggestions: [] };

      const valid = suggestions.filter(s =>
        s && typeof s.title === 'string' && typeof s.content === 'string'
      );

      return { suggestions: valid };
    } catch (err) {
      console.warn('[ChatService] Workspace enrichment failed:', err.message);
      return { suggestions: [] };
    }
  }

  destroy() {
    if (this._unhandledRejectionHandler) {
      process.removeListener('unhandledRejection', this._unhandledRejectionHandler);
      this._unhandledRejectionHandler = null;
    }
    if (this._uncaughtExceptionHandler) {
      process.removeListener('uncaughtException', this._uncaughtExceptionHandler);
      this._uncaughtExceptionHandler = null;
    }
  }
}

/**
 * Delete the .jsonl session file created by a workflow agent step.
 * Claude stores sessions at ~/.claude/projects/{encoded_cwd}/{session_id}.jsonl
 * We capture the session_id from the SDK's system:init message and clean up
 * after the step completes so workflow runs don't pollute "Resume conversation".
 */
function _deleteWorkflowSession(cwd, sessionId) {
  try {
    const os = require('os');
    const encoded = cwd.replace(/:/g, '-').replace(/\\/g, '-').replace(/\//g, '-');
    const sessionFile = require('path').join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
    if (require('fs').existsSync(sessionFile)) {
      require('fs').unlinkSync(sessionFile);
      console.log(`[ChatService] Deleted workflow session file: ${sessionId}.jsonl`);
    }
  } catch (e) {
    console.warn(`[ChatService] Could not delete workflow session file: ${e.message}`);
  }
}

module.exports = new ChatService();
