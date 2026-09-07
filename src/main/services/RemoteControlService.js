/**
 * RemoteControlService - Claude Code "Remote Control" for chat sessions.
 *
 * Puts every local chat tab on claude.ai/code and in the Claude mobile app: the
 * transcript streams out live, and (unless the user restricts it to a mirror)
 * prompts, interrupts and permission answers come back the other way. It is the
 * same capability the CLI exposes as `claude --rc`, wired to this app's own
 * sessions instead of a terminal REPL.
 *
 * HOW THE PIECES FIT
 * ------------------
 * The SDK ships the whole transport; we own none of the wire protocol:
 *
 *   ChatService ──_emitEvent──> RemoteControlService
 *                                     │
 *                    createCodeSession │  POST /v1/code/sessions        (OAuth)
 *                 fetchRemoteCredentials  POST /v1/code/sessions/:id/bridge
 *                                     ▼
 *                              BridgeSessionHandle
 *                        write / sendResult / reportState  ──HTTP──> CCR
 *                        onInboundMessage / onInterrupt   <──SSE───  CCR
 *                                                                     ▲
 *                                                    claude.ai/code ──┘
 *                                                    Claude mobile app
 *
 * So the work here is entirely translation: this app's chat events into
 * SDKMessages the bridge understands, and inbound bridge callbacks into
 * ChatService calls.
 *
 * WHY EVERYTHING IS FIRE-AND-FORGET
 * ---------------------------------
 * Attaching costs two HTTP round trips and can fail for reasons that have
 * nothing to do with the user's prompt (expired login, an org that demands an
 * enrolled device, no network). None of that is a reason for a local chat
 * session to be slower to start or to fail, so `onSessionStarted` returns
 * immediately and the events that arrive before the handle is ready go into a
 * bounded buffer. If the attach never succeeds, the buffer is dropped and the
 * session runs exactly as it would with the feature switched off.
 *
 * OPT-IN, AND WHY
 * ---------------
 * Off by default. This ships local transcripts - prompts, file contents, tool
 * output - to claude.ai, and with driving enabled it lets a phone approve tool
 * permissions on a real working tree. That is a decision the user makes on
 * purpose, not one they discover after the fact.
 */

const fs = require('fs');
const { settingsFile } = require('../utils/paths');
const { loadBridge, getUnavailableReason, getApiBaseUrl } = require('../utils/claudeBridge');
const {
  readAccessToken,
  readCredentialsForDir,
  tokenFromCredentials,
  readTrustedDeviceToken,
} = require('../utils/claudeCredentials');

/** HTTP timeout for the two session-minting calls. */
const MINT_TIMEOUT_MS = 20000;

/**
 * Events buffered per session while the attach is in flight.
 *
 * Sized for a long first turn rather than a whole conversation: with
 * `includePartialMessages` a busy turn emits a message per token, and the point
 * of the buffer is only to cover the two round trips of the attach. Past the
 * cap the oldest go, so a session whose attach never lands cannot grow without
 * bound - claude.ai then simply joins mid-transcript.
 */
const MAX_BUFFERED_EVENTS = 2000;

/** Backoff for a transport that died for a reason worth retrying. */
const RECONNECT_DELAYS_MS = [2000, 5000, 15000, 60000];

/**
 * Close codes documented by the SDK as permanent. Retrying any of these is
 * pointless: the epoch is gone (another worker took the session), or the server
 * rejected the stream outright.
 */
const FATAL_CLOSE_CODES = new Set([4090, 403, 404]);

/**
 * Close codes that mean "the credential expired", as opposed to "the transport
 * broke". These re-mint from scratch rather than reusing the epoch.
 */
const CREDENTIAL_CLOSE_CODES = new Set([401, 4094]);

/**
 * Token cache, keyed by account id (`''` for the machine-wide login).
 *
 * Minting happens once per chat tab, not on a timer, but on macOS the credential
 * store is a Keychain item whose ACL trusts the CLI and not this app: an
 * uncached read would raise a system password prompt every time the user opened
 * a tab. Half an hour collapses a working session's worth of tabs into one.
 */
const TOKEN_TTL_MS = 30 * 60 * 1000;
const _tokenCache = new Map();

class RemoteControlService {
  constructor() {
    /**
     * sessionId -> mirror record.
     * @type {Map<string, {
     *   handle: Object|null, ccrSessionId: string|null, epoch: number|undefined,
     *   buffer: Array, state: string|null, closed: boolean,
     *   reconnects: number, meta: Object, pendingInbound: string[],
     *   permissions: Map<string, string>
     * }>}
     */
    this._mirrors = new Map();
    this._chatService = null;
    this._unsubscribe = null;
    /** Last terminal failure, surfaced in settings so the user can act on it. */
    this._lastError = null;
  }

  // ── Capability & configuration ────────────────────────────────────────────

  /** The user's settings.json, or an empty object when it is unreadable. */
  _settings() {
    try {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch {
      return {};
    }
  }

  /**
   * Whether the user turned mirroring on.
   *
   * The renderer owns settings.json, so this reads it rather than holding a
   * copy - same pattern as the other main-process consumers of user settings.
   */
  isEnabled() {
    return this._settings().claudeRemoteControlEnabled === true;
  }

  /**
   * Whether claude.ai may drive the session, or only watch it.
   *
   * Defaults to on once the feature itself is enabled: a mirror you cannot
   * answer a permission prompt from stalls the moment a tool needs approval,
   * which is a worse experience than not mirroring at all. Users who want a
   * pure read-only view turn this off, and the bridge is then attached with
   * `outboundOnly`, which does not even open the inbound SSE stream.
   */
  allowsDriving() {
    return this._settings().claudeRemoteControlDrive !== false;
  }

  /**
   * Honour the managed-settings kill switch.
   *
   * `disableRemoteControl` is what an administrator sets to forbid Remote
   * Control org-wide. It governs the CLI's own `--rc`; an app that mirrored
   * sessions anyway would just be a hole in the same policy.
   */
  isBlockedByPolicy() {
    return this._settings().disableRemoteControl === true;
  }

  /**
   * Whether a Claude CLI spawned in a terminal tab should be launched with
   * `--rc`, so it connects to Remote Control the way `claude --rc` does.
   *
   * Separate from the chat mirror, and off by default: a terminal tab runs the
   * real CLI, and `--rc` visibly changes how it starts up. Sharing the master
   * toggle would have turned that on for people who only wanted their chat tabs
   * on their phone.
   */
  launchesTerminalsConnected() {
    return this.isEnabled()
      && !this.isBlockedByPolicy()
      && this._settings().claudeRemoteControlTerminals === true;
  }

  /** Status for the settings panel. */
  async getStatus() {
    const bridge = await loadBridge();
    return {
      supported: bridge !== null,
      unavailableReason: bridge === null ? getUnavailableReason() : null,
      blockedByPolicy: this.isBlockedByPolicy(),
      enabled: this.isEnabled(),
      driving: this.allowsDriving(),
      terminals: this.launchesTerminalsConnected(),
      activeSessions: [...this._mirrors.values()].filter(m => m.handle).length,
      lastError: this._lastError,
    };
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  /**
   * Subscribe to the chat event stream. Idempotent, so a settings round trip
   * cannot end up with two listeners writing every message twice.
   */
  attachToChatService(chatService) {
    if (this._chatService === chatService && this._unsubscribe) return;
    if (this._unsubscribe) this._unsubscribe();
    this._chatService = chatService;
    this._unsubscribe = chatService.addEventListener((channel, data) => {
      try {
        this._onChatEvent(channel, data);
      } catch (err) {
        console.warn('[RemoteControl] event handling error:', err?.message);
      }
    });
  }

  /**
   * A local chat session started. Begins an attach when the feature is on.
   *
   * Never awaited by the caller and never throws: see the fire-and-forget note
   * at the top of the file.
   *
   * @param {string} sessionId
   * @param {Object} meta - { cwd, projectId, accountId, model, title }
   */
  /**
   * Mirror one specific chat session to claude.ai, starting from whatever it
   * says next — not a replay of what it already said.
   *
   * Deliberately per-session and explicit: nothing here is triggered by
   * ChatService starting a session. A global "mirror everything" switch would
   * put a user's private local chats on claude.ai the moment they turned the
   * feature on at all, with no per-conversation say in it. This is the only
   * entry point that starts a mirror, and it always begins as an action the
   * user just took in that specific tab (the footer button, or the
   * `/remote-control` input command) — never as a side effect of settings.
   *
   * Session metadata (cwd, project, account, model) is read live off the
   * ChatService session rather than passed in, since the caller here is a
   * button click with no reason to know any of that.
   *
   * @param {string} sessionId
   * @returns {Promise<{success: true} | {success: false, error: string}>}
   */
  async enableForSession(sessionId) {
    if (!sessionId) return { success: false, error: 'No session id.' };
    if (this._mirrors.get(sessionId)?.handle) return { success: true }; // already mirrored

    if (this.isBlockedByPolicy()) {
      return { success: false, error: 'Remote Control is disabled by your organisation policy.' };
    }
    if (!this.isEnabled()) {
      return { success: false, error: 'Turn on Remote Control in Settings → Connectivity → claude.ai first.' };
    }
    const session = this._chatService?.sessions?.get(sessionId);
    if (!session) {
      return { success: false, error: 'This tab has no running session yet — send a message first.' };
    }

    // Registered synchronously, before the first await: building the transport
    // takes about a second, and a turn already streaming has to land in the
    // buffer over that window rather than on the floor. Whether the SDK can
    // serve the bridge at all is checked inside _attach, past this point.
    const mirror = {
      handle: null,
      ccrSessionId: null,
      epoch: undefined,
      buffer: [],
      state: null,
      closed: false,
      reconnects: 0,
      meta: {
        cwd: session.cwd || null,
        projectId: session.projectId || null,
        accountId: session.accountId || null,
        model: session.model || null,
      },
      pendingInbound: [],
      permissions: new Map(),
    };
    this._mirrors.set(sessionId, mirror);

    await this._attach(sessionId).catch(err => {
      console.warn(`[RemoteControl] attach failed for ${sessionId}:`, err?.message);
      this._mirrors.delete(sessionId);
      this._emitStatus(sessionId, false, err?.message || 'Attach failed.');
    });

    const attached = this._mirrors.get(sessionId);
    return attached?.handle ? { success: true } : { success: false, error: this._lastError || 'Could not attach.' };
  }

  /** Stop mirroring one session. Always succeeds — disabling an unmirrored session is a no-op. */
  disableForSession(sessionId) {
    this._teardown(sessionId, 'user disabled');
    return { success: true };
  }

  /** Whether `sessionId` is currently mirrored, for a tab's initial paint. */
  getSessionStatus(sessionId) {
    const mirror = this._mirrors.get(sessionId);
    return { mirrored: !!mirror?.handle, lastError: mirror ? null : this._lastError };
  }

  /**
   * Every conversation currently on claude.ai, for the Connectivity screen.
   *
   * Only mirrors with a live handle are listed: one still building its
   * transport is not yet reachable from anywhere, and showing it would offer
   * the user a session to jump to that claude.ai does not have.
   *
   * @returns {Array<{sessionId, ccrSessionId, cwd, projectId, branch, state, startedAt}>}
   */
  listSessions() {
    const out = [];
    for (const [sessionId, mirror] of this._mirrors) {
      if (!mirror.handle) continue;
      out.push({
        sessionId,
        ccrSessionId: mirror.ccrSessionId,
        cwd: mirror.meta?.cwd || null,
        projectId: mirror.meta?.projectId || null,
        branch: mirror.branch || null,
        state: mirror.state || 'idle',
        startedAt: mirror.startedAt || null,
      });
    }
    return out;
  }

  /**
   * Push a session's mirror state to the renderer.
   *
   * Reuses ChatService's own event bus (`_send`) rather than opening a second
   * channel to the window: it already reaches the chat tab (and any remote
   * PWA listener) keyed by `sessionId`, exactly like `chat-idle` or
   * `chat-permission-request`. RemoteControlService also receives its own
   * emission back through `_onChatEvent`, which is harmless — the switch
   * there has no case for it.
   */
  _emitStatus(sessionId, mirrored, lastError = null) {
    this._chatService?._send?.('remote-control:session-status-changed', { sessionId, mirrored, lastError });
  }

  /** A local chat session ended. Flushes what is queued, then lets the handle go. */
  onSessionClosed(sessionId) {
    this._teardown(sessionId, 'session closed');
  }

  // ── Attach ────────────────────────────────────────────────────────────────

  /** The OAuth token for an account, cached. See TOKEN_TTL_MS. */
  async _accessToken(accountId) {
    const key = accountId || '';
    const hit = _tokenCache.get(key);
    if (hit && Date.now() < hit.until) return hit.token;

    let token = null;
    try {
      if (accountId) {
        const { accountConfigDir } = require('./AccountManager');
        token = tokenFromCredentials(await readCredentialsForDir(accountConfigDir(accountId)));
      } else {
        token = await readAccessToken();
      }
    } catch (_) {
      // Store unreadable. Cached as "no token" so a refusal is not re-asked on
      // the next tab the user opens.
    }
    _tokenCache.set(key, { token, until: Date.now() + TOKEN_TTL_MS });
    return token;
  }

  /** The per-account credential directory, when the session is bound to one. */
  _accountDir(accountId) {
    if (!accountId) return null;
    try {
      return require('./AccountManager').accountConfigDir(accountId);
    } catch (_) {
      return null;
    }
  }

  /**
   * Git provenance for the session, so claude.ai shows the repo and branch
   * rather than a bare path.
   *
   * `defaultBranch` is load-bearing, not decoration: the SDK drops `branch`
   * from the session's outcomes entirely when it is absent, because it will not
   * act on a guess - and a session created without it works on a
   * runner-generated branch instead of the user's. `origin/HEAD` is the
   * authoritative answer, and a repository whose symref was never set simply
   * yields nothing here.
   *
   * @returns {Promise<Object|null>}
   */
  async _gitContext(cwd) {
    if (!cwd) return null;
    try {
      const git = require('../utils/git');
      const [branch, remotes] = await Promise.all([
        git.getCurrentBranch(cwd).catch(() => null),
        git.getRemotes(cwd).catch(() => []),
      ]);
      const origin = remotes.find(r => r.name === 'origin') || remotes[0];
      const gitRepoUrl = origin?.fetchUrl || origin?.pushUrl || null;
      if (!branch || !gitRepoUrl) return null;

      const head = await git.execGitResult(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
      const defaultBranch = head?.ok
        ? head.output.trim().replace(/^refs\/remotes\/origin\//, '') || undefined
        : undefined;

      return { gitRepoUrl, branch, ...(defaultBranch ? { defaultBranch } : {}) };
    } catch (_) {
      return null;
    }
  }

  /**
   * Turn a bridge failure into something the user can act on.
   *
   * The reasons are not interchangeable - one needs a re-login, one needs an
   * enrolled device, one is a bug - so they are not collapsed into a single
   * "could not connect".
   */
  _describeFailure(result, bridge) {
    if (bridge.isCredentialsRejection?.(result)) {
      return 'Claude rejected the saved login. Run /login in a terminal, then try again.';
    }
    if (!result?.terminal) return null;
    switch (result.reason) {
      case 'untrusted_device':
        // Enrollment is the CLI's flow, and it runs on its own the first time
        // Claude Code itself connects to Remote Control. Pointing the user at
        // that is the only remedy this app can offer.
        return 'Your organisation requires a trusted device for Remote Control. '
          + 'Run `claude` in a terminal and connect Remote Control once to enroll this machine, then try again.';
      case 'session_stale_relogin':
        return 'Your Claude login is too old for Remote Control. Run /login in a terminal, then try again.';
      case 'invalid_session_id':
        return 'The bridge rejected the session id.';
      case 'grouping_rejected':
        return 'The bridge rejected the session grouping.';
      case 'malformed_response':
        return 'The bridge returned a response this build could not parse.';
      case 'request_rejected':
        return `Claude refused the Remote Control request (HTTP ${result.status}).`;
      default:
        return `Remote Control failed: ${result.reason}.`;
    }
  }

  /** Create the CCR session, mint worker credentials, attach the transport. */
  async _attach(sessionId) {
    const mirror = this._mirrors.get(sessionId);
    if (!mirror || mirror.closed) return;

    const bridge = await loadBridge();
    if (!bridge) {
      this._lastError = getUnavailableReason() || 'This build cannot serve Remote Control.';
      this._mirrors.delete(sessionId);
      this._emitStatus(sessionId, false, this._lastError);
      return;
    }

    const { meta } = mirror;
    const accessToken = await this._accessToken(meta.accountId);
    if (!accessToken) {
      this._lastError = 'No usable Claude login. Run /login in a terminal.';
      this._mirrors.delete(sessionId);
      this._emitStatus(sessionId, false, this._lastError);
      return;
    }

    const baseUrl = getApiBaseUrl();
    const title = meta.title || this._defaultTitle(meta.cwd);
    const gitContext = await this._gitContext(meta.cwd);

    const created = await bridge.createCodeSession(
      baseUrl, accessToken, title, MINT_TIMEOUT_MS,
      ['claude-terminal'], gitContext || undefined, meta.cwd || undefined, meta.model || undefined,
    );
    if (typeof created !== 'string') {
      this._lastError = this._describeFailure(created, bridge) || 'Could not create the Remote Control session.';
      console.warn(`[RemoteControl] createCodeSession: ${this._lastError}`);
      this._mirrors.delete(sessionId);
      this._emitStatus(sessionId, false, this._lastError);
      return;
    }

    const trustedDeviceToken = await readTrustedDeviceToken(this._accountDir(meta.accountId));
    const creds = await bridge.fetchRemoteCredentials(
      created, baseUrl, accessToken, MINT_TIMEOUT_MS, trustedDeviceToken || undefined,
    );
    if (!creds || typeof creds.worker_jwt !== 'string') {
      this._lastError = this._describeFailure(creds, bridge) || 'Could not obtain Remote Control credentials.';
      console.warn(`[RemoteControl] fetchRemoteCredentials: ${this._lastError}`);
      this._mirrors.delete(sessionId);
      this._emitStatus(sessionId, false, this._lastError);
      return;
    }

    // The session may have ended while the two round trips were in flight.
    if (mirror.closed) return;

    const handle = await bridge.attachBridgeSession({
      sessionId: created,
      ingressToken: creds.worker_jwt,
      apiBaseUrl: creds.api_base_url || baseUrl,
      // The bridge mint IS the worker register and already bumped the epoch;
      // passing it back skips a redundant registerWorker round trip.
      epoch: creds.worker_epoch,
      outboundOnly: !this.allowsDriving(),
      onInboundMessage: msg => this._onInboundMessage(sessionId, msg),
      onInterrupt: () => this._onInterrupt(sessionId),
      onPermissionResponse: res => this._onPermissionResponse(sessionId, res),
      onSetModel: model => this._onSetModel(sessionId, model),
      onSetPermissionMode: mode => this._onSetPermissionMode(sessionId, mode),
      onRenameSession: title2 => this._onRenameSession(sessionId, title2),
      onStopTask: taskId => this._onStopTask(sessionId, taskId),
      onClose: code => this._onTransportClose(sessionId, code),
    });

    mirror.handle = handle;
    mirror.ccrSessionId = created;
    mirror.epoch = creds.worker_epoch;
    mirror.startedAt = Date.now();
    mirror.branch = gitContext?.branch || null;
    this._lastError = null;

    handle.reportMetadata({
      cwd: meta.cwd || null,
      branch: gitContext?.branch || null,
      host: 'claude-terminal',
    });

    this._flushBuffer(sessionId);
    this._emitStatus(sessionId, true, null);
  }

  /** A readable session title when the caller supplied none. */
  _defaultTitle(cwd) {
    if (!cwd) return 'Claude Terminal';
    const name = require('path').basename(cwd);
    return name ? `${name} (Claude Terminal)` : 'Claude Terminal';
  }

  // ── Outbound: local chat events -> claude.ai ──────────────────────────────

  _onChatEvent(channel, data) {
    const sessionId = data?.sessionId;
    if (!sessionId) return;
    const mirror = this._mirrors.get(sessionId);
    if (!mirror || mirror.closed) return;

    switch (channel) {
      case 'chat-message':
        this._write(mirror, data.message);
        // Any model output means the turn is live. Reported once per turn:
        // reportState PUTs to the worker endpoint, and a per-token PUT would be
        // one HTTP request per streamed character.
        this._reportState(mirror, 'running');
        break;

      case 'chat-user-message':
        this._writeUserMessage(mirror, sessionId, data);
        break;

      case 'chat-permission-request':
        this._forwardPermission(mirror, sessionId, data);
        break;

      case 'chat-permission-resolved':
        // Answered on the desktop first. Retract the prompt from claude.ai so
        // the phone does not keep showing a question that no longer has an
        // answer to give.
        this._retractPermission(mirror, data.requestId);
        break;

      case 'chat-idle':
        // The queue pulled the next message, so the turn is over. This is what
        // stops the "working" spinner on claude.ai.
        this._sendResult(mirror);
        this._reportState(mirror, 'idle');
        break;

      case 'chat-done':
      case 'chat-error':
        this._sendResult(mirror);
        this._teardown(sessionId, channel === 'chat-error' ? 'session error' : 'stream ended');
        break;

      case 'session:closed':
        this._teardown(sessionId, 'session closed');
        break;

      default:
        break;
    }
  }

  /**
   * Write an SDKMessage out, or buffer it while the attach is in flight.
   * `session_id` is injected by the handle, so it is not set here.
   */
  _write(mirror, message) {
    if (!message) return;
    if (!mirror.handle) {
      this._buffer(mirror, { kind: 'write', message });
      return;
    }
    try {
      mirror.handle.write(message);
    } catch (err) {
      console.warn('[RemoteControl] write failed:', err?.message);
    }
  }

  /**
   * Mirror the user's own prompt.
   *
   * The SDK's output stream carries assistant, system and result messages but
   * never echoes the prompt that caused them, so without this claude.ai would
   * show a conversation of answers with no questions.
   *
   * A prompt that arrived *from* claude.ai is skipped: it is already on screen
   * there, and writing it back would show it twice.
   */
  _writeUserMessage(mirror, sessionId, data) {
    const text = typeof data.text === 'string' ? data.text : '';
    const idx = mirror.pendingInbound.indexOf(text);
    if (idx !== -1) {
      mirror.pendingInbound.splice(idx, 1);
      return;
    }
    if (!text) return;
    this._write(mirror, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: sessionId,
    });
  }

  _sendResult(mirror) {
    if (!mirror.handle) {
      this._buffer(mirror, { kind: 'result' });
      return;
    }
    try {
      mirror.handle.sendResult();
    } catch (err) {
      console.warn('[RemoteControl] sendResult failed:', err?.message);
    }
  }

  /** PUT the worker state, skipping no-op transitions. */
  _reportState(mirror, state) {
    if (mirror.state === state) return;
    mirror.state = state;
    if (!mirror.handle) {
      this._buffer(mirror, { kind: 'state', state });
      return;
    }
    try {
      mirror.handle.reportState(state);
    } catch (err) {
      console.warn('[RemoteControl] reportState failed:', err?.message);
    }
  }

  /**
   * Forward a permission prompt to claude.ai as a control request.
   *
   * Both surfaces show the prompt at once and the first answer wins: whichever
   * side answers resolves the single pending entry in ChatService, and the
   * other is retracted (see `chat-permission-resolved` above and
   * `_onPermissionResponse` below).
   */
  _forwardPermission(mirror, sessionId, data) {
    this._reportState(mirror, 'requires_action');
    if (!mirror.handle || !this.allowsDriving()) return;

    const requestId = data.requestId;
    if (!requestId) return;
    mirror.permissions.set(requestId, requestId);

    try {
      mirror.handle.sendControlRequest({
        type: 'control_request',
        request_id: requestId,
        request: {
          subtype: 'can_use_tool',
          tool_name: data.toolName,
          input: data.input || {},
          ...(data.suggestions ? { permission_suggestions: data.suggestions } : {}),
          ...(data.decisionReason ? { decision_reason: data.decisionReason } : {}),
        },
      });
    } catch (err) {
      console.warn('[RemoteControl] sendControlRequest failed:', err?.message);
      mirror.permissions.delete(requestId);
    }
  }

  _retractPermission(mirror, requestId) {
    if (!requestId || !mirror.permissions.has(requestId)) return;
    mirror.permissions.delete(requestId);
    try {
      mirror.handle?.sendControlCancelRequest(requestId);
    } catch (err) {
      console.warn('[RemoteControl] sendControlCancelRequest failed:', err?.message);
    }
  }

  /** Queue an event until the handle exists, oldest dropped past the cap. */
  _buffer(mirror, entry) {
    mirror.buffer.push(entry);
    if (mirror.buffer.length > MAX_BUFFERED_EVENTS) mirror.buffer.shift();
  }

  /** Replay everything queued during the attach, in order. */
  _flushBuffer(sessionId) {
    const mirror = this._mirrors.get(sessionId);
    if (!mirror?.handle) return;
    const queued = mirror.buffer;
    mirror.buffer = [];
    for (const entry of queued) {
      try {
        if (entry.kind === 'write') mirror.handle.write(entry.message);
        else if (entry.kind === 'result') mirror.handle.sendResult();
        else if (entry.kind === 'state') mirror.handle.reportState(entry.state);
      } catch (err) {
        console.warn('[RemoteControl] buffered replay failed:', err?.message);
        break;
      }
    }
  }

  // ── Inbound: claude.ai -> local chat session ──────────────────────────────

  /** A prompt typed on claude.ai. */
  _onInboundMessage(sessionId, msg) {
    if (!this._chatService || !this.allowsDriving()) return;
    const mirror = this._mirrors.get(sessionId);
    if (!mirror || mirror.closed) return;

    const text = this._textOf(msg);
    if (!text) return;

    // Remembered so the echo this send produces is not written back out.
    mirror.pendingInbound.push(text);
    try {
      this._chatService.sendMessage(sessionId, text);
    } catch (err) {
      const at = mirror.pendingInbound.indexOf(text);
      if (at !== -1) mirror.pendingInbound.splice(at, 1);
      console.warn('[RemoteControl] inbound send failed:', err?.message);
    }
  }

  /** Plain text of an inbound SDKMessage, ignoring non-text blocks. */
  _textOf(msg) {
    const content = msg?.message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
      .trim();
  }

  _onInterrupt(sessionId) {
    if (!this.allowsDriving()) return;
    try {
      this._chatService?.interrupt(sessionId);
    } catch (err) {
      console.warn('[RemoteControl] interrupt failed:', err?.message);
    }
  }

  /**
   * The user answered a permission prompt on claude.ai.
   *
   * Returning false leaves the prompt eligible for re-delivery, which is the
   * right answer for a response this app cannot make sense of: better that
   * claude.ai asks again than that a malformed frame silently allows a tool.
   */
  _onPermissionResponse(sessionId, res) {
    if (!this.allowsDriving()) return false;
    const mirror = this._mirrors.get(sessionId);
    if (!mirror) return false;

    const response = res?.response;
    const requestId = response?.request_id;
    if (!requestId || !mirror.permissions.has(requestId)) return false;

    // An error response is a refusal to answer, not a denial - the prompt stays
    // live locally so the desktop can still take it.
    if (response.subtype === 'error') return false;

    const payload = response.response || {};
    const behavior = payload.behavior;
    if (behavior !== 'allow' && behavior !== 'deny') return false;

    mirror.permissions.delete(requestId);
    try {
      this._chatService?.resolvePermission(requestId, behavior === 'allow'
        ? { behavior: 'allow', updatedInput: payload.updatedInput ?? {} }
        : { behavior: 'deny', message: payload.message || 'Denied from claude.ai' });
    } catch (err) {
      console.warn('[RemoteControl] resolvePermission failed:', err?.message);
      return false;
    }
    return undefined;
  }

  async _onSetModel(sessionId, model) {
    if (!this.allowsDriving()) return { ok: false, error: 'This session is mirrored read-only.' };
    try {
      await this._chatService?.setModel(sessionId, model);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || 'Could not change the model.' };
    }
  }

  /**
   * Permission mode from claude.ai.
   *
   * Only `bypassPermissions` is actionable here: it maps onto the session's
   * `alwaysAllow` flag, which is the same switch the desktop toggle drives. The
   * other modes are decided when the query is created and the SDK gives no
   * mid-session control for them, so they are refused explicitly rather than
   * accepted and ignored.
   */
  _onSetPermissionMode(sessionId, mode) {
    if (!this.allowsDriving()) return { ok: false, error: 'This session is mirrored read-only.' };
    const session = this._chatService?.sessions?.get(sessionId);
    if (!session) return { ok: false, error: 'Session not found.' };
    if (mode === 'bypassPermissions' || mode === 'default') {
      session.alwaysAllow = mode === 'bypassPermissions';
      return { ok: true };
    }
    return { ok: false, error: `Claude Terminal cannot switch to "${mode}" mid-session.` };
  }

  _onRenameSession(sessionId, title) {
    const mirror = this._mirrors.get(sessionId);
    if (mirror) mirror.meta = { ...mirror.meta, title };
    return { ok: true };
  }

  async _onStopTask(sessionId, taskId) {
    if (!this.allowsDriving()) throw new Error('This session is mirrored read-only.');
    await this._chatService?.stopTask(sessionId, taskId);
  }

  // ── Transport lifecycle ───────────────────────────────────────────────────

  /**
   * The transport died. Whether that is recoverable depends on the code: see
   * FATAL_CLOSE_CODES and CREDENTIAL_CLOSE_CODES.
   *
   * Transient network trouble never reaches here - the SDK's SSETransport
   * retries those internally - so anything that does is worth acting on.
   */
  _onTransportClose(sessionId, code) {
    const mirror = this._mirrors.get(sessionId);
    if (!mirror || mirror.closed) return;

    if (FATAL_CLOSE_CODES.has(code)) {
      // 4090 means another worker took the session over. Reconnecting would
      // fight it for the same epoch, so the mirror is simply given up.
      this._teardown(sessionId, `transport closed (${code})`);
      return;
    }

    const delay = RECONNECT_DELAYS_MS[Math.min(mirror.reconnects, RECONNECT_DELAYS_MS.length - 1)];
    if (mirror.reconnects >= RECONNECT_DELAYS_MS.length) {
      this._teardown(sessionId, `transport closed (${code}), retries exhausted`, 'Connection to claude.ai was lost.');
      return;
    }
    mirror.reconnects++;
    setTimeout(() => {
      this._reconnect(sessionId, CREDENTIAL_CLOSE_CODES.has(code)).catch(err => {
        console.warn(`[RemoteControl] reconnect failed for ${sessionId}:`, err?.message);
      });
    }, delay).unref?.();
  }

  /**
   * Swap in a fresh transport.
   *
   * A credential expiry re-mints the JWT and hands back the *new* epoch; any
   * other failure reuses the current one, because only the mint bumps the epoch
   * server-side and claiming a new one would orphan the stream we are resuming.
   * The sequence number goes along either way so the server resumes rather than
   * replaying the whole transcript.
   */
  async _reconnect(sessionId, credentialExpired) {
    const mirror = this._mirrors.get(sessionId);
    if (!mirror || mirror.closed || !mirror.handle || !mirror.ccrSessionId) return;

    const bridge = await loadBridge();
    if (!bridge) return;

    const accessToken = await this._accessToken(mirror.meta.accountId);
    if (!accessToken) {
      this._teardown(sessionId, 'no usable login for reconnect', 'No usable Claude login. Run /login in a terminal.');
      return;
    }

    const baseUrl = getApiBaseUrl();
    const trustedDeviceToken = await readTrustedDeviceToken(this._accountDir(mirror.meta.accountId));
    const creds = await bridge.fetchRemoteCredentials(
      mirror.ccrSessionId, baseUrl, accessToken, MINT_TIMEOUT_MS, trustedDeviceToken || undefined,
    );
    if (!creds || typeof creds.worker_jwt !== 'string') {
      this._teardown(sessionId, 'could not re-mint credentials', 'Connection to claude.ai was lost.');
      return;
    }

    try {
      await mirror.handle.reconnectTransport({
        ingressToken: creds.worker_jwt,
        apiBaseUrl: creds.api_base_url || baseUrl,
        ...(credentialExpired ? { epoch: creds.worker_epoch } : {}),
      });
      mirror.reconnects = 0;
      this._emitStatus(sessionId, true, null);
    } catch (err) {
      // The SDK is explicit that a failed reconnectTransport means the handle
      // is dead, not retryable.
      this._teardown(sessionId, `reconnect rejected: ${err?.message}`, 'Connection to claude.ai was lost.');
    }
  }

  /**
   * Drain what is queued, close the handle, forget the session.
   *
   * Always emits the session's new (unmirrored) status, whether or not a
   * handle ever existed: this is also what a user's disable click routes
   * through, and the button needs to hear back even if it clicked disable
   * while the attach was still in flight.
   *
   * @param {string} sessionId
   * @param {string} [reason] - Logged; not shown to the user.
   * @param {string|null} [error] - Shown to the user when this teardown is a
   *   failure (a dead transport) rather than a plain disconnect (the user
   *   asked, the tab closed).
   */
  _teardown(sessionId, reason, error = null) {
    const mirror = this._mirrors.get(sessionId);
    if (!mirror) return;
    mirror.closed = true;
    this._mirrors.delete(sessionId);
    this._emitStatus(sessionId, false, error);

    const handle = mirror.handle;
    if (!handle) return;

    // Delivery matters on the last write of a session: without the flush the
    // final assistant message can be lost, and claude.ai would keep a session
    // that never visibly finished.
    Promise.resolve()
      .then(() => handle.flush())
      .catch(() => {})
      .finally(() => {
        try {
          handle.close();
        } catch (_) { /* already gone */ }
      });
    if (reason) console.log(`[RemoteControl] ${sessionId}: ${reason}`);
  }

  /** Drop every mirror. Called on account switch, opt-out, and app quit. */
  shutdown() {
    for (const sessionId of [...this._mirrors.keys()]) {
      this._teardown(sessionId, 'shutdown');
    }
    _tokenCache.clear();
  }

  /**
   * The active account changed, so every mirror belongs to the outgoing one.
   * Cached tokens go too, or the next attach would authenticate as the account
   * the user just left.
   */
  onAccountChanged() {
    this.shutdown();
  }
}

module.exports = new RemoteControlService();
