'use strict';

/**
 * Voice transcription (speech-to-text).
 *
 * The renderer captures the microphone and hands over raw PCM; everything that
 * needs a secret or the network happens here.
 *
 * Groq is the only backend for now. It was picked over running Whisper locally
 * because the user is gaming while they talk: a local model burns CPU exactly
 * when it is least available, whereas an API call costs nothing on the machine
 * and is more accurate in French than any model small enough to run alongside a
 * game. A local backend can be added behind `transcribe()` later without the
 * renderer noticing.
 *
 * The API key lives in the OS credential store, never in settings.json, and is
 * never sent to the renderer.
 */

const keytar = require('keytar');

const SERVICE_NAME = 'claude-terminal';
const ACCOUNT_NAME = 'groq-api-key';

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

/** Groq bills a 10s minimum per request, so very short blips are pure waste. */
const MIN_SPEECH_MS = 350;

/** Free tier caps uploads at 25 MB; 16 kHz mono PCM16 hits that around 13 min. */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

const SAMPLE_RATE = 16000;

const MODELS = {
  'whisper-large-v3-turbo': { label: 'Balanced', multilingual: true },
  'whisper-large-v3': { label: 'Best accuracy', multilingual: true },
  'distil-whisper-large-v3-en': { label: 'English only', multilingual: false },
};

const DEFAULT_MODEL = 'whisper-large-v3-turbo';

// ── WAV encoding ─────────────────────────────────────────────────────────────

/**
 * Wrap raw mono PCM16 in a WAV container.
 *
 * Groq accepts several formats but not headerless PCM, and a 44-byte header is
 * cheaper than pulling in an encoder.
 *
 * @param {Buffer} pcm - little-endian signed 16-bit mono samples
 * @param {number} sampleRate
 * @returns {Buffer}
 */
function pcm16ToWav(pcm, sampleRate = SAMPLE_RATE) {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // PCM chunk size
  header.writeUInt16LE(1, 20);           // format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Duration of a mono PCM16 buffer, in milliseconds. */
function pcmDurationMs(pcm, sampleRate = SAMPLE_RATE) {
  return (pcm.length / 2 / sampleRate) * 1000;
}

// ── Credentials ──────────────────────────────────────────────────────────────

async function getApiKey() {
  try {
    return await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
  } catch {
    return null;
  }
}

async function setApiKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) throw new Error('API key is empty');
  await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, trimmed);
}

async function clearApiKey() {
  try {
    await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
  } catch { /* nothing stored */ }
}

async function hasApiKey() {
  return !!(await getApiKey());
}

/** Show enough of the key to recognise it, never the whole thing. */
function maskKey(key) {
  if (!key) return null;
  const str = String(key);
  if (str.length <= 8) return '••••';
  return `${str.slice(0, 4)}••••${str.slice(-4)}`;
}

// ── Error mapping ────────────────────────────────────────────────────────────

/**
 * Turn an HTTP failure into something worth saying out loud. A voice user gets
 * one sentence, so it has to name the actual problem and the way out.
 */
function describeHttpFailure(status, bodyText, retryAfter) {
  switch (status) {
    case 400:
      return 'Groq rejected the audio. It may be empty or corrupted.';
    case 401:
    case 403:
      return 'Groq API key rejected. Check it in Settings > Voice.';
    case 413:
      return 'Recording too long for Groq. Keep it under a few minutes.';
    case 429: {
      const wait = retryAfter ? ` Retry in ${retryAfter}s.` : '';
      return `Groq rate limit reached.${wait}`;
    }
    case 500:
    case 502:
    case 503:
      return 'Groq is unavailable right now. Try again in a moment.';
    default: {
      const detail = (bodyText || '').slice(0, 200).trim();
      return `Groq error ${status}${detail ? `: ${detail}` : ''}`;
    }
  }
}

// ── Transcription ────────────────────────────────────────────────────────────

/**
 * Send audio to Groq and return what was said.
 *
 * Two input shapes are supported. The renderer uses `webm` — MediaRecorder's
 * opus output, which Groq accepts natively — because that avoids an
 * AudioWorklet (blocked by the app's `script-src 'self'` CSP when loaded from a
 * blob URL), avoids resampling, and ships ~10x fewer bytes over IPC. Raw
 * `pcm16` is kept for callers that already have samples.
 *
 * @param {Buffer} audio
 * @param {Object} [opts]
 * @param {'webm'|'pcm16'} [opts.format]
 * @param {number} [opts.durationMs] - required for webm; derived for pcm16
 * @param {string} [opts.model]
 * @param {string} [opts.language] - ISO code; omit to let Groq detect
 * @param {string} [opts.apiKey] - overrides the stored key (used to test a key)
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok: boolean, text?: string, error?: string, durationMs?: number}>}
 */
async function transcribe(audio, opts = {}) {
  const {
    format = 'pcm16',
    model = DEFAULT_MODEL,
    language = null,
    timeoutMs = 20000,
  } = opts;

  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    return { ok: false, error: 'No audio captured.' };
  }

  // Compressed audio carries no duration in its byte count, so the recorder
  // reports it; PCM is uniform enough to measure directly.
  const durationMs = format === 'pcm16'
    ? pcmDurationMs(audio)
    : Number(opts.durationMs) || null;

  if (durationMs !== null && durationMs < MIN_SPEECH_MS) {
    // Not an error the user needs to hear about — they just did not speak.
    return { ok: false, error: 'Too short — nothing was said.', tooShort: true };
  }

  const body = format === 'pcm16' ? pcm16ToWav(audio) : audio;
  const filename = format === 'pcm16' ? 'speech.wav' : 'speech.webm';
  const mimeType = format === 'pcm16' ? 'audio/wav' : 'audio/webm';

  if (body.length > MAX_AUDIO_BYTES) {
    return { ok: false, error: 'Recording too long. Keep it under a few minutes.' };
  }

  const apiKey = opts.apiKey || await getApiKey();
  if (!apiKey) {
    return { ok: false, error: 'No Groq API key configured. Add one in Settings > Voice.', needsKey: true };
  }

  if (!MODELS[model]) {
    return { ok: false, error: `Unknown model "${model}".` };
  }
  // distil-whisper is English-only; sending French to it returns confident garbage.
  if (language && language !== 'en' && !MODELS[model].multilingual) {
    return { ok: false, error: `Model "${model}" only handles English. Pick another one in Settings > Voice.` };
  }

  const form = new FormData();
  form.append('file', new Blob([body], { type: mimeType }), filename);
  form.append('model', model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      return {
        ok: false,
        error: describeHttpFailure(res.status, bodyText, res.headers.get('retry-after')),
        status: res.status,
      };
    }

    const payload = await res.json();
    const text = String(payload?.text || '').trim();
    if (!text) return { ok: false, error: 'Nothing recognisable in the audio.', tooShort: true };

    return { ok: true, text, durationMs };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, error: 'Groq took too long to answer.' };
    }
    return { ok: false, error: `Could not reach Groq: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check a key without burning a real recording: a fraction of a second of
 * silence is enough for Groq to accept or reject the credentials.
 */
async function testApiKey(apiKey) {
  const silence = Buffer.alloc(SAMPLE_RATE * 2 /* bytes per sample */, 0);
  const res = await transcribe(silence, { apiKey, timeoutMs: 15000 });

  // Silence transcribes to nothing, which is a success as far as auth goes.
  if (res.ok || res.tooShort) return { ok: true };
  return { ok: false, error: res.error };
}

module.exports = {
  transcribe,
  testApiKey,
  getApiKey,
  setApiKey,
  clearApiKey,
  hasApiKey,
  maskKey,
  pcm16ToWav,
  pcmDurationMs,
  describeHttpFailure,
  MODELS,
  DEFAULT_MODEL,
  SAMPLE_RATE,
  MIN_SPEECH_MS,
  MAX_AUDIO_BYTES,
};
