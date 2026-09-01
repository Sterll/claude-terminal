/**
 * Microphone capture (renderer).
 *
 * jsdom has no MediaRecorder, getUserMedia or AudioContext, so they are stubbed
 * here. What matters is the contract around them: the mic is always released,
 * a denial produces an actionable sentence, cancel discards the audio, and
 * silence ends the recording on its own — the last one is what makes a global
 * hotkey usable at all, since Electron never reports the key release.
 */

const { VoiceCaptureService } = require('../../src/renderer/services/VoiceCaptureService');

let stoppedTracks;
let recorderInstances;
let analyserLevel;

class FakeMediaRecorder {
  static isTypeSupported(type) {
    return type === 'audio/webm;codecs=opus';
  }

  constructor(stream, opts = {}) {
    this.stream = stream;
    this.mimeType = opts.mimeType || 'audio/webm';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    recorderInstances.push(this);
  }

  start() {
    this.state = 'recording';
  }

  /** Emit a chunk then settle, the way a real recorder does on stop(). */
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['opus-bytes'], { type: this.mimeType }) });
    this.onstop?.();
  }

  failWith(message) {
    this.onerror?.({ error: new Error(message) });
  }
}

function installAudioStubs({ getUserMedia } = {}) {
  stoppedTracks = 0;
  recorderInstances = [];
  analyserLevel = 0;

  global.MediaRecorder = FakeMediaRecorder;

  const track = { stop: () => { stoppedTracks++; } };
  const stream = { getTracks: () => [track] };

  global.navigator.mediaDevices = {
    getUserMedia: getUserMedia || jest.fn(async () => stream),
  };

  global.AudioContext = class {
    createMediaStreamSource() { return { connect: () => {} }; }
    createAnalyser() {
      return {
        fftSize: 1024,
        getFloatTimeDomainData: (buf) => buf.fill(analyserLevel),
      };
    }
    close() {}
  };

  // jsdom's Blob has no arrayBuffer() in this environment.
  if (!Blob.prototype.arrayBuffer) {
    Blob.prototype.arrayBuffer = async function arrayBuffer() {
      return new ArrayBuffer(this.size);
    };
  }
}

beforeEach(() => {
  installAudioStubs();
});

afterEach(() => {
  jest.useRealTimers();
  delete global.MediaRecorder;
  delete global.AudioContext;
});

describe('support detection', () => {
  test('reports available when both APIs exist', () => {
    expect(VoiceCaptureService.isSupported()).toBe(true);
  });

  test('reports unavailable without MediaRecorder', () => {
    delete global.MediaRecorder;
    expect(VoiceCaptureService.isSupported()).toBe(false);
  });

  test('picks the opus container Groq accepts', () => {
    expect(VoiceCaptureService.pickMimeType()).toBe('audio/webm;codecs=opus');
  });
});

describe('recording', () => {
  test('returns the captured audio once stopped', async () => {
    const voice = new VoiceCaptureService();
    const pending = voice.start();

    await Promise.resolve();
    voice.stop();

    const res = await pending;
    expect(res.ok).toBe(true);
    expect(res.audio).toBeInstanceOf(ArrayBuffer);
    expect(res.mimeType).toContain('webm');
    expect(typeof res.durationMs).toBe('number');
  });

  test('always releases the microphone', async () => {
    const voice = new VoiceCaptureService();
    const pending = voice.start();

    await Promise.resolve();
    voice.stop();
    await pending;

    expect(stoppedTracks).toBe(1);
    expect(voice.state).toBe('idle');
  });

  test('refuses to start twice', async () => {
    const voice = new VoiceCaptureService();
    const pending = voice.start();
    await Promise.resolve();

    const second = await voice.start();
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already recording/i);

    voice.stop();
    await pending;
  });

  test('announces state transitions', async () => {
    const voice = new VoiceCaptureService();
    const states = [];
    voice.on('state', (s) => states.push(s));

    const pending = voice.start();
    await Promise.resolve();
    voice.stop();
    await pending;

    expect(states).toContain('recording');
    expect(states[states.length - 1]).toBe('idle');
  });

  test('cancel discards the audio and still frees the mic', async () => {
    const voice = new VoiceCaptureService();
    const pending = voice.start();
    await Promise.resolve();

    voice.cancel();

    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.cancelled).toBe(true);
    expect(stoppedTracks).toBe(1);
  });

  test('toggle starts, then stops without starting a second recording', async () => {
    const voice = new VoiceCaptureService();
    const pending = voice.toggle();
    await Promise.resolve();

    expect(voice.isRecording).toBe(true);
    expect(await voice.toggle()).toBeNull();

    await pending;
    expect(recorderInstances).toHaveLength(1);
  });

  test('surfaces a recorder failure instead of hanging', async () => {
    const voice = new VoiceCaptureService();
    const pending = voice.start();
    await Promise.resolve();

    recorderInstances[0].failWith('device lost');

    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/device lost/);
    expect(stoppedTracks).toBe(1);
  });
});

describe('microphone failures', () => {
  const denial = (name) => {
    const err = new Error('denied');
    err.name = name;
    return async () => { throw err; };
  };

  test('explains a permission denial and how to fix it', async () => {
    installAudioStubs({ getUserMedia: denial('NotAllowedError') });

    const res = await new VoiceCaptureService().start();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/privacy settings/i);
  });

  test('explains a missing microphone', async () => {
    installAudioStubs({ getUserMedia: denial('NotFoundError') });

    const res = await new VoiceCaptureService().start();
    expect(res.error).toMatch(/no microphone/i);
  });

  test('explains a microphone held by another application', async () => {
    installAudioStubs({ getUserMedia: denial('NotReadableError') });

    const res = await new VoiceCaptureService().start();
    expect(res.error).toMatch(/already in use/i);
  });

  test('leaves the service usable after a failure', async () => {
    installAudioStubs({ getUserMedia: denial('NotAllowedError') });

    const voice = new VoiceCaptureService();
    await voice.start();

    expect(voice.state).toBe('idle');
  });
});

describe('silence detection', () => {
  test('stops on its own once the speaker goes quiet', async () => {
    jest.useFakeTimers();
    const voice = new VoiceCaptureService({ leadInMs: 200, silenceHangoverMs: 500 });

    const pending = voice.start();
    await Promise.resolve();
    await Promise.resolve();

    analyserLevel = 0.2;          // speaking
    jest.advanceTimersByTime(400);
    expect(voice.isRecording).toBe(true);

    analyserLevel = 0;            // gone quiet
    jest.advanceTimersByTime(700);

    const res = await pending;
    expect(res.ok).toBe(true);
    expect(voice.state).toBe('idle');
  });

  test('does not cut off during the lead-in pause before speaking', async () => {
    jest.useFakeTimers();
    const voice = new VoiceCaptureService({ leadInMs: 2000, silenceHangoverMs: 200 });

    const pending = voice.start();
    await Promise.resolve();
    await Promise.resolve();

    analyserLevel = 0;
    jest.advanceTimersByTime(1500);

    expect(voice.isRecording).toBe(true);

    voice.cancel();
    await pending;
  });

  test('gives up at the maximum duration even in constant noise', async () => {
    jest.useFakeTimers();
    const voice = new VoiceCaptureService({ maxDurationMs: 1000, leadInMs: 100 });

    const pending = voice.start();
    await Promise.resolve();
    await Promise.resolve();

    analyserLevel = 0.5;          // never quiet
    jest.advanceTimersByTime(1200);

    const res = await pending;
    expect(res.ok).toBe(true);
  });

  test('reports the level so the UI can show a meter', async () => {
    jest.useFakeTimers();
    const voice = new VoiceCaptureService();
    const levels = [];
    voice.on('level', (l) => levels.push(l));

    const pending = voice.start();
    await Promise.resolve();
    await Promise.resolve();

    analyserLevel = 0.3;
    jest.advanceTimersByTime(300);

    expect(levels.length).toBeGreaterThan(0);
    expect(levels[levels.length - 1]).toBeCloseTo(0.3, 1);

    voice.cancel();
    await pending;
  });
});
