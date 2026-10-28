/**
 * The chat's session brief, at the top of the side column. What it must get
 * right: never call the model on its own (the cached brief is read, a new one
 * waits for a click), read nothing while off screen, show the model's text as
 * text, and say when the brief is behind the conversation.
 */

'use strict';

const { createSessionBrief, inlineHtml } = require('../../src/renderer/ui/components/chat/sessionBrief');
const { t, getCurrentLanguage } = require('../../src/renderer/i18n');

const BRIEF = {
  about: 'Fix the `ProjectBar` drag freeze.',
  status: 'Done, PR to open.',
  decisions: ['Read before write <b>not</b> throttle'],
  notes: [],
};

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function setup({ sessionId = 'sess-1', status, generated, onScreen = true } = {}) {
  document.body.innerHTML = '<div class="chat-brief-body"></div>';
  const api = {
    claude: {
      sessionBrief: jest.fn(async () => status || { success: true, brief: null, newMessages: 4 }),
      generateSessionBrief: jest.fn(async () => generated || { success: true, brief: BRIEF, generatedAt: Date.now(), language: getCurrentLanguage(), newMessages: 0 }),
    },
  };
  let currentId = sessionId;
  let visible = onScreen;
  const onChange = jest.fn();
  const brief = createSessionBrief({
    api,
    bodyEl: document.querySelector('.chat-brief-body'),
    getSessionId: () => currentId,
    getProjectPath: () => '/p',
    isOnScreen: () => visible,
    onChange,
  });
  return {
    api, brief, onChange,
    setSessionId: (id) => { currentId = id; },
    setOnScreen: (v) => { visible = v; },
    body: () => document.querySelector('.chat-brief-body'),
    update: () => document.querySelector('.chat-brief-update'),
  };
}

describe('session brief', () => {
  test('a new conversation says the brief comes after the first exchange, and reads nothing', async () => {
    const view = setup({ sessionId: null });
    view.brief.sync();
    await flush();
    expect(view.body().textContent).toContain(t('chat.brief.afterFirstTurn'));
    expect(view.body().querySelector('.chat-brief-generate')).toBeNull();
    expect(view.api.claude.sessionBrief).not.toHaveBeenCalled();
  });

  test('with a session it reads the cache and offers to write one, without calling the model', async () => {
    const view = setup();
    view.brief.sync();
    await flush();
    expect(view.api.claude.sessionBrief).toHaveBeenCalledWith({ projectPath: '/p', sessionId: 'sess-1' });
    expect(view.api.claude.generateSessionBrief).not.toHaveBeenCalled();
    expect(view.body().querySelector('.chat-brief-generate')).not.toBeNull();
  });

  test('writing renders the sections, the model text escaped and its code spans kept', async () => {
    const view = setup();
    view.brief.sync();
    await flush();
    view.body().querySelector('.chat-brief-generate').click();
    expect(view.body().textContent).toContain(t('chat.brief.generating'));
    await flush();
    expect(view.api.claude.generateSessionBrief).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1', language: getCurrentLanguage() }));
    const html = view.body().innerHTML;
    expect(html).toContain('<code class="chat-inline-code">ProjectBar</code>');
    expect(html).toContain('&lt;b&gt;not&lt;/b&gt;');
    expect(view.body().querySelector('b')).toBeNull();
    expect(view.body().textContent).toContain(t('chat.brief.decisions'));
    // No notes: no empty section.
    expect(view.body().textContent).not.toContain(t('chat.brief.notes'));
  });

  test('the update button is always there, greyed while the brief is up to date', async () => {
    const view = setup({ status: { success: true, brief: BRIEF, generatedAt: Date.now(), language: getCurrentLanguage(), newMessages: 0 } });
    view.brief.sync();
    await flush();
    expect(view.body().textContent).toContain(t('chat.brief.upToDate'));
    expect(view.update().disabled).toBe(true);
    expect(view.onChange).toHaveBeenLastCalledWith({ behind: false });
  });

  test('a cached brief that is behind says by how much, and its update sends one call', async () => {
    const view = setup({ status: { success: true, brief: BRIEF, generatedAt: Date.now() - 60_000, language: getCurrentLanguage(), newMessages: 12 } });
    view.brief.sync();
    await flush();
    expect(view.body().textContent).toContain(t('chat.brief.newMessages', { count: 12 }));
    expect(view.onChange).toHaveBeenLastCalledWith({ behind: true });
    view.update().click();
    expect(view.update().disabled).toBe(true);
    expect(view.update().textContent).toBe(t('chat.brief.updating'));
    await flush();
    expect(view.api.claude.generateSessionBrief).toHaveBeenCalledTimes(1);
    expect(view.update().disabled).toBe(true);
    expect(view.body().textContent).toContain(t('chat.brief.upToDate'));
    expect(view.onChange).toHaveBeenLastCalledWith({ behind: false });
  });

  test('a brief in another language than the UI is behind', async () => {
    const view = setup({ status: { success: true, brief: BRIEF, generatedAt: Date.now(), language: 'xx', newMessages: 0 } });
    view.brief.sync();
    await flush();
    expect(view.update().disabled).toBe(false);
  });

  test('a failed write keeps the previous brief on screen and says it failed', async () => {
    const view = setup({
      status: { success: true, brief: BRIEF, generatedAt: Date.now(), language: getCurrentLanguage(), newMessages: 3 },
      generated: { success: false, error: 'failed' },
    });
    view.brief.sync();
    await flush();
    view.update().click();
    await flush();
    expect(view.body().textContent).toContain('Done, PR to open.');
    expect(view.body().textContent).toContain(t('chat.brief.errorFailed'));
  });

  test('off screen, a turn ending reads nothing until the column is shown again', async () => {
    const view = setup({ onScreen: false });
    view.brief.sync();
    view.brief.onTurnEnd();
    await flush();
    expect(view.api.claude.sessionBrief).not.toHaveBeenCalled();

    view.setOnScreen(true);
    view.brief.onShown();
    await flush();
    expect(view.api.claude.sessionBrief).toHaveBeenCalledTimes(1);
    // Shown again at once: no second read.
    view.brief.onShown();
    await flush();
    expect(view.api.claude.sessionBrief).toHaveBeenCalledTimes(1);
  });

  test('shown again after a while, it reads again: the session may have moved elsewhere', async () => {
    const view = setup();
    view.brief.sync();
    await flush();
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now + 11_000);
    try {
      view.brief.onShown();
      await flush();
      expect(view.api.claude.sessionBrief).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  test('on screen, every turn end refreshes the count', async () => {
    const view = setup();
    view.brief.sync();
    await flush();
    view.brief.onTurnEnd();
    await flush();
    expect(view.api.claude.sessionBrief).toHaveBeenCalledTimes(2);
  });
});

test('inlineHtml escapes first, then turns backticks into code', () => {
  expect(inlineHtml('run `<x>` now')).toBe('run <code class="chat-inline-code">&lt;x&gt;</code> now');
});
