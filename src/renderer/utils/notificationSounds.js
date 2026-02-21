/**
 * Notification Sounds - Web Audio API synthesized sounds
 * Generates short notification sounds programmatically without bundled audio files
 */

let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Resume if suspended (browser autoplay policy)
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

/**
 * Subtle - soft two-tone ascending chime
 */
function playSubtle(volume) {
  const ctx = getAudioContext();
  const now = ctx.currentTime;

  // First tone (C5)
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = 'sine';
  osc1.frequency.value = 523;
  gain1.gain.setValueAtTime(volume * 0.3, now);
  gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
  osc1.connect(gain1).connect(ctx.destination);
  osc1.start(now);
  osc1.stop(now + 0.3);

  // Second tone (E5)
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = 'sine';
  osc2.frequency.value = 659;
  gain2.gain.setValueAtTime(0, now + 0.1);
  gain2.gain.linearRampToValueAtTime(volume * 0.3, now + 0.15);
  gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
  osc2.connect(gain2).connect(ctx.destination);
  osc2.start(now + 0.1);
  osc2.stop(now + 0.45);
}

/**
 * Bell - classic notification bell
 */
function playBell(volume) {
  const ctx = getAudioContext();
  const now = ctx.currentTime;

  const frequencies = [830, 1245, 1660];
  frequencies.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const amp = volume * (0.25 - i * 0.06);
    gain.gain.setValueAtTime(amp, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.6);
  });
}

/**
 * Pulse - quick rhythmic pulse
 */
function playPulse(volume) {
  const ctx = getAudioContext();
  const now = ctx.currentTime;

  for (let i = 0; i < 3; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 440;
    const t = now + i * 0.1;
    gain.gain.setValueAtTime(volume * 0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.06);
  }
}

const sounds = { subtle: playSubtle, bell: playBell, pulse: playPulse };

/**
 * Play a notification sound
 * @param {string} soundName - 'none', 'subtle', 'bell', 'pulse'
 * @param {number} volume - 0.0 to 1.0
 */
function playNotificationSound(soundName, volume = 0.5) {
  if (!soundName || soundName === 'none') return;
  const fn = sounds[soundName];
  if (fn) {
    try {
      fn(Math.max(0, Math.min(1, volume)));
    } catch (e) {
      console.warn('Failed to play notification sound:', e);
    }
  }
}

module.exports = { playNotificationSound };
