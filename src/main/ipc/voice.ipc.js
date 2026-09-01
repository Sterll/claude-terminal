'use strict';

/**
 * Voice IPC — microphone transcription and Groq credentials.
 *
 * The renderer owns audio capture (getUserMedia lives there) and sends raw PCM
 * over. Everything touching the key or the network stays in main: the key is
 * read from the OS credential store here and never crosses back to the
 * renderer, which only ever sees a masked form.
 */

const { ipcMain } = require('electron');
const voiceService = require('../services/VoiceService');

function registerVoiceHandlers() {
  /**
   * 'voice:transcribe'
   * @param {ArrayBuffer} audioBuffer - webm/opus from MediaRecorder, or raw PCM16
   * @param {Object} opts { format?, durationMs?, model?, language? }
   */
  ipcMain.handle('voice:transcribe', async (_event, audioBuffer, opts = {}) => {
    try {
      const audio = Buffer.from(audioBuffer || new ArrayBuffer(0));
      return await voiceService.transcribe(audio, {
        format: opts.format || 'webm',
        durationMs: opts.durationMs,
        model: opts.model,
        language: opts.language || null,
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /** 'voice:has-key' — whether a key is stored, never the key itself. */
  ipcMain.handle('voice:has-key', async () => {
    try {
      const key = await voiceService.getApiKey();
      return { ok: true, hasKey: !!key, masked: voiceService.maskKey(key) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /** 'voice:set-key' — store a key in the OS credential store. */
  ipcMain.handle('voice:set-key', async (_event, key) => {
    try {
      await voiceService.setApiKey(key);
      return { ok: true, masked: voiceService.maskKey(key) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /** 'voice:clear-key' */
  ipcMain.handle('voice:clear-key', async () => {
    try {
      await voiceService.clearApiKey();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * 'voice:test-key'
   * Validates a key before the user relies on it mid-game. Falls back to the
   * stored key when called with nothing, so the settings panel can re-check.
   */
  ipcMain.handle('voice:test-key', async (_event, key) => {
    try {
      const candidate = key || await voiceService.getApiKey();
      if (!candidate) return { ok: false, error: 'No API key to test.' };
      return await voiceService.testApiKey(candidate);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /** 'voice:models' — model list for the settings picker. */
  ipcMain.handle('voice:models', async () => ({
    ok: true,
    models: Object.entries(voiceService.MODELS).map(([id, meta]) => ({
      id,
      label: meta.label,
      multilingual: meta.multilingual,
    })),
    defaultModel: voiceService.DEFAULT_MODEL,
    sampleRate: voiceService.SAMPLE_RATE,
  }));
}

module.exports = { registerVoiceHandlers };
