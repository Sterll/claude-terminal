/**
 * One lane of the persistent command channel to a remote host.
 *
 * A lane is a single `ssh -T ... -- <dest> /bin/sh -s` process running the
 * driver from `sshDriver.js`. Requests are strictly FIFO and one is in flight
 * at a time, so one TCP connection serves any number of calls with one round
 * trip each and no handshake (design/remote-ssh.md section 2.3). This is what
 * makes remote git and fs usable on Windows, where OpenSSH has no
 * ControlMaster.
 *
 * The lane knows nothing about profiles, reconnects or pools; that is
 * `SshHostService`. It is constructed with a command and argv, which is also
 * how the tests point it at `tests/helpers/fake-ssh.js` and a real local sh.
 *
 * Result contract of `request()`:
 *   { ok: true,  code: 0, stdout: Buffer, stderr: Buffer }
 *   { ok: false, code, stdout, stderr }                     non-zero exit
 *   { ok: false, reason: 'timeout'|'cancelled'|'maxbuffer'|'disconnected', ... }
 * It never rejects.
 */

'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { driverPreamble, killScript } = require('./sshDriver');
const { assertOneLine, classifySshFailure, sshExitStatus } = require('../../shared/remote-shell');

const DEFAULT_MAX_BUFFER = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_READY_TIMEOUT_MS = 20000;
const DEFAULT_GRACE_MS = 2000;
const MAX_HEADER_BYTES = 1024;
const NOISE_TAIL = 4096;
const STDERR_TAIL = 16384;
const PUT_LINE = 64; // openssl base64 -d wants short lines

// ── Frame parser ─────────────────────────────────────────────────────────────

/**
 * Turns the lane's stdout bytes into events. Pure: no I/O, no timers, so it is
 * tested on its own with arbitrary chunk splits.
 *
 * Events:
 *   { type: 'ready', version }
 *   { type: 'fail', reason }            driver could not start (CT-FAIL marker)
 *   { type: 'pid', id, pid }
 *   { type: 'res', id, code, stdout, stderr, overflow, stdoutBytes, stderrBytes }
 *   { type: 'error', message }          protocol violation
 */
class FrameParser {
  /**
   * @param {object} options
   * @param {string} options.nonce
   * @param {(id: number) => number} [options.limitFor]  max response bytes for a request id
   */
  constructor({ nonce, limitFor = () => DEFAULT_MAX_BUFFER }) {
    this.readyMarker = `CT-READY-${nonce} `;
    this.failMarker = `CT-FAIL-${nonce} `;
    this.limitFor = limitFor;
    this.state = 'preready';
    this.pre = '';
    this.noise = '';
    this.headerParts = [];
    this.headerBytes = 0;
    this.body = null;
  }

  /** @param {Buffer} chunk  @returns {object[]} events */
  feed(chunk) {
    const events = [];
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (buf.length > 0 && this.state !== 'broken') {
      if (this.state === 'preready') buf = this._preready(buf, events);
      else if (this.state === 'header') buf = this._header(buf, events);
      else buf = this._body(buf, events);
    }
    return events;
  }

  _preready(buf, events) {
    this.pre += buf.toString('latin1');
    for (const [marker, type] of [[this.readyMarker, 'ready'], [this.failMarker, 'fail']]) {
      const at = this.pre.indexOf(marker);
      if (at === -1) continue;
      const nl = this.pre.indexOf('\n', at);
      if (nl === -1) return Buffer.alloc(0); // marker line not complete yet
      const value = this.pre.slice(at + marker.length, nl).trim();
      this.noise = (this.noise + this.pre.slice(0, at)).slice(-NOISE_TAIL);
      const rest = Buffer.from(this.pre.slice(nl + 1), 'latin1');
      this.pre = '';
      if (type === 'fail') {
        this.state = 'broken';
        events.push({ type: 'fail', reason: value });
        return Buffer.alloc(0);
      }
      this.state = 'header';
      events.push({ type: 'ready', version: Number(value) || 0 });
      return rest;
    }
    // Keep only enough to complete a marker split across chunks.
    const keep = Math.max(this.readyMarker.length, this.failMarker.length) + 32;
    if (this.pre.length > keep) {
      this.noise = (this.noise + this.pre.slice(0, this.pre.length - keep)).slice(-NOISE_TAIL);
      this.pre = this.pre.slice(-keep);
    }
    return Buffer.alloc(0);
  }

  _header(buf, events) {
    const nl = buf.indexOf(10);
    if (nl === -1) {
      this.headerParts.push(buf);
      this.headerBytes += buf.length;
      if (this.headerBytes > MAX_HEADER_BYTES) this._broken(events, 'header line too long');
      return Buffer.alloc(0);
    }
    const line = Buffer.concat([...this.headerParts, buf.subarray(0, nl)]).toString('latin1');
    this.headerParts = [];
    this.headerBytes = 0;
    const rest = buf.subarray(nl + 1);
    const parts = line.split(' ');
    if (parts[0] === 'PID' && parts.length === 3 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])) {
      events.push({ type: 'pid', id: Number(parts[1]), pid: Number(parts[2]) });
      return rest;
    }
    if (parts[0] === 'RES' && parts.length === 5 && parts.slice(1).every((p) => /^\d+$/.test(p))) {
      const [id, code, ol, el] = parts.slice(1).map(Number);
      const limit = this.limitFor(id);
      this.body = {
        id, code, ol, el,
        remaining: ol + el,
        overflow: ol + el > limit,
        out: [], err: [], outLen: 0,
      };
      if (this.body.remaining === 0) this._finishBody(events);
      else this.state = 'body';
      return rest;
    }
    if (line === '') return rest; // stray blank line
    this._broken(events, `unexpected line from driver: ${line.slice(0, 80)}`);
    return Buffer.alloc(0);
  }

  _body(buf, events) {
    const b = this.body;
    const take = Math.min(b.remaining, buf.length);
    const piece = buf.subarray(0, take);
    if (!b.overflow) {
      const consumed = b.ol + b.el - b.remaining;
      const outLeft = Math.max(0, b.ol - consumed);
      if (outLeft > 0) {
        const toOut = Math.min(outLeft, piece.length);
        b.out.push(Buffer.from(piece.subarray(0, toOut)));
        if (piece.length > toOut) b.err.push(Buffer.from(piece.subarray(toOut)));
      } else {
        b.err.push(Buffer.from(piece));
      }
    }
    b.remaining -= take;
    if (b.remaining === 0) this._finishBody(events);
    return buf.subarray(take);
  }

  _finishBody(events) {
    const b = this.body;
    this.body = null;
    this.state = 'header';
    events.push({
      type: 'res',
      id: b.id,
      code: b.code,
      overflow: b.overflow,
      stdoutBytes: b.ol,
      stderrBytes: b.el,
      stdout: b.overflow ? Buffer.alloc(0) : Buffer.concat(b.out),
      stderr: b.overflow ? Buffer.alloc(0) : Buffer.concat(b.err),
    });
  }

  _broken(events, message) {
    this.state = 'broken';
    events.push({ type: 'error', message });
  }
}

// ── Lane ─────────────────────────────────────────────────────────────────────

function laneOpenError(message, extra) {
  const error = new Error(message);
  error.code = 'LANE_OPEN_FAILED';
  Object.assign(error, extra);
  return error;
}

function encodePut(id, input) {
  const b64 = input.toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += PUT_LINE) lines.push(b64.slice(i, i + PUT_LINE));
  return `PUT ${id} ${input.length}\n${lines.length ? lines.join('\n') + '\n' : ''}.\n`;
}

class SshLane extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.command       ssh binary (or node, for the fake)
   * @param {string[]} options.args        full argv, ending with the remote `/bin/sh -s`
   * @param {object} [options.env]
   * @param {Function} [options.spawnImpl]
   * @param {number} [options.readyTimeoutMs]
   * @param {number} [options.graceMs]     how long a killed request may take before the lane is closed
   * @param {string} [options.nonce]
   */
  constructor({ command, args, env = process.env, spawnImpl = spawn, readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS, graceMs = DEFAULT_GRACE_MS, nonce } = {}) {
    super();
    this.command = command;
    this.args = args || [];
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.readyTimeoutMs = readyTimeoutMs;
    this.graceMs = graceMs;
    this.nonce = nonce || crypto.randomBytes(16).toString('hex');
    this.child = null;
    this.ready = false;
    this.exited = false;
    this.closingReason = null;
    this.queue = [];
    this.current = null;
    this.nextId = 1;
    this.stderrTail = '';
    this.killer = null;
    this.lastActivity = 0;
    this._openPromise = null;
    this._finalizeTimer = null;
    this.parser = new FrameParser({
      nonce: this.nonce,
      limitFor: (id) => (this.current && this.current.id === id ? this.current.maxBuffer : DEFAULT_MAX_BUFFER),
    });
  }

  get isOpen() { return this.ready && !this.exited && !this.closingReason; }
  get busy() { return Boolean(this.current); }
  get load() { return this.queue.length + (this.current ? 1 : 0); }

  /** Who sends the process-group kill for a stuck request (a sibling lane). */
  setKiller(fn) { this.killer = typeof fn === 'function' ? fn : null; }

  /**
   * Spawn the process, send the driver, resolve on the ready marker.
   * Rejects with a LANE_OPEN_FAILED error carrying `failKind`
   * ('spawn' | 'exit' | 'timeout' | 'driver' | 'protocol'), `exitCode`,
   * `stderr`, `noise` and `sshFailure` (classifySshFailure).
   */
  open() {
    if (this._openPromise) return this._openPromise;
    this._openPromise = new Promise((resolve, reject) => {
      this._openResolve = resolve;
      this._openReject = reject;
    });
    let child;
    try {
      child = this.spawnImpl(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.env });
    } catch (e) {
      this._failOpen(laneOpenError(`Could not start ssh: ${e.message}`, { failKind: 'spawn', errno: e.code }));
      this.exited = true;
      return this._openPromise;
    }
    this.child = child;
    child.stdin.on('error', () => { /* EPIPE after the remote side went away; exit handling covers it */ });
    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.on('error', (e) => {
      if (!this.ready) this._failOpen(laneOpenError(`Could not start ssh: ${e.message}`, { failKind: 'spawn', errno: e.code }));
      this._finalize(null, null);
    });
    child.on('exit', (code, signal) => {
      // A ControlPersist master can inherit a pipe and keep 'close' from ever
      // firing, so 'exit' is authoritative; the short delay lets buffered
      // stdout land first.
      if (this._finalizeTimer) return;
      this._finalizeTimer = setTimeout(() => this._finalize(code, signal), 250);
    });
    child.on('close', (code, signal) => this._finalize(code, signal));

    this._readyTimer = setTimeout(() => {
      if (this.ready) return;
      this._failOpen(laneOpenError('Timed out waiting for the remote shell', { failKind: 'timeout', stderr: this.stderrTail, sshFailure: 'timeout' }));
      this.close('ready-timeout');
    }, this.readyTimeoutMs);

    child.stdin.write(driverPreamble(this.nonce));
    return this._openPromise;
  }

  _failOpen(error) {
    if (this._openReject) {
      const reject = this._openReject;
      this._openReject = null;
      this._openResolve = null;
      clearTimeout(this._readyTimer);
      reject(error);
    }
  }

  _onStdout(chunk) {
    this.lastActivity = Date.now();
    for (const event of this.parser.feed(chunk)) {
      if (event.type === 'ready') {
        this.ready = true;
        clearTimeout(this._readyTimer);
        if (this._openResolve) {
          const resolve = this._openResolve;
          this._openResolve = null;
          this._openReject = null;
          resolve({ version: event.version, noise: this.parser.noise });
        }
        this._pump();
      } else if (event.type === 'fail') {
        this._failOpen(laneOpenError(`Remote driver could not start (${event.reason})`, { failKind: 'driver', reason: event.reason, stderr: this.stderrTail }));
        this.close('driver-failed');
      } else if (event.type === 'pid') {
        if (this.current && this.current.id === event.id) {
          this.current.pid = event.pid;
          if (this.current.abortReason) this._killCurrent();
        }
      } else if (event.type === 'res') {
        this._onResult(event);
      } else if (event.type === 'error') {
        this._failOpen(laneOpenError(`Protocol error: ${event.message}`, { failKind: 'protocol' }));
        this.emit('protocol-error', event.message);
        this.close('protocol-error');
      }
    }
  }

  _onResult(event) {
    const req = this.current;
    if (!req || req.id !== event.id) return;
    this.current = null;
    this._clearReqTimers(req);
    const base = { code: event.code, stdout: event.stdout, stderr: event.stderr };
    if (req.abortReason) req.resolve({ ...base, ok: false, reason: req.abortReason });
    else if (event.overflow) req.resolve({ ok: false, reason: 'maxbuffer', code: event.code, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), bytes: event.stdoutBytes + event.stderrBytes });
    else req.resolve({ ...base, ok: event.code === 0 });
    this._pump();
  }

  /**
   * Queue a one-line script.
   * @param {string} script
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxBuffer]
   * @param {AbortSignal} [options.signal]
   * @param {Buffer} [options.input]  bytes the script reads on stdin (PUT)
   */
  request(script, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, signal, input } = {}) {
    try { assertOneLine(script); } catch (e) {
      return Promise.resolve({ ok: false, reason: 'invalid', error: e.message, code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    }
    return this._enqueue({ kind: input ? 'put' : 'req', script, input: input ? Buffer.from(input) : null, timeoutMs, maxBuffer, signal });
  }

  /** Export PATH in the driver for every later request on this lane. */
  setPath(value) {
    try { assertOneLine(value); } catch (e) {
      return Promise.resolve({ ok: false, reason: 'invalid', error: e.message });
    }
    return this._enqueue({ kind: 'path', script: value, timeoutMs: DEFAULT_TIMEOUT_MS, maxBuffer: DEFAULT_MAX_BUFFER });
  }

  _enqueue(req) {
    return new Promise((resolve) => {
      req.resolve = resolve;
      if (this.exited || this.closingReason) {
        resolve({ ok: false, reason: 'disconnected', code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
        return;
      }
      if (req.signal) {
        if (req.signal.aborted) {
          resolve({ ok: false, reason: 'cancelled', code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
          return;
        }
        req.onAbort = () => this._abort(req, 'cancelled');
        req.signal.addEventListener('abort', req.onAbort, { once: true });
      }
      req.enqueuedAt = Date.now();
      // The timeout covers queueing too: a caller's budget is wall-clock.
      req.timer = setTimeout(() => this._abort(req, 'timeout'), req.timeoutMs);
      this.queue.push(req);
      this._pump();
    });
  }

  _pump() {
    if (!this.ready || this.current || this.exited || this.closingReason) return;
    const req = this.queue.shift();
    if (!req) return;
    req.id = this.nextId++;
    this.current = req;
    let frame;
    if (req.kind === 'req') frame = `REQ ${req.id}\n${req.script}\n`;
    else if (req.kind === 'put') frame = `${encodePut(req.id, req.input)}${req.script}\n`;
    else frame = `PATH ${req.id}\n${req.script}\n`;
    try { this.child.stdin.write(frame); } catch { /* exit handling resolves it */ }
  }

  _abort(req, reason) {
    if (req.abortReason || req.done) return;
    const queued = this.queue.indexOf(req);
    if (queued !== -1) {
      this.queue.splice(queued, 1);
      this._clearReqTimers(req);
      req.resolve({ ok: false, reason, code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      return;
    }
    if (this.current !== req) return;
    req.abortReason = reason;
    if (req.pid) this._killCurrent();
    // Whether or not the kill lands, the lane is not left hostage to it.
    req.graceTimer = setTimeout(() => {
      if (this.current === req) this.close('stuck');
    }, this.graceMs);
  }

  _killCurrent() {
    const req = this.current;
    if (!req || !req.pid || req.killSent) return;
    req.killSent = true;
    if (!this.killer) return;
    let script;
    try { script = killScript(req.pid); } catch { return; }
    Promise.resolve()
      .then(() => this.killer(script, req.pid))
      .catch(() => { /* the grace timer closes the lane */ });
  }

  _clearReqTimers(req) {
    req.done = true;
    clearTimeout(req.timer);
    clearTimeout(req.graceTimer);
    if (req.signal && req.onAbort) req.signal.removeEventListener('abort', req.onAbort);
  }

  /**
   * Close the lane. `BYE` lets an idle driver exit cleanly; a lane closed
   * because a request is stuck is killed outright, since its driver is blocked
   * in `wait` and will not read BYE.
   */
  close(reason = 'closed') {
    if (this.exited) return;
    if (!this.closingReason) this.closingReason = reason;
    const child = this.child;
    if (!child) return;
    const hardKill = reason === 'stuck' || reason === 'ready-timeout' || reason === 'protocol-error' || !this.ready;
    if (!hardKill) {
      try { child.stdin.write('BYE\n'); } catch { /* already gone */ }
    }
    try { child.stdin.end(); } catch { /* already gone */ }
    if (hardKill) {
      try { child.kill(); } catch { /* already gone */ }
    } else {
      const t = setTimeout(() => { try { if (!this.exited) child.kill(); } catch { /* gone */ } }, 1000);
      if (t.unref) t.unref();
    }
  }

  _finalize(rawCode, signal) {
    if (this.exited) return;
    // -1 on Windows when the server ended the session without a status (see sshExitStatus)
    const code = sshExitStatus(rawCode);
    this.exited = true;
    clearTimeout(this._readyTimer);
    clearTimeout(this._finalizeTimer);
    const stderr = this.stderrTail;
    const sshFailure = classifySshFailure(code, stderr);
    if (!this.ready) {
      this._failOpen(laneOpenError('ssh exited before the remote shell was ready', {
        failKind: 'exit', exitCode: code, signal, stderr, noise: this.parser.noise, sshFailure,
      }));
    }
    const pending = [...(this.current ? [this.current] : []), ...this.queue];
    this.current = null;
    this.queue = [];
    for (const req of pending) {
      const reason = req.abortReason || 'disconnected';
      this._clearReqTimers(req);
      req.resolve({ ok: false, reason, code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), started: req.id !== undefined });
    }
    this.emit('exit', {
      code,
      signal,
      stderr,
      sshFailure,
      expected: Boolean(this.closingReason),
      reason: this.closingReason,
    });
  }
}

module.exports = {
  FrameParser,
  SshLane,
  DEFAULT_MAX_BUFFER,
  DEFAULT_TIMEOUT_MS,
  encodePut,
};
