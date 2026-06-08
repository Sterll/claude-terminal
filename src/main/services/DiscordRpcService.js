/**
 * DiscordRpcService - Discord Rich Presence for Claude Terminal.
 *
 * Shows "Coding in {project} - Claude Terminal" (with elapsed time + logo) on the
 * user's Discord profile, VSCode-style. Zero-dependency implementation of the
 * Discord IPC protocol over the local Discord client socket (named pipe on
 * Windows, unix domain socket elsewhere).
 *
 * Only the PUBLIC application Client ID is required - no Client Secret or bot
 * token. Rich Presence is purely local: we connect to the Discord app already
 * running on the user's machine, no network call leaves the device.
 */

'use strict';

const net = require('net');
const path = require('path');
const fs = require('fs');

// Public Discord application Client ID for "Claude Terminal".
// Safe to ship in source: a Client ID is a public identifier, not a secret.
const CLIENT_ID = '1511308729839259728';

// Asset key uploaded in the Discord Developer Portal (Rich Presence > Art Assets).
const LOGO_KEY = 'logo';

// Discord IPC opcodes
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const RECONNECT_DELAY = 15000; // Discord not running yet → retry slowly

/** Candidate IPC socket paths (Discord opens discord-ipc-0..9). */
function ipcCandidates() {
  if (process.platform === 'win32') {
    return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  }
  const base = process.env.XDG_RUNTIME_DIR
    || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  // Plain install + Flatpak/Snap sandbox sub-paths.
  const prefixes = ['', 'snap.discord/', 'app/com.discordapp.Discord/', 'app/com.discordapp.DiscordCanary/'];
  const out = [];
  for (let i = 0; i < 10; i++) {
    for (const p of prefixes) out.push(path.join(base, `${p}discord-ipc-${i}`));
  }
  return out;
}

class DiscordRpcService {
  constructor() {
    this.socket = null;
    this.connected = false;   // handshake (READY) complete
    this.enabled = false;
    this.showProject = true;
    this._readBuf = Buffer.alloc(0);
    this._reconnectTimer = null;
    this._connecting = false;
    this._sessionStart = Date.now();
    this._current = null;     // last activity, re-sent on (re)connect
  }

  /** Read persisted prefs (the renderer owns settings.json). Defaults: ON. */
  _loadSettings() {
    try {
      const { settingsFile } = require('../utils/paths');
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      this.enabled = s.discordRpcEnabled !== false;        // default ON
      this.showProject = s.discordRpcShowProject !== false; // default ON
    } catch {
      this.enabled = true;
      this.showProject = true;
    }
  }

  /** Called once at app startup. */
  start() {
    this._loadSettings();
    this._sessionStart = Date.now();
    if (this.enabled) {
      this.setIdle();      // queue a base presence to send on connect
      this._connect();
    }
  }

  // ── Public presence helpers ──────────────────────────────────────────────

  /** Base "idle" presence (app open, no active session). */
  setIdle() {
    this.setActivity({ details: 'Idle', state: 'In Claude Terminal' });
  }

  /**
   * Presence for a project the user is working on.
   * @param {string} name  Project display name
   * @param {Object} [opts] { coding?: boolean, subtitle?: string, type?: string }
   *        subtitle is the second presence line (e.g. "on main"); when omitted
   *        it falls back to "{type} project".
   */
  setProject(name, opts = {}) {
    if (!name || !this.showProject) {
      this.setActivity({ details: 'Using Claude Terminal', state: undefined });
      return;
    }
    const subtitle = opts.subtitle || (opts.type ? `${opts.type} project` : undefined);
    this.setActivity({
      details: opts.coding ? `Coding in ${name}` : `Working on ${name}`,
      state: subtitle,
    });
  }

  /**
   * Low-level activity setter. Fields map to Discord's activity object.
   * @param {{details?:string, state?:string, since?:number}} a
   */
  setActivity(a) {
    this._current = a || null;
    if (this.connected) this._sendActivity(this._current);
  }

  clearActivity() {
    this._current = null;
    if (this.connected) this._sendRaw('SET_ACTIVITY', { pid: process.pid, activity: null });
  }

  /** Apply a live settings change from the renderer. */
  applySettings({ enabled, showProject } = {}) {
    if (typeof showProject === 'boolean') this.showProject = showProject;
    if (typeof enabled === 'boolean' && enabled !== this.enabled) {
      if (enabled) this.enable(); else this.disable();
      return;
    }
    // showProject toggled while connected → re-render last project presence
    if (this.connected && this._current) this._sendActivity(this._current);
  }

  enable() {
    if (this.enabled && this.connected) return;
    this.enabled = true;
    if (!this._current) this.setIdle();
    this._connect();
  }

  disable() {
    this.enabled = false;
    this._clearReconnect();
    this._destroySocket();
  }

  isConnected() {
    return this.connected;
  }

  destroy() {
    this._clearReconnect();
    try { this.clearActivity(); } catch { /* socket may be gone */ }
    this._destroySocket();
  }

  // ── Connection management ────────────────────────────────────────────────

  _connect() {
    if (!this.enabled || this._connecting || this.connected) return;
    this._connecting = true;
    this._tryCandidate(0);
  }

  _tryCandidate(idx) {
    const candidates = ipcCandidates();
    if (idx >= candidates.length) {
      this._connecting = false;
      this._scheduleReconnect(); // Discord likely closed
      return;
    }
    let settled = false;
    const sock = net.connect(candidates[idx]);
    sock.once('connect', () => {
      settled = true;
      this.socket = sock;
      this._readBuf = Buffer.alloc(0);
      sock.on('data', (d) => this._onData(d));
      sock.on('close', () => this._onClose());
      sock.on('error', () => { /* surfaced via close */ });
      this._send(OP_HANDSHAKE, { v: 1, client_id: CLIENT_ID });
    });
    sock.once('error', () => {
      if (settled) return;
      try { sock.destroy(); } catch { /* noop */ }
      this._tryCandidate(idx + 1);
    });
  }

  _onClose() {
    this.connected = false;
    this.socket = null;
    if (this.enabled) this._scheduleReconnect();
  }

  _destroySocket() {
    this.connected = false;
    this._connecting = false;
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* noop */ }
      this.socket = null;
    }
  }

  _scheduleReconnect() {
    if (!this.enabled || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connecting = false;
      this._connect();
    }, RECONNECT_DELAY);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  // ── Wire protocol ────────────────────────────────────────────────────────

  _onData(chunk) {
    this._readBuf = Buffer.concat([this._readBuf, chunk]);
    while (this._readBuf.length >= 8) {
      const op = this._readBuf.readInt32LE(0);
      const len = this._readBuf.readInt32LE(4);
      if (this._readBuf.length < 8 + len) break;
      const payload = this._readBuf.slice(8, 8 + len).toString('utf8');
      this._readBuf = this._readBuf.slice(8 + len);
      this._handleFrame(op, payload);
    }
  }

  _handleFrame(op, payloadStr) {
    let data = null;
    try { data = JSON.parse(payloadStr); } catch { /* ignore */ }

    if (op === OP_PING) { this._send(OP_PONG, data); return; }
    if (op === OP_CLOSE) { this._destroySocket(); this._scheduleReconnect(); return; }

    if (op === OP_FRAME && data && data.evt === 'READY') {
      this.connected = true;
      this._connecting = false;
      console.log('[DiscordRPC] Connected to Discord');
      this._sendActivity(this._current || { details: 'Idle', state: 'In Claude Terminal' });
    }
  }

  _sendActivity(a) {
    if (!a) return;
    const activity = {
      timestamps: { start: a.since || this._sessionStart },
      assets: { large_image: LOGO_KEY, large_text: 'Claude Terminal' },
      instance: false,
    };
    if (a.details) activity.details = String(a.details).slice(0, 128);
    if (a.state) activity.state = String(a.state).slice(0, 128);
    this._sendRaw('SET_ACTIVITY', { pid: process.pid, activity });
  }

  _sendRaw(cmd, args) {
    this._send(OP_FRAME, {
      cmd,
      args,
      nonce: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }

  _send(op, data) {
    if (!this.socket || this.socket.destroyed) return false;
    try {
      const json = Buffer.from(JSON.stringify(data), 'utf8');
      const header = Buffer.alloc(8);
      header.writeInt32LE(op, 0);
      header.writeInt32LE(json.length, 4);
      this.socket.write(Buffer.concat([header, json]));
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = new DiscordRpcService();
