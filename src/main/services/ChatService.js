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
   * @returns {Promise<string>} Session ID
   */
  async startSession({ cwd, prompt, permissionMode = 'default' }) {
    const sdk = await loadSDK();
    const sessionId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const messageQueue = createMessageQueue(() => {
      this._send('chat-idle', { sessionId });
    });

    // Push first user message
    messageQueue.push({
      type: 'user',
      message: { role: 'user', content: prompt }
    });

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
        canUseTool: async (toolName, input, opts) => {
          return this._handlePermission(sessionId, toolName, input, opts);
        }
      };

      const queryStream = sdk.query({
        prompt: messageQueue.iterable,
        options,
      });

      this.sessions.set(sessionId, {
        abortController,
        messageQueue,
        queryStream,
      });

      this._processStream(sessionId, queryStream);
      return sessionId;
    } catch (err) {
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
      message: { role: 'user', content: text }
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
   * Process the SDK query stream and forward all messages to renderer
   */
  async _processStream(sessionId, queryStream) {
    try {
      for await (const message of queryStream) {
        this._send('chat-message', { sessionId, message });
      }
      this._send('chat-done', { sessionId });
    } catch (err) {
      if (err.name === 'AbortError' || err.message === 'Aborted') {
        this._send('chat-done', { sessionId, aborted: true });
      } else {
        console.error(`[ChatService] Stream error for ${sessionId}:`, err.message);
        this._send('chat-error', { sessionId, error: err.message });
      }
    }
  }

  _safeSerialize(obj) {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch {
      return { _raw: String(obj) };
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
  }
}

module.exports = new ChatService();
