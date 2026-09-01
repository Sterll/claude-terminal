/**
 * Voice transcription service (main process).
 *
 * fetch and keytar are stubbed so the Groq contract, the WAV container and the
 * error messages can be checked without a network call or a credential store.
 */

jest.mock('keytar', () => {
  const store = new Map();
  return {
    __store: store,
    getPassword: jest.fn(async (s, a) => store.get(`${s}:${a}`) ?? null),
    setPassword: jest.fn(async (s, a, v) => { store.set(`${s}:${a}`, v); }),
    deletePassword: jest.fn(async (s, a) => store.delete(`${s}:${a}`)),
  };
});

const keytar = require('keytar');
const voice = require('../../src/main/services/VoiceService');

/** A buffer of `ms` worth of silent PCM16 @16 kHz. */
function pcmOfDuration(ms) {
  return Buffer.alloc(Math.round((voice.SAMPLE_RATE * ms) / 1000) * 2, 0);
}

function mockFetch(impl) {
  global.fetch = jest.fn(impl);
  return global.fetch;
}

const okResponse = (text) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ text }),
  text: async () => JSON.stringify({ text }),
});

const errResponse = (status, body = '', retryAfter = null) => ({
  ok: false,
  status,
  headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? retryAfter : null) },
  json: async () => ({}),
  text: async () => body,
});

beforeEach(async () => {
  keytar.__store.clear();
  await voice.setApiKey('gsk_test_key_1234');
  delete global.fetch;
});

// ── WAV container ────────────────────────────────────────────────────────────

describe('pcm16ToWav', () => {
  test('writes a 44-byte RIFF/WAVE header in front of the samples', () => {
    const pcm = Buffer.alloc(1000, 1);
    const wav = voice.pcm16ToWav(pcm, 16000);

    expect(wav.length).toBe(pcm.length + 44);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
  });

  test('declares mono 16-bit PCM at the requested rate', () => {
    const wav = voice.pcm16ToWav(Buffer.alloc(320), 16000);

    expect(wav.readUInt16LE(20)).toBe(1);        // format = PCM
    expect(wav.readUInt16LE(22)).toBe(1);        // channels
    expect(wav.readUInt32LE(24)).toBe(16000);    // sample rate
    expect(wav.readUInt32LE(28)).toBe(32000);    // byte rate
    expect(wav.readUInt16LE(32)).toBe(2);        // block align
    expect(wav.readUInt16LE(34)).toBe(16);       // bits per sample
  });

  test('sizes both length fields consistently', () => {
    const pcm = Buffer.alloc(2048);
    const wav = voice.pcm16ToWav(pcm);

    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
  });
});

describe('pcmDurationMs', () => {
  test('converts byte length to milliseconds', () => {
    expect(voice.pcmDurationMs(pcmOfDuration(1000))).toBeCloseTo(1000, 0);
    expect(voice.pcmDurationMs(pcmOfDuration(250))).toBeCloseTo(250, 0);
  });
});

// ── Credentials ──────────────────────────────────────────────────────────────

describe('api key handling', () => {
  test('stores, reports and clears the key', async () => {
    expect(await voice.hasApiKey()).toBe(true);
    await voice.clearApiKey();
    expect(await voice.hasApiKey()).toBe(false);
  });

  test('refuses an empty key', async () => {
    await expect(voice.setApiKey('   ')).rejects.toThrow(/empty/i);
  });

  test('masks the key instead of exposing it', () => {
    const masked = voice.maskKey('gsk_abcdefghijklmnop');

    expect(masked).toContain('gsk_');
    expect(masked).not.toContain('efghijkl');
    expect(voice.maskKey(null)).toBeNull();
    expect(voice.maskKey('short')).toBe('••••');
  });
});

// ── Transcription ────────────────────────────────────────────────────────────

describe('transcribe', () => {
  test('returns what Groq heard', async () => {
    mockFetch(async () => okResponse('  ouvre le git  '));

    const res = await voice.transcribe(pcmOfDuration(2000), { format: 'pcm16' });

    expect(res.ok).toBe(true);
    expect(res.text).toBe('ouvre le git');
  });

  test('posts multipart to the Groq endpoint with the key as a bearer token', async () => {
    const fetchMock = mockFetch(async () => okResponse('bonjour'));

    await voice.transcribe(pcmOfDuration(2000), { format: 'pcm16', language: 'fr' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('api.groq.com');
    expect(url).toContain('/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer gsk_test_key_1234');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('model')).toBe(voice.DEFAULT_MODEL);
    expect(init.body.get('language')).toBe('fr');
  });

  test('sends webm straight through without wrapping it in a WAV header', async () => {
    const fetchMock = mockFetch(async () => okResponse('ok'));
    const webm = Buffer.from('fake-opus-payload-that-is-long-enough');

    await voice.transcribe(webm, { format: 'webm', durationMs: 3000 });

    const file = fetchMock.mock.calls[0][1].body.get('file');
    expect(file.size).toBe(webm.length);
    expect(file.type).toBe('audio/webm');
  });

  test('rejects an empty buffer before making a request', async () => {
    const fetchMock = mockFetch(async () => okResponse('nope'));

    const res = await voice.transcribe(Buffer.alloc(0), { format: 'pcm16' });

    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('does not bill a request for a blip too short to be speech', async () => {
    const fetchMock = mockFetch(async () => okResponse('x'));

    const res = await voice.transcribe(pcmOfDuration(100), { format: 'pcm16' });

    expect(res.ok).toBe(false);
    expect(res.tooShort).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('flags a missing key rather than calling Groq anonymously', async () => {
    await voice.clearApiKey();
    const fetchMock = mockFetch(async () => okResponse('x'));

    const res = await voice.transcribe(pcmOfDuration(2000), { format: 'pcm16' });

    expect(res.ok).toBe(false);
    expect(res.needsKey).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('refuses French on the English-only model instead of returning garbage', async () => {
    const fetchMock = mockFetch(async () => okResponse('garbage'));

    const res = await voice.transcribe(pcmOfDuration(2000), {
      format: 'pcm16',
      model: 'distil-whisper-large-v3-en',
      language: 'fr',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only handles English/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('allows the English-only model for English', async () => {
    mockFetch(async () => okResponse('hello'));

    const res = await voice.transcribe(pcmOfDuration(2000), {
      format: 'pcm16',
      model: 'distil-whisper-large-v3-en',
      language: 'en',
    });

    expect(res.ok).toBe(true);
  });

  test('rejects an unknown model', async () => {
    const res = await voice.transcribe(pcmOfDuration(2000), { format: 'pcm16', model: 'whisper-9000' });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown model/i);
  });

  test('treats an empty transcript as nothing said', async () => {
    mockFetch(async () => okResponse('   '));

    const res = await voice.transcribe(pcmOfDuration(2000), { format: 'pcm16' });

    expect(res.ok).toBe(false);
    expect(res.tooShort).toBe(true);
  });

  test('reports a network failure in one readable sentence', async () => {
    mockFetch(async () => { throw new Error('getaddrinfo ENOTFOUND'); });

    const res = await voice.transcribe(pcmOfDuration(2000), { format: 'pcm16' });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/could not reach groq/i);
  });

  test('reports a timeout distinctly from a network failure', async () => {
    mockFetch(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const res = await voice.transcribe(pcmOfDuration(2000), { format: 'pcm16', timeoutMs: 5 });

    expect(res.error).toMatch(/too long to answer/i);
  });

  test('surfaces the HTTP status on an API error', async () => {
    mockFetch(async () => errResponse(401, 'invalid api key'));

    const res = await voice.transcribe(pcmOfDuration(2000), { format: 'pcm16' });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.error).toMatch(/key rejected/i);
  });
});

describe('describeHttpFailure', () => {
  test('points a rejected key at the settings panel', () => {
    expect(voice.describeHttpFailure(401)).toMatch(/Settings > Voice/);
    expect(voice.describeHttpFailure(403)).toMatch(/Settings > Voice/);
  });

  test('passes the retry delay through on a rate limit', () => {
    expect(voice.describeHttpFailure(429, '', '30')).toContain('30s');
    expect(voice.describeHttpFailure(429)).toMatch(/rate limit/i);
  });

  test('has a message for oversized audio and for an outage', () => {
    expect(voice.describeHttpFailure(413)).toMatch(/too long/i);
    expect(voice.describeHttpFailure(503)).toMatch(/unavailable/i);
  });

  test('falls back to the status and a trimmed body', () => {
    const msg = voice.describeHttpFailure(418, 'x'.repeat(500));

    expect(msg).toContain('418');
    expect(msg.length).toBeLessThan(260);
  });
});

describe('testApiKey', () => {
  test('accepts a key that Groq does not reject', async () => {
    mockFetch(async () => okResponse(''));

    await expect(voice.testApiKey('gsk_candidate')).resolves.toMatchObject({ ok: true });
  });

  test('reports why a bad key failed', async () => {
    mockFetch(async () => errResponse(401, 'nope'));

    const res = await voice.testApiKey('gsk_bad');

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/key rejected/i);
  });

  test('tests the candidate key, not the stored one', async () => {
    const fetchMock = mockFetch(async () => okResponse(''));

    await voice.testApiKey('gsk_candidate_key');

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer gsk_candidate_key');
  });
});
