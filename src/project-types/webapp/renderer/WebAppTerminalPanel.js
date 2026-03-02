/**
 * Web App Terminal Panel
 * Dev server console view with info panel + live preview (webview)
 */

const { getWebAppServer, setWebAppPort } = require('./WebAppState');
const { getSetting } = require('../../../renderer/state/settings.state');
const { t } = require('../../../renderer/i18n');
const api = window.electron_api;

// Track active poll timer per wrapper (shared between views)
const pollTimers = new WeakMap();

// Store detached webview data per previewView element
const detachedWebviews = new WeakMap();

function clearPollTimer(wrapper) {
  const timer = pollTimers.get(wrapper);
  if (timer) {
    clearInterval(timer);
    pollTimers.delete(wrapper);
  }
}

function startPortPoll(wrapper, projectIndex, onFound) {
  clearPollTimer(wrapper);
  const timer = setInterval(async () => {
    const s = getWebAppServer(projectIndex);
    if (s.status === 'stopped') { clearPollTimer(wrapper); return; }
    let p = s.port;
    if (!p) {
      try { p = await api.webapp.getPort({ projectIndex }); } catch (e) {}
    }
    if (p) {
      setWebAppPort(projectIndex, p);
      clearPollTimer(wrapper);
      onFound(p);
    }
  }, 2000);
  pollTimers.set(wrapper, timer);
}

async function resolvePort(projectIndex) {
  const server = getWebAppServer(projectIndex);
  if (server.port) return server.port;
  if (server.status !== 'running') return null;
  try {
    const p = await api.webapp.getPort({ projectIndex });
    if (p) setWebAppPort(projectIndex, p);
    return p || null;
  } catch (e) { return null; }
}

function isPreviewEnabled() {
  const val = getSetting('webappPreviewEnabled');
  return val !== undefined ? val : true;
}

// ── SVG icons ──────────────────────────────────────────────────────────
const ICON_CONSOLE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><rect x="1" y="2" width="14" height="12" rx="2"/><path d="M4.5 6L7 8.5 4.5 11M8.5 11H12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_PREVIEW = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><rect x="1" y="3" width="14" height="10" rx="2"/><path d="M1 6h14" stroke-linecap="round"/><circle cx="4" cy="4.5" r=".6" fill="currentColor" stroke="none"/><circle cx="6" cy="4.5" r=".6" fill="currentColor" stroke="none"/><circle cx="8" cy="4.5" r=".6" fill="currentColor" stroke="none"/></svg>`;
const ICON_INFO    = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.5v4M8 5.5v.5" stroke-linecap="round"/></svg>`;
const ICON_BACK    = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M7.5 2.5L4 6l3.5 3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_FWD     = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M4.5 2.5L8 6 4.5 9.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_RELOAD  = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M10 3.5A5 5 0 103.5 10" stroke-linecap="round"/><path d="M10 1.5v2H8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_OPEN    = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M8 2h2v2M10 2L6 6M5 3H2v7h7V7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_INSPECT = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M1 1l4.2 10 1.5-3.8L10.5 5.7z" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 7l4 4" stroke-linecap="round"/></svg>`;

// Responsive breakpoint icons
const ICON_RESPONSIVE_FULL    = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M1 4V1h3M8 1h3v3M11 8v3H8M4 11H1V8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_RESPONSIVE_MOBILE  = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" width="11" height="11"><rect x="3" y="1" width="6" height="10" rx="1.2"/><path d="M5.5 9.5h1" stroke-linecap="round"/></svg>`;
const ICON_RESPONSIVE_TABLET  = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" width="11" height="11"><rect x="2" y="1.5" width="8" height="9" rx="1.2"/><path d="M5.5 9h1" stroke-linecap="round"/></svg>`;
const ICON_RESPONSIVE_LAPTOP  = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" width="11" height="11"><rect x="2" y="2" width="8" height="6" rx="1"/><path d="M1 10h10" stroke-linecap="round"/></svg>`;
const ICON_RESPONSIVE_DESKTOP = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" width="11" height="11"><rect x="1" y="1.5" width="10" height="7" rx="1"/><path d="M4 10.5h4M6 8.5v2" stroke-linecap="round"/></svg>`;

// Auto-scan icon
const ICON_SCAN = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M1 3V1h2M9 1h2v2M11 9v2H9M3 11H1V9" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 6h5" stroke-linecap="round"/></svg>`;

// Ruler / spacing measurement icon
const ICON_RULER = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" width="11" height="11"><path d="M1.5 10.5l9-9" stroke-linecap="round"/><path d="M3.5 10V8.5M5.5 9V7.5M7.5 7V5.5" stroke-linecap="round"/><path d="M1 10.5h2.5V8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ── Inspect inject/uninject scripts ──────────────────────────────────
function getInspectInjectScript() {
  const hex = getSetting('accentColor') || '#d97706';
  // Parse hex to r,g,b for rgba usage inside webview
  const r = parseInt(hex.slice(1, 3), 16) || 217;
  const g = parseInt(hex.slice(3, 5), 16) || 119;
  const b = parseInt(hex.slice(5, 7), 16) || 6;
  return `(function() {
  if (window.__CT_INSPECT_ACTIVE__) return;
  window.__CT_INSPECT_ACTIVE__ = true;
  // Kill standalone scroll listener (we have our own)
  if (window.__CT_SCROLL_AC__) { window.__CT_SCROLL_AC__.abort(); delete window.__CT_SCROLL_AC__; window.__CT_SCROLL_ACTIVE__ = false; }
  const ac = new AbortController();
  window.__CT_INSPECT_AC__ = ac;
  const s = ac.signal;
  const _c = '${hex}', _bg = 'rgba(${r},${g},${b},0.08)';

  const overlay = document.createElement('div');
  overlay.id = '__ct_inspect_overlay__';
  Object.assign(overlay.style, {
    position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
    border: '2px solid ' + _c, borderRadius: '3px',
    background: _bg, transition: 'all 0.08s ease',
    display: 'none', top: '0', left: '0', width: '0', height: '0'
  });
  document.body.appendChild(overlay);

  const label = document.createElement('div');
  label.id = '__ct_inspect_label__';
  Object.assign(label.style, {
    position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
    background: _c, color: '#fff', fontSize: '10px', fontFamily: 'monospace',
    padding: '2px 6px', borderRadius: '3px', whiteSpace: 'nowrap',
    display: 'none', top: '0', left: '0'
  });
  document.body.appendChild(label);

  // Send scroll position so host can reposition pins
  var scrollThrottle = null;
  window.addEventListener('scroll', function() {
    if (scrollThrottle) return;
    scrollThrottle = setTimeout(function() {
      scrollThrottle = null;
      console.log('__CT_INSPECT_SCROLL__:' + JSON.stringify({ scrollX: window.scrollX, scrollY: window.scrollY }));
    }, 16);
  }, { capture: true, signal: s });

  // Send initial scroll position
  console.log('__CT_INSPECT_SCROLL__:' + JSON.stringify({ scrollX: window.scrollX, scrollY: window.scrollY }));

  let lastEl = null;
  document.addEventListener('mousemove', function(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === label) return;
    if (el === lastEl) return;
    lastEl = el;
    const r = el.getBoundingClientRect();
    Object.assign(overlay.style, {
      display: 'block', top: r.top + 'px', left: r.left + 'px',
      width: r.width + 'px', height: r.height + 'px'
    });
    const tag = el.tagName.toLowerCase();
    const dim = Math.round(r.width) + 'x' + Math.round(r.height);
    label.textContent = tag + (el.id ? '#' + el.id : '') + ' ' + dim;
    Object.assign(label.style, {
      display: 'block',
      top: Math.max(0, r.top - 20) + 'px',
      left: r.left + 'px'
    });
  }, { signal: s });

  // Block all clicks/navigation while in inspect mode
  function blockEvent(e) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
  document.addEventListener('click', blockEvent, { capture: true, signal: s });
  document.addEventListener('auxclick', blockEvent, { capture: true, signal: s });
  document.addEventListener('submit', blockEvent, { capture: true, signal: s });
  document.addEventListener('pointerup', blockEvent, { capture: true, signal: s });
  document.addEventListener('mouseup', blockEvent, { capture: true, signal: s });

  document.addEventListener('mousedown', function(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === label) return;
    const r = el.getBoundingClientRect();
    const selector = (function() {
      if (el.id) return '#' + el.id;
      let s = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\\s+/).join('.');
      return s;
    })();
    const data = {
      tagName: el.tagName.toLowerCase(),
      id: el.id || '',
      className: (typeof el.className === 'string' ? el.className : ''),
      selector: selector,
      text: (el.textContent || '').trim().substring(0, 60),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      scroll: { x: window.scrollX, y: window.scrollY }
    };
    console.log('__CT_INSPECT__:' + JSON.stringify(data));
  }, { capture: true, signal: s });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      console.log('__CT_INSPECT_CANCEL__');
    }
    if (e.key === 'i' || e.key === 'I') {
      if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        console.log('__CT_INSPECT_TOGGLE__');
      }
    }
  }, { signal: s });
})();`;
}

const INSPECT_UNINJECT_SCRIPT = `(function() {
  if (window.__CT_INSPECT_AC__) { window.__CT_INSPECT_AC__.abort(); delete window.__CT_INSPECT_AC__; }
  var o = document.getElementById('__ct_inspect_overlay__'); if (o) o.remove();
  var l = document.getElementById('__ct_inspect_label__'); if (l) l.remove();
  window.__CT_INSPECT_ACTIVE__ = false;
})();`;

// Lightweight scroll-only listener (stays active while pins are displayed)
const SCROLL_LISTEN_SCRIPT = `(function() {
  if (window.__CT_SCROLL_ACTIVE__) return;
  window.__CT_SCROLL_ACTIVE__ = true;
  var ac = new AbortController();
  window.__CT_SCROLL_AC__ = ac;
  var throttle = null;
  window.addEventListener('scroll', function() {
    if (throttle) return;
    throttle = setTimeout(function() {
      throttle = null;
      console.log('__CT_INSPECT_SCROLL__:' + JSON.stringify({ scrollX: window.scrollX, scrollY: window.scrollY }));
    }, 16);
  }, { capture: true, signal: ac.signal });
  console.log('__CT_INSPECT_SCROLL__:' + JSON.stringify({ scrollX: window.scrollX, scrollY: window.scrollY }));
})();`;

const SCROLL_UNLISTEN_SCRIPT = `(function() {
  if (window.__CT_SCROLL_AC__) { window.__CT_SCROLL_AC__.abort(); delete window.__CT_SCROLL_AC__; }
  window.__CT_SCROLL_ACTIVE__ = false;
})();`;

// Lightweight key listener: forwards "I" and "R" keydown to host via console.log when inspect/ruler is not active
const KEY_LISTEN_SCRIPT = `(function() {
  if (window.__CT_KEY_ACTIVE__) return;
  window.__CT_KEY_ACTIVE__ = true;
  document.addEventListener('keydown', function(e) {
    if (window.__CT_INSPECT_ACTIVE__ || window.__CT_RULER_ACTIVE__) return;
    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.key === 'i' || e.key === 'I') console.log('__CT_INSPECT_TOGGLE__');
      if (e.key === 'r' || e.key === 'R') console.log('__CT_RULER_TOGGLE__');
    }
  });
})();`;

// ── axe-core source cache ───────────────────────────────────────────
let _axeSource = null;
async function _loadAxeSource() {
  if (_axeSource) return _axeSource;
  try {
    _axeSource = await api.webapp.getAxeSource();
  } catch (e) {
    console.error('[Scan] Failed to load axe-core:', e);
  }
  return _axeSource;
}

// ── axe-core rule → issue type mapping ──────────────────────────────
const AXE_TYPE_MAP = {
  'color-contrast': 'contrast', 'color-contrast-enhanced': 'contrast',
  'image-alt': 'alt-text', 'input-image-alt': 'alt-text', 'area-alt': 'alt-text',
  'role-img-alt': 'alt-text', 'svg-img-alt': 'alt-text', 'object-alt': 'alt-text',
};
function _mapAxeType(ruleId) {
  if (AXE_TYPE_MAP[ruleId]) return AXE_TYPE_MAP[ruleId];
  if (ruleId.startsWith('aria')) return 'aria';
  if (ruleId.includes('focus') || ruleId.includes('tabindex')) return 'keyboard';
  if (ruleId.includes('heading') || ruleId.includes('landmark') || ruleId.includes('region') || ruleId.includes('document') || ruleId.includes('page')) return 'structure';
  return 'a11y';
}

// ── Auto-scan injection script ──────────────────────────────────────
function getScanInjectionScript(hasAxe) {
  return `(async function() {
  var results = [];
  var MAX_RESULTS = 100;

  function getSelector(el) {
    if (el.id) return '#' + el.id;
    var s = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      var c = el.className.trim().split(/\\s+/).filter(Boolean);
      if (c.length) s += '.' + c.join('.');
    }
    return s;
  }

  function makeResult(el, type, description) {
    if (results.length >= MAX_RESULTS) return;
    var r = el.getBoundingClientRect();
    results.push({
      type: type,
      description: description,
      tagName: el.tagName.toLowerCase(),
      id: el.id || '',
      className: (typeof el.className === 'string' ? el.className : ''),
      selector: getSelector(el),
      text: (el.textContent || '').trim().substring(0, 60),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      scroll: { x: window.scrollX, y: window.scrollY }
    });
  }

  // ── 1. OVERFLOW (custom — axe doesn't cover this) ──
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length && results.length < MAX_RESULTS; i++) {
    var el = all[i];
    if (el.tagName === 'HTML' || el.tagName === 'BODY') continue;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      var overX = el.scrollWidth - el.clientWidth;
      var overY = el.scrollHeight - el.clientHeight;
      if (overX > 5 || overY > 5) {
        var st = window.getComputedStyle(el);
        var ovf = st.overflow + ' ' + st.overflowX + ' ' + st.overflowY;
        if (ovf.indexOf('hidden') === -1 && ovf.indexOf('scroll') === -1 && ovf.indexOf('auto') === -1) {
          var desc = 'Content overflows by ' +
            (overX > 5 ? overX + 'px horizontally' : '') +
            (overX > 5 && overY > 5 ? ' and ' : '') +
            (overY > 5 ? overY + 'px vertically' : '');
          makeResult(el, 'overflow', desc);
        }
      }
    }
  }

  // ── 2. Z-INDEX OVERLAP (custom — axe doesn't cover this) ──
  var zEls = [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var st = window.getComputedStyle(el);
    var z = parseInt(st.zIndex);
    if (!isNaN(z) && z > 0 && st.position !== 'static') {
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) zEls.push({ el: el, z: z, rect: r });
    }
  }
  for (var i = 0; i < zEls.length && results.length < MAX_RESULTS; i++) {
    for (var j = i + 1; j < zEls.length; j++) {
      var a = zEls[i], b = zEls[j];
      if (a.z === b.z) continue;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      var overlap = !(a.rect.right < b.rect.left || b.rect.right < a.rect.left ||
                      a.rect.bottom < b.rect.top || b.rect.bottom < a.rect.top);
      if (overlap) {
        var hi = a.z > b.z ? a : b;
        var lo = a.z > b.z ? b : a;
        makeResult(hi.el, 'z-index',
          'z-index: ' + hi.z + ' overlaps with ' + getSelector(lo.el) + ' (z-index: ' + lo.z + ')'
        );
      }
    }
  }

  // ── 3. AXE-CORE (accessibility — contrast, alt-text, ARIA, keyboard, structure, etc.) ──
  ${hasAxe ? `
  try {
    var axeConfig = {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'best-practice'] },
      resultTypes: ['violations']
    };
    var axeResults = await window.axe.run(document, axeConfig);

    // Map axe-core rule IDs to our issue type categories
    var axeTypeMap = ${JSON.stringify(AXE_TYPE_MAP)};
    function mapAxeType(ruleId) {
      if (axeTypeMap[ruleId]) return axeTypeMap[ruleId];
      if (ruleId.startsWith('aria')) return 'aria';
      if (ruleId.indexOf('focus') !== -1 || ruleId.indexOf('tabindex') !== -1) return 'keyboard';
      if (ruleId.indexOf('heading') !== -1 || ruleId.indexOf('landmark') !== -1 || ruleId.indexOf('region') !== -1) return 'structure';
      return 'a11y';
    }

    var impactOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    var sorted = (axeResults.violations || []).sort(function(a, b) {
      return (impactOrder[a.impact] || 4) - (impactOrder[b.impact] || 4);
    });

    for (var v = 0; v < sorted.length && results.length < MAX_RESULTS; v++) {
      var violation = sorted[v];
      var type = mapAxeType(violation.id);
      var impactTag = violation.impact ? '[' + violation.impact.toUpperCase() + '] ' : '';

      for (var n = 0; n < violation.nodes.length && results.length < MAX_RESULTS; n++) {
        var node = violation.nodes[n];
        var selector = (node.target && node.target[0]) || '';
        var el = null;
        try { el = selector ? document.querySelector(selector) : null; } catch(e) {}

        if (el) {
          makeResult(el, type, impactTag + violation.help);
        } else if (selector) {
          // Element not found via querySelector, create result manually
          var desc = impactTag + violation.help;
          results.push({
            type: type, description: desc,
            tagName: (node.html || '').match(/<(\\w+)/)?.[1]?.toLowerCase() || '',
            id: '', className: '', selector: selector,
            text: (node.html || '').substring(0, 60),
            rect: { x: 0, y: 0, width: 0, height: 0 },
            scroll: { x: window.scrollX, y: window.scrollY }
          });
        }
      }
    }
  } catch (axeErr) {
    console.warn('[CT Scan] axe-core error:', axeErr.message);
  }
  ` : `
  // axe-core not available — no accessibility checks
  `}

  // Deduplicate
  var seen = {};
  var unique = [];
  for (var i = 0; i < results.length; i++) {
    var key = results[i].type + '|' + results[i].selector;
    if (!seen[key]) { seen[key] = true; unique.push(results[i]); }
  }

  console.log('__CT_SCAN__:' + JSON.stringify(unique));
})()`;
}

// ── Ruler inject/uninject scripts ──────────────────────────────────
function getRulerInjectScript() {
  return `(function() {
  if (window.__CT_RULER_ACTIVE__) return;
  window.__CT_RULER_ACTIVE__ = true;
  var ac = new AbortController();
  window.__CT_RULER_AC__ = ac;
  var s = ac.signal;

  // Kill standalone scroll listener
  if (window.__CT_SCROLL_AC__) { window.__CT_SCROLL_AC__.abort(); delete window.__CT_SCROLL_AC__; window.__CT_SCROLL_ACTIVE__ = false; }

  // Overlay elements
  var boxmodel = document.createElement('div');
  boxmodel.id = '__ct_ruler_boxmodel__';
  Object.assign(boxmodel.style, { position:'fixed', zIndex:'2147483646', pointerEvents:'none', display:'none', top:'0', left:'0' });
  boxmodel.innerHTML = '<div id="__ct_rm__" style="position:absolute;background:rgba(251,146,60,0.3)"></div><div id="__ct_rb__" style="position:absolute;background:rgba(250,204,21,0.35)"></div><div id="__ct_rp__" style="position:absolute;background:rgba(74,222,128,0.35)"></div><div id="__ct_rc__" style="position:absolute;background:rgba(96,165,250,0.25)"></div>';
  document.body.appendChild(boxmodel);

  var dimLabel = document.createElement('div');
  dimLabel.id = '__ct_ruler_dim__';
  Object.assign(dimLabel.style, { position:'fixed', zIndex:'2147483647', pointerEvents:'none', background:'rgba(0,0,0,0.8)', color:'#fff', fontSize:'10px', fontFamily:'monospace', padding:'2px 6px', borderRadius:'3px', whiteSpace:'nowrap', display:'none', top:'0', left:'0' });
  document.body.appendChild(dimLabel);

  var linesSvg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  linesSvg.id = '__ct_ruler_lines__';
  linesSvg.setAttribute('xmlns','http://www.w3.org/2000/svg');
  Object.assign(linesSvg.style, { position:'fixed', inset:'0', width:'100%', height:'100%', zIndex:'2147483645', pointerEvents:'none', display:'none' });
  document.body.appendChild(linesSvg);

  var guidesSvg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  guidesSvg.id = '__ct_ruler_guides__';
  guidesSvg.setAttribute('xmlns','http://www.w3.org/2000/svg');
  Object.assign(guidesSvg.style, { position:'fixed', inset:'0', width:'100%', height:'100%', zIndex:'2147483644', pointerEvents:'none', display:'none' });
  document.body.appendChild(guidesSvg);

  var lockedEl = null;
  var lastHover = null;

  function getSpacing(el) {
    var cs = window.getComputedStyle(el);
    return {
      margin:  { top: parseFloat(cs.marginTop)||0,  right: parseFloat(cs.marginRight)||0,  bottom: parseFloat(cs.marginBottom)||0,  left: parseFloat(cs.marginLeft)||0 },
      border:  { top: parseFloat(cs.borderTopWidth)||0, right: parseFloat(cs.borderRightWidth)||0, bottom: parseFloat(cs.borderBottomWidth)||0, left: parseFloat(cs.borderLeftWidth)||0 },
      padding: { top: parseFloat(cs.paddingTop)||0, right: parseFloat(cs.paddingRight)||0, bottom: parseFloat(cs.paddingBottom)||0, left: parseFloat(cs.paddingLeft)||0 }
    };
  }

  function drawBoxModel(el) {
    var r = el.getBoundingClientRect();
    var sp = getSpacing(el);
    var m = sp.margin, b = sp.border, p = sp.padding;

    // Margin layer (outermost)
    var mEl = document.getElementById('__ct_rm__');
    Object.assign(mEl.style, { top:(r.top-m.top)+'px', left:(r.left-m.left)+'px', width:(r.width+m.left+m.right)+'px', height:(r.height+m.top+m.bottom)+'px' });

    // Border layer
    var bEl = document.getElementById('__ct_rb__');
    Object.assign(bEl.style, { top:r.top+'px', left:r.left+'px', width:r.width+'px', height:r.height+'px' });

    // Padding layer
    var pEl = document.getElementById('__ct_rp__');
    Object.assign(pEl.style, { top:(r.top+b.top)+'px', left:(r.left+b.left)+'px', width:(r.width-b.left-b.right)+'px', height:(r.height-b.top-b.bottom)+'px' });

    // Content layer (innermost)
    var cEl = document.getElementById('__ct_rc__');
    Object.assign(cEl.style, { top:(r.top+b.top+p.top)+'px', left:(r.left+b.left+p.left)+'px', width:(r.width-b.left-b.right-p.left-p.right)+'px', height:(r.height-b.top-b.bottom-p.top-p.bottom)+'px' });

    boxmodel.style.display = 'block';

    // Dimension label
    var w = Math.round(r.width), h = Math.round(r.height);
    dimLabel.textContent = w + ' \\u00d7 ' + h;
    var lt = r.left, tt = r.bottom + 4;
    if (tt + 18 > window.innerHeight) tt = r.top - 18;
    dimLabel.style.left = Math.max(0,lt) + 'px';
    dimLabel.style.top = tt + 'px';
    dimLabel.style.display = 'block';
  }

  function makeSvgLine(x1,y1,x2,y2,color,dashed) {
    var line = document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('x1',x1); line.setAttribute('y1',y1);
    line.setAttribute('x2',x2); line.setAttribute('y2',y2);
    line.setAttribute('stroke',color);
    line.setAttribute('stroke-width','1');
    if (dashed) line.setAttribute('stroke-dasharray','4,3');
    return line;
  }

  function makeSvgText(x,y,text,color) {
    var t = document.createElementNS('http://www.w3.org/2000/svg','text');
    t.setAttribute('x',x); t.setAttribute('y',y);
    t.setAttribute('fill',color);
    t.setAttribute('font-size','10');
    t.setAttribute('font-family','monospace');
    t.textContent = text;
    return t;
  }

  function drawMeasurementLines(rA, rB) {
    linesSvg.innerHTML = '';
    linesSvg.style.display = 'block';
    var color = '#ec4899';

    // Vertical distance
    var xMid = Math.round((Math.max(rA.left,rB.left)+Math.min(rA.right,rB.right))/2);
    if (rA.bottom <= rB.top) {
      linesSvg.appendChild(makeSvgLine(xMid,rA.bottom,xMid,rB.top,color,true));
      var dist = Math.round(rB.top - rA.bottom);
      linesSvg.appendChild(makeSvgText(xMid+4, (rA.bottom+rB.top)/2+3, dist+'px', color));
    } else if (rB.bottom <= rA.top) {
      linesSvg.appendChild(makeSvgLine(xMid,rB.bottom,xMid,rA.top,color,true));
      var dist = Math.round(rA.top - rB.bottom);
      linesSvg.appendChild(makeSvgText(xMid+4, (rB.bottom+rA.top)/2+3, dist+'px', color));
    }

    // Horizontal distance
    var yMid = Math.round((Math.max(rA.top,rB.top)+Math.min(rA.bottom,rB.bottom))/2);
    if (rA.right <= rB.left) {
      linesSvg.appendChild(makeSvgLine(rA.right,yMid,rB.left,yMid,color,true));
      var dist = Math.round(rB.left - rA.right);
      linesSvg.appendChild(makeSvgText((rA.right+rB.left)/2-10, yMid-4, dist+'px', color));
    } else if (rB.right <= rA.left) {
      linesSvg.appendChild(makeSvgLine(rB.right,yMid,rA.left,yMid,color,true));
      var dist = Math.round(rA.left - rB.right);
      linesSvg.appendChild(makeSvgText((rB.right+rA.left)/2-10, yMid-4, dist+'px', color));
    }
  }

  function drawAlignmentGuides(rA, rB) {
    guidesSvg.innerHTML = '';
    guidesSvg.style.display = 'block';
    var color = 'rgba(6,182,212,0.6)';
    var W = window.innerWidth, H = window.innerHeight;
    var tol = 1;

    // Top edge alignment
    if (Math.abs(rA.top - rB.top) <= tol) guidesSvg.appendChild(makeSvgLine(0,rA.top,W,rA.top,color,true));
    // Bottom edge alignment
    if (Math.abs(rA.bottom - rB.bottom) <= tol) guidesSvg.appendChild(makeSvgLine(0,rA.bottom,W,rA.bottom,color,true));
    // Left edge alignment
    if (Math.abs(rA.left - rB.left) <= tol) guidesSvg.appendChild(makeSvgLine(rA.left,0,rA.left,H,color,true));
    // Right edge alignment
    if (Math.abs(rA.right - rB.right) <= tol) guidesSvg.appendChild(makeSvgLine(rA.right,0,rA.right,H,color,true));
    // Vertical center alignment
    var cxA = (rA.left+rA.right)/2, cxB = (rB.left+rB.right)/2;
    if (Math.abs(cxA - cxB) <= tol) guidesSvg.appendChild(makeSvgLine(cxA,0,cxA,H,color,true));
    // Horizontal center alignment
    var cyA = (rA.top+rA.bottom)/2, cyB = (rB.top+rB.bottom)/2;
    if (Math.abs(cyA - cyB) <= tol) guidesSvg.appendChild(makeSvgLine(0,cyA,W,cyA,color,true));
  }

  function clearOverlays() {
    boxmodel.style.display = 'none';
    dimLabel.style.display = 'none';
    linesSvg.style.display = 'none';
    linesSvg.innerHTML = '';
    guidesSvg.style.display = 'none';
    guidesSvg.innerHTML = '';
  }

  function getSelector(el) {
    if (el.id) return '#' + el.id;
    var s = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      var c = el.className.trim().split(/\\s+/).filter(Boolean);
      if (c.length) s += '.' + c.join('.');
    }
    return s;
  }

  // Scroll reporting
  var scrollThrottle = null;
  window.addEventListener('scroll', function() {
    if (scrollThrottle) return;
    scrollThrottle = setTimeout(function() {
      scrollThrottle = null;
      console.log('__CT_RULER_SCROLL__:' + JSON.stringify({ scrollX: window.scrollX, scrollY: window.scrollY }));
    }, 16);
  }, { capture: true, signal: s });
  console.log('__CT_RULER_SCROLL__:' + JSON.stringify({ scrollX: window.scrollX, scrollY: window.scrollY }));

  // Block clicks/navigation
  function blockEvent(e) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
  document.addEventListener('click', blockEvent, { capture: true, signal: s });
  document.addEventListener('auxclick', blockEvent, { capture: true, signal: s });
  document.addEventListener('submit', blockEvent, { capture: true, signal: s });
  document.addEventListener('pointerup', blockEvent, { capture: true, signal: s });
  document.addEventListener('mouseup', blockEvent, { capture: true, signal: s });

  // Hover
  document.addEventListener('mousemove', function(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === boxmodel || el === dimLabel || el.closest('#__ct_ruler_boxmodel__')) return;
    if (el === lastHover) return;
    lastHover = el;

    if (lockedEl) {
      // Show distance between locked and hovered element
      var rA = lockedEl.getBoundingClientRect();
      var rB = el.getBoundingClientRect();
      drawMeasurementLines(rA, rB);
      drawAlignmentGuides(rA, rB);
      // Also show box model on hovered element
      drawBoxModel(el);
    } else {
      drawBoxModel(el);
      // Clear measurement lines when not locked
      linesSvg.style.display = 'none';
      linesSvg.innerHTML = '';
      guidesSvg.style.display = 'none';
      guidesSvg.innerHTML = '';
    }
  }, { signal: s });

  // Click: lock/unlock + send data
  document.addEventListener('mousedown', function(e) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === boxmodel || el === dimLabel || el.closest('#__ct_ruler_boxmodel__')) return;

    if (lockedEl === el) {
      // Unlock
      lockedEl = null;
      clearOverlays();
      lastHover = null;
      return;
    }

    lockedEl = el;
    var r = el.getBoundingClientRect();
    var sp = getSpacing(el);
    var cs = window.getComputedStyle(el);
    console.log('__CT_RULER_CLICK__:' + JSON.stringify({
      selector: getSelector(el),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      scroll: { x: window.scrollX, y: window.scrollY },
      spacing: sp,
      computedWidth: cs.width,
      computedHeight: cs.height
    }));
  }, { capture: true, signal: s });

  // Keys
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (lockedEl) {
        lockedEl = null;
        clearOverlays();
        lastHover = null;
      } else {
        console.log('__CT_RULER_CANCEL__');
      }
    }
    if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.altKey && !e.metaKey) {
      console.log('__CT_RULER_TOGGLE__');
    }
  }, { signal: s });
})();`;
}

const RULER_UNINJECT_SCRIPT = `(function() {
  if (window.__CT_RULER_AC__) { window.__CT_RULER_AC__.abort(); delete window.__CT_RULER_AC__; }
  ['__ct_ruler_boxmodel__','__ct_ruler_dim__','__ct_ruler_lines__','__ct_ruler_guides__'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.remove();
  });
  window.__CT_RULER_ACTIVE__ = false;
})();`;

function getViewSwitcherHtml() {
  const previewEnabled = isPreviewEnabled();
  return `
    <div class="wa-shell">
      <div class="wa-tabbar">
        <div class="wa-tabs">
          <button class="wa-tab active" data-view="console">
            ${ICON_CONSOLE}
            <span>${t('webapp.console')}</span>
          </button>
          ${previewEnabled ? `
          <button class="wa-tab" data-view="preview">
            ${ICON_PREVIEW}
            <span>${t('webapp.preview')}</span>
          </button>` : ''}
          <button class="wa-tab" data-view="info">
            ${ICON_INFO}
            <span>${t('webapp.serverInfo')}</span>
          </button>
        </div>
        <div class="wa-tabbar-right">
          <div class="wa-server-status" data-status="stopped">
            <span class="wa-status-pip"></span>
            <span class="wa-status-label"></span>
          </div>
        </div>
      </div>
      <div class="wa-body">
        <div class="webapp-console-view wa-view"></div>
        ${previewEnabled ? `<div class="webapp-preview-view wa-view"></div>` : ''}
        <div class="webapp-info-view wa-view"></div>
      </div>
    </div>
  `;
}

/**
 * Detach the webview from DOM (removes the native surface entirely).
 */
function detachWebview(previewView) {
  if (previewView._inspectHandlers) {
    if (previewView._inspectHandlers.isActive()) {
      previewView._inspectHandlers.deactivate();
    }
  }
  const webview = previewView.querySelector('.webapp-preview-webview');
  if (!webview) return;
  try {
    const currentUrl = webview.getURL();
    detachedWebviews.set(previewView, currentUrl);
  } catch (e) {
    detachedWebviews.delete(previewView);
  }
  webview.remove();
}

/**
 * Re-attach the webview to the browser container.
 */
function attachWebview(previewView) {
  const savedUrl = detachedWebviews.get(previewView);
  if (!savedUrl || savedUrl === 'about:blank') return;
  const frame = previewView.querySelector('.wa-responsive-frame') || previewView.querySelector('.wa-browser-viewport');
  if (!frame) return;
  const webview = document.createElement('webview');
  webview.className = 'webapp-preview-webview';
  webview.setAttribute('src', savedUrl);
  webview.setAttribute('disableblinkfeatures', 'Auxclick');
  frame.insertBefore(webview, frame.firstChild);
  wireWebviewEvents(previewView, webview);
  detachedWebviews.delete(previewView);
}

/**
 * Wire up webview events (navigation, console, etc.)
 */
function wireWebviewEvents(previewView, webview) {
  const addrPath = previewView.querySelector('.wa-addr-path');
  const addrPort = previewView.querySelector('.wa-addr-port');

  webview.addEventListener('did-navigate', (e) => {
    let newPath = '/';
    try {
      const u = new URL(e.url);
      if (addrPort) addrPort.textContent = u.port ? `:${u.port}` : '';
      newPath = u.pathname + u.search;
      if (addrPath) addrPath.textContent = newPath !== '/' ? newPath : '';
    } catch (err) {}
    // Switch pins to the new page
    previewView._inspectHandlers?.switchPage?.(newPath);
    // Re-inject scripts after navigation if active
    setTimeout(() => {
      if (!webview.isConnected) return;
      try { webview.executeJavaScript(KEY_LISTEN_SCRIPT); } catch (e) {}
      if (previewView._inspectHandlers?.isActive()) {
        // Determine which mode is active and re-inject appropriately
        try { webview.executeJavaScript(getInspectInjectScript()); } catch (e) {}
      }
    }, 300);
  });
  webview.addEventListener('did-navigate-in-page', (e) => {
    try {
      const u = new URL(e.url);
      const newPath = u.pathname + u.search;
      if (addrPath) addrPath.textContent = newPath !== '/' ? newPath : '';
      // Switch pins for SPA navigation (React, Vue, Next.js, etc.)
      previewView._inspectHandlers?.switchPage?.(newPath);
    } catch (err) {}
  });

  webview.addEventListener('console-message', (e) => {
    // Intercept inspect protocol messages
    if (typeof e.message === 'string') {
      if (e.message.startsWith('__CT_INSPECT__:')) {
        try {
          const data = JSON.parse(e.message.slice('__CT_INSPECT__:'.length));
          previewView._inspectHandlers?.handleCapture(data);
        } catch (err) {}
        return;
      }
      if (e.message.startsWith('__CT_INSPECT_SCROLL__:')) {
        try {
          const scroll = JSON.parse(e.message.slice('__CT_INSPECT_SCROLL__:'.length));
          previewView._inspectHandlers?.handleScroll(scroll);
        } catch (err) {}
        return;
      }
      if (e.message === '__CT_INSPECT_CANCEL__') {
        previewView._inspectHandlers?.handleEscape();
        return;
      }
      if (e.message === '__CT_INSPECT_TOGGLE__') {
        previewView._inspectHandlers?.toggle();
        return;
      }
      if (e.message.startsWith('__CT_SCAN__:')) {
        try {
          const data = JSON.parse(e.message.slice('__CT_SCAN__:'.length));
          previewView._inspectHandlers?.handleScanResults(data);
        } catch (err) {}
        return;
      }
      if (e.message.startsWith('__CT_RULER_CLICK__:')) {
        try {
          const data = JSON.parse(e.message.slice('__CT_RULER_CLICK__:'.length));
          previewView._inspectHandlers?.handleRulerClick(data);
        } catch (err) {}
        return;
      }
      if (e.message.startsWith('__CT_RULER_SCROLL__:')) {
        try {
          const scroll = JSON.parse(e.message.slice('__CT_RULER_SCROLL__:'.length));
          previewView._inspectHandlers?.handleScroll(scroll);
        } catch (err) {}
        return;
      }
      if (e.message === '__CT_RULER_CANCEL__') {
        previewView._inspectHandlers?.handleRulerEscape();
        return;
      }
      if (e.message === '__CT_RULER_TOGGLE__') {
        previewView._inspectHandlers?.toggleRuler();
        return;
      }
    }
    if (e.level >= 2) {
      if (!previewView._consoleLogs) previewView._consoleLogs = [];
      previewView._consoleLogs.push({ level: e.level, message: e.message, source: e.sourceId, line: e.line });
      if (previewView._consoleLogs.length > 100) previewView._consoleLogs.shift();
    }
  });
}

function setupViewSwitcher(wrapper, terminalId, projectIndex, project, deps) {
  const { t, getTerminal } = deps;
  const consoleView  = wrapper.querySelector('.webapp-console-view');
  const previewView  = wrapper.querySelector('.webapp-preview-view');
  const infoView     = wrapper.querySelector('.webapp-info-view');
  const statusEl     = wrapper.querySelector('.wa-server-status');
  const statusLabel  = wrapper.querySelector('.wa-status-label');

  const STATUS_LABELS = { stopped: '', starting: t('webapp.statusStarting'), running: t('webapp.statusRunning') };

  function refreshStatus() {
    const s = getWebAppServer(projectIndex);
    const st = s.status || 'stopped';
    if (statusEl) statusEl.dataset.status = st;
    if (statusLabel) statusLabel.textContent = STATUS_LABELS[st] || '';
  }
  refreshStatus();
  const pipInterval = setInterval(refreshStatus, 2000);
  wrapper._waPipInterval = pipInterval;

  function switchView(view) {
    const panes = [consoleView, previewView, infoView].filter(Boolean);

    wrapper.querySelectorAll('.wa-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.view === view);
    });

    panes.forEach(p => p.classList.remove('wa-view-active'));

    if (view === 'console') {
      consoleView.classList.add('wa-view-active');
      const termData = getTerminal(terminalId);
      if (termData) setTimeout(() => termData.fitAddon.fit(), 50);
    } else if (view === 'preview' && previewView) {
      previewView.classList.add('wa-view-active');
      renderPreviewView(wrapper, projectIndex, project, deps);
    } else if (view === 'info') {
      infoView.classList.add('wa-view-active');
      renderInfoView(wrapper, projectIndex, project, deps);
    }

    // Detach webview when leaving preview tab
    if (view !== 'preview' && previewView) {
      detachWebview(previewView);
    }

    const termData = getTerminal(terminalId);
    if (termData) termData.activeView = view;
  }

  // Watch for terminal tab switches (wrapper gains/loses .active class).
  // When our wrapper becomes inactive, detach the webview.
  const observer = new MutationObserver(() => {
    if (!wrapper.classList.contains('active') && previewView) {
      detachWebview(previewView);
    } else if (wrapper.classList.contains('active') && previewView && previewView.classList.contains('wa-view-active')) {
      if (detachedWebviews.has(previewView)) {
        attachWebview(previewView);
      }
    }
  });
  observer.observe(wrapper, { attributes: true, attributeFilter: ['class'] });
  wrapper._waClassObserver = observer;

  // Initial state: show console
  switchView('console');

  wrapper.querySelectorAll('.wa-tab').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
}

async function renderPreviewView(wrapper, projectIndex, project, deps) {
  const { t } = deps;
  const previewView = wrapper.querySelector('.webapp-preview-view');
  if (!previewView) return;

  const port = await resolvePort(projectIndex);
  const server = getWebAppServer(projectIndex);

  if (!port) {
    if (previewView.dataset.loadedPort) delete previewView.dataset.loadedPort;

    const isStopped = server.status === 'stopped';
    previewView.innerHTML = `
      <div class="wa-empty ${isStopped ? 'is-stopped' : 'is-loading'}">
        <div class="wa-empty-visual">
          ${isStopped
            ? `<svg viewBox="0 0 48 48" fill="none" width="40" height="40"><rect x="3" y="7" width="42" height="30" rx="4" stroke="currentColor" stroke-width="1" opacity=".15"/><path d="M3 14h42" stroke="currentColor" stroke-width="1" opacity=".15"/><rect x="18" y="37" width="12" height="4" rx="1.5" fill="currentColor" opacity=".07"/><path d="M13 43h22" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".07"/><circle cx="9" cy="10.5" r="1.2" fill="currentColor" opacity=".18"/><circle cx="14" cy="10.5" r="1.2" fill="currentColor" opacity=".12"/><circle cx="19" cy="10.5" r="1.2" fill="currentColor" opacity=".08"/></svg>`
            : `<svg viewBox="0 0 48 48" fill="none" width="38" height="38" class="wa-spin-slow"><circle cx="24" cy="24" r="19" stroke="currentColor" stroke-width="1" opacity=".07"/><path d="M24 5a19 19 0 0116 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".5"/><path d="M24 11a13 13 0 0110 6" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity=".2"/></svg>`
          }
        </div>
        <div class="wa-empty-body">
          <p class="wa-empty-title">${isStopped ? t('webapp.noServerRunning') : t('webapp.startingUp')}</p>
          <p class="wa-empty-sub">${isStopped ? t('webapp.startDevServerHint') : t('webapp.waitingPort')}</p>
        </div>
      </div>
    `;

    if (!isStopped) {
      startPortPoll(wrapper, projectIndex, () => {
        renderPreviewView(wrapper, projectIndex, project, deps);
      });
    }
    return;
  }

  clearPollTimer(wrapper);
  const url = `http://localhost:${port}`;

  // If webview already exists for this port, skip
  const existingWebview = previewView.querySelector('.webapp-preview-webview');
  if (existingWebview && previewView.dataset.loadedPort === String(port)) {
    return;
  }
  // If detached for this port, re-attach
  if (!existingWebview && detachedWebviews.has(previewView) && previewView.dataset.loadedPort === String(port)) {
    attachWebview(previewView);
    return;
  }

  previewView.dataset.loadedPort = String(port);
  previewView.innerHTML = `
    <div class="wa-browser">
      <div class="wa-browser-bar">
        <div class="wa-browser-nav">
          <button class="wa-browser-btn wa-back" title="Back">${ICON_BACK}</button>
          <button class="wa-browser-btn wa-fwd" title="Forward">${ICON_FWD}</button>
          <button class="wa-browser-btn wa-reload" title="Reload">${ICON_RELOAD}</button>
        </div>
        <div class="wa-address-bar">
          <span class="wa-addr-scheme">http://</span><span class="wa-addr-host">localhost</span><span class="wa-addr-port">:${port}</span><span class="wa-addr-path"></span>
        </div>
        <div class="wa-responsive-group">
          <button class="wa-responsive-btn active" data-width="0" title="${t('webapp.responsive.full')}">${ICON_RESPONSIVE_FULL}</button>
          <div class="wa-responsive-sep"></div>
          <button class="wa-responsive-btn" data-width="375" title="${t('webapp.responsive.mobile')} (375px)">${ICON_RESPONSIVE_MOBILE}<span class="wa-responsive-label">375</span></button>
          <button class="wa-responsive-btn" data-width="768" title="${t('webapp.responsive.tablet')} (768px)">${ICON_RESPONSIVE_TABLET}<span class="wa-responsive-label">768</span></button>
          <button class="wa-responsive-btn" data-width="1024" title="${t('webapp.responsive.laptop')} (1024px)">${ICON_RESPONSIVE_LAPTOP}<span class="wa-responsive-label">1024</span></button>
          <button class="wa-responsive-btn" data-width="1440" title="${t('webapp.responsive.desktop')} (1440px)">${ICON_RESPONSIVE_DESKTOP}<span class="wa-responsive-label">1440</span></button>
        </div>
        <button class="wa-browser-btn wa-scan" title="${t('webapp.scan.title')}">${ICON_SCAN}<span class="wa-scan-count"></span></button>
        <button class="wa-browser-btn wa-ruler" title="${t('webapp.ruler.title')} (R)">${ICON_RULER}<span class="wa-ruler-count"></span></button>
        <button class="wa-browser-btn wa-inspect" title="${t('webapp.inspect')} (I)">${ICON_INSPECT}<span class="wa-inspect-count"></span></button>
        <button class="wa-send-all">${t('webapp.sendToClaude')}</button>
        <button class="wa-browser-btn wa-open-ext" title="${t('webapp.openBrowser')}">${ICON_OPEN}</button>
      </div>
      <div class="wa-scan-filters"></div>
      <div class="wa-browser-viewport">
        <div class="wa-responsive-frame">
          <webview class="webapp-preview-webview" src="${url}" disableblinkfeatures="Auxclick"></webview>
          <div class="wa-pins-overlay"></div>
        </div>
      </div>
      <div class="wa-responsive-indicator"></div>
    </div>
  `;

  // Store project & deps on previewView for inspect handlers
  previewView._project = project;
  previewView._deps = deps;

  const webview = previewView.querySelector('.webapp-preview-webview');
  wireWebviewEvents(previewView, webview);

  // Inject key listener immediately (webview may already be loaded)
  try { webview.executeJavaScript(KEY_LISTEN_SCRIPT); } catch (e) {}

  // ── Inspect mode with multi-annotation pins (per-page) ──
  let inspectActive = false;
  // Per-page annotation storage: pathname → { annotations[], scroll }
  const pageAnnotations = new Map();
  let currentPagePath = '/';
  let nextPinId = 1;
  // Track webview scroll position for pin offset calculation
  let currentScroll = { x: 0, y: 0 };

  // Auto-scan state (transient, cleared on re-scan/navigation)
  let autoAnnotations = [];
  let nextAutoPinId = 1000;
  let scanActive = false;
  let scanFilterHidden = new Set(); // issue types currently hidden by filter

  // Ruler state (transient)
  let rulerActive = false;
  let rulerLockedElement = null;
  let rulerAnnotations = [];
  let nextRulerPinId = 2000;

  const inspectBtn = previewView.querySelector('.wa-inspect');
  const badgeEl = previewView.querySelector('.wa-inspect-count');
  const sendAllBtn = previewView.querySelector('.wa-send-all');
  const scanBtn = previewView.querySelector('.wa-scan');
  const scanBadge = previewView.querySelector('.wa-scan-count');
  const rulerBtn = previewView.querySelector('.wa-ruler');
  const rulerBadge = previewView.querySelector('.wa-ruler-count');
  const overlay = previewView.querySelector('.wa-pins-overlay');
  const scanFiltersEl = previewView.querySelector('.wa-scan-filters');

  /** Get annotations for the current page */
  function getPageAnns() {
    if (!pageAnnotations.has(currentPagePath)) {
      pageAnnotations.set(currentPagePath, { annotations: [], scroll: { x: 0, y: 0 } });
    }
    return pageAnnotations.get(currentPagePath);
  }

  /** Count total annotations across all pages */
  function getTotalCount() {
    let total = 0;
    for (const page of pageAnnotations.values()) total += page.annotations.length;
    return total;
  }

  /** Get all annotations flattened with their page path (user + auto-detected + ruler) */
  function getAllAnnotations() {
    const all = [];
    for (const [path, page] of pageAnnotations) {
      for (const ann of page.annotations) all.push({ ...ann, pagePath: path });
    }
    for (const ann of autoAnnotations) {
      all.push({ ...ann, pagePath: currentPagePath, isAutoDetected: true });
    }
    for (const ann of rulerAnnotations) {
      all.push({ ...ann, pagePath: currentPagePath, isRulerAnnotation: true });
    }
    return all;
  }

  function updateBadge() {
    const userCount = getTotalCount();
    const totalCount = userCount + autoAnnotations.length + rulerAnnotations.length;
    if (userCount > 0) {
      badgeEl.textContent = userCount;
      badgeEl.classList.add('visible');
    } else {
      badgeEl.classList.remove('visible');
    }
    if (totalCount > 0) {
      sendAllBtn.textContent = `${t('webapp.sendAll').replace('{count}', totalCount)}`;
      sendAllBtn.classList.add('visible');
    } else {
      sendAllBtn.classList.remove('visible');
    }
  }

  function updateRulerBadge() {
    const count = rulerAnnotations.length;
    if (count > 0) {
      rulerBadge.textContent = count;
      rulerBadge.classList.add('visible');
    } else {
      rulerBadge.textContent = '';
      rulerBadge.classList.remove('visible');
    }
  }

  function updateScanBadge() {
    const count = autoAnnotations.length;
    if (count > 0) {
      scanBadge.textContent = count;
      scanBadge.classList.add('visible');
    } else {
      scanBadge.textContent = '';
      scanBadge.classList.remove('visible');
    }
  }

  /** Build scan filter bar from current autoAnnotations */
  function buildScanFilters() {
    if (!scanFiltersEl) return;
    // Count issues by type
    const counts = {};
    for (const ann of autoAnnotations) {
      counts[ann.issueType] = (counts[ann.issueType] || 0) + 1;
    }
    const types = Object.keys(counts);
    if (types.length === 0) {
      scanFiltersEl.innerHTML = '';
      scanFiltersEl.classList.remove('visible');
      return;
    }

    const typeLabels = {
      'overflow': t('webapp.scan.types.overflow'),
      'contrast': t('webapp.scan.types.contrast'),
      'broken-image': t('webapp.scan.types.brokenImage'),
      'z-index': t('webapp.scan.types.zIndex'),
      'aria': t('webapp.scan.types.aria'),
      'alt-text': t('webapp.scan.types.altText'),
      'keyboard': t('webapp.scan.types.keyboard'),
      'structure': t('webapp.scan.types.structure'),
      'a11y': t('webapp.scan.types.a11y')
    };

    // Sort by count descending
    types.sort((a, b) => counts[b] - counts[a]);

    let html = '';
    for (const type of types) {
      const active = !scanFilterHidden.has(type);
      html += `<button class="wa-scan-filter-chip ${active ? 'active' : ''}" data-filter-type="${type}">
        <span class="wa-scan-filter-dot" data-type="${type}"></span>
        ${typeLabels[type] || type} <span class="wa-scan-filter-count">${counts[type]}</span>
      </button>`;
    }
    scanFiltersEl.innerHTML = html;
    scanFiltersEl.classList.add('visible');

    // Wire click handlers
    for (const chip of scanFiltersEl.querySelectorAll('.wa-scan-filter-chip')) {
      chip.onclick = () => {
        const type = chip.dataset.filterType;
        if (scanFilterHidden.has(type)) {
          scanFilterHidden.delete(type);
          chip.classList.add('active');
        } else {
          scanFilterHidden.add(type);
          chip.classList.remove('active');
        }
        applyScanFilter();
      };
    }
  }

  /** Show/hide auto pins based on active filters */
  function applyScanFilter() {
    for (const ann of autoAnnotations) {
      const pinEl = overlay.querySelector(`.wa-pin-auto[data-pin-id="${ann.id}"]`);
      if (!pinEl) continue;
      pinEl.style.display = scanFilterHidden.has(ann.issueType) ? 'none' : '';
    }
    // Update scan badge with visible count only
    const visibleCount = autoAnnotations.filter(a => !scanFilterHidden.has(a.issueType)).length;
    if (visibleCount > 0) {
      scanBadge.textContent = visibleCount;
      scanBadge.classList.add('visible');
    } else {
      scanBadge.textContent = '';
      scanBadge.classList.remove('visible');
    }
    updateBadge();
  }

  function clearScanFilters() {
    scanFilterHidden.clear();
    if (scanFiltersEl) {
      scanFiltersEl.innerHTML = '';
      scanFiltersEl.classList.remove('visible');
    }
  }

  function closePopover() {
    const pop = overlay.querySelector('.wa-pin-popover');
    if (pop) pop.remove();
  }

  /**
   * Convert document-absolute coords to current viewport-relative coords
   * by subtracting the current webview scroll position.
   */
  function absToViewport(absX, absY) {
    return { x: absX - currentScroll.x, y: absY - currentScroll.y };
  }

  /** Reposition all pins and popover based on current scroll (current page only) */
  function repositionAllPins() {
    const page = getPageAnns();
    for (const ann of page.annotations) {
      const pinEl = overlay.querySelector(`.wa-pin[data-pin-id="${ann.id}"]`);
      if (!pinEl) continue;
      const abs = ann.elementData.absRect;
      const vp = absToViewport(abs.x + abs.width / 2 - 11, abs.y + abs.height / 2 - 11);
      pinEl.style.top = vp.y + 'px';
      pinEl.style.left = vp.x + 'px';
    }
    // Also reposition auto-detected pins
    for (const ann of autoAnnotations) {
      const pinEl = overlay.querySelector(`.wa-pin-auto[data-pin-id="${ann.id}"]`);
      if (!pinEl) continue;
      const abs = ann.elementData.absRect;
      const vp = absToViewport(abs.x + abs.width / 2 - 11, abs.y + abs.height / 2 - 11);
      pinEl.style.top = vp.y + 'px';
      pinEl.style.left = vp.x + 'px';
    }
    // Also reposition ruler pins
    for (const ann of rulerAnnotations) {
      const pinEl = overlay.querySelector(`.wa-pin-ruler[data-pin-id="${ann.id}"]`);
      if (!pinEl) continue;
      const abs = ann.elementData.absRect;
      const vp = absToViewport(abs.x + abs.width / 2 - 11, abs.y + abs.height / 2 - 11);
      pinEl.style.top = vp.y + 'px';
      pinEl.style.left = vp.x + 'px';
    }
    // Reposition popover if open
    const pop = overlay.querySelector('.wa-pin-popover');
    if (pop && pop._absRect) {
      const preferredW = pop.classList.contains('wa-pin-popover-ruler') ? 300 : 280;
      positionPopover(pop, pop._absRect, preferredW);
    }
  }

  /** Position a popover element relative to an absRect, adapting to overlay size */
  function positionPopover(pop, absRect, preferredW) {
    const overlayW = overlay.offsetWidth || 400;
    const popW = Math.min(preferredW, overlayW - 8);
    pop.style.width = popW + 'px';
    const vpPos = absToViewport(absRect.x, absRect.y);
    // Use actual height if rendered, otherwise estimate
    const popH = pop.offsetHeight || 120;
    let top = vpPos.y - popH - 8;
    let left = vpPos.x;
    if (top < 4) top = vpPos.y + absRect.height + 8;
    if (left + popW > overlayW - 4) left = overlayW - popW - 4;
    if (left < 4) left = 4;
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
  }

  function showPopover(elementData, existingAnnotation) {
    closePopover();

    const pop = document.createElement('div');
    pop.className = 'wa-pin-popover';

    pop.innerHTML = `
      <div class="wa-popover-header">
        <span class="wa-popover-selector">${escapeAttr(elementData.selector)}</span>
        <button class="wa-popover-close" title="Close">&times;</button>
      </div>
      <textarea class="wa-popover-input" rows="1" placeholder="${t('webapp.pinPlaceholder')}">${existingAnnotation ? escapeAttr(existingAnnotation.instruction) : ''}</textarea>
      <div class="wa-popover-actions">
        ${existingAnnotation ? `<button class="wa-popover-delete">${t('webapp.deletePin')}</button>` : ''}
        <button class="wa-popover-ok">${existingAnnotation ? 'Update' : 'OK'}</button>
      </div>
    `;

    // Store absRect on popover for repositioning on scroll
    const absRect = elementData.absRect || elementData.rect;
    pop._absRect = absRect;

    overlay.appendChild(pop);
    positionPopover(pop, absRect, 280);

    const textarea = pop.querySelector('.wa-popover-input');
    const okBtn = pop.querySelector('.wa-popover-ok');
    const closeBtn = pop.querySelector('.wa-popover-close');
    const delBtn = pop.querySelector('.wa-popover-delete');

    const dismissPopover = () => {
      closePopover();
      const wv = previewView.querySelector('.webapp-preview-webview');
      if (wv && inspectActive) {
        try { wv.executeJavaScript(getInspectInjectScript()); } catch (e) {}
      }
    };

    // Auto-resize
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 80) + 'px';
    });

    const confirm = () => {
      const instruction = textarea.value.trim();
      if (!instruction) return;
      closePopover();

      if (existingAnnotation) {
        existingAnnotation.instruction = instruction;
      } else {
        const ann = { id: nextPinId++, elementData, instruction, viewportWidth: currentBreakpoint || 0 };
        getPageAnns().annotations.push(ann);
        addPin(ann);
        updateBadge();
      }

      const wv = previewView.querySelector('.webapp-preview-webview');
      if (wv && inspectActive) {
        try { wv.executeJavaScript(getInspectInjectScript()); } catch (e) {}
      }
    };

    // Close button → just dismiss popover (no delete)
    closeBtn.onclick = dismissPopover;

    okBtn.onclick = confirm;
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        confirm();
      }
      if (e.key === 'Escape') {
        dismissPopover();
      }
    });

    // Delete button → remove the annotation + pin
    if (delBtn) {
      delBtn.onclick = () => {
        closePopover();
        if (existingAnnotation) {
          removePin(existingAnnotation.id);
        }
        const wv = previewView.querySelector('.webapp-preview-webview');
        if (wv && inspectActive) {
          try { wv.executeJavaScript(getInspectInjectScript()); } catch (e) {}
        }
      };
    }

    setTimeout(() => textarea.focus(), 50);
  }

  function addPin(annotation) {
    const abs = annotation.elementData.absRect;
    const pin = document.createElement('div');
    pin.className = 'wa-pin';
    pin.dataset.pinId = annotation.id;
    pin.dataset.viewport = annotation.viewportWidth || 0;
    pin.textContent = annotation.id;
    const vp = absToViewport(abs.x + abs.width / 2 - 11, abs.y + abs.height / 2 - 11);
    pin.style.top = vp.y + 'px';
    pin.style.left = vp.x + 'px';
    pin.onclick = (e) => {
      e.stopPropagation();
      showPopover(annotation.elementData, annotation);
    };
    overlay.appendChild(pin);
  }

  function removePin(annotationId) {
    // Search in all pages
    for (const page of pageAnnotations.values()) {
      const idx = page.annotations.findIndex(a => a.id === annotationId);
      if (idx !== -1) { page.annotations.splice(idx, 1); break; }
    }
    const pinEl = overlay.querySelector(`.wa-pin[data-pin-id="${annotationId}"]`);
    if (pinEl) pinEl.remove();
    updateBadge();
  }

  function clearAllPins() {
    pageAnnotations.clear();
    nextPinId = 1;
    currentScroll = { x: 0, y: 0 };
    clearAutoAnnotations();
    clearRulerAnnotations();
    overlay.querySelectorAll('.wa-pin, .wa-pin-auto, .wa-pin-ruler, .wa-pin-popover').forEach(el => el.remove());
    updateBadge();
  }

  /** Remove pin DOM elements (keep data in memory) */
  function hidePins() {
    overlay.querySelectorAll('.wa-pin, .wa-pin-auto, .wa-pin-ruler, .wa-pin-popover').forEach(el => el.remove());
  }

  /** Re-create pin DOM elements for the current page from stored data */
  function showPins() {
    // Clear existing pin DOM first to avoid duplicates
    overlay.querySelectorAll('.wa-pin, .wa-pin-auto, .wa-pin-ruler').forEach(el => el.remove());
    const page = pageAnnotations.get(currentPagePath);
    if (page) {
      for (const ann of page.annotations) addPin(ann);
    }
    for (const ann of autoAnnotations) addAutoPin(ann);
    for (const ann of rulerAnnotations) addRulerPin(ann);
    // Dim pins from other viewports if responsive checker is active
    if (previewView._updatePinViewportStyles) previewView._updatePinViewportStyles();
  }

  // ── Auto-scan pin functions ──────────────────────────────────────────

  function clearAutoAnnotations() {
    autoAnnotations = [];
    nextAutoPinId = 1000;
    overlay.querySelectorAll('.wa-pin-auto').forEach(el => el.remove());
    updateScanBadge();
    clearScanFilters();
  }

  function addAutoPin(annotation) {
    const abs = annotation.elementData.absRect;
    const pin = document.createElement('div');
    pin.className = 'wa-pin wa-pin-auto';
    pin.dataset.pinId = annotation.id;
    pin.dataset.pinType = annotation.issueType;
    pin.dataset.viewport = annotation.viewportWidth || 0;
    const icons = { 'overflow': '\u2194', 'contrast': 'Aa', 'broken-image': '\u2298', 'z-index': 'Z', 'aria': 'A', 'alt-text': '\u{1F5BC}', 'keyboard': '\u2328', 'structure': '\u00A7', 'a11y': '\u267F' };
    pin.textContent = icons[annotation.issueType] || '!';
    const vp = absToViewport(abs.x + abs.width / 2 - 11, abs.y + abs.height / 2 - 11);
    pin.style.top = vp.y + 'px';
    pin.style.left = vp.x + 'px';
    pin.onclick = (e) => {
      e.stopPropagation();
      showAutoPopover(annotation);
    };
    overlay.appendChild(pin);
  }

  function showAutoPopover(annotation) {
    closePopover();
    const ed = annotation.elementData;
    const pop = document.createElement('div');
    pop.className = 'wa-pin-popover wa-pin-popover-auto';

    const typeLabels = {
      'overflow': t('webapp.scan.types.overflow'),
      'contrast': t('webapp.scan.types.contrast'),
      'broken-image': t('webapp.scan.types.brokenImage'),
      'z-index': t('webapp.scan.types.zIndex'),
      'aria': t('webapp.scan.types.aria'),
      'alt-text': t('webapp.scan.types.altText'),
      'keyboard': t('webapp.scan.types.keyboard'),
      'structure': t('webapp.scan.types.structure'),
      'a11y': t('webapp.scan.types.a11y')
    };

    const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    pop.innerHTML = `
      <div class="wa-popover-header">
        <span class="wa-scan-type-badge" data-type="${annotation.issueType}">${typeLabels[annotation.issueType] || annotation.issueType}</span>
        <span class="wa-popover-selector">${escAttr(ed.selector)}</span>
        <button class="wa-popover-close" title="Close">&times;</button>
      </div>
      <div class="wa-scan-description">${escAttr(annotation.description)}</div>
      <textarea class="wa-popover-input" rows="1" placeholder="${t('webapp.scan.customInstruction')}">${escAttr(annotation.instruction)}</textarea>
      <div class="wa-popover-actions">
        <button class="wa-popover-delete">${t('webapp.scan.dismiss')}</button>
        <button class="wa-popover-ok">${annotation._customized ? 'Update' : 'OK'}</button>
      </div>
    `;

    const absRect = ed.absRect || ed.rect;
    pop._absRect = absRect;
    overlay.appendChild(pop);
    positionPopover(pop, absRect, 280);

    const textarea = pop.querySelector('.wa-popover-input');
    const okBtn = pop.querySelector('.wa-popover-ok');
    const closeBtn = pop.querySelector('.wa-popover-close');
    const delBtn = pop.querySelector('.wa-popover-delete');

    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 80) + 'px';
    });

    closeBtn.onclick = () => closePopover();
    delBtn.onclick = () => {
      autoAnnotations = autoAnnotations.filter(a => a.id !== annotation.id);
      overlay.querySelector(`.wa-pin-auto[data-pin-id="${annotation.id}"]`)?.remove();
      closePopover();
      updateScanBadge();
      updateBadge();
    };
    okBtn.onclick = () => {
      const val = textarea.value.trim();
      if (val) { annotation.instruction = val; annotation._customized = true; }
      closePopover();
    };
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); okBtn.onclick(); }
      if (e.key === 'Escape') closePopover();
    });
    setTimeout(() => textarea.focus(), 50);
  }

  function handleScanResults(results) {
    scanActive = false;
    scanBtn?.classList.remove('scanning');

    if (!results || results.length === 0) {
      scanBtn?.classList.add('scan-clear');
      setTimeout(() => scanBtn?.classList.remove('scan-clear'), 2000);
      return;
    }

    // Ensure scroll listener for pin positioning
    const wv = previewView.querySelector('.webapp-preview-webview');
    if (wv) {
      try { wv.executeJavaScript(SCROLL_LISTEN_SCRIPT); } catch (e) {}
    }

    const instructions = {
      'overflow': (d) => `Fix overflow: ${d}. Ensure content fits within its container.`,
      'contrast': (d) => `Fix contrast: ${d}. Adjust text or background color to meet WCAG AA.`,
      'broken-image': (d) => `Fix broken image: ${d}. Verify the image path and ensure it loads.`,
      'z-index': (d) => `Fix z-index issue: ${d}. Review stacking context.`,
      'aria': (d) => `Fix ARIA issue: ${d}. Ensure correct ARIA roles and attributes.`,
      'alt-text': (d) => `Fix missing alt text: ${d}. Add a descriptive alt attribute.`,
      'keyboard': (d) => `Fix keyboard accessibility: ${d}. Ensure element is focusable and operable via keyboard.`,
      'structure': (d) => `Fix document structure: ${d}. Review heading hierarchy and landmark regions.`,
      'a11y': (d) => `Fix accessibility issue: ${d}.`
    };

    for (const result of results) {
      const scroll = result.scroll || { x: 0, y: 0 };
      const absRect = {
        x: result.rect.x + scroll.x, y: result.rect.y + scroll.y,
        width: result.rect.width, height: result.rect.height
      };
      const ann = {
        id: nextAutoPinId++,
        issueType: result.type,
        description: result.description,
        elementData: {
          tagName: result.tagName, id: result.id, className: result.className,
          selector: result.selector, text: result.text,
          rect: result.rect, absRect,
          capturedAtViewport: currentBreakpoint || 0
        },
        instruction: (instructions[result.type] || ((d) => d))(result.description),
        viewportWidth: currentBreakpoint || 0,
        isAutoDetected: true
      };
      autoAnnotations.push(ann);
      addAutoPin(ann);
    }

    updateScanBadge();
    updateBadge();
    buildScanFilters();
    scanBtn?.classList.add('scan-found');
    setTimeout(() => scanBtn?.classList.remove('scan-found'), 2000);
  }

  // ── Ruler pin functions ──────────────────────────────────────────

  function clearRulerAnnotations() {
    rulerAnnotations = [];
    nextRulerPinId = 2000;
    rulerLockedElement = null;
    overlay.querySelectorAll('.wa-pin-ruler').forEach(el => el.remove());
    updateRulerBadge();
  }

  function addRulerPin(annotation) {
    const abs = annotation.elementData.absRect;
    const pin = document.createElement('div');
    pin.className = 'wa-pin wa-pin-ruler';
    pin.dataset.pinId = annotation.id;
    pin.dataset.viewport = annotation.viewportWidth || 0;
    pin.textContent = '\ud83d\udccf';
    const vp = absToViewport(abs.x + abs.width / 2 - 11, abs.y + abs.height / 2 - 11);
    pin.style.top = vp.y + 'px';
    pin.style.left = vp.x + 'px';
    pin.onclick = (e) => {
      e.stopPropagation();
      showRulerPopover(annotation);
    };
    overlay.appendChild(pin);
  }

  function showRulerPopover(annotation) {
    closePopover();
    const ed = annotation.elementData;
    const sp = annotation.spacing;
    const pop = document.createElement('div');
    pop.className = 'wa-pin-popover wa-pin-popover-ruler';

    const fmtVal = (v) => Math.round(v) + 'px';
    const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    pop.innerHTML = `
      <div class="wa-popover-header">
        <span class="wa-popover-selector">${escAttr(ed.selector)}</span>
        <span class="wa-ruler-dim">${annotation.computedWidth} \u00d7 ${annotation.computedHeight}</span>
        <button class="wa-popover-close" title="Close">&times;</button>
      </div>
      <div class="wa-ruler-boxmodel-mini">
        <div class="wa-ruler-row margin"><span class="wa-ruler-label">${t('webapp.ruler.margin')}</span><span class="wa-ruler-val">${fmtVal(sp.margin.top)}</span><span class="wa-ruler-val">${fmtVal(sp.margin.right)}</span><span class="wa-ruler-val">${fmtVal(sp.margin.bottom)}</span><span class="wa-ruler-val">${fmtVal(sp.margin.left)}</span></div>
        <div class="wa-ruler-row border"><span class="wa-ruler-label">${t('webapp.ruler.border')}</span><span class="wa-ruler-val">${fmtVal(sp.border.top)}</span><span class="wa-ruler-val">${fmtVal(sp.border.right)}</span><span class="wa-ruler-val">${fmtVal(sp.border.bottom)}</span><span class="wa-ruler-val">${fmtVal(sp.border.left)}</span></div>
        <div class="wa-ruler-row padding"><span class="wa-ruler-label">${t('webapp.ruler.padding')}</span><span class="wa-ruler-val">${fmtVal(sp.padding.top)}</span><span class="wa-ruler-val">${fmtVal(sp.padding.right)}</span><span class="wa-ruler-val">${fmtVal(sp.padding.bottom)}</span><span class="wa-ruler-val">${fmtVal(sp.padding.left)}</span></div>
      </div>
      <textarea class="wa-popover-input" rows="1" placeholder="${t('webapp.ruler.pinPlaceholder')}">${escAttr(annotation.instruction || '')}</textarea>
      <div class="wa-popover-actions">
        ${annotation._saved ? `<button class="wa-popover-delete">${t('webapp.deletePin')}</button>` : ''}
        <button class="wa-popover-ok">${annotation._saved ? 'Update' : 'OK'}</button>
      </div>
    `;

    const absRect = ed.absRect || ed.rect;
    pop._absRect = absRect;
    overlay.appendChild(pop);
    positionPopover(pop, absRect, 300);

    const textarea = pop.querySelector('.wa-popover-input');
    const okBtn = pop.querySelector('.wa-popover-ok');
    const closeBtn = pop.querySelector('.wa-popover-close');
    const delBtn = pop.querySelector('.wa-popover-delete');

    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 80) + 'px';
    });

    closeBtn.onclick = () => {
      closePopover();
      const wv = previewView.querySelector('.webapp-preview-webview');
      if (wv && rulerActive) {
        try { wv.executeJavaScript(getRulerInjectScript()); } catch (e) {}
      }
    };

    if (delBtn) {
      delBtn.onclick = () => {
        rulerAnnotations = rulerAnnotations.filter(a => a.id !== annotation.id);
        overlay.querySelector(`.wa-pin-ruler[data-pin-id="${annotation.id}"]`)?.remove();
        closePopover();
        updateRulerBadge();
        updateBadge();
        const wv = previewView.querySelector('.webapp-preview-webview');
        if (wv && rulerActive) {
          try { wv.executeJavaScript(getRulerInjectScript()); } catch (e) {}
        }
      };
    }

    okBtn.onclick = () => {
      const val = textarea.value.trim();
      if (!val) return;
      closePopover();
      if (annotation._saved) {
        annotation.instruction = val;
      } else {
        annotation.instruction = val;
        annotation._saved = true;
        rulerAnnotations.push(annotation);
        addRulerPin(annotation);
        updateRulerBadge();
        updateBadge();
      }
      const wv = previewView.querySelector('.webapp-preview-webview');
      if (wv && rulerActive) {
        try { wv.executeJavaScript(getRulerInjectScript()); } catch (e) {}
      }
    };

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); okBtn.onclick(); }
      if (e.key === 'Escape') {
        closePopover();
        const wv = previewView.querySelector('.webapp-preview-webview');
        if (wv && rulerActive) {
          try { wv.executeJavaScript(getRulerInjectScript()); } catch (e) {}
        }
      }
    });
    setTimeout(() => textarea.focus(), 50);
  }

  function handleRulerClick(data) {
    const scroll = data.scroll || { x: 0, y: 0 };
    const absRect = {
      x: data.rect.x + scroll.x, y: data.rect.y + scroll.y,
      width: data.rect.width, height: data.rect.height
    };
    rulerLockedElement = {
      selector: data.selector,
      rect: data.rect,
      absRect,
      capturedAtViewport: currentBreakpoint || 0
    };

    // Uninject ruler for popover interaction, keep scroll
    const wv = previewView.querySelector('.webapp-preview-webview');
    if (wv) {
      try { wv.executeJavaScript(RULER_UNINJECT_SCRIPT); } catch (e) {}
      try { wv.executeJavaScript(SCROLL_LISTEN_SCRIPT); } catch (e) {}
    }

    const ann = {
      id: nextRulerPinId++,
      elementData: { selector: data.selector, rect: data.rect, absRect, capturedAtViewport: currentBreakpoint || 0 },
      spacing: data.spacing,
      computedWidth: data.computedWidth,
      computedHeight: data.computedHeight,
      instruction: '',
      viewportWidth: currentBreakpoint || 0,
      isRulerAnnotation: true,
      _saved: false
    };
    showRulerPopover(ann);
  }

  function handleRulerEscape() {
    deactivateRuler();
  }

  function activateRuler() {
    // Mutual exclusion: deactivate inspect if active
    if (inspectActive) deactivateInspect();
    rulerActive = true;
    rulerBtn.classList.add('active');
    previewView.classList.add('ruler-mode');
    const wv = previewView.querySelector('.webapp-preview-webview');
    if (wv) {
      try { wv.executeJavaScript(getRulerInjectScript()); } catch (e) {}
    }
  }

  function deactivateRuler() {
    rulerActive = false;
    rulerLockedElement = null;
    rulerBtn.classList.remove('active');
    previewView.classList.remove('ruler-mode');
    const wv = previewView.querySelector('.webapp-preview-webview');
    if (wv) {
      try { wv.executeJavaScript(RULER_UNINJECT_SCRIPT); } catch (e) {}
    }
    closePopover();
  }

  function activateInspect() {
    // Mutual exclusion: deactivate ruler if active
    if (rulerActive) deactivateRuler();
    inspectActive = true;
    inspectBtn.classList.add('active');
    previewView.classList.add('inspect-mode');
    // Show pins of current page
    showPins();
    const wv = previewView.querySelector('.webapp-preview-webview');
    if (wv) {
      try { wv.executeJavaScript(getInspectInjectScript()); } catch (e) {}
    }
  }

  function deactivateInspect() {
    inspectActive = false;
    inspectBtn.classList.remove('active');
    previewView.classList.remove('inspect-mode');
    const wv = previewView.querySelector('.webapp-preview-webview');
    if (wv) {
      try { wv.executeJavaScript(INSPECT_UNINJECT_SCRIPT); } catch (e) {}
      try { wv.executeJavaScript(SCROLL_UNLISTEN_SCRIPT); } catch (e) {}
    }
    closePopover();
    hidePins();
  }

  /** Full cleanup: deactivate + clear all pins */
  function deactivateAndClear() {
    inspectActive = false;
    inspectBtn.classList.remove('active');
    previewView.classList.remove('inspect-mode');
    if (rulerActive) deactivateRuler();
    const wv = previewView.querySelector('.webapp-preview-webview');
    if (wv) {
      try { wv.executeJavaScript(INSPECT_UNINJECT_SCRIPT); } catch (e) {}
      try { wv.executeJavaScript(RULER_UNINJECT_SCRIPT); } catch (e) {}
      try { wv.executeJavaScript(SCROLL_UNLISTEN_SCRIPT); } catch (e) {}
    }
    closePopover();
    clearAllPins();
  }

  function handleCapture(elementData) {
    // Compute document-absolute rect from viewport rect + scroll at capture time
    const scroll = elementData.scroll || { x: 0, y: 0 };
    elementData.absRect = {
      x: elementData.rect.x + scroll.x,
      y: elementData.rect.y + scroll.y,
      width: elementData.rect.width,
      height: elementData.rect.height
    };

    // Tag capture with current responsive breakpoint
    elementData.capturedAtViewport = currentBreakpoint || 0;

    // Uninject inspect overlay for popover interaction
    // but keep scroll listener active for pin repositioning
    const wv = previewView.querySelector('.webapp-preview-webview');
    if (wv) {
      try { wv.executeJavaScript(INSPECT_UNINJECT_SCRIPT); } catch (e) {}
      try { wv.executeJavaScript(SCROLL_LISTEN_SCRIPT); } catch (e) {}
    }

    showPopover(elementData, null);
  }

  function handleScroll(scroll) {
    currentScroll = { x: scroll.scrollX, y: scroll.scrollY };
    const page = pageAnnotations.get(currentPagePath);
    const hasAnyPins = (page && page.annotations.length > 0) || autoAnnotations.length > 0 || rulerAnnotations.length > 0;
    if (hasAnyPins) {
      repositionAllPins();
    }
  }

  function handleEscapeFromWebview() {
    // If popover is open, just close it
    if (overlay.querySelector('.wa-pin-popover')) {
      closePopover();
      const wv = previewView.querySelector('.webapp-preview-webview');
      if (wv && inspectActive) {
        try { wv.executeJavaScript(getInspectInjectScript()); } catch (e) {}
      }
    } else {
      // No popover → deactivate inspect entirely
      deactivateInspect();
    }
  }

  /** Switch visible pins when navigating to a different page */
  function switchToPage(newPath) {
    if (newPath === currentPagePath) return;
    closePopover();

    // Save scroll position for current page
    const oldPage = pageAnnotations.get(currentPagePath);
    if (oldPage) oldPage.scroll = { ...currentScroll };

    // Remove pin DOM of old page + auto-pins + ruler pins (transient per-page)
    overlay.querySelectorAll('.wa-pin, .wa-pin-auto, .wa-pin-ruler').forEach(el => el.remove());
    clearAutoAnnotations();
    clearRulerAnnotations();

    // Switch
    currentPagePath = newPath;
    currentScroll = { x: 0, y: 0 };

    // Restore pins of new page only if inspect is active
    const newPage = pageAnnotations.get(currentPagePath);
    if (newPage && inspectActive) {
      currentScroll = { ...newPage.scroll };
      for (const ann of newPage.annotations) addPin(ann);
    }
  }

  inspectBtn.onclick = () => {
    if (inspectActive) {
      deactivateInspect();
    } else {
      activateInspect();
    }
  };

  rulerBtn.onclick = () => {
    if (rulerActive) {
      deactivateRuler();
    } else {
      activateRuler();
    }
  };

  sendAllBtn.onclick = () => {
    const all = getAllAnnotations();
    if (all.length === 0) return;
    sendAllFeedback(previewView, all, deps);
    deactivateAndClear();
  };

  // ── Scan button wiring ──
  scanBtn.onclick = async () => {
    if (scanActive) return;
    let wv = previewView.querySelector('.webapp-preview-webview');
    if (!wv) return;
    clearAutoAnnotations();
    scanActive = true;
    scanBtn.classList.add('scanning');
    try {
      // Load and inject axe-core if available
      const axeSrc = await _loadAxeSource();
      // Re-check webview after async load — it may have been detached
      wv = previewView.querySelector('.webapp-preview-webview');
      if (!wv) { scanActive = false; scanBtn.classList.remove('scanning'); return; }
      if (axeSrc) {
        try { await wv.executeJavaScript(axeSrc); } catch (e) {
          console.warn('[Scan] Failed to inject axe-core:', e.message);
        }
      }
      wv.executeJavaScript(getScanInjectionScript(!!axeSrc));
    } catch (e) {
      scanActive = false;
      scanBtn.classList.remove('scanning');
    }
    // Timeout fallback (15s for axe-core on large pages)
    setTimeout(() => {
      if (scanActive) { scanActive = false; scanBtn.classList.remove('scanning'); }
    }, 15000);
  };

  previewView._inspectHandlers = {
    handleCapture,
    deactivate: deactivateAndClear,
    handleEscape: handleEscapeFromWebview,
    handleScroll,
    handleScanResults,
    handleRulerClick,
    handleRulerEscape,
    toggleRuler: () => { rulerActive ? deactivateRuler() : activateRuler(); },
    toggle: () => { inspectActive ? deactivateInspect() : activateInspect(); },
    isActive: () => inspectActive || rulerActive,
    hasPins: () => getTotalCount() > 0 || autoAnnotations.length > 0 || rulerAnnotations.length > 0,
    switchPage: switchToPage
  };

  // ── Keyboard shortcuts: "I" to toggle inspect, "R" to toggle ruler ──
  const shortcutHandler = (e) => {
    // Only act when preview tab is visible and no input is focused
    if (!previewView.classList.contains('wa-view-active')) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'i' || e.key === 'I') {
      e.preventDefault();
      if (inspectActive) {
        deactivateInspect();
      } else {
        activateInspect();
      }
    }
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      if (rulerActive) {
        deactivateRuler();
      } else {
        activateRuler();
      }
    }
  };
  document.addEventListener('keydown', shortcutHandler);
  // Store for cleanup
  previewView._inspectShortcutHandler = shortcutHandler;

  // ── Browser nav buttons ──
  previewView.querySelector('.wa-reload').onclick = () => {
    const wv = previewView.querySelector('.webapp-preview-webview');
    if (wv) wv.reload();
  };
  previewView.querySelector('.wa-back').onclick = () => {
    const wv = previewView.querySelector('.webapp-preview-webview');
    if (wv && wv.canGoBack()) wv.goBack();
  };
  previewView.querySelector('.wa-fwd').onclick = () => {
    const wv = previewView.querySelector('.webapp-preview-webview');
    if (wv && wv.canGoForward()) wv.goForward();
  };
  previewView.querySelector('.wa-open-ext').onclick = () => {
    const wv = previewView.querySelector('.webapp-preview-webview');
    api.dialog.openExternal(wv ? wv.getURL() : url);
  };

  // ── Responsive breakpoint buttons ──
  let currentBreakpoint = 0; // 0 = full width
  const responsiveGroup = previewView.querySelector('.wa-responsive-group');
  const responsiveFrame = previewView.querySelector('.wa-responsive-frame');
  const responsiveIndicator = previewView.querySelector('.wa-responsive-indicator');
  const viewportEl = previewView.querySelector('.wa-browser-viewport');

  function applyBreakpoint(width) {
    currentBreakpoint = width;

    // Update active button
    responsiveGroup.querySelectorAll('.wa-responsive-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.width) === width);
    });

    if (width === 0) {
      // Full mode
      responsiveFrame.style.maxWidth = '';
      responsiveFrame.classList.remove('constrained');
      if (viewportEl) viewportEl.classList.remove('responsive-active');
      if (responsiveIndicator) {
        responsiveIndicator.classList.remove('visible');
        responsiveIndicator.textContent = '';
      }
    } else {
      // Constrained mode
      responsiveFrame.style.maxWidth = width + 'px';
      responsiveFrame.classList.add('constrained');
      if (viewportEl) viewportEl.classList.add('responsive-active');
      if (responsiveIndicator) {
        responsiveIndicator.textContent = width + 'px';
        responsiveIndicator.classList.add('visible');
      }
    }

    // Close popover (its absRect becomes stale after reflow)
    closePopover();

    // Pins need repositioning after content reflows
    setTimeout(() => {
      invalidatePinsAfterResize();
      updatePinViewportStyles();
    }, 300);
  }

  function invalidatePinsAfterResize() {
    const page = getPageAnns();
    const allAnns = [...(page ? page.annotations : []), ...autoAnnotations, ...rulerAnnotations];
    if (allAnns.length === 0) return;

    const wv = previewView.querySelector('.webapp-preview-webview');
    if (!wv) return;

    const selectors = [...new Set(allAnns.map(a => a.elementData.selector))];
    const queryScript = `(function() {
      var results = {};
      var selectors = ${JSON.stringify(selectors)};
      for (var i = 0; i < selectors.length; i++) {
        try {
          var el = document.querySelector(selectors[i]);
          if (el) {
            var r = el.getBoundingClientRect();
            results[selectors[i]] = { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
          }
        } catch(e) {}
      }
      return JSON.stringify(results);
    })()`;

    try {
      wv.executeJavaScript(queryScript).then(resultStr => {
        try {
          const results = JSON.parse(resultStr);
          for (const ann of allAnns) {
            const newRect = results[ann.elementData.selector];
            if (newRect) ann.elementData.absRect = newRect;
          }
          repositionAllPins();
        } catch (e) {}
      });
    } catch (e) {}
  }

  function updatePinViewportStyles() {
    const page = getPageAnns();
    if (!page) return;
    for (const ann of page.annotations) {
      const pinEl = overlay.querySelector(`.wa-pin[data-pin-id="${ann.id}"]`);
      if (!pinEl) continue;
      const annVp = ann.viewportWidth || 0;
      const matchesCurrent = annVp === currentBreakpoint || annVp === 0;
      pinEl.classList.toggle('wa-pin-other-viewport', !matchesCurrent);
    }
    // Also update auto-detected pins
    for (const ann of autoAnnotations) {
      const pinEl = overlay.querySelector(`.wa-pin-auto[data-pin-id="${ann.id}"]`);
      if (!pinEl) continue;
      const annVp = ann.viewportWidth || 0;
      const matchesCurrent = annVp === currentBreakpoint || annVp === 0;
      pinEl.classList.toggle('wa-pin-other-viewport', !matchesCurrent);
    }
    // Also update ruler pins
    for (const ann of rulerAnnotations) {
      const pinEl = overlay.querySelector(`.wa-pin-ruler[data-pin-id="${ann.id}"]`);
      if (!pinEl) continue;
      const annVp = ann.viewportWidth || 0;
      const matchesCurrent = annVp === currentBreakpoint || annVp === 0;
      pinEl.classList.toggle('wa-pin-other-viewport', !matchesCurrent);
    }
  }

  responsiveGroup.querySelectorAll('.wa-responsive-btn').forEach(btn => {
    btn.addEventListener('click', () => applyBreakpoint(parseInt(btn.dataset.width)));
  });

  // Expose for annotation tagging
  previewView._getCurrentBreakpoint = () => currentBreakpoint;
  previewView._updatePinViewportStyles = updatePinViewportStyles;
}

async function renderInfoView(wrapper, projectIndex, project, deps) {
  const { t } = deps;
  const server = getWebAppServer(projectIndex);
  const infoView = wrapper.querySelector('.webapp-info-view');
  if (!infoView) return;

  const port = await resolvePort(projectIndex);
  const url = port ? `http://localhost:${port}` : null;

  const STATUS = {
    stopped:  { cls: 'stopped',  label: t('webapp.statusStopped'),  desc: t('webapp.devServerNotRunning') },
    starting: { cls: 'starting', label: t('webapp.statusStarting'), desc: t('webapp.launchingServer')     },
    running:  { cls: 'running',  label: t('webapp.statusRunning'),  desc: url || t('webapp.serverActive') },
  };
  const st = STATUS[server.status] || STATUS.stopped;

  const framework = project.framework || project.webFramework || null;
  const devCmd    = project.devCommand || 'auto';
  const projectName = project.name || 'Web App';

  const ICON_STATUS_RUNNING = `<svg viewBox="0 0 20 20" fill="none" width="18" height="18"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.2" opacity=".25"/><circle cx="10" cy="10" r="4" fill="currentColor"/></svg>`;
  const ICON_STATUS_STOPPED = `<svg viewBox="0 0 20 20" fill="none" width="18" height="18"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.2" opacity=".25"/><rect x="7.5" y="7.5" width="5" height="5" rx="1" fill="currentColor" opacity=".5"/></svg>`;
  const ICON_GLOBE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" width="13" height="13"><circle cx="8" cy="8" r="6.5"/><path d="M8 1.5C6 4 5 6 5 8s1 4 3 6.5M8 1.5C10 4 11 6 11 8s-1 4-3 6.5M1.5 8h13" stroke-linecap="round"/></svg>`;
  const ICON_TERMINAL = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" width="13" height="13"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6L7 8.5 4.5 11M8.5 11H12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const ICON_PORT = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" width="13" height="13"><path d="M8 2v12M4 5h8M3 9h10" stroke-linecap="round"/><rect x="5" y="7" width="6" height="4" rx="1"/></svg>`;

  infoView.innerHTML = `
    <div class="wa-info">

      <div class="wa-info-hero ${st.cls}">
        <div class="wa-info-hero-bg"></div>
        <div class="wa-info-hero-content">
          <div class="wa-info-hero-icon">${server.status === 'running' ? ICON_STATUS_RUNNING : ICON_STATUS_STOPPED}</div>
          <div class="wa-info-hero-text">
            <div class="wa-info-hero-label">${st.label}</div>
            <div class="wa-info-hero-sub">${st.desc}</div>
          </div>
          ${url ? `<button class="wa-info-cta webapp-open-url" data-url="${url}">${ICON_OPEN}<span>${t('webapp.openBtn')}</span></button>` : ''}
        </div>
      </div>

      <div class="wa-info-grid">
        <div class="wa-info-tile">
          <div class="wa-info-tile-icon">${ICON_PORT}</div>
          <div class="wa-info-tile-body">
            <div class="wa-info-tile-label">${t('webapp.port')}</div>
            <div class="wa-info-tile-val wa-mono">${port ? port : '—'}</div>
          </div>
        </div>
        <div class="wa-info-tile">
          <div class="wa-info-tile-icon">${ICON_TERMINAL}</div>
          <div class="wa-info-tile-body">
            <div class="wa-info-tile-label">${t('webapp.commandLabel')}</div>
            <div class="wa-info-tile-val wa-mono">${devCmd}</div>
          </div>
        </div>
        ${framework ? `
        <div class="wa-info-tile">
          <div class="wa-info-tile-icon">${ICON_GLOBE}</div>
          <div class="wa-info-tile-body">
            <div class="wa-info-tile-label">${t('webapp.framework')}</div>
            <div class="wa-info-tile-val">${framework}</div>
          </div>
        </div>` : ''}
        ${url ? `
        <div class="wa-info-tile wa-info-tile-link webapp-open-url" data-url="${url}" role="button" tabindex="0">
          <div class="wa-info-tile-icon">${ICON_GLOBE}</div>
          <div class="wa-info-tile-body">
            <div class="wa-info-tile-label">${t('webapp.localUrlLabel')}</div>
            <div class="wa-info-tile-val wa-mono">${url}</div>
          </div>
          <div class="wa-info-tile-arrow">${ICON_OPEN}</div>
        </div>` : ''}
      </div>

    </div>
  `;

  infoView.querySelectorAll('.webapp-open-url').forEach(el => {
    el.style.cursor = 'pointer';
    el.onclick = () => {
      const u = el.dataset.url;
      if (u) api.dialog.openExternal(u);
    };
  });

  if (!port && server.status === 'running') {
    startPortPoll(wrapper, projectIndex, () => {
      renderInfoView(wrapper, projectIndex, project, deps);
    });
  }
}

// ── Send All Feedback ──────────────────────────────────────────────

function sendAllFeedback(previewView, annotations, deps) {
  const { createTerminal, setActiveTerminal, findChatTab } = deps;
  const project = previewView._project;
  if (!project || annotations.length === 0) return;

  // Separate user vs auto-detected vs ruler annotations
  const userAnns = annotations.filter(a => !a.isAutoDetected && !a.isRulerAnnotation);
  const autoAnns = annotations.filter(a => a.isAutoDetected);
  const rulerAnns = annotations.filter(a => a.isRulerAnnotation);

  // Detect viewport info across all annotations
  const viewports = [...new Set(annotations.map(a => a.viewportWidth || 0))];
  const hasViewportInfo = viewports.some(v => v > 0);
  const vpSuffix = hasViewportInfo
    ? '\n\nFor viewport-specific issues, ensure the fixes work correctly at the specified breakpoints using responsive CSS (media queries).'
    : '';

  let prompt;

  // Helper to format a single annotation line
  const fmtLine = (ann, num) => {
    const ed = ann.elementData;
    const tag = ed.tagName ? `<${ed.tagName}>` : '';
    const classes = ed.className ? `, classes: \`${ed.className}\`` : '';
    const vpTag = ann.viewportWidth ? ` @${ann.viewportWidth}px` : '';
    const autoTag = ann.isAutoDetected ? ` [${(ann.issueType || 'auto').toUpperCase()}]` : '';
    const rulerTag = ann.isRulerAnnotation ? ' [SPACING]' : '';
    const spacingInfo = ann.spacing ? ` (margin: ${Math.round(ann.spacing.margin.top)}/${Math.round(ann.spacing.margin.right)}/${Math.round(ann.spacing.margin.bottom)}/${Math.round(ann.spacing.margin.left)}, padding: ${Math.round(ann.spacing.padding.top)}/${Math.round(ann.spacing.padding.right)}/${Math.round(ann.spacing.padding.bottom)}/${Math.round(ann.spacing.padding.left)}, size: ${ann.computedWidth} × ${ann.computedHeight})` : '';
    return `${num}. ${autoTag}${rulerTag}\`${ed.selector}\` ${tag ? `(${tag}${classes})` : ''}${vpTag}${spacingInfo}: "${ann.instruction}"`;
  };

  if (annotations.length === 1) {
    const ann = annotations[0];
    const ed = ann.elementData;
    const vpHint = ann.viewportWidth ? ` (at viewport: ${ann.viewportWidth}px)` : '';
    if (ann.isRulerAnnotation) {
      const sp = ann.spacing;
      prompt = `The user measured spacing on an element in the web app preview${vpHint} and wants a change:\n\n[SPACING] "${ann.instruction}"\n\nElement: \`${ed.selector}\` (size: ${ann.computedWidth} × ${ann.computedHeight}, margin: ${Math.round(sp.margin.top)}/${Math.round(sp.margin.right)}/${Math.round(sp.margin.bottom)}/${Math.round(sp.margin.left)}, padding: ${Math.round(sp.padding.top)}/${Math.round(sp.padding.right)}/${Math.round(sp.padding.bottom)}/${Math.round(sp.padding.left)})\n\nFind this element in the project source code and make the requested spacing change.${vpSuffix}`;
    } else if (ann.isAutoDetected) {
      prompt = `An auto-detected visual issue was found in the web app preview${vpHint}:\n\n[${(ann.issueType || '').toUpperCase()}] "${ann.instruction}"\n\nElement: \`${ed.selector}\` (<${ed.tagName}>${ed.className ? `, classes: \`${ed.className}\`` : ''})\n\nFind this element in the project source code and fix the issue.${vpSuffix}`;
    } else {
      prompt = `The user selected an element in their web app preview${vpHint} and wants a change:\n\n"${ann.instruction}"\n\nElement: \`${ed.selector}\` (<${ed.tagName}>${ed.className ? `, classes: \`${ed.className}\`` : ''})\n\nFind this element in the project source code and make the requested change directly.${vpSuffix}`;
    }
  } else {
    // Group by page
    const byPage = new Map();
    for (const ann of annotations) {
      const path = ann.pagePath || '/';
      if (!byPage.has(path)) byPage.set(path, []);
      byPage.get(path).push(ann);
    }
    const multiPage = byPage.size > 1;

    let num = 1;
    const sections = [];

    // User annotations section
    if (userAnns.length > 0) {
      const userByPage = new Map();
      for (const ann of userAnns) {
        const path = ann.pagePath || '/';
        if (!userByPage.has(path)) userByPage.set(path, []);
        userByPage.get(path).push(ann);
      }
      for (const [path, anns] of userByPage) {
        const lines = anns.map(ann => fmtLine(ann, num++));
        if (multiPage) {
          sections.push(`Page \`${path}\`:\n${lines.join('\n')}`);
        } else {
          sections.push(lines.join('\n'));
        }
      }
    }

    // Auto-detected section
    if (autoAnns.length > 0) {
      const autoLines = autoAnns.map(ann => fmtLine(ann, num++));
      sections.push(`Auto-detected visual issues:\n${autoLines.join('\n')}`);
    }

    // Ruler/spacing section
    if (rulerAnns.length > 0) {
      const rulerLines = rulerAnns.map(ann => fmtLine(ann, num++));
      sections.push(`Spacing/measurement fixes:\n${rulerLines.join('\n')}`);
    }

    const vpSummary = viewports.length > 1 && hasViewportInfo
      ? ` across multiple viewport sizes (${viewports.map(v => v ? v + 'px' : 'full').join(', ')})`
      : viewports[0] ? ` at ${viewports[0]}px viewport` : '';
    const parts = [];
    if (userAnns.length > 0) parts.push(`${userAnns.length} element(s) annotated`);
    if (autoAnns.length > 0) parts.push(`${autoAnns.length} visual issue(s) auto-detected`);
    if (rulerAnns.length > 0) parts.push(`${rulerAnns.length} spacing fix(es) measured`);
    const what = parts.join(', ');
    prompt = `${what} in the web app preview${vpSummary}. Fix all these:\n\n${sections.join('\n\n')}\n\nFind each element in the project source code and make the requested changes.${vpSuffix}`;
  }

  const VISUAL_TAB_PREFIX = '\ud83c\udfaf Visual';
  const existing = findChatTab(project.path, VISUAL_TAB_PREFIX);

  if (existing) {
    const { id, termData } = existing;
    if (termData.chatView) {
      termData.chatView.sendMessage(prompt);
      setActiveTerminal(id);
      return;
    }
  }

  // Respect user's defaultTerminalMode and skipPermissions settings
  createTerminal(project, {
    skipPermissions: getSetting('skipPermissions') || false,
    initialPrompt: prompt,
    name: '\ud83c\udfaf Visual Feedback'
  });
}

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cleanup(wrapper) {
  clearPollTimer(wrapper);
  if (wrapper._waPipInterval) clearInterval(wrapper._waPipInterval);
  if (wrapper._waClassObserver) {
    wrapper._waClassObserver.disconnect();
    delete wrapper._waClassObserver;
  }
  const previewView = wrapper.querySelector('.webapp-preview-view');
  if (previewView) {
    if (previewView._inspectShortcutHandler) {
      document.removeEventListener('keydown', previewView._inspectShortcutHandler);
      delete previewView._inspectShortcutHandler;
    }
    const webview = previewView.querySelector('.webapp-preview-webview');
    if (webview) webview.remove();
    detachedWebviews.delete(previewView);
    delete previewView.dataset.loadedPort;
  }
}

module.exports = {
  getViewSwitcherHtml,
  setupViewSwitcher,
  renderPreviewView,
  renderInfoView,
  cleanup
};
