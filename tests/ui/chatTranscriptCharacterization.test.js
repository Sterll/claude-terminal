/**
 * Characterization — how a turn becomes DOM in ChatView.
 *
 * These tests do not say what the transcript *should* look like. They pin what
 * it looks like today, so that the split CLAUDE.md calls for ("prefer adding
 * new chat behaviour as a sibling module over growing ChatView.js further")
 * can be attempted with something other than hope. A refactor that moves a
 * class name, drops a dataset key or reorders the grouping rule fails here
 * loudly instead of shipping.
 *
 * The one rule in this file that is not merely descriptive is the ask-rule
 * clause on the permission card: when the user's own `permissions.ask` entry
 * is what forced the prompt, "Always Allow" is removed, because the rule it
 * would write overrides the rule the user wrote. That is a security property,
 * and it is asserted from both sides — present without the rule, absent with
 * it — so a regression cannot hide behind a passing happy path.
 */

/** api mock: `on*` captures its callback, everything else resolves to a bare success. */
function makeApiMock(listeners) {
  const ns = () => new Proxy({}, {
    get: (_t, method) => (...args) => {
      if (typeof method === 'string' && method.startsWith('on')) {
        listeners[method] = args[0];
        return () => {};
      }
      return Promise.resolve({ success: true, messages: [] });
    }
  });
  return new Proxy({}, { get: () => ns() });
}

// jsdom ships no crypto.randomUUID; the send path tags each user message with one.
let uuidSeq = 0;
Object.defineProperty(global, 'crypto', {
  value: { ...(global.crypto || {}), randomUUID: () => `char-uuid-${++uuidSeq}` },
  configurable: true,
});

// jsdom implements no layout, so it ships no scrollIntoView. The permission and
// question cards call it from a rAF, which lands after the test that queued it —
// leaving an unstubbed one to fail whichever test happens to run next. Stubbed
// here rather than in tests/setup.js to keep this suite self-contained.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

describe('chat transcript rendering (characterization)', () => {
  let listeners, wrapper, view, sessionId;

  const emit = (message) => listeners.onMessage({ sessionId, message });
  const streamEvent = (event) => emit({ type: 'stream_event', event });

  /** One complete streamed tool_use block, the way the SDK delivers it. */
  const streamToolUse = (index, name, input) => {
    streamEvent({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${index}`, name } });
    streamEvent({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
    streamEvent({ type: 'content_block_stop', index });
  };

  const cards = () => Array.from(wrapper.querySelectorAll('.chat-tool-card'));
  const permCard = () => wrapper.querySelector('.chat-perm-card');

  beforeEach(async () => {
    jest.resetModules();
    listeners = {};
    window.electron_api = makeApiMock(listeners);
    document.body.innerHTML = '';
    wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' });
    // A real send opens the session, so the messages below carry the id the
    // component filters on instead of bypassing that guard.
    view.sendMessage('go');
    await new Promise(r => setTimeout(r, 0));
    sessionId = view.getSessionId();
    expect(sessionId).toBeTruthy();
  });

  afterEach(() => {
    try { view?.destroy?.(); } catch (_) { /* teardown is best effort */ }
  });

  // ── Tool cards ──

  describe('tool_use blocks', () => {
    it('gives a streamed tool_use its own card, tagged with tool name and use id', () => {
      streamToolUse(0, 'Read', { file_path: '/tmp/test/a.js' });

      expect(cards()).toHaveLength(1);
      const card = cards()[0];
      expect(card.dataset.toolName).toBe('Read');
      expect(card.dataset.toolUseId).toBe('toolu_0');
      // The parsed input is parked on the card; the permission path and the
      // background-task re-render both read it back off this attribute.
      expect(JSON.parse(card.dataset.toolInput)).toEqual({ file_path: '/tmp/test/a.js' });
    });

    it('folds a second card for the same tool into a group', () => {
      streamToolUse(0, 'Read', { file_path: '/tmp/test/a.js' });
      streamToolUse(1, 'Read', { file_path: '/tmp/test/b.js' });

      const group = wrapper.querySelector('.chat-tool-group');
      expect(group).toBeTruthy();
      expect(group.dataset.toolName).toBe('Read');
      expect(group.querySelectorAll('.chat-tool-group-items > .chat-tool-card')).toHaveLength(2);
      // The lone card is not left behind next to the group it was folded into.
      expect(wrapper.querySelectorAll('.chat-tool-group')).toHaveLength(1);
    });

    it('starts a new card rather than a group when the tool changes', () => {
      streamToolUse(0, 'Read', { file_path: '/tmp/test/a.js' });
      streamToolUse(1, 'Bash', { command: 'ls' });

      expect(wrapper.querySelector('.chat-tool-group')).toBeNull();
      expect(cards().map(c => c.dataset.toolName)).toEqual(['Read', 'Bash']);
    });

    it('routes TodoWrite to the task bar instead of a tool card', () => {
      streamToolUse(0, 'TodoWrite', { todos: [{ content: 'one', status: 'pending' }] });

      expect(cards()).toHaveLength(0);
    });

    it('marks a card complete when the turn ends', () => {
      streamToolUse(0, 'Read', { file_path: '/tmp/test/a.js' });
      expect(cards()[0].querySelector('.chat-tool-status').classList.contains('running')).toBe(true);

      listeners.onDone({ sessionId, interrupted: false });

      expect(cards()[0].querySelector('.chat-tool-status').classList.contains('complete')).toBe(true);
    });
  });

  // ── Thinking blocks ──

  describe('thinking blocks', () => {
    it('renders nothing until the block stops', () => {
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing it up' } });

      // Thinking is accumulated and rendered once, not streamed into the DOM.
      expect(wrapper.querySelector('.chat-thinking')).toBeNull();

      streamEvent({ type: 'content_block_stop', index: 0 });

      const block = wrapper.querySelector('.chat-thinking');
      expect(block).toBeTruthy();
      expect(block.querySelector('.chat-thinking-content').textContent).toContain('weighing it up');
    });

    it('joins the deltas in arrival order', () => {
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
      for (const part of ['first ', 'second ', 'third']) {
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: part } });
      }
      streamEvent({ type: 'content_block_stop', index: 0 });

      expect(wrapper.querySelector('.chat-thinking-content').textContent).toContain('first second third');
    });

    it('leaves no block behind when nothing was thought', () => {
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
      streamEvent({ type: 'content_block_stop', index: 0 });

      expect(wrapper.querySelector('.chat-thinking')).toBeNull();
    });
  });

  // ── Permission cards ──

  describe('permission cards', () => {
    const request = (extra = {}) => listeners.onPermissionRequest({
      sessionId,
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      ...extra,
    });

    it('offers Allow / Always Allow / Deny for an ordinary prompt', () => {
      request();

      const actions = Array.from(permCard().querySelectorAll('.chat-perm-actions button'))
        .map(b => b.dataset.action);
      expect(actions).toEqual(['allow', 'always-allow', 'deny']);
      expect(permCard().dataset.requestId).toBe('req-1');
      expect(permCard().dataset.toolName).toBe('Bash');
      expect(permCard().classList.contains('rule-forced')).toBe(false);
    });

    it('parks the SDK permission suggestions on the card', () => {
      // "Always Allow" reads these back to write a granular rule rather than
      // falling through to bypassPermissions.
      request({ suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }] });

      expect(JSON.parse(permCard().dataset.suggestions)).toHaveLength(1);
    });

    it('drops Always Allow when the user own ask rule forced the prompt', () => {
      // The security clause. A rule written here would override the rule the
      // user wrote, so the button is removed — not merely disabled or hidden
      // by CSS, which a refactor could restore by accident.
      request({ matchedAskRule: { ruleContent: 'Bash(rm:*)', source: 'projectSettings', toolName: 'Bash' } });

      const card = permCard();
      const actions = Array.from(card.querySelectorAll('.chat-perm-actions button')).map(b => b.dataset.action);
      expect(actions).toEqual(['allow', 'deny']);
      expect(card.querySelector('[data-action="always-allow"]')).toBeNull();
      expect(card.classList.contains('rule-forced')).toBe(true);
    });

    it('names the rule that fired, with its source', () => {
      request({ matchedAskRule: { ruleContent: 'Bash(rm:*)', source: 'projectSettings', toolName: 'Bash' } });

      const source = permCard().querySelector('.chat-perm-rule-source');
      expect(source).toBeTruthy();
      // Rule text and where it came from, joined — this is what tells the user
      // which of their own rules to go and edit.
      expect(source.textContent).toContain('Bash(rm:*)');
      expect(source.textContent).toContain('projectSettings');
      expect(permCard().querySelector('.chat-perm-rule-badge')).toBeTruthy();
    });

    it('falls back to the tool name when the rule carries no content', () => {
      request({ matchedAskRule: { source: 'localSettings', toolName: 'WebFetch' } });

      expect(permCard().querySelector('.chat-perm-rule-source').textContent).toContain('WebFetch');
      expect(permCard().querySelector('[data-action="always-allow"]')).toBeNull();
    });

    it('escapes rule text rather than letting it reach the DOM as markup', () => {
      // Rule content is producer-authored and lands in an innerHTML template.
      request({ matchedAskRule: { ruleContent: '<img src=x onerror=alert(1)>', source: 'settings' } });

      expect(permCard().querySelector('img')).toBeNull();
      expect(permCard().querySelector('.chat-perm-rule-source').textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('sends AskUserQuestion to the question card, not the permission card', () => {
      listeners.onPermissionRequest({
        sessionId,
        requestId: 'req-q',
        toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }] },
      });

      expect(permCard()).toBeNull();
      expect(wrapper.querySelector('.chat-question-card')).toBeTruthy();
    });

    it('ignores a prompt addressed to another session', () => {
      listeners.onPermissionRequest({
        sessionId: 'some-other-session',
        requestId: 'req-x',
        toolName: 'Bash',
        input: { command: 'ls' },
      });

      expect(permCard()).toBeNull();
    });
  });
});
