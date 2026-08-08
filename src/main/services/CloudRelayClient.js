/**
 * CloudRelayClient
 * Connects the desktop app to a cloud relay server (WSS).
 * Acts as a transparent bridge: messages from the local RemoteServer
 * are forwarded to the relay, and messages from the relay are injected
 * into the local RemoteServer as if they came from a local mobile client.
 */

const WebSocket = require('ws');

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000]; // exponential backoff
const HEARTBEAT_INTERVAL = 30000;
// A connection must survive this long before we trust it and reset the backoff.
// Without it, a relay that accepts then immediately drops us (code 1006, token
// taken over by another desktop…) resets the backoff on every `open` and we
// hammer it once per second forever.
const STABLE_CONNECTION_MS = 60000;
// Consecutive short-lived connections before we give the relay a real break.
const FLAP_THRESHOLD = 5;
const FLAP_COOLDOWN_MS = 5 * 60 * 1000;

class CloudRelayClient {
  constructor() {
    /** @type {WebSocket|null} */
    this.ws = null;
    /** @type {string|null} */
    this.serverUrl = null;
    /** @type {string|null} */
    this.apiKey = null;
    /** @type {boolean} */
    this.connected = false;
    /** @type {boolean} */
    this.shouldReconnect = false;
    /** @type {number} */
    this.reconnectAttempt = 0;
    /** @type {NodeJS.Timeout|null} */
    this._reconnectTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this._heartbeatTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this._stableTimer = null;
    /** @type {number} Consecutive connections that died before STABLE_CONNECTION_MS */
    this._unstableStreak = 0;
    /** @type {Function|null} */
    this._onMessage = null;
    /** @type {Function|null} */
    this._onStatusChange = null;
  }

  /**
   * @param {Function} fn - Called with (messageData) when relay sends a message
   */
  onMessage(fn) { this._onMessage = fn; }

  /**
   * @param {Function} fn - Called with ({ connected, error? }) on status change
   */
  onStatusChange(fn) { this._onStatusChange = fn; }

  /**
   * Connect to the cloud relay
   * @param {string} serverUrl - e.g. 'https://cloud.example.com'
   * @param {string} apiKey - e.g. 'ctc_abc123...'
   */
  connect(serverUrl, apiKey) {
    this.disconnect();
    this.serverUrl = serverUrl;
    this.apiKey = apiKey;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    // Explicit user action — clear any flap cooldown and retry right away
    this._unstableStreak = 0;
    this._doConnect();
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this._clearStableTimer();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, 'Disconnect');
      this.ws = null;
    }
    if (this.connected) {
      this.connected = false;
      this._emitStatus({ connected: false });
    }
  }

  /**
   * Forward a message to the relay (desktop → cloud → mobile).
   * Nothing is queued: every frame here is a snapshot of live state that the
   * next broadcast supersedes, and a replayed auth result would be worse than a
   * lost one. Failure is reported rather than swallowed.
   * @param {string|object} data
   * @returns {boolean} true if handed to the socket
   */
  send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[CloudRelay] Dropped outbound message — relay socket not open');
      return false;
    }
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    try {
      this.ws.send(msg);
      return true;
    } catch (err) {
      console.warn('[CloudRelay] Send failed:', err.message);
      return false;
    }
  }

  /** @returns {{ connected: boolean, serverUrl: string|null }} */
  getStatus() {
    return {
      connected: this.connected,
      serverUrl: this.serverUrl,
    };
  }

  // ── Internal ──

  _doConnect() {
    if (!this.serverUrl || !this.apiKey) return;

    const wsUrl = this.serverUrl
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:')
      .replace(/\/$/, '');

    const url = `${wsUrl}/relay?role=desktop&token=${encodeURIComponent(this.apiKey)}`;
    console.log('[CloudRelay] Connecting to:', wsUrl + '/relay');

    try {
      this.ws = new WebSocket(url, {
        perMessageDeflate: { level: 1, threshold: 128 },
      });
    } catch (err) {
      this._emitStatus({ connected: false, error: err.message });
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.connected = true;
      this._emitStatus({ connected: true });
      this._startHeartbeat();
      // Reset the backoff only once the connection proves it can last — an
      // immediate reset here is what turns a flapping relay into a 1s loop.
      this._clearStableTimer();
      this._stableTimer = setTimeout(() => {
        this._stableTimer = null; // null while connected = "this one is healthy"
        this.reconnectAttempt = 0;
        this._unstableStreak = 0;
      }, STABLE_CONNECTION_MS);
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'pong') return; // heartbeat response
        if (this._onMessage) this._onMessage(msg);
      } catch {
        // Non-JSON message, forward raw
        if (this._onMessage) this._onMessage(data.toString());
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log('[CloudRelay] Connection closed:', code, reason?.toString());
      const wasStable = this._stableTimer === null && this.connected;
      this.connected = false;
      this._stopHeartbeat();
      // Timer still pending (or we never even opened) = the connection was short-lived
      if (!wasStable) this._unstableStreak++;
      this._clearStableTimer();
      this._emitStatus({ connected: false, error: code !== 1000 ? `Closed: ${code}` : undefined });
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[CloudRelay] WebSocket error:', err.message);
    });
  }

  _scheduleReconnect() {
    if (!this.shouldReconnect) return;
    // Clear any existing timer before scheduling a new one
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    let delay;
    if (this._unstableStreak >= FLAP_THRESHOLD) {
      // The relay keeps accepting then dropping us. Retrying every second only
      // makes it worse (and spams the UI), so stand down for a while.
      delay = FLAP_COOLDOWN_MS;
      this._unstableStreak = 0;
      this.reconnectAttempt = 0;
      console.warn(`[CloudRelay] Connection unstable — pausing reconnect for ${FLAP_COOLDOWN_MS / 60000} min`);
      this._emitStatus({
        connected: false,
        error: `Connection unstable — retrying in ${FLAP_COOLDOWN_MS / 60000} min`,
      });
    } else {
      delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
      this.reconnectAttempt++;
    }
    this._reconnectTimer = setTimeout(() => this._doConnect(), delay);
  }

  _clearStableTimer() {
    if (this._stableTimer) {
      clearTimeout(this._stableTimer);
      this._stableTimer = null;
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _emitStatus(status) {
    if (this._onStatusChange) this._onStatusChange(status);
  }
}

module.exports = { CloudRelayClient, cloudRelayClient: new CloudRelayClient() };
