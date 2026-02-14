/**
 * ChatService - Claude Agent SDK Wrapper
 * Manages chat sessions using streaming input mode for multi-turn conversations.
 * Handles permissions via canUseTool callback, forwarding to renderer.
 */

let sdkPromise = null;

async function loadSDK() {
  if (!sdkPromise) {
    sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  }
  return sdkPromise;
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
    /** @type {BrowserWindow|null} */
    this.mainWindow = null;
  }

  setMainWindow(window) {
    this.mainWindow = window;
  }

  _send(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
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
  async startSession({ cwd, prompt, permissionMode = 'default', resumeSessionId = null, sessionId = null }) {
    const sdk = await loadSDK();
    if (!sessionId) sessionId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    console.log(`[ChatService] startSession — cwd: ${cwd}, resume: ${resumeSessionId || 'none'}`);

    const messageQueue = createMessageQueue(() => {
      console.log(`[ChatService] onIdle — sessionId: ${sessionId}`);
      this._send('chat-idle', { sessionId });
    });

    // Always push initial prompt (even for resume — SDK needs a message to process)
    if (prompt) {
      messageQueue.push({
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
        session_id: sessionId
      });
    }

    const abortController = new AbortController();

    // Remove CLAUDECODE env to avoid nested session detection
    const prevClaudeCode = process.env.CLAUDECODE;
    delete process.env.CLAUDECODE;

    try {
      const options = {
        cwd,
        abortController,
        maxTurns: 100,
        includePartialMessages: true,
        permissionMode,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        canUseTool: async (toolName, input, opts) => {
          return this._handlePermission(sessionId, toolName, input, opts);
        },
        stderr: (data) => {
          console.log(`[ChatService:stderr] ${data.trim()}`);
        }
      };

      // Resume existing session if requested
      if (resumeSessionId) {
        options.resume = resumeSessionId;
        console.log(`[ChatService] Resuming SDK session: ${resumeSessionId}`);
      }

      const queryStream = sdk.query({
        prompt: messageQueue.iterable,
        options,
      });

      console.log(`[ChatService] query() called, stream created — internal sessionId: ${sessionId}`);

      this.sessions.set(sessionId, {
        abortController,
        messageQueue,
        queryStream,
      });

      this._processStream(sessionId, queryStream);
      return sessionId;
    } catch (err) {
      console.error(`[ChatService] startSession error:`, err.message);
      this.sessions.delete(sessionId);
      throw err;
    } finally {
      if (prevClaudeCode) {
        process.env.CLAUDECODE = prevClaudeCode;
      }
    }
  }

  /**
   * Send a follow-up message (push to async iterable queue)
   */
  sendMessage(sessionId, text) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.messageQueue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: sessionId
    });
  }

  /**
   * Handle permission request from SDK's canUseTool callback.
   * Forwards to renderer and waits for user response.
   */
  async _handlePermission(sessionId, toolName, input, options) {
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
      pending.resolve(result);
    }
  }

  /**
   * Interrupt (not abort) the current turn. Preserves session.
   */
  interrupt(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session?.queryStream?.interrupt) {
      session.queryStream.interrupt().catch(() => {});
    }
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
    try {
      for await (const message of queryStream) {
        msgCount++;
        const sub = message.subtype || '';
        const replay = message.isReplay ? ' [REPLAY]' : '';
        console.log(`[ChatService] msg #${msgCount} type=${message.type}${sub ? '/' + sub : ''}${replay}`);
        this._send('chat-message', { sessionId, message });
      }
      console.log(`[ChatService] Stream done — ${msgCount} messages total`);
      this._send('chat-done', { sessionId });
    } catch (err) {
      if (err.name === 'AbortError' || err.message === 'Aborted') {
        console.log(`[ChatService] Stream aborted after ${msgCount} messages`);
        this._send('chat-done', { sessionId, aborted: true });
      } else {
        console.error(`[ChatService] Stream error after ${msgCount} msgs:`, err.message);
        this._send('chat-error', { sessionId, error: err.message });
      }
    } finally {
      this._rejectPendingPermissions(sessionId, 'Stream ended');
    }
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

      const stream = sdk.query({
        prompt: this._namingQueue.iterable,
        options: {
          maxTurns: 1,
          allowedTools: [],
          model: 'haiku',
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

        this._namingQueue.push({
          type: 'user',
          message: { role: 'user', content: `Title for: "${userMessage.slice(0, 200)}"` }
        });
      });
    } catch (err) {
      console.error('[ChatService] generateTabName error:', err.message);
      return null;
    }
  }

  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.queryStream?.close) session.queryStream.close();
      if (session.messageQueue) session.messageQueue.close();
      // Reject pending permissions for this session
      for (const [id, pending] of this.pendingPermissions) {
        if (pending.sessionId === sessionId) {
          this.pendingPermissions.delete(id);
          pending.reject(new Error('Session closed'));
        }
      }
      this.sessions.delete(sessionId);
    }
  }

  closeAll() {
    for (const [id] of this.sessions) {
      this.closeSession(id);
    }
    // Close naming session
    if (this._namingQueue) {
      this._namingQueue.close();
      this._namingReady = false;
    }
  }
}

module.exports = new ChatService();
