/**
 * ClaudeCompanion - a little pixel Claude that lives along the bottom of the
 * window, to fidget with and unwind while a session runs.
 *
 *  Play
 *  - Drag it and throw it: it flies, bounces off the window edges and lands.
 *  - Stroke it (move the pointer over it without pressing): hearts, purring.
 *  - Click: it hops. Click it a lot: it gets dizzy.
 *  - A ball it chases and kicks, a cookie it runs to and eats.
 *  - Colours and accessories, from the right-click menu.
 *
 *  Unwind
 *  - Guided breathing (double-click): 4 in, 4 hold, 6 out, five cycles.
 *  - Guided stretch: arms up, lean left, lean right, shoulders.
 *  - Focus timer: 25 minutes of work, then a 5 minute break.
 *  - After 45 minutes of Claude work it offers a stretch; late at night it
 *    yawns and suggests bed. Left alone a few minutes it falls asleep.
 *
 *  Sessions (terminalsState, written by chat tabs and hook-driven PTY tabs)
 *  - Thought bubble while any turn runs, "!" while one waits on the user;
 *    clicking it then opens that tab.
 *  - A small celebration, with the project's name, when a turn ends.
 *
 * Driven by settings.companionEnabled (the ambience popover toggles it).
 * Position, looks, sound and counters live in localStorage: they change far
 * too often to be settings. Nothing runs per frame unless something moves:
 * the rAF loop stops itself once the companion and its props are at rest.
 */

const { t } = require('../../i18n');
const { terminalsState } = require('../../state/terminals.state');
const {
  spriteSvg, PALETTES, ACCESSORIES,
  HEART_SVG, SPARK_SVG, CRUMB_SVG, BALL_SVG, BALL_SIZE, COOKIE_SVG, COOKIE_SIZE,
} = require('./sprite');
const sound = require('./sound');

// ── Tuning ──────────────────────────────────────────────────────────────────

const SIZE = 70;               // CSS px, the 14x14 sprite at 5x
const GRAVITY = 2400;          // px/s²
const MAX_THROW = 2600;        // px/s
const FLOOR_MARGIN = 6;        // px above the window's bottom edge
const TOP_MARGIN = 40;         // keep clear of the titlebar
const WALK_SPEED = 55;         // px/s
const RUN_SPEED = 170;         // px/s, chasing the ball or a cookie
const PET_DISTANCE = 90;       // px of stroking per heart
const SLEEP_AFTER_MS = 4 * 60 * 1000;
const PROP_IDLE_MS = 3 * 60 * 1000;
const STRETCH_AFTER_WORK_MS = 45 * 60 * 1000;
const OFFER_MS = 30 * 1000;    // how long "click me to ..." stays valid
const FOCUS_MS = 25 * 60 * 1000;
const BREAK_MS = 5 * 60 * 1000;
const BREATH_CYCLES = 5;
const STORE_KEY = 'ct-companion';

const reducedMotion = () =>
  document.body.classList.contains('reduce-motion') ||
  (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function saveStore(data) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* storage full or denied */ }
}

const floorY = (h) => Math.max(TOP_MARGIN, window.innerHeight - h - FLOOR_MARGIN);
const maxX = (w) => Math.max(0, window.innerWidth - w);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const today = () => new Date().toDateString();

/**
 * One physics step for a body on the window's floor and walls.
 * @returns {number} the hardest impact speed this step (0 when none)
 */
function stepBody(b, dt, w, h, bounce) {
  b.vy += GRAVITY * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  let impact = 0;
  const right = maxX(w);
  const floor = floorY(h);
  if (b.x < 0) { impact = Math.abs(b.vx); b.x = 0; b.vx = Math.abs(b.vx) * bounce; }
  else if (b.x > right) { impact = Math.abs(b.vx); b.x = right; b.vx = -Math.abs(b.vx) * bounce; }
  if (b.y < TOP_MARGIN) { b.y = TOP_MARGIN; b.vy = Math.abs(b.vy) * bounce; }
  b.grounded = false;
  if (b.y >= floor) {
    if (b.vy > 0) impact = Math.max(impact, b.vy);
    b.y = floor;
    if (b.vy > 220) {
      b.vy = -b.vy * bounce;
      b.vx *= 0.85;
    } else {
      b.vy = 0;
      b.grounded = true;
      b.vx *= Math.pow(0.04, dt);
      if (Math.abs(b.vx) < 6) b.vx = 0;
    }
  }
  return impact;
}

/** Velocity over the last ~90 ms of pointer samples. */
function releaseVelocity(samples) {
  const last = samples[samples.length - 1];
  if (!last) return [0, 0];
  let first = last;
  for (let i = samples.length - 1; i >= 0; i--) {
    first = samples[i];
    if (last.t - samples[i].t > 90) break;
  }
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return [0, 0];
  const vx = (last.x - first.x) / dt;
  const vy = (last.y - first.y) / dt;
  const speed = Math.hypot(vx, vy);
  const k = speed > MAX_THROW ? MAX_THROW / speed : 1;
  return [vx * k, vy * k];
}

/** mm:ss */
function formatClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Pointer drag with a throw on release; a press that never moves is a click.
 * Shared by the companion and its props.
 */
function attachDrag(target, { getPos, onGrab, onMove, onRelease, onClick }) {
  let drag = null;
  target.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const [x, y] = getPos();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: e.clientX - x, oy: e.clientY - y, moved: false, samples: [] };
    target.setPointerCapture?.(e.pointerId);
  });
  target.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
    if (!drag.moved) { drag.moved = true; onGrab(); }
    drag.samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
    if (drag.samples.length > 8) drag.samples.shift();
    onMove(e.clientX - drag.ox, e.clientY - drag.oy);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    target.releasePointerCapture?.(e.pointerId);
    if (d.moved) {
      const [vx, vy] = e.type === 'pointercancel' ? [0, 0] : releaseVelocity(d.samples);
      onRelease(vx, vy);
    } else if (e.type === 'pointerup') {
      onClick(e);
    }
  };
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
}

// ── Companion ───────────────────────────────────────────────────────────────

/**
 * @param {object} [deps]
 * @param {(terminalId: any) => void} [deps.focusTerminal]  open a tab (the one waiting on the user)
 */
function createCompanion(deps = {}) {
  const store = loadStore();
  const prefs = {
    color: PALETTES[store.color] ? store.color : 'orange',
    hat: ACCESSORIES[store.hat] ? store.hat : 'none',
    sound: !!store.sound,
  };
  sound.setEnabled(prefs.sound);

  const root = document.createElement('div');
  root.className = 'ct-companion';
  root.innerHTML = `
    <div class="ctc-halo"></div>
    <div class="ctc-shadow"></div>
    <div class="ctc-tilt"><div class="ctc-squash"><div class="ctc-bob"><div class="ctc-pose"><div class="ctc-sprite"></div></div></div></div></div>
    <div class="ctc-indicator" aria-hidden="true"></div>
    <div class="ctc-timer" aria-hidden="true" hidden><span></span></div>
    <div class="ctc-bubble" role="status" aria-live="polite"></div>
    <button type="button" class="ctc-hit"></button>`;
  const fx = document.createElement('div');
  fx.className = 'ctc-fx';
  document.body.append(fx, root);

  const el = {
    tilt: root.querySelector('.ctc-tilt'),
    squash: root.querySelector('.ctc-squash'),
    sprite: root.querySelector('.ctc-sprite'),
    shadow: root.querySelector('.ctc-shadow'),
    bubble: root.querySelector('.ctc-bubble'),
    indicator: root.querySelector('.ctc-indicator'),
    timer: root.querySelector('.ctc-timer'),
    timerText: root.querySelector('.ctc-timer span'),
    hit: root.querySelector('.ctc-hit'),
  };
  el.hit.setAttribute('aria-label', t('companion.label'));
  el.hit.title = t('companion.label');

  const now = () => performance.now();
  const st = {
    x: clamp(typeof store.x === 'number' ? store.x : window.innerWidth - SIZE - 40, 0, maxX(SIZE)),
    y: floorY(SIZE),
    vx: 0, vy: 0, grounded: true,
    facing: -1,
    // idle | held | air | walk | chase | fetch | eat | routine | sleep
    mode: 'idle',
    mood: null, moodUntil: 0,   // transient face over the mode
    session: 'none',            // none | working | waiting
    waitingId: null,
    workMs: 0, workMark: now(), // Claude work time since the last stretch offer
    walkTarget: null,
    look: [0, 0],
    lastInteraction: now(),
    pets: store.pets || 0,
    snacks: store.snacks || 0,
    recentSnacks: [],
    petAccum: 0,
    lastPurr: 0,
    clicks: [],
    maxImpact: 0,
    chewFrame: 0,
    routine: null,              // { name, steps, i, timer, stepCls }
    pendingRoutine: null,
    offer: null,                // { action, until }: the next click runs it
    timer: null,                // { phase: 'focus'|'break', endAt, total }
    lastNight: store.lastNight || 0,
  };
  const props = {};             // 'ball' | 'cookie' -> prop
  const workStarts = new Map(); // terminalId -> when its turn started
  let rafId = 0;
  let lastFrame = 0;
  let faceKey = '';
  let tickTimer = null;
  let sayTimer = null;
  let timerInterval = null;
  let chewTimer = null;
  let menu = null;
  let menuAt = [0, 0];
  let destroyed = false;
  let kickCooldown = 0;

  function persist() {
    saveStore({
      x: st.x, pets: st.pets, snacks: st.snacks, met: true,
      color: prefs.color, hat: prefs.hat, sound: prefs.sound,
      lastGreet: store.lastGreet, lastNight: st.lastNight,
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function currentFace() {
    if (st.mode === 'held') return 'held';
    if (st.mode === 'eat') return st.chewFrame ? 'chomp' : 'chew';
    if (st.mode === 'routine') {
      if (st.routine?.name === 'stretch') return 'stretch';
      return st.routine?.stepCls === 'ctc-breath-in' ? 'breatheIn' : 'breathe';
    }
    if (st.mood && now() < st.moodUntil) return st.mood === 'happy' && st.mode === 'sleep' ? 'sleepHappy' : st.mood;
    if (st.mode === 'sleep') return 'sleep';
    if (st.mode === 'air') return 'air';
    if (st.session === 'waiting') return 'waiting';
    if (st.session === 'working') return 'working';
    if (st.mode === 'chase' || st.mode === 'fetch') return 'chase';
    if (st.mode === 'walk') return 'walk';
    return 'idle';
  }

  function renderFace() {
    const mood = currentFace();
    const look = mood === 'working' ? [1, -1] : st.look;
    const key = `${mood}|${look[0]},${look[1]}|${prefs.color}|${prefs.hat}`;
    if (key === faceKey) return;
    faceKey = key;
    el.sprite.innerHTML = spriteSvg(mood, look, prefs);
  }

  function renderPosition() {
    root.style.transform = `translate3d(${Math.round(st.x)}px, ${Math.round(st.y)}px, 0)`;
    const tiltDeg = st.mode === 'air' ? clamp(st.vx * 0.012, -25, 25) : 0;
    el.tilt.style.transform = `rotate(${tiltDeg.toFixed(1)}deg) scaleX(${st.facing})`;
    // The shadow stays on the floor and shrinks with height.
    const lift = floorY(SIZE) - st.y;
    const k = clamp(1 - lift / 400, 0.25, 1);
    el.shadow.style.transform = `translate3d(0, ${Math.round(lift)}px, 0) scale(${k.toFixed(2)})`;
    el.shadow.style.opacity = (0.35 * k).toFixed(2);
  }

  function renderIndicator() {
    let kind = '';
    if (st.mode !== 'sleep' && st.mode !== 'routine') {
      if (st.session === 'waiting') kind = 'waiting';
      else if (st.session === 'working') kind = 'working';
    }
    if (el.indicator.dataset.kind === kind) return;
    el.indicator.dataset.kind = kind;
    el.indicator.innerHTML = kind === 'working'
      ? '<span></span><span></span><span></span>'
      : kind === 'waiting' ? '!' : '';
  }

  function render() {
    renderFace();
    renderPosition();
    renderIndicator();
    root.classList.toggle('ctc-walking', st.mode === 'walk' || st.mode === 'chase' || st.mode === 'fetch');
    root.classList.toggle('ctc-running', st.mode === 'chase' || st.mode === 'fetch');
    root.classList.toggle('ctc-sleeping', st.mode === 'sleep');
    root.classList.toggle('ctc-held', st.mode === 'held');
    root.classList.toggle('ctc-eating', st.mode === 'eat');
    root.classList.toggle('ctc-busy', st.session === 'working' && st.mode === 'idle');
  }

  // ── Effects ───────────────────────────────────────────────────────────────

  function say(text, ms = 2600) {
    clearTimeout(sayTimer);
    el.bubble.textContent = text;
    el.bubble.classList.add('show');
    sayTimer = setTimeout(() => el.bubble.classList.remove('show'), ms);
  }

  /** Say something the next click will act on. */
  function offer(action, text) {
    st.offer = { action, until: now() + OFFER_MS };
    say(text, 6000);
  }

  function particle(html, cls, dx = 0, dy = 0) {
    if (document.hidden) return;
    const p = document.createElement('div');
    p.className = `ctc-particle ${cls}`;
    p.innerHTML = html;
    p.style.left = `${Math.round(st.x + SIZE / 2 + dx)}px`;
    p.style.top = `${Math.round(st.y + dy)}px`;
    p.style.setProperty('--drift', `${Math.round((Math.random() - 0.5) * 40)}px`);
    fx.appendChild(p);
    const remove = () => p.remove();
    p.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 3000);
  }

  function sparkles(n = 5) {
    for (let i = 0; i < n; i++) {
      setTimeout(() => particle(SPARK_SVG, 'ctc-spark', (Math.random() - 0.5) * SIZE, Math.random() * 20), i * 70);
    }
  }

  function hearts(n = 1) {
    for (let i = 0; i < n; i++) {
      setTimeout(() => particle(HEART_SVG, 'ctc-heart', (Math.random() - 0.5) * 30, 0), i * 160);
    }
  }

  function squash(kind) {
    if (reducedMotion() || typeof el.squash.animate !== 'function') return;
    const frames = kind === 'land'
      ? [{ transform: 'scale(1,1)' }, { transform: 'scale(1.25,0.75)' }, { transform: 'scale(0.92,1.08)' }, { transform: 'scale(1,1)' }]
      : [{ transform: 'scale(1,1)' }, { transform: 'scale(1.15,0.85)' }, { transform: 'scale(1,1)' }];
    el.squash.animate(frames, { duration: kind === 'land' ? 320 : 200, easing: 'ease-out' });
  }

  function setMood(mood, ms) {
    st.mood = mood;
    st.moodUntil = now() + ms;
    renderFace();
    setTimeout(() => { if (!destroyed) render(); }, ms + 20);
  }

  function touch() {
    st.lastInteraction = now();
  }

  // ── Motion ────────────────────────────────────────────────────────────────

  function kick() {
    if (rafId || destroyed || document.hidden) return;
    lastFrame = now();
    rafId = requestAnimationFrame(frame);
  }

  function hop(vy = -620) {
    sound.play('boing');
    if (reducedMotion()) { squash('hop'); return; }
    st.vy = vy;
    st.vx += (Math.random() - 0.5) * 60;
    st.grounded = false;
    st.mode = 'air';
    squash('hop');
    kick();
  }

  function land(impact) {
    st.mode = 'idle';
    if (impact > 900) sound.play('thud');
    if (impact > 1500) {
      setMood('dizzy', 2200);
      say(t('companion.dizzy'), 2000);
    }
    squash('land');
    persist();
    if (st.pendingRoutine) {
      const name = st.pendingRoutine;
      st.pendingRoutine = null;
      startRoutine(name);
    }
  }

  function targetOf(mode) {
    if (mode === 'chase' && props.ball) return props.ball.x + BALL_SIZE / 2 - SIZE / 2;
    if (mode === 'fetch' && props.cookie) return props.cookie.x + COOKIE_SIZE / 2 - SIZE / 2;
    if (mode === 'walk') return st.walkTarget;
    return null;
  }

  function frame() {
    rafId = 0;
    if (destroyed) return;
    const t0 = now();
    const dt = Math.min(0.033, (t0 - lastFrame) / 1000);
    lastFrame = t0;
    let moving = false;

    if (st.mode === 'air') {
      const impact = stepBody(st, dt, SIZE, SIZE, 0.45);
      st.maxImpact = Math.max(st.maxImpact, impact);
      if (impact > 500) squash('land');
      if (st.grounded && st.vx === 0) { land(st.maxImpact); st.maxImpact = 0; }
      else moving = true;
    }

    moving = stepProps(dt) || moving;

    if (st.mode === 'walk' || st.mode === 'chase' || st.mode === 'fetch') {
      const target = targetOf(st.mode);
      if (target == null) {
        st.mode = 'idle';
      } else {
        const dx = target - st.x;
        if (st.mode === 'fetch' && Math.abs(dx) < 16) {
          eat();
        } else if (st.mode === 'walk' && Math.abs(dx) < 3) {
          st.mode = 'idle';
          st.walkTarget = null;
          persist();
        } else {
          const speed = st.mode === 'walk' ? WALK_SPEED : RUN_SPEED;
          st.facing = dx > 0 ? 1 : -1;
          st.x = clamp(st.x + Math.sign(dx) * Math.min(Math.abs(dx), speed * dt), 0, maxX(SIZE));
          moving = true;
        }
      }
    }

    render();
    if (moving) rafId = requestAnimationFrame(frame);
  }

  // ── Props: ball and cookie ────────────────────────────────────────────────

  function makeProp(kind, svg, size, init, title) {
    const node = document.createElement('div');
    node.className = `ctc-prop ctc-${kind}`;
    node.innerHTML = svg;
    node.title = title;
    document.body.appendChild(node);
    const p = { kind, el: node, size, grounded: false, held: false, lastTouch: now(), kicks: 0, ...init };
    const touched = () => { p.lastTouch = now(); p.kicks = 0; };
    attachDrag(node, {
      getPos: () => [p.x, p.y],
      onGrab: () => { p.held = true; p.vx = 0; p.vy = 0; touched(); kick(); },
      onMove: (x, y) => { p.x = clamp(x, 0, maxX(size)); p.y = clamp(y, TOP_MARGIN, floorY(size)); touched(); renderProp(p); },
      onRelease: (vx, vy) => { p.held = false; p.vx = vx; p.vy = vy; p.grounded = false; touched(); kick(); },
      onClick: () => { p.vy = -700; p.vx += (Math.random() - 0.5) * 300; p.grounded = false; touched(); kick(); },
    });
    props[kind] = p;
    renderProp(p);
    kick();
    return p;
  }

  function removeProp(kind) {
    const p = props[kind];
    if (!p) return;
    p.el.remove();
    delete props[kind];
    if ((kind === 'ball' && st.mode === 'chase') || (kind === 'cookie' && st.mode === 'fetch')) st.mode = 'idle';
    render();
  }

  function renderProp(p) {
    const spin = p.kind === 'ball' ? ` rotate(${Math.round((p.x * 2) % 360)}deg)` : '';
    p.el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)${spin}`;
  }

  /** @returns {boolean} whether props (or a chase) still need frames */
  function stepProps(dt) {
    let moving = false;
    kickCooldown = Math.max(0, kickCooldown - dt);
    for (const p of Object.values(props)) {
      if (p.held) { moving = true; continue; }
      if (!p.grounded || p.vx !== 0) {
        stepBody(p, dt, p.size, p.size, p.kind === 'ball' ? 0.68 : 0.3);
        if (!(p.grounded && p.vx === 0)) moving = true;
      }
      renderProp(p);
    }

    const free = (st.mode === 'idle' || st.mode === 'walk' || st.mode === 'chase' || st.mode === 'fetch') &&
      st.grounded && st.session !== 'waiting' && !reducedMotion();
    const cookie = props.cookie;
    const ball = props.ball;

    // A cookie on the floor beats everything.
    if (cookie && free && cookie.grounded && !cookie.held) {
      st.mode = 'fetch';
      return true;
    }
    if (st.mode === 'fetch' && (!cookie || cookie.held)) st.mode = 'idle';

    if (ball && free) {
      const bored = ball.kicks >= 4; // bored until the user plays with it again
      if (bored && st.mode === 'chase') st.mode = 'idle';
      const centre = st.x + SIZE / 2;
      const ballCentre = ball.x + BALL_SIZE / 2;
      const near = Math.abs(centre - ballCentre) < SIZE / 2 + BALL_SIZE / 2 - 4 && ball.y > floorY(BALL_SIZE) - SIZE * 0.6;
      if (!bored && near && kickCooldown === 0) {
        kickCooldown = 0.7;
        ball.kicks++;
        const dir = ballCentre >= centre ? 1 : -1;
        ball.vx = dir * (420 + Math.random() * 420);
        ball.vy = -(420 + Math.random() * 380);
        ball.grounded = false;
        st.facing = dir;
        st.mode = 'idle';
        setMood('happy', 700);
        squash('hop');
        sound.play('pop');
        moving = true;
      } else if (!bored && !near && ball.grounded && Math.abs(ball.vx) < 300) {
        st.mode = 'chase';
        moving = true;
      }
    }
    return moving;
  }

  function throwBall() {
    if (props.ball) return;
    makeProp('ball', BALL_SVG, BALL_SIZE, {
      x: clamp(st.x + SIZE / 2 + st.facing * 30, 0, maxX(BALL_SIZE)),
      y: st.y - 30,
      vx: st.facing * 380 + (Math.random() - 0.5) * 120,
      vy: -760,
    }, t('companion.ballHint'));
    say(t('companion.ballStart'), 1800);
  }

  function giveCookie() {
    if (props.cookie || st.mode === 'eat') return;
    wake(false);
    if (reducedMotion()) {
      st.snacks++;
      setMood('chomp', 1200);
      say(t('companion.yum'), 2200);
      persist();
      return;
    }
    // Drop it on the side with more room, away from the companion.
    const room = window.innerWidth - st.x - SIZE;
    const dir = room > st.x ? 1 : -1;
    const x = clamp(st.x + SIZE / 2 + dir * (140 + Math.random() * 160), 0, maxX(COOKIE_SIZE));
    makeProp('cookie', COOKIE_SVG, COOKIE_SIZE, { x, y: TOP_MARGIN + 10, vx: 0, vy: 0 }, t('companion.cookieHint'));
    setMood('held', 900);
    say(t('companion.cookieSpotted'), 1600);
  }

  function eat() {
    const cookie = props.cookie;
    if (!cookie) { st.mode = 'idle'; return; }
    st.mode = 'eat';
    st.facing = cookie.x + COOKIE_SIZE / 2 >= st.x + SIZE / 2 ? 1 : -1;
    cookie.el.classList.add('ctc-eaten');
    let bites = 0;
    clearInterval(chewTimer);
    chewTimer = setInterval(() => {
      if (destroyed) { clearInterval(chewTimer); return; }
      if (st.mode !== 'eat' || !props.cookie) {
        clearInterval(chewTimer);
        props.cookie?.el.classList.remove('ctc-eaten');
        return;
      }
      bites++;
      st.chewFrame = bites % 2;
      renderFace();
      if (st.chewFrame) {
        sound.play('chomp');
        for (let i = 0; i < 2; i++) particle(CRUMB_SVG, 'ctc-crumb', st.facing * 18 + (Math.random() - 0.5) * 16, SIZE * 0.55);
      }
      if (bites >= 8) {
        clearInterval(chewTimer);
        removeProp('cookie');
        st.mode = 'idle';
        st.snacks++;
        const t0 = now();
        st.recentSnacks = st.recentSnacks.filter((s) => t0 - s < 10 * 60 * 1000);
        st.recentSnacks.push(t0);
        setMood('happy', 1800);
        hearts(2);
        say(st.recentSnacks.length >= 3 ? t('companion.full') : t('companion.yum'), 2400);
        persist();
        render();
      }
    }, 180);
    render();
  }

  // ── Routines: breathing and stretching ────────────────────────────────────

  function routineSteps(name) {
    if (name === 'stretch') {
      return [
        { cls: '', text: t('companion.stretchStart'), ms: 2200 },
        { cls: 'ctc-st-up', text: t('companion.stretchUp'), ms: 4500 },
        { cls: 'ctc-st-left', text: t('companion.stretchLeft'), ms: 4500 },
        { cls: 'ctc-st-right', text: t('companion.stretchRight'), ms: 4500 },
        { cls: 'ctc-st-roll', text: t('companion.stretchShoulders'), ms: 5000 },
        { cls: 'ctc-st-up', text: t('companion.stretchBreath'), ms: 4000, breath: 'inhale' },
      ];
    }
    const steps = [{ cls: '', text: t('companion.breatheStart'), ms: 2400 }];
    for (let c = 1; c <= BREATH_CYCLES; c++) {
      const n = `  ${c}/${BREATH_CYCLES}`;
      steps.push(
        { cls: 'ctc-breath-in', text: t('companion.inhale') + n, ms: 4000, breath: 'inhale' },
        { cls: 'ctc-breath-in', text: t('companion.hold') + n, ms: 4000, breath: 'hold' },
        { cls: '', text: t('companion.exhale') + n, ms: 6000, breath: 'exhale' },
      );
    }
    return steps;
  }

  function startRoutine(name) {
    if (st.mode === 'routine' && st.routine?.name === name) return;
    if (st.mode === 'air' || st.mode === 'held') { st.pendingRoutine = name; return; }
    stopRoutine(false);
    touch();
    if (st.mode === 'eat') return;
    st.mode = 'routine';
    st.facing = 1; // face the user the same way every time, so "left" is left
    st.walkTarget = null;
    st.offer = null;
    st.routine = { name, steps: routineSteps(name), i: -1, timer: null, stepCls: '' };
    root.classList.add('ctc-routine', `ctc-routine-${name}`);
    nextStep();
  }

  function nextStep() {
    const r = st.routine;
    if (!r || destroyed) return;
    if (r.stepCls) root.classList.remove(r.stepCls);
    r.i++;
    if (r.i >= r.steps.length) { stopRoutine(true); return; }
    const step = r.steps[r.i];
    r.stepCls = step.cls;
    root.style.setProperty('--ctc-step-ms', `${step.ms}ms`);
    if (step.cls) root.classList.add(step.cls);
    if (step.breath) sound.breath(step.breath, step.ms);
    say(step.text, step.ms + 200);
    renderFace();
    r.timer = setTimeout(nextStep, step.ms);
  }

  function stopRoutine(finished) {
    st.pendingRoutine = null;
    const r = st.routine;
    if (!r) return;
    clearTimeout(r.timer);
    sound.stopBreath();
    root.classList.remove('ctc-routine', `ctc-routine-${r.name}`);
    if (r.stepCls) root.classList.remove(r.stepCls);
    st.routine = null;
    if (st.mode === 'routine') st.mode = 'idle';
    if (finished) {
      setMood('happy', 2500);
      say(r.name === 'stretch' ? t('companion.stretchDone') : t('companion.breatheDone'), 3200);
      sparkles(4);
      sound.play('chime');
    } else {
      el.bubble.classList.remove('show');
    }
    render();
  }

  // ── Focus timer ───────────────────────────────────────────────────────────

  function startTimer(phase, announce = true) {
    clearInterval(timerInterval);
    const total = phase === 'focus' ? FOCUS_MS : BREAK_MS;
    st.timer = { phase, total, endAt: Date.now() + total };
    el.timer.hidden = false;
    el.timer.dataset.phase = phase;
    renderTimer();
    timerInterval = setInterval(timerTick, 1000);
    if (announce) say(phase === 'focus' ? t('companion.focusStart') : t('companion.breakStart'), 3000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
    st.timer = null;
    el.timer.hidden = true;
  }

  function renderTimer() {
    if (!st.timer) return;
    const left = st.timer.endAt - Date.now();
    el.timerText.textContent = formatClock(left);
    el.timer.style.setProperty('--p', String(clamp(1 - left / st.timer.total, 0, 1)));
  }

  function timerTick() {
    if (!st.timer || destroyed) return;
    if (Date.now() < st.timer.endAt) { renderTimer(); return; }
    const phase = st.timer.phase;
    sound.play('chime');
    wake(false);
    if (phase === 'focus') {
      startTimer('break', false);
      if (st.mode === 'idle' || st.mode === 'walk') hop(-520);
      sparkles(5);
      offer('stretch', t('companion.focusDone'));
    } else {
      stopTimer();
      if (st.mode === 'idle' || st.mode === 'walk') hop(-560);
      offer('focus', t('companion.breakDone'));
    }
  }

  // ── Sleep ─────────────────────────────────────────────────────────────────

  function sleep() {
    if (st.mode === 'sleep') return;
    stopRoutine(false);
    st.mode = 'sleep';
    st.walkTarget = null;
    render();
  }

  function wake(quip) {
    if (st.mode !== 'sleep') return;
    st.mode = 'idle';
    touch();
    setMood('held', 600);
    if (quip) say(t('companion.wake'), 2400);
    render();
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  attachDrag(el.hit, {
    getPos: () => [st.x, st.y],
    onGrab: () => {
      touch();
      closeMenu();
      stopRoutine(false);
      if (st.mode === 'sleep') wake(false);
      st.mode = 'held';
      st.vx = 0; st.vy = 0;
      if (Math.random() < 0.35) say(t('companion.grabbed'), 1400);
      render();
    },
    onMove: (x, y) => {
      st.x = clamp(x, 0, maxX(SIZE));
      st.y = clamp(y, TOP_MARGIN, floorY(SIZE));
      render();
    },
    onRelease: (vx, vy) => {
      st.vx = vx; st.vy = vy;
      st.grounded = false;
      st.mode = 'air';
      if (reducedMotion()) { st.vx = 0; st.vy = 0; st.y = floorY(SIZE); st.grounded = true; land(0); render(); return; }
      if (Math.hypot(vx, vy) > 1400) say(t('companion.thrown'), 1200);
      kick();
    },
    onClick: () => onCompanionClick(),
  });

  function onCompanionClick() {
    touch();
    closeMenu();
    if (st.mode === 'sleep') { wake(true); return; }
    if (st.mode === 'routine') { stopRoutine(false); return; }
    // Claude is waiting on the user: take them there.
    if (st.session === 'waiting' && st.waitingId != null && deps.focusTerminal) {
      try { deps.focusTerminal(st.waitingId); } catch (e) { console.error('[Companion] focus failed:', e); }
      if (st.mode !== 'air') hop(-420);
      return;
    }
    if (st.offer && now() < st.offer.until) {
      const { action } = st.offer;
      st.offer = null;
      runAction(action);
      return;
    }
    const t0 = now();
    st.clicks = st.clicks.filter((c) => t0 - c < 2000);
    st.clicks.push(t0);
    if (st.clicks.length >= 6) {
      st.clicks = [];
      setMood('dizzy', 2500);
      say(t('companion.dizzy'), 2200);
      return;
    }
    if (st.mode === 'air' || st.mode === 'eat') return;
    hop();
    if (Math.random() < 0.3) {
      say(pick([
        t('companion.line1'), t('companion.line2'), t('companion.line3'),
        t('companion.line4'), t('companion.line5'), t('companion.line6'),
        t('companion.line7'), t('companion.line8'),
      ]), 3200);
    }
  }

  el.hit.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (st.session === 'waiting') return; // the first click already opened the tab
    startRoutine('breathe');
  });

  // Stroking: pointer moving over it without a button pressed.
  let lastPet = null;
  el.hit.addEventListener('pointermove', (e) => {
    if (e.buttons !== 0 || st.mode === 'held' || st.mode === 'air') { lastPet = null; return; }
    if (lastPet) st.petAccum += Math.hypot(e.clientX - lastPet[0], e.clientY - lastPet[1]);
    lastPet = [e.clientX, e.clientY];
    if (st.petAccum < PET_DISTANCE) return;
    st.petAccum = 0;
    st.pets++;
    touch();
    if (st.mode === 'walk' || st.mode === 'chase') st.mode = 'idle';
    setMood('happy', 1400);
    hearts(1);
    if (now() - st.lastPurr > 900) { st.lastPurr = now(); sound.play('purr'); }
    if (st.pets % 10 === 0) persist();
    if (st.pets % 50 === 0 && st.mode !== 'sleep') { say(t('companion.petMilestone', { count: st.pets }), 2600); sparkles(4); }
  });
  el.hit.addEventListener('pointerleave', () => { lastPet = null; st.petAccum = 0; });

  el.hit.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onCompanionClick();
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const r = el.hit.getBoundingClientRect();
      openMenu(r.left, r.top);
    }
  });

  el.hit.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY);
  });

  // Eyes follow the cursor when it is nearby.
  const onDocMove = (e) => {
    if (st.mode === 'held' || st.mode === 'sleep') return;
    const dx = e.clientX - (st.x + SIZE / 2);
    const dy = e.clientY - (st.y + SIZE / 2);
    const dist = Math.hypot(dx, dy);
    let look = [0, 0];
    if (dist < 320 && dist > SIZE / 2) {
      // Eyes are drawn in sprite space, which is mirrored when facing left.
      look = [Math.sign(Math.round(dx / 60)) * st.facing, Math.sign(Math.round(dy / 60))];
    }
    if (look[0] !== st.look[0] || look[1] !== st.look[1]) {
      st.look = look;
      renderFace();
    }
  };
  document.addEventListener('pointermove', onDocMove, { passive: true });

  // ── Menu ──────────────────────────────────────────────────────────────────

  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener('mousedown', onMenuOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }
  const onMenuOutside = (e) => { if (menu && !menu.contains(e.target)) closeMenu(); };
  const onMenuKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); el.hit.focus(); }
  };

  const item = (action, label, extra = '') =>
    `<button type="button" role="menuitem" data-action="${action}"${extra}>${label}</button>`;

  function menuHtml() {
    const inRoutine = st.mode === 'routine' ? st.routine?.name : null;
    const timerLabel = st.timer
      ? t('companion.menuTimerStop', { time: formatClock(st.timer.endAt - Date.now()) })
      : t('companion.menuFocus');
    const swatches = Object.entries(PALETTES).map(([id, c]) =>
      `<button type="button" class="ctc-swatch${id === prefs.color ? ' active' : ''}" data-color="${id}" style="--sw:${c.body}" ` +
      `title="${t(`companion.color.${id}`)}" aria-label="${t(`companion.color.${id}`)}" aria-pressed="${id === prefs.color}"></button>`).join('');
    const hats = Object.keys(ACCESSORIES).map((id) =>
      `<button type="button" class="ctc-hat${id === prefs.hat ? ' active' : ''}" data-hat="${id}" ` +
      `title="${t(`companion.hat.${id}`)}" aria-label="${t(`companion.hat.${id}`)}" aria-pressed="${id === prefs.hat}">` +
      `${spriteSvg('idle', [0, 0], { color: prefs.color, hat: id }, 2)}</button>`).join('');
    return `
      <div class="ctc-menu-head">${HEART_SVG}<span>${t('companion.stats', { pets: st.pets, snacks: st.snacks })}</span></div>
      <div class="ctc-menu-section">${t('companion.sectionRelax')}</div>
      ${inRoutine === 'breathe' ? item('routine-stop', t('companion.menuStopBreathe')) : item('breathe', t('companion.menuBreathe'))}
      ${inRoutine === 'stretch' ? item('routine-stop', t('companion.menuStopStretch')) : item('stretch', t('companion.menuStretch'))}
      ${item(st.timer ? 'timer-stop' : 'focus', timerLabel)}
      <div class="ctc-menu-section">${t('companion.sectionPlay')}</div>
      ${item('cookie', t('companion.menuCookie'), props.cookie || st.mode === 'eat' ? ' disabled' : '')}
      ${props.ball ? item('ball-away', t('companion.menuBallAway')) : item('ball', t('companion.menuBall'))}
      ${st.mode === 'sleep' ? item('wake', t('companion.menuWake')) : item('sleep', t('companion.menuSleep'))}
      <div class="ctc-menu-section">${t('companion.sectionLook')}</div>
      <div class="ctc-swatches" role="group" aria-label="${t('companion.sectionLook')}">${swatches}</div>
      <div class="ctc-hats" role="group">${hats}</div>
      <div class="ctc-menu-sep"></div>
      ${item('sound', `${t('companion.menuSound')}<span class="ctc-check">${prefs.sound ? '✓' : ''}</span>`, ` aria-checked="${prefs.sound}" role="menuitemcheckbox"`)}
      ${item('home', t('companion.menuHome'))}
      ${item('hide', t('companion.menuHide'))}`;
  }

  function openMenu(x, y, keepFocus) {
    closeMenu();
    touch();
    menuAt = [x, y];
    menu = document.createElement('div');
    menu.className = 'ctc-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = menuHtml();
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.round(clamp(x, 8, window.innerWidth - r.width - 8))}px`;
    menu.style.top = `${Math.round(clamp(y - r.height, 8, window.innerHeight - r.height - 8))}px`;
    const focusTarget = keepFocus ? menu.querySelector(keepFocus) : menu.querySelector('button[data-action]');
    focusTarget?.focus();
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      if (btn.dataset.color) {
        prefs.color = btn.dataset.color;
        restyle();
        openMenu(...menuAt, `[data-color="${prefs.color}"]`);
        return;
      }
      if (btn.dataset.hat) {
        prefs.hat = btn.dataset.hat;
        restyle();
        openMenu(...menuAt, `[data-hat="${prefs.hat}"]`);
        return;
      }
      if (btn.dataset.action === 'sound') {
        prefs.sound = !prefs.sound;
        sound.setEnabled(prefs.sound);
        sound.play('blip');
        persist();
        openMenu(...menuAt, '[data-action="sound"]');
        return;
      }
      closeMenu();
      runAction(btn.dataset.action);
    });
    document.addEventListener('mousedown', onMenuOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
  }

  function restyle() {
    faceKey = '';
    renderFace();
    persist();
    setMood('happy', 900);
    sparkles(3);
  }

  function runAction(action) {
    switch (action) {
      case 'breathe': wake(false); startRoutine('breathe'); break;
      case 'stretch': wake(false); startRoutine('stretch'); break;
      case 'routine-stop': stopRoutine(false); break;
      case 'focus': wake(false); startTimer('focus'); break;
      case 'timer-stop': stopTimer(); break;
      case 'cookie': giveCookie(); break;
      case 'ball': wake(false); throwBall(); break;
      case 'ball-away': removeProp('ball'); break;
      case 'sleep': sleep(); break;
      case 'wake': wake(true); break;
      case 'home':
        stopRoutine(false);
        if (st.mode === 'sleep') wake(false);
        st.x = maxX(SIZE) - 40;
        st.y = TOP_MARGIN + 40;
        st.vx = -200; st.vy = 0;
        st.mode = 'air';
        kick();
        break;
      case 'hide':
        api.onHide?.();
        break;
      default: break;
    }
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  function accrueWork() {
    const t0 = now();
    if (st.session === 'working') st.workMs += t0 - st.workMark;
    st.workMark = t0;
  }

  function onSessions(state) {
    accrueWork();
    let waitingId = null;
    let working = false;
    const finished = [];
    const seen = new Set();
    for (const [id, term] of state.terminals) {
      if (term.type === 'fivem' || term.type === 'webapp' || term.isBasic) continue;
      seen.add(id);
      const isWaiting = term.attention === 'input';
      const isWorking = term.status === 'working' && !isWaiting;
      if (isWaiting && waitingId == null) waitingId = id;
      if (isWorking) {
        working = true;
        if (!workStarts.has(id)) workStarts.set(id, now());
      } else if (workStarts.has(id)) {
        const started = workStarts.get(id);
        workStarts.delete(id);
        if (!isWaiting && now() - started > 4000) finished.push(term);
      }
    }
    for (const id of [...workStarts.keys()]) if (!seen.has(id)) workStarts.delete(id);

    const prev = st.session;
    const next = waitingId != null ? 'waiting' : working ? 'working' : 'none';
    const newlyWaiting = waitingId != null && waitingId !== st.waitingId;
    st.session = next;
    st.waitingId = waitingId;

    if (next !== 'none' && st.mode === 'sleep') wake(false);
    if (newlyWaiting && st.mode !== 'routine') {
      say(deps.focusTerminal ? t('companion.waitingClick') : t('companion.waiting'), 4000);
      sound.play('blip');
      if (st.mode !== 'held' && st.mode !== 'air' && st.mode !== 'eat') hop(-520);
    }
    if (finished.length && next !== 'waiting' && st.mode !== 'held' && st.mode !== 'routine') {
      const project = finished[0].project?.name;
      setMood('done', 2200);
      say(project ? t('companion.doneIn', { project }) : t('companion.done'), 2600);
      sparkles(6);
      sound.play('chime');
      if (st.mode !== 'air' && st.mode !== 'eat') hop(-560);
    }
    if (next !== prev || newlyWaiting) render();
  }
  const unsubscribeSessions = terminalsState.subscribe(onSessions);
  onSessions(terminalsState.get());

  // ── Behaviour tick (wander, sleep, wellbeing nudges, prop tidy-up) ────────

  function scheduleTick() {
    tickTimer = setTimeout(behaviourTick, 4000 + Math.random() * 9000);
  }

  function behaviourTick() {
    if (destroyed) return;
    scheduleTick();
    if (document.hidden) return;
    accrueWork();
    const t0 = now();
    const idleFor = t0 - st.lastInteraction;
    for (const p of Object.values(props)) {
      if (!p.held && t0 - p.lastTouch > PROP_IDLE_MS && p.kind === 'ball') removeProp('ball');
    }
    if (st.mode === 'sleep') {
      particle('<span>z</span>', 'ctc-zzz', 14, -6);
      setTimeout(() => { if (st.mode === 'sleep') particle('<span>Z</span>', 'ctc-zzz', 22, -14); }, 700);
      return;
    }
    if (st.mode !== 'idle') return;

    // Wellbeing nudges, at most one per tick.
    if (st.workMs > STRETCH_AFTER_WORK_MS && !st.timer) {
      st.workMs = 0;
      setMood('yawn', 1600);
      offer('stretch', t('companion.stretchOffer'));
      return;
    }
    const hour = new Date().getHours();
    const lateNight = hour >= 23 || hour < 5;
    if (lateNight && Date.now() - st.lastNight > 60 * 60 * 1000 && (st.session !== 'none' || idleFor < 5 * 60 * 1000)) {
      st.lastNight = Date.now();
      persist();
      setMood('yawn', 1800);
      say(t('companion.late'), 4500);
      return;
    }

    if (Object.keys(props).length) return;
    if (st.session === 'none' && idleFor > SLEEP_AFTER_MS && !st.timer) { sleep(); return; }
    if (st.session !== 'none' || reducedMotion()) return;
    if (Math.random() < 0.55) {
      st.walkTarget = clamp(st.x + (Math.random() - 0.5) * 360, 0, maxX(SIZE));
      st.mode = 'walk';
      kick();
    }
  }
  scheduleTick();

  // ── Window events ─────────────────────────────────────────────────────────

  const onResize = () => {
    st.x = clamp(st.x, 0, maxX(SIZE));
    if (st.mode !== 'held') {
      if (st.y > floorY(SIZE) || st.grounded) st.y = floorY(SIZE);
      if (st.mode === 'idle' && st.y < floorY(SIZE)) { st.mode = 'air'; kick(); }
    }
    for (const p of Object.values(props)) {
      p.x = clamp(p.x, 0, maxX(p.size));
      p.y = Math.min(p.y, floorY(p.size));
      p.grounded = false;
    }
    kick();
    render();
  };
  window.addEventListener('resize', onResize);
  const onVisibility = () => { if (!document.hidden) kick(); };
  document.addEventListener('visibilitychange', onVisibility);

  render();

  // Hello: an introduction the first time, then a greeting once a day.
  if (!store.met || store.lastGreet !== today()) {
    const first = !store.met;
    store.lastGreet = today();
    persist();
    setTimeout(() => {
      if (destroyed) return;
      const hour = new Date().getHours();
      const greet = first ? t('companion.hello')
        : hour < 5 ? t('companion.greetNight')
          : hour < 12 ? t('companion.greetMorning')
            : hour < 18 ? t('companion.greetAfternoon')
              : t('companion.greetEvening');
      say(greet, 4500);
      hop(-500);
    }, 1200);
  }

  const api = {
    onHide: null,
    destroy() {
      destroyed = true;
      persist();
      cancelAnimationFrame(rafId);
      clearTimeout(tickTimer);
      clearTimeout(sayTimer);
      clearInterval(timerInterval);
      clearInterval(chewTimer);
      if (st.routine) clearTimeout(st.routine.timer);
      sound.stopBreath();
      unsubscribeSessions();
      closeMenu();
      for (const kind of Object.keys(props)) removeProp(kind);
      document.removeEventListener('pointermove', onDocMove);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      root.remove();
      fx.remove();
    },
    // Exposed for tests and the console.
    _state: st,
    _props: props,
    breathe: () => startRoutine('breathe'),
    stretch: () => startRoutine('stretch'),
    run: runAction,
  };
  return api;
}

/**
 * Mount the companion and keep it in sync with settings.companionEnabled.
 * @param {object} deps
 * @param {object} deps.settingsState
 * @param {(key: string, value: any) => void} deps.setSetting
 * @param {(terminalId: any) => void} [deps.focusTerminal]
 */
function initCompanion({ settingsState, setSetting, focusTerminal }) {
  let companion = null;
  const sync = (s) => {
    const on = s.companionEnabled !== false;
    if (on && !companion) {
      companion = createCompanion({ focusTerminal });
      companion.onHide = () => setSetting('companionEnabled', false);
    } else if (!on && companion) {
      companion.destroy();
      companion = null;
    }
  };
  sync(settingsState.get());
  settingsState.subscribe(sync);
  return { get: () => companion };
}

module.exports = { initCompanion, createCompanion, stepBody, releaseVelocity, formatClock, spriteSvg };
