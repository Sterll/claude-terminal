/**
 * The companion's sounds, synthesised live with Web Audio (no files): a
 * purr, a boing, a thud, a pop, a chomp, a chime, and a soft breath of
 * filtered noise that follows the breathing exercise.
 *
 * Off by default. The AudioContext is only created the first time a sound
 * plays while enabled, which is always after a user gesture (turning sound on
 * is one), so Chromium's autoplay policy never blocks it.
 */

let ctx = null;
let master = null;
let noiseBuffer = null;
let enabled = false;
let breathNode = null;

function audio() {
  if (!enabled) return null;
  if (!ctx) {
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = 0.2;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function noise() {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  return src;
}

function tone(freq, dur, { type = 'sine', gain = 0.4, slideTo = null, delay = 0 } = {}) {
  const a = audio();
  if (!a) return;
  const t0 = a.currentTime + delay;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function burst(dur, { freq = 1000, q = 1, gain = 0.4, delay = 0, type = 'bandpass' } = {}) {
  const a = audio();
  if (!a) return;
  const t0 = a.currentTime + delay;
  const src = noise();
  const f = a.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

function purr() {
  const a = audio();
  if (!a) return;
  const t0 = a.currentTime;
  const src = noise();
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 260;
  const g = a.createGain();
  g.gain.value = 0.25;
  // A 24 Hz tremolo on lowpassed noise is close enough to a purr.
  const lfo = a.createOscillator();
  const depth = a.createGain();
  lfo.frequency.value = 24;
  depth.gain.value = 0.25;
  lfo.connect(depth).connect(g.gain);
  const env = a.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(1, t0 + 0.12);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.8);
  src.connect(f).connect(g).connect(env).connect(master);
  src.start(t0);
  lfo.start(t0);
  src.stop(t0 + 0.85);
  lfo.stop(t0 + 0.85);
}

const SOUNDS = {
  boing: () => tone(300, 0.2, { type: 'triangle', slideTo: 620, gain: 0.3 }),
  thud: () => tone(150, 0.14, { slideTo: 55, gain: 0.5 }),
  pop: () => tone(900, 0.08, { type: 'triangle', slideTo: 420, gain: 0.3 }),
  blip: () => tone(740, 0.07, { type: 'triangle', gain: 0.2 }),
  chomp: () => { burst(0.06, { freq: 1400, q: 2, gain: 0.35 }); burst(0.05, { freq: 900, q: 2, gain: 0.25, delay: 0.09 }); },
  chime: () => {
    tone(1046.5, 0.7, { gain: 0.22 });
    tone(1318.5, 0.8, { gain: 0.18, delay: 0.12 });
    tone(1568, 1.0, { gain: 0.15, delay: 0.24 });
  },
  purr,
};

function play(name) {
  if (!enabled) return;
  try { SOUNDS[name]?.(); } catch { /* audio is a nicety */ }
}

/**
 * Breath of filtered noise for one breathing phase.
 * @param {'inhale'|'hold'|'exhale'} phase
 * @param {number} ms
 */
function breath(phase, ms) {
  stopBreath();
  const a = audio();
  if (!a || phase === 'hold') return;
  const t0 = a.currentTime;
  const end = t0 + ms / 1000;
  const src = noise();
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  const g = a.createGain();
  if (phase === 'inhale') {
    f.frequency.setValueAtTime(300, t0);
    f.frequency.exponentialRampToValueAtTime(1100, end);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.22, end - 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
  } else {
    f.frequency.setValueAtTime(1000, t0);
    f.frequency.exponentialRampToValueAtTime(220, end);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.2, t0 + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
  }
  src.connect(f).connect(g).connect(master);
  src.start(t0);
  src.stop(end + 0.05);
  breathNode = src;
}

function stopBreath() {
  if (!breathNode) return;
  try { breathNode.stop(); } catch { /* already stopped */ }
  breathNode = null;
}

function setEnabled(on) {
  enabled = !!on;
  if (!enabled) stopBreath();
}

function dispose() {
  stopBreath();
  if (ctx) ctx.close().catch(() => {});
  ctx = null;
  master = null;
  noiseBuffer = null;
}

module.exports = { play, breath, stopBreath, setEnabled, isEnabled: () => enabled, dispose };
