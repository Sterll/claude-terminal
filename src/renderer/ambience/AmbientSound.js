/**
 * AmbientSound - procedural background soundscapes for the lofi themes.
 *
 * Everything is synthesised with the Web Audio API: no audio files, no
 * fetches, no AudioWorklet (the CSP and the renderer setup rule them out).
 *
 *   const sound = createAmbientSound();
 *   sound.play('rain');      // crossfades (~1.5 s) from whatever was playing
 *   sound.setVolume(0.4);    // 0..1, perceptual (squared) curve, smoothed
 *   sound.stop();            // ~1 s fade, then every node is released
 *
 * Structure
 * ---------
 * - A soundscape is a factory `(ctx, output, opts) -> { stop(fade), release() }`
 *   that builds its own node graph into `output`. `ctx` may be any
 *   BaseAudioContext, so the exact same code renders offline (tests, previews).
 * - `createKit` is the shared toolbox: cached noise buffers, a generated
 *   reverb, one-shot "voices" that disconnect themselves when they end, and a
 *   lookahead scheduler for event-based sounds (drops, chirps, notes).
 * - The controller owns one AudioContext (created lazily on first play) and a
 *   master chain: highpass (strip inaudible sub-bass from brown noise) ->
 *   gentle lowpass -> soft compressor -> volume -> speakers.
 *
 * Levels: every soundscape is calibrated (see `level` in each definition) to
 * sit around -30..-22 dBFS RMS at volume 1, peaks well under 0.8. The numbers
 * were measured with `.preview/sound-check.cjs` through `renderOffline`.
 */

'use strict';

const { seeded, clamp } = require('./scenes/_kit');

// ---------------------------------------------------------------------------
// Tunables

const CROSSFADE_SECONDS = 1.5;
const STOP_FADE_SECONDS = 1.0;
/** Scheduler tick. Short enough to react, long enough to be free. */
const TICK_MS = 100;
/**
 * How far ahead events are committed to the audio clock. Generous on purpose:
 * Electron throttles timers in hidden windows (down to ~1 Hz), and events
 * already handed to Web Audio keep perfect time regardless. Stopping is still
 * instant because a stopping scene fades its own output gain and then kills
 * every source it scheduled, future ones included.
 */
const LOOKAHEAD_SECONDS = 1.2;
const NOISE_SECONDS = 6;
const NOISE_RMS = 0.25;
const DEFAULT_VOLUME = 0.7;

// ---------------------------------------------------------------------------
// Small helpers

function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

/** Connect nodes in series; the last element may be an AudioParam. */
function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

function isOffline(ctx) {
  return typeof globalThis.OfflineAudioContext !== 'undefined' && ctx instanceof globalThis.OfflineAudioContext;
}

/**
 * Freeze a param at its current (possibly mid-ramp) value so a new ramp can
 * start from there. cancelScheduledValues alone would leave an in-progress
 * ramp/curve in place or make the value jump.
 */
function holdParam(param, t) {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(t);
  } else {
    const v = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(v, t);
  }
}

function kill(node) {
  if (!node) return;
  if (typeof node.stop === 'function') { try { node.stop(); } catch (_) { /* not started / already stopped */ } }
  try { node.disconnect(); } catch (_) { /* already disconnected */ }
}

/** Smooth 0 -> 1 -> 0 envelope shape, peaking at `rise` (0..1), as a curve. */
function swellCurve(n, rise, lo, hi, geometric) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const u = x < rise ? x / rise : 1 - (x - rise) / (1 - rise);
    const y = 0.5 - 0.5 * Math.cos(Math.PI * clamp(u, 0, 1));
    out[i] = geometric ? lo * Math.pow(hi / lo, y) : lo + (hi - lo) * y;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Noise and reverb buffers (generated once per context)

const noiseCache = new WeakMap();

/**
 * White / pink / brown stereo noise loops. Channels are independent so loops
 * are naturally wide. The tail is equal-power crossfaded into the head so the
 * loop point is seamless (brown noise would otherwise click), and every buffer
 * is normalised to the same RMS so mix gains mean the same thing across kinds.
 */
function noiseBank(ctx) {
  let bank = noiseCache.get(ctx);
  if (bank) return bank;
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * NOISE_SECONDS);
  const xf = Math.floor(sr * 0.25);

  const build = (fill) => {
    const buf = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const raw = new Float32Array(n + xf);
      fill(raw);
      let mean = 0;
      for (let i = 0; i < raw.length; i++) mean += raw[i];
      mean /= raw.length;
      const data = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) data[i] = raw[i] - mean;
      for (let i = 0; i < xf; i++) {
        const a = (i / xf) * Math.PI / 2;
        data[i] = (raw[i] - mean) * Math.sin(a) + (raw[n + i] - mean) * Math.cos(a);
      }
      let sq = 0;
      for (let i = 0; i < n; i++) sq += data[i] * data[i];
      const g = NOISE_RMS / Math.sqrt(sq / n || 1);
      for (let i = 0; i < n; i++) data[i] *= g;
    }
    return buf;
  };

  bank = {
    white: build((d) => { for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }),
    // Paul Kellet's refined pink filter: -3 dB/oct, the "natural" rain/wind tilt.
    pink: build((d) => {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
      }
    }),
    // Leaky integrator: -6 dB/oct above ~150 Hz, flat below, so no runaway sub.
    brown: build((d) => {
      let last = 0;
      for (let i = 0; i < d.length; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        d[i] = last;
      }
    }),
  };
  noiseCache.set(ctx, bank);
  return bank;
}

const reverbCache = new WeakMap();

/**
 * Synthetic room: decaying stereo noise whose brightness also decays (a
 * one-pole lowpass closing over time), which is what makes real tails sound
 * soft rather than like hiss. -60 dB at `seconds`.
 */
function impulseResponse(ctx, seconds) {
  let perCtx = reverbCache.get(ctx);
  if (!perCtx) { perCtx = new Map(); reverbCache.set(ctx, perCtx); }
  const key = seconds.toFixed(2);
  if (perCtx.has(key)) return perCtx.get(key);
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const x = t / seconds;
      const a = 0.7 - 0.6 * x;
      lp += a * ((Math.random() * 2 - 1) - lp);
      const fadeIn = t < 0.015 ? t / 0.015 : 1;
      d[i] = lp * Math.exp(-6.9 * x) * fadeIn;
    }
  }
  perCtx.set(key, buf);
  return buf;
}

// ---------------------------------------------------------------------------
// The kit: node bookkeeping + scheduler shared by every soundscape

/**
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} output
 * @param {{ fadeIn?: number, random?: () => number, level?: number, onRelease?: () => void }} opts
 */
function createKit(ctx, output, opts = {}) {
  const rand = opts.random || Math.random;
  const offline = isOffline(ctx);
  const endTime = offline ? ctx.length / ctx.sampleRate : Infinity;
  const start = ctx.currentTime;
  const persistent = [];
  const voices = new Set();
  const groups = new Set();
  const generators = [];
  let timer = null;
  let stopping = false;
  let released = false;
  let releaseTimer = null;

  const keep = (node) => { persistent.push(node); return node; };

  // `out` carries the fades; `dest` is the per-soundscape calibration level.
  const out = keep(ctx.createGain());
  out.connect(output);
  if (opts.fadeIn > 0) {
    out.gain.setValueAtTime(0, start);
    out.gain.linearRampToValueAtTime(1, start + opts.fadeIn);
  }
  const dest = keep(ctx.createGain());
  dest.gain.value = opts.level == null ? 1 : opts.level;
  dest.connect(out);

  const inputOf = (d) => (d && d.input ? d.input : d);

  function finish(v) {
    if (!voices.delete(v)) return;
    try { v.src.disconnect(); } catch (_) { /* noop */ }
    for (const n of v.nodes) { try { n.disconnect(); } catch (_) { /* noop */ } }
    if (v.group && --v.group.refs <= 0) dropGroup(v.group);
  }

  function dropGroup(g) {
    if (!groups.delete(g)) return;
    for (const n of g.nodes) { try { n.disconnect(); } catch (_) { /* noop */ } }
  }

  function tick() {
    if (released) return;
    const now = ctx.currentTime;
    for (const gen of generators) {
      try { gen(now + LOOKAHEAD_SECONDS, now); } catch (e) { console.error('[AmbientSound] scheduler', e); }
    }
  }

  function release() {
    if (released) return;
    released = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
    generators.length = 0;
    for (const v of Array.from(voices)) { try { v.src.stop(); } catch (_) { /* noop */ } finish(v); }
    for (const g of Array.from(groups)) dropGroup(g);
    for (const n of persistent) kill(n);
    persistent.length = 0;
    if (opts.onRelease) { try { opts.onRelease(); } catch (_) { /* noop */ } }
  }

  function stop(fade = STOP_FADE_SECONDS) {
    if (stopping || released) return;
    stopping = true;
    if (timer) { clearInterval(timer); timer = null; }
    generators.length = 0;
    if (!(fade > 0) || offline) { release(); return; }
    const now = ctx.currentTime;
    holdParam(out.gain, now);
    out.gain.linearRampToValueAtTime(0, now + fade);
    releaseTimer = setTimeout(release, (fade + 0.15) * 1000);
  }

  const k = {
    ctx, rand, offline, start, dest,
    rr: (a, b) => a + (b - a) * rand(),
    ri: (a, b) => Math.floor(a + (b - a + 1) * rand()),
    pick: (arr) => arr[Math.floor(rand() * arr.length)],
    chance: (p) => rand() < p,
    /** Exponential inter-arrival time: Poisson-like, never metronomic. */
    expo: (mean) => -Math.log(1 - rand() * 0.999) * mean,
    keep,

    gain(v = 1) { const g = keep(ctx.createGain()); g.gain.value = v; return g; },
    /** NB: Web Audio interprets Q in dB for lowpass/highpass, linear for bandpass. */
    filter(type, freq, Q) {
      const f = keep(ctx.createBiquadFilter());
      f.type = type;
      f.frequency.value = freq;
      if (Q != null) f.Q.value = Q;
      return f;
    },
    lp(freq, qdb = -3) { return k.filter('lowpass', freq, qdb); },
    hp(freq, qdb = -3) { return k.filter('highpass', freq, qdb); },
    bp(freq, q = 1) { return k.filter('bandpass', freq, q); },
    pan(p) { const n = keep(ctx.createStereoPanner()); n.pan.value = p; return n; },

    /** A looping noise bed, started at a random point so layers decorrelate. */
    loop(kind) {
      const s = keep(ctx.createBufferSource());
      s.buffer = noiseBank(ctx)[kind];
      s.loop = true;
      s.start(start, rand() * s.buffer.duration);
      return s;
    },
    osc(type, freq, detune = 0) {
      const o = keep(ctx.createOscillator());
      if (typeof type === 'string') o.type = type; else o.setPeriodicWave(type);
      o.frequency.value = freq;
      o.detune.value = detune;
      o.start(start);
      return o;
    },
    /** Convolver send bus feeding `dest`; returns the node to send into. */
    reverb(seconds, wet) {
      const conv = keep(ctx.createConvolver());
      conv.buffer = impulseResponse(ctx, seconds);
      chain(conv, k.gain(wet), dest);
      return conv;
    },

    /**
     * Transient nodes that share a tail (a bird phrase's panner, a note's
     * envelope). Disconnected once every voice routed through them has ended.
     * `targets` may be one node or an array (dry + reverb send).
     */
    group(nodes, targets) {
      chain(...nodes);
      const last = nodes[nodes.length - 1];
      for (const t of [].concat(targets)) last.connect(inputOf(t));
      const g = { input: nodes[0], nodes, refs: 0 };
      groups.add(g);
      return g;
    },

    /**
     * Register a one-shot source: start/stop it and disconnect it plus its
     * private `nodes` when it ends, so nothing piles up over hours of play.
     */
    voice(src, nodes, t, end, group, offset) {
      const v = { src, nodes, group };
      voices.add(v);
      if (group) group.refs++;
      src.onended = () => finish(v);
      if (offset != null) src.start(t, offset); else src.start(t);
      src.stop(end);
      return v;
    },

    /** Short enveloped slice of a noise buffer through one filter. */
    noiseBurst(t, o) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBank(ctx)[o.kind || 'white'];
      if (o.rate) src.playbackRate.value = o.rate;
      const f = ctx.createBiquadFilter();
      f.type = o.type || 'bandpass';
      f.frequency.value = o.freq || 3000;
      if (o.Q != null) f.Q.value = o.Q;
      const g = ctx.createGain();
      const attack = o.attack || 0.001;
      const decay = o.decay || 0.01;
      g.gain.value = 0;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(o.peak, t + attack);
      g.gain.setTargetAtTime(0, t + attack + (o.hold || 0), decay);
      const nodes = [f, g];
      chain(src, f, g);
      let last = g;
      if (o.pan) {
        const p = ctx.createStereoPanner();
        p.pan.value = o.pan;
        g.connect(p);
        nodes.push(p);
        last = p;
      }
      const target = o.dest || dest;
      last.connect(inputOf(target));
      const end = t + attack + (o.hold || 0) + decay * 7;
      return k.voice(src, nodes, t, end, target.input ? target : null, rand() * (src.buffer.duration - 1));
    },

    /**
     * Enveloped oscillator. `glide` = [[dt, freq], ...] exponential pitch
     * moves after t; envelope = linear attack, optional hold, exp decay.
     */
    tone(t, o) {
      const osc = ctx.createOscillator();
      if (o.wave) osc.setPeriodicWave(o.wave); else osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.freq, t);
      for (const [dt, f] of o.glide || []) osc.frequency.exponentialRampToValueAtTime(f, t + dt);
      if (o.detune) osc.detune.value = o.detune;
      const g = ctx.createGain();
      const attack = o.attack || 0.005;
      const hold = o.hold || 0;
      const decay = o.decay || 0.1;
      g.gain.value = 0;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(o.peak, t + attack);
      if (hold) g.gain.setValueAtTime(o.peak, t + attack + hold);
      g.gain.setTargetAtTime(0, t + attack + hold, decay);
      osc.connect(g);
      const nodes = [g];
      let last = g;
      if (o.pan) {
        const p = ctx.createStereoPanner();
        p.pan.value = o.pan;
        g.connect(p);
        nodes.push(p);
        last = p;
      }
      const target = o.dest || dest;
      last.connect(inputOf(target));
      const end = t + attack + hold + decay * 7;
      return k.voice(osc, nodes, t, end, target.input ? target : null);
    },

    /**
     * Lookahead event stream. `step(t)` schedules whatever happens at audio
     * time `t` and returns the delay until its next call. Live, a single
     * setInterval commits events up to LOOKAHEAD_SECONDS ahead of the audio
     * clock; offline, the whole render length is scheduled up front.
     */
    every(firstDelay, step) {
      if (stopping || released) return;
      let t = start + firstDelay;
      const gen = (until, now) => {
        while (t < until) {
          // After a long stall (should not happen with the lookahead), resync
          // rather than firing a burst of overdue events at once.
          if (t < now) t = now + 0.05;
          if (t >= until) break;
          let d = step(t);
          if (!(d > 0.005)) d = 0.005;
          t += d;
        }
      };
      generators.push(gen);
      if (offline) gen(endTime, -Infinity);
      else {
        gen(ctx.currentTime + LOOKAHEAD_SECONDS, ctx.currentTime);
        if (!timer) timer = setInterval(tick, TICK_MS);
      }
    },

    /** Slow random walk of a param: new target every [a, b] s, glide `tc`. */
    wander(param, lo, hi, every, tc) {
      k.every(0, (t) => {
        param.setTargetAtTime(k.rr(lo, hi), t, tc);
        return k.rr(every[0], every[1]);
      });
    },

    handle: {
      stop,
      release,
      get released() { return released; },
      stats: () => ({ voices: voices.size, groups: groups.size, nodes: persistent.length }),
    },
  };
  return k;
}

/** Wrap a builder into a soundscape factory with leak-safe error handling. */
function defineScene(level, build) {
  return function create(ctx, output, opts = {}) {
    const k = createKit(ctx, output, { ...opts, level: level * (opts.level == null ? 1 : opts.level) });
    try {
      build(k);
    } catch (e) {
      k.handle.release();
      throw e;
    }
    return k.handle;
  };
}

// ---------------------------------------------------------------------------
// Soundscapes

/**
 * Shared rain body. A slow deterministic "intensity" curve drives the bed's
 * level and brightness and the droplet density together, so the rain
 * breathes as one thing rather than as unrelated layers.
 */
function buildRain(k, heavy) {
  const { ctx } = k;
  const p1 = k.rr(0, 6.28);
  const p2 = k.rr(0, 6.28);
  const intensity = (t) => clamp(
    0.75 + 0.17 * Math.sin((t * 2 * Math.PI) / 41 + p1) + 0.08 * Math.sin((t * 2 * Math.PI) / 13.3 + p2),
    0.45, 1,
  );

  // Hiss of the rain itself.
  const bedLp = k.lp(heavy ? 4200 : 5200, -4);
  const bedGain = k.gain(0.55);
  chain(k.loop('pink'), k.hp(heavy ? 350 : 500), bedLp, bedGain, k.dest);
  // Body: the low wash of water on roofs and ground.
  chain(k.loop('brown'), k.lp(heavy ? 700 : 550), k.gain(heavy ? 0.55 : 0.35), k.dest);

  k.every(0, (t) => {
    const i = intensity(t);
    bedGain.gain.setTargetAtTime(0.55 * i, t, 0.9);
    bedLp.frequency.setTargetAtTime((heavy ? 2600 : 3200) + 2400 * i, t, 1.2);
    return 0.5;
  });

  // Droplets: tiny ringing ticks on near surfaces, plus rarer duller plops.
  const dropBus = k.lp(7000);
  dropBus.connect(k.dest);
  const rate = heavy ? 16 : 9;
  k.every(k.rr(0.05, 0.2), (t) => {
    const i = intensity(t);
    if (k.chance(0.85)) {
      k.noiseBurst(t, {
        type: 'bandpass', freq: k.rr(1800, 4800), Q: k.rr(2, 6),
        peak: k.rr(0.15, 0.6) * (0.6 + 0.4 * i), attack: 0.0008, decay: k.rr(0.004, 0.012),
        pan: k.rr(-0.9, 0.9), dest: dropBus,
      });
    } else {
      k.noiseBurst(t, {
        type: 'bandpass', freq: k.rr(700, 1400), Q: k.rr(3, 7),
        peak: k.rr(0.2, 0.5), attack: 0.001, decay: k.rr(0.01, 0.02),
        pan: k.rr(-0.7, 0.7), dest: dropBus,
      });
    }
    return Math.max(0.01, k.expo(1 / (rate * (0.4 + 0.8 * i))));
  });
  return { ctx, intensity };
}

const rain = defineScene(0.29, (k) => { buildRain(k, false); });

const storm = defineScene(0.25, (k) => {
  buildRain(k, true);
  const verb = k.reverb(4, 0.35);

  /**
   * Distant thunder: a brown-noise rumble through two lowpasses, shaped as a
   * few overlapping slow swells. Attacks are long time-constants, never a
   * crack, and the cutoff rises with each swell for a sense of rolling.
   */
  function thunder(t) {
    const { ctx } = k;
    const src = ctx.createBufferSource();
    src.buffer = noiseBank(ctx).brown;
    src.loop = true;
    const lp1 = ctx.createBiquadFilter();
    lp1.type = 'lowpass';
    lp1.Q.value = -3;
    lp1.frequency.value = 90;
    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.Q.value = -3;
    lp2.frequency.value = 320;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    const pan = ctx.createStereoPanner();
    pan.pan.value = k.rr(-0.5, 0.5);

    const rolls = k.ri(2, 4);
    let c = t;
    const strength = k.rr(0.6, 1);
    for (let r = 0; r < rolls; r++) {
      const peak = strength * k.rr(0.55, 1) * (r === 0 ? 0.7 : 1);
      const rise = k.rr(0.5, 1.1);
      g.gain.setTargetAtTime(peak, c, rise / 2.5);
      lp1.frequency.setTargetAtTime(k.rr(150, 260), c, rise / 2);
      g.gain.setTargetAtTime(peak * 0.25, c + rise, k.rr(0.7, 1.4));
      lp1.frequency.setTargetAtTime(90, c + rise, 1.2);
      c += rise + k.rr(0.6, 1.8);
    }
    g.gain.setTargetAtTime(0, c, k.rr(1.2, 2));
    chain(src, lp1, lp2, g, pan);
    pan.connect(k.dest);
    pan.connect(verb);
    k.voice(src, [lp1, lp2, g, pan], t, c + 12, null, k.rr(0, 5));
  }
  // First roll comes early so the soundscape introduces itself.
  k.every(k.rr(3, 7), (t) => { thunder(t); return k.rr(20, 60); });
});

const waves = defineScene(0.22, (k) => {
  /**
   * One wave layer: a brown+pink wash whose level and lowpass cutoff follow
   * a smooth swell curve (fast-ish rise, long draw-back), plus foam hiss that
   * peaks just after the crest and lingers as the water recedes.
   */
  function layer(panPos, amp, firstDelay) {
    const sum = k.gain(1);
    chain(k.loop('brown'), k.gain(1), sum);
    chain(k.loop('pink'), k.gain(0.35), sum);
    const lp = k.lp(300, -4);
    const g = k.gain(0.2 * amp);
    const p = k.pan(panPos);
    chain(sum, lp, g, p, k.dest);

    const foamG = k.gain(0);
    chain(k.loop('white'), k.hp(2200), k.lp(6000), foamG, p);

    k.every(firstDelay, (t) => {
      const period = k.rr(8, 12);
      const dur = period - 0.03;
      const rise = k.rr(0.32, 0.45);
      const peak = k.rr(0.75, 1) * amp;
      g.gain.setValueCurveAtTime(swellCurve(64, rise, 0.2 * amp, peak, false), t, dur);
      lp.frequency.setValueCurveAtTime(swellCurve(64, rise, 260, k.rr(900, 1700), true), t, dur);
      foamG.gain.setValueCurveAtTime(swellCurve(64, Math.min(0.7, rise + 0.12), 0.0, 0.08 * peak, false), t, dur);
      return period;
    });
  }
  // Never start a curve at t=0: it could collide with the initial value event.
  layer(-0.35, 1, 0.05);
  layer(0.4, 0.6, k.rr(3, 6));
});

const forest = defineScene(0.66, (k) => {
  const { ctx } = k;
  // Leaves: broad band of pink noise, slow gusts in level and colour.
  const leafBp = k.bp(2200, 0.6);
  const leafG = k.gain(0.3);
  chain(k.loop('pink'), leafBp, k.lp(6000), leafG, k.dest);
  k.wander(leafG.gain, 0.12, 0.4, [2, 5], 1.4);
  k.wander(leafBp.frequency, 1400, 3200, [3, 6], 2);
  // Low air movement under it.
  const airG = k.gain(0.18);
  chain(k.loop('brown'), k.lp(350), airG, k.dest);
  k.wander(airG.gain, 0.08, 0.25, [3, 7], 2);

  const verb = k.reverb(2.5, 0.5);

  /** One bird phrase in its own panned/distance group. */
  function phrase(t) {
    const dist = k.rr(0.35, 1);
    const grp = k.group([ctx.createGain(), ctx.createBiquadFilter(), ctx.createStereoPanner()], [k.dest, verb]);
    grp.nodes[0].gain.value = dist;
    grp.nodes[1].type = 'lowpass';
    grp.nodes[1].frequency.value = 3500 + 3500 * dist;
    grp.nodes[2].pan.value = k.rr(-0.85, 0.85);

    const kind = k.pick(['whistle', 'whistle', 'trill', 'tweet', 'coo']);
    let c = t;
    if (kind === 'whistle') {
      let f = k.rr(2200, 3400);
      const n = k.ri(2, 4);
      for (let i = 0; i < n; i++) {
        const d = k.rr(0.12, 0.26);
        k.tone(c, { freq: f * k.rr(1.0, 1.12), glide: [[d, f * k.rr(0.8, 0.95)]], peak: 0.05, attack: 0.015, hold: d - 0.04, decay: 0.02, dest: grp });
        c += d + k.rr(0.06, 0.16);
        f *= k.rr(0.9, 1.06);
      }
    } else if (kind === 'trill') {
      const f = k.rr(3400, 4600);
      const n = k.ri(6, 14);
      const gap = k.rr(0.06, 0.085);
      for (let i = 0; i < n; i++) {
        const fall = 1 - i / (n * 6);
        k.tone(c, { freq: f * 0.85 * fall, glide: [[0.035, f * 1.08 * fall]], peak: 0.03, attack: 0.006, hold: 0.02, decay: 0.008, dest: grp });
        c += gap;
      }
    } else if (kind === 'tweet') {
      const n = k.ri(1, 3);
      for (let i = 0; i < n; i++) {
        const f = k.rr(2000, 2600);
        k.tone(c, { freq: f, glide: [[0.07, f * k.rr(1.7, 2.1)]], peak: 0.045, attack: 0.01, hold: 0.05, decay: 0.012, dest: grp });
        c += k.rr(0.14, 0.22);
      }
      const f = k.rr(2800, 3600);
      k.tone(c, { freq: f, glide: [[0.18, f * 0.75]], peak: 0.035, attack: 0.012, hold: 0.14, decay: 0.03, dest: grp });
    } else {
      // Wood-pigeon-ish coo: low, soft, two or three notes.
      const f = k.rr(480, 640);
      const n = k.ri(2, 3);
      for (let i = 0; i < n; i++) {
        const d = i === 0 ? k.rr(0.35, 0.5) : k.rr(0.22, 0.32);
        k.tone(c, { type: 'triangle', freq: f * 0.92, glide: [[0.08, f], [d, f * 0.9]], peak: 0.06, attack: 0.05, hold: d - 0.1, decay: 0.05, dest: grp });
        c += d + k.rr(0.12, 0.2);
      }
    }
    // A group with no voices would never be dropped; every branch adds one.
  }
  k.every(k.rr(0.8, 2.5), (t) => { phrase(t); return k.rr(1.5, 7); });
});

const night = defineScene(0.62, (k) => {
  // Very soft wind.
  const windG = k.gain(0.25);
  chain(k.loop('brown'), k.lp(450), windG, k.dest);
  k.wander(windG.gain, 0.12, 0.3, [3, 7], 2.5);
  const airBp = k.bp(700, 0.8);
  chain(k.loop('pink'), airBp, k.gain(0.05), k.dest);
  k.wander(airBp.frequency, 450, 1100, [4, 8], 3);

  const verb = k.reverb(3, 0.4);
  const crickets = k.lp(6500);
  chain(crickets, k.dest);
  crickets.connect(verb);

  /**
   * A cricket: one persistent sine carrier, gated into chirps of 3-5 quick
   * pulses. Each cricket keeps its own tempo and sings in bouts with rests,
   * which is what makes a field of them sound alive instead of looped.
   */
  function cricket(panPos, level) {
    const osc = k.osc('sine', k.rr(4200, 4900));
    const env = k.gain(0);
    chain(osc, env, k.pan(panPos), crickets);
    const period = k.rr(0.5, 0.85);
    const pulseRate = k.rr(26, 34);
    let singing = k.chance(0.7);
    let left = k.ri(6, 20);
    k.every(k.rr(0, 1.5), (t) => {
      if (!singing) {
        singing = true;
        left = k.ri(8, 24);
        return k.rr(2, 7);
      }
      const pulses = k.ri(3, 5);
      const pp = 1 / pulseRate;
      const peak = level * k.rr(0.8, 1);
      for (let i = 0; i < pulses; i++) {
        const p = t + i * pp;
        env.gain.setValueAtTime(0, p);
        env.gain.linearRampToValueAtTime(peak, p + 0.004);
        env.gain.linearRampToValueAtTime(0, p + pp * 0.7);
      }
      if (--left <= 0) singing = false;
      return period * k.rr(0.97, 1.03);
    });
  }
  cricket(-0.6, 0.03);
  cricket(0.5, 0.025);
  cricket(0.05, 0.015);
  cricket(0.85, 0.01);

  /** Soft owl: low triangle hoots through a lowpass, drenched in reverb. */
  function hoot(t, d, peak, panPos) {
    const f = k.rr(330, 390);
    k.tone(t, { type: 'triangle', freq: f, glide: [[d, f * 0.93]], peak, attack: 0.07, hold: d - 0.12, decay: 0.06, pan: panPos, dest: owlBus });
  }
  const owlBus = k.lp(900);
  chain(owlBus, k.gain(0.7), k.dest);
  owlBus.connect(verb);
  k.every(k.rr(7, 14), (t) => {
    const p = k.rr(-0.7, 0.7);
    const peak = k.rr(0.05, 0.08);
    hoot(t, k.rr(0.4, 0.55), peak, p);
    let c = t + k.rr(1.1, 1.6);
    const n = k.ri(1, 3);
    for (let i = 0; i < n; i++) { hoot(c, k.rr(0.22, 0.3), peak * 0.8, p); c += k.rr(0.32, 0.42); }
    return k.rr(30, 75);
  });
});

const fire = defineScene(0.6, (k) => {
  // Roar: low flame rumble with a fast, irregular flicker.
  const roarG = k.gain(0.3);
  chain(k.loop('brown'), k.lp(260, -4), roarG, k.dest);
  k.wander(roarG.gain, 0.18, 0.36, [0.15, 0.5], 0.12);
  // Faint hiss of gas and steam.
  const hissG = k.gain(0.04);
  chain(k.loop('pink'), k.bp(2600, 0.8), hissG, k.dest);
  k.wander(hissG.gain, 0.02, 0.06, [0.5, 2], 0.4);

  const crackleBus = k.lp(6500);
  crackleBus.connect(k.dest);
  const ph = k.rr(0, 6.28);
  const density = (t) => 0.6 + 0.45 * Math.sin((t * 2 * Math.PI) / 23 + ph) + 0.25 * Math.sin((t * 2 * Math.PI) / 7.1);

  const crackle = (t, scale) => k.noiseBurst(t, {
    type: 'bandpass', freq: k.rr(1500, 5000), Q: k.rr(0.7, 2.2),
    peak: scale * (0.16 + 0.9 * Math.pow(k.rand(), 3)), attack: 0.0004, decay: k.rr(0.0012, 0.005),
    pan: k.rr(-0.6, 0.6), dest: crackleBus,
  });

  k.every(k.rr(0.05, 0.3), (t) => {
    if (k.chance(0.18)) {
      // Little cluster: a log splitting along its grain.
      const n = k.ri(3, 8);
      let c = t;
      for (let i = 0; i < n; i++) { crackle(c, 0.8); c += k.rr(0.008, 0.05); }
    } else {
      crackle(t, 1);
    }
    return Math.max(0.02, k.expo(1 / (4 * Math.max(0.25, density(t)))));
  });
  // Pops: rarer, lower, a bit rounder.
  k.every(k.rr(0.5, 2), (t) => {
    k.noiseBurst(t, {
      type: 'bandpass', freq: k.rr(450, 1100), Q: k.rr(1.2, 2.5),
      peak: k.rr(0.5, 0.9), attack: 0.0008, decay: k.rr(0.008, 0.018),
      pan: k.rr(-0.5, 0.5), dest: crackleBus,
    });
    return k.rr(1.5, 6);
  });
});

const wind = defineScene(0.6, (k) => {
  // Broad body of the wind.
  const bodyBp = k.bp(600, 0.8);
  const bodyG = k.gain(0.3);
  chain(k.loop('pink'), bodyBp, bodyG, k.pan(-0.25), k.dest);
  // Narrow howl/whistle around corners.
  const howlBp = k.bp(500, 5);
  const howlG = k.gain(0.5);
  chain(k.loop('pink'), howlBp, howlG, k.pan(0.3), k.dest);
  // Low pressure rumble.
  const lowG = k.gain(0.2);
  chain(k.loop('brown'), k.lp(220), lowG, k.dest);

  // Gusts drive everything together: level up, centre frequencies up.
  k.every(0, (t) => {
    const peak = k.rr(0.55, 1);
    const rise = k.rr(1.5, 3.5);
    const fall = k.rr(3, 7);
    const rest = k.rr(0.25, 0.4);
    bodyG.gain.setTargetAtTime(0.32 * peak, t, rise / 3);
    bodyG.gain.setTargetAtTime(0.32 * rest, t + rise, fall / 3);
    bodyBp.frequency.setTargetAtTime(380 + 700 * peak, t, rise / 2.5);
    bodyBp.frequency.setTargetAtTime(380, t + rise, fall / 2.5);
    howlG.gain.setTargetAtTime(0.55 * peak, t, rise / 2.5);
    howlG.gain.setTargetAtTime(0.55 * rest * 0.6, t + rise, fall / 3);
    howlBp.frequency.setTargetAtTime(k.rr(420, 520) * (1 + 0.6 * peak), t, rise / 2);
    howlBp.frequency.setTargetAtTime(k.rr(360, 460), t + rise, fall / 2);
    lowG.gain.setTargetAtTime(0.12 + 0.12 * peak, t, rise / 2);
    return rise + fall * k.rr(0.55, 1.05);
  });
});

const space = defineScene(0.29, (k) => {
  // Open, unresolved voicings; the pad glides slowly from one to the next.
  const CHORDS = [
    [38, 45, 52, 57, 64], // D A E A E   (open fifths)
    [34, 46, 53, 57, 62], // Bb maj7
    [36, 43, 50, 55, 64], // C add9
    [33, 45, 52, 60, 64], // A m7-ish
    [31, 43, 50, 57, 59], // G add9
  ];
  const padLp = k.lp(600, -2);
  const pad = k.gain(1);
  chain(pad, padLp, k.dest);
  const verb = k.reverb(5, 0.8);
  padLp.connect(verb);
  k.wander(padLp.frequency, 320, 1100, [4, 8], 3.5);

  const voices = CHORDS[0].map((m, i) => {
    const vg = k.gain(0.12 / (1 + i * 0.25));
    const a = k.osc('sine', mtof(m), -k.rr(3, 6));
    const b = k.osc('triangle', mtof(m), k.rr(3, 6));
    const bg = k.gain(0.5);
    chain(a, vg);
    chain(b, bg, vg);
    chain(vg, k.pan((i % 2 ? 1 : -1) * 0.15 * i), pad);
    k.wander(vg.gain, 0.06 / (1 + i * 0.25), 0.13 / (1 + i * 0.25), [3, 7], 2.5);
    return { a, b };
  });

  // Shimmer: high chord partials fading in and out, almost only in the reverb.
  const shimmer = k.gain(1);
  chain(shimmer, k.gain(0.15), k.dest);
  shimmer.connect(verb);
  const highs = [0, 1, 2].map((i) => {
    const o = k.osc('sine', mtof(CHORDS[0][2 + i] + 24));
    const g = k.gain(0);
    chain(o, g, k.pan([-0.6, 0.6, 0][i]), shimmer);
    k.every(k.rr(1, 4), (t) => {
      g.gain.setTargetAtTime(k.chance(0.55) ? k.rr(0.004, 0.012) : 0, t, k.rr(2, 4));
      return k.rr(4, 9);
    });
    return o;
  });

  let ci = 0;
  k.every(k.rr(18, 26), (t) => {
    ci = (ci + 1 + Math.floor(k.rand() * (CHORDS.length - 1))) % CHORDS.length;
    const chord = CHORDS[ci];
    voices.forEach((v, i) => {
      const f = mtof(chord[i]);
      v.a.frequency.setTargetAtTime(f, t, 2.5);
      v.b.frequency.setTargetAtTime(f, t, 2.5);
    });
    highs.forEach((o, i) => o.frequency.setTargetAtTime(mtof(chord[2 + i] + 24), t, 3));
    return k.rr(20, 32);
  });
});

const underwater = defineScene(0.29, (k) => {
  // Muffled mass of water: double lowpassed brown noise with a slow swell.
  const swell = k.gain(0.6);
  const lpA = k.lp(320, -4);
  chain(k.loop('brown'), lpA, k.lp(600), swell, k.dest);
  k.wander(swell.gain, 0.4, 0.8, [3, 6], 1.8);
  k.wander(lpA.frequency, 220, 420, [4, 8], 2.5);
  // Faint low resonance of the space.
  chain(k.loop('pink'), k.bp(150, 1.2), k.gain(0.12), k.dest);

  const verb = k.reverb(2.5, 0.45);
  const bubbles = k.lp(1500);
  chain(bubbles, k.gain(0.9), k.dest);
  bubbles.connect(verb);

  /** Bubble: a sine whose pitch shoots up as it frees itself. */
  const bubble = (t, size) => {
    const f0 = k.rr(260, 700) / size;
    const d = k.rr(0.04, 0.11) * size;
    k.tone(t, {
      freq: f0, glide: [[d, f0 * k.rr(1.8, 2.8)]],
      peak: k.rr(0.09, 0.18), attack: 0.004, decay: d * 0.6, pan: k.rr(-0.7, 0.7), dest: bubbles,
    });
  };
  k.every(k.rr(0.6, 2), (t) => {
    if (k.chance(0.35)) {
      const n = k.ri(2, 6);
      let c = t;
      for (let i = 0; i < n; i++) { bubble(c, k.rr(0.6, 1.1)); c += k.rr(0.05, 0.22); }
    } else {
      bubble(t, k.rr(0.8, 1.4));
    }
    return k.rr(1.2, 5);
  });
});

const cafe = defineScene(0.5, (k) => {
  // The room: everything goes through a dull, reverberant space.
  const room = k.gain(1);
  const roomLp = k.lp(2600);
  chain(room, k.hp(140), roomLp, k.dest);
  const verb = k.reverb(1.8, 0.55);
  roomLp.connect(verb);
  chain(k.loop('brown'), k.lp(400), k.gain(0.12), k.dest);

  /**
   * One distant talker: pink noise through two vowel-ish formants, gated
   * syllable by syllable, in phrases with pauses. Six of them overlapping
   * read as murmur without ever forming words.
   */
  function talker(panPos) {
    const src = k.loop('pink');
    const f1 = k.bp(500, k.rr(2.5, 4));
    const f2 = k.bp(1600, 3.5);
    const f2g = k.gain(0.45);
    const vg = k.gain(0);
    src.connect(f1);
    chain(src, f2, f2g, vg);
    f1.connect(vg);
    chain(vg, k.pan(panPos), room);
    const level = k.rr(0.5, 1);
    let talking = k.chance(0.6);
    let left = k.ri(4, 16);
    k.every(k.rr(0, 2), (t) => {
      if (!talking) {
        vg.gain.setTargetAtTime(0, t, 0.12);
        talking = true;
        left = k.ri(4, 18);
        return k.rr(0.6, 3.5);
      }
      const d = k.rr(0.12, 0.28);
      vg.gain.setTargetAtTime(level * k.rr(0.4, 1), t, 0.03);
      vg.gain.setTargetAtTime(level * k.rr(0.05, 0.2), t + d * k.rr(0.55, 0.8), 0.04);
      f1.frequency.setTargetAtTime(k.rr(320, 780), t, 0.04);
      f2.frequency.setTargetAtTime(k.rr(1000, 2300), t, 0.04);
      if (--left <= 0) talking = false;
      return d;
    });
  }
  [-0.75, -0.4, -0.1, 0.15, 0.45, 0.8].forEach(talker);

  /** Cup/spoon clink: a few inharmonic partials, fast decay, quiet. */
  const clinkBus = k.lp(6000);
  chain(clinkBus, k.gain(1), k.dest);
  clinkBus.connect(verb);
  const clink = (t, panPos, level) => {
    const f = k.rr(1900, 2700);
    [[1, 1, 0.12], [2.32, 0.45, 0.07], [4.25, 0.18, 0.04]].forEach(([r, a, d]) => {
      k.tone(t, { freq: f * r, peak: 0.03 * a * level, attack: 0.001, decay: d, pan: panPos, dest: clinkBus });
    });
  };
  k.every(k.rr(4, 10), (t) => {
    const p = k.rr(-0.7, 0.7);
    clink(t, p, k.rr(0.6, 1));
    if (k.chance(0.35)) clink(t + k.rr(0.1, 0.3), p, k.rr(0.3, 0.6));
    return k.rr(8, 25);
  });
});

// --- lofi -----------------------------------------------------------------

/** Rootless jazz voicings in F major, kept around A3-A4 for warmth. */
const LOFI_CHORDS = {
  Gm9: { root: 43, notes: [58, 62, 65, 69] },
  C13: { root: 36, notes: [58, 62, 64, 69] },
  C9sus: { root: 36, notes: [58, 62, 65, 67] },
  Fmaj9: { root: 41, notes: [57, 60, 64, 67] },
  Fmaj7: { root: 41, notes: [53, 57, 60, 64] },
  Dm9: { root: 38, notes: [57, 60, 64, 65] },
  Gm7: { root: 43, notes: [58, 62, 65, 67] },
  Bbmaj9: { root: 46, notes: [57, 60, 62, 65] },
  Bbm6: { root: 46, notes: [58, 61, 65, 67] },
  Am7: { root: 45, notes: [55, 60, 64, 69] },
};
const LOFI_PROGRESSIONS = [
  ['Gm9', 'C13', 'Fmaj9', 'Dm9'], // ii V I vi
  ['Fmaj7', 'Dm9', 'Gm7', 'C9sus'], // I vi ii V
  ['Bbmaj9', 'Bbm6', 'Am7', 'Dm9'], // IV iv iii vi (the minor-iv sigh)
  ['Bbmaj9', 'C13', 'Am7', 'Dm9'], // IV V iii vi
];
const PENTATONIC = [0, 2, 4, 7, 9].map((x) => (x + 5) % 12); // F G A C D

const lofi = defineScene(0.34, (k) => {
  const { ctx } = k;
  const bpm = k.rr(76, 84);
  const beat = 60 / bpm;
  const s16 = beat / 4;
  const barDur = beat * 4;
  const swing = k.rr(0.57, 0.62);
  /** Swung 16th: odd steps land late within their 8th-note pair. */
  const stepTime = (bar, i) => bar + Math.floor(i / 2) * 2 * s16 + (i % 2 ? 2 * s16 * swing : 0);
  const human = () => k.rr(-0.006, 0.006);

  // Tape: keys and bass share a wobbling delay line (wow + a little flutter),
  // which detunes the whole band together like a worn cassette.
  const music = k.gain(1);
  const tape = k.keep(ctx.createDelay(0.05));
  tape.delayTime.value = 0.015;
  chain(k.osc('sine', k.rr(0.35, 0.55)), k.gain(0.0013), tape.delayTime);
  chain(k.osc('sine', k.rr(5, 7)), k.gain(0.00006), tape.delayTime);
  chain(music, tape, k.lp(3200), k.dest);

  const keys = k.lp(1800, -2);
  const verb = k.reverb(2.2, 0.45);
  chain(keys, k.gain(1), music);
  keys.connect(verb);
  const bassBus = k.lp(240);
  chain(bassBus, music);
  const drums = k.lp(8000);
  chain(drums, k.gain(1), k.dest);

  // Soft electric-piano partials: a sine plus a gently buzzy, detuned
  // second oscillator, and a quick tine "ping" an octave+ up for the attack.
  const epWave = ctx.createPeriodicWave(new Float32Array(6), new Float32Array([0, 1, 0.2, 0.08, 0.03, 0.012]));
  const bassWave = ctx.createPeriodicWave(new Float32Array(4), new Float32Array([0, 1, 0.22, 0.05]));

  function ep(t, midi, vel, dur) {
    const f = mtof(midi);
    const peak = 0.14 * vel * Math.pow(220 / f, 0.3);
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.006);
    g.gain.setTargetAtTime(peak * 0.45, t + 0.006, 0.22);
    if (dur > 0.7) g.gain.setTargetAtTime(0, t + 0.6, 1.8);
    g.gain.setTargetAtTime(0, t + dur, 0.14);
    const pan = ctx.createStereoPanner();
    pan.pan.value = k.rr(-0.25, 0.25);
    const grp = k.group([g, pan], keys);
    const end = t + dur + 1;
    const a = ctx.createOscillator();
    a.frequency.value = f;
    a.connect(g);
    k.voice(a, [], t, end, grp);
    const b = ctx.createOscillator();
    b.setPeriodicWave(epWave);
    b.frequency.value = f;
    b.detune.value = k.rr(4, 9);
    const bg = ctx.createGain();
    bg.gain.value = 0.45;
    chain(b, bg, g);
    k.voice(b, [bg], t, end, grp);
    const tine = ctx.createOscillator();
    tine.frequency.value = f * 4;
    const tg = ctx.createGain();
    tg.gain.value = 0;
    tg.gain.setValueAtTime(0, t);
    tg.gain.linearRampToValueAtTime(0.12, t + 0.003);
    tg.gain.setTargetAtTime(0, t + 0.003, 0.05);
    chain(tine, tg, g);
    k.voice(tine, [tg], t, t + 0.5, grp);
  }

  function bass(t, midi, dur, vel) {
    const peak = 0.13 * vel;
    k.tone(t, { wave: bassWave, freq: mtof(midi), peak, attack: 0.018, hold: Math.max(0, dur - 0.08), decay: 0.07, dest: bassBus });
  }

  function kick(t, vel) {
    k.tone(t, { freq: 115, glide: [[0.09, 46]], peak: 0.3 * vel, attack: 0.003, decay: 0.085, dest: drums });
  }
  function snare(t, vel) {
    k.noiseBurst(t, { type: 'bandpass', freq: 1900, Q: 0.7, peak: 0.5 * vel, attack: 0.002, decay: 0.055, dest: drums });
    k.tone(t, { freq: 190, glide: [[0.05, 165]], peak: 0.06 * vel, attack: 0.002, decay: 0.035, dest: drums });
  }
  function hat(t, vel) {
    k.noiseBurst(t, { type: 'highpass', freq: 6500, Q: -3, peak: 0.16 * vel, attack: 0.001, decay: 0.014, pan: 0.2, dest: drums });
  }

  const KICKS = [[0, 10], [0, 10], [0, 7, 10], [0, 10, 13], [0, 3, 10]];
  const COMPS = [
    [[0, 1, 16]],
    [[0, 0.95, 6], [6, 0.6, 10]],
    [[0, 1, 10], [10, 0.6, 6]],
    [[0, 0.9, 3], [3, 0.7, 5], [8, 0.8, 8]],
    [[0, 1, 12], [14, 0.5, 2]],
  ];

  let prog = k.pick(LOFI_PROGRESSIONS);
  let bar = 0;
  let lastMelody = 75;

  function voicing(chord) {
    let notes = chord.notes.slice();
    if (k.chance(0.3)) notes = notes.slice(1).concat(notes[0] + 12); // inversion up
    if (k.chance(0.2)) notes.splice(1 + Math.floor(k.rand() * (notes.length - 2)), 1); // thinner
    if (k.chance(0.15)) notes.unshift(chord.root + 12); // add the root low in the keys
    return notes;
  }

  function melodyPool(chord) {
    const pcs = chord.notes.map((n) => n % 12);
    const clashes = (pc) => pcs.some((c) => { const d = (pc - c + 12) % 12; return d === 1 || d === 11; });
    const ok = (pc) => pcs.includes(pc) || (PENTATONIC.includes(pc) && !clashes(pc));
    const pool = [];
    for (let m = 70; m <= 84; m++) if (ok(m % 12)) pool.push(m);
    return pool;
  }

  function playBar(t) {
    if (bar % 4 === 0 && bar > 0) {
      let next = k.pick(LOFI_PROGRESSIONS);
      if (next === prog) next = k.pick(LOFI_PROGRESSIONS);
      prog = next;
    }
    const chord = LOFI_CHORDS[prog[bar % 4]];
    const nextChord = LOFI_CHORDS[prog[(bar + 1) % 4]];

    // Keys.
    const notes = voicing(chord);
    for (const [step, vel, len] of k.pick(COMPS)) {
      const at = stepTime(t, step) + human();
      const strum = k.rr(0.006, 0.02);
      notes.forEach((n, j) => ep(at + j * strum, n, vel * k.rr(0.85, 1), len * s16));
    }

    // Occasional melody fragment from chord tones + safe pentatonic notes.
    if (bar >= 2 && k.chance(0.45)) {
      const pool = melodyPool(chord);
      let idx = pool.reduce((best, m, i) => (Math.abs(m - lastMelody) < Math.abs(pool[best] - lastMelody) ? i : best), 0);
      const slots = [2, 4, 6, 8, 10, 12, 14].filter(() => k.chance(0.35)).slice(0, 4);
      for (const s of slots) {
        idx = clamp(idx + k.pick([-2, -1, -1, 1, 1, 2]), 0, pool.length - 1);
        lastMelody = pool[idx];
        ep(stepTime(t, s) + human(), lastMelody, k.rr(0.45, 0.65), k.rr(2, 5) * s16);
      }
    }

    // Bass: root on one, sometimes a push on the and-of-three, an approach note.
    bass(stepTime(t, 0) + 0.01, chord.root, 7 * s16, 1);
    if (k.chance(0.55)) bass(stepTime(t, 10), k.pick([chord.root, chord.root, chord.root + 7, chord.root + 12]), 3 * s16, 0.8);
    if (k.chance(0.3)) bass(stepTime(t, 14), nextChord.root + k.pick([-1, 1, 2]), 1.6 * s16, 0.6);

    // Drums: two-bar intro without, and an occasional breather bar.
    const intro = bar < 2;
    const breather = bar % 8 === 7 && k.chance(0.5);
    if (!intro) {
      if (!breather) {
        for (const s of k.pick(KICKS)) kick(stepTime(t, s) + human(), s === 0 ? 1 : 0.8);
        const late = k.rr(0.015, 0.03); // laid-back backbeat
        snare(stepTime(t, 4) + late, k.rr(0.85, 1));
        snare(stepTime(t, 12) + late, k.rr(0.85, 1));
        if (k.chance(0.3)) snare(stepTime(t, k.pick([7, 15])) + late, 0.25);
      }
      for (let s = 0; s < 16; s++) {
        if (s % 2 === 0) {
          if (k.chance(0.92)) hat(stepTime(t, s) + human(), (s % 4 === 2 ? 0.8 : 0.55) * k.rr(0.8, 1.1));
        } else if (k.chance(0.18)) {
          hat(stepTime(t, s) + human(), k.rr(0.25, 0.4));
        }
      }
    }
    bar++;
  }
  k.every(0.25, (t) => { playBar(t); return barDur; });

  // Vinyl: constant soft hiss + sparse crackle, outside the tape wobble.
  chain(k.loop('pink'), k.hp(1500), k.lp(5000), k.gain(0.035), k.dest);
  const vinyl = k.lp(5000);
  vinyl.connect(k.dest);
  k.every(k.rr(0, 0.3), (t) => {
    const pop = k.chance(0.05);
    k.noiseBurst(t, {
      type: 'bandpass', freq: pop ? k.rr(600, 1200) : k.rr(1500, 4000), Q: 0.9,
      peak: pop ? k.rr(0.08, 0.15) : 0.02 + 0.12 * Math.pow(k.rand(), 3),
      attack: 0.0003, decay: pop ? 0.004 : k.rr(0.0004, 0.0015), pan: k.rr(-0.5, 0.5), dest: vinyl,
    });
    return Math.max(0.01, k.expo(1 / 7));
  });
});

// ---------------------------------------------------------------------------
// Registry, master chain, controller

const SCENES = [
  { id: 'rain', create: rain },
  { id: 'storm', create: storm },
  { id: 'waves', create: waves },
  { id: 'forest', create: forest },
  { id: 'night', create: night },
  { id: 'fire', create: fire },
  { id: 'wind', create: wind },
  { id: 'space', create: space },
  { id: 'underwater', create: underwater },
  { id: 'cafe', create: cafe },
  { id: 'lofi', create: lofi },
];
const BY_ID = Object.fromEntries(SCENES.map((s) => [s.id, s.create]));

/** [{ id, nameKey }] in display order. */
const SOUNDSCAPES = SCENES.map(({ id }) => ({ id, nameKey: `ambience.sound.${id}` }));

/**
 * input -> highpass 28 Hz (brown noise carries inaudible sub energy that would
 * only make the compressor pump) -> gentle lowpass -> soft compressor ->
 * volume -> destination. Volume sits after the compressor so turning it down
 * never changes the dynamics.
 */
function createMaster(ctx) {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 28;
  hp.Q.value = -3;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 9500;
  lp.Q.value = -6;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 12;
  comp.ratio.value = 3;
  comp.attack.value = 0.015;
  comp.release.value = 0.35;
  const volume = ctx.createGain();
  chain(input, hp, lp, comp, volume, ctx.destination);
  return { input, volume, nodes: [input, hp, lp, comp, volume] };
}

/** Slider position -> gain. Squared: a linear slider feels "all at the top". */
const volumeCurve = (v) => v * v;

/**
 * Render a soundscape through the same master chain, offline. Dev/test aid
 * (sound-check, previews); not used by the live controller.
 *
 * @returns {Promise<AudioBuffer>}
 */
function renderOffline(id, seconds = 12, { sampleRate = 44100, seed = 7, volume = 1 } = {}) {
  const create = BY_ID[id];
  if (!create) return Promise.reject(new Error(`unknown soundscape: ${id}`));
  const ctx = new globalThis.OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const master = createMaster(ctx);
  master.volume.gain.value = volumeCurve(volume);
  create(ctx, master.input, { fadeIn: 0, random: seeded(seed) });
  return ctx.startRendering();
}

/**
 * The live controller. The AudioContext is created on the first play() so an
 * app that never enables sound never opens an audio device.
 */
function createAmbientSound(options = {}) {
  let ctx = null;
  let master = null;
  let active = null; // { id, scene }
  const live = new Set(); // scenes not yet released (incl. fading out)
  let volume = clamp(options.volume == null ? DEFAULT_VOLUME : Number(options.volume) || 0, 0, 1);
  let userSuspended = false;
  let destroyed = false;

  function ensureContext() {
    if (ctx) return true;
    const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!AC) return false;
    try {
      ctx = new AC({ latencyHint: 'playback' });
    } catch (e) {
      console.error('[AmbientSound] cannot create AudioContext', e);
      return false;
    }
    master = createMaster(ctx);
    master.volume.gain.value = volumeCurve(volume);
    return true;
  }

  function play(id) {
    if (destroyed) return;
    const create = BY_ID[id];
    if (!create) { stop(); return; }
    if (active && active.id === id) return;
    if (!ensureContext()) return;
    if (!userSuspended && ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (active) { active.scene.stop(CROSSFADE_SECONDS); active = null; }
    let scene = null;
    try {
      scene = create(ctx, master.input, {
        fadeIn: CROSSFADE_SECONDS,
        onRelease: () => { live.delete(scene); },
      });
    } catch (e) {
      console.error(`[AmbientSound] failed to start "${id}"`, e);
      return;
    }
    live.add(scene);
    active = { id, scene };
  }

  function stop() {
    if (!active) return;
    active.scene.stop(STOP_FADE_SECONDS);
    active = null;
  }

  function setVolume(v) {
    volume = clamp(Number(v) || 0, 0, 1);
    if (!ctx || !master) return;
    master.volume.gain.setTargetAtTime(volumeCurve(volume), ctx.currentTime, 0.08);
  }

  function suspend() {
    userSuspended = true;
    return ctx && ctx.state === 'running' ? ctx.suspend().catch(() => {}) : Promise.resolve();
  }

  function resume() {
    userSuspended = false;
    return ctx && ctx.state === 'suspended' ? ctx.resume().catch(() => {}) : Promise.resolve();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    active = null;
    for (const s of Array.from(live)) s.release();
    live.clear();
    if (master) master.nodes.forEach(kill);
    master = null;
    if (ctx) ctx.close().catch(() => {});
    ctx = null;
  }

  return {
    play,
    stop,
    setVolume,
    current: () => (active ? active.id : null),
    suspend,
    resume,
    destroy,
    /** Debug: scenes still holding nodes and their transient voices. */
    _stats: () => ({
      state: ctx ? ctx.state : 'none',
      scenes: live.size,
      voices: Array.from(live).reduce((n, s) => n + s.stats().voices, 0),
    }),
  };
}

module.exports = {
  SOUNDSCAPES,
  createAmbientSound,
  renderOffline,
};
