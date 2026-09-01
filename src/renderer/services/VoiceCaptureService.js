'use strict';

/**
 * Microphone capture for voice control.
 *
 * Records with MediaRecorder (opus in a WebM container, which Groq accepts as
 * is) rather than pulling raw samples through an AudioWorklet: a worklet has to
 * be loaded from a URL, and the app's `script-src 'self'` CSP blocks the blob
 * URL that would take. This path also skips resampling and sends roughly a
 * tenth of the bytes over IPC.
 *
 * Stopping is automatic. Electron's globalShortcut only reports the key press,
 * never the release, so hold-to-talk is impossible from a fullscreen game;
 * recording is toggled on and closed by a silence detector instead. An
 * AnalyserNode on the same stream watches the level - no worklet needed there
 * either.
 */

const DEFAULT_OPTIONS = {
  // Below this RMS the frame counts as silence. Deliberately low: a gaming
  // headset picks up fans and game audio bleed, and cutting someone off
  // mid-sentence is far worse than a little trailing silence.
  silenceThreshold: 0.012,
  // How long the level must stay down before we stop.
  silenceHangoverMs: 1200,
  // Never wait forever if the mic is picking up constant noise.
  maxDurationMs: 30000,
  // Ignore silence during the first moments: people pause before starting.
  leadInMs: 700,
};

class VoiceCaptureService {
  constructor(opts = {}) {
    this._opts = { ...DEFAULT_OPTIONS, ...opts };
    this._stream = null;
    this._recorder = null;
    this._audioContext = null;
    this._analyser = null;
    this._chunks = [];
    this._levelTimer = null;
    this._startedAt = 0;
    this._lastLoudAt = 0;
    this._state = 'idle';
    this._listeners = { state: [], level: [] };
    this._settle = null;
  }

  get state() {
    return this._state;
  }

  get isRecording() {
    return this._state === 'recording';
  }

  /** @param {'state'|'level'} event */
  on(event, fn) {
    if (this._listeners[event]) this._listeners[event].push(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const list = this._listeners[event];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }

  _emit(event, payload) {
    for (const fn of this._listeners[event] || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[Voice] ${event} listener failed:`, err);
      }
    }
  }

  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    this._emit('state', state);
  }

  /** Whether this environment can record at all. */
  static isSupported() {
    return typeof navigator !== 'undefined'
      && !!navigator.mediaDevices?.getUserMedia
      && typeof MediaRecorder !== 'undefined';
  }

  /** Pick a container MediaRecorder supports and Groq accepts. */
  static pickMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ];
    for (const type of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(type)) {
        return type;
      }
    }
    return '';
  }

  /**
   * Start recording. Resolves with the captured audio once silence, the max
   * duration, or an explicit stop() ends it.
   *
   * @param {Object} [opts] { deviceId? }
   * @returns {Promise<{ok: boolean, audio?: ArrayBuffer, mimeType?: string, durationMs?: number, error?: string, cancelled?: boolean}>}
   */
  async start(opts = {}) {
    if (this._state !== 'idle') {
      return { ok: false, error: 'Already recording.' };
    }
    if (!VoiceCaptureService.isSupported()) {
      return { ok: false, error: 'Microphone capture is not available in this environment.' };
    }

    this._setState('starting');

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(opts.deviceId && opts.deviceId !== 'default' ? { deviceId: { exact: opts.deviceId } } : {}),
        },
      });
    } catch (err) {
      this._setState('idle');
      return { ok: false, error: this._describeMicFailure(err) };
    }

    try {
      const mimeType = VoiceCaptureService.pickMimeType();
      this._recorder = new MediaRecorder(this._stream, mimeType ? { mimeType } : undefined);
      this._chunks = [];

      this._recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this._chunks.push(e.data);
      };

      const finished = new Promise((resolve) => { this._settle = resolve; });

      this._recorder.onstop = async () => {
        const durationMs = Date.now() - this._startedAt;
        const blob = new Blob(this._chunks, { type: this._recorder?.mimeType || 'audio/webm' });
        this._teardown();

        if (!blob.size) {
          this._setState('idle');
          this._settle?.({ ok: false, error: 'Nothing was recorded.' });
          return;
        }

        this._setState('idle');
        this._settle?.({
          ok: true,
          audio: await blob.arrayBuffer(),
          mimeType: blob.type,
          durationMs,
        });
      };

      this._recorder.onerror = (e) => {
        this._teardown();
        this._setState('idle');
        this._settle?.({ ok: false, error: `Recorder failed: ${e.error?.message || 'unknown error'}` });
      };

      this._startedAt = Date.now();
      this._lastLoudAt = this._startedAt;
      this._recorder.start(250);
      this._startSilenceWatch();
      this._setState('recording');

      return finished;
    } catch (err) {
      this._teardown();
      this._setState('idle');
      return { ok: false, error: `Could not start recording: ${err.message}` };
    }
  }

  /** Stop and keep the audio. */
  stop() {
    if (this._recorder && this._recorder.state !== 'inactive') {
      this._recorder.stop();
    }
  }

  /** Stop and throw the audio away — Escape while speaking. */
  cancel() {
    if (this._state === 'idle') return;
    const settle = this._settle;
    if (this._recorder && this._recorder.state !== 'inactive') {
      this._recorder.onstop = null;
      this._recorder.stop();
    }
    this._teardown();
    this._setState('idle');
    settle?.({ ok: false, cancelled: true });
  }

  /** Toggle, since a global hotkey can only report a press. */
  async toggle(opts = {}) {
    if (this._state === 'recording') {
      this.stop();
      return null;
    }
    return this.start(opts);
  }

  // ── Silence detection ──────────────────────────────────────────────────────

  _startSilenceWatch() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this._audioContext = new AudioCtx();
      const source = this._audioContext.createMediaStreamSource(this._stream);
      this._analyser = this._audioContext.createAnalyser();
      this._analyser.fftSize = 1024;
      source.connect(this._analyser);
    } catch (err) {
      // Without a level meter the recording still works; it just needs an
      // explicit stop or the max-duration cutoff.
      console.warn('[Voice] level analysis unavailable:', err.message);
      return;
    }

    const buffer = new Float32Array(this._analyser.fftSize);

    this._levelTimer = setInterval(() => {
      if (!this._analyser || this._state !== 'recording') return;

      this._analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
      const rms = Math.sqrt(sum / buffer.length);

      this._emit('level', rms);

      const now = Date.now();
      const elapsed = now - this._startedAt;

      if (rms >= this._opts.silenceThreshold) this._lastLoudAt = now;

      if (elapsed >= this._opts.maxDurationMs) {
        this.stop();
        return;
      }
      // Give the speaker a moment to get going before silence can end it.
      if (elapsed < this._opts.leadInMs) return;
      if (now - this._lastLoudAt >= this._opts.silenceHangoverMs) this.stop();
    }, 100);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  _teardown() {
    if (this._levelTimer) {
      clearInterval(this._levelTimer);
      this._levelTimer = null;
    }
    if (this._audioContext) {
      try { this._audioContext.close(); } catch (_) { /* already closed */ }
      this._audioContext = null;
    }
    this._analyser = null;
    if (this._stream) {
      // Releases the OS mic indicator; leaving this out keeps the mic "in use".
      for (const track of this._stream.getTracks()) {
        try { track.stop(); } catch (_) { /* already stopped */ }
      }
      this._stream = null;
    }
    this._recorder = null;
    this._chunks = [];
  }

  _describeMicFailure(err) {
    switch (err?.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Microphone access denied. Allow it in Windows privacy settings, then retry.';
      case 'NotFoundError':
        return 'No microphone found.';
      case 'NotReadableError':
        return 'The microphone is already in use by another application.';
      case 'OverconstrainedError':
        return 'The selected microphone is unavailable. Pick another in Settings > Voice.';
      default:
        return `Could not open the microphone: ${err?.message || 'unknown error'}`;
    }
  }
}

module.exports = { VoiceCaptureService, DEFAULT_OPTIONS };
