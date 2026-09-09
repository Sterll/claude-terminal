/**
 * Load the real PWA (index.html + i18n.js + app.js) into jsdom.
 *
 * The PWA is a pair of classic scripts sharing one global scope, with no module
 * boundary to import. Re-implementing its logic in a test would only assert that
 * the copy is self-consistent, so instead the real sources are evaluated inside
 * a function body — which reproduces exactly the shared scope they get in the
 * browser — and the internals under test are handed back at the end.
 */

const fs = require('fs');
const path = require('path');

const PWA_DIR = path.join(__dirname, '..', '..', 'remote-ui');

/** The names the tests drive. Appended as a return statement to the sources. */
const EXPORTS = [
  'state', 'conn',
  'handleMessage', 'setInputState', '_applyInputState', '_syncChatUiToSession',
  '_setThinking', '_makeSession', 'openSession', 'switchView', 'renderChatView',
  'renderChatMessages', 'renderSessionBar', 'sendMessage', 'interruptSession',
  '_renderChatBody', '_getOrCreateSession', 'onSessionStarted', 'onChatIdle',
  '_startHeartbeat', '_stopHeartbeat', '_dropSocket', '_wakeUp', '_openWS',
  'onChatDone', 'onChatError', 'onChatMessage', 'enterProjectHub',
];

// jsdom hands the whole test file one document and one window, so every load
// would stack another set of the PWA's global listeners on them — and a stale
// visibilitychange handler still holding its own `conn` would open sockets
// behind the current test's back. Record what each load attaches so the next
// one can detach it.
let _attached = [];
const _origAdd = new WeakMap();

function _recordListeners(target) {
  if (!_origAdd.has(target)) _origAdd.set(target, target.addEventListener.bind(target));
  const add = _origAdd.get(target);
  target.addEventListener = (type, fn, opts) => {
    _attached.push({ target, type, fn });
    add(type, fn, opts);
  };
}

function loadPwa({ token = null } = {}) {
  for (const { target, type, fn } of _attached) target.removeEventListener(type, fn);
  _attached = [];
  _recordListeners(document);
  _recordListeners(window);

  // jsdom ships neither of these and the PWA calls both on startup.
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  window.fetch = () => Promise.reject(new Error('offline in tests'));
  global.fetch = window.fetch;
  // Keep the socket inert: these tests are about UI routing, not transport.
  window.WebSocket = function () {
    return { readyState: 0, close() {}, send() {} };
  };
  window.WebSocket.OPEN = 1;

  localStorage.clear();
  if (token) localStorage.setItem('remote_session_token', token);

  const html = fs.readFileSync(path.join(PWA_DIR, 'index.html'), 'utf8');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script[\s\S]*?<\/script>/gi, '');
  document.body.innerHTML = body;

  const sources = [
    fs.readFileSync(path.join(PWA_DIR, 'i18n.js'), 'utf8'),
    fs.readFileSync(path.join(PWA_DIR, 'app.js'), 'utf8'),
    `return { ${EXPORTS.join(', ')} };`,
  ].join('\n');

  // The PWA narrates its startup and every send on a closed socket. Useful on a
  // phone, pure noise here — and it drowns the actual assertion failures.
  console.log = () => {};
  console.warn = () => {};
  console.debug = () => {};

  // eslint-disable-next-line no-new-func
  return new Function(sources)();
}

/** Is the interrupt button (rather than send) the one on screen? */
function interruptVisible() {
  return !document.getElementById('interrupt-btn').classList.contains('hidden');
}

function thinkingVisible() {
  return !document.getElementById('thinking-indicator').classList.contains('hidden');
}

module.exports = { loadPwa, interruptVisible, thinkingVisible };
